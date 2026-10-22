# Handoff: phase-0 spike, `AsyncSwap.setExecutor` through SolidCore

You are picking up the phase-0 spike from [`docs/solidity-semantics.md`](solidity-semantics.md) (§7.1).
Read that doc first, at least the Summary, §2 and §3. This file is self-contained enough to start
work.

**Goal:** decide **option A** or **option B** from measurements.

- **Option A:** prove contracts directly against Paradigm's SolidCore interpreter.
- **Option B:** keep our own small typed proof core and check it against SolidCore.

**Deliverable:** a spike report, added as §8 of `docs/solidity-semantics.md`, with timings, what worked,
what didn't, and the A/B decision. Push it to formalmind/formalmind#15 (draft; don't merge). Put the
spike code in `spikes/solidcore-setexecutor/` on the same branch.

## Where things are

| What | Where |
| --- | --- |
| Design doc and this file | `~/developer/asyncswap/formalmind-semantics/docs/`: a git worktree of `~/developer/asyncswap/formalmind` on branch `docs/solidity-semantics` (PR [formalmind/formalmind#15](https://github.com/formalmind/formalmind/pull/15)) |
| SolidCore (paradigmxyz/solidity-lean @ `16843fd`) | `~/developer/asyncswap/references/solidity-lean`. Lean `v4.28.0`, Mathlib, `evmyul` and `evm-interaction` as git deps |
| Solidus, EVMYulLean fork, evm-interaction | `~/developer/asyncswap/references/{solidus,EVMYulLean,evm-interaction}` |
| The contract | asyncswap/contracts `src/AsyncSwap.sol:526`. Any checkout works, e.g. `~/developer/asyncswap/contracts` |
| Today's shallow model and proofs | asyncswap/contracts `formal/Generated/AsyncSwap.lean:1955` (`AsyncSwap.setExecutor`) and `formal/Refinement/AsyncSwap.lean` (`setExecutor_run`, `setExecutor_refines`, `setExecutor_frame`, six invariant corollaries). Lean `v4.35.0` |
| solc 0.8.35 (SolidCore's pinned version; checksum checked against binaries.soliditylang.org) | `~/.solc-bin/solc-0.8.35`. `solc-select install` fails here with HTTP 403, so use this binary via the importer's `--solc` flag |
| Foundry | `~/.foundry/bin/forge` |

**State left behind.** `lake exe cache get && lake build SolidCore.Solidity.Checked SolidCore.Solidity.ABI`
has already succeeded in `references/solidity-lean` (1,093 jobs, 34m40s wall clock with Mathlib from the
cache). Its `.lake` is built for the interpreter, ABI and checked entry points, so step 1 only has to
smoke-test. Logs are in `/tmp/sl-cache.log` and `/tmp/sl-build.log`.

## The function

```solidity
// src/AsyncSwap.sol
mapping(PoolId poolId => AsyncFiller.State) public asyncOrders;   // slot 2 (EIP712's two string fallbacks are slots 0, 1)
...
function setExecutor(PoolId poolId, address executor, bool allow) external {
    asyncOrders[poolId].isExecutor[msg.sender][executor] = allow;
    emit ExecutorSet(poolId, msg.sender, executor, allow);
}
event ExecutorSet(PoolId indexed poolId, address indexed maker, address indexed executor, bool allow);

// src/libraries/AsyncFiller.sol
struct State {
    IPoolManager poolManager;   // +0
    Currency numeraire;         // +1
    address feeVault;           // +2
    mapping(bytes32 orderId => OrderInfo) orders;                         // +3
    mapping(address owner => mapping(address executor => bool)) isExecutor; // +4
}
```

So the written slot is
`keccak(executor ‖ keccak(sender ‖ (keccak(poolId ‖ 2) + 4)))`. `PoolId` is a user-defined value
type over `bytes32`. Verify the slot numbers with `forge inspect AsyncSwap storageLayout` before
relying on them.

## Steps

1. **Build and smoke-test SolidCore** on its pinned 4.28. Run `scripts/fast_inner_gate.sh` or build the
   interpreter modules, and run one existing witness. Record the clean build time.
2. **Reduced contract.** Write `spikes/solidcore-setexecutor/SetExecutor.sol`: one file (no imports,
   which SolidCore excludes) with the same storage prefix so the slots match. Use two `string` state
   variables for slots 0–1, then `asyncOrders` with an inlined `State` struct (interface types become
   `address`), plus `setExecutor` and the event. Import it:
   ```bash
   python3 scripts/solc_ast_to_lean_source.py <path>/SetExecutor.sol --contract SetExecutor --solc ~/.solc-bin/solc-0.8.35
   ```
   See `build_parser()` at the bottom of the script for the other flags. Also run the importer on a
   `forge flatten`ed `AsyncSwap.sol` and save the rejection list: that is phase 1's coverage baseline.
   Expect rejections for inline assembly, at least.
3. **Execute and compare.**
   - `#eval` a `setExecutor(poolId, executor, true)` call through SolidCore's checked entry points, the
     way `SolidCore/Witness/*.lean` do it (`Contract.call…` in `ABI.lean`, run under a scripted
     responder; setExecutor makes no external calls, so the responder needs no rows).
   - Read the final storage word at the slot above and the emitted log.
   - Do the same call in a Foundry test, reading `vm.load` and the recorded logs. They must match
     byte for byte.
   - SolidCore's own harness, `scripts/run_forge_interpreter_harness.py`, can drive this; reuse it if
     it's easy.
4. **Prove the spec** (the actual question). In a Lean package in `spikes/solidcore-setexecutor/` that
   depends on SolidCore by path:
   - **Typed storage lemma.** Reading back the slot after the call gives `allow`, and every other slot
     is unchanged unless it collides. Keep Keccak irreducible (`SolidCore/Solidity/Interpreter.lean`
     `keccakWord`, ~line 2013). State collision-freedom of the three preimages as a hypothesis.
   - **The spec.**
     - With `α` the abstraction from storage to the asyncswap `World.isExecutor` table, prove that a
       successful call takes the abstract world by `step cfg W (.setExecutor sender executor allow)`.
     - You don't need asyncswap's Mathlib-heavy spec library in the spike. Restate just the
       `isExecutor` update as a local `def` that mirrors `AsyncSwapProtocol.V2`'s `Protocol.setExecutor`.
   - **Automation, in this order:**
     1. plain `simp`/`decide`-free unfolding of the interpreter;
     2. `Std.Do` + `mvcgen` on 4.28 (WP instances for `SolI` = `EvmCompiler.Simulation.Interaction`
        don't exist; write a minimal one, and handle `request` by quantifying over answers);
     3. if you manage the toolchain bump (step 6), `Std.WP` + `vcgen` on 4.35
        (`set_option experimental.vcgen true`).
   - **Measure.** For each approach: wall time, `maxHeartbeats` needed, the number of simp lemmas you
     had to write about interpreter internals, and whether the proof mentions interpreter internals
     (string-keyed environments, `Value` constructors, `Runtime` fields) or only the spec.
5. **Durability demo.**
   - Edit the reduced contract: add `require(executor != address(0), ZeroAddress())` and move the
     `emit` above the write.
   - Re-import and re-run the proof. Record what had to change.
     - **Expected:** the success-branch spec rechecks unchanged, and a "reverts only with
       `ZeroAddress`" clause is new.
     - Compare with asyncswap's `setExecutor_run`, which claims "never reverts" and must break.
6. **Toolchain (time-boxed to one day).** Try bumping a copy of solidity-lean to `v4.35.0` with the
   Mathlib revision asyncswap/contracts `formal/lake-manifest.json` uses. Record the size of the breakage.
   Don't push upstream from the spike.
7. **Extrapolate (optional, if time).** Repeat step 4's timing on a function with a loop and checked
   arithmetic, e.g. `AsyncSwap._matchAmounts`. Extract it the same way; it calls OpenZeppelin
   `Math.mulDiv`, which is assembly, so stub `mulDiv` with a pure-Solidity version for the timing only.

## Decision rule

- **Choose A** if, on `setExecutor`:
  - the spec proof goes through in under about 30 s;
  - it needs a reusable set of interpreter lemmas (not per-function hacks);
  - the final proof script mentions only spec-level terms.
- **Otherwise choose B**, and say which interpreter features caused the cost:
  - string environments;
  - `Value` universe;
  - storage refs;
  - lowering in `Interface/*`;
  - the size of the mutual block.
- **Either way, report:**
  - the import result on full AsyncSwap;
  - the byte-for-byte comparison from step 3;
  - the toolchain-bump findings.

## Rules

- Don't change asyncswap/contracts or the solidity-lean clone (copy it if you need to patch it).
  Spike code goes in `spikes/solidcore-setexecutor/` on the PR #15 branch.
- Commit with a message ending in the repo's attribution line. Push to `docs/solidity-semantics`. The
  PR stays a draft.
- If a step is blocked, write down why and go on to the next. A partial report with real numbers beats
  a complete one with guesses.
