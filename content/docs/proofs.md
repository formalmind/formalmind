# Proofs

The Proofs page shows how much of each contract is proved in Lean, function by function. Pick a contract file at the
top. The bar shows the share of its functions proved.

## Where each function stands

| Status | Means |
|---|---|
| **Proved** | a theorem without `sorry` names the function's generated definition |
| **Has sorry** | a theorem names it, but its proof isn't finished |
| **In Lean** | the model has a definition for it, but no theorem names it yet |
| **Not modeled** | the model leaves it opaque (inline assembly, for example), so nothing can be proved about it yet |

Proved functions sit in their own group at the top. The rest are grouped as the functions your scripts call, the
other entry points, internal functions and libraries. The filters above the list show all of them, only the proved
ones, the ones not proved yet, or the ones not modeled.

Select a function to see its Solidity, the Lean definition generated from it (**Lean4 spec**), and the theorems that
prove it (**Lean4 proof**), each opened at its line.

## Where the model comes from

The Lean model is generated from the compiler's syntax tree, one file per contract in
`formal/Generated/<Contract>.lean`. Each Solidity function becomes a definition over the contract's storage. A call
to another contract is an opaque step that returns whatever that contract returns, so a proof that relies on what a
token or an oracle does says so in its assumptions.

Code written for Solidity before 0.8, where arithmetic wraps instead of reverting on overflow, is modelled that way:
the model's arithmetic follows the compiler the code was written for.

Proofs are about those generated definitions, never a hand-written copy of the code. A function counts as proved
only when a theorem names its definition, fully qualified.

## The ledger

The ledger (`.formal/ledger.json`) is the record of what's proved, kept by the app, never written by an agent. A
function counts as proved only when all of these hold:

- every theorem naming its generated def is in a module Lake builds, and that module has built since it last changed;
- Lean checks each theorem (`#check`, `#print axioms`): no `sorry`, no axiom beyond Lean's own (`propext`,
  `Classical.choice`, `Quot.sound`);
- at least one checked theorem's statement is about the def itself;
- together, the checked theorems say **when it reverts, what it writes and what it returns**. The ledger reads this
  from the statements as Lean prints them (`Except.error`, `ext.set`, `Except.ok`), and also notes money invariants
  such as conservation. A function whose approved theorems cover less, a conservation theorem alone say, shows as
  **partly proved**, with what it covers and what's missing;
- the swarm's reviewer approved those theorems for that def. The approval holds a fingerprint of the def's generated
  text and of each theorem, so if either changes it lapses, and the function is reviewed again.

Each theorem's `/-- … -/` comment is kept with it as the proof's explanation in words. Functions proved before the
ledger existed show as "approved before the ledger" until they're reviewed again.

## Checking proofs yourself

The proofs are an ordinary Lake project in `formal/`:

```bash
cd formal
lake exe cache get   # Mathlib, prebuilt
lake build
```

`lake build` checks every proof. The swarm runs the same command before any proof goes to review.
