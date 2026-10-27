/* Agent Skills published at /.well-known/agent-skills/ (agentskills.io).
 *
 * The index lists each skill with a sha256 digest of the SKILL.md as served,
 * so a client can tell when one changed. Every claim below names its source:
 * the code under desktop/, lib/ and server/routes/ in this repository, or
 * desktop/README.md and docs/audit-format.md. */

import { MAC_DOWNLOAD, ORIGIN, STATUS_LINE, WINDOWS_DOWNLOAD } from "./narrative";

interface Skill {
  name: string;
  description: string;
  body: string;
}

const LOCAL_SWARM: Skill = {
  name: "run-the-local-swarm",
  description:
    "Run the Formal Mind swarm on a Solidity repository on your own computer: download the app, add the folder, pick who runs the model (your Claude plan through Claude Code, your Anthropic key or your OpenAI key), and Start. A planner, provers and a reviewer write and check Lean 4 proofs of each in-scope function and file bugs with Foundry PoCs, keeping everything in the folder (.formal/, formal/, audit/, test/) and nothing on GitHub. Use when a person wants formal proofs or an audit of their contracts, or asks how the swarm works, what it costs or how to stop and resume it.",
  body: `# Run the local swarm

> **${STATUS_LINE}**

The swarm runs in the Formal Mind desktop app, on a folder on your computer. The code, \`lake\` and \`forge\` stay on the machine; only the model calls leave it. It opens no issues or pull requests, sets no labels, comments nowhere and pushes nothing: its tools cannot run git.

## 1. Install and add the folder

1. Download the app: macOS ${MAC_DOWNLOAD} (one universal build), Windows ${WINDOWS_DOWNLOAD}. It updates itself.
2. Sign in with GitHub (the app opens the browser and comes back on its own).
3. **Add a project → Local folder** and pick the repository. Only folders you add can be read, and nothing is uploaded.

The folder needs Solidity the swarm can compile with solc (it reads remappings from the repository's files) and, for proving, a Lean 4 toolchain (\`elan\`); a Lake project in the folder or in \`formal/\` is used when there is one. \`forge\` runs bug PoCs.

## 2. Choose who pays

Settings → Models, one of:

- **Claude Code** (the default): your own Claude plan, through the \`claude\` you installed and signed in to; nothing is metered, and the plan's usage limits apply.
- **Your Anthropic key** (Claude) or **your OpenAI key** (GPT-5, GPT-5 mini), kept in the system keychain; the calls go straight to that provider.

## 3. Start

On the folder's page, type an optional focus ("the matching engine first") and press **Start**; set a spending cap in the chat header. The swarm then:

1. **Plans**, without a model: \`.formal/plan.md\` gets one item per function of the in-scope contracts (what the Foundry scripts under \`script/\` deploy or call, their bases and what they deploy), the scripts' calls first, then the functions that write storage, then views. Functions already proved come checked.
2. **Proves**: a prover takes the next \`- [ ]\` item with the function's slice of the solc AST and its generated Lean model (\`formal/Specs/<Contract>.lean\`), writes \`formal/Proofs/Swarm/<Contract><Fn>.lean\` and runs \`lake build\`.
3. **Checks**: no \`sorry\`, \`admit\`, \`axiom\` or \`native_decide\`, a clean build, and the Proofs page counting the function as proved. Three failures mark the item \`- [!]\`.
4. **Reviews**: the reviewer checks the theorems and the prover's notes against the Solidity; approved items are \`- [x]\` and their notes go into \`audit/formal-mind.audit.json\`.
5. **Files bugs**: a finding needs a Foundry PoC under \`test/\` (by convention \`test/formal/\`) that the swarm runs with \`forge test\`; it lands in \`audit/formal-mind-swarm.md\`, the audit index \`audit/README.md\` and \`audit/formal-mind.audit.json\`, and shows on the Bugs page.

Several sessions can run side by side, in one folder or several. Messages you send while it works are answered by the assistant before the next turn and can change the plan.

## 4. Stop, resume, follow

- **Stop** any time, or let the cap stop it. Quitting the app pauses it (with agents working, ⌘Q keeps the app in the background until they finish). The queue (\`.formal/queue.json\`) and each job's conversation (\`.formal/jobs/\`) are saved, so **Resume** carries on mid-step and finished work is never redone. Raising the cap also resumes.
- Network or overload errors retry three times, then pause with a Retry.
- Follow along on the Swarm canvas (the working agent on its item, the ledger, the context meter), and on the **Proofs**, **Bugs** and **Code** tabs. Every event is logged to \`.formal/runs/<run>.jsonl\`.

## 5. The report

As it works, the swarm writes Formal Mind's audit of the folder, \`audit/formal-mind.audit.json\` (\`kind: "internal"\`): its findings with PoC, evidence and fix, and the reviewed properties. See the \`read-formal-mind-results\` skill for the format.

## Edge cases

- Commit the swarm's files yourself when you want them kept: it never commits or pushes.
- Scope comes from the scripts under \`script/\`; a repository without deploy scripts gives the swarm little to plan.
- The swarm reads only the code (the solc AST), not comments or commit history.

Source: desktop/README.md ("Local swarm", "Formal Mind's report"), desktop/SWARM-STATES.md, desktop/src-tauri/src/swarm.rs, desktop/src/settings.tsx, desktop/src-tauri/src/claude_code.rs.
`,
};

