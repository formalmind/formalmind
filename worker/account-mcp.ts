/* Account MCP server at formal.team/mcp/account (Streamable HTTP, stateless).
 *
 * The same setup as the anonymous server in worker/mcp.ts, behind an OAuth
 * access token from this host's authorization server (worker/oauth.ts), or
 * the desktop app's own sign-in token (`fmd_…`, every scope: it is the
 * person's session).
 * Without a valid token every request is a 401 whose WWW-Authenticate header
 * points at the RFC 9728 document for this resource, which is how an MCP
 * client finds the authorization server, registers, and sends the person to
 * sign in with GitHub. Each tool names the scope it needs; a token without it
 * gets a 403 with error="insufficient_scope".
 *
 * The tools act for the account the token was issued to, through the same
 * code as the signed-in app: lib/projects.ts, lib/spend.ts, lib/billing.ts,
 * lib/swarm.ts, lib/relay.ts (the Mac app's swarm), lib/project-repo.ts and
 * lib/project-audits.ts (a project's files, audits and Proofs coverage, read
 * from GitHub), and the /api/projects, /api/onboarding/plan,
 * /api/onboarding/state and /api/projects/init routes. What runs only on the
 * Mac (the debugger, concolity's coverage and explore, formal-ast on a working
 * tree) is not here; docs/MCP.md lists it. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { auth } from "@/lib/auth";
import { getCredits, hasSpend, isBillingConfigured, REPORT_USD } from "@/lib/billing";
import { issuer, SCOPE_LIST, SCOPES, type Scope } from "@/lib/oauth";
import { parseRepo, type RepoPlan } from "@/lib/plan";
import { findingRow, planProgress, readAudits, reportSummary, REPORT_DIRS, where } from "@/lib/project-audits";
import { openProject } from "@/lib/project-repo";
import { listProjects } from "@/lib/projects";
import { MAC_OPS, parseCommand, relayObject, type MacOp, type RelayEvent, type RelayRow } from "@/lib/relay";
import { projectObject } from "@/lib/spend";
import { getSwarmState } from "@/lib/swarm";
import { currentRequest } from "@/worker/context";
import * as onboardingPlan from "@/server/routes/onboarding/plan/route";
import * as onboardingState from "@/server/routes/onboarding/state/route";
import * as projectsInit from "@/server/routes/projects/init/route";
import * as projectsAdd from "@/server/routes/projects/route";
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

const REF = { type: "string", description: "A branch, tag or commit; the default branch when absent. Every read in the call is pinned to the commit it resolves to, which the result names." };
const REPO = { type: "string", description: "One of your projects, owner/name or its github.com URL" };
const DIRS = { type: "array", items: { type: "string" }, description: `Report folders, repository-relative; default ${REPORT_DIRS.join(", ")}` };
const FOLDER = { type: "string", description: "A folder added in the Mac app: its path, its name, or the owner/name of its GitHub origin (see mac_swarm)" };

/** MAC_OPS of one kind, one line each, for a tool's description. */
const opsList = (write: boolean) =>
  Object.entries(MAC_OPS)
    .filter(([, o]) => o.write === write)
    .map(([name, o]) => `${name}${o.args ? ` (${o.args})` : ""}: ${o.about}`)
    .join("; ");
