# Proof workspace

Open a local folder and select a Solidity or Lean file in **Code**. **Proof tools** in the
file toolbar toggles the integration. Solidity files show a Lean mappings sidebar; select a function and theorem, then click
the theorem’s file location to open the Lean file with its editor and live goals. Source links return to Solidity in the same Code screen, and declaration links
highlight the recorded line. Lean files open directly with the proof editor when proof tools
are enabled. Vim remains available by switching off proof tools.

The standalone **Proofs → Proof workspace** is also available.
The workspace starts `lake serve` in the nearest ancestor containing a `lakefile.toml`
or `lakefile.lean`, within the added folder. It respects that project's `lean-toolchain`.
Install elan and the pinned toolchain and build the project's imports first.

The editor sends unsaved changes to Lean, with monotonically increasing document versions.
The right pane shows goals at the cursor (or an expected term type), and diagnostics that
match the current buffer version. Clicking a diagnostic moves the cursor to its position.
The declaration menu navigates to symbols reported by Lean.

**Save** or Cmd/Ctrl-S writes the buffer. The save fails if another editor changed the file
on disk since it was opened. **Reload** reads the disk again; when a draft exists its label
explicitly says **Discard draft and reload**. Drafts survive tab/file switches using session
storage, with an in-memory fallback. They are not a substitute for saving files before quitting.
**Restart Lean** restarts the project's server and reopens the current draft.

This feature has no dependency on swarm jobs, model providers, budgets or agent tools.
Solidity coverage and the SolidCore execution experiment remain separate views. Server
notifications and process errors are handled locally, and servers are stopped on app exit.

## Existing Solidity-to-Lean mapping

The Code sidebar consumes `ast_formal`, the same `formal_json` output used by Lean coverage.
It preserves function `file`, `line`, `endLine`, `lean` and `theorems` indices and opens the
referenced theorem’s exact `file` and `line`. No separate manifest is required. Relevant code
shows all mapped functions referencing the selected theorem index, including cross-file
locations. The existing mapping uses definition-name references; it is not a checked
refinement certificate or a complete dependency slice. Refresh rebuilds the mapping.

Mapping builds, failures, and Lean checking use the existing muted frames, rounded-xl
`bg-card` surfaces, and compact monospace labels used by coverage and report cards.

## Optional supplemental source annotations

An optional `.formal/proof-specs.json` in the added folder declares the mapping explicitly:

```json
{
  "schema": 1,
  "specs": [
    {
      "id": "executor-permission",
      "signature": "AsyncSwap.setExecutor(bytes32,address,bool)",
      "title": "Successful calls update the selected permission",
      "solidity": { "path": "src/AsyncSwap.sol", "line": 526 },
      "lean": { "path": "formal/Refinement/AsyncSwap.lean", "line": 1 },
      "assumptions": ["Record the actual theorem assumptions here"]
    }
  ]
}
```

Paths are relative to the added folder and must resolve inside it. Lines are one-based;
use the actual locations in your checkout. This manifest is navigation and descriptive
metadata, not a checked certificate. The UI does not infer correspondence from similar names.
Selecting a specification opens its Lean location; its source link opens the Solidity file.

## What the status means

**No Lean diagnostics** means the current buffer has no messages from Lean and checking
has finished. It does not establish that a Solidity function meets the specification or
that the theorem is free of additional axioms. There is no verified-Solidity badge here.
Live goals are inspected with Lean's `$/lean/plainGoal` and `$/lean/plainTermGoal` requests.
The implementation uses plain goals, not the richer widget/Infoview RPC protocol yet.

Automatic Solidity regeneration, source-to-generated-Lean range maps, dependency invalidation,
and certificates tied to Solidity/semantics hashes remain separate proof-pipeline work.

## Local demonstration and checks

Add `desktop/test-fixtures/lean-proofs` as a local folder to try the editor without Mathlib
or Solidity dependencies. `Permissions.lean` proves properties of an abstract permission
function; it is explicitly not a Solidity refinement proof. Put the cursor before `simp`
to inspect its goal. In an unsaved draft, replace `simp [setExecutor]` with `skip` to see an
unsolved-goal diagnostic, then restore it to see diagnostics clear.

```sh
bun test desktop/src/proof-workspace.test.ts
cargo test --manifest-path desktop/src-tauri/Cargo.toml lean_lsp::tests
cargo test --manifest-path desktop/src-tauri/Cargo.toml \
  lean_lsp::tests::live_lean_goals_diagnostics_and_version_invalidation -- --ignored --nocapture
```

