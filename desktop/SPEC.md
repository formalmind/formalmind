# Formal Mind Mac app backend: behaviour spec

What the Rust backend in `desktop/src-tauri/src` (about 10.8k lines, desktop 0.2 line, `main` at `9a2fd10` plus PR #71
`claude/find-and-verdict` at `8d5f2bb`) does today, written to drive a from-scratch rewrite. Every behaviour is numbered
and testable. Where this spec and the code disagree, the code at that commit wins; where it says **NEW**, the behaviour
does not exist yet and is a requirement for the rewrite.

Rules the rewrite inherits (`AGENTS.md`, `docs/roadmap.md`): keep the UI; keep the swarm's one-item-per-function loop
working the same; keep the skills and role prompts (`worker/skills.ts`, the role prompts in `swarm.rs::system`) as they
are; the swarm's agents run nothing but `lake` and `forge` and never touch git or GitHub (only `publish.rs`, opted in per
folder, pushes). `desktop/SWARM-STATES.md` is the target session state machine; this spec describes what runs now.

Contents: 1. Contract with the UI and the MCP · 2. On-disk state · 3. Behaviours · 4. Regressions to get right ·
5. Module boundaries and tests.

---

## 1. The contract with the UI and the MCP

All of this must be preserved exactly: names, argument names (Tauri passes camelCase from JS as the Rust snake_case
names below; every current argument is a single word or already snake_case, e.g. `budget_usd` inside `request`), return
shapes and error strings where the UI matches on them. Every command returns `Result<T, String>`; the error is a
human sentence shown as is.

The folder guard: commands marked **[added]** fail with `"Add the folder first"` unless the folder is in
`config.folders` or is a value of `config.repos` (`Config::allows`).

### 1.1 Tauri commands (75)

Sign-in and keys (keychain service `team.formal.desktop`):

| Command | Args | Returns |
|---|---|---|
| `token_get` | – | `string \| null` (account `session`) |
| `token_set` | `token` | `()` |
| `token_clear` | – | `()`; no entry is not an error |
| `anthropic_key_set` | `key` | `()`; trimmed; empty deletes (account `anthropic`) |
| `anthropic_key_status` | – | `bool` |
| `openai_key_set` | `key` | `()`; as above (account `openai`) |
| `openai_key_status` | – | `bool` |
| `claude_code_status` | – | `"Claude Code <ver> · <billing>"` or Err (not installed / not signed in) |
| `codex_status` | – | `"Codex <ver> · signed in to your ChatGPT plan"` or Err (`codex login` hints) |

Settings and folders (`local.rs`, `~/.formalmind/config.json`):

| Command | Args | Returns |
|---|---|---|
| `config_get` | – | `Config` `{folders: string[], repos: {"owner/name": path}, settings: Settings}` |
| `settings_get` | – | `Settings` (see 2.1) |
| `settings_set` | `patch: object` | `Settings`; each key replaces; `null` removes; `budgets`/`github` merge per folder |
| `folder_add` | `path` | `Config`; Err `"<path> isn't a folder"`; idempotent |
| `folder_remove` | `path` | `Config`; files stay |
| `folder_scan` [added] | `path` | `{solidity: string[], lean: string[], truncated: bool, git: bool}` |
| `folder_tree` [added] | `path` | `{files: string[], truncated: bool}` (sorted, `/`-separated, ≤5000) |
| `folder_git_graph` [added] | `path` | `{commits: [{id, parents[], refs[], subject, time}], head, branch, dirty}` |
| `folder_repo` [added] | `path` | `"owner/name" \| null` from `origin` |
| `repo_local` | `repo` ("owner/name") | absolute path (mapped folder, a matching added folder, or a shallow clone under `~/.formalmind/repos/`) |
| `machine_name` | – | `string \| null` (`scutil --get ComputerName`, else `COMPUTERNAME`/`hostname`) |
| `log_error` | `source, message` | `()`; appends `[secs] v<ver> source: message` to `<log dir>/errors.log` |
| `folder_read` [added] | `folder, path` | file text; path must stay inside (see B24) |
| `folder_image` [added] | `folder, path` | `data:<mime>;base64,…`; png/jpg/jpeg/gif/webp/svg/avif/ico ≤8 MB, pdf ≤32 MB; else Err `"Not an image or a PDF"` / `"File too large"` |

The swarm (`swarm.rs`, `statements.rs`, `ledger.rs`, `health.rs`, `skills.rs`):

| Command | Args | Returns |
|---|---|---|
| `swarm_start` [added] | `request: {folder, goal?, budget_usd, api_base, provider?, model?, session?, only_queued?}` | session id (`run`) |
| `swarm_stop` | `folder, run` | `()` (never fails) |
| `swarm_say` | `folder, run, text` | `()`; Err `"The swarm isn't running"` |
| `swarm_set_budget` | `folder, run, usd` | `()`; same Err |
| `swarm_compact` | `folder, run` | `()`; same Err |
| `swarm_running` | `folder` | `string[]` runs running in that folder |
| `swarm_triage` [added] | `folder, path, session?` | `()`; Err `"<path> isn't a file"`, `"Reports are PDF, Markdown or text files"` |
| `swarm_queue` [added] | `folder` | `{run, open: [{id, kind, item, state, attempt}], spent, done: n}` |
| `swarm_plan` [added] | `folder` | `[{index, mark, text}]` (`mark` `" "`, `"x"`, `"!"`, `"~"`) |
| `swarm_bugs` [added] | `folder` | `[{file, title, body}]` from `.formal/bugs/`, newest first by file name |
| `swarm_proofs` [added] | `folder` | `.formal/proofs.json` as is, or `{}` |
| `swarm_sessions` [added] | `folder` | `[{run, title, outcome, spent, events, at}]`, newest `at` first |
| `swarm_rename` [added] | `folder, run, title` | `()`; ≤120 chars, control chars dropped; empty deletes `<run>.title`; Err `"Bad session id"` |
| `swarm_history` [added] | `folder, run` | event objects (see B45) |
| `swarm_suggest` | `folder, api_base, provider?, run, transcript` | drafted next message (string) |
| `swarm_work_map` [added] | `folder` | see B53 |
| `swarm_brief` [added] | `folder, function` | Markdown brief |
| `swarm_check_proof` [added] | `folder, path, content?` | `{ok, path, check, errors?, proves?, regenerated?}` |
| `swarm_submit_proof` [added] | `folder, function, path, notes?, session?` | `{item, job, queued: "review"}` |
| `swarm_refresh_model` [added] | `folder` | `string[]` models rewritten |
| `swarm_health` | `folder?, limit?` | `{turns, healthy, …}` from `turns.jsonl` |
| `swarm_ledger` [added] | `folder, check?, force?` | ledger (B31) |
| `swarm_statements` [added] | `folder` | `Statement[]` `{id, mark, author, text, details[], obligations[{mark,text}]}` |
| `swarm_add_statement` [added] | `folder, text` | `Statement` |
| `swarm_statement_mark` [added] | `folder, id, mark` | `Statement[]` |
| `swarm_confirm_statement` [added] | `folder, id` | `Statement[]` |
| `swarm_correct_statement` [added] | `folder, id, text` | `Statement[]` |
| `swarm_remove_statement` [added] | `folder, id` | `Statement[]` |
| `skills_catalog` | – | `[{id, name, author, licence, about, source, roles, files, added}]` |
| `skills_add` | `id` | `()` (downloads pinned files) |
| `skills_remove` | `id` | `()` |
| `control` | `op, folder?, args?` | the op's JSON (1.3) |

