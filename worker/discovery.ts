/* Agent discovery layer for formal.team.
 *
 * Crawlers and AI agents look for a handful of well-known files before they
 * read a site. With `not_found_handling: "single-page-application"` every one
 * of them used to come back as the app's index.html with a 200, which
 * scanners read as a broken file (a soft 404). These handlers answer each
 * path with the right body and content-type, and give unknown /.well-known/
 * paths a real 404. See Cloudflare's Agent Readiness checks
 * (blog.cloudflare.com/agent-readiness) for what each file is for, and
 * worker/narrative.ts for the facts every document is built from. */

import { SCOPES } from "@/lib/oauth";
import { ACCOUNT_MCP_PATH, ACCOUNT_TOOLS, handleAccountMcp } from "./account-mcp";
import { handleSkills } from "./skills";
import { handleMcp, serverCard } from "./mcp";
import { handleWellKnown } from "./wellKnown";
import {
  AGENT_ACCESS,
  APP_REPO,
  AUDIT_FORMAT_DOC,
  DESCRIPTION,
  EXAMPLE_REPO,
  GITHUB_APP,
  HOW_IT_WORKS,
  MAC_DOWNLOAD,
  ORIGIN,
  PLANNED,
  PROTOCOL_DOC,
  RELEASES,
  SHORT,
  SITE_NAME,
  STATUS_LINE,
  STATUS_SECTION,
  WINDOWS_DOWNLOAD,
} from "./narrative";

/* Pages anyone can open without signing in (src/app.tsx routes plus the
 * static pages under public/). Everything else redirects to /login. */
export const PUBLIC_PATHS = ["/", "/welcome", "/login", "/terms", "/privacy", "/brand"];

/* The header every HTML response carries so an agent that lands on any
 * page finds the machine-readable entry points (RFC 8288 Link). */
export const DISCOVERY_LINK_HEADER = [
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</llms.txt>; rel="alternate"; type="text/plain"; title="llms.txt"',
  '</.well-known/mcp/server-card.json>; rel="alternate"; type="application/mcp-server-card+json"',
  '</.well-known/ai-catalog.json>; rel="ai-catalog"',
].join(", ");

function text(body: string, contentType = "text/plain; charset=utf-8", maxAge = 3600): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": `public, max-age=${maxAge}`,
      "x-robots-tag": "noindex",
    },
  });
}

/* RFC 9309 robots.txt with explicit AI crawler groups and a Content-Signal
 * line (contentsignals.org): search and answering from our pages are fine,
 * training on them is not. */
function robotsTxt(): Response {
  const aiCrawlers = [
    "GPTBot", "OAI-SearchBot", "ChatGPT-User",
    "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai",
    "PerplexityBot", "Perplexity-User",
    "Google-Extended", "Applebot-Extended",
    "CCBot", "Bytespider", "meta-externalagent", "Amazonbot",
  ];
  const rules = ["Content-Signal: search=yes, ai-input=yes, ai-train=no", "Allow: /", "Disallow: /api/", "Disallow: /auth/", "Disallow: /oauth/", "Disallow: /login/callback", ""];
  const lines = [
    `# ${SITE_NAME}: proves Solidity contracts correct in Lean 4, with a swarm of agents that runs on your own computer.`,
    "# Agents: start at /llms.txt and /.well-known/api-catalog.",
    "",
    "User-agent: *",
    ...rules,
    ...aiCrawlers.flatMap((ua) => [`User-agent: ${ua}`, ...rules]),
    `Sitemap: ${ORIGIN}/sitemap.xml`,
    "",
  ];
  return text(lines.join("\n"));
}

function sitemapXml(): Response {
  const today = new Date().toISOString().slice(0, 10);
  const urls = PUBLIC_PATHS
    .map((p) => `  <url><loc>${ORIGIN}${p}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq></url>`)
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return text(body, "application/xml; charset=utf-8", 86400);
}

/* The agent entry points, as a markdown section shared by llms.txt and the
 * markdown pages. */
