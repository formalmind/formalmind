# Formal Mind for iPhone

A [Tauri 2](https://tauri.app) iOS app over the same React components as the website and the Mac app (through the
`@/` alias). iOS can't run the swarm (no processes, no Lean or Foundry), so the phone is a client:

- **Projects.** Home lists your formal.team projects and adds one from a GitHub repository (no local folders).
  A project's **Code**, **Proofs** and **Bugs** read the repository the way the website does: a shallow clone in the
  webview (`lib/browser-git.ts`, through the Worker's git proxy), and Proofs runs formal-ast as wasm with solc-js in a
  Web Worker (`lib/browser-ast.ts`). The views are the Mac app's (`desktop/src/swarm-panel.tsx`), laid out for a phone
  in `src/project.tsx`.
- **The swarm on your Mac.** The Mac app publishes its swarm through formal.team (the relay: `lib/relay.ts`,
  `worker/relay-do.ts`, `desktop/src/relay.ts`). The phone (`src/relay.ts`) follows it with one waiting request at a
  time, shows each folder's sessions and their chat (`src/mac.tsx`), and sends messages, Start and Stop back; the Mac
  runs them as if typed there. Start uses the Mac's own settings (model route, model, the folder's spending cap).
- **Notifications.** A proof done, a bug filed or the budget reached shows in the bell (`lib/notifications.ts`)
  while the app is open. Push (APNs) needs an Apple push key and a sender in the Worker: not done yet.
- **Sign-in** is the Mac app's: Safari opens `/api/desktop/authorize`, the page hands back `formalmind://auth?code=…`
  (registered as the app's URL scheme), and the app also polls for it. The token is kept in the iOS keychain
  (service `team.formal.mobile`) and sent as a bearer token (`desktop/src/api.ts`).

## Develop

Needs Xcode, `xcodegen` and CocoaPods (`brew install xcodegen cocoapods`), and the iOS Rust targets
(`rustup target add aarch64-apple-ios aarch64-apple-ios-sim`).

```bash
cd mobile
bunx tauri ios dev "iPhone 17 Pro"
```

That serves the webview from Vite on :1421 and opens the app in the simulator. It talks to https://formal.team; for a
local Worker run `bun run dev:api` and start with `VITE_FORMALMIND_API=http://localhost:8787` (a local Worker without
`APP_BASE_URL` signs everyone in as "Dev Preview", the Mac app included, so the two share a relay). The relay needs the
`RELAY` Durable Object (wrangler.jsonc, migration `v2`), deployed with the website.

The Xcode project is generated in `src-tauri/gen/apple` (`bunx tauri ios init`) and signed with the team
WA3Q5YSLK6. App Store Connect and TestFlight are not set up; nothing here publishes to them.