formal-ast, Lean and the Code tab:

| Command | Args | Returns |
|---|---|---|
| `ast_units` [added] | `folder, entry` | `formal_ast::audit_json` |
| `ast_slice` [added] | `folder, entry, function` | Markdown |
| `ast_formal` [added] | `folder, entry` | Lean coverage JSON |
| `ast_scripts` [added] | `folder` | script entries JSON |
| `lsp_definition` | `folder, path, line, character` | `Location[]` (solidity-language-server; retries a few seconds while it indexes) |
| `lsp_hover` | `folder, path, line, character` | `string \| null` |
| `lean_open` | `folder, path` | `{text, version, project, toolchain}` |
| `lean_sync` | `folder, path, text` | new version (i64) |
| `lean_state` | `folder, path` | `{version, diagnostics, processing, …}` |
| `lean_symbols` | `folder, path, version` | document symbols; Err `"Buffer changed"` if version moved |
| `lean_goal` | `folder, path, line, character, version` | goal JSON; same version rule |
| `lean_save` | `folder, path, text, expected` | `()`; refuses when disk text ≠ `expected` |
| `lean_close` | `folder, path` | `()` |
| `lean_restart` | `folder, path` | `()` |
| `proof_specs` | `folder` | specs from `.formal/proof-specs.json` (schema 1, ≤2 MiB) or `[]` |
| `proof_relevant_code` | `folder, spec_id` | the spec's `relevantCode` ranges with text and whether `expectedText` still matches |
| `term_start` | `folder, path?, line?, cols, rows` | terminal id (u32); Neovim in a PTY |
| `term_write` | `id, data` | `()` |
| `term_resize` | `id, cols, rows` | `()` |
| `term_kill` | `id` | `()` |

Only some are invoked by `desktop/src` directly today (folder_read, control, folder_tree, swarm_stop/say/running,
term_*, lean_*, lsp_*, …); the rest are used by `components/local-demo.tsx`, `components/projects/git-bridge.ts`, the
`control` op table or the MCP. All 75 stay registered.

### 1.2 Events the backend emits (5)

| Event | Payload | When |
|---|---|---|
| `swarm` | `SwarmEvent` `{folder, run, kind, role, item, text, spent: f64, at: u64 ms}` | every session event; also appended to `.formal/runs/<run>.jsonl` (B44) |
| `swarm-running` | `{ "<folder>": ["<run>", …] }` for every folder with a running session | whenever a session starts or ends, by any route |
| `term:data` | `{id, data}` (`data` base64 of the PTY bytes) | Neovim output |
| `term:exit` | `{id}` | the PTY's process ended |
| `fm:settings` | `null` | menu Settings… (⌘,) |

`SwarmEvent.kind` values (the UI switches on them): `start`, `status`, `say`, `tool`, `result`, `you`, `bug`, `plan`,
`done`, `error`, `context`, `ask`. `context.text` is a JSON string
`{used, window, compact_at, system, tools, task, estimated?}`. `item` is a plan item number, `S-01.2` for a statement
obligation, `plan`, `report`, `you`, a statement id, or empty. `role` is `swarm`, `planner`, `prover`, `reviewer`,
`assistant`, `auditor` or `you`.

Inbound: the deep link `formalmind://auth?code=…` (handled in the webview, `desktop/src/app.tsx`), the updater plugin
(`latest.json` at `github.com/formalmind/releases/releases/latest/download/latest.json`, pubkey in `tauri.conf.json`),
dialog, opener, process (relaunch) and single-instance (release builds only) plugins.

### 1.3 The control API and the relay (`control.rs`, `relay.rs`)

`control::OPS` must equal `lib/mac-ops.ts` `MAC_OPS` (names and the read/write split; a test enforces it). 47 ops.
`dispatch(op, folder, args)` is the single entry point for the app's `control` command, the relay, and tests.

Reads (no folder guard for `folders`, `status`, `health`; the rest are [added], with the Err
`"<folder> isn't one of the added folders: <list>"`): `folders`, `status`, `files`, `scan`, `git`, `read_file(path)`,
`plan`, `statements`, `bugs`, `proofs`, `queue(run?, done?)`, `sessions`, `running`, `history(run)` (last 300),
`scripts`, `units(entry)`, `coverage(entry)`, `slice(entry, function)`, `work_map`, `health(limit?)`,
`brief(function)`, `ledger(check?=true, force?=false)`, `questions`, `diagnose(item)`, `skills`.

Writes: `add_folder(path)`, `remove_folder(path)` (Err if not added), `verify_repo(repo, ref?, goal?, budget?, path?)`,
`answers(who: "mcp"|"agent")`, `start(goal?, budget?, run?, title?, answer_only?)` → `{run}`, `stop(run)`,
`pause(run?)` → `{paused: [...]}`, `resume(run?)` → `{run}`, `say(run, text)`, `set_budget(run, usd)`,
`add_statement(text)` → `{statement, running}`, `confirm_statement(id)`, `correct_statement(id, text)`,
`mark_statement(id, mark)` → `{statements, running}`, `remove_statement(id)`, `skill_add(id)`, `skill_remove(id)`,
`triage(path, run?)` → `{running}`, `github(on)` → `{folder, github}`, `refresh_model` → `{regenerated}`,
`check_proof(path, content?)`, `submit_proof(function, path, notes?, run?)` → `{queued, running}`.

Missing required args fail as `"<op> needs <arg>"`; unknown ops as `"unknown op <op>"`. `status` returns
`{version, claudeCode, codex, anthropicKey, openaiKey, provider, model}`. `folders` returns
`[{path, name, repo, github, sessions: [{run, title, outcome, spent, events, at, running}]}]` (≤12 sessions, plus any
running session without a log yet, listed first).

