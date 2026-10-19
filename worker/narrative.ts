/* The story agents should hear about Formal Mind, in one place, so llms.txt,
 * llms-full.txt, the markdown pages, the skills and the MCP instructions all
 * say the same thing. Every fact here is checkable: against README.md and
 * docs/protocol.md in this repository, against the swarm's own documentation
 * in asyncswap/v2-proofs/.github/formalmind/README.md, or against the code
 * under lib/ and server/routes/ named next to the claim. Anything that is not
 * built yet is under "Planned" and nowhere else. */

export const SITE_NAME = "Formal Mind";
export const ORIGIN = "https://formal.team";
export const APP_REPO = "https://github.com/formalmind/formalmind";
export const GITHUB_APP = "https://github.com/apps/formalmind";
export const PROOFS_REPO = "https://github.com/asyncswap/v2-proofs";
export const PROTOCOL_REPO = "https://github.com/asyncswap/v2";
export const SWARM_DOC = `${PROOFS_REPO}/blob/dev/.github/formalmind/README.md`;
export const CHANGELOG = `${PROOFS_REPO}/blob/dev/FORMAL_MIND.md`;
export const CHANGELOG_RAW = "https://raw.githubusercontent.com/asyncswap/v2-proofs/dev/FORMAL_MIND.md";
export const ROLE_DOCS_RAW = "https://raw.githubusercontent.com/asyncswap/v2-proofs/dev/.github/formalmind";
export const PROTOCOL_DOC = `${APP_REPO}/blob/main/docs/protocol.md`;
export const MAC_DOWNLOAD = `${APP_REPO}/releases/latest/download/Formal-Mind-mac.dmg`;

/* One paragraph: what it is. From README.md. */
export const DESCRIPTION =
  "Formal Mind is a swarm of agents for verifying Ethereum smart contracts. Point it at a Solidity repository and the agents write a Lean 4 + Mathlib specification of it, prove it, and keep the proofs up to date as the code changes. Every theorem is machine-checked by lake build, with no sorry and no new axioms, and the agents talk on GitHub as formalmind[bot].";

/* Two sentences for places that cannot afford the paragraph. */
export const SHORT =
  "A swarm of agents that keeps a Lean 4 specification of a Solidity protocol honest on every commit. Planner, prover, reviewer and merger work GitHub issues and pull requests within a spend budget, and nothing merges without a clean lake build.";

/* Where things stand. Read by every agent-facing document; change it here. */
export const STATUS_LINE =
  "Status: early access. The hosted swarm works one project today, the Async Swap v2 protocol (asyncswap/v2) and its proofs repository (asyncswap/v2-proofs). Onboarding another repository through formal.team creates its proofs repository from the Lean template and lists it for the swarm; the swarm is one team with one budget, so projects share its queue.";

export const STATUS_SECTION = `## Status: early access

${STATUS_LINE}

- The swarm's work is public: its issues, pull requests, notebooks and spend ledger are on GitHub in ${PROOFS_REPO}, and the swarm's own documentation is ${SWARM_DOC}.
- The live swarm's budget is $5 a day and $150 a month, enforced by the dispatcher from the ledger issue (asyncswap/v2-proofs/.github/formalmind/README.md, "Budget").
- Prepaid credits bought on formal.team are recorded per account (lib/billing.ts); metering them against the swarm's model calls is planned, not live.
- Agents and MCP connectors act on an account with OAuth 2.0 access tokens from formal.team's own authorization server (GitHub sign-in, a consent page, PKCE; worker/oauth.ts), at ${ORIGIN}/mcp/account and on the API routes named in ${ORIGIN}/auth.md. A public verification-work API is planned.`;

