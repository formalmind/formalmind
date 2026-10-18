# Formal Mind desktop

A [Tauri 2](https://tauri.app) app: a native window over the same React components as the website (imported through
the `@/` alias, nothing copied), plus what only a native app can do. Runs on macOS, Windows and Linux.

- `src/`: the webview entry. `app.tsx` is the signed-in shell (sidebar, swarm canvas, Usage) and the sign-in screen;
  `api.ts` points the shared components' `fetch("/api/…")` at the API with the desktop token.
- `src-tauri/`: the Rust side. Keychain storage for the token, the `formalmind://` deep link, opening the browser.

## Local folders

**On this computer** in the sidebar adds folders from disk (native picker). The list lives in
`~/.formalmind/config.json`, the app's home for local settings. A folder's page lists its Solidity and Lean files
(skipping `.git`, `node_modules`, `lib`, `out`, `cache`, `target`, `.lake`, `dist`). Only folders you added can be
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
Signing and notarizing aren't set up yet.

## Releasing

The landing page's **Download for Mac** links to `releases/latest/download/Formal-Mind-mac.dmg`, and the app checks
`releases/latest/download/latest.json` for updates (on launch and every 6 hours; it offers to install and restart).
Updates must be signed with the key whose public half is in `tauri.conf.json`. The private key is
`~/.tauri/formalmind.key` on the maintainer's Mac, not in the repo: back it up, or no future update can install.

1. Bump `version` in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. `TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/formalmind.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" bun run desktop:build`
3. Rename the .dmg to `Formal-Mind-mac.dmg` and `Formal Mind.app.tar.gz` to `Formal-Mind-mac.app.tar.gz`, and write
   `latest.json` (version, notes, pub_date, and under `platforms.darwin-aarch64` the `.sig` file's text and the
   tar.gz's download URL).
4. `gh release create desktop-vX.Y.Z Formal-Mind-mac.dmg Formal-Mind-mac.app.tar.gz latest.json`

The .dmg opens on a white window with the app, an arrow and Applications (`src-tauri/dmg-background.png`).

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

## Local executor

A folder's page has **Run a turn here**: pick Prover or Reviewer, say what to prove or review, and the agent works
on the folder on this computer (`src-tauri/src/executor.rs`):

- The model is called directly with your own OpenAI key, saved in the OS keychain (`team.formal.desktop` / `openai`).
  formal.team never sees the key or the code.
- Tools: `list_files`, `read_file`, `write_file` (Prover only), and `run`, which allows only `lake build`,
  `lake env lean <file>`, `forge build` and `forge test`, with no shell. Every path must stay inside the folder,
  symlinks included. `lake`/`forge` are found in `~/.elan/bin` and `~/.foundry/bin` too.
- A turn stops when the agent finishes, at 60 steps, at 400k tokens, or on **Stop**. Progress streams to the page.
- Try it without the UI: `FM_OPENAI_KEY=… FM_FOLDER=… FM_TASK=… cargo test -- --ignored live_turn --nocapture`
  in `src-tauri/`.

Not yet: turns are local only. The protocol's claim, renew and report (`docs/protocol.md` section 5) wrap
`run_turn`: claim a Grant from the project's Durable Object with the desktop token instead of taking the task from
the page, renew the lease while the loop runs, and report the outcome and cost. That needs the claim/report routes
on the Worker first. Costs show as tokens until there's a price table.