The relay (the formal-team MCP's `mac_do`, `mac_get`, `mac_swarm`, `mac_swarm_send`, `mac_swarm_events`, `mac_watch`
go through formal.team's relay to this loop; `lib/relay.ts`, `worker/relay-do.ts`):

- Up: `POST {api}/api/relay/mac` with bearer token, bodies `{events: SwarmEvent[]}` (batched every 400 ms),
  `{state: {folders: [{path, name, repo, sessions: [{run, title, outcome, spent, running}]}], at, name, version}}`
  (on start/done/`swarm-running` and at least every 60 s), `{replies: [{id, ok, result|error}]}`,
  `{history: {folder, run, events}}`.
- Down: long poll `GET {api}/api/relay/mac?after=<last>&wait=1` → `{commands: [...], last}`. Command `type`s: `call`
  (`{id, op, folder, args}` → dispatch → reply), `say`, `stop`, `start` (`goal`, `budget`, `run`), `history`
  (last 600 events, each stamped with folder and run). An error from say/stop/start is sent up as an event
  `{folder, run (default "swarm"), kind: "error", role: "swarm", item: "", text, spent: 0}`.
- Off when Settings `relay` is false, when not signed in, or when `FM_RELAY=0`; while off, queued events are dropped.
  Poll failures back off `min(2·n, 60)` s.

---

## 2. On-disk state

Existing folders and `~/.formalmind` must keep working unchanged. Unknown fields must be preserved or ignored, never
rejected.

### 2.1 `~/.formalmind/` (Windows: `%USERPROFILE%\.formalmind`)

- `config.json`: `{folders: string[], repos: {owner/name: path}, settings}` pretty JSON + newline. A missing file is
  an empty config; a malformed one is an error `~/.formalmind/config.json: …`.
- `settings`: `api_base?` (default `https://formal.team`), `provider?` (`claude-code` default, `codex`, `formal`,
  `anthropic`, `openai`; anything else reads as `claude-code`), `model?`, `effort?` (`low|medium|high|xhigh|max`),
  `budgets: {folder: usd}` (default 5.0 when ≤0 or missing), `github: {folder: bool}` (default false),
  `answers?` (`agent` or default `mcp`), `relay?` (default true).
- `repos/<owner>/<name>/`: shallow clones from `repo_local`.
- `skills/<id>/…` + `SOURCE.md`: added auditing skills.
- `claude-code/<folder-name>-<fnv32 hex of path>/<run>/`: `mcp.json` (0600, carries the bridge token),
  `job-<id>.session`, `stream.jsonl`, `stderr.log`.
- `codex/<folder-name>-<fnv32>/<run>/`: `instructions.md`, `job-<id>.thread`, `stream.jsonl`, `stderr.log`.
- Logs (`platform::log_dir`, `~/Library/Logs/Formal Mind` on macOS): `errors.log`, `turns.jsonl` (health; counts and
  outcomes only, never prompts or code).

### 2.2 The folder

`formalmind.toml` (written once by `ensure_config` when a Lake project exists and the file doesn't):

```toml
[lean]
project = "formal"   # folder with the lakefile; "." for the root
sources = "formal"   # where Lake reads the sources; module names are relative to it
archive = "…"        # optional: earlier proofs, read in place, never copied
```

`.formal/` (the swarm's; agents may not write here, B23):

| Path | Format |
|---|---|
| `plan.md` | Markdown checklist. Items are lines whose trimmed start is `- [m] ` with `m` ∈ ` `, `x`/`X` (proved), `!` (blocked or bug), `~`. Numbered 1.. in file order, nested items included. Generated item line: `` - [ ] `Lean.def` — Contract (src/X.sol:12): <mutability> · writes [a, b] · guards N · external calls N[ · called by S1, S2] ``. The def is the first backticked token. Header when created: `# Plan` + a paragraph. |
| `queue.json` (session `swarm`) / `queues/<run>.json` | `{next_id, jobs: [Job], spent}`, pretty JSON, written via `.json.tmp` + rename. `Job`: `{id, kind: plan|prove|review|answer|formalize|triage, item, text, state: queued|running|done, attempt, notes, files[], summary, result: approve|changes|bug|"", property?, verdict?, statement?}`. `next_id` starts at the current Unix seconds. |
| `jobs/<id>.json` (session `swarm`) / `jobs/<run>/<id>.json` | API-route transcript: the Messages array as sent and received (thinking blocks included). |
| `runs/<run>.jsonl` | one `SwarmEvent` per line; `runs/<run>.title` a rename; `runs/archive/local-*.jsonl` old logs. |
| `run.lock` | the owning app's pid. |
| `proofs.json` | `{ "<item>": {item, files, summary, at} }` |
| `ledger.json` | `{checked: {at, sources: "<CHECK_VERSION>:<hash>", results: {theorem: Checked}}, reviews: {"<lean def>": {verdict: "approve", at, defHash, theorems: {name: hash}, notes}}}`; hashes are FNV-1a 64-bit hex (`ledger::hash`), stable across builds. `CHECK_VERSION` = `"3"`. |
| `check/ledger-<Module_Name>.lean` | scratch files the ledger runs with `lake env lean`. |
| `statements.md` | see 2.3 |
| `statements.json` | `{ "S-01": { "<n>": {theorem, files, notes} } }` |
| `findings.sarif` | SARIF 2.1.0; the swarm's results (`formal-mind/finding`, `formal-mind/tag/<kind>`) in its own run, other tools' runs kept. |
| `bugs/*.md` | legacy bug files read by `swarm_bugs` (first line `# title`). |
| `proof-specs.json` | `{schema: 1, specs: [...]}` for the Lean pane. |

Report folder: the first existing of `audit/`, `audits/`, `reports/`, else `audit/`:
`README.md` (index; the swarm's section `## formal-mind-swarm.md` with table
`| ID | Severity | Finding | Status | Evidence |`, rows `| FM-NN | High | title | ⏳ Open | PoC `path`; `loc` |`, ids
`FM-NN` = max existing + 1), `formal-mind-swarm.md` (one `### [FM-NN] title` section per finding),
`formal-mind.audit.json` (`formalmind.audit/v1`, kind internal: `findings[]`, `properties[]` with ids `P-NN` for plan
items and `P-S01` for statements, upserted by id), `<report>.audit.json` next to each triaged report.

### 2.3 `.formal/statements.md`

```
# Statements

<header paragraph>

- [m] S-01 · you · the claim in plain words
  - kind: access · …
  - why: … / you said: … (kept across re-formalization)
  - [ ] `Vault.setFee` — Vault (src/Vault.sol:20): …   (obligations, one per function, plan-line format)
<!-- next: S-03 -->
```

Marks: ` ` open, `~` working, `x` proved, `!` disproved, `?` waiting for the maintainer, `-` can't be proved against
this model. A hand-written top-level `- [ ] text` without id gets the next id (`S-NN`, never reused) and author `you`
the next time it is read, written back. A statement's mark derives from its obligations (all proved → `x`, one
disproved/blocked → `!`, any progress → `~`). Obligation proofs go to
`<sources>/Proofs/InformalSpecs/S01/<Contract><Fn>.lean` (`<proofs>/Statements/` in older layouts) with theorem name
`S01.<Contract>_<fn>`.

### 2.4 Lake project discovery (`swarm_ctx`)

1. `lake_dir`: `formalmind.toml` `lean.project` if it has a lakefile (`lakefile.toml` or `lakefile.lean`); else the
   folder; else `formal/`; else the shallowest directory ≤3 levels down (skipping `.git .lake .formal .claude
   node_modules lib dependencies out cache broadcast target dist`, sorted) whose lakefile declares a `Generated` or
   `Specs` library.
2. `lean_src`: `lean.sources` if inside the Lake project; else the lakefile's `srcDir` (toml `srcDir = "…"` or lean
   `srcDir := "…"`, not `.`, no `..`); else the Lake project.
3. `layout`: `(Generated, Refinement)` when the lakefile declares either or `lean_src` has either folder; else
   `(Specs, Proofs)`. `functions_dir`: `Swarm` under `Refinement`, or when only `Swarm/` exists; else `Functions`.
4. `scaffold` (no project): `formal/` with `Specs/`, `Proofs/`, `lean-toolchain` `leanprover/lean4:v4.35.0`,
   `lakefile.toml` with the two libs, `.gitignore` `.lake/`.
5. A **stray** is a path outside `lean_src` whose first component under the Lake project or the folder root is the
   specs or proofs folder name (e.g. `Generated/AsyncSwap.lean` at the root when Lake reads `validation/lean/`).
   Its error: `"<path> is outside the Lake sources (<src>/), so Lake never builds it: use <right path>"`.
6. Plan item proof file: `<src>/<proofs>/<functions_dir>/<Contract><CapitalizedFn>.lean` (`«»` → `Fallback`).

---

## 3. Behaviours

Each: **trigger → what happens → observable result**.

### Sessions, start, stop

- **B1 Start.** `swarm_start(request)` (or `control start/resume`) → checks the folder is added; the route's
  credential (`anthropic`/`openai`: key in keychain, else `"Add your Anthropic key first"` / `"Add your OpenAI key
  first"`; `claude-code`: `claude auth status`; `codex`: `codex login status` must say ChatGPT; otherwise the session
  token, else `"Sign in to Formal Mind first"`); refuses a running `(folder, run)` with `"This session is already
  running"`; claims the folder (B3); merges legacy logs (B46); loads the session's spend; enqueues `goal` (trimmed,
  non-empty) as an `answer` job; registers the session; broadcasts `swarm-running`; spawns the loop which emits
  `start` (text = goal) then `status` `resuming`. Returns the run id.
