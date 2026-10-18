<p align="center"><img src="public/brand/files/social/formalmind-x-header-1500x500.png" alt="Formal Mind" width="100%" /></p>

# Formal Mind

Formal Mind is a swarm of agents for verifying smart contracts. Point it at a Solidity repository and the agents write
a Lean 4 specification of it, prove it, and keep the proofs up to date as the code changes. Every theorem is
machine-checked by `lake build`, with no `sorry` and no new axioms.

- **Web:** [formal.team](https://formal.team). Paste a repository, watch the plan, start the swarm.
- **Mac:** [Download for Mac](https://github.com/formalmind/formalmind/releases/latest/download/Formal-Mind-mac.dmg).
  Also runs agent turns on folders on your machine, so the code never leaves it ([desktop/](desktop/README.md)).

## How it works

A planner breaks the work into small issues, provers write the Lean, a reviewer checks each statement against the
Solidity, and a merger merges only when `lake build` is clean. A human is asked only when a decision is needed.

## Example: Async Swap

[`asyncswap/v2`](https://github.com/asyncswap/v2) is the protocol (Solidity), and
[`asyncswap/v2-proofs`](https://github.com/asyncswap/v2-proofs) is what the swarm maintains for it:

```text
asyncswap/v2-proofs
├── AsyncSwapSpec/            specs: one Lean module per Solidity contract or library
│   ├── Fee.lean              AsyncSwap.calculatePoolFee: exactly 30 bps of gross, rounded down
│   ├── Match.lean            _matchAmounts: never fills below a limit price or overspends escrow
│   ├── Reduce.lean           a maker closed out always receives at least amountOutMin
│   ├── Book.lean             the escrow invariant, preserved by every state transition
│   ├── RadixTree.lean        RadixPriceTree: best() is the exact max/min, ≤ 128 steps
│   ├── Hashing.lean          EIP-712 / Permit2 witnesses bind every field that matters
│   └── …
├── AsyncSwapProtocol/        protocol: the whole system as one state machine
│   ├── Model.lean            World, orders, transactions, Protocol.step
│   ├── Spec.lean             order lifecycle, settlement, authorization
│   ├── Invariants.lean       escrow and claims backing hold after any sequence of steps
│   ├── Conservation.lean     no value is created or lost
│   └── V2/                   the same for v2: balances, claims and supply never go negative
├── .formal/
│   ├── plan.md               decisions, roadmap and the gaps not proven yet
│   └── notebook.json         the project's config: repos, budget, maintainers
├── FORMAL_MIND.md            changelog, including what could not be proven
└── lakefile.toml
```

The two directories split the work. `AsyncSwapSpec/` checks each contract against its own spec, close to the code.
`AsyncSwapProtocol/` models how the contracts work together and proves properties of the whole system. A theorem
there reads like this:

```lean
/-- A non-zero match never executes either side below its limit price
    and never overspends either escrow. -/
theorem matchAmounts_sound …
```

## Develop

```sh
bun install
bun run dev:api   # API on :8787
bun run dev       # web app on :3000
bun run desktop:dev
```