The live test requires the installed Lean 4.28 toolchain. It exercises the real server:
open a proof with an unsolved goal, inspect the goal, change the buffer, reject a stale
diagnostic, wait for fresh diagnostics to clear, and retrieve theorem symbols.

## Show code relevant to this specification

Select a specification and choose **Show code relevant to this specification**. The panel
shows saved Solidity excerpts with line numbers, a reason for each link, and a source-file
navigation button. **Refresh source** reloads the manifest and excerpts from disk.

Each specification can include `relevantCode`, an array of explicit source ranges:

```json
"relevantCode": [
  {
    "path": "src/Permissions.sol",
    "startLine": 6,
    "endLine": 6,
    "reason": "State indexed by maker and executor",
    "expectedText": "    mapping(address => mapping(address => bool)) public permissions;"
  }
]
```

Ranges are inclusive and one-based. `expectedText` is the exact excerpt joined with LF
newlines, without a trailing newline. Changed text or missing lines produce **Source link
needs review**. Matching text means only that the recorded excerpt still matches; changes
elsewhere can still affect its meaning. Review the location, reason, and dependencies before
updating the manifest. Paths cannot escape the added folder, including through symlinks.

These are curated source links, not a sound program slice or a proof of complete dependencies.
The app does not yet infer transitive calls, control dependencies, storage aliases, or external
call effects. The bundled `lean-proofs` fixture includes a demonstrative Solidity file and
manifest so this view can be tried alongside the abstract Lean theorem without any swarm.

## Validation (2026-10-22)

TypeScript checking, web and desktop production builds, the native debug app bundle,
two cursor-position tests, and six Rust tests (including the real Lean server) pass.
The Rust suite covers source changes/missing ranges/path escape and document versions
across close/reopen. Native inspection confirmed the demo folder loads and Permissions.lean
opens inside Code with the specification controls and no Lean diagnostics. Full native
source-link interaction remains partially unverified because the macOS capture service
intermittently returns SCStreamErrorDomain -3812.

Native mapping verification: the existing `ast_formal` pipeline linked the demo setter to
`Permissions.lean:10`; relevant code displayed `Permissions.sol:8–10` through `FileView`,
and the theorem link opened Code at Lean line 10. The build and failure cards were both
observed. The local Async Swap checkout could not build its mapping because an OpenZeppelin
import under dependencies/v4-core was missing.

## Lean editor highlighting

The editable proof buffer uses the same lazy-loaded Shiki Lean grammar and GitHub light/dark
colors as `FileView`. A non-interactive highlighted layer follows the textarea's scroll
position; the textarea remains the accessible editor and source of UTF-16 cursor positions,
selection, copying, drafts, and saves. Highlighting does not change the text sent to Lean.
Goal requests refresh when checking completes, including after a long import build.

## Restoring the actual contract checkout

The local Async Swap v2 checkout was missing its pinned Git submodules. Restoring them with
`git submodule update --init --recursive` supplies OpenZeppelin through
`dependencies/v4-core/lib/openzeppelin-contracts`, as the existing remapping requires.
OpenZeppelin is pinned at `dbb6104ce834628e473d2173bbc9d47f81a9eec3`; no dependency revision
or remapping was changed. Contract compilation with `forge build --skip test --skip script`
passes. The checkout remains clean.

Actual `ast_formal` results were exercised for AsyncSwap, Router, and FeeVault. In the native
Code view, AsyncSwap has 36 own functions and the project exposes 531 theorem records.
`setExecutor` links Solidity lines 526–529 to nine theorem references, starting with
`formal/Refinement/AsyncSwap.lean:57`. Relevant source display and navigation to that Lean
line were verified. Router has five own functions with theorem references; FeeVault has
none in this mapping. These counts describe references, not independent proof certificates.

Final actual-project verification: `lake build Refinement.AsyncSwap Refinement.Router`
completed successfully (3155 jobs, with existing warnings). The native editor reached
**No Lean diagnostics** on `formal/Refinement/AsyncSwap.lean`. At line 60, column 3 it
returned the live `setExecutor_run` goal:

```lean
⊢ AsyncSwap.setExecutor ext poolId executor allow env w =
    Except.ok ((), setExecutorWorld ext w poolId env.sender executor allow)
```

A separate `lake serve` protocol check returned the same goal. No contract or proof source
was modified in the actual Async Swap checkout. The five frontend tests (highlighting,
UTF-16 cursor handling, and exact mapping indices), TypeScript, and desktop/web builds pass.
