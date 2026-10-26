# Formal Mind desktop

A [Tauri 2](https://tauri.app) app: a native window over the same React components as the website (imported through
the `@/` alias, nothing copied), plus what only a native app can do. Runs on macOS, Windows and Linux.

- `src/`: the webview entry. `app.tsx` is the signed-in shell (sidebar, swarm canvas, Usage) and the sign-in screen;
  `api.ts` points the shared components' `fetch("/api/…")` at the API with the desktop token.
- `src-tauri/`: the Rust side. Keychain storage for the token, the `formalmind://` deep link, opening the browser.

## Local folders

**On this computer** in the sidebar adds folders from disk (native picker). The list lives in
`~/.formalmind/config.json`, the app's home for local settings. A folder's page lists its Solidity and Lean files
(skipping `.git`, `node_modules`, `lib`, `dependencies`, `out`, `cache`, `target`, `.lake`, `dist`). Only folders you added can be
read. Nothing is uploaded. `src-tauri/src/local.rs` has it, with a test (`cargo test` in `src-tauri/`).

## Develop

Needs Rust (`rustup`) and, on Linux, the [Tauri system packages](https://tauri.app/start/prerequisites/).

```bash
bun install
bun run desktop:dev
```

That starts Vite on :1420 and opens the app. It talks to https://formal.team by default. For a local Worker, run
`bun run dev:api` (port 8787) and either start the app with `VITE_FORMALMIND_API=http://localhost:8787` or set
**Server** on the sign-in screen. A local Worker without `APP_BASE_URL` signs everyone in as "Dev Preview".
Chat needs `OPENAI_API_KEY` in `.dev.vars`, and the swarm state needs `GITHUB_TOKEN` there too (unauthenticated
GitHub requests hit the rate limit fast); `gh auth token` gives you one.

## Build

```bash
bun run desktop:build
```

Installers land in `desktop/src-tauri/target/release/bundle/` (`.app`/`.dmg`, `.msi`/`.exe`, `.deb`/`.AppImage`).

## Releasing

The landing page's **Download for Mac** links to `releases/latest/download/Formal-Mind-mac.dmg`, and the app checks
`releases/latest/download/latest.json` for updates (on launch and every 6 hours; it offers to install and restart).
Updates must be signed with the key whose public half is in `tauri.conf.json`. The private key is
`~/.tauri/formalmind.key` on the maintainer's Mac, not in the repo: back it up, or no future update can install.

Releases run on the maintainer's Mac so no key goes to CI: `scripts/release.sh`, run by the pre-push hook
(`.githooks/pre-push`, turned on by `bun install` through `core.hooksPath`) whenever you push to main. The push
goes through only if the release does. Skip it once with `SKIP_RELEASE=1 git push` or `git push --no-verify`;
run it by hand with `bun run release` (or `release web` / `release desktop`).

It needs: `wrangler login`, the `formalmind` notarytool keychain profile, the Developer ID certificate in your
keychain, `~/.tauri/formalmind.key`, and `gh auth login`. It ships what is committed (a dirty tree is refused).

1. The website always deploys (`bun run deploy:cf`).
2. The app ships only when `desktop-v<version>` isn't released yet, so bump `version` in `src-tauri/tauri.conf.json`
   and `src-tauri/Cargo.toml` to ship it. Then it builds (signed with `signingIdentity`), notarizes the .dmg,
   staples the .dmg and the .app, re-makes `Formal-Mind-mac.app.tar.gz` from the stapled app, signs it with
   `tauri signer sign`, writes `latest.json` (`platforms.darwin-aarch64`) and runs
   `gh release create desktop-vX.Y.Z` with `Formal-Mind-mac.dmg`, `Formal-Mind-mac.app.tar.gz` and `latest.json`.
   Those names are what the landing page and the updater fetch; don't change them.

The .dmg opens on a white window with the app, an arrow and Applications (`src-tauri/dmg-background.tiff`).

## Sign-in

1. **Sign in with GitHub** opens the system browser at `<api>/api/desktop/authorize`.
2. That page signs you in as on the website if you aren't already, then mints a one-time code (KV, 60 s) and opens
   `formalmind://auth?code=…`. Only the code is in the URL, never a token. The page also shows the code to paste
   in case the link doesn't open the app.
3. The app POSTs the code to `/api/desktop/token`, which deletes it and returns a desktop session token (`fmd_…`),
   a session of its own in KV, so signing out of the website doesn't sign out the app and the other way round.
4. The token goes in the OS keychain (service `team.formal.desktop`) and is sent as `Authorization: Bearer`.
   The Worker allows the app's webview origins through CORS; no cookies are involved. Signing out deletes it from
   both the keychain and KV.

The app also opens the browser with a random `poll` id and asks `/api/desktop/token` with it every 2 s (202 until
the browser side finishes, then the token once). So sign-in completes even where the `formalmind://` link doesn't
open the app, such as `tauri dev` on macOS, which only registers the link for an installed app. Pasting the code
still works as a last resort.

## Local swarm

A folder's page runs a swarm on this computer: **Start the swarm**, optionally with a focus and a spending cap.
`src-tauri/src/swarm.rs` works continuously until the spending cap is reached or you press Stop (raise the cap from the chat header to keep it going):

Everything about the Solidity comes from formal-ast (`src-tauri/src/swarm_ctx.rs`), never from listing or grepping
files: `script_entries` gives the scope (the contracts the Foundry scripts under `script/` deploy or call, their bases
and what they deploy), `audit_json` units are the functions, and `all_slices` is what an agent reads about one.

1. **Plan.** The swarm writes `.formal/plan.md` itself, without a model: one item per unit of the in-scope contracts,
   as the Proofs page lists them (the scripts' calls first, then the ones that write storage, then views). Each line
   names the generated def, e.g. `` - [ ] `Router.matchBook` — Router (src/Router.sol:228): nonpayable · writes [] ``;
   functions the Proofs page already shows as proved come checked, opaque ones are left out. Every start adds the
   functions the plan doesn't list yet.
2. **Prover** takes the next `- [ ]` item with a brief from the AST: the def, the generated model it lives in
   (`formal/Generated/<Contract>.lean`, generated by formal-ast when the Lake project has none), and the unit's slice.
   Its tools are `functions` and `function` (the AST's list and slices), `read_file` (Lean and test files), `search`
   (the Lean project only), `write_file`, `run` (lake/forge) and `report_bug`. It writes
   `formal/Refinement/Swarm/<Contract><Fn>.lean`, with theorems naming the def fully qualified, and checks it with
   `lake build` (lake runs in the folder's Lake project, the folder or `formal/`). When it checks, the prover calls
   `record_property` with the notes Formal Mind's report shows for it: what the proof establishes (third person,
   what holds), its assumptions and the theorems' names.
3. **The swarm's check** before review: no `sorry`/`admit`/`axiom`/`native_decide`, `lake build` passes, and the
   Proofs page's coverage now counts the def as proved. A failure goes back to the prover with the output (three
   tries, then `- [!]`).
4. **Reviewer** gets the same brief and the prover's notes, and checks both against the Solidity: approve marks the
   item `- [x]`, records the files in `.formal/proofs.json`, and writes the notes (with any corrections it gives in
   the verdict) into `audit/formal-mind.audit.json` as the property `P-<item>`; changes sends it back to the prover.
5. **report_bug** (prover, assistant) needs a Foundry PoC under `test/` (by convention `test/formal/`). The swarm runs
   it with `forge test --match-path`, adds the finding to `audit/formal-mind-swarm.md` and a row
   `| FM-NN | Severity | Finding | ⏳ Open | PoC … |` under that report in the audit index (`audit/README.md`), and the
   finding (with its impact and recommendation) to `audit/formal-mind.audit.json`, so Bugs lists it; the item is
   marked `- [!]` and the swarm moves on.
6. **Messages** you send while it runs are answered by the assistant before the next turn and can change the plan.

**Picking back up.** Each folder has one continuous session. The work is a durable queue in `.formal/queue.json`
(plan, prove item N, review item N, answer you): a job is marked running before its agent starts and done when it
ends, and every step of the agent's conversation is saved to `.formal/jobs/<job>.json`. Quit any time; on the next
start an interrupted job continues the same conversation (prompt caching keeps that cheap), your unanswered messages
are still queued, and finished work is never redone. Spend is the session's running total; the cap in the chat header
can be raised to keep going.

**Nothing goes through GitHub.** The swarm's state is the folder's: plan and progress in `.formal/`, proofs in
`formal/`, findings in `audit/` with PoC tests under `test/`. It opens no issues or PRs, sets no labels, comments
nowhere and pushes nothing; its tools can't run git. Activity shows in the app (the Swarm canvas, the plan card, the
Proofs and Bugs pages), and the canvas links nowhere outside it.

**Who pays for the model.** Files, `lake` and `forge` run here; only the model calls leave, by exactly one route,
picked in Settings → Models (`fm:provider`): **formal.team credits** (`/api/desktop/model-session` mints a
session per agent turn with the desktop sign-in, charged as `local/<folder>` with the agent and item), **your own
Anthropic key** from the keychain (`team.formal.desktop` / `anthropic`), straight to `api.anthropic.com`, or
**Claude Code on your Claude plan** (`claude-code`). Every event is logged to `.formal/runs/<run>.jsonl`.

**On Claude Code** (`src-tauri/src/claude_code.rs`), each agent turn is one `claude -p` in the folder, with the
`claude` you installed and signed in to yourself (Max or Pro; Settings shows what `claude auth status` reports, and
Start refuses until it is signed in). The app never sees or stores the sign-in, and it unsets `ANTHROPIC_API_KEY` for
the run so the plan pays, not a stray key. The role keeps everything it has on the API: its system prompt replaces
Claude Code's (`--system-prompt`), Claude Code's own tools are off (`--tools ""`), and the role's tools are served by
the swarm over MCP on 127.0.0.1 with a per-turn token (`Bridge`), answered by the same code as on the API, so the
plan, the check, review, `report_bug` and the files a prover writes work the same. Nothing from your Claude Code setup
or the project reaches the agent (`--setting-sources ""`: no settings, hooks, CLAUDE.md, skills or other MCP
servers). The task goes in as a stream-json message, so an audit report's PDF is still a document. Each job has its
own Claude session id, kept in `~/.formalmind/claude-code/<project>-<hash>/<run>/` with the raw stream and stderr, so a
quit mid-job resumes the conversation (`--resume`). Nothing is added to the session's spend; your plan's usage limits
apply instead, and hitting one pauses the swarm with the job still running (Start again after the reset).
Anthropic allows this because the person signs in to the unmodified Claude Code binary with their own plan. The app
must never offer a Claude login itself, handle Claude credentials, or route one person's plan for someone else
(code.claude.com/docs/en/legal-and-compliance). Plan limits assume ordinary, individual use, so a swarm left running
for a long time will hit them.

The Swarm canvas follows the events: the working agent sits on its item saying what it's doing, the Swarm notebook
lists the current turn's steps, the ledger has a line per turn, and the Proofs page and Bugs read again when an item is proven
or a finding filed. In dev builds `FM_SWARM_AUTOSTART=<added folder>` starts that folder's swarm at launch (with
`FM_SWARM_BUDGET`, `FM_SWARM_PROVIDER=anthropic`, `FM_SWARM_MODEL`, `FM_SWARM_GOAL`, `FM_SWARM_SESSION`), for driving a run without clicking.


