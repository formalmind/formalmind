/* Further /.well-known/ documents for agent discovery. Each one states
 * something that is true today: the authorization server listed here is
 * the one this Worker runs (worker/oauth.ts), and the resources it protects
 * are the account MCP server and the token-capable API routes. */

import { issuer, SCOPE_LIST } from "@/lib/oauth";
import { ACCOUNT_MCP_PATH } from "./account-mcp";
import { authorizationServerMetadata, jwksDocument } from "./oauth";
import { AUDIT_FORMAT_DOC, DESCRIPTION, EXAMPLE_REPO, ORIGIN, PROTOCOL_DOC, SITE_NAME } from "./narrative";

function json(body: unknown, contentType = "application/json; charset=utf-8"): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    },
  });
}

/* RFC 9728 Protected Resource Metadata. The authorization server is this
 * host's own (RFC 8414 metadata at /.well-known/oauth-authorization-server);
 * its access tokens are accepted by /mcp/account and by the API routes
 * listed in auth.md, each within its scope. People still sign in with
 * GitHub; the authorization server only lets a client hold a token for the
 * account that signed in. The root document describes the API; the
 * path-specific one (RFC 9728 §3) describes the account MCP server, which is
 * what an MCP client is pointed at by the 401 it gets without a token. */
function protectedResource(resourcePath = ""): Response {
  const iss = issuer();
  return json({
    resource: `${iss}${resourcePath}`,
    resource_name: resourcePath ? `${SITE_NAME} account MCP server` : `${SITE_NAME} API`,
    authorization_servers: [iss],
    scopes_supported: SCOPE_LIST,
    bearer_methods_supported: ["header"],
    resource_documentation: `${ORIGIN}/auth.md`,
    resource_policy_uri: `${ORIGIN}/terms`,
  });
}

/* Personal Agent Protocol (Poppy) discovery, website-only declaration:
 * personal agents browse the site as ordinary signed-out visitors. `auth`
 * is required only with `agent`, `apis` or a browser session endpoint,
 * none of which exist here. */
function poppy(hostname: string): Response {
  return json({
    protocol_version: "0.1",
    organization: {
      name: SITE_NAME,
      domain: hostname,
    },
    web: {},
  });
}

/* ARD / AI Catalog: the artifacts an agent can start from, each one already
 * published on this host or on GitHub. */