- **B2 Session ids.** `session`/`run` must be ASCII alphanumerics and `-`; anything else (or empty) is `swarm`.
  Several sessions may run at once in one folder or several, keyed `folder\nrun`.
- **B3 One app per folder.** `.formal/run.lock` holds a pid. Another live pid → Err
  `"Another Formal Mind (process <pid>) is running this folder's swarm; pause it there first"`. A dead pid is stale and
  taken over. The lock is removed when this app's last session in the folder ends.
- **B4 Item claims.** A session working on a plan item (prove/review, not a statement obligation) claims it; other
  sessions in the folder skip it. A session holds one claim at a time; ending releases it. When every open item is
  claimed by others the loop ends with `done: the rest of the plan is being worked in another session`.
- **B5 Stop/Pause take effect mid-turn.** `swarm_stop` sets the stop flag. Every wait inside a turn (each model
  call, each tool call, Claude Code's and Codex's output streams) races the flag (polled every 300 ms): a running tool
  call returns `"stopped: the swarm was paused; this call didn't finish"`; a Claude Code / Codex child is killed; an
  API step returns. Observable: a Stop during a minutes-long model call or `lake build` ends the turn within ~1 s, and
  the session emits `done` with `paused: resume anytime, the queue carries on`.
- **B6 A stopped turn stays queued.** If the turn was stopped and did not reach a verdict or a bug (PR #71; before it:
  "and its summary is empty"), the job stays `running` in the queue and no follow-up is queued; the next start resumes
  it. A turn that reached a verdict or a bug before the stop is finished normally.
- **B7 Background tasks.** Stopping the last non-stopped session of a folder cancels its background forge tasks
  (`analysis::cancel_tasks`).
- **B8 Session end.** When the loop returns: if not stopped and an `answer` job is queued, the loop runs again
  (B20); else emits `done` (text = the outcome), releases claims, unregisters, releases the folder lock when it was
  the last session there, broadcasts `swarm-running`, and exits the app if ⌘Q was pressed and nothing is left.
- **B9 Outcomes** (the `done` text): `paused: resume anytime, the queue carries on`; `paused: <error>`;
  `budget reached ($X.XX spent of $Y.YY); raise it and resume to carry on`; `done: the queued work is finished`;
  `done: the rest of the plan is being worked in another session`;
  `done: every function in scope is proved or blocked (N items)`;
  `failed: formal-ast found no function in scope (no script under script/ deploys or calls the contracts)`.
- **B10 Budget.** The cap is `max(budget_usd, spent)`; `swarm_set_budget` changes it live (≥0). Before each job,
  `spent ≥ cap` ends the session, except on `claude-code` and `codex` (the plan pays; nothing is metered). Spend is
  the sum of `cost(model, usage)` per call (B27), stored in the queue's `spent` after every call.
- **B11 Quit.** ⌘Q with no session running exits. With sessions running, the window hides, the Dock icon goes
  (Accessory policy), and the app exits after the last session ends; showing the window (Dock click, second launch,
  deep link) cancels that. Closing the window only hides it. On `ExitRequested`, every session is flagged stopped and
  a `done` line `paused: the app quit. Resume to carry on from the plan.` is appended to its log (not emitted).
- **B12 Only queued work.** `only_queued: true` (and `control start answer_only`) starts with the plan off: the
  session answers/handles queued jobs and statement work, then ends `done: the queued work is finished`, unless an
  agent called `start_work` or `reopen` (B19). `work_queued`: when a statement, triage or submitted proof is queued and
  nothing runs in the folder, a session `swarm` starts with `only_queued`.
- **B13 Dev autostart.** Debug builds only: `FM_SWARM_AUTOSTART=<folder>` starts that folder's session at launch with
  `FM_SWARM_GOAL/BUDGET (default 10)/PROVIDER/MODEL/SESSION/ONLY_QUEUED` and `FM_API_BASE`.

### The loop: one item per function

- **B14 Job order.** Each iteration picks: a `running` job (resumed; one not claimed elsewhere) → the oldest queued
  `answer` → the oldest queued job not claimed elsewhere → a `formalize` job for the next statement awaiting it → the
  next confirmed statement obligation (marked `~`) → a `prove` job for the first open (` `) plan item not claimed
  elsewhere (attempt = previous prove jobs for that item + 1) → a `plan` job. The picked job is marked `running`
  before the agent starts.
