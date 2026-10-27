/* Read-only MCP server at formal.team/mcp (Streamable HTTP, stateless).
 *
 * Three tools over what is public: the audit format Formal Mind reads and
 * writes, Formal Mind's audit of an example repository in that format, and the
 * desktop app's latest release. Nothing here writes, and the swarm itself runs
 * in the desktop app (worker/skills.ts says how). The server card for
 * pre-connection discovery is served at /.well-known/mcp/server-card.json and
 * /mcp/server-card.
 *
 * Tools are declared with plain JSON Schema on the SDK's low-level Server:
 * the high-level McpServer infers its types from zod shapes, and this
 * repository's zod 3 and the SDK's nested zod do not agree. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import type { AuditDoc } from "@/lib/audit-format";
import { APP_REPO, AUDIT_FORMAT_RAW, EXAMPLE_AUDIT_RAW, EXAMPLE_REPO, ORIGIN, SHORT, STATUS_LINE } from "./narrative";

/* zod 4 compiles object parsers with `new Function` when it believes the
 * runtime allows it; workerd lets the empty probe through and then rejects
 * the real thing ("Code generation from strings disallowed"), which the SDK
 * reports as a JSON-RPC parse error. One zod serves the whole tree
 * (package.json "overrides"), so this switch reaches the SDK's schemas too. */
z.config({ jitless: true });

const MCP_URL = `${ORIGIN}/mcp`;
export const MCP_VERSION = "0.4.0";
const PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];

const AUDIT_SECTIONS = ["summary", "findings", "coverage", "properties", "full"] as const;

const READ_ONLY = { readOnlyHint: true, openWorldHint: true };

export const TOOLS: Tool[] = [
  {
    name: "get_audit_format",
    title: "Audit format",
    description:
      "The formalmind.audit/v1 format: one JSON file per audit report (<report>.audit.json), with the report's facts, every finding (id, severity, status in the current code, locations, description, impact, recommendation, evidence, PoC, fix) and, for Formal Mind's own audit, the Proofs coverage of each contract and the properties proved. The Bugs tab reads only this format. Returns docs/audit-format.md.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: "get_example_audit",
    title: "Example audit",
    description: `Formal Mind's audit of Async Swap's contracts (${EXAMPLE_REPO}), audit/formal-mind.audit.json, as the swarm left it: what a finished run looks like. section "summary" (default) gives the report's facts and counts per contract; "findings", "coverage" or "properties" gives that list; "full" the whole file.`,
    inputSchema: {
      type: "object",
      properties: { section: { type: "string", enum: [...AUDIT_SECTIONS], default: "summary", description: "Which part of the file" } },
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_app_release",
    title: "Desktop app release",
    description:
      "The Formal Mind desktop app's latest release: its version, when it was published, its notes, and the download links for macOS (one universal build) and Windows. The local swarm runs in this app.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
];

async function get(url: string, accept = "text/plain"): Promise<Response> {
  const headers: Record<string, string> = { accept, "user-agent": "formalmind-mcp/" + MCP_VERSION };
  if (url.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res;
}

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });
const json = (value: unknown): CallToolResult => text(JSON.stringify(value, null, 2));

async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "get_audit_format":
      return text(await (await get(AUDIT_FORMAT_RAW)).text());
    case "get_example_audit": {
      const section = typeof args.section === "string" && args.section ? args.section : "summary";
      if (!(AUDIT_SECTIONS as readonly string[]).includes(section)) throw new Error(`section must be one of ${AUDIT_SECTIONS.join(", ")}`);
      const audit = (await (await get(EXAMPLE_AUDIT_RAW, "application/json")).json()) as AuditDoc;
      if (section === "full") return json(audit);
      if (section !== "summary") return json(audit[section as "findings" | "coverage" | "properties"] ?? []);
      const { findings = [], coverage = [], properties = [], ...facts } = audit;
      return json({
        ...facts,
        findings: findings.length,
        properties: properties.length,
        coverage: coverage.map(({ rows: _rows, ...counts }) => counts),
      });
    }
    case "get_app_release": {
      const release = (await (await get("https://api.github.com/repos/formalmind/formalmind/releases/latest", "application/vnd.github+json")).json()) as {
        tag_name: string;
        published_at: string;
        html_url: string;
        body?: string;
        assets: { name: string; browser_download_url: string }[];
      };
      const asset = (file: string) => release.assets.find((a) => a.name === file)?.browser_download_url ?? null;
      return json({
        version: release.tag_name.replace(/^desktop-v/, ""),
        published: release.published_at,
        url: release.html_url,
        downloads: { mac: asset("Formal-Mind-mac.dmg"), windows: asset("Formal-Mind-windows-setup.exe") },
        notes: release.body ?? "",
      });
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
        " These tools read what is public: the audit format, Formal Mind's audit of an example repository, and the desktop app's latest release; they change nothing. The swarm runs in the desktop app. To run it, onboard a repository or read Formal Mind's files in one, read the skills at " +
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
    title: "Formal Mind",
    description:
      "Two remotes. /mcp: read-only tools, no authentication: the formalmind.audit/v1 format Formal Mind's Bugs tab reads, Formal Mind's audit of an example repository (Async Swap's contracts) in that format, and the desktop app's latest release. /mcp/account: the signed-in person's own projects (their files, formalmind.audit/v1 reports, findings and Proofs coverage, read from GitHub at a commit) and the desktop app's swarm through the relay, reading and driving everything the desktop app does on the person's Mac (mac_get, mac_do), behind an OAuth 2.0 access token from this host's authorization server (GitHub sign-in; RFC 9728 metadata at /.well-known/oauth-protected-resource/mcp/account, RFC 8414 at /.well-known/oauth-authorization-server). The swarm itself runs locally in the desktop app; see the Agent Skills at /.well-known/agent-skills/index.json.",
    websiteUrl: ORIGIN,
    repository: { source: "github", url: APP_REPO },
    remotes: [
      { type: "streamable-http", url: MCP_URL, supportedProtocolVersions: PROTOCOL_VERSIONS, authentication: { required: false } },
      {
        type: "streamable-http",
        url: `${ORIGIN}/mcp/account`,
        supportedProtocolVersions: PROTOCOL_VERSIONS,
        authentication: {
          required: true,
          type: "oauth2",
          authorizationServer: ORIGIN,
          resourceMetadata: `${ORIGIN}/.well-known/oauth-protected-resource/mcp/account`,
          scopes: ["swarm:read", "swarm:write"],
          description: "Unauthenticated requests get 401 with WWW-Authenticate: Bearer resource_metadata=…; the client registers at /oauth/register, authorizes with PKCE at /oauth/authorize (GitHub sign-in and a consent page), and exchanges the code at /oauth/token. Documented at /auth.md.",
        },
      },
    ],
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
