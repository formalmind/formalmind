# Formal Mind MCP

formal.team runs two remote MCP servers on the Worker (Streamable HTTP, stateless, JSON responses):

| Endpoint | Auth | What |
| --- | --- | --- |
| `https://formal.team/mcp` | none | Public reads: the `formalmind.audit/v1` format, Formal Mind's audit of an example repository, the desktop app's latest release (`worker/mcp.ts`) |
| `https://formal.team/mcp/account` | OAuth 2.0 or the desktop token | Your account: projects and their files, audit reports, findings, Proofs coverage, usage, the swarm in your desktop app (`worker/account-mcp.ts`) |

Every tool returns one text block of compact JSON. Project reads are pinned to one commit, and each result names it.

## Add it to Claude Code

```bash
claude mcp add --transport http formal-mind https://formal.team/mcp/account
```

Then run `/mcp` in Claude Code, pick `formal-mind` and authenticate. Claude Code finds the authorization server
from the 401's `WWW-Authenticate` header, registers itself, and opens the GitHub sign-in and a consent page. Tokens
last an hour and refresh until you revoke them. Add `--scope user` to have it in every project.

The public server needs no sign-in:

```bash
claude mcp add --transport http formal-mind-public https://formal.team/mcp
```

Claude Desktop and claude.ai: Settings → Connectors → Add custom connector, URL `https://formal.team/mcp/account`.
Cursor, ChatGPT and other clients: see `/auth.md` and the `connect-formal-mind-as-mcp` skill at
`/.well-known/agent-skills/`.

## Auth

- **OAuth access token** (recommended): an ES256 JWT from formal.team's own authorization server (`worker/oauth.ts`),
  with scopes `swarm:read` and/or `swarm:write`. A tool call without its scope gets HTTP 403
  `insufficient_scope` naming the scope it needs.
- **The desktop app's token** (`Authorization: Bearer fmd_…`): the Mac app's own sign-in session. It has both scopes.
  It lives in the keychain (service `team.formal.desktop`), and it is for scripts on your own machine. Prefer OAuth for
  anything else.
- No token or a bad one: 401 with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp/account"`.

Tools act only on the token's account. The project tools read only that account's projects (`my_projects`).
A private repository needs the formalmind GitHub App installed on its owner. Without the App, public repositories are
read through GitHub's public API, with the Worker's `GITHUB_TOKEN` when it has one.

## Tools (`/mcp/account`)

| Tool | Scope | Returns |
| --- | --- | --- |
| `my_projects` | read | The account's projects (repository, proofs repository, added at) |
| `my_usage` | read | Spend today / this month / overall and the latest cost lines |
| `swarm_state` | read | The hosted swarm on GitHub (the earlier, GitHub-based swarm): open fm: work, merges, runs |
| `list_files` | read | A project's paths at a commit; `prefix`, `ext`, `limit`, `ref` |
| `read_file` | read | One file's text, optionally `from`/`to` lines (2000-line cut otherwise) |
| `list_audits` | read | Each `*.audit.json` in the report folders (`audit`, `audits`, `reports`, or `dirs`): kind, auditor, date, audited commit, findings by severity and status, coverage totals; also reports not yet converted, unparseable files, `.formal/bugs/`, Formal Mind's PDF |
| `list_findings` | read | Findings as `{report, id, title, severity, status, at}` rows, most severe first; filter by `report`, `severity`, `status` |
| `get_finding` | read | One finding in full (description, impact, recommendation, response, evidence, tests, PoC, fix) |
| `proofs_coverage` | read | From the internal (Formal Mind) report: per contract functions / in Lean / proved / sorry / not modeled / theorems, the function rows for one `contract`, the properties proved, and `.formal/plan.md` progress when committed |
| `mac_swarm` | read | The desktop app's swarm through the relay: online or not, last seen, folders and their sessions |
| `mac_swarm_events` | read | The relay's recent swarm events, filtered by `folder`, `run`, `kind`, `after` (a seq) |
| `add_project` | write | Adds a GitHub repository to the account's projects |
| `plan_repository` | write | Runs the planner on a repository and saves the plan to the account |
| `start_swarm` | write | Sets up `<repo>-proofs` for the hosted swarm |
| `mac_swarm_send` | write | `say` / `start` / `stop` to the Mac; `start` runs on the route the app's Settings use |
| `mac_get` | read | One of the app's reads on the Mac (`lib/mac-ops.ts`): folders, status, plan, statements, bugs, proofs, scope, coverage, … The Mac answers through the relay |
| `mac_do` | write | One of the app's actions on the Mac (`lib/mac-ops.ts`): add a folder, verify any GitHub repository at a branch or commit (`verify_repo`), start, hunt, stop, say, statements, triage, Reach |
| `mac_get` `work_map` / `brief`, `mac_do` `refresh_model` / `check_proof` / `submit_proof` | read / write | A remote prover: what's covered and left, a function's brief, checking and submitting a proof as the swarm's own |
| `mac_reply` | read | A `mac_get` / `mac_do` answer that came after the call stopped waiting, by its id |
| `mac_watch` | read | Waits up to ~50 s for the next event that needs attention (a question, a bug, a blocked item, a proof, an error, a session ending) and returns it with its `seq`; call again with `after` to keep watching |

