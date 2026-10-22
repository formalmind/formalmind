# Solidity edit experiment

The desktop Proofs page includes **Proofs across Solidity edits → Experiment**.
It runs this script on a bundled reduced fixture, in a fresh application cache directory.
It does not edit the open project or contribute to its proof coverage.
Agent onboarding can be deferred with **Set up agents later**; this experiment needs no
model provider or swarm run.

## Run

Requires Python 3, Foundry, solc 0.8.35, and a clean SolidCore checkout at
`16843fdd947b750d9690521d42eefb8be31dbe21` with its pinned Lean dependencies built:

```sh
lake build SolidCore.Solidity.Checked SolidCore.Solidity.ABI
```

From this repository:

```sh
python3 spikes/solidcore-setexecutor/run.py \
  --solidcore /path/to/solidity-lean \
  --solc /path/to/solc-0.8.35 \
  --output /path/to/new-evidence-directory
python3 -m unittest discover -s spikes/solidcore-setexecutor
```

The desktop embeds the runner and fixture at compile time. No repository-relative runtime
paths are needed. Python, Lake, Foundry and the built SolidCore checkout remain external
prerequisites. Each subprocess is bounded by a timeout; concurrent desktop runs are rejected.
Reports are written atomically after each variant, with source hashes, the unchanged assertion
hash, compiler version, SolidCore revision, timings, exit codes and full diagnostics.

## What the experiment checks

Each variant is imported from solc's AST. SolidCore and Foundry execute three calls from empty
storage, with pool 1, sender 11, and `(executor, allow)` equal to `(22, true)`, `(22, false)` and
`(0, true)`. The comparison covers the target storage word, event topics/data and exact revert
bytes. It does not compare all storage slots, gas, deployment behavior or arbitrary initial states.

The variants are the original, event moved before the write, a zero-address guard, and an
intentionally incorrect permission inversion. The negative control must differ from the
permission specification even though both execution engines agree about its behavior.

The reduced fixture preserves slot 2 for `asyncOrders` and offset 4 for `isExecutor`. This
layout was checked against `forge inspect src/AsyncSwap.sol:AsyncSwap storageLayout` on
2026-10-22. Other contract functions and the mapped `OrderInfo` contents are omitted.

## Measured result, 2026-10-22

See `measured-results.json` for reproducible inputs, outputs and timings.

| Variant | SolidCore/EVM comparisons | Permission examples | Lean assertion |
| --- | --- | --- | --- |
| Original | 3/3 match | Match | Not proved |
| Event moved | 3/3 match | Match | Not proved |
| Zero-address guard | 3/3 match | Match, with zero-address revert | Not proved |
| Permission inverted | 3/3 match | Mismatch detected | Not proved |

All four imports succeeded. Warm interpreter runs took roughly 5–6 seconds; the first run took
12 seconds. These timings include Lean startup/elaboration and three concrete evaluations.
They are not timings of symbolic proof automation.

The native macOS development app was also checked through its UI on 2026-10-22:
open Proofs, expand the experiment, enter the two tool paths, and run. All four rows
completed through the Tauri command, all twelve execution comparisons matched, the
negative control displayed **Change detected**, and failed Lean diagnostics could be expanded.
The run button became available again after completion. The selected project's missing
dependencies did not block the independent experiment. Native UI verification covers this
experiment, not the still-unimplemented proof-preservation capability.

The identical concrete assertion `permission_example` fails with `decide`: the decidable
instance does not reduce to `isTrue` or `isFalse`. A separate `decide +kernel` attempt also
failed; unrestricted `#reduce` exhausted Lean's stack. No `native_decide`, `sorry` or axiom
was introduced to make this pass. Lean's diagnostic includes `sorryAx` for its failed theorem;
that file is rejected and never counted as a proof.

**This does not demonstrate proof preservation yet, and does not decide option A versus B.**
The assertion is only one concrete permission example, not the universal refinement theorem
from the design. The next work is reusable storage/interpreter lemmas and a WP instance,
followed by a universal `setExecutor` spec whose identical proof rechecks after the edits.
The toolchain upgrade, full-contract import coverage, shallow-model simulation theorem,
assembly semantics and swarm migration remain unimplemented.