function aiCatalog(): Response {
  const id = (ns: string, name: string) => `urn:air:formal.team:${ns}:${name}`;
  return json({
    specVersion: "1.0",
    host: {
      displayName: SITE_NAME,
      identifier: "did:web:formal.team",
      description: DESCRIPTION,
      url: ORIGIN,
    },
    entries: [
      {
        identifier: id("server", "swarm"),
        displayName: "Formal Mind MCP servers",
        description: "One card, two remotes: read-only tools at /mcp (no auth): the audit format, Formal Mind's audit of an example repository, the desktop app's latest release; and the account tools at /mcp/account (OAuth 2.0 from this host, GitHub sign-in): your projects' files, audits, findings and Proofs coverage, usage, credits, the hosted and the Mac's swarm, planning a repository, setting up its specs and steering the Mac's swarm.",
        type: "application/mcp-server-card+json",
        url: `${ORIGIN}/.well-known/mcp/server-card.json`,
        representativeQueries: [
          "what is the latest version of the formal mind app",
          "what does a formal mind audit look like",
          "what did my swarm spend today",
          "plan my repository",
        ],
      },
      {
        identifier: id("skill", "run-the-local-swarm"),
        displayName: "Skill: run the local swarm",
        description: "Download the desktop app, add a Solidity folder, choose credits or your own key, and Start: the swarm proves each in-scope function in Lean 4 and files bugs with Foundry PoCs, keeping everything in the folder and nothing on GitHub.",
        type: "text/markdown",
        url: `${ORIGIN}/.well-known/agent-skills/run-the-local-swarm/SKILL.md`,
        representativeQueries: [
          "how do I get formal proofs for my Solidity repository",
          "how do I stop and resume the formal mind swarm",
        ],
      },
      {
        identifier: id("skill", "read-formal-mind-results"),
        displayName: "Skill: read Formal Mind's results",
        description: "The files Formal Mind keeps in a repository (.formal/, formal/, audit/) and the formalmind.audit/v1 format for audit reports and findings.",
        type: "text/markdown",
        url: `${ORIGIN}/.well-known/agent-skills/read-formal-mind-results/SKILL.md`,
        representativeQueries: [
          "which audit findings are still open in this repository",
          "what has formal mind proved about this contract",
        ],
      },
      {
        identifier: id("skill", "connect-formal-mind-as-mcp"),
        displayName: "Skill: connect Formal Mind as an MCP connector",
        description: "Add formal.team/mcp/account to Claude, ChatGPT or Cursor, sign in with GitHub, and ask about or act on your own account: projects, their audits, findings and Proofs coverage, usage, credits, swarm state, planning a repository, starting the swarm.",
        type: "text/markdown",
        url: `${ORIGIN}/.well-known/agent-skills/connect-formal-mind-as-mcp/SKILL.md`,
        representativeQueries: [
          "how do I add Formal Mind to Claude as a connector",
          "what did my swarm spend today",
        ],
      },
      {
        identifier: id("skill", "onboard-a-repository"),
        displayName: "Skill: onboard a repository",
        description: "Plan a Solidity repository, add it as a project (a local folder or a remote repository) with its Code, Bugs and Proofs tabs, and optionally set up specs built from its commits.",
        type: "text/markdown",
        url: `${ORIGIN}/.well-known/agent-skills/onboard-a-repository/SKILL.md`,
        representativeQueries: [
          "how do I add my repository to Formal Mind",
          "what does Formal Mind cost",
        ],
      },
      {
        identifier: id("doc", "llms-full"),
        displayName: "Formal Mind full reference for agents",
        description: "What Formal Mind is, how the local swarm works and where it keeps its files, what an agent can do here today, and what is planned.",
        type: "text/plain",
        url: `${ORIGIN}/llms-full.txt`,
        representativeQueries: [
          "what is Formal Mind",
          "is there an API for Formal Mind",
        ],
      },
      {
        identifier: id("doc", "audit-format"),
        displayName: "The formalmind.audit/v1 format",
        description: "One JSON file per audit report: the report's facts, every finding with its status in the current code, PoC and fix, and for Formal Mind's own audit the Proofs coverage and the properties proved. The Bugs tab reads it; the swarm writes it.",
        type: "text/markdown",
        url: AUDIT_FORMAT_DOC,
        representativeQueries: ["what fields does a formal mind audit finding have", "how do I make my audit report show in Formal Mind"],
      },
      {
        identifier: id("doc", "example-repository"),
        displayName: "Example: Async Swap's contracts",
        description: "A public repository Formal Mind works on: Lean proofs in formal/, Formal Mind's audit in audit/formal-mind.audit.json.",
        type: "text/html",
        url: EXAMPLE_REPO,
        representativeQueries: ["what does a repository look like after Formal Mind ran", "show me formal mind's lean proofs"],
      },
      {
        identifier: id("doc", "protocol-v1"),
        displayName: "Formal Mind protocol, v1 draft",
        description: "The messages, records and rules of the hosted side; a draft.",
        type: "text/markdown",
        url: PROTOCOL_DOC,
        representativeQueries: ["how will Formal Mind run one object per project"],
      },
    ],
  });
}

export function handleWellKnown(request: Request): Response | Promise<Response> | null {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/.well-known/oauth-protected-resource":
      return protectedResource();
    case `/.well-known/oauth-protected-resource${ACCOUNT_MCP_PATH}`:
      return protectedResource(ACCOUNT_MCP_PATH);
    case "/.well-known/oauth-authorization-server":
    case "/.well-known/oauth-authorization-server/":
      return authorizationServerMetadata();
    case "/.well-known/jwks.json":
      return jwksDocument();
    case "/.well-known/poppy.json":
      return poppy(url.hostname);
    case "/.well-known/ai-catalog.json":
      return aiCatalog();
  }
  return null;
}