const ONBOARD: Skill = {
  name: "onboard-a-repository",
  description:
    "Get a Solidity repository into Formal Mind: plan it without signing in (POST /api/onboarding/plan), then, signed in with GitHub, add it as a project (a local folder in the desktop app, or a remote GitHub repository on formal.team) to read its code, audits (Bugs) and theorem coverage (Proofs). Use when helping a person start with Formal Mind on their contracts.",
  body: `# Onboard a repository

> **${STATUS_LINE}**

A project is a repository with four tabs: **Code** (read it, with LSP navigation), **Bugs** (every audit report and finding, with status, PoC and the report's section), **Proofs** (the theorems so far, per Solidity function) and the **Swarm** that does the work. Planning is open to anyone; the rest needs a GitHub sign-in.

## 1. Plan the repository (no sign-in)

\`\`\`
POST ${ORIGIN}/api/onboarding/plan
Content-Type: application/json

{"repo":"owner/name"}
\`\`\`

\`repo\` may be \`owner/name\` or a github.com URL. The repository must be public and contain Solidity contracts outside tests and libraries (422 otherwise). The response is \`text/plain\`: one JSON object streamed a few characters at a time, with \`summary\` (two sentences on what the protocol does, from the code), the contracts found, and the first work the planner would hand out. Read the body to the end, then parse it. Limits: five plans per hour per address (429), and a plan for a repository is cached for a week and replayed to everyone who asks (\`X-Plan-Cache: hit\`). Errors come as JSON with an \`error\` message: 404 (no public repository), 503 (GitHub rate limit), 502 (GitHub did not answer).

The landing page (${ORIGIN}) runs the same plan live and then goes on to sign-in.

Source: server/routes/onboarding/plan/route.ts, lib/plan.ts.

## 2. Add it as a project (signed in)

**Add a project** (the home page, the sidebar's +, or the project picker) offers two ways:

- **Local folder**, in the desktop app: the repository on disk. Everything is read locally, and the swarm runs here (the \`run-the-local-swarm\` skill).
- **Remote repository**, on formal.team or in the app: a public GitHub repository, \`owner/name\`. Nothing else is set up: the browser keeps a shallow git copy, and the Code, Bugs and Proofs tabs read from it. Proofs compiles the Solidity in the browser (solc-js) and maps each function to its Lean coverage (formal-ast as WebAssembly). The same step is \`POST ${ORIGIN}/api/projects\` with \`{"repo":"owner/name"}\` and the person's session; 404 when the repository is private or missing.

## Edge cases

- Private repositories cannot be planned or added as remote projects; add the local folder in the desktop app instead.
- The GitHub App install needs the person in the browser.

Source: server/routes/onboarding/plan/route.ts, server/routes/projects/route.ts, components/add-project.tsx, lib/ast/.
`,
};