const OP_ARGS = { type: "object", description: "The operation's arguments, by name (see the list above)", additionalProperties: true };

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
    description: "The hosted swarm on GitHub (the earlier, GitHub-based swarm; the desktop app's local swarm is mac_swarm), across the account's projects: open issues and pull requests with fm: labels, recently merged pull requests, spend today, the latest cost lines, the chief's and the assistant's latest notes, the rebuild cycle and recent runs. The same read as the swarm workspace. Needs swarm:read.",
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
  {
    name: "add_project",
    title: "Add a project",
    description: "Adds a GitHub repository to the account's projects (Add a project → Remote repository; POST /api/projects), so the project tools can read it. Nothing is planned or started. A private repository is read through the formalmind GitHub App, which must be installed on its owner. Needs swarm:write.",
    inputSchema: REPO_INPUT,
    annotations: WRITE,
    scope: "swarm:write",
  },
  {
    name: "list_files",
    title: "List a project's files",
    description: "A project's file paths at a commit, from GitHub. Leaves out .git, node_modules, lib, dependencies, out, cache, target, .lake, dist, broadcast and .next unless prefix names one. Filter with prefix (a folder) and ext (e.g. sol, lean). Returns {repo, commit, count, files, truncated}. Needs swarm:read.",
    inputSchema: {
      type: "object",
      required: ["repo"],
      properties: {
        repo: REPO,
        ref: REF,
        prefix: { type: "string", description: "Only paths under this folder, e.g. src or formal/Refinement" },
        ext: { type: "string", description: "Only files with this extension, without the dot" },
        limit: { type: "integer", minimum: 1, maximum: 5000, default: 1000 },
      },
    },
    annotations: READ,
    scope: "swarm:read",
  },
  {
    name: "read_file",
    title: "Read a project file",
    description: "One file of a project as text, at a commit, optionally a line range (1-based, inclusive). Long files are cut at 2000 lines unless a range is given; the result says how many lines there are. Needs swarm:read.",
    inputSchema: {
      type: "object",
      required: ["repo", "path"],
      properties: {
        repo: REPO,
        path: { type: "string", description: "Repository-relative path" },
        ref: REF,
        from: { type: "integer", minimum: 1, description: "First line" },
        to: { type: "integer", minimum: 1, description: "Last line" },
      },
    },
    annotations: READ,
    scope: "swarm:read",
  },
  {
    name: "list_audits",
    title: "A project's audit reports",
    description: "Every formalmind.audit/v1 report in a project's report folders (<report>.audit.json; get_audit_format on /mcp describes it), each as its facts and counts: kind (external, or internal for Formal Mind's own), title, auditor, date, audited commit, findings by severity and by status in the current code, Proofs coverage totals and properties for an internal one. Also report files with no .audit.json yet, .audit.json files that don't parse, the swarm's .formal/bugs/ notes, and whether Formal Mind's PDF is there. Needs swarm:read.",
    inputSchema: { type: "object", required: ["repo"], properties: { repo: REPO, ref: REF, dirs: DIRS } },
    annotations: READ,
    scope: "swarm:read",
  },
  {
    name: "list_findings",
    title: "Findings",
    description: "The findings across a project's audit reports as short rows {report, id, title, severity, status, at: [file:line]}, most severe first. Filter by report (its path or title), severity and status (open, fixed, acknowledged, works as expected, rejected). get_finding returns one in full. Needs swarm:read.",
    inputSchema: {
      type: "object",
      required: ["repo"],
      properties: {
        repo: REPO,
        ref: REF,
        dirs: DIRS,
        report: { type: "string", description: "Only this report: its .audit.json path or (part of) its title" },
        severity: { type: "string", description: "critical, high, medium, low, informational or gas" },
        status: { type: "string", description: "open, fixed, acknowledged, works as expected or rejected" },
      },
    },
    annotations: READ,
    scope: "swarm:read",
  },
  {
    name: "get_finding",
    title: "One finding",
    description: "One finding in full, as its report has it: description, impact, recommendation, the team's response, the evidence for its status, tests, PoC and fix. Name it by id (e.g. H-01, FM-03); give report when two reports use the same id. Needs swarm:read.",
    inputSchema: {
      type: "object",
      required: ["repo", "id"],
      properties: { repo: REPO, id: { type: "string" }, report: { type: "string", description: "Its report's .audit.json path or (part of) its title" }, ref: REF, dirs: DIRS },
    },
    annotations: READ,
    scope: "swarm:read",
  },
  {
    name: "proofs_coverage",
    title: "Proofs coverage",
    description: "What the Lean proofs cover, from Formal Mind's audit (the internal formalmind.audit/v1 report, which the desktop app writes from formal-ast and the reviewed proofs): per contract, its functions, how many are in the Lean model, proved, with a sorry, not modeled, and the theorem count; with contract, that contract's function rows (status, theorems, why). Also the properties proved (id, title, status, theorems; with contract, only that contract's) and, when .formal/plan.md is committed, the swarm's plan progress (done, to do, stuck). Coverage is as of the report's commit; regenerate the report in the app for a newer one. Needs swarm:read.",
    inputSchema: {
      type: "object",
      required: ["repo"],
      properties: { repo: REPO, ref: REF, dirs: DIRS, contract: { type: "string", description: "One contract's function rows" } },
    },
    annotations: READ,
    scope: "swarm:read",
  },
  {
    name: "report_quote",
    title: "Report quote",
    description: `What Formal Mind's audit report for a repository and commit costs ($${REPORT_USD}, once per repository and commit), whether that commit is already paid for, and the credit balance. Only a quote: the report is generated and paid for in the desktop app (Bugs → Generate report), on the Mac. Needs swarm:read.`,
    inputSchema: {
      type: "object",
      required: ["repo", "commit"],
      properties: { repo: { type: "string", description: "owner/name" }, commit: { type: "string", description: "The commit, 7 to 40 hex characters" } },
    },
    annotations: READ,
    scope: "swarm:read",
  },
  {
    name: "mac_swarm",
    title: "The Mac's swarm",
    description: "The swarm running in the account's desktop app, through the formal.team relay: whether the Mac is online and when it was last seen, its name, and each added folder (path, name, GitHub origin) with its sessions (run id, title, outcome, spent in USD, running). The work and the files stay on the Mac; this is what it publishes. Empty until the app has signed in with the relay on (Settings → Phone). Needs swarm:read.",
    inputSchema: { type: "object", properties: {} },
    annotations: { ...READ, idempotentHint: false },
    scope: "swarm:read",
  },
  {
    name: "mac_swarm_events",
    title: "The Mac's swarm events",
    description: "The latest events of the Mac's swarm sessions (the relay keeps the most recent few thousand; the Mac's .formal/runs/<run>.jsonl is the full record), oldest first, as {seq, at, folder, run, kind, role, item, text, spent}; text is cut at 600 characters. Filter by folder, run and kind; pass after (a seq from an earlier call) for only what is new. A session the Mac sent as history comes as its events. Needs swarm:read.",
    inputSchema: {
      type: "object",
      properties: {
        folder: FOLDER,
        run: { type: "string", description: "One session's run id" },
        kind: { type: "string", description: "Only this event kind" },
        after: { type: "integer", minimum: 0, description: "Only events after this seq" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 60 },
      },
    },
    annotations: { ...READ, idempotentHint: false },
    scope: "swarm:read",
  },
  {
    name: "mac_swarm_send",
    title: "Steer the Mac's swarm",
    description: "Sends the desktop app a command through the relay, as the phone does: say (a message to a session's assistant, answered before the next turn: run and text), start (a session in a folder, optionally a goal, a budget in USD up to 1000, and the run to continue) or stop (run). The Mac runs it as if typed there; a command it doesn't pick up within 10 minutes is dropped. Consequential: start runs agents on the Mac with the model route its Settings use (the person's Claude plan, credits or key). Returns the command's seq; follow with mac_swarm_events. Needs swarm:write.",
    inputSchema: {
      type: "object",
      required: ["type", "folder"],
      properties: {
        type: { type: "string", enum: ["say", "start", "stop"] },
        folder: FOLDER,
        run: { type: "string", description: "The session (say, stop; optional for start)" },
        text: { type: "string", description: "say: the message" },
        goal: { type: "string", description: "start: what to work on" },
        budget: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: "start: the spending cap in USD" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "swarm:write",
  },
  {
    name: "mac_get",
    title: "Read from the Mac app",
    description: `Reads from the desktop app on the person's Mac, through the relay, as the app's own pages do; the answer comes back from the Mac (waits up to ~50 s; if it hasn't come, mac_reply with the returned id). Operations: ${opsList(false)}. The Mac must be online with the app signed in and Settings → Phone on (mac_swarm shows it).`,
    inputSchema: {
      type: "object",
      required: ["op"],
      properties: {
        op: { type: "string", enum: Object.keys(MAC_OPS).filter((k) => !MAC_OPS[k as MacOp].write) },
        folder: FOLDER,
        args: OP_ARGS,
      },
    },
    annotations: { ...READ, idempotentHint: false },
    scope: "swarm:read",
  },
  {
    name: "mac_do",
    title: "Act in the Mac app",
    description: `Does anything the desktop app's folder page does, on the person's Mac, through the relay: the Mac runs it as if clicked there, with the model route and caps its Settings use, and answers with the result (waits up to ~50 s; then mac_reply with the returned id). Operations: ${opsList(true)}. Consequential: start, hunt, statements and triage run agents that spend the person's Claude plan, credits or key; report spends $150 of credits; add_folder lets the app (and these tools) read that folder.`,
    inputSchema: {
      type: "object",
      required: ["op"],
      properties: {
        op: { type: "string", enum: Object.keys(MAC_OPS).filter((k) => MAC_OPS[k as MacOp].write) },
        folder: FOLDER,
        args: OP_ARGS,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "swarm:write",
  },
  {
    name: "mac_reply",
    title: "A Mac call's answer",
    description: "The Mac's answer to a mac_get or mac_do call that hadn't come back in time, by the id it returned (answers are kept 30 minutes). Waits up to ~25 s for it.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    annotations: { ...READ, idempotentHint: false },
    scope: "swarm:read",
  },
];

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });
/* Compact: an agent reads every byte of it. */
const json = (value: unknown): CallToolResult => text(JSON.stringify(value));
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

/** Who the tools act for: an OAuth token within its scopes, or the desktop app's session with all of them. */
type Caller = { sub: string; who: string; via: "token" | "desktop"; scopes: Scope[] };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const lower = (v: unknown) => str(v).toLowerCase();
const SEVERITY_ORDER = ["critical", "high", "medium", "low", "informational", "gas"];
const severityRank = (s: string) => {
  const i = SEVERITY_ORDER.indexOf(s.toLowerCase());
  return i < 0 ? SEVERITY_ORDER.length : i;
};
/** Folders the file list leaves out unless asked for (as the Code tab's tree does: server/routes/projects/tree). */
const SKIP_DIRS = new Set([".git", "node_modules", "lib", "dependencies", "out", "cache", "target", ".lake", "dist", "broadcast", ".next"]);
const READ_LINES = 2000;

/** A report named by its path or (part of) its title. */
const matchesReport = (path: string, title: string, wanted: string) => !wanted || path.toLowerCase() === wanted || title.toLowerCase().includes(wanted);

/** A relay row as the agent sees it: its text cut short, its time readable. */
const eventRow = (e: RelayEvent & { seq?: number; at?: number }) => ({
  ...(e.seq !== undefined ? { seq: e.seq } : {}),
  ...(e.at ? { at: new Date(e.at).toISOString() } : {}),
  folder: e.folder,
  run: e.run,
  kind: e.kind,
  role: e.role,
  item: e.item || undefined,
  text: e.text.length > 600 ? `${e.text.slice(0, 600)}…` : e.text,
  spent: e.spent || undefined,
});

async function callTool(name: string, args: Record<string, unknown>, caller: Caller): Promise<CallToolResult> {
  const sub = caller.sub;
  const project = async () => {
    const opened = await openProject(sub, str(args.repo), str(args.ref) || undefined);
    if ("error" in opened) throw new Error(opened.error);
    return opened;
  };
  const dirs = () => (Array.isArray(args.dirs) && args.dirs.length ? args.dirs.map((d) => String(d).replace(/^\.?\/+|\/+$/g, "")).filter(Boolean) : REPORT_DIRS);
  const relay = () => {
    const r = relayObject(sub);
    if (!r) throw new Error("The RELAY Durable Object binding is missing; see wrangler.jsonc.");
    return r;
  };
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
    case "add_project": {
      const repo = parseRepo(str(args.repo));
      if (!repo) return failure("repo must be owner/name or a github.com URL.");
      const res = await projectsAdd.POST(internal("POST", "/api/projects", { repo }));
      const body = (await res.json().catch(() => ({}))) as { repo?: string; error?: string };
      if (!res.ok) return failure(`${body.error ?? "Adding the project failed."} (HTTP ${res.status})`);
      return json({ repo: body.repo ?? repo, projects: (await listProjects(sub)).map((p) => p.repo) });
    }
    case "list_files": {
      const p = await project();
      const prefix = str(args.prefix).replace(/^\.?\/+|\/+$/g, "");
      const ext = str(args.ext).replace(/^\./, "").toLowerCase();
      const limit = Math.min(5000, Math.max(1, Number(args.limit) || 1000));
      const { files, truncated } = await p.tree();
      const picked = files.filter(
        (f) =>
          (!prefix || f.startsWith(`${prefix}/`)) &&
          (!ext || f.toLowerCase().endsWith(`.${ext}`)) &&
          !f.slice(prefix ? prefix.length + 1 : 0).split("/").slice(0, -1).some((d) => SKIP_DIRS.has(d)),
      );
      return json({ repo: p.repo, commit: p.commit, count: picked.length, files: picked.slice(0, limit), truncated: truncated || picked.length > limit });
    }
    case "read_file": {
      const path = str(args.path).replace(/^\.?\/+/, "");
      if (!path || path.split("/").includes("..")) return failure("path must be a repository-relative file path.");
      const p = await project();
      const body = await p.file(path);
      if (body === null) return failure(`${path} isn't in ${p.repo} at ${p.commit.slice(0, 12)}.`);
      const lines = body.split("\n");
      const ranged = args.from !== undefined || args.to !== undefined;
      const from = Math.max(1, Number(args.from) || 1);
      const to = Math.min(lines.length, Number(args.to) || (ranged ? lines.length : READ_LINES));
      return json({ repo: p.repo, commit: p.commit, path, lines: lines.length, from, to, text: lines.slice(from - 1, to).join("\n"), ...(to < lines.length && !ranged ? { cut: `first ${READ_LINES} lines; pass from/to for more` } : {}) });
    }
    case "list_audits": {
      const p = await project();
      const audits = await readAudits(p, dirs());
      const pdf = audits.files.filter((f) => /(^|\/)formal-mind\.pdf$/.test(f));
      return json({
        repo: p.repo,
        commit: p.commit,
        dirs: dirs(),
        reports: audits.reports.map((r) => reportSummary(r.path, r.doc)),
        ...(audits.unconverted.length ? { unconverted: audits.unconverted } : {}),
        ...(audits.invalid.length ? { invalid: audits.invalid } : {}),
        ...(audits.swarmBugs.length ? { swarmBugs: audits.swarmBugs } : {}),
        ...(pdf.length ? { formalMindPdf: pdf } : {}),
        ...(audits.truncated ? { truncated: true } : {}),
      });
    }
    case "list_findings": {
      const p = await project();
      const audits = await readAudits(p, dirs());
      const report = lower(args.report);
      const severity = lower(args.severity);
      const status = lower(args.status);
      const rows = audits.reports
        .filter((r) => matchesReport(r.path, r.doc.title, report))
        .flatMap((r) => r.doc.findings.map((f) => findingRow(r.path, f)))
        .filter((f) => (!severity || String(f.severity).toLowerCase() === severity) && (!status || f.status.toLowerCase() === status))
        .sort((a, b) => severityRank(String(a.severity)) - severityRank(String(b.severity)));
      return json({ repo: p.repo, commit: p.commit, count: rows.length, findings: rows });
    }
    case "get_finding": {
      const id = lower(args.id);
      if (!id) return failure("id is required.");
      const p = await project();
      const audits = await readAudits(p, dirs());
      const report = lower(args.report);
      const hits = audits.reports
        .filter((r) => matchesReport(r.path, r.doc.title, report))
        .flatMap((r) => r.doc.findings.filter((f) => f.id.toLowerCase() === id).map((f) => ({ report: r.path, reportTitle: r.doc.title, auditedCommit: r.doc.commit, ...f, locations: where(f.locations) })));
      if (!hits.length) return failure(`No finding ${args.id} in the reports of ${p.repo}${report ? ` matching ${args.report}` : ""}.`);
      if (hits.length > 1) return failure(`${args.id} is in ${hits.length} reports (${hits.map((h) => h.report).join(", ")}); pass report.`);
      return json({ repo: p.repo, commit: p.commit, finding: hits[0] });
    }
    case "proofs_coverage": {
      const p = await project();
      const [audits, plan] = await Promise.all([readAudits(p, dirs()), p.file(".formal/plan.md")]);
      const internal = audits.reports.filter((r) => r.doc.kind === "internal");
      const contract = lower(args.contract);
      const reports = internal.map(({ path, doc }) => {
        const coverage = doc.coverage ?? [];
        const one = contract ? coverage.find((c) => c.contract.toLowerCase() === contract) : undefined;
        return {
          path,
          title: doc.title,
          commit: doc.commit,
          date: doc.date,
          contracts: coverage.map(({ rows: _rows, ...counts }) => counts),
          ...(one ? { rows: one.rows ?? [] } : {}),
          properties: (doc.properties ?? []).filter((pr) => !one || pr.title.toLowerCase().startsWith(`${contract}.`)).map((pr) => ({ id: pr.id, title: pr.title, status: pr.status, theorems: (pr.theorems ?? []).map((t) => t.name), at: where(pr.locations) })),
        };
      });
      if (contract && !reports.some((r) => "rows" in r)) {
        const known = [...new Set(internal.flatMap((r) => (r.doc.coverage ?? []).map((c) => c.contract)))];
        return failure(`No coverage for ${args.contract}${known.length ? `; contracts with coverage: ${known.join(", ")}` : ""}.`);
      }
      return json({
        repo: p.repo,
        commit: p.commit,
        reports,
        ...(plan !== null ? { plan: planProgress(plan) } : {}),
        ...(!internal.length ? { note: "No internal (Formal Mind) audit report here yet: the desktop app writes audit/formal-mind.audit.json as the swarm proves and reviews, and Bugs → Generate report fills in the coverage." } : {}),
      });
    }
    case "report_quote": {
      const repo = str(args.repo).replace(/[^\w./-]/g, "").slice(0, 100);
      const commit = lower(args.commit);
      if (!repo || !/^[0-9a-f]{7,40}$/.test(commit)) return failure("repo (owner/name) and commit (7 to 40 hex characters) are required.");
      const [paid, credits] = await Promise.all([hasSpend(sub, `report:${repo}@${commit}`), getCredits(sub)]);
      return json({ repo, commit, priceUsd: REPORT_USD, paid, balanceUsd: credits.cents / 100, enough: paid || credits.cents >= REPORT_USD * 100 });
    }
    case "mac_swarm": {
      const { state, macSeenAt } = await relay().read(Number.MAX_SAFE_INTEGER, false);
      return json({
        online: macSeenAt !== null && Date.now() - macSeenAt < 90_000,
        lastSeen: macSeenAt ? new Date(macSeenAt).toISOString() : null,
        name: state?.name ?? null,
        folders: (state?.folders ?? []).map((f) => ({ ...f, sessions: f.sessions.map((s) => ({ ...s, spent: Math.round(s.spent * 100) / 100 })) })),
      });
    }
    case "mac_swarm_events": {
      const r = relay();
      const after = Math.max(0, Number(args.after) || 0);
      const limit = Math.min(500, Math.max(1, Number(args.limit) || 60));
      const { events, last, state } = await r.read(after, false);
      const folder = lower(args.folder);
      const folders = state?.folders ?? [];
      const inFolder = (path: string) => {
        if (!folder) return true;
        const f = folders.find((x) => x.path === path);
        return path.toLowerCase() === folder || f?.name.toLowerCase() === folder || f?.repo?.toLowerCase() === folder;
      };
      const run = str(args.run);
      const kind = lower(args.kind);
      const expanded = events.flatMap((e: RelayRow) => {
        if (e.kind !== "history") return [e];
        try {
          return (JSON.parse(e.text) as RelayEvent[]).map((h) => ({ ...h, seq: e.seq, at: e.at }));
        } catch {
          return [];
        }
      });
      const picked = expanded.filter((e) => inFolder(e.folder) && (!run || e.run === run) && (!kind || e.kind.toLowerCase() === kind));
      return json({ last, count: picked.length, events: picked.slice(-limit).map(eventRow), ...(picked.length > limit ? { earlier: picked.length - limit } : {}) });
    }
    case "mac_swarm_send": {
      const r = relay();
      const wanted = str(args.folder);
      const { state } = await r.read(Number.MAX_SAFE_INTEGER, false);
      const folders = state?.folders ?? [];
      const match = folders.find((f) => [f.path, f.name, f.repo ?? ""].some((v) => v.toLowerCase() === wanted.toLowerCase()));
      if (!match) return failure(`${wanted || "folder"} isn't one of the Mac's folders${folders.length ? `: ${folders.map((f) => f.path).join(", ")}` : " (it has published none; is the app signed in, with Settings → Phone on?)"}.`);
      const command = parseCommand({ ...args, folder: match.path });
      if (!command || command.type === "history") return failure("Not a command: say needs run and text, stop needs run, start takes an optional run, goal and budget (up to 1000).");
      const seq = await r.send(command);
      return json({ sent: command, seq, note: "Queued for the Mac; it picks commands up within seconds while online and drops them after 10 minutes." });
    }
    case "mac_get":
    case "mac_do": {
      const op = str(args.op) as MacOp;
      if (!Object.hasOwn(MAC_OPS, op) || MAC_OPS[op].write !== (name === "mac_do")) return failure(`${op || "op"} isn't a ${name} operation.`);
      const r = relay();
      let folder = "";
      // Ops about the Mac rather than one folder; health is for every folder when none is named.
      const macWide = ["folders", "status", "add_folder", "remove_folder"].includes(op) || (op === "health" && !str(args.folder));
      if (!macWide) {
        const wanted = str(args.folder);
        const { state } = await r.read(Number.MAX_SAFE_INTEGER, false);
        const folders = state?.folders ?? [];
        const match = folders.find((f) => [f.path, f.name, f.repo ?? ""].some((v) => v.toLowerCase() === wanted.toLowerCase()));
        if (!match) return failure(`${wanted || "folder"} isn't one of the Mac's folders${folders.length ? `: ${folders.map((f) => f.path).join(", ")}` : " (it has published none; is the app signed in, with Settings → Phone on?)"}.`);
        folder = match.path;
      }
      const command = parseCommand({ type: "call", folder, id: crypto.randomUUID(), op, args: args.args ?? {} });
      if (!command || command.type !== "call") return failure("Arguments too large, or not an object.");
      await r.send(command);
      const reply = (await r.reply(command.id, true)) ?? (await r.reply(command.id, true));
      if (!reply) return json({ id: command.id, pending: true, note: "The Mac hasn't answered yet (it may be offline, or the operation is long). Ask again with mac_reply." });
      return reply.ok ? json({ id: command.id, result: reply.result }) : failure(`The Mac: ${reply.error}`);
    }
    case "mac_reply": {
      const reply = await relay().reply(str(args.id), true);
      if (!reply) return json({ id: str(args.id), pending: true });
      return reply.ok ? json({ id: reply.id, result: reply.result }) : failure(`The Mac: ${reply.error}`);
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

function buildServer(caller: Caller): Server {
  const { who } = caller;
  const server = new Server(
    { name: "formalmind-account", version: MCP_VERSION },
    {
      capabilities: { tools: {} },
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        `${SHORT} These tools act for the Formal Mind account of ${who} (scopes: ${caller.scopes.join(", ")}): its projects and their files, audit reports, findings and Proofs coverage (read from GitHub at a commit), its usage and credits, the swarm running in its desktop app (through the relay), and with swarm:write, adding and planning a repository and steering the Mac's swarm. Start with my_projects, then list_audits or proofs_coverage on one. Results are compact JSON. The debugger and concolity run only on the Mac; public reads (the audit format, an example audit, the app's latest release) need no token at ${ORIGIN}/mcp.`,
    },
  );
  const handlers = server as unknown as ToolHandlers;
  handlers.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: publicTools() }));
  handlers.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = ACCOUNT_TOOLS.find((t) => t.name === request.params.name);
    if (tool && !caller.scopes.includes(tool.scope)) return failure(`insufficient_scope: ${tool.name} needs the ${tool.scope} scope (${SCOPES[tool.scope]}).`);
    try {
      return await callTool(request.params.name, request.params.arguments ?? {}, caller);
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
  if (principal.via !== "token" && principal.via !== "desktop") {
    const invalid = principal.via === "invalid";
    const challenge = invalid ? `Bearer ${metadata}, error="invalid_token", error_description="${(principal.reason ?? "invalid token").replace(/"/g, "'")}"` : `Bearer ${metadata}`;
    return refused(401, challenge, invalid ? "invalid_token" : "unauthorized", invalid ? `The access token was refused: ${principal.reason}.` : `This endpoint needs an OAuth access token from ${issuer()} (see ${accountResourceMetadataUrl()}) or the desktop app's sign-in token.`);
  }
  const user = principal.session.user;
  const caller: Caller = { sub: user.sub, who: user.nickname ?? user.sub, via: principal.via, scopes: principal.via === "token" ? principal.scopes : SCOPE_LIST };
  const tool = await requestedTool(request);
  if (tool && !caller.scopes.includes(tool.scope)) {
    return refused(403, `Bearer ${metadata}, error="insufficient_scope", scope="${tool.scope}"`, "insufficient_scope", `${tool.name} needs the ${tool.scope} scope (${SCOPES[tool.scope]}); the token has ${caller.scopes.join(" ") || "none"}.`);
  }

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildServer(caller);
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