- **B15 Planning without a model.** At the first iteration with no answer job waiting, and for every `plan` job,
  `sync_plan` runs: reads formal-ast (writing missing models), appends one line per in-scope unit not yet in the plan
  (matched by def and contract; already-proved ones come checked), emits `result` for each unreadable file, each
  regenerated model, and each stray copy (`<dir>: a copy outside the Lake sources that Lake never builds; the agents
  can't read or check it, and it can go`), then runs the ledger (B31) and reopens lapsed items (B33), then emits
  `plan` with one of: `the plan has every function in scope` / `N items from the AST` / `R proved items reopened: …` /
  both.
- **B16 Unit order.** Units of in-scope contracts (deployed or called by `script/`, with their bases), skipping
  opaque ones, one per (def, contract); ordered: called by a script, then writes storage or calls out, then the rest,
  then internal; within a group by `arith + 2·external + guards` ascending.
- **B17 Prove → check → review.** A `prove` job runs the prover with the brief (def, model, slice, where to write).
  After the turn (no bug, not stopped) the swarm checks: a `.lean` file was written for the job (or the expected
  proof file exists); none of them contains the words `sorry`, `admit`, `axiom`, `native_decide`;
  `lake build <modules written>` (only those; `lake build` when none is a module) exits 0; formal-ast counts the item's
  def as proved by a sorry-free theorem. For a statement obligation also: the named theorem exists, has no `sorryAx`,
  and its type names the def. Pass → a `review` job (same attempt, prover's summary + "Checked by the swarm: …",
  files, property notes). Fail → `result changes`, a new `prove` with attempt+1 and notes `The swarm's check failed:\n…`
  and the files, or the item blocked `!` after attempt 3.
- **B18 Review.** The reviewer calls `verdict` once. Approve → plan item `x`, ledger approval for the def and its
  theorems now (B32), `publish::after_approval` (B58), the merged property (prover's notes, each non-empty reviewer
  field replacing) recorded as `P-NN` in `formal-mind.audit.json`, `proofs.json` entry, job `result approve`. Changes
  or no verdict → a new `prove` (attempt+1, the notes or `The reviewer gave no verdict; …`) or `!` after attempt 3.
  A bug during prove or review → `!`, `result bug`. Plan events: `item N checks; to review`, `item N proven`,
  `item N: the check failed, back to the prover`, `item N blocked: the proof didn't check after 3 attempts`,
  `item N blocked after 3 attempts`, `item N: bug reported, moving on`.
- **B19 Assistant answers and starts work.** An `answer` job runs the assistant on `The maintainer says:\n\n<text>`
  plus the statements waiting for confirmation. `start_work` turns the session's plan work on; `reopen(defs)` sets
  those plan items back to ` ` (by backticked def), turns work on, and reports `reopened …; not in the plan: …`.
  Without either, a session started by a message answers and ends.
- **B20 A message on a finishing run is answered.** `swarm_say` enqueues an `answer` job and emits a `you` event with
  the session's spend; Err if the session isn't running. If it lands after the loop decided to end, the session loop
  runs again instead of ending (B8), and a `plan` job re-checks for a waiting answer before finishing.
- **B21 Triage.** `swarm_triage` enqueues `triage` with the report path. The auditor gets a PDF as a document block
  (base64) or Markdown/text inline; it calls `record_report` once and `record_finding` per finding into
  `<report>.audit.json`; ends with plan `read <path>: its findings are in Bugs`.
- **B22 Submitted proofs.** `swarm_submit_proof` finds the plan item naming the def (Err `No plan item names …`),
  enqueues a `review` (attempt 1, files `[path]`, summary noting it came from outside via MCP).

### Tools and the folder sandbox

- **B23 Tools per role** (`swarm.rs::tools`): all: `functions`, `function`, `read_file`, `search`, `find`, `run`;
  not reviewer/auditor: `report_bug`, `write_file`; not auditor: `tag`, `run_in_background`, `background_results`;
  auditor: `record_report`, `record_finding`; assistant: `formalize_result`, `confirm_statement`, `start_work`,
  `reopen`; prover: `record_property`; reviewer: `verdict`. Schemas must stay byte-for-byte compatible.
- **B24 Paths.** Every file path must be relative (an absolute path echoing the folder is accepted), without `..`,
  and its nearest existing ancestor must resolve inside the folder (no symlink escape).
- **B25 `.formal/` is the swarm's.** `write_file` into `.formal/` fails with
  `error: .formal/ is the swarm's; it ticks a plan item once its proof checks and the reviewer approves it (reopen
  puts items back in the plan)`.
- **B26 Commands.** `run` allows only `lake build …`, `lake exe cache get`, `lake init|new <Name>`,
  `lake env lean <file in sources>`, `forge build|test …`; anything else errs with the allowlist sentence. `lake` runs
  in the Lake project; `forge` in the folder. PATH is the tool path; `ELAN_TOOLCHAIN` defaults to
  `leanprover/lean4:v4.35.0`; 15-minute timeout; output `exit <code>\n<stdout><stderr>` clipped to 12 000 bytes
  (head + `… [cut] …` + tail). Before any `lake` command, a `.lean` file in the folder containing `#eval`,
  `IO.Process`, `IO.FS`, `System.FilePath`, `run_cmd` or `initialize ` refuses the run.
- **B27 Stray copies are invisible.** `read_file`, `write_file` and `lake env lean` on a stray path fail with the
  stray error (2.4.5). `search` and `find` (both the executor's and the swarm's own) drop hits in stray copies
  (PR #71). The swarm's `search` searches `.lean` files under the Lake project; the executor's searches
  `.sol .lean .md .toml`. Both: regex, `path:line: text`, ≤200 hits, `no matches`; bad regex → `bad pattern: …`.
  `find` is fuzzy over file paths (fff index, watcher), ≤30, skipping `.git node_modules lib dependencies out cache
  broadcast target .lake dist .formal`.
- **B28 read_file.** `@skills/…` and bare skill paths resolve to `~/.formalmind/skills`. Files ≤12 000 bytes come
  whole; longer or with `start_line`/`end_line` come as numbered slices of ≤300 lines with `lines a-b of N`.
- **B29 Writes are recorded at once.** Each `write_file` path (outside `.formal/`) is added to the job's `files` in
  the queue as it happens, and the chat gets a `result` with a unified diff (3 lines of context, ≤20 000 chars).
- **B30 report_bug.** The PoC must be `test/…/*.sol` and exist; the swarm runs `forge test --match-path <poc>`; a
  compile failure is refused; otherwise it files `FM-NN` in the report index and report, `formal-mind.audit.json`, and
  `findings.sarif` (critical/high → error, medium → warning, else note), and emits `bug` `FM-NN title — poc`.

### Proof ledger and reopening

- **B31 Ledger.** `ledger::build(check, force)` lists every in-scope function: `not_modeled`, `unproved`,
  `pending`, `partly proved` or `proved`, with `notYet` reasons. Proved needs: ≥1 theorem naming the def in a module
  Lake builds (a lib the lakefile declares); every counted theorem checked by Lean (`#check @T`, `#print axioms T`,
  per module, via `.formal/check/`) against the current sources hash; no `sorryAx`/extra axioms beyond `propext`,
  `Classical.choice`, `Quot.sound`; a checked type mentioning the def; the reviewer's approval holding for the def's
  hash and each theorem's text hash; and coverage of `reverts`, `writes`, `returns` (a def without `throw` covers
  reverts, without `set`/`modify` covers writes, once returns is covered). Lean reruns only when the sources hash
  changed, a theorem is missing a result, or `force`. Statement proofs are excluded. Approvals recorded while Lean ran
  are not overwritten.