/* The swarm, in the swarm's own words (asyncswap/v2-proofs/.github/formalmind/README.md). */
export const HOW_IT_WORKS = `## How the swarm works

A **proofs repository** holds the Lean 4 + Mathlib specification of a protocol: one module per Solidity contract or library close to the code (for Async Swap, \`AsyncSwapSpec/\`), and a model of the whole system as one state machine with its invariants (\`AsyncSwapProtocol/\`). \`FORMAL_MIND.md\` in that repository is the changelog, including anything that could not be proved.

**Reconcile on every protocol push.** A push to the protocol repository is forwarded to the proofs repository, where the bot reads the Solidity diff, updates the Lean definitions that model it, re-proves what broke, records the result in \`FORMAL_MIND.md\`, and opens a pull request only when \`lake build\` is clean.

**Answer when tagged.** Mention \`@formalmind\` in any issue, pull request, review or comment of a proofs repository. A triage step reacts 👀 within seconds and sorts the message into chat (answered at once), a question that needs the repository (a run that reads it), or work that needs the Lean toolchain (a full run). The bot replies as a normal commenter, posts as formalmind[bot], cites code with permalinks GitHub renders inline, leaves inline review comments with suggestion blocks, and pushes to the branch when asked. Workflow: \`.github/workflows/formalmind-mention.yml\` in the proofs repository.

**Work the roadmap on its own.** Roles take turns, one at a time, and hand off by naming who goes next:

- **planner** reads the roadmap, the changelog and the open work; writes small, disjoint issues labelled \`fm:todo\`; posts a digest on the ledger.
- **prover** implements one issue on branch \`fm/issue-<n>\`, pushing as it goes, and opens a pull request labelled \`fm:review\` when \`lake build\` is clean, with a changelog entry.
- **reviewer** reads the issue and the whole diff, leaves inline suggestions, and labels \`fm:approved\` or \`fm:changes\`.
- **merger** builds the exact head, runs the \`sorry\` check, verifies every claim made in the thread against the code (a theorem the prover says it proved must exist without \`sorry\`), decides whether a human must look, and squash-merges, bounces or holds.
- **rebuilder** writes \`rebuild/\`, a Solidity implementation of the protocol built from the proofs alone, with Foundry tests named after the theorems; every guess it has to make marks a place where the proofs are silent.
- **editor** runs the rebuild cycle: it compares the maintainer's draft, the rebuild and the proofs, files gaps as \`fm:finding\`, and puts decisions to the maintainer through the assistant.
- **consolidator** owns \`official/\`, the one protocol everyone builds against.
- **chief** audits the day once, at 23:40 UTC, on the chief notebook issue.
- **assistant** is the only role that talks to the maintainer, on the assistant notebook issue; other roles ask it with \`/ask assistant\`.
- **dispatcher** is not a model. Every 30 minutes, or as soon as an \`fm:\` label changes, it sums the ledger and, if the budget allows, gives the turn to one job.

GitHub is the shared memory: issues and \`fm:*\` labels are the task queue, a pinned ledger issue is the spend log, a notebook issue holds one task list per run, and every comment starts with a marker so the state can be rebuilt from GitHub alone. Anyone can ask one role a question by commenting \`/ask <role> <question>\` on an issue or pull request.

**Safety rails.** Only one model job runs at a time. Nothing merges without a clean build on the exact head, and never with \`sorry\`, \`admit\` or a new axiom. Work only moves forward through the labels. A prover gets at most two runs per issue per day, a reviewer bounces a pull request at most twice, and at most three \`/ask\` answers happen per item per day before the item is parked for a human.

## The app at formal.team

- **Landing page** (${ORIGIN}/welcome, also / when signed out): paste a public GitHub repository and the planner drafts the swarm's first issues for it, live. The same call is open to anyone without signing in: \`POST ${ORIGIN}/api/onboarding/plan\` with \`{"repo":"owner/name"}\` streams the plan as text (a JSON object); five plans per hour per address, and a plan is cached for a week (server/routes/onboarding/plan/route.ts).
- **Sign in** with GitHub (${ORIGIN}/login). Sessions are an httpOnly cookie; there is no password. An agent acting for you holds an OAuth access token instead (${ORIGIN}/auth.md).
- **Onboarding** (signed in): your plan, team size, daily budget, prepaid credits through Stripe Checkout ($10 to $1,000), installing the formalmind GitHub App, and Start, which creates \`<owner>/<name>-proofs\` from the formalmind/lean-template repository and lists it in the swarm's \`projects.json\` so the dispatcher sweeps it (lib/proofs-repo.ts).
- **Swarm workspace** (signed in): the live board of the swarm's open work, merged pull requests, spend today, the chief's and the assistant's latest notes, and a chat that posts on the swarm's public notebook issues as you.
- **Mac app**: ${MAC_DOWNLOAD}. It signs in through the browser and can run agent turns on folders on your machine.`;