## The phone

Signed in, the app relays its swarm through formal.team so Formal Mind for iPhone (`mobile/`) can follow and steer it
(`src/relay.ts`; Settings → Phone turns it off). Every `swarm` event is posted to `/api/relay/mac` as it happens,
with the added folders and their sessions; the app long-polls the same route for commands from the phone (a message,
Start, Stop, a session's history) and runs them as if typed here. The relay is one Durable Object per person
(`worker/relay-do.ts`, `lib/relay.ts`) holding the recent events and the commands waiting for the Mac (dropped after
10 minutes). Nothing runs there: the swarm, the files and the tools stay on this Mac. A message sent with `swarm_say`
is a `you` event in the session and its log, so the chat shows it wherever it was sent from.

## Formal Mind's report

Bugs → **Generate report** costs $150 from formal.team credits, once per repository and commit: the app first asks
(`report_quote`, showing the balance before and after), and `report_generate` takes the charge
(`/api/desktop/report`, ref `report:<repo>@<commit>`) before building. Generating again for a commit already paid for is
free. It (`src-tauri/src/report.rs`) writes Formal Mind's assessment of the folder
as `<audit folder>/formal-mind.audit.json` in the standard format (`formalmind.audit/v1`, docs/audit-format.md, with
`kind: "internal"`): the swarm's findings (its `formal-mind-swarm.md` rows in the index, and `.formal/bugs/`) with
locations, PoC, evidence and the fix (the commit that added the covering test, and the PR its message names), the
Proofs coverage of each contract the scripts deploy or call, and the properties the reviewer approved
(`.formal/proofs.json`) with the theorems that prove them. The swarm writes its findings and approved properties into that file as it works, in the
report's words; Generate report keeps what is there (the swarm's text and any hand edits), takes each finding's
status, evidence and fix from the index, adds the coverage, and derives only what's missing (from older runs'
`.formal/proofs.json` and index rows). Other audit reports are not part of it; Bugs lists Formal Mind's report and findings apart from them.