- **B32 Approvals hold for code, not marks.** `ledger::approve` stores `{verdict, at, defHash, theorems{name:hash},
  notes≤4000}` under the def. Any change to the def's generated text or a counted theorem's text lapses it
  (`lapsed: the def or a theorem changed since it was approved`). A tick from before the ledger holds only if
  `proofs.json` has a record for the def with the current `defHash`; otherwise `lapsed: proved before the ledger, with
  no record of the code it proved`.
- **B33 Reopen changed functions.** At each `sync_plan`, every `x` item whose ledger entry is not `proved` is set
  back to ` ` with a `result` `reopened \`def\`: <first notYet reason>`. A ledger failure leaves marks as they are and
  says so.
- **B34 Models follow the code.** formal-ast rewrites a generated model when it is missing, the contract's code
  changed, or more functions translate; never when fewer would. Rewrites are listed in `regenerated`.

### Executors

- **B35 API route** (`formal`, `anthropic`, `openai`). Key: own key from the keychain (to `api.anthropic.com` /
  `api.openai.com`), or `POST {api}/api/desktop/model-session` `{folder: <basename>, run, role, ref: item}` with the
  session token → `{key, base_url}`. Request: model (`claude-opus-5-5` default; sonnet/haiku 5.5; OpenAI models from
  `openai::MODELS`), `max_tokens` 16000, the role's system prompt and tools, `cache_control: ephemeral`,
  `output_config.effort` `high` for the prover else `medium`. OpenAI requests are translated to Chat Completions and
  back. Loop until a reply has no `tool_use` or `stop_reason ≠ tool_use`; max 90 steps for the prover, 40 otherwise.
  `status` `step N: thinking` before each call; `say` per text block; `context` after each call.
- **B36 Transcripts survive a quit.** The API conversation is saved to `.formal/jobs/…` after every step. On resume a
  trailing assistant message (tool calls without results) is dropped and a user line `The app quit and this job is
  being resumed. …` is added. The task also carries `This job was interrupted … Files already written for it: …`.
- **B37 Auto-compaction (API).** When the last reply's context (input + cache creation + cache read + output) ≥ 75% of
  the window (1M for Claude, 400k for `gpt-*`), or Compact now was pressed (and there is more than the task), the
  older steps are summarized with the compaction beta `compact-2026-09-04` (`compaction: {type: summarize,
  instructions}`), keeping the last 3 steps; the summary goes first as an assistant message, the kept steps follow
  unchanged, and the task is restated on the last user turn. If the summarizer itself overflows, an earlier cut (about
  half) is tried, up to 4 times. A step failing as too long (413, or 400 mentioning too long/context window/maximum
  context, or `model_context_window_exceeded`) compacts and retries once. Cut points keep each tool_use with its
  tool_result. Compaction cost counts `usage.iterations`.
- **B38 Claude Code route.** One `claude -p` per turn, in the folder (cwd checked against `init`; a mismatch kills it
  with an error), stream-json in and out, `--system-prompt <role prompt>`, `--tools ""`, `--mcp-config <state>/mcp.json`
  pointing at a per-turn local MCP bridge (`127.0.0.1:<port>/mcp`, random bearer token), `--strict-mcp-config`,
  `--allowedTools mcp__formalmind`, `--setting-sources ""`, `--disable-slash-commands`, `--model`, `--effort` from
  Settings, `--session-id <stable uuid per folder/run/job>` or `--resume <saved>`; `ANTHROPIC_API_KEY` removed;
  `MCP_TOOL_TIMEOUT=7200000`. The job's session id is saved once the first assistant line arrives; a later start
  resumes it. No spend is charged.