export const AGENT_LINKS_MARKDOWN = `## For agents

- [llms.txt](${ORIGIN}/llms.txt) and [llms-full.txt](${ORIGIN}/llms-full.txt): orientation and the full account of the swarm
- [MCP server card](${ORIGIN}/.well-known/mcp/server-card.json): read-only MCP server at ${ORIGIN}/mcp (the audit format, an example audit, the desktop app's latest release) and the account server at ${ORIGIN}/mcp/account (your projects, usage, credits, swarm state, plan and start; OAuth 2.0)
- [Agent Skills](${ORIGIN}/.well-known/agent-skills/index.json): how to run the local swarm, how to onboard a repository, how to read Formal Mind's results in a repository, and how to connect Formal Mind as an MCP connector
- [API catalog](${ORIGIN}/.well-known/api-catalog): the open plan endpoint, the two MCP servers and the token-capable account routes
- [auth.md](${ORIGIN}/auth.md): GitHub sign-in for people; the OAuth 2.0 authorization server, scopes and tokens for agents`;

/* llmstxt.org: a short orientation plus a curated reading list. */
function llmsTxt(): Response {
  const body = `# ${SITE_NAME}

> ${DESCRIPTION}

**${STATUS_LINE}**

${SHORT} The full account, how the swarm works and where it keeps its files included, is in [llms-full.txt](${ORIGIN}/llms-full.txt).

## Agents

- [MCP server card](${ORIGIN}/.well-known/mcp/server-card.json): read-only tools at ${ORIGIN}/mcp (Streamable HTTP, no auth): get_audit_format, get_example_audit, get_app_release; and the account server at ${ORIGIN}/mcp/account (OAuth 2.0, GitHub sign-in): my_projects, my_usage, my_credits, swarm_state, plan_repository, start_swarm
- [Skill: connect-formal-mind-as-mcp](${ORIGIN}/.well-known/agent-skills/connect-formal-mind-as-mcp/SKILL.md): add ${ORIGIN}/mcp/account to Claude, ChatGPT or Cursor and act on your own account
- [Skill: run-the-local-swarm](${ORIGIN}/.well-known/agent-skills/run-the-local-swarm/SKILL.md): run the swarm on a folder in the desktop app; proofs, bugs and state stay in the folder
- [Skill: onboard-a-repository](${ORIGIN}/.well-known/agent-skills/onboard-a-repository/SKILL.md): plan a repository, add it as a project, optionally set up specs from its commits
- [Skill: read-formal-mind-results](${ORIGIN}/.well-known/agent-skills/read-formal-mind-results/SKILL.md): the files Formal Mind keeps in a repository and the formalmind.audit/v1 format
- [auth.md](${ORIGIN}/auth.md): GitHub sign-in for people; OAuth 2.0 (RFC 8414 metadata, dynamic registration, PKCE, refresh, revocation) for agents acting on an account

## Formal Mind

- [The audit format](${AUDIT_FORMAT_DOC}): formalmind.audit/v1, the JSON file per audit report that Bugs reads and the swarm writes
- [Example: Async Swap's contracts](${EXAMPLE_REPO}): Lean proofs in formal/, Formal Mind's audit in audit/formal-mind.audit.json
- [Formal Mind protocol, v1 draft](${PROTOCOL_DOC}): the messages, records and rules of the hosted side (draft)

## App

- [Download for Mac](${MAC_DOWNLOAD}): the desktop app, one universal build; the local swarm runs here
- [Download for Windows](${WINDOWS_DOWNLOAD}): the same app for Windows
- [Releases](${RELEASES}): every version of the desktop app
- [Landing page](${ORIGIN}/welcome): paste a public repository and watch the planner plan it
- [Sign in](${ORIGIN}/login): GitHub sign-in; projects, billing and usage are behind it
- [GitHub App](${GITHUB_APP}): installed on a repository's owner to set up specs from its commits
- [Source](${APP_REPO}): the website and the desktop app

## Optional

- [Terms](${ORIGIN}/terms)
- [Privacy](${ORIGIN}/privacy)
- [Brand kit](${ORIGIN}/brand)
`;
  return text(body);
}