/* What an agent may do on a person's account, and how a person connects one.
 * Sources: worker/oauth.ts, lib/oauth.ts, lib/auth.ts, worker/account-mcp.ts,
 * worker/index.ts (ROUTES). */
export const AGENT_ACCESS = `## Agents on your account

Formal Mind runs an OAuth 2.0 authorization server at ${ORIGIN} (RFC 8414 metadata at ${ORIGIN}/.well-known/oauth-authorization-server; dynamic client registration, authorization code with PKCE, refresh tokens, revocation). A client registers itself, sends you to ${ORIGIN}/oauth/authorize, you sign in with GitHub and allow it on a consent page that names the client and the scopes, and it receives an access token for your account, good for an hour and renewable until you revoke it. Two scopes: \`swarm:read\` (your projects, usage, credits and the swarm's state) and \`swarm:write\` (plan a repository for your account, start the swarm on it). Everything else, including chat and billing, stays behind your own sign-in.

**Account MCP server**, ${ORIGIN}/mcp/account (Streamable HTTP, JSON responses): \`my_projects\`, \`my_usage\` (spend today, this month and overall, and the latest cost lines), \`my_credits\`, \`swarm_state\` (swarm:read), \`plan_repository\` and \`start_swarm\` (swarm:write). Without a token it answers 401 with a \`WWW-Authenticate\` header pointing at ${ORIGIN}/.well-known/oauth-protected-resource/mcp/account, which is how MCP clients find the authorization server on their own.

**API routes that take the same token** (\`Authorization: Bearer\`): \`GET /api/projects\`, \`GET /api/usage\`, \`GET /api/billing/balance\`, \`GET /api/swarm/state\` (swarm:read) and \`POST /api/projects/init\` (swarm:write). A token without the scope gets 403 \`insufficient_scope\`.

**Connect it as an MCP connector.** Claude: Settings → Connectors → Add custom connector, name "Formal Mind", URL \`${ORIGIN}/mcp/account\`; Claude registers itself and opens the GitHub sign-in. ChatGPT: Settings → Connectors (or Apps) → Create, the same URL, authentication OAuth, no client id or secret (it registers dynamically). Cursor: Settings → MCP → Add new MCP server, \`{"url":"${ORIGIN}/mcp/account"}\`, then Authenticate. Then ask: "what did my swarm spend today", "what are my projects", "plan owner/repo", "start the swarm on owner/repo". Full details: ${ORIGIN}/auth.md and the skill at ${ORIGIN}/.well-known/agent-skills/connect-formal-mind-as-mcp/SKILL.md.`;

/* Roadmap, kept apart from what exists. Sources: lib/billing.ts (metering
 * "comes next"), wrangler.jsonc (per-project lease, queue and dispatcher
 * "later"), docs/protocol.md (status: draft). */
export const PLANNED = `## Planned, not built

- **Credit metering.** Prepaid credits are recorded today; routing the swarm's model calls through a metering proxy that spends them is next (lib/billing.ts).
- **One Durable Object per project** holding the project's event log, queue, lease and budget, as described in the protocol v1 draft (docs/protocol.md). Today one object holds the spend ledger of the live swarm.
- **A public verification-work API.** The credential layer exists (OAuth 2.0 tokens from ${ORIGIN}, see ${ORIGIN}/auth.md) and covers an account's projects, usage, credits, swarm state, planning and starting the swarm. An API for submitting verification work and reading its results outside GitHub is next, and will take the same tokens.
- **An A2A agent card.** None is published, because there is no agent-to-agent endpoint to describe.`;
