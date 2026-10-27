/* The story agents should hear about Formal Mind, in one place, so llms.txt,
 * llms-full.txt, the markdown pages, the skills and the MCP instructions all
 * say the same thing. Every fact here is checkable: against README.md,
 * desktop/README.md and docs/audit-format.md in this repository, or against
 * the code under desktop/, lib/ and server/routes/ named next to the claim.
 * Anything that is not built yet is under "Planned" and nowhere else. */

import { MAC_DOWNLOAD, WINDOWS_DOWNLOAD } from "../lib/downloads";

export { MAC_DOWNLOAD, WINDOWS_DOWNLOAD };

export const SITE_NAME = "Formal Mind";
export const ORIGIN = "https://formal.team";
export const APP_REPO = "https://github.com/formalmind/formalmind";
export const GITHUB_APP = "https://github.com/apps/formalmind";
export const RELEASES = `${APP_REPO}/releases`;
export const AUDIT_FORMAT_DOC = `${APP_REPO}/blob/main/docs/audit-format.md`;
export const AUDIT_FORMAT_RAW = "https://raw.githubusercontent.com/formalmind/formalmind/main/docs/audit-format.md";
export const PROTOCOL_DOC = `${APP_REPO}/blob/main/docs/protocol.md`;
/* A public repository Formal Mind works on: Async Swap's contracts, with its Lean proofs in formal/ and Formal
 * Mind's audit in audit/formal-mind.audit.json. */
export const EXAMPLE_REPO = "https://github.com/asyncswap/contracts";
export const EXAMPLE_AUDIT_RAW = "https://raw.githubusercontent.com/asyncswap/contracts/main/audit/formal-mind.audit.json";

/* One paragraph: what it is. From README.md and desktop/README.md. */
export const DESCRIPTION =
  "Formal Mind is an app for Solidity developers that proves their contracts correct. It keeps four things in one place: Bugs (every audit report and finding, with its status and proof-of-concept test), Proofs (the Lean 4 theorems written so far, tracked per Solidity function), Code (the repository, with LSP navigation), and a Swarm of agents that runs on your own computer and does the work: it writes and checks a Lean proof for each function in scope and files bugs with Foundry PoCs. Every theorem is machine-checked by lake build, with no sorry and no new axioms, and the swarm keeps everything in the repository's own files.";

/* Two sentences for places that cannot afford the paragraph. */
export const SHORT =
  "Formal Mind proves Solidity contracts correct: a swarm of agents on your own computer writes a Lean 4 proof for each function in scope, checks it with lake build, and files bugs with Foundry PoCs. Bugs, Proofs and Code show the results, read from the repository's own files.";

/* Where things stand. Read by every agent-facing document; change it here. */
export const STATUS_LINE =
  "Status: early access. The desktop app is free to download for macOS (Apple Silicon and Intel) and Windows; the swarm runs locally and pays for its model calls with formal.team credits or your own Anthropic or OpenAI key. The website opens public GitHub repositories with the same Bugs, Proofs and Code tabs.";

export const STATUS_SECTION = `## Status: early access

${STATUS_LINE}

- The app: macOS ${MAC_DOWNLOAD} (one universal build), Windows ${WINDOWS_DOWNLOAD}. It updates itself; releases are at ${RELEASES}.
- Model calls on formal.team credits are metered per call and charged to the account; a call is refused when the balance is empty (lib/model-gateway.ts). Credits are bought through Stripe, $10 to $1,000 per deposit (lib/billing.ts).
- Formal Mind's own report of a repository (Bugs → Generate report) costs $150 from credits, once per repository and commit.
- Agents and MCP connectors act on an account with OAuth 2.0 access tokens from formal.team's own authorization server (GitHub sign-in, a consent page, PKCE; worker/oauth.ts), at ${ORIGIN}/mcp/account and on the API routes named in ${ORIGIN}/auth.md.`;

