/* Account MCP server at formal.team/mcp/account (Streamable HTTP, stateless).
 *
 * The same setup as the anonymous server in worker/mcp.ts, behind an OAuth
 * access token from this host's authorization server (worker/oauth.ts).
 * Without a valid token every request is a 401 whose WWW-Authenticate header
 * points at the RFC 9728 document for this resource, which is how an MCP
 * client finds the authorization server, registers, and sends the person to
 * sign in with GitHub. Each tool names the scope it needs; a token without it
 * gets a 403 with error="insufficient_scope".
 *
 * The tools act for the account the token was issued to, through the same
 * code as the signed-in app: lib/projects.ts, lib/spend.ts, lib/billing.ts,
 * lib/swarm.ts, and the /api/onboarding/plan, /api/onboarding/state and
 * /api/projects/init routes. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { auth, type Principal } from "@/lib/auth";
import { getCredits, isBillingConfigured } from "@/lib/billing";
import { issuer, SCOPES, type Scope } from "@/lib/oauth";
import { parseRepo, type RepoPlan } from "@/lib/plan";
import { listProjects } from "@/lib/projects";
import { projectObject } from "@/lib/spend";
import { getSwarmState } from "@/lib/swarm";
import { currentRequest } from "@/worker/context";
import * as onboardingPlan from "@/server/routes/onboarding/plan/route";
import * as onboardingState from "@/server/routes/onboarding/state/route";
import * as projectsInit from "@/server/routes/projects/init/route";
import { MCP_VERSION } from "./mcp";
import { ORIGIN, SHORT } from "./narrative";

z.config({ jitless: true });

export const ACCOUNT_MCP_PATH = "/mcp/account";
/** The RFC 9728 document for this resource (path-specific, RFC 9728 §3). */
export const accountResourceMetadataUrl = () => `${issuer()}/.well-known/oauth-protected-resource${ACCOUNT_MCP_PATH}`;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/* Writes to the account, never destroys anything, and does the same thing when repeated. */
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const REPO_INPUT: Tool["inputSchema"] = {
  type: "object",
  required: ["repo"],
  properties: { repo: { type: "string", description: "The GitHub repository, owner/name or its github.com URL" } },
};

type AccountTool = Tool & { scope: Scope };

export const ACCOUNT_TOOLS: AccountTool[] = [
  {
    name: "my_projects",
    title: "My projects",
    description: "The account's projects: each protocol repository, the proofs repository its swarm works in (null until the swarm has been started on it), and when it was added. The live swarm's project (asyncswap/v2) is listed for every account. Needs swarm:read.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    scope: "swarm:read",
  },
  {
    name: "my_usage",
    title: "My usage",
    description: "What the swarm spent: the total today (UTC), this month and overall in USD, and the latest cost lines (repository, role, reference, amount, time) from the spend ledger. Needs swarm:read.",
    inputSchema: {
      type: "object",
      properties: { lines: { type: "integer", minimum: 1, maximum: 500, default: 50, description: "How many of the latest cost lines to return, default 50" } },
    },
    annotations: READ,
    scope: "swarm:read",
  },
  {
    name: "my_credits",
    title: "My credits",
    description: "The account's prepaid credits: the balance in cents and USD and every entry, deposits (Stripe Checkout) and the metered spend of model calls made on credits. Needs swarm:read.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    scope: "swarm:read",
  },
  {
    name: "swarm_state",
    title: "Swarm state",
    description: "The live state of the swarm across the account's projects: open issues and pull requests with fm: labels, recently merged pull requests, spend today, the latest cost lines, the chief's and the assistant's latest notes, the rebuild cycle and recent runs. The same read as the swarm workspace. Needs swarm:read.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    scope: "swarm:read",
  },
  {
    name: "plan_repository",
    title: "Plan a repository",
    description: "Runs the planner on a public Solidity repository, the same way the landing page and POST /api/onboarding/plan do, waits for it to finish, and returns the plan: a summary, the core contracts, the invariants worth proving, the first issues for the swarm and a suggested team size. The repository becomes one of the account's projects and its onboarding starts from this plan. Limits: five fresh plans per hour per address; a plan is cached for a week. Needs swarm:write.",
    inputSchema: REPO_INPUT,
    annotations: WRITE,
    scope: "swarm:write",
  },
  {
    name: "start_swarm",
    title: "Start the swarm on a repository",
    description: "Hands a planned repository to the swarm: creates <owner>/<name>-proofs from the formalmind/lean-template repository under the same owner (an existing one is reused) and lists it in the swarm's projects.json, so the dispatcher sweeps it on its next pass. The same step as Start in onboarding and POST /api/projects/init. Refuses unless the repository is already one of the account's projects (plan it first), and fails with the step named when the formalmind GitHub App is not installed on the owner. Consequential: it creates a repository on GitHub. Needs swarm:write.",
    inputSchema: REPO_INPUT,
    annotations: { ...WRITE, idempotentHint: true },
    scope: "swarm:write",
  },
];

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });
const json = (value: unknown): CallToolResult => text(JSON.stringify(value, null, 2));
const failure = (message: string): CallToolResult => ({ ...text(message), isError: true });

