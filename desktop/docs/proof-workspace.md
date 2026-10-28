# Proofs in Code

How an auditor or a Solidity developer reads proofs next to the code. Everything here is in **Code**; the **Proofs**
tab keeps the whole-contract coverage table and, on the Mac, the SolidCore experiment.

## Solidity: the Proofs rail

Open a `.sol` file with **Proofs** on (the toggle beside `vim` in the file bar; on by default, remembered):

- **Line numbers.** Each function's first line number takes its status colour, as in the Proofs tab: green proved,
  sky has `sorry`, violet in Lean but unproved, amber not modeled. Click it to pick the function.
- **The rail.** The file's functions (proved / total, a bar), then the picked function: its status, its Lean model
  (folded), why it isn't modeled if it isn't, and the theorems that name it. **Open** goes to the theorem's line.
  "Also names" lists the other functions the same theorem covers.
- The picked function's lines are tinted in the code.

The rail reads `ast_formal` with the open file as the entry, so it works on the website too (wasm formal-ast, see
`lib/ast/`). A library, interface or types file has no model of its own: the rail says so and points at the Proofs tab.
"Proved" means a finished theorem names the function's Lean definition; Lean checks the theorem, not that the model
matches the bytecode.

## Getting around

Back and Forward (⌘[ and ⌘]) sit at the start of the file bar, with the history beside them: every file, line and
function you opened in Code, newest first, the current one ticked. Going back to a function's line picks it in the rail
again, so a Solidity → theorem → Solidity round trip lands where it started.

## Lean: the editor (Mac app)

Open a `.lean` file with **Proofs** on and Code becomes a Lean editor backed by the project's `lake serve` (the nearest
folder with a `lakefile.toml`/`lakefile.lean`, on its `lean-toolchain`; build the imports once with `lake build`).

- **File bar:** status (Starting Lean · Checking · Checks · N errors), warnings, Unsaved, cursor position;
  **Declarations**, **Save** (⌘S), **Revert**, restart Lean.
- **Editor:** FileView's metrics (24px lines, numbers in the first 3rem). Line numbers turn red or amber where Lean has
  a message; messages are underlined.
- **Infoview** on the right, as in VS Code's Lean extension:
  - **Proves**: the theorem at the cursor and the Solidity functions it names (from the last Solidity file's coverage),
    each a link back to its line.
  - **Goals** at the cursor (hypotheses muted, the `⊢` target in full), or the expected type inside a term.
  - **Messages** for the current buffer version; click one to jump.
  - **Specifications** from `.formal/proof-specs.json`, when the folder has one (below).
- Turning on `vim` hands the file to Neovim and turns the Lean editor off.

Drafts survive switching files (session storage). Save refuses when the file changed on disk since it was opened.

## Optional: `.formal/proof-specs.json`

A hand-written map from specifications to code, for proofs that aren't named after a generated definition:

```json
{
  "schema": 1,
  "specs": [
    {
      "id": "executor-permission",
      "signature": "AsyncSwap.setExecutor(bytes32,address,bool)",
      "title": "Successful calls update the selected permission",
      "solidity": { "path": "src/AsyncSwap.sol", "line": 526 },
      "lean": { "path": "formal/Proofs/AsyncSwap.lean", "line": 57 },
      "assumptions": ["Record the theorem's assumptions here"],
      "relevantCode": [
        { "path": "src/AsyncSwap.sol", "startLine": 527, "endLine": 527, "reason": "The write", "expectedText": "        asyncOrders[poolId].isExecutor[msg.sender][executor] = allow;" }
      ]
    }
  ]
}
```

Paths are relative to the folder and can't leave it. `expectedText` lets the editor flag a range whose code changed
("Source link needs review"). It is navigation, not a certificate: nothing checks that the ranges are complete.

## Proofs tab → Semantics (Mac app, experimental)

**Proofs across Solidity edits** runs `spikes/solidcore-setexecutor/run.py` (embedded in the app): a reduced
`setExecutor` edited four ways (original, event moved, zero-address guard, permission inverted), each imported from
solc's AST into Paradigm's SolidCore, run there and on the EVM (Foundry), and the same Lean assertion rechecked. It needs
Python 3, Lake, Foundry, a built SolidCore checkout at `16843fd` and solc 0.8.35. It never counts toward coverage.

As measured on 2026-10-22 (`spikes/solidcore-setexecutor/measured-results.json`): all imports succeed and all twelve
SolidCore/EVM comparisons match, the inverted permission is caught by the execution check, and the Lean assertion
doesn't check on any version (`decide` can't reduce the interpreter). So proof survival is not shown yet; that needs
the interpreter lemmas and WP layer in `docs/solidity-semantics.md`.

## Checks

```sh
bun test desktop/src/proof-workspace.test.ts desktop/src/proof-mapping.test.ts desktop/src/lean-highlighting.test.tsx
cargo test --manifest-path desktop/src-tauri/Cargo.toml lean_lsp::tests
cargo test --manifest-path desktop/src-tauri/Cargo.toml lean_lsp::tests::live_lean_goals_diagnostics_and_version_invalidation -- --ignored --nocapture
```

The live test needs the Lean 4.28 toolchain. `desktop/test-fixtures/lean-proofs` is a small Lake project (no Mathlib)
to try the editor on: add it as a local folder and open `Permissions.lean`.
