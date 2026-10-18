/* Read-only MCP server at formal.team/mcp (Streamable HTTP, stateless).
 *
 * Four tools over what is already public on GitHub, so an agent can read the
 * swarm without learning its issues, labels and markers first. Nothing here
 * writes: talking to the swarm is done on GitHub (worker/skills.ts). The
 * server card for pre-connection discovery is served at
 * /.well-known/mcp/server-card.json and /mcp/server-card.
 *
 * Tools are declared with plain JSON Schema on the SDK's low-level Server:
 * the high-level McpServer infers its types from zod shapes, and this
 * repository's zod 3 and the SDK's nested zod do not agree. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { LIVE_PROJECT } from "@/lib/projects";
import { getSwarmState } from "@/lib/swarm";
import { APP_REPO, CHANGELOG_RAW, ORIGIN, ROLE_DOCS_RAW, SHORT, STATUS_LINE } from "./narrative";

/* zod 4 compiles object parsers with `new Function` when it believes the
 * runtime allows it; workerd lets the empty probe through and then rejects
 * the real thing ("Code generation from strings disallowed"), which the SDK
 * reports as a JSON-RPC parse error. One zod serves the whole tree
 * (package.json "overrides"), so this switch reaches the SDK's schemas too. */
z.config({ jitless: true });

const MCP_URL = `${ORIGIN}/mcp`;
export const MCP_VERSION = "0.1.0";

/* Role documentation files in asyncswap/v2-proofs/.github/formalmind/. */
const ROLE_DOCS: Record<string, string> = {
  overview: "README.md",
  planner: "plan.md",
  prover: "prove.md",
  reviewer: "review.md",
  merger: "merge.md",
  rebuilder: "rebuild.md",
  editor: "editor.md",
  consolidator: "consolidate.md",
  chief: "chief.md",
  assistant: "assistant.md",
  answer: "answer.md",
  cycle: "cycle.md",
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: true };

export const TOOLS: Tool[] = [
  {
    name: "get_swarm_state",
    title: "Swarm state",
    description:
      "The live state of the swarm: its projects (protocol and proofs repositories), open issues and pull requests carrying fm: labels, each project's recently merged pull requests, spend today and the latest cost lines in the ledger, the chief's and the assistant's latest notes, the rebuild cycle, and the latest workflow runs. Read from GitHub, cached for ten seconds.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: "list_open_work",
    title: "Open work",
    description:
      "Open issues and pull requests the swarm is working, across its projects, each with its fm: labels (fm:todo queued, fm:in-progress being worked, fm:review waiting for the reviewer, fm:approved waiting for the merger, fm:blocked waiting for a human, fm:rebuild and fm:finding for the rebuild cycle). Optionally only items carrying one label.",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string", pattern: "^fm:[a-z-]+$", description: "Only items with this fm: label, e.g. fm:review" } },
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_changelog",
    title: "Proofs changelog",
    description:
      "The latest entries of FORMAL_MIND.md in the proofs repository: one entry per run with the protocol commit reconciled, what changed in the spec, which theorems were added, changed or could not be proved, and what the build said. Newest first.",
    inputSchema: {
      type: "object",
      properties: { entries: { type: "integer", minimum: 1, maximum: 50, default: 5, description: "How many entries, default 5" } },
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_role_doc",
    title: "Role documentation",
    description:
      "The instructions a swarm role works from, as published in the proofs repository (.github/formalmind/): overview (the README: roles, labels, turns, budget, safety rails), planner, prover, reviewer, merger, rebuilder, editor, consolidator, chief, assistant, answer (how a role answers an /ask) or cycle (the rebuild cycle).",
    inputSchema: {
      type: "object",
      required: ["role"],
      properties: { role: { type: "string", enum: Object.keys(ROLE_DOCS), description: "Which document" } },
    },
    annotations: READ_ONLY,
  },
];

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { accept: "text/plain", "user-agent": "formalmind-mcp/" + MCP_VERSION } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });
const json = (value: unknown): CallToolResult => text(JSON.stringify(value, null, 2));