/* A request to one of this app's own routes, on behalf of the caller: the
 * route reads the session from the request in flight (the bearer token), and
 * the client's address so rate limits apply to it. */
function internal(method: "POST" | "PUT", path: string, body: unknown): Request {
  const original = currentRequest().request;
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["cf-connecting-ip", "x-forwarded-for"]) {
    const value = original.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Request(`${new URL(original.url).origin}${path}`, { method, headers, body: JSON.stringify(body) });
}

async function callTool(name: string, args: Record<string, unknown>, principal: Principal & { via: "token" }): Promise<CallToolResult> {
  const sub = principal.session.user.sub;
  switch (name) {
    case "my_projects":
      return json({ projects: await listProjects(sub) });
    case "my_usage": {
      const project = projectObject();
      if (!project) return failure("The PROJECT Durable Object binding is missing; see wrangler.jsonc.");
      const lines = Math.min(500, Math.max(1, Number(args.lines) || 50));
      const { costs, syncedAt } = await project.costs();
      const today = new Date().toISOString().slice(0, 10);
      const month = today.slice(0, 7);
      const sum = (prefix: string) => costs.filter((c) => c.createdAt.startsWith(prefix)).reduce((s, c) => s + c.usd, 0);
      return json({ spentTodayUsd: sum(today), spentThisMonthUsd: sum(month), spentTotalUsd: sum(""), lineCount: costs.length, syncedAt, lines: costs.slice(-lines) });
    }
    case "my_credits": {
      const credits = await getCredits(sub);
      return json({ configured: isBillingConfigured(), cents: credits.cents, usd: credits.cents / 100, deposits: credits.entries });
    }
    case "swarm_state": {
      const state = await getSwarmState(await listProjects(sub));
      return json({ ...state, costs: state.costs.slice(-20), merged: state.merged.slice(0, 10), runs: state.runs.slice(0, 10) });
    }
    case "plan_repository": {
      const repo = parseRepo(String(args.repo ?? ""));
      if (!repo) return failure("repo must be owner/name or a github.com URL.");
      const res = await onboardingPlan.POST(internal("POST", "/api/onboarding/plan", { repo }));
      const body = await res.text();
      if (!res.ok) {
        const error = (() => {
          try {
            return (JSON.parse(body) as { error?: string }).error;
          } catch {
            return undefined;
          }
        })();
        return failure(`${error ?? body} (HTTP ${res.status})`);
      }
      let plan: RepoPlan;
      try {
        plan = JSON.parse(body) as RepoPlan;
      } catch {
        return failure("The planner did not finish a plan; try again in a minute.");
      }
      const planned = res.headers.get("x-plan-repo") ?? repo;
      // The same step the web app takes once a plan is in: it becomes the account's onboarding and one of its projects.
      const saved = await onboardingState.PUT(internal("PUT", "/api/onboarding/state", { repo: planned, plan }));
      if (!saved.ok) return failure(`The plan is ready but could not be saved to the account (HTTP ${saved.status}).`);
      return json({ repo: planned, cached: res.headers.get("x-plan-cache") === "hit", plan });
    }
    case "start_swarm": {
      const repo = parseRepo(String(args.repo ?? ""));
      if (!repo) return failure("repo must be owner/name or a github.com URL.");
      const res = await projectsInit.POST(internal("POST", "/api/projects/init", { repo }));
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return failure(`${typeof body.error === "string" ? body.error : "Starting the swarm failed."}${body.step ? ` (step: ${body.step})` : ""} (HTTP ${res.status})`);
      return json({ repo, ...body });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

interface ToolHandlers {
  setRequestHandler(schema: typeof ListToolsRequestSchema, handler: () => Promise<{ tools: Tool[] }>): void;
  setRequestHandler(
    schema: typeof CallToolRequestSchema,
    handler: (request: { params: { name: string; arguments?: Record<string, unknown> } }) => Promise<CallToolResult>,
  ): void;
}

/* The tool list as the SDK wants it: without this file's `scope` field. */
const publicTools = (): Tool[] =>
  ACCOUNT_TOOLS.map((t) => {
    const tool: Tool & { scope?: Scope } = { ...t };
    delete tool.scope;
    return tool;
  });

function buildServer(principal: Principal & { via: "token" }): Server {
  const who = principal.session.user.nickname ?? principal.session.user.sub;
  const server = new Server(
    { name: "formalmind-account", version: MCP_VERSION },
    {
      capabilities: { tools: {} },
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        `${SHORT} These tools act for the Formal Mind account of ${who} (scopes: ${principal.scopes.join(", ")}): its projects, usage, credits and swarm state, and with swarm:write, planning a repository and starting the swarm on it. The swarm's public record is also readable without a token at ${ORIGIN}/mcp.`,
    },
  );
  const handlers = server as unknown as ToolHandlers;
  handlers.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: publicTools() }));
  handlers.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = ACCOUNT_TOOLS.find((t) => t.name === request.params.name);
    if (tool && !principal.scopes.includes(tool.scope)) return failure(`insufficient_scope: ${tool.name} needs the ${tool.scope} scope (${SCOPES[tool.scope]}).`);
    try {
      return await callTool(request.params.name, request.params.arguments ?? {}, principal);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  });
  return server;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, accept",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, www-authenticate",
};