- **B39 Codex route.** One `codex exec [resume <thread>] --json --ignore-user-config --ignore-rules
  --skip-git-repo-check -m <model>` per turn with 15 built-in features disabled and `-c` config: instructions file,
  read-only sandbox, approval never, no web search/apply_patch/view_image/skill instructions, MCP server `formalmind`
  (required, auto-approved, 7200 s tool timeout, token via `FORMALMIND_MCP_TOKEN`),
  `model_auto_compact_token_limit = 75% of the window` (#70), effort (`max` → `xhigh`). `OPENAI_API_KEY` and
  `CODEX_API_KEY` removed. The thread id is saved on `thread.started`; a later start resumes it. Models
  `gpt-6-astra` (default), `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.
- **B40 Tools must connect.** Claude Code reporting the `formalmind` MCP server as anything but `connected`, or Codex
  failing with `required MCP servers failed`, is the error `the agent's tools didn't connect (…)`; the turn is retried
  twice more (3 s, 6 s apart) before the session pauses with it.
- **B41 Plan limits pause.** A Claude Code `result` error or a Codex `turn.failed`/`error` line (e.g. a usage limit)
  ends the session `paused: <why>` with the job still running, so the next start resumes the conversation.
- **B42 Context for CLI routes.** `context` events carry the CLI's reported usage with `estimated: true` and
  system/tools/task estimated at 4 chars per token; on the API they come from `/v1/messages/count_tokens`.
- **B43 Health.** Every turn writes one `turns.jsonl` line (folder, run, job, role, item, provider, model, tools
  status, tool-call counts, calls written as text, lake ok/failed, timeouts, max tokens, how it ended:
  done/paused/error). Anomalies are emitted as `error` events `health: the <role>'s turn on item <item>: …`.

### Logs, history, sessions

- **B44 Event log.** Every emitted `swarm` event is appended to `.formal/runs/<run>.jsonl` before it is emitted.
- **B45 History.** `swarm_history` returns the log with all non-noise events (`say`, `you`, `plan`, `bug`, `done`,
  `ask`, `error`, `start`, …) and only the newest 600 of `tool`/`result`/`status`/`context`, in order, each `text`
  cut to 8000 bytes plus `\n…`.
- **B46 Legacy logs.** On start, `runs/local-*.jsonl` are concatenated (sorted) into `runs/swarm.jsonl` with
  `run: "swarm"`, moved to `runs/archive/`, and their last `spent` values added to the default queue's spend.
- **B47 Session list.** Title: `.title` file, else the first non-empty `start` text, else the first `you` text cut
  to ≤60 chars at a word with `…`; outcome: the last line's text when it is `done`; spent: the last line's; `at`: the
  log's mtime.
- **B48 Suggest.** `swarm_suggest` drafts the user's next message (1–3 sentences) with Haiku 5.5 (Claude Code),
  `gpt-5.6-luna` (Codex), `gpt-5-mini` (OpenAI) or Haiku on the API route.

### Statements

- **B49 Add.** Text is whitespace-collapsed, 1–2000 chars, not a case-insensitive duplicate (`already in the list as
  S-NN`); appended before the next-id line as `- [ ] S-NN · you · text`; `next` advanced. Agents' proposals are `?`.
- **B50 Formalize.** An open statement with no `kind:` gets a `formalize` job; the assistant answers via
  `formalize_result`, checked against formal-ast (`access`: every entry point writing the variables). Provable kinds
  (`function`, `access`, `invariant`, `conservation`, `sequence`) are written with mark `?`, the details and obligations,
  and an `ask` event with drafted replies; others are written open with a plan event that the swarm doesn't prove them
  yet. No answer → mark `?` with `note: couldn't formalize it: …`. With Settings `answers: agent`, the answerer agent
  confirms or corrects once in the background.
- **B51 Confirm / correct / mark / remove.** Confirm requires `?` with a kind, sets it open keeping obligations;
  correct drops the formalization and keeps `you said: …`, open again; mark sets any of the six marks; remove deletes
  the block, the id is never reused. Each op through `control` starts a session when none runs (B12).
- **B52 Obligations.** Proved like plan items (B17–B18) with item id `S-NN.n`. Approval records
  `statements.json`; when all are proved the statement becomes `x`, `P-S01` goes into the audit file, and a plan event
  `S-01 proved: …` is emitted. Whole-contract kinds are taken only after every plan item is done.

### Reads for the pages and the MCP

- **B53 Work map.** `swarm_work_map` → `{folder, lake, sources, totals: {proved, hasSorry, inLean, notModeled}, plan:
  {items, proved, blocked, open}, next: ≤25 open functions (script-called first), contracts: [{contract, file, model,
  functions: [{function, lean, status, why, theorems, proofFile, plan: {item, mark}|null, scripts}]}], problems,
  regenerated}` without writing models.
- **B54 check_proof.** Path must be a `.lean` under `<sources>/<proofs>/` (Err otherwise; Err when no Lake project);
  writes `content` if given; cheat words → `ok: false`; `lake build <module>`; on success lists the functions it
  proves.

### Folders, sign-in, settings, updates, Neovim

- **B55 Folders.** Only added or repo-mapped folders are readable; `folder_scan` skips `.git node_modules lib
  dependencies out cache target .lake dist`; `folder_tree` also skips `broadcast .formal .next` and `.DS_Store`; both
  stop at 5000 entries with `truncated`.
- **B56 Git graph.** `git log --all --date-order -n 80` and HEAD's last 20, refs, uncommitted file count; read only;
  `GIT_TERMINAL_PROMPT=0`.
- **B57 Sign-in.** The webview opens `{api}/api/desktop/authorize[?poll=id]`, receives `formalmind://auth?code=…`
  (or polls `/api/desktop/token`), exchanges the code, and stores the `fmd_…` token with `token_set`. The backend
  only stores, reads and clears it; every formal.team call sends it as bearer. Sign-out clears the keychain.
- **B58 Publish to GitHub.** Only for folders with `github: true`: after each approval, in the background, the README
  section from the ledger is updated, committed (co-authored by formalmind[bot]) and pushed to the formalmind fork.
  `verify_repo` forks, clones into `~/formal-targets/<name>[-<ref>]` (or `path`), checks out `ref` on its own branch,
  adds the folder with GitHub on and starts the swarm → `{folder, branch, fork, run}`.
- **B59 Updates.** The webview checks the updater on launch and every 6 h and offers Update (download, install,
  relaunch). Asset names and signature rules in `AGENTS.md` are part of the contract.
- **B60 Neovim.** `term_start` runs the bundled `Resources/nvim/bin/nvim` (with `VIMRUNTIME`) or one on the machine,
  in the added folder, `+line path`, in a PTY sized `max(cols,10)`×`max(rows,2)`, `TERM=xterm-256color`,
  `COLORTERM=truecolor`; ids start at 1; output → `term:data` (base64), end → `term:exit`.
- **B61 Lean pane.** One Lean server per Lake project; `lean_symbols`/`lean_goal` fail with `Buffer changed` when the
  version moved during the request; `lean_save` refuses if the file changed on disk; all servers stop on exit.
- **B62 Menu.** Settings… (⌘, / Ctrl+,) shows the window and emits `fm:settings`; Quit Formal Mind (⌘Q) is ours (B11).
- **B63 Skills.** `skills_add` copies a catalogue entry's files from a pinned commit to `~/.formalmind/skills/<id>/`
  with `SOURCE.md`; each role's prompt lists the files for its role as `@skills/…`.

### NEW requirements (not in the code today)

- **B64 NEW: the app opens on the project's file tree.** Trigger: launch, signed in, with at least one added folder.
  Result: the first screen is the file tree of the last-opened (else first) project folder, not the empty home or the
  canvas. Touches: `folder_tree` (as is), `config_get`; needs a persisted "last opened folder" (add an optional
  `settings.last_folder` to `config.json`, ignored by older builds) set when a folder page opens; front end
  `desktop/src/app.tsx` route `/` (`DesktopHome`) and `LocalFolderPage`. Test: with two folders and `last_folder` = B,
  a cold launch renders B's tree; with none, the add-a-folder step.
- **B65 NEW: the app's agent rebuilds a project in place.** Trigger: a folder is opened (e.g. this repository) in
  rebuild mode. Result: a session starts at once without a click, and its agent can read and write any project file
  directly, not only through the swarm's Lean/forge tools. Touches: `swarm_start`/`control start` (auto-start on
  open; today only `FM_SWARM_AUTOSTART` in debug builds), `executor::inside`/`in_sources` and `write_file` (today
  writes are limited by B24/B25/B27), `run_command`'s allowlist (B26: lake/forge only), `swarm.rs::tools` and
  `system` (a new role, e.g. `builder`, with its own prompt; the existing roles and prompts must not change),
  Claude Code `--tools ""` / Codex read-only sandbox (B38/B39), `.formal/queue.json` job kinds (a new kind). Must keep:
  the `.formal/` guard, path containment (no writes outside the folder), and the existing swarm loop for Solidity
  folders. See "Unclear" below.

---

## 4. Regressions the rewrite must get right

