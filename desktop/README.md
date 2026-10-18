# Formal Mind desktop

A [Tauri 2](https://tauri.app) app: a native window over the same React components as the website (imported through
the `@/` alias, nothing copied), plus what only a native app can do. Runs on macOS, Windows and Linux.

- `src/`: the webview entry. `app.tsx` is the signed-in shell (sidebar, swarm canvas, Usage) and the sign-in screen;
  `api.ts` points the shared components' `fetch("/api/…")` at the API with the desktop token.
- `src-tauri/`: the Rust side. Keychain storage for the token, the `formalmind://` deep link, opening the browser.

## Develop

Needs Rust (`rustup`) and, on Linux, the [Tauri system packages](https://tauri.app/start/prerequisites/).

```bash
bun install
bun run desktop:dev
```

That starts Vite on :1420 and opens the app. It talks to https://formal.team by default. For a local Worker, run
`bun run dev:api` (port 8787) and either start the app with `VITE_FORMALMIND_API=http://localhost:8787` or set
**Server** on the sign-in screen. A local Worker without `APP_BASE_URL` signs everyone in as "Dev Preview".

## Build

```bash
bun run desktop:build
```

Installers land in `desktop/src-tauri/target/release/bundle/` (`.app`/`.dmg`, `.msi`/`.exe`, `.deb`/`.AppImage`).
Signing and notarizing aren't set up yet.

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

In `tauri dev` on macOS the `formalmind://` link isn't registered (macOS only registers it for an installed app), so
paste the code shown in the browser. Windows and Linux register it in dev too.

## Next: the local executor

Running agent turns on this machine (the "local executor" in `docs/protocol.md`) belongs in `src-tauri/src/`, as a
module started from `setup` in `lib.rs`: it claims turns from the project's Durable Object with the same bearer
token, runs Lean locally, renews and reports. Code never leaves the machine.