The JSON is rendered in Formal Mind's own style (learned from Spearbit and Certora: a black cover with the logo, a
project scope table linking the repository and commit, colour-coded findings summary and severity matrix, a strip
per finding, Context links at the audited commit, the fix's PR, and a Formal Verification chapter with assumptions, a
notation legend, coverage and properties) to `.formal/report/formal-mind.adoc` with the theme and logos from
`report-template/`, and to `<audit folder>/formal-mind.pdf` when asciidoctor-pdf is installed
(`brew install asciidoctor`; Solidity highlighting uses Pygments, which needs python3). Without it, the JSON is still
written and Bugs says how to install it. Try it with
`FM_FOLDER=… cargo test -- --ignored report_of_a_folder --nocapture`.


## Platforms

- **macOS**: one universal app (Apple Silicon and Intel), built and notarized by `scripts/release.sh` on a Mac.
  `scripts/fetch-nvim.sh` merges Neovim's arm64 and x86_64 builds with `lipo` and signs them.
- **Windows**: built on GitHub Actions (`.github/workflows/desktop-windows.yml`) from the release's tag once the Mac
  release is published, or by hand with *Run workflow* and a tag. It needs the repository secret
  `TAURI_SIGNING_PRIVATE_KEY` (the update key) for in-app updates. The installer isn't code-signed yet, so SmartScreen
  warns on first run; signing it (e.g. Azure Trusted Signing, configured with `bundle.windows.signCommand`) is still
  to do. Tools are found where their installers put them (`src-tauri/src/platform.rs`: `~/.elan/bin`, `~/.foundry/bin`,
  `~/.cargo/bin`, Scoop, Chocolatey); logs go to `~/.formalmind/logs`; the Code tab's terminal uses ConPTY.