const RESULTS: Skill = {
  name: "read-formal-mind-results",
  description:
    "Read what Formal Mind left in a repository: the swarm's plan and progress in .formal/, Lean proofs in formal/, audit reports and findings in the formalmind.audit/v1 JSON format (audit/*.audit.json, including Formal Mind's own formal-mind.audit.json) with their Foundry PoCs under test/. Use when working in a repository where Formal Mind ran, to answer what is proved, which findings are open, or to write an audit file the Bugs page can show.",
  body: `# Read Formal Mind's results in a repository

> **${STATUS_LINE}**

Formal Mind keeps its state in the repository's own files, so an agent with the checkout can read all of it.

## The files

| Path | What it holds |
| --- | --- |
| \`.formal/plan.md\` | One item per in-scope function: \`- [ ]\` to do, \`- [x]\` proved and reviewed, \`- [!]\` blocked or a bug was filed. Each line names the generated def, e.g. \`Router.matchBook\`, and where the function is. |
| \`.formal/proofs.json\` | The proof files of each reviewed item. |
| \`.formal/queue.json\`, \`.formal/jobs/\`, \`.formal/runs/*.jsonl\` | The swarm's queue, each job's saved conversation, and the event log of each run. |
| \`formal/Specs/<Contract>.lean\` | The Lean model of each contract, generated from the solc AST by formal-ast. Regenerated, never hand-edited. |
| \`formal/Proofs/…\` | Proofs about the generated defs; the swarm writes \`formal/Proofs/Swarm/<Contract><Fn>.lean\`. \`lake build\` checks them. |
| \`audit/README.md\` | The audit index: each report, with a table \`| ID | Severity | Finding | Status | Evidence |\`. |
| \`audit/formal-mind-swarm.md\` | The swarm's findings, each with a PoC under \`test/\` (by convention \`test/formal/\`). |
| \`<report>.audit.json\` | One per audit report, beside it, in the format below. Formal Mind's own is \`audit/formal-mind.audit.json\`. |

## The audit format (\`formalmind.audit/v1\`)

One JSON file per report: \`schema\` (\`"formalmind.audit/v1"\`), \`kind\` (\`external\` for an audit firm's report, \`internal\` for Formal Mind's), \`title\`, \`auditor\`, \`date\` (\`YYYY-MM-DD\`), \`commit\`, \`repository\`, \`scope\` (paths), \`summary\`, \`source\` (the report file it was read from), and \`findings\`. An internal audit adds \`coverage\` (per contract: functions, in Lean, proved, not modeled, theorems, sorry, and a row per function) and \`properties\` (\`P-01\`…: what was proved, with each theorem's name and file).

A finding: \`id\` (the report's own, \`H-01\`, \`M-2\`; \`F-01\` when it has none), \`title\`, \`severity\` (\`critical\`, \`high\`, \`medium\`, \`low\`, \`informational\`, \`gas\`), \`status\` **in the current code** (\`open\`, \`fixed\`, \`acknowledged\`, \`works as expected\`, \`rejected\`), \`reportStatus\` (what the report said), \`locations\` (\`{ file, line? }\`), \`description\` (Markdown, required), \`impact\`, \`recommendation\`, \`response\`, \`evidence\` (why this status: what changed and the test that covers it), \`tests\`, \`poc\`, \`fix\` (\`{ commit?, pr?, url? }\`) and \`page\` (in the source PDF).

The Bugs page reads only these files, plus the legacy tables in \`audit/README.md\`. In the app, Bugs → **Read findings** has the auditor turn an external PDF or Markdown report into its \`.audit.json\`, checking each finding against the current code.

## Answering common questions

- **What is proved?** Items checked in \`.formal/plan.md\`, the \`properties\` of \`audit/formal-mind.audit.json\`, or the Proofs tab. A theorem counts only when \`lake build\` passes and it has no \`sorry\`, \`admit\` or new axiom.
- **What is open?** Findings with \`status: "open"\` across the \`.audit.json\` files.
- **Reproduce a bug**: \`forge test --match-path <poc>\`.

Source: docs/audit-format.md, lib/audit-format.ts, desktop/README.md ("Local swarm", "Formal Mind's report").
`,
};