/* How it works, from desktop/README.md ("Local swarm", "Formal Mind's report") and docs/audit-format.md. */
export const HOW_IT_WORKS = `## How it works

A **project** is a Solidity repository: a folder on your computer in the desktop app, or a public GitHub repository on the website. Each one has four tabs.

- **Code**: read the repository, with LSP navigation (and Neovim in the desktop app).
- **Bugs**: every audit report and finding in one place, with its status in the current code (open, fixed, acknowledged, works as expected, rejected), its PoC test and the report's section. Reports are read from \`<report>.audit.json\` files in the standard \`formalmind.audit/v1\` format (${AUDIT_FORMAT_DOC}); **Read findings** turns an audit firm's PDF or Markdown report into one, checking each finding against the current code.
- **Proofs**: each Solidity function in scope, whether it has a Lean model, and the theorems that prove it. The Solidity is compiled with solc and read from its AST by formal-ast (natively in the desktop app; as WebAssembly with solc-js in the browser on the website). Scope is what the Foundry scripts under \`script/\` deploy or call, their bases and what they deploy.
- **Swarm**: agents that do the work, on your computer.

**The local swarm.** Press Start on a folder, with an optional focus and a spending cap:

1. **Plan**, without a model: \`.formal/plan.md\` gets one item per function in scope, the scripts' calls first, then the functions that write storage, then views. Functions already proved come checked.
2. **Prove**: a prover takes the next item with the function's slice of the AST and its generated Lean model (\`formal/Specs/<Contract>.lean\`), writes \`formal/Proofs/Swarm/<Contract><Fn>.lean\` and runs \`lake build\`.
3. **Check**: no \`sorry\`, \`admit\`, \`axiom\` or \`native_decide\`, a clean build, and the Proofs tab counting the function as proved. Three failures block the item.
4. **Review**: a reviewer checks the theorems and the prover's notes against the Solidity. Approved properties are written to \`audit/formal-mind.audit.json\`.
5. **Bugs**: a finding needs a Foundry PoC under \`test/\` that the swarm runs with \`forge test\`; it goes to \`audit/formal-mind-swarm.md\`, the audit index \`audit/README.md\` and \`audit/formal-mind.audit.json\`, and shows on Bugs.

Messages you send while it works are answered by an assistant before the next turn and can change the plan. Sessions run side by side. Stop any time: the queue and every agent's conversation are saved in \`.formal/\`, so Resume carries on mid-step and finished work is never redone.

**Nothing goes through GitHub.** The swarm's state is the folder's own files: plan and progress in \`.formal/\`, proofs in \`formal/\`, findings in \`audit/\` with PoC tests under \`test/\`. It opens no issues or pull requests, comments nowhere and pushes nothing; its tools cannot run git. Only the model calls leave the computer, by the route picked in Settings → Models: formal.team credits, or your own Anthropic or OpenAI key, kept in the system keychain and sent straight to that provider.

**Formal Mind's report.** Bugs → Generate report writes \`audit/formal-mind.audit.json\` (\`kind: "internal"\`) for the current commit: the swarm's findings with PoC, evidence and fix, the Proofs coverage of each contract in scope, and the reviewed properties with their theorems.

**Specs from commits (optional).** For a GitHub repository, Set up specs creates \`<owner>/<name>-proofs\` from the formalmind/lean-template repository (the formalmind GitHub App, ${GITHUB_APP}, must be installed on the owner), where Formal Mind writes the Lean specification as the protocol's commits land, within a daily budget (lib/proofs-repo.ts). Proving stays in the app.

**Example.** Async Swap's contracts, ${EXAMPLE_REPO}: its Lean proofs are in \`formal/\` (the generated models in \`formal/Generated/\`, the proofs about them in \`formal/Refinement/\`), and Formal Mind's audit is \`audit/formal-mind.audit.json\`.

## The website, formal.team

- **Landing page** (${ORIGIN}/welcome, also / when signed out): paste a public GitHub repository and the planner reads its contracts and plans the work, live. The same call is open to anyone: \`POST ${ORIGIN}/api/onboarding/plan\` with \`{"repo":"owner/name"}\` streams the plan as text (a JSON object); five plans per hour per address, and a plan is cached for a week (server/routes/onboarding/plan/route.ts).
- **Sign in** with GitHub (${ORIGIN}/login). Sessions are an httpOnly cookie; there is no password. An agent acting for you holds an OAuth access token instead (${ORIGIN}/auth.md).
- **Add a project**: a public GitHub repository, kept as a shallow git copy in the browser; its Code, Bugs and Proofs tabs read from it (server/routes/projects/route.ts, lib/ast/).
- **Billing and Usage**: credits, deposits and every metered cost line.
- **Desktop app**: macOS ${MAC_DOWNLOAD}, Windows ${WINDOWS_DOWNLOAD}. It signs in through the browser and adds local folders, which is where the swarm runs.`;