/* Everything an agent needs in one file. */
function llmsFullTxt(): Response {
  const body = `# ${SITE_NAME}: full reference for agents

${DESCRIPTION}

${STATUS_SECTION}

${HOW_IT_WORKS}

## What an agent can do here today

- **Read what is public.** The MCP server at ${ORIGIN}/mcp (Streamable HTTP, JSON responses, no authentication) has three read-only tools: \`get_audit_format\` (the formalmind.audit/v1 format), \`get_example_audit\` (Formal Mind's audit of Async Swap's contracts: a summary, its findings, coverage or properties) and \`get_app_release\` (the desktop app's latest version, notes and downloads).
- **Read Formal Mind's files in a repository.** In a checkout where Formal Mind ran, \`.formal/plan.md\` is the plan and its progress, \`formal/\` the Lean proofs, and \`audit/*.audit.json\` the reports and findings; the skill at ${ORIGIN}/.well-known/agent-skills/read-formal-mind-results/SKILL.md says what each holds.
- **Plan a repository.** \`POST ${ORIGIN}/api/onboarding/plan\` with body \`{"repo":"owner/name"}\` and no credentials. The response is \`text/plain\`: a JSON object streamed a few characters at a time, with the protocol summary, the contracts found, and the work the planner would hand out. Limits: public repositories with Solidity contracts outside tests and libraries; five plans per hour per address (429 after that); a plan is cached for a week and replayed (header \`X-Plan-Cache: hit\`).
- **Help a person run the swarm.** The desktop app runs the swarm on a folder on the person's computer, with nothing on GitHub; it is started and steered in the app. The skill at ${ORIGIN}/.well-known/agent-skills/run-the-local-swarm/SKILL.md says how.
- **Act on a person's account.** With an OAuth access token from ${ORIGIN} (the person signs in with GitHub and allows the client on a consent page), the account MCP server at ${ORIGIN}/mcp/account and the API routes listed in ${ORIGIN}/auth.md give the account's projects, usage, credits and swarm state (\`swarm:read\`), and plan a repository or set up its specs (\`swarm:write\`). The section below says how.
- **Onboard a repository for a person.** Planning and setting up specs can be done with a \`swarm:write\` token (\`plan_repository\`, \`start_swarm\`, or \`POST /api/projects/init\`); adding a project, setting a budget, buying credits and installing the GitHub App are browser flows behind GitHub sign-in. The skill at ${ORIGIN}/.well-known/agent-skills/onboard-a-repository/SKILL.md walks a person through them.

${AGENT_ACCESS}

${PLANNED}

## Links

- App: ${ORIGIN}
- Source: ${APP_REPO}
- Download for Mac: ${MAC_DOWNLOAD}
- Download for Windows: ${WINDOWS_DOWNLOAD}
- Releases: ${RELEASES}
- GitHub App: ${GITHUB_APP}
- Audit format: ${AUDIT_FORMAT_DOC}
- Example repository: ${EXAMPLE_REPO}
- Protocol v1 draft (the hosted side's own protocol): ${PROTOCOL_DOC}
`;
  return text(body);
}

/* auth.md: how a client authenticates. People sign in with GitHub; agents
 * acting on a person's account use the OAuth 2.0 authorization server this
 * Worker runs (worker/oauth.ts, lib/oauth.ts). Every endpoint named here
 * answers. */