`mac_get` and `mac_do` run the desktop app's control API (`desktop/src-tauri/src/control.rs`, whose operations
`lib/mac-ops.ts` publishes; a test keeps the two equal). The app's pages call the same API, and the relay that serves
these tools runs in the app's backend process (`desktop/src-tauri/src/relay.rs`), so it answers with no window open.

The public server (`/mcp`) has `get_audit_format`, `get_example_audit` (`section`: summary, findings, coverage,
properties, full) and `get_app_release`.

Typical use: `my_projects` → `list_audits` → `list_findings {status: "open"}` → `get_finding`, or `proofs_coverage
{contract: "Router"}` → `read_file` on the theorem's Lean file.

## Run it locally

```bash
bun run build
```

```bash
bunx wrangler dev --port 8787
```

Without `APP_BASE_URL` the Worker is in dev preview. There, any `Bearer fmd_…` token is the stub account
`dev|preview`, and OAuth signs with a throwaway key:

```bash
curl -s localhost:8787/mcp/account -H 'authorization: Bearer fmd_local' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

```bash
claude mcp add --transport http formal-mind-dev http://localhost:8787/mcp/account --header "Authorization: Bearer fmd_local"
```

Wrangler rewrites the Host header to the first route, so the OAuth issuer under preview is `http://formal.team`
unless wrangler is started with `--host localhost:8787`. Use that issuer as the `resource` when you test the OAuth
flow by hand. The relay can be fed as the Mac by POSTing `{state, events}` to `/api/relay/mac` with the same token.

## Not here yet: a local MCP

Some of the tools run only on the Mac, against the working tree, so the Worker can't serve them. They belong in a
local (stdio) MCP server, from the desktop app or from concolity itself:

- **sol-debug**: the desktop app's Solidity debugger (`desktop/src-tauri/src/debug.rs`, on anvil): step a test or
  script, read the stack, memory and storage at a step, set breakpoints.
- **concolity**: coverage of a test run, concolic explore of a function for inputs that reach new branches or revert,
  and its SARIF findings (`.formal/findings.sarif`).
- **formal-ast on the working tree**: units, slices and Lean coverage of uncommitted code
  (`desktop/src-tauri/src/ast.rs`). The website runs the same crate as wasm in the browser, but the Worker doesn't:
  solc-js is too big for it. Server-side coverage comes from the committed `audit/formal-mind.audit.json`.
- **lake build / forge test** and the swarm's own `.formal/` state beyond what the relay carries. Those stay on the Mac.

Until then, `mac_swarm_send` is how a remote agent asks the Mac's swarm to do this work. The results come back
through `mac_swarm_events`, and as committed files the project tools can read.
