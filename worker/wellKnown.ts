/* Further /.well-known/ documents for agent discovery. Each one states
 * something that is true today; none advertises an authorization server,
 * agent endpoint or session feature Formal Mind does not run. */

import { CHANGELOG, DESCRIPTION, ORIGIN, PROTOCOL_DOC, SITE_NAME, SWARM_DOC } from "./narrative";

function json(body: unknown, contentType = "application/json; charset=utf-8"): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    },
  });
}

/* RFC 9728 Protected Resource Metadata. People sign in with GitHub, whose
 * OAuth publishes no RFC 8414 metadata and whose tokens this API does not
 * accept; the only bearer tokens the API takes are the ones it mints for its
 * own desktop app. So `authorization_servers` is empty, which the RFC
 * allows: no token issuer exists that a third party could use. */
function protectedResource(): Response {
  return json({
    resource: ORIGIN,
    resource_name: SITE_NAME,
    authorization_servers: [],
    scopes_supported: [],
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
        displayName: "Formal Mind swarm MCP server",
        description: "Read-only MCP tools: the swarm's live state, its open issues and pull requests by fm: label, the proofs changelog, and each role's instructions.",
        type: "application/mcp-server-card+json",
        url: `${ORIGIN}/.well-known/mcp/server-card.json`,
        representativeQueries: [
          "what is the formalmind swarm working on right now",
          "which pull requests are waiting for the merger",
          "what did the last proofs run change",
          "what does the reviewer role do",
        ],
      },
      {
        identifier: id("skill", "ask-formalmind"),
        displayName: "Skill: ask formalmind on GitHub",
        description: "How to mention @formalmind or /ask a role in an issue or pull request of a proofs repository, what the triage tiers do, and how replies and reactions work.",
        type: "text/markdown",
        url: `${ORIGIN}/.well-known/agent-skills/ask-formalmind/SKILL.md`,
        representativeQueries: [
          "how do I ask the formalmind bot a question about the spec",
          "how do I ask the prover to pick up an issue",
        ],
      },
      {
        identifier: id("skill", "onboard-a-repository"),
        displayName: "Skill: onboard a repository",
        description: "Plan a Solidity repository, set a daily budget, add prepaid credits, install the GitHub App, and start the swarm on it.",
        type: "text/markdown",
        url: `${ORIGIN}/.well-known/agent-skills/onboard-a-repository/SKILL.md`,
        representativeQueries: [
          "how do I get formal proofs for my Solidity repository",
          "what does Formal Mind cost and how is the budget enforced",
        ],
      },
      {
        identifier: id("doc", "llms-full"),
        displayName: "Formal Mind full reference for agents",
        description: "What the swarm is, how its roles, labels and budget work, what an agent can do here today, and what is planned.",
        type: "text/plain",
        url: `${ORIGIN}/llms-full.txt`,
        representativeQueries: [
          "what is Formal Mind",
          "is there an API for Formal Mind",
        ],
      },
      {
        identifier: id("doc", "swarm-readme"),
        displayName: "The formalmind swarm: roles, labels, turns and safety rails",
        description: "The swarm's own documentation in the proofs repository it maintains.",
        type: "text/markdown",
        url: SWARM_DOC,
        representativeQueries: ["what do the fm: labels mean", "how does the dispatcher choose the next job"],
      },
      {
        identifier: id("doc", "changelog"),
        displayName: "FORMAL_MIND.md, the proofs changelog",
        description: "One entry per run: the protocol commit reconciled, what changed in the spec, theorems added or not proved, and what the build said.",
        type: "text/markdown",
        url: CHANGELOG,
        representativeQueries: ["what could the swarm not prove", "which theorems were added recently"],
      },
      {
        identifier: id("doc", "protocol-v1"),
        displayName: "Formal Mind protocol, v1 draft",
        description: "The messages, records and rules each part of the system follows; a draft.",
        type: "text/markdown",
        url: PROTOCOL_DOC,
        representativeQueries: ["how will Formal Mind run one object per project"],
      },
    ],
  });
}

export function handleWellKnown(request: Request): Response | null {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/.well-known/oauth-protected-resource":
      return protectedResource();
    case "/.well-known/poppy.json":
      return poppy(url.hostname);
    case "/.well-known/ai-catalog.json":
      return aiCatalog();
  }
  return null;
}
