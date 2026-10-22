# Notes for agents working on this repo

Formal Mind: a website (Vite + React, `src/`, `components/`) with a Hono API on a Cloudflare Worker (`worker/`,
routes in `server/routes/`), and a Tauri 2 Mac app in `desktop/` that reuses the same components through `@/`.
Check `bunx tsc --noEmit -p .` and `bun run build` before committing.

UI follows [DESIGN.md](DESIGN.md): tokens, type scale, layout patterns, the Mac app's title bar and shortcuts, copy.

`crates/formal-ast` (solc's AST → graph, units, Lean coverage) runs natively in the Mac app and as wasm on the website's
Proofs tab (`crates/formal-ast-wasm`, with solc-js in a Web Worker: `lib/ast/`). The wasm build is committed in
`lib/formal-ast-wasm`: after changing either crate, run `bun run build:ast-wasm` and commit what it writes.

## Pushing to main ships

`.githooks/pre-push` runs `scripts/release.sh` on every push to `main` (`bun install` turns the hook on). It:

1. deploys formal.team (`bun run deploy:cf`), and
2. if `desktop-v<version>` isn't on GitHub Releases yet, builds the Mac app, notarizes it, and publishes it.

The push only goes through if the release succeeds.

- **Not asked to ship?** Push with `SKIP_RELEASE=1 git push`. Deploy and publish only when the user asks.
- **Shipping the Mac app:** bump `version` in both `desktop/src-tauri/tauri.conf.json` and
  `desktop/src-tauri/Cargo.toml` (the script refuses if they differ). The same version is never re-released.
- **Ship by hand:** `bun run release` (both), `bun run release web`, or `bun run release desktop`.
- The script ships what is committed: it stops if the tree is dirty, and the pushed commit must be checked out.

## Mac app releases

- Signing: "Developer ID Application: Asyncswap Labs, Inc. (WA3Q5YSLK6)" in the keychain. Notarization: the
  `formalmind` notarytool keychain profile. Update signing: `~/.tauri/formalmind.key`. None of these are in the repo.
  Never ask for, print, or copy their values.
- Don't export `TAURI_SIGNING_PRIVATE_KEY` in your shell. `tauri signer sign -f` refuses to run when it is set. The
  release script clears it, but your own commands won't.
- If the build fails with `hdiutil: couldn't unmount … Resource busy`, a Formal Mind disk image is still mounted:
  `diskutil eject force "/Volumes/Formal Mind"`, then retry.
- The Mac app is one universal build (Apple Silicon and Intel: `--target universal-apple-darwin`; the bundled Neovim is
  made universal by `desktop/scripts/fetch-nvim.sh`). The Windows installer is built by
  `.github/workflows/desktop-windows.yml` when a `desktop-v*` release is published, attached as
  `Formal-Mind-windows-setup.exe`, and added to that release's `latest.json` as `windows-x86_64` (it needs the
  `TAURI_SIGNING_PRIVATE_KEY` repo secret; without it the installer ships without updates).
- Release assets must keep these names: `Formal-Mind-mac.dmg` (the landing page's Download for Mac link),
  `Formal-Mind-windows-setup.exe` (Download for Windows), `Formal-Mind-mac.app.tar.gz` and `latest.json` (the in-app
  updater). The `signature` in `latest.json` must be the
  `.sig` of that exact tar. An empty or mismatched signature makes every installed app refuse the update.
- Installed apps check for updates on launch and every 6 hours. A new version lands in the notification bell with
  an Update button (`desktop/src/update.tsx`).

More on the desktop app (sign-in, local folders, the local swarm): `desktop/README.md`.