function refused(status: 401 | 403, challenge: string, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "www-authenticate": challenge, "cache-control": "no-store", ...CORS },
  });
}

/* Which tool a JSON-RPC body calls, if it is a tools/call, so a scope the
 * token lacks is a 403 at the HTTP level (RFC 6750 §3.1) and not a tool
 * result an agent might read past. */
async function requestedTool(request: Request): Promise<AccountTool | null> {
  if (request.method !== "POST") return null;
  const body = (await request
    .clone()
    .json()
    .catch(() => null)) as { method?: string; params?: { name?: string } } | { method?: string; params?: { name?: string } }[] | null;
  const messages = Array.isArray(body) ? body : body ? [body] : [];
  for (const m of messages) {
    if (m?.method === "tools/call") return ACCOUNT_TOOLS.find((t) => t.name === m.params?.name) ?? null;
  }
  return null;
}

export async function handleAccountMcp(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const principal = await auth.getPrincipal();
  const metadata = `resource_metadata="${accountResourceMetadataUrl()}"`;
  if (principal.via !== "token") {
    const invalid = principal.via === "invalid";
    const challenge = invalid ? `Bearer ${metadata}, error="invalid_token", error_description="${(principal.reason ?? "invalid token").replace(/"/g, "'")}"` : `Bearer ${metadata}`;
    return refused(401, challenge, invalid ? "invalid_token" : "unauthorized", invalid ? `The access token was refused: ${principal.reason}.` : `This endpoint needs an OAuth access token from ${issuer()}; see ${accountResourceMetadataUrl()}.`);
  }
  const tool = await requestedTool(request);
  if (tool && !principal.scopes.includes(tool.scope)) {
    return refused(403, `Bearer ${metadata}, error="insufficient_scope", scope="${tool.scope}"`, "insufficient_scope", `${tool.name} needs the ${tool.scope} scope (${SCOPES[tool.scope]}); the token has ${principal.scopes.join(" ") || "none"}.`);
  }

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildServer(principal);
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } finally {
    await transport.close().catch(() => {});
  }
}