function authMd(): Response {
  const scopes = Object.entries(SCOPES)
    .map(([scope, what]) => `- \`${scope}\`: ${what.toLowerCase()}.`)
    .join("\n");
  const tools = (scope: string) => ACCOUNT_TOOLS.filter((t) => t.scope === scope).map((t) => `\`${t.name}\``).join(", ");
  const body = `# auth.md

Formal Mind has GitHub sign-in for people, and an OAuth 2.0 authorization server of its own for agents and MCP connectors that act on a person's account. A public verification-work API is planned; the credentials below are what it will use.

## Audience

MCP clients (Claude, ChatGPT, Cursor and any other remote-MCP connector), AI agents and bots calling the account MCP server at ${ORIGIN}${ACCOUNT_MCP_PATH} or the token-capable API routes below. The anonymous MCP server at ${ORIGIN}/mcp, \`POST ${ORIGIN}/api/onboarding/plan\` and every discovery document under /.well-known/ need no credential.

## Metadata

- RFC 8414 authorization server metadata: ${ORIGIN}/.well-known/oauth-authorization-server (issuer \`${ORIGIN}\`).
- RFC 9728 protected resource metadata: ${ORIGIN}/.well-known/oauth-protected-resource (the API) and ${ORIGIN}/.well-known/oauth-protected-resource${ACCOUNT_MCP_PATH} (the account MCP server). Both name \`${ORIGIN}\` as the authorization server and list the scopes.
- Signing keys: ${ORIGIN}/.well-known/jwks.json (ES256).

## Registration (RFC 7591)

\`POST ${ORIGIN}/oauth/register\` with a JSON client metadata document: \`client_name\`, \`redirect_uris\` (https URLs, http on the loopback with any port, or the app's own URI scheme), and optionally \`grant_types\` (\`authorization_code\`, \`refresh_token\`), \`response_types\` (\`code\`), \`scope\`, \`client_uri\`, \`logo_uri\`. Only public clients are registered: \`token_endpoint_auth_method\` is \`none\`. The answer is 201 with \`client_id\` (\`fmc_…\`), \`client_id_issued_at\` and the metadata as stored. Thirty registrations per hour per address. MCP clients do this on their own after the 401 described below.

## Authorization (authorization code with PKCE)

\`GET ${ORIGIN}/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&scope=swarm:read%20swarm:write&state=…&code_challenge=…&code_challenge_method=S256\`, optionally with \`resource=${ORIGIN}${ACCOUNT_MCP_PATH}\` (RFC 8707). PKCE with S256 is required; \`redirect_uri\` must be one the client registered.

- Without a session the person is sent through GitHub sign-in (${ORIGIN}/auth/login) and brought back to the same request.
- A consent page names the client and each scope. Allow sends the person to \`redirect_uri\` with \`code\`, \`state\` and \`iss\` (RFC 9207); Deny sends \`error=access_denied\`.
- A code lives ten minutes and works once.

## Token

\`POST ${ORIGIN}/oauth/token\` (form-encoded or JSON) with \`grant_type=authorization_code\`, \`code\`, \`code_verifier\`, \`redirect_uri\` and \`client_id\` returns \`{ access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope }\`.

- \`access_token\` is an ES256 JWT: \`iss\` \`${ORIGIN}\`, \`aud\` the \`resource\` the client asked for (or \`${ORIGIN}\`), \`sub\` the GitHub account (\`github|<id>\`), \`scope\`, \`client_id\`, \`exp\` one hour after \`iat\`, \`jti\`, plus \`name\`, \`nickname\` and \`email\` as GitHub reported them. Verify it against the JWKS.
- \`refresh_token\` (\`fmr_…\`) is opaque, lasts thirty days and works once: \`grant_type=refresh_token\` with \`refresh_token\` and \`client_id\` returns a new pair and the old refresh token stops working. \`scope\` may narrow the grant, never widen it.
- Errors follow RFC 6749 §5.2: \`invalid_client\` (401), \`invalid_grant\`, \`invalid_scope\`, \`unsupported_grant_type\`.

## Revocation (RFC 7009)

\`POST ${ORIGIN}/oauth/revoke\` with \`token\` (and optionally \`token_type_hint\`). A refresh token is deleted; an access token is refused for the rest of its hour. The answer is 200 either way.

## Scopes

${scopes}

Everything else on the account (chat, billing checkout, the GitHub App, onboarding settings) stays behind the person's own sign-in; no scope reaches it.

## What accepts a token

Send \`Authorization: Bearer <access_token>\`.

- The account MCP server, ${ORIGIN}${ACCOUNT_MCP_PATH} (Streamable HTTP, JSON responses): ${tools("swarm:read")} need \`swarm:read\`; ${tools("swarm:write")} need \`swarm:write\`.
- API routes: \`GET /api/projects\`, \`GET /api/usage\`, \`GET /api/billing/balance\` and \`GET /api/swarm/state\` with \`swarm:read\`; \`POST /api/projects/init\` (body \`{"repo":"owner/name"}\`) with \`swarm:write\`.

Without a credential these answer 401 with \`WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource[${ACCOUNT_MCP_PATH}]"\`, which is how an MCP client finds this authorization server. A token that does not verify gets 401 with \`error="invalid_token"\`; a valid token without the scope gets 403 with \`error="insufficient_scope"\` and the scope it needs. Every other /api/ route needs the person's own session and answers 403 to an OAuth token.

## With curl alone

\`\`\`sh
# 1. Register a public client (once; keep the client_id).
curl -s ${ORIGIN}/oauth/register -H 'content-type: application/json' \\
  -d '{"client_name":"my agent","redirect_uris":["http://127.0.0.1:9876/callback"]}'
# → {"client_id":"fmc_…","client_id_issued_at":…,"redirect_uris":[…],"grant_types":[…],"scope":"swarm:read swarm:write",…}

# 2. PKCE: a verifier and its S256 challenge.
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/' | cut -c1-64)
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# 3. Open this in the person's browser; they sign in with GitHub and click Allow.
#    The browser lands on redirect_uri?code=…&state=…&iss=${ORIGIN}
echo "${ORIGIN}/oauth/authorize?response_type=code&client_id=fmc_…&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&scope=swarm%3Aread%20swarm%3Awrite&state=xyz&code_challenge=$CHALLENGE&code_challenge_method=S256&resource=${ORIGIN}${ACCOUNT_MCP_PATH}"

# 4. Exchange the code within ten minutes.
curl -s ${ORIGIN}/oauth/token -d grant_type=authorization_code -d code=… -d code_verifier="$VERIFIER" \\
  -d redirect_uri=http://127.0.0.1:9876/callback -d client_id=fmc_…
# → {"access_token":"eyJ…","token_type":"Bearer","expires_in":3600,"refresh_token":"fmr_…","scope":"swarm:read swarm:write"}

# 5. Use it.
curl -s ${ORIGIN}/api/projects -H "authorization: Bearer $ACCESS_TOKEN"
curl -s ${ORIGIN}${ACCOUNT_MCP_PATH} -H "authorization: Bearer $ACCESS_TOKEN" -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"my_usage","arguments":{}}}'

# 6. Renew (the old refresh token stops working) and revoke.
curl -s ${ORIGIN}/oauth/token -d grant_type=refresh_token -d refresh_token=fmr_… -d client_id=fmc_…
curl -s ${ORIGIN}/oauth/revoke -d token=fmr_…
\`\`\`

## Error shapes

- Authorization server endpoints: a JSON body \`{"error":"…","error_description":"…"}\` (RFC 6749 §5.2, RFC 7591 §3.2.2): \`invalid_client_metadata\` or \`invalid_redirect_uri\` (400) from registration, \`invalid_request\`, \`invalid_scope\`, \`invalid_target\`, \`unsupported_response_type\` or \`access_denied\` as query parameters on the redirect from authorize, \`invalid_client\` (401), \`invalid_grant\`, \`invalid_scope\` or \`unsupported_grant_type\` (400) from the token endpoint. A client or redirect_uri problem at authorize is an HTML page, never a redirect.
- Protected routes and ${ACCOUNT_MCP_PATH}: 401 \`{"error":"unauthenticated"|"unauthorized"|"invalid_token","error_description":"…"}\` with \`WWW-Authenticate: Bearer resource_metadata="…"[, error="invalid_token", error_description="…"][, scope="…"]\`; 403 \`{"error":"insufficient_scope","error_description":"…","scope":"swarm:write"}\` with \`WWW-Authenticate: Bearer error="insufficient_scope", scope="…"\`. A tool that fails for another reason returns an MCP result with \`isError: true\` and the reason as text.

## Other methods

- Anonymous: the MCP server at ${ORIGIN}/mcp, \`POST /api/onboarding/plan\`, and every discovery document under /.well-known/.
- GitHub sign-in, for people in a browser: ${ORIGIN}/auth/login starts the formalmind GitHub App's user authorization and ${ORIGIN}/login/callback finishes it. The session is an httpOnly cookie.
- Desktop session token: the Mac app signs in through the browser at /api/desktop/authorize, trades a one-time code at /api/desktop/token for a bearer token (\`Authorization: Bearer fmd_…\`), and uses it on /api/ routes as the person. These tokens are minted for the app's own desktop client only and are unchanged by the OAuth server.

## Credentials

The GitHub user token stays on the Worker; it is never handed to the browser, to the Mac app or to an OAuth client. An access token carries the account's \`sub\`, \`name\`, \`nickname\` and \`email\` and nothing from GitHub. Access tokens are signed with the Worker's OAUTH_SIGNING_KEY secret; only its public half is published.
`;
  return text(body, "text/markdown; charset=utf-8");
}

