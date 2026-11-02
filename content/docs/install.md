# Install the app

Formal Mind runs as a desktop app on macOS and Windows. The swarm, your files and the tools all stay on your computer.

## Download

- **Mac:** [Formal-Mind-mac.dmg](https://github.com/formalmind/releases/releases/latest/download/Formal-Mind-mac.dmg).
  One build for Apple Silicon and Intel, signed and notarized. Open the disk image and drag Formal Mind to
  Applications.
- **Windows:** [Formal-Mind-windows-setup.exe](https://github.com/formalmind/releases/releases/latest/download/Formal-Mind-windows-setup.exe).
  The installer isn't code-signed yet, so Windows SmartScreen asks before the first run.

Every version is on the [releases page](https://github.com/formalmind/releases/releases).

## What else you need

The agents run the same tools you would. Install them once:

| Tool | Why | Install |
|---|---|---|
| [Foundry](https://getfoundry.sh) | `forge build` and `forge test` for PoCs and coverage; it also installs the solc versions your project uses | `curl -L https://foundry.paradigm.xyz \| bash`, then `foundryup` |
| [elan](https://github.com/leanprover/elan) | Lean and Lake, for the proofs | `curl https://elan.lean-lang.org/elan-init.sh -sSf \| sh` |
| [Claude Code](https://code.claude.com) | Runs the agents on your Claude plan (the default) | `npm install -g @anthropic-ai/claude-code`, then `claude` to sign in |
| [Codex](https://developers.openai.com/codex) | Optional: runs the agents on your ChatGPT plan instead | `npm install -g @openai/codex`, then `codex login` |

## Project requirements

- A Foundry project, added through **On this computer** in the sidebar. The app reads only folders you add.
- `forge build` run once in it. Formal Mind takes solc from Foundry's install location.
- A deploy script under `script/`. Scope is the contracts those scripts deploy or call, plus their base contracts. With
  no script, nothing is in scope.

Lean setup is generated on the first prover turn: the Lake project in `formal/`, models in `formal/Specs/`.

## Sign in

Open the app and choose **Sign in with GitHub**. Your browser opens formal.team, you sign in there, and the browser
sends you back to the app. If the link doesn't open the app, the page shows a code to paste instead. Your session is
kept in the system keychain.

## Updates

The app checks for a new version when it starts and every 6 hours. When there is one, the bell in the title bar
shows it with an **Update** button, which installs it and restarts the app.
