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
   `lake build` (lake runs in the folder's Lake project, the folder or `formal/`).
3. **The swarm's check** before review: no `sorry`/`admit`/`axiom`/`native_decide`, `lake build` passes, and the
   Proofs page's coverage now counts the def as proved. A failure goes back to the prover with the output (three
   tries, then `- [!]`).
4. **Reviewer** gets the same brief and gives a verdict: approve marks the item `- [x]` and records the files in
   `.formal/proofs.json`; changes sends it back to the prover.
5. **report_bug** (prover, assistant) needs a Foundry PoC under `test/` (by convention `test/formal/`). The swarm runs
   it with `forge test --match-path`, adds the finding to `audit/formal-mind-swarm.md` and a row
   `| FM-NN | Severity | Finding | ⏳ Open | PoC … |` under that report in the audit index (`audit/README.md`), so Bugs
   lists it with the other audits; the item is marked `- [!]` and the swarm moves on.
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

**Who pays for the model.** Files, `lake` and `forge` run here; only the model calls leave, by exactly one of two
routes, picked in Settings → Models (`fm:provider`): **formal.team credits** (`/api/desktop/model-session` mints a
session per agent turn with the desktop sign-in, charged as `local/<folder>` with the agent and item), or **your own
Anthropic key** from the keychain (`team.formal.desktop` / `anthropic`), straight to `api.anthropic.com`. Every event
is logged to `.formal/runs/<run>.jsonl`.

The Swarm canvas follows the events: the working agent sits on its item saying what it's doing, the Swarm notebook
lists the current turn's steps, the ledger has a line per turn, and the Proofs page and Bugs read again when an item is proven
or a finding filed. In dev builds `FM_SWARM_AUTOSTART=<added folder>` starts that folder's swarm at launch (with
`FM_SWARM_BUDGET`, `FM_SWARM_PROVIDER=anthropic`, `FM_SWARM_MODEL`, `FM_SWARM_GOAL`), for driving a run without clicking.


## Audit report

Bugs → **Generate report** (`report_generate`, `src-tauri/src/report.rs`) writes the folder's audit report in the layout
of [mmsaki/audit-report-generator](https://github.com/mmsaki/audit-report-generator): `<audit folder>/report/README.adoc`
with intro, methodology, lines-of-code, findings-critical/-high/-med/-low, manual-review (informational), revisions,
glossary and references, each finding a `tag::N[]` block, and that generator's PDF theme (`report-template/`). Nothing is
read from PDFs. The findings come from the audit index (the `| ID | Severity | Finding | Status | Evidence |` tables
under each `## <report>`), each with its report's own Markdown section, the code at its `**Location**` and the
regression tests its evidence names (both `include::`d from the folder at render time), plus `.formal/bugs/`. The
methodology has the Proofs page's coverage (formal-ast's `formal_json` for each contract the scripts deploy or call),
lines of code covers those contracts' files, and the revision is `git rev-parse HEAD`.

With asciidoctor-pdf installed (`brew install asciidoctor`, which brings Ruby, asciidoctor-pdf and Pygments' Ruby
bridge; Solidity highlighting uses python3), the PDF lands at `<audit folder>/formal-mind-report.pdf` and opens in
Bugs. Without it, only the AsciiDoc is written and Bugs says how to install it. Try it on a folder with
`FM_FOLDER=… cargo test -- --ignored report_of_a_folder --nocapture`.