/* What an agent may do on a person's account, and how a person connects one.
 * Sources: worker/oauth.ts, lib/oauth.ts, lib/auth.ts, worker/account-mcp.ts,
 * worker/index.ts (ROUTES). */
export const AGENT_ACCESS = `## Agents on your account

Formal Mind runs an OAuth 2.0 authorization server at ${ORIGIN} (RFC 8414 metadata at ${ORIGIN}/.well-known/oauth-authorization-server; dynamic client registration, authorization code with PKCE, refresh tokens, revocation). A client registers itself, sends you to ${ORIGIN}/oauth/authorize, you sign in with GitHub and allow it on a consent page that names the client and the scopes, and it receives an access token for your account, good for an hour and renewable until you revoke it. Two scopes: \`swarm:read\` (your projects and their files, audit reports, findings and Proofs coverage, your usage and credits, and the swarm's state, your Mac's included) and \`swarm:write\` (add and plan a repository, set up its specs, steer your Mac's swarm). Everything else, including chat and billing, stays behind your own sign-in.

**Account MCP server**, ${ORIGIN}/mcp/account (Streamable HTTP, JSON responses; compact JSON results): \`my_projects\`, \`my_usage\` (spend today, this month and overall, and the latest cost lines), \`my_credits\` (the balance, deposits and metered spend), \`swarm_state\` (the hosted swarm), \`list_files\` and \`read_file\` (a project's files at a commit), \`list_audits\`, \`list_findings\` and \`get_finding\` (its formalmind.audit/v1 reports), \`proofs_coverage\` (Lean coverage per contract and the properties proved), \`report_quote\`, \`mac_swarm\` and \`mac_swarm_events\` (the desktop app's swarm, through the relay), \`mac_get\` (any of the app's reads on the Mac: folders, plan, statements, bugs, proofs, scope, coverage, Reach) and \`mac_reply\` (a late answer) (swarm:read); \`add_project\`, \`plan_repository\`, \`start_swarm\` (sets up specs from commits), \`mac_swarm_send\` (say, Start, Stop to the Mac) and \`mac_do\` (anything the app's folder page does on the Mac: add a folder, start, the Bug Hunter, statements, triage, Reach tools, the report) (swarm:write). The desktop app's own sign-in token is accepted too, with both scopes. docs/MCP.md in the repository has the details. Without a token it answers 401 with a \`WWW-Authenticate\` header pointing at ${ORIGIN}/.well-known/oauth-protected-resource/mcp/account, which is how MCP clients find the authorization server on their own.

**API routes that take the same token** (\`Authorization: Bearer\`): \`GET /api/projects\`, \`GET /api/usage\`, \`GET /api/billing/balance\`, \`GET /api/swarm/state\` (swarm:read) and \`POST /api/projects/init\` (swarm:write). A token without the scope gets 403 \`insufficient_scope\`.

**Connect it as an MCP connector.** Claude: Settings → Connectors → Add custom connector, name "Formal Mind", URL \`${ORIGIN}/mcp/account\`; Claude registers itself and opens the GitHub sign-in. ChatGPT: Settings → Connectors (or Apps) → Create, the same URL, authentication OAuth, no client id or secret (it registers dynamically). Cursor: Settings → MCP → Add new MCP server, \`{"url":"${ORIGIN}/mcp/account"}\`, then Authenticate. Claude Code: \`claude mcp add --transport http formal-mind ${ORIGIN}/mcp/account\`, then /mcp to sign in. Then ask: "what are my projects", "list the open findings in owner/repo", "how much of Router is proved", "what is my Mac's swarm doing", "how many credits do I have". Full details: ${ORIGIN}/auth.md and the skill at ${ORIGIN}/.well-known/agent-skills/connect-formal-mind-as-mcp/SKILL.md.`;

/* Roadmap, kept apart from what exists. */
export const PLANNED = `## Planned, not built

- **The iPhone app on the App Store.** It is not published yet (lib/downloads.ts).
- **Driving the local swarm from outside the app.** The swarm is started, steered and stopped in the desktop app; there is no API or MCP tool for it.
- **A public verification-work API.** The credential layer exists (OAuth 2.0 tokens from ${ORIGIN}, see ${ORIGIN}/auth.md). An API for submitting verification work and reading its results is next, and will take the same tokens.
- **An A2A agent card.** None is published, because there is no agent-to-agent endpoint to describe.`;