const CONNECT: Skill = {
  name: "connect-formal-mind-as-mcp",
  description:
    "Add Formal Mind to Claude, ChatGPT, Cursor or any remote-MCP client as a connector at formal.team/mcp/account, sign in with GitHub, and ask about or act on your own account: your projects, their audits, findings and Proofs coverage, and the swarm in your desktop app, read and steered. Also how an agent gets an OAuth token for the account by hand (RFC 8414 metadata, dynamic registration, PKCE, refresh, revoke). Use when a person wants their AI assistant to see or run their Formal Mind swarm.",
  body: `# Connect Formal Mind as an MCP connector

> **${STATUS_LINE}**

Formal Mind runs an OAuth 2.0 authorization server at ${ORIGIN} and an account MCP server at ${ORIGIN}/mcp/account. A connector added in an MCP client discovers the authorization server by itself, registers, sends you to sign in with GitHub, shows a consent page naming the client and the scopes, and from then on holds a token for your account (an hour at a time, renewed until you revoke it). Nothing here changes how you sign in to formal.team; the public swarm record stays readable without any of this at ${ORIGIN}/mcp.

## 1. Add the connector

- **Claude** (claude.ai or the desktop app): Settings → Connectors → Add custom connector. Name: Formal Mind. Remote MCP server URL: \`${ORIGIN}/mcp/account\`. Leave client id and secret empty: Claude registers itself. Click Connect, sign in with GitHub, Allow.
- **ChatGPT**: Settings → Connectors (Apps) → Create. MCP server URL: \`${ORIGIN}/mcp/account\`. Authentication: OAuth, no client id or secret (dynamic registration). Create, then sign in with GitHub and Allow.
- **Cursor**: Settings → MCP → Add new MCP server, or in \`.cursor/mcp.json\`: \`{"mcpServers":{"formal-mind":{"url":"${ORIGIN}/mcp/account"}}}\`. Click Authenticate, sign in with GitHub, Allow.
- **Any other client** that follows the MCP authorization spec: point it at \`${ORIGIN}/mcp/account\`. The 401 it gets carries \`WWW-Authenticate: Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/account"\`, which leads to the RFC 8414 metadata at ${ORIGIN}/.well-known/oauth-authorization-server.

## 2. Ask

With \`swarm:read\`: "what are my projects", "what findings does owner/repo have", "how much of Router is proved", "what is the swarm on my Mac working on". With \`swarm:write\`: "verify owner/repo at v1.2" or "pause the swarm" (\`mac_do\`, run by the desktop app on your Mac, signed in with Settings → Remote control (MCP) on).

The tools: \`my_projects\`, \`list_files\`, \`read_file\`, \`list_audits\`, \`list_findings\`, \`get_finding\`, \`proofs_coverage\`, \`mac_swarm\`, \`mac_watch\`, \`mac_swarm_events\`, \`mac_get\`, \`mac_reply\` (swarm:read); \`mac_swarm_send\`, \`mac_do\` (swarm:write).

## 3. By hand (any agent)

1. \`GET ${ORIGIN}/.well-known/oauth-authorization-server\` for the endpoints.
2. \`POST ${ORIGIN}/oauth/register\` with \`{"client_name":"…","redirect_uris":["https://…"]}\` (https, loopback http, or your app's own scheme) → \`client_id\`.
3. Open \`${ORIGIN}/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&scope=swarm:read%20swarm:write&state=…&code_challenge=…&code_challenge_method=S256&resource=${ORIGIN}/mcp/account\` in the person's browser; they sign in with GitHub and allow; you receive \`code\` and \`state\` on the redirect.
4. \`POST ${ORIGIN}/oauth/token\` with \`grant_type=authorization_code\`, \`code\`, \`code_verifier\`, \`redirect_uri\`, \`client_id\` → \`access_token\` (ES256 JWT, one hour), \`refresh_token\` (thirty days, single use).
5. Call \`${ORIGIN}/mcp/account\` or \`GET ${ORIGIN}/api/projects\` with \`Authorization: Bearer <access_token>\`. Refresh with \`grant_type=refresh_token\`; revoke at \`POST ${ORIGIN}/oauth/revoke\`.

## Edge cases

- The token is scoped: chat and the GitHub App install answer 403 to it. They need the person's own sign-in in the browser.
- A token without \`swarm:write\` gets 403 \`insufficient_scope\` from \`mac_swarm_send\` and \`mac_do\`.
- Revoking the refresh token ends the connector's access at the next renewal; revoking the access token ends it at once.

Source: worker/oauth.ts, lib/oauth.ts, lib/auth.ts, worker/account-mcp.ts, worker/index.ts, ${ORIGIN}/auth.md.
`,
};

const SKILLS: Skill[] = [LOCAL_SWARM, ONBOARD, RESULTS, CONNECT];

/* The description is quoted: it holds colons, which YAML would otherwise read as keys. */
function skillMd(s: Skill): string {
  return `---
name: ${s.name}
description: ${JSON.stringify(s.description)}
license: MIT
metadata:
  publisher: formalmind
  homepage: ${ORIGIN}
---

${s.body}`;
}

async function sha256Hex(body: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function text(body: string, contentType: string, maxAge = 3600): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": `public, max-age=${maxAge}`,
      "access-control-allow-origin": "*",
    },
  });
}

/* /.well-known/agent-skills/index.json and each skill's SKILL.md, or null
 * when the path is not one of ours. */
export async function handleSkills(pathname: string): Promise<Response | null> {
  if (pathname === "/.well-known/agent-skills/index.json" || pathname === "/.well-known/agent-skills/") {
    const skills = await Promise.all(
      SKILLS.map(async (s) => ({
        name: s.name,
        type: "skill-md",
        description: s.description,
        url: `/.well-known/agent-skills/${s.name}/SKILL.md`,
        digest: `sha256:${await sha256Hex(skillMd(s))}`,
      })),
    );
    const body = { $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", skills };
    return text(JSON.stringify(body, null, 2), "application/json; charset=utf-8");
  }

  const m = pathname.match(/^\/\.well-known\/agent-skills\/([a-z0-9-]+)\/SKILL\.md$/);
  if (m) {
    const skill = SKILLS.find((s) => s.name === m[1]);
    if (skill) return text(skillMd(skill), "text/markdown; charset=utf-8");
  }

  return null;
}
