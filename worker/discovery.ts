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

import { handleSkills } from "./skills";
import { handleMcp, serverCard } from "./mcp";
import { handleWellKnown } from "./wellKnown";
import {
  APP_REPO,
  CHANGELOG,
  DESCRIPTION,
  GITHUB_APP,
  HOW_IT_WORKS,
  MAC_DOWNLOAD,
  ORIGIN,
  PLANNED,
  PROOFS_REPO,
  PROTOCOL_DOC,
  PROTOCOL_REPO,
  SHORT,
  SITE_NAME,
  STATUS_LINE,
  STATUS_SECTION,
  SWARM_DOC,
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
  const rules = ["Content-Signal: search=yes, ai-input=yes, ai-train=no", "Allow: /", "Disallow: /api/", "Disallow: /auth/", "Disallow: /login/callback", ""];
  const lines = [
    `# ${SITE_NAME}: a swarm of agents that keeps a Lean 4 specification of a Solidity protocol honest on every commit.`,
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
- [MCP server card](${ORIGIN}/.well-known/mcp/server-card.json): read-only MCP server at ${ORIGIN}/mcp (swarm state, open work, changelog, role documentation)
- [Agent Skills](${ORIGIN}/.well-known/agent-skills/index.json): how to ask the swarm on GitHub, and how to onboard a repository
- [API catalog](${ORIGIN}/.well-known/api-catalog): the one open endpoint and the MCP server
- [auth.md](${ORIGIN}/auth.md): how people sign in, and that there is no agent credential yet`;

/* llmstxt.org: a short orientation plus a curated reading list. */
function llmsTxt(): Response {
  const body = `# ${SITE_NAME}

> ${DESCRIPTION}

**${STATUS_LINE}**

${SHORT} The full account, roles, labels and safety rails included, is in [llms-full.txt](${ORIGIN}/llms-full.txt).

## Agents

- [MCP server card](${ORIGIN}/.well-known/mcp/server-card.json): read-only tools at ${ORIGIN}/mcp (Streamable HTTP, no auth): the swarm's live state, its open work, the proofs changelog and each role's instructions
- [Skill: ask-formalmind](${ORIGIN}/.well-known/agent-skills/ask-formalmind/SKILL.md): mention @formalmind or /ask a role in an issue or pull request of a proofs repository
- [Skill: onboard-a-repository](${ORIGIN}/.well-known/agent-skills/onboard-a-repository/SKILL.md): plan a repository, set a budget, add credits, install the GitHub App, start the swarm
- [auth.md](${ORIGIN}/auth.md): sign-in is GitHub, for people; no agent API key or token issuer exists yet

## The swarm

- [How the swarm works](${SWARM_DOC}): roles, labels, turns, budget and safety rails, in the swarm's own repository
- [FORMAL_MIND.md](${CHANGELOG}): the proofs changelog, one entry per run, including what could not be proved
- [Proofs repository](${PROOFS_REPO}): the Lean 4 + Mathlib specification of Async Swap v2 the swarm maintains
- [Protocol repository](${PROTOCOL_REPO}): the Solidity it models
- [Formal Mind protocol, v1 draft](${PROTOCOL_DOC}): the messages, records and rules each part of the system follows (draft)

## App

- [Landing page](${ORIGIN}/welcome): paste a public repository and watch the planner draft its first issues
- [Sign in](${ORIGIN}/login): GitHub sign-in; the swarm workspace, onboarding, billing and usage are behind it
- [GitHub App](${GITHUB_APP}): what the swarm installs in your repositories
- [Mac app](${MAC_DOWNLOAD}): the same app for the desktop, which can run agent turns on local folders
- [Source](${APP_REPO}): this web app and the Mac app

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

- **Read the swarm.** The MCP server at ${ORIGIN}/mcp (Streamable HTTP, JSON responses, no authentication) has four read-only tools: \`get_swarm_state\` (projects, open work with labels, merged pull requests, spend today, the chief's and the assistant's latest notes, the rebuild cycle, recent runs), \`list_open_work\` (open issues and pull requests carrying an fm: label, optionally filtered by label), \`get_changelog\` (the latest entries of FORMAL_MIND.md) and \`get_role_doc\` (a role's instructions). Everything they return is also public on GitHub.
- **Plan a repository.** \`POST ${ORIGIN}/api/onboarding/plan\` with body \`{"repo":"owner/name"}\` and no credentials. The response is \`text/plain\`: a JSON object streamed a few characters at a time, with the protocol summary, the contracts found, and the first issues the planner would open. Limits: public repositories with Solidity contracts outside tests and libraries; five plans per hour per address (429 after that); a plan is cached for a week and replayed (header \`X-Plan-Cache: hit\`).
- **Talk to the swarm on GitHub.** In a proofs repository the swarm works, mention \`@formalmind\` for the bot, or comment \`/ask <role> <question>\` to put a question to one role. This needs a GitHub account; the skill at ${ORIGIN}/.well-known/agent-skills/ask-formalmind/SKILL.md says how replies and reactions work.
- **Onboard a repository for a person.** Signing in, setting a budget, buying credits, installing the GitHub App and starting the swarm are browser flows behind GitHub sign-in; the skill at ${ORIGIN}/.well-known/agent-skills/onboard-a-repository/SKILL.md walks a person through them. There is no API for them.

${PLANNED}

## Links

- App: ${ORIGIN}
- Source: ${APP_REPO}
- GitHub App: ${GITHUB_APP}
- Swarm documentation: ${SWARM_DOC}
- Proofs changelog: ${CHANGELOG}
- Proofs: ${PROOFS_REPO}
- Protocol: ${PROTOCOL_REPO}
- Protocol v1 draft (this system's own protocol): ${PROTOCOL_DOC}
`;
  return text(body);
}

/* auth.md: how a client authenticates. People sign in with GitHub; no
 * credential exists for agents, and saying so is better than advertising an
 * authorization server that does not exist. */
function authMd(): Response {
  const body = `# auth.md

Formal Mind has GitHub sign-in for people and no credential for agents yet.

## Audience

AI agents and bots reading this site, calling the MCP server at ${ORIGIN}/mcp, or calling the one open endpoint, \`POST ${ORIGIN}/api/onboarding/plan\`.

## Registration

None. There is no account to create for an agent, no API key to request and no client registration endpoint. Send requests to the open endpoints without credentials.

## Supported methods

- Anonymous: the MCP server at ${ORIGIN}/mcp (Streamable HTTP, no Authorization header), \`POST /api/onboarding/plan\`, and every discovery document under /.well-known/.
- GitHub sign-in, for people in a browser: ${ORIGIN}/auth/login starts the formalmind GitHub App's user authorization and ${ORIGIN}/login/callback finishes it. The session is an httpOnly cookie. Every other /api/ route answers 401 without it.
- Desktop session token: the Mac app signs in through the browser at /api/desktop/authorize, trades a one-time code at /api/desktop/token for a bearer token (\`Authorization: Bearer fmd_…\`), and uses it on /api/ routes. These tokens are minted by this app for its own desktop client only; they are not issued to third parties.

## Credentials

No credential is sent to Formal Mind by an agent. People authenticate with GitHub; Formal Mind keeps the GitHub user token on the server and never hands it to the browser or to an agent.

## Metadata

RFC 9728 Protected Resource Metadata is at ${ORIGIN}/.well-known/oauth-protected-resource. Its \`authorization_servers\` list is empty: GitHub's OAuth has no RFC 8414 metadata, its tokens are not accepted by this app's API, and no token issuer of our own exists. If an agent API with credentials is added, an authorization server will be listed there and documented here.
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
          { href: `${ORIGIN}/llms-full.txt`, type: "text/plain", title: "Formal Mind: full reference for agents (MCP tools, the open plan endpoint, what is planned)" },
          { href: `${ORIGIN}/auth.md`, type: "text/markdown", title: "Authentication: none for agents" },
        ],
        "service-meta": [{ href: `${ORIGIN}/.well-known/mcp/server-card.json`, type: "application/mcp-server-card+json" }],
      },
      {
        anchor: `${ORIGIN}/api/onboarding/plan`,
        "service-doc": [
          { href: `${ORIGIN}/.well-known/agent-skills/onboard-a-repository/SKILL.md`, type: "text/markdown", title: "POST a repository, receive the planner's first issues as a text stream" },
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

  /* MCP endpoint takes GET, POST, DELETE and OPTIONS. */
  if (pathname === "/mcp") return handleMcp(request);
  if (pathname === "/mcp/server-card" || pathname === "/.well-known/mcp/server-card.json") return serverCard();

  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const skills = await handleSkills(pathname);
  if (skills) return skills;

  const wellKnown = handleWellKnown(request);
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