async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "get_swarm_state": {
      const state = await getSwarmState([LIVE_PROJECT]);
      return json({ ...state, costs: state.costs.slice(-20), merged: state.merged.slice(0, 10), runs: state.runs.slice(0, 10) });
    }
    case "list_open_work": {
      const label = typeof args.label === "string" && args.label ? args.label : undefined;
      if (label && !/^fm:[a-z-]+$/.test(label)) throw new Error("label must be an fm: label, like fm:todo");
      const state = await getSwarmState([LIVE_PROJECT]);
      const work = label ? state.work.filter((item) => item.labels.includes(label)) : state.work;
      return json({ fetchedAt: state.fetchedAt, count: work.length, work });
    }
    case "get_changelog": {
      const entries = Math.min(50, Math.max(1, Number(args.entries) || 5));
      const body = await getText(CHANGELOG_RAW);
      const [intro, ...rest] = body.split(/\n(?=## )/);
      return text([intro.trim(), ...rest.slice(0, entries)].join("\n\n"));
    }
    case "get_role_doc": {
      const file = typeof args.role === "string" ? ROLE_DOCS[args.role] : undefined;
      if (!file) throw new Error(`role must be one of ${Object.keys(ROLE_DOCS).join(", ")}`);
      return text(await getText(`${ROLE_DOCS_RAW}/${file}`));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/* `Server.setRequestHandler` infers its types from the SDK's request schemas,
 * which makes TypeScript give up here ("type instantiation is excessively
 * deep", the SDK's nested zod against this repository's). The same method,
 * seen through the two signatures this file needs; the runtime is unchanged
 * and the schemas still validate every request. */
interface ToolHandlers {
  setRequestHandler(schema: typeof ListToolsRequestSchema, handler: () => Promise<{ tools: Tool[] }>): void;
  setRequestHandler(
    schema: typeof CallToolRequestSchema,
    handler: (request: { params: { name: string; arguments?: Record<string, unknown> } }) => Promise<CallToolResult>,
  ): void;
}

function buildServer(): Server {
  const server = new Server(
    { name: "formalmind", version: MCP_VERSION },
    {
      capabilities: { tools: {} },
      /* The SDK's default validator (ajv) compiles schemas with `new Function`, which Workers forbid. */
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        SHORT +
        " " +
        STATUS_LINE +
        " These tools read the swarm's public record on GitHub (issues, labels, notebook comments and FORMAL_MIND.md); they change nothing. To ask the swarm something or onboard a repository, read the skills at " +
        ORIGIN +
        "/.well-known/agent-skills/index.json.",
    },
  );
  const handlers = server as unknown as ToolHandlers;
  handlers.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  handlers.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await callTool(request.params.name, request.params.arguments ?? {});
    } catch (error) {
      return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
    }
  });
  return server;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version, accept",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

/* Static card (SEP-2127 Server Card extension). The scanner at
 * isitagentready.com also looks for serverInfo / url / transport /
 * capabilities, so those are included alongside the spec's fields. */
export function serverCard(): Response {
  const card = {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: "formal.team/formalmind",
    version: MCP_VERSION,
    title: "Formal Mind swarm",
    description:
      "Read-only tools over the Formal Mind swarm's public record on GitHub: its live state, open issues and pull requests by fm: label, the proofs changelog (FORMAL_MIND.md) and each role's instructions. No authentication. Asking the swarm something or onboarding a repository happens on GitHub and at formal.team; see the Agent Skills at /.well-known/agent-skills/index.json.",
    websiteUrl: ORIGIN,
    repository: { source: "github", url: APP_REPO },
    remotes: [{ type: "streamable-http", url: MCP_URL, supportedProtocolVersions: ["2025-03-26", "2025-06-18", "2025-11-25"] }],
    serverInfo: { name: "formalmind", version: MCP_VERSION },
    url: MCP_URL,
    transport: { type: "streamable-http" },
    capabilities: { tools: true, resources: false, prompts: false },
  };
  return new Response(JSON.stringify(card, null, 2), {
    headers: {
      "content-type": "application/mcp-server-card+json; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    },
  });
}

/* Stateless: a fresh server and transport per request, JSON responses
 * rather than SSE, so the Worker holds nothing between calls. */
export async function handleMcp(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = buildServer();
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