From #69 (`4378acc`, `a698488`), #70 (`324d9ad`, `14e492b`) and PR #71 (`8d5f2bb`, branch `claude/find-and-verdict`):

- **R1 Nested Lake project.** A lakefile in `validation/lean/` with `srcDir` must be found (B-2.4.1); otherwise the
  swarm scaffolds a second project and proves against a copy. Test: fixture with `validation/lean/lakefile.toml`
  declaring `Generated`; `lake_dir` returns it; `layout` is `Generated/Refinement`.
- **R2 Stale root copies.** With `Generated/X.lean` at the root and Lake reading `validation/lean/Generated/`:
  read_file/write_file/`lake env lean` refuse the root copy naming the right file; search and find (both paths) omit it;
  the planner reports it; formal-ast only counts theorems under `lean_src`.
- **R3 Ticks lapse with the code.** A checked item whose def changed is reopened at the next plan sync with the
  reason (test `changed_functions_are_reopened`). A legacy tick without a def hash goes back to the reviewer.
- **R4 Late message.** A `say` that lands while the run is finishing is answered before the session ends (test: queue
  an answer after `run_swarm` returns; the outer loop runs again).
- **R5 Assistant can't write `.formal/`.** It once marked a whole plan proved by writing `plan.md`; B25 refuses it,
  and `reopen` is the only way back.
- **R6 Stop mid-step.** Stop during a model call, a long tool call, or a Claude Code/Codex turn ends the turn within
  about a second (B5); the job stays queued (B6).
- **R7 Codex compaction.** Codex with ignored user config had no compaction limit for an unknown model and grew
  forever; it must be given `model_auto_compact_token_limit` = `compact_limit(model)` (300 000 for `gpt-6-astra`,
  750 000 for Opus).
- **R8 Verdict survives a quit.** The `verdict` input is written to the job in the queue the moment it is called; on
  resume or after a stop the stored verdict is restored into the outcome (test `a_verdict_survives_a_quit`).
- **R9 A stopped turn isn't finished** unless it reached a verdict or a bug (B6).
- **R10 Tools not connected.** A Claude Code reviewer without its tools wrote 321 tool calls as text; the turn must be
  stopped at `init` and retried (B40).
- **R11 Job ids don't collide** after `.formal/` is deleted (next_id seeded from the clock), nor across sessions
  (per-session transcript and CLI state folders).
- **R12 Build only what the item wrote**, so another agent's broken proof doesn't fail this one (B17;
  test `a_proof_is_checked_by_building_its_own_modules`).

Edge cases worth a test each: plan lines nested under others still count; `X` reads as `x`; queue file missing or
corrupt reads as empty (never an error); Claude Code's session uuid is derived with `DefaultHasher` (not stable across
Rust versions, but saved once started, so only an unstarted job is affected); a ledger check writes after re-reading
so a concurrent approval isn't lost; `pause_all` appends to the log without emitting.

---

## 5. Suggested module boundaries and tests

| Module | Owns | Behaviours | Tests |
|---|---|---|---|
| `contract` (Tauri glue) | the 75 commands, 5 events, menu, window and quit | 1.1, 1.2, B11, B62 | a compile-time list compared with `generate_handler!`; a JS-side snapshot of invoke names from `desktop/src` |
| `config` | `~/.formalmind`, settings defaults, folder guard | 2.1, B55, B64 | temp HOME (`TEST_HOME`), round-trip unknown fields |
| `fsguard` | `inside`, stray detection, `.formal` guard | B24, B25, B27, R2, R5 | path table tests, symlink escape |
| `lake` | project discovery, layout, scaffold, build command, run allowlist, lean guard | 2.4, B26, R1, R12 | fixtures per layout; `run_command` refusals |
| `ast` | formal-ast context, plan lines, briefs, work map | B15, B16, B34, B53 | fixture repos under `desktop/test-fixtures` |
| `plan` / `queue` | plan.md, queue files, transcripts, claims, run.lock | 2.2, B2–B4, B14, B36, R11 | `plan_round_trip`, `queue_and_transcripts_survive_a_restart`, `one_app_per_folder` |
| `loop` | the session state machine and job transitions | B1, B5–B12, B14, B17–B22, R4, R6, R8, R9 | a fake executor (scripted outcomes) and fake checker drive the loop end to end; assert queue states, marks and the event sequence |
| `executor::{api, claude_code, codex}` behind one trait `Agent::turn(role, item, task, tools) -> Outcome` racing a stop token | B35–B42, R7, R10 | fake HTTP server for the API; fake `claude`/`codex` binaries printing scripted JSONL |
| `compaction` | cut, splice, cost | B37 | existing `compaction_*` and `usage_*` tests |
| `tools` | tool schemas and handlers | B23, B27–B30 | schema snapshot per role; handler tests on a temp folder |
| `ledger` | checks, hashes, approvals, lapses | B31–B33, R3 | existing ledger tests + `lapsed` |
| `statements` | statements.md and statements.json | 2.3, B49–B52 | existing parser tests; fixture vault |
| `audit` | report index, FM ids, audit json, SARIF | 2.2 report folder, B30 | golden files |
| `events` | emit + jsonl log + history + sessions | B44–B47 | `long_histories_are_cut…`, `chats_are_named…`, `old_sessions_merge_into_one` |
| `control` / `relay` | ops table, dispatch, relay loop | 1.3 | `ops_match_the_published_list`, `every_read`, `every_action`, `refusals`, `relay_commands` with a fake engine |
| `health`, `publish`, `skills`, `answerer`, `diagnose` | as today | B43, B58, B63, B50 | as today |
| `code` (lsp, lean_lsp, term) | Code tab | B60, B61 | `lean_lsp` fixture test (skipped without lake) |

Each behaviour above should get one test named after it (`b17_failed_check_requeues_with_notes`, …). The loop tests
are the most valuable: the current code tests helpers, not transitions, which is how R4, R6, R8 and R9 shipped.

### Unclear (needs a decision before the rewrite)

1. B65 conflicts with the roadmap's standing rules ("the agents work the same"; the swarm's tools run only lake and
   forge and cannot run git) and with B25/B26. Is the rebuild agent a separate role and session kind outside the
   proof loop, and may it run shell commands (bun, cargo) or only read/write files?
2. B64: the Mac app's home is deliberately an empty screen with the next step (`3ec9fab`); confirm the file tree
   replaces it rather than sitting beside it, and whether the website changes too.
3. `ledger::review_state`'s legacy path looks for `defHash` in `proofs.json`, but `record_proof` never writes one:
   legacy ticks can only come from data written by an older build. Keep, or drop the path?
4. `SWARM-STATES.md` describes a target machine (Answering state, 3-error pause, `main` session name) that the code
   does not implement; the rewrite should implement what is described here unless told otherwise.
5. The `formal` (credits) route is still accepted but no longer offered; keep it?