/* RFC 9727 API catalog: a linkset naming what a client can call and where
 * it is described. There is no REST API with an OpenAPI document; the catalog
 * names the open plan endpoint and the MCP server, and points service-doc at
 * the written documentation, which is where an agent should start. */
function apiCatalog(): Response {
  const body = {
    linkset: [
      {
        anchor: `${ORIGIN}/mcp`,
        "service-doc": [
          { href: `${ORIGIN}/llms-full.txt`, type: "text/plain", title: "Formal Mind: full reference for agents (MCP tools, the open plan endpoint, account access, what is planned)" },
          { href: `${ORIGIN}/auth.md`, type: "text/markdown", title: "Authentication: none for this server" },
        ],
        "service-meta": [{ href: `${ORIGIN}/.well-known/mcp/server-card.json`, type: "application/mcp-server-card+json" }],
      },
      {
        anchor: `${ORIGIN}${ACCOUNT_MCP_PATH}`,
        "service-doc": [
          { href: `${ORIGIN}/auth.md`, type: "text/markdown", title: "Authentication: OAuth 2.0 access token from this host (registration, PKCE, scopes swarm:read and swarm:write)" },
          { href: `${ORIGIN}/.well-known/agent-skills/connect-formal-mind-as-mcp/SKILL.md`, type: "text/markdown", title: "Connect Formal Mind as an MCP connector in Claude, ChatGPT or Cursor" },
        ],
        "service-meta": [
          { href: `${ORIGIN}/.well-known/mcp/server-card.json`, type: "application/mcp-server-card+json" },
          { href: `${ORIGIN}/.well-known/oauth-protected-resource${ACCOUNT_MCP_PATH}`, type: "application/json", title: "RFC 9728 protected resource metadata" },
          { href: `${ORIGIN}/.well-known/oauth-authorization-server`, type: "application/json", title: "RFC 8414 authorization server metadata" },
        ],
      },
      {
        anchor: `${ORIGIN}/api/projects`,
        "service-doc": [{ href: `${ORIGIN}/auth.md`, type: "text/markdown", title: "GET with a swarm:read token: the account's projects; also GET /api/usage, /api/billing/balance, /api/swarm/state (swarm:read) and POST /api/projects/init (swarm:write)" }],
        "service-meta": [{ href: `${ORIGIN}/.well-known/oauth-protected-resource`, type: "application/json", title: "RFC 9728 protected resource metadata" }],
      },
      {
        anchor: `${ORIGIN}/api/onboarding/plan`,
        "service-doc": [
          { href: `${ORIGIN}/.well-known/agent-skills/onboard-a-repository/SKILL.md`, type: "text/markdown", title: "POST a repository, receive the planner's plan as a text stream" },
        ],
      },
    ],
  };
  return text(JSON.stringify(body, null, 2), "application/linkset+json; charset=utf-8", 86400);
}

/* Returns a response for a discovery path, or null when the path is not one
 * (the caller then falls through to the API and the SPA assets). Unknown
 * /.well-known/ paths get a plain 404 so scanners do not mistake the app
 * shell for a server card or a key directory we do not publish. */
export async function handleDiscovery(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);

  /* MCP endpoints take GET, POST, DELETE and OPTIONS. */
  if (pathname === "/mcp") return handleMcp(request);
  if (pathname === ACCOUNT_MCP_PATH) return handleAccountMcp(request);
  if (pathname === "/mcp/server-card" || pathname === "/.well-known/mcp/server-card.json") return serverCard();

  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const skills = await handleSkills(pathname);
  if (skills) return skills;

  const wellKnown = await handleWellKnown(request);
  if (wellKnown) return wellKnown;

  switch (pathname) {
    case "/robots.txt":
      return robotsTxt();
    case "/sitemap.xml":
      return sitemapXml();
    case "/llms.txt":
      return llmsTxt();
    case "/llms-full.txt":
      return llmsFullTxt();
    case "/.well-known/api-catalog":
      return apiCatalog();
    case "/auth.md":
      return authMd();
  }

  if (pathname.startsWith("/.well-known/")) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  }

  return null;
}
