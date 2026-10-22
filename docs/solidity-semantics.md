# A formal semantics of Solidity for formal-ast (design)

Status: draft for review. No code yet. Scope: what `crates/formal-ast` emits, how proofs are written
against it, and how both are trusted.

## Summary

formal-ast turns solc's AST into a **shallow embedding**: each Solidity function becomes a Lean `do`
block in `M σ α := ReaderT Env (StateT σ (Except Revert))`. Whatever it can't translate becomes a field
of `Ext`. Proofs unfold those generated definitions, so when the generated text changes the proofs
break, even when the property still holds.

The direction is a **deep embedding**: Solidity syntax as data, one interpreter that gives it meaning,
and proofs that go through a verification-condition generator instead of through generated text. A
working one already exists. Paradigm's **SolidCore**
([paradigmxyz/solidity-lean](https://github.com/paradigmxyz/solidity-lean)) is an executable Lean 4
semantics of Solidity 0.8.35:

- it imports solc's AST;
- it uses an inductive free monad for external calls;
- it is checked byte-for-byte against solc + EVM on a 290-case corpus;
- it is the source semantics that the verified compiler **Solidus**
  ([paradigmxyz/solidus](https://github.com/paradigmxyz/solidus)) is meant to target.

What it does not have is a way to *prove things about contracts*. It has no program logic and no
specs; it is a validated interpreter. That missing layer is exactly what Formal Mind is.

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Why do proofs break? | They are tied to the generated *text*: names that carry solc node ids, the order of `if`s, the shape of `Ext`, and hand-written library semantics. Proofs must stop seeing that text ([§1](#1-diagnosis-why-proofs-broke)). |
| 2 | What do we embed? | **Adopt SolidCore as the semantics of record**; don't write a third Solidity semantics. formal-ast emits SolidCore's AST. Our own small typed core is the fallback, chosen only if the spike shows proofs through SolidCore's interpreter are too slow. Today's shallow model stays, linked to SolidCore per function by translation validation, so the 862 existing theorems keep working ([§2](#2-the-semantics-adopt-solidcore)). |
| 3 | How do proofs survive edits? | Lean core's `Std.WP` + `vcgen` (the 4.35 successor of `mvcgen`, built for deep embeddings), with `@[spec]` lemmas for the interpreter's primitives and for each Solidity function by signature. Specs state refinement of the abstract protocol spec, never the body ([§3](#3-proof-automation-that-survives-code-changes)). |
| 4 | External calls and reentrancy? | Keep SolidCore's choice: an *inductive* free monad over the shared EVM query alphabet, plus fuel. Not coinductive ITrees: Lean 4 has `coinductive` predicates but no coinductive data types, its ITree libraries are research-grade, and EVM runs are finite (gas, call depth 1024). Reentrancy proofs use an invariant (rely/guarantee) rule over all answers to a call. This is where `Ext` goes away ([§4](#4-external-calls-and-reentrancy)). |
| 5 | Why trust the semantics? | Reuse SolidCore's differential harness (solc + Foundry, byte-equal observables), add solc's `semanticTests` and our contracts' fuzzed calls, and keep the existing "theorem → Foundry test" checks. Divergences go upstream (Paradigm's Spec Hunt) ([§5](#5-trust-validating-the-semantics)). |
| 6 | Plan | A two-week spike on `AsyncSwap.setExecutor`, then four phases over roughly 6–8 months for one person. The big upstream gap is inline assembly ([§7](#7-plan)). |

Local clones for reference, kept up to date by hand: `~/developer/asyncswap/references/` holds
`solidity-lean` (SolidCore), `solidus`, `EVMYulLean` (Paradigm's fork) and `evm-interaction`.

## 0. Where we are

- **Generator:** `crates/formal-ast` (`graph.rs` builds the contract graph, `lean.rs` emits Lean).
  `prelude.lean` holds the shared semantics: checked/wrapping arithmetic, Yul word ops, ABI words,
  `mulDivFloor`, `loopBound`, `require`, `callAs`, and so on.
- **What is translated today** (`lean.rs`, `Fx::stmt` / `Fx::expr` / `Fx::call`):
  - Statements: blocks and `unchecked`, locals, `if`, `return`, `revert`/`require`, `emit` (dropped),
    loops (`for _ in [0:loopBound]` with a `__done` flag, reverting on "loop bound"),
    `break`/`continue`, `try`/`catch` (two clauses), and modifiers as wrappers with `_` as `k`.
  - Storage: state variables, nested mappings/structs/arrays as functional updates through a lens
    (`ext.get`/`ext.set`), and storage parameters as getter/setter pairs.
  - Yul: `sload`/`sstore` of known slots, word arithmetic, `keccak256` of mapping slots.
  - Calls: internal and library calls; external calls become `ext.call_I_f` / `ext.callV_I_f` /
    `ext.view_I_f`; OpenZeppelin `Math.mulDiv` maps to the prelude.
  - ABI: static ABI encode and decode, a selector dispatcher.
- **What is opaque:** about 80 `bail(...)` sites. Low-level calls, dynamic ABI, memory it doesn't
  model, computed or packed slots, writes through conditionals, recursion. In asyncswap/contracts that
  leaves 15 of AsyncSwap's 143 reached functions opaque, 11 of Router's 46 and 1 each of FeeVault's and
  NativeClaims' 4. The reasons, counted over the four models:
  - 4 `keccak256` of a non-literal constant
  - 4 can't write through a `Conditional`
  - 4 can't write an immutable
  - 2 `mload` of memory the model didn't see written
  - 2 `hexString` literals
  - 2 `staticcall` builtins
  - 2 Yul `call`s
  - 2 references to storage
  - plus singletons
- **Linking:** `link.rs` instantiates each contract's `Ext` with the other contracts' models. Call depth
  is bounded by `exts n`, and level 0 reverts. That is already fuel on call depth.
- **Proofs:** asyncswap/contracts `formal/` (Lean 4.35.0 + Mathlib) has 4,770 generated lines and 862
  theorems in `Refinement/`. 570 of those theorems are checked on the bytecode by Foundry tests. The
  proofs evaluate generated defs with `run_*` simp lemmas (`Refinement/Monad.lean`). They state 88
  `_run` theorems (the whole-body result in closed form) and 461 `simp only [...]` calls. The protocol
  spec (`AsyncSwapProtocol.V2`: `World`, `step`, invariants) is independent of the code. It is the
  part worth the most and the part this design keeps.

## 1. Diagnosis: why proofs broke

**Evidence.** `src/` in asyncswap/contracts has not changed since the proofs landed: its last commit,
`dc8042d`, predates `formal/`. So every break in `formal/`'s history came from the *generator*
changing what it emits for unchanged Solidity. To the proofs that is the same event as a Solidity
edit: a definition's text changes.

| Commit (asyncswap/contracts) | What changed in `Generated/` | What broke |
| --- | --- | --- |
| `dc47c82` (#17) | `Address.functionCallWithValue` and `CurrencySettler.settle` went from opaque to translated. `Ext` lost 2 fields and gained 4 (`callV_IPoolManager_settle`, `call_IPoolManager_settle`, `call_IPoolManager_sync`, `lowCall`). A dispatcher case was added | Every theorem quantified over `ext : Ext σ` is now about a different structure. Hypotheses about `ext.fn_CurrencySettler_settle_8995` lost their subject |
| `549d4d2` (#27) → `e04668e` (#30) | The prelude's `mulDivFloor` was wrong: it panicked `0x12` on `d = 0` before checking overflow, unlike OpenZeppelin 5.0. The fix reordered its branches | **8 theorems were false on the bytecode** and were restated (`crosses_run`, `floor_run`, `ceil_run`, `matchAmounts_reverts_*`, …). **8 proofs of true theorems broke** because they unfolded `mulDivFloor` and case-split in its old branch order (`priceKey_ok`, `crosses_frame`, …). One was rewritten only because the kernel tried to evaluate `x * PRICE_SCALE < 2^256` on a symbolic `x` |
| `dc47c82` (Lean side) | Toolchain bump: `include` changed meaning | Section variables restated. Not a Solidity issue; out of scope |

**A static audit of `formal/Refinement/` shows the same couplings, waiting for the next edit:**

- **Unstable names.** Opaque functions are named `fn_<Contract>_<name>_<solc node id>`
  (`ext_fn_field` in `lean.rs`). The same library function gets a different name in each contract's
  model, for example `fn_Address_functionCallWithValue_15059` and `_5351`. Node ids shift whenever
  anything earlier in the compilation unit changes. 31 proof files mention such names
  (`ext.fn_AsyncFiller_remove_6902` alone 26 times). Overloaded functions get the same suffix through
  `lean_fn_name`.
- **Generated temporaries.** 37 mentions of `__t…`, `__d…` or `a72`-style locals inside proofs.
- **Shape-coupled proof scripts.** 88 `_run` theorems state the *whole* result of a body in closed
  form. They are proved by `simp [Def]` or `unfold`, then `split_ifs` / `by_cases` in the order the
  `if`s appear. 51 files `unfold` generated or prelude definitions. Reordering two `require`s, adding a
  guard, or hoisting a local changes the term, and the script fails even when the spec theorem built on
  top still holds.
- **`Ext` as a theorem parameter.** 25 files state hypotheses about `ext.call_*` behaviour. A new
  external call, or a call that becomes internal, changes `Ext`'s fields.
- **Library semantics by hand.** `mulDivFloor` is a second, hand-written semantics for OpenZeppelin
  code. It drifted from the real code, and nothing checked it until the bytecode tests did.
- **Reverts as strings.** `Revert` is `⟨reason : String⟩`: a custom error's name, `"panic 0x11"`, or
  `""` for library errors. Error arguments are dropped, so theorems can't say *which* order failed, and
  the tests map names back to selectors by hand.

**Classification, and what the semantics must fix:**

| Class | Cause | Fix in this design |
| --- | --- | --- |
| A. Renamed or reshaped definitions | node-id names, temporaries, `Ext` layout | Proofs name code by Solidity signature (`AsyncFiller._remove(bytes32)`) and never see a generated body (§2, §3) |
| B. Statement order and new guards | proofs replay the body's control flow | Pre/post triples discharged by `vcgen`. Callers use callee *specs*, not bodies (§3) |
| C. New or changed reverts | specs state *every* revert in closed form | Specs separate "on success, refines `step`" from "reverts only with …". A new guard leaves the first untouched (§3) |
| D. Opaque `Ext` fields come and go | the generator decides globally what is opaque | One interpreter covers the language; external calls are queries in a fixed alphabet; abstraction is a per-proof choice, via the callee's spec (§2, §4) |
| E. Wrong hand-written semantics | the prelude re-implements library code | Interpret the library's own source, and use a semantics that is checked differentially against solc + EVM (§2, §5) |

Class C is partly irreducible: when a revert condition really changes, a theorem *about* that revert
must change. The goal is that only such theorems change.

## 2. The semantics: adopt SolidCore

### 2.1 What SolidCore is

The facts below are from the repository at `16843fd` (2026-10-18), its `README.md`, `ARCHITECTURE.md`
and `ROADMAP.md`.

- **Syntax.** A deep embedding of Solidity 0.8.35 (`SolidCore/Solidity/Ast.lean`).
  - Mutual inductives `Expr` (17 constructors) and `Stmt` (18), contracts with inheritance,
    modifiers, libraries, events, errors, structs, enums and user value types.
  - Names are strings; the AST is the surface syntax, close to solc's.
  - `scripts/solc_ast_to_lean_source.py` imports solc's analyzed AST. It covers every solc `nodeType`
    except `ImportDirective` and `InlineAssembly`, and fails closed on anything it doesn't recognize.
- **Statics.** A typechecker (`TypeCheck.lean`, 16k lines) checked against about 311 cases that pinned
  solc rejects.
- **Dynamics.** One total, fuel-based interpreter (`Interpreter.lean`, 11k lines, no `partial def`).
  - Values are a universal `Value` type: words, `fixedBytes`, `bytes`, arrays, tuples, storage refs.
  - Storage is word-addressed with solc's real layout: slots, packing, mapping slots via Keccak.
    Storage references are bound to a concrete slot when created, as solc does.
  - Memory is abstract.
  - Reverts and panics are values carrying their exact revert data.
- **Effects.** `SolI α := Interaction SolidityFailure α`, an *inductive* free monad.
  ```lean
  inductive Interaction (Error Result : Type) where
    | done    : Except Error Result → Interaction Error Result
    | request : (query : Query) → (Answer query → Interaction Error Result) → Interaction Error Result
  ```
  - The only queries are external calls (`call`, `staticcall`, `delegatecall`, `callcode`, high- and
    low-level), precompiles, contract creation, and `gasleft`.
  - Each call query carries a snapshot of the caller's `OpenWorld`. The answer's `postWorld` is adopted
    wholesale, which is how reentrancy shows up.
  - The alphabet is shared with Solidus through
    [`evm-interaction`](https://github.com/danrobinson/evm-interaction), hash-checked to be
    byte-identical.
- **Proved laws.** `FuelMonotonicity.lean` (more fuel, same result) and `AdoptionLaws.lean`
  (`snapshotWorld (adoptWorld w s) = w`).
- **Substrate.** Lean 4.28.0, Mathlib, and EVMYulLean (Paradigm's fork) for `UInt256`, accounts and
  state.
- **Out of scope** (by its `ROADMAP.md` "Known semantic gaps"):
  - inline assembly;
  - imports and multi-file units (flattening is the planned answer);
  - closed-world multi-contract execution;
  - gas metering.
- **No proofs about programs.** In its own words, "The verification is a differential corpus, **not
  theorems**."

### 2.2 Options

| Option | For | Against |
| --- | --- | --- |
| **A. Adopt SolidCore as the semantics of record**, and build the proof layer on its interpreter | No third Solidity semantics to write and trust. Already validated byte-for-byte. Shares Solidus's interaction alphabet and EVMYulLean, so a future verified Solidity → Yul → EVM chain (Solidus) ends at *our* theorems. Fixes class E outright: library code is interpreted from source | Built to execute, not to prove: string-keyed environments, a universal `Value` type, an 11k-line mutual interpreter, word-addressed storage. Toolchain 4.28 vs our 4.35. No inline assembly, which asyncswap and Uniswap v4 libraries use |
| **B. Our own typed proof core** (`Sol` IR: typed values denote straight to `Nat`/`Int`/structures, structured storage through the lens), checked against SolidCore | Proofs stay about Lean values, as today. Small trusted interpreter. `rfl`-close to today's shallow model | A third semantics, which must itself be validated, and which drifts. It recreates what SolidCore already did, minus the validation |
| **C. Status quo**, plus better proof hygiene (named specs, no `unfold` in callers) | Cheapest | Doesn't fix classes D and E; opacity stays a generator decision |

**Recommendation: A, with B as the fallback the spike decides.** The question that decides it is
empirical. Can `vcgen` plus a simp set symbolically run SolidCore's interpreter on a real function, to
VCs about `Nat`s, in seconds rather than minutes? If yes, there is one semantics, and it is the one
Solidus will compile from. If no, B becomes a *proof IR*: formal-ast emits it, and each function's B
term is checked against the SolidCore term by execution on fuzzed inputs, later by proof. Either way,
SolidCore is the reference.

### 2.3 What we build on SolidCore

1. **Fork and pin.** Bump a fork to Lean 4.35 (`vcgen` needs it), on the same Mathlib as `formal/`. Send
   the bump upstream. Pin by commit, like the formalmind CLI today.
2. **formal-ast emits SolidCore's AST.** `lean.rs` becomes a printer from solc's AST to `Ast.lean`
   terms. Porting `solc_ast_to_lean_source.py`'s node handling to Rust keeps formal-ast one binary;
   alternatively, call the script. Sources are flattened first (`forge flatten`).
3. **Inline assembly.** SolidCore's roadmap sketches "an embedded-Yul statement whose meaning *is* the
   shared Yul semantics". We build that against EVMYulLean's Yul interpreter, which SolidCore already
   depends on, and offer it upstream. It is the biggest gap for us: AsyncSwap has 17 assembly blocks,
   and Uniswap v4's `StateLibrary` and `CurrencyLibrary` are assembly.
   - Until it lands, a fork-local `Query.oracle (block id)` arm stands in for each assembly block. The
     proofs constrain it with the block's named spec, as `formal/Refinement/Swarm/SpecBook.lean` does
     today.
4. **Typed storage views.** Lemmas from solc's `storageLayout` to typed reads and writes: "the word at
   `slot(asyncOrders[p].isExecutor[a][e])` decodes to `allow`". Proofs then talk about mappings and
   structs, not words.
   - Keccak is a concrete pure function in SolidCore, so proofs keep it irreducible and assume
     collision-freedom only on the preimages a theorem uses, as a stated hypothesis.
   - This is the one place a deep, word-level semantics costs real proof effort, and the typed lemmas
     are written once per layout feature, not per function.
5. **Abstraction to the protocol spec.** `α : State → World` per contract, generated from the layout
   and hand-completed. The existing `AsyncSwapProtocol.V2` specs and invariants are reused unchanged.

### 2.4 Translation validation: keep the 862 theorems

The existing proofs are about the shallow model. To keep them while moving:

1. formal-ast keeps emitting the shallow model, unchanged, and adds the SolidCore AST of the same
   source.
2. **Differential first.** Both models are executable: the shallow one with a concrete `Ext`, SolidCore
   under a scripted responder. A harness runs both on fuzzed calldata and states and compares results,
   revert reasons and typed storage. That catches generator bugs like the `mulDiv` one without any
   proof.
3. **Proof per function, where it pays.** A simulation theorem, for the functions whose existing
   proofs we want to keep:
   ```lean
   theorem setExecutor_sim (hR : R ext w st) :
       SolI.runAdv (callSig ast "setExecutor(bytes32,address,bool)" args) st ≈ₛ
         AsyncSwap.setExecutor ext poolId executor allow env w
   ```
   - `R` relates the shallow `State` to SolidCore's word storage through the typed views. `≈ₛ` says
     "same outcome, related final states, same revert".
   - It is proved by `vcgen`, generated as a template, and checked in CI. Existing theorems then
     transfer through `setExecutor_sim`.
   - This is translation validation in the CompCert sense (Tristan & Leroy): a checked certificate per
     run instead of a verified generator.
4. **New proofs go against SolidCore directly.** The shallow model and `lean.rs`'s 3,200 lines are
   retired once no proof depends on them.

## 3. Proof automation that survives code changes

### 3.1 Options

| Option | How | Survives edits? | Notes |
| --- | --- | --- | --- |
| **Status quo: simp sets** (`run_*` lemmas) | `simp` evaluates a body to a closed term, then `split_ifs` | No. The script mirrors the body's branches (class B) | Exponential in branches |
| **`Std.Do` + `mvcgen`** (Lean ≥ 4.22) | Hoare triples over any monad with a `WP` instance; `@[spec]` lemmas; loop invariants | Yes, if callers use callee specs | Our `M` has instances for free (`ReaderT`/`StateT`/`Except`). **Deprecated in Lean 4.35.0 (2026-10-12)** in favour of `vcgen` |
| **`Std.WP` + `vcgen`** (Lean 4.35, experimental) | A new weakest-precondition framework (authors Gladshtein and Graf; it carries Loom's ideas into core) whose WP interpretation "applies to any program type". The release notes name deeply embedded languages as a target. One benchmark in the notes: 0.32 s vs 66 s, kernel check 0.53 s vs 246 s | Yes | Behind `set_option experimental.vcgen true`. Ships in our pinned 4.35.0 (`Std/WP/`, `Lean/Elab/Tactic/VCGen/`) |
| Hand-written syntax-directed WP on the AST (Isabelle/Solidity's SSCalc, Clear) | `wp : Stmt → Post → Pre`, proven sound against the interpreter | Yes | We'd own the VC generator, its soundness proof and its performance |
| Loom / Velvet (verse-lab, POPL 2026) | Monad-transformer algebras derive WP; Velvet adds SMT via lean-auto | Yes | External; partly superseded by `Std.WP` in core |

### 3.2 Recommendation: `Std.WP` and `vcgen`

- **The monad.** A `WP` instance for `SolI` under a *handler family* (§4): the WP of `request q k` is
  "for every answer the handler allows, the WP of `k`". The adversarial handler makes that a demonic
  choice constrained by the rely invariant.
- **Primitive specs.** `@[spec]` lemmas for the interpreter's choke points:
  - checked arithmetic and panics;
  - typed storage reads and writes, with frame lemmas: writing `orders[id].price` leaves `orders[j]`,
    `j ≠ id`, alone;
  - ABI decoding;
  - event emission;
  - call queries.
- **Function specs.** `@[spec]` lemmas for each Solidity function, keyed by signature.
- **Composition.** When proving a caller, `vcgen` applies the callee's spec instead of interpreting the
  callee's body. A change inside `_remove` re-checks `_remove`'s spec and nothing above it; today 26
  references to `ext.fn_AsyncFiller_remove_6902` would all move.
- **Fallbacks.** `mvcgen` on today's shallow model is the fallback for functions not yet moved. It
  works on `M` with no new code, and the spike checks it still runs (it is deprecated, not removed).
  A hand-written syntax-directed WP is the fallback if `vcgen`'s experimental API stalls.

### 3.3 How specs are written

1. **Named by the code's identity.** A stable attribute, never a generated name:
   ```lean
   @[sol_spec "AsyncSwap.setExecutor(bytes32,address,bool)"]
   theorem setExecutor_spec :
       ⦃fun st => ⌜α st = W⌝⦄ callSig ast "setExecutor(bytes32,address,bool)" args
       ⦃fun _ st' => ⌜α st' = (step cfg W (.setExecutor env.sender executor allow)).get!⌝⦄
   ```
   `α` is the abstraction to `AsyncSwapProtocol.V2.World`.
2. **Against the abstract spec (refinement), never the body.** The postcondition says "the abstract
   world took `step`". It does not say "storage is `{ s with asyncOrders := upd … }`". Today's 88
   `_run` theorems become internal lemmas or go away.
3. **Success and failure apart.** Q is refinement on success. The failure postcondition lists the
   allowed reverts as a *superset* ("only `NotOwner`, or panic 0x11"). Adding a `require` with an
   existing error keeps it true. Only theorems that pin an exact revert condition change (the
   irreducible part of class C).
4. **Frames are derived.** "Writes only these places" comes from a syntactic write-set: `graph.rs`
   already computes `writes` per function. It is proved once by a generic lemma over the interpreter,
   not by hand per function as in today's `_frame` theorems.
5. **Tests from specs.** Errors are exact revert data and specs are keyed by signature, so the existing
   Foundry patterns (expectRevert, `vm.accesses` frames) can be generated from the spec instead of
   mapped by hand.

**Metric: proof survival under mutation.** Apply rewrites to `src/` and count which proofs still
check:
- semantics-preserving: reorder independent statements, extract a helper, rename locals, add an
  unrelated function;
- semantics-changing: add a guard, change an error.

The target is 100% survival for preserving edits, and failures only in theorems that mention the
changed behaviour.

## 4. External calls and reentrancy

Today an external call is an `Ext` field `call_I_f : Nat → … → M σ β`: an arbitrary state transformer
that "may re-enter and change our storage". It is sound but unstructured. Every theorem quantifies over
it, every new call changes `Ext`, and the linker rebuilds `Ext` to bind it.

### 4.1 Interaction trees or a free monad plus fuel

**Interaction trees** (Xia et al., POPL 2020) model a program as a *coinductive* tree of visible
events, silent `Tau` steps and returns. Handlers interpret the events, and equivalence is `eutt`
(equal up to finite `Tau`s). They are the standard Coq tool for open, possibly divergent programs.

**State of ITrees in Lean 4.** We checked our pinned 4.35.0 toolchain and the libraries:

- **Coinductive *predicates* only.** `coinductive` arrived in Lean 4.25 (PR #10333,
  `Lean/Elab/Coinductive.lean`), with stronger coinduction principles in 4.35. Declarations must be
  `Prop`-valued; there are no coinductive *data types* in core. An ITree can be built only through an
  encoding: Mathlib's `PFunctor.M`, QPFs, or approximant sequences.
- **`partial_fixpoint`** (Lean 4.17) gives equations for recursive definitions in monads with a
  bottom (`Option`, `MonadTail`), but no definitional unfolding.
- **Libraries are research-grade:**
  - [mit-plv/lean4-itree](https://github.com/mit-plv/lean4-itree) defines ITrees as `PFunctor.M` with a
    Paco port. Active, on 4.36-rc1, one-line README.
  - [boogie-org/lean-itrees](https://github.com/boogie-org/lean-itrees) builds on QPF. Stale since
    2025-01, and its README says it can't implement `interp`.
  - [HaleOIC/coinductive](https://github.com/HaleOIC/coinductive) is early development.
  - HITrees (Fadaei Ayyam & Sammler, 2025) avoid coinduction through defunctionalization.
  - None has the equational theory of Coq's InteractionTrees library and `paco`.
- **Cost of going the ITree way:** pick or build a library (M-type encoding, `bind`, `iter`, `interp`,
  `eutt` as a `coinductive` predicate, up-to lemmas) before any Solidity work. That is months of
  foundations, plus `eutt` reasoning that every user pays for.

**A free monad plus fuel** is the same tree, *inductive*: no `Tau`, no infinite branches. SolidCore's
`Interaction` is exactly this, with the interpreter's statement fuel bounding loops and recursion
(`outOfFuel` is the only failure that escapes).

### 4.2 Recommendation: the free monad plus fuel (SolidCore's `Interaction`)

1. **It's faithful.** ITrees exist for divergence and unbounded interaction. A transaction has
   neither: gas bounds every run, and call depth stops at 1024. A transaction is a finite tree of calls.
   Sequences of transactions are a separate layer, a step relation over worlds, which
   `AsyncSwapProtocol` already is.
2. **It's shared.** The query alphabet and `OpenWorld` come from `evm-interaction`, the same
   declarations Solidus's compiler theorems use. A future verified frontend's theorem and our contract
   theorems meet without re-plumbing.
3. **It's what we already do.** `link.rs`'s `exts n` is depth fuel, and `loopBound` is loop fuel.
4. **Equality is structural.** No `eutt`, no up-to techniques. `FuelMonotonicity` (already proved)
   gives "enough fuel" reasoning.

If a Lean ITree library matures, inductive trees embed into it as finite ITrees, so this choice
doesn't block a later move.

### 4.3 Handlers, and reentrancy reasoning

A handler answers queries. Three families:

- `h_adv I` (*rely*): any `CallResponse` whose `postWorld` keeps our storage within invariant `I`.
  Other accounts may change arbitrarily.
- `h_link`: closed-world linking. A call to a bound address runs that contract's SolidCore program at
  depth − 1, including re-entry through our own dispatcher. SolidCore leaves closed-world execution to
  its users ("v2 seam"); `link.rs` becomes this handler.
- `h_script`: SolidCore's scripted responders, which mirror `vm.mockCall`, for tests and the
  differential harness.

**The reentrancy rule.** This is the rule of Marmsoler & Thornton's SSCalc (SEFM 2023) and Isabelle/
Solidity's `Reentrancy` theory, also the shape of solc-verify's and SolCMC's treatment of unknown code.

- *Guarantee:* every public function, started in a state satisfying `I` with calls answered by
  `h_adv I`, ends in `I` or reverts.
- *Rely:* during an external call the world may do anything that keeps `I`. Any re-entry is a call to
  a public function, which preserves `I` by the guarantee, by induction on fuel.
- In SolidCore a reentrant callee is just "one particular `postWorld` answer", and the adoption law
  makes that precise. The `I`-preserving answers are exactly the reentrant behaviours our guarantee
  covers.
- For asyncswap this turns an assumption into a theorem or a finding. `TransferSpec.frame` currently
  "excludes re-entry from a native recipient".

**This is where `Ext` goes away.**

- External calls become queries.
- Immutables become deployment data in `Context`.
- Opaque internal functions are interpreted.
- Assembly blocks are interpreted once embedded Yul lands; until then they are oracle queries with
  named specs.

## 5. Trust: validating the semantics

The semantics is the trusted base: a wrong interpreter makes every proof vacuous. The `mulDiv`
incident is why this matters. Eight theorems were proved about a model that disagreed with the
bytecode, and only the bytecode tests caught it. Layers, cheapest first:

1. **SolidCore's own validation, inherited.**
   - 290 replay cases compiled with pinned solc and run on a real EVM via `forge`, compared
     byte-for-byte: return data, revert data, events, final storage. They cover real OpenZeppelin,
     WETH9, solmate, Uniswap and Compound sources.
   - Witness modules (one per fixed bug).
   - Pinned solc rejection lanes.
   - Paradigm's public divergence bounty (Spec Hunt).

   Adopting SolidCore means this evidence covers our proofs' foundation, and every bug someone else
   finds fixes our semantics too.
2. **Our contracts in the same harness.** Run fuzzed ABI calls to asyncswap's contracts from states the
   Foundry fixtures reach, through SolidCore and through the EVM, and compare. Mismatches go upstream
   with a witness. Add solc's own `test/libsolidity/semanticTests`, which Formal Land's
   rocq-of-solidity used as an oracle and passed at over 90%.
3. **Theorems checked on the bytecode.** Existing, in asyncswap/contracts `test/formal/`. Keep them:
   they test the *theorems*, so they catch a wrong spec as well as a wrong semantics. Generation gets
   easier because errors are exact revert data (§3.3).
4. **Translation validation** (§2.4) ties the shallow model to SolidCore while both exist.
5. **Toward bytecode, later and not ours to build.** Solidus proves Yul → EVM bytes. When its Solidity
   → Yul frontend exists and is proved against SolidCore, our theorems hold of the deployed bytecode
   with no trusted compiler. Using SolidCore unchanged, apart from upstreamed fixes, keeps that path
   open. A private fork that drifts would close it.

## 6. Related work, and what to borrow

| Work | What it is | Borrow |
| --- | --- | --- |
| **SolidCore / solidity-lean** (Paradigm, 2026), [repo](https://github.com/paradigmxyz/solidity-lean) | Executable deep semantics of Solidity 0.8.35 in Lean 4 (§2.1). Free monad over a shared EVM query alphabet; differentially validated; no program logic | **The semantics itself** (§2). Also its design records on solc corner cases: `EVAL_ORDER_DESIGN.md`, `STORAGE_REF_DESIGN.md` (storage refs bound to a slot when created, a real divergence they fixed), `docs/solc-*-review.md` |
| **Solidus** (Paradigm; D. Robinson, "Formally Verifying a Compiler Using Automated Research", 2026-07), [repo](https://github.com/paradigmxyz/solidus) | Verified Yul → EVM compiler in Lean 4, mostly built by agents. Main theorems relate solc's `irOptimizedAst` to emitted bytes, gas-free and gasful. Solidity → Yul frontend not yet built | The end of the trust chain (§5.5). Its practice of a frozen spec, an axiom audit, and agents proving against both resembles Formal Mind's swarm |
| **evm-interaction** / **EVMYulLean** (Nethermind; Paradigm fork) | The shared `Interaction`/`Query`/`OpenWorld` alphabet; executable EVM + Yul in Lean 4 with Ethereum-tests conformance | Use as-is: our handlers (§4.3) and embedded Yul (§2.3) are built on them |
| **KSolidity** (Jiao et al., IEEE S&P 2020; [arXiv 1804.01295](https://arxiv.org/abs/1804.01295)) and **KEVM** (Hildenbrandt et al., CSF 2018) | Executable small-step semantics in K. KSolidity's repo is a prototype, unmaintained since 2019; KEVM is maintained | Executable semantics plus conformance suites as the oracle. K's reachability proofs don't transfer |
| **Isabelle/Solidity** (Marmsoler, Brucker et al.: SEFM 2021, TAP 2022, SEFM 2023 SSCalc, SEFM 2024, FAC 2025; AFP entries [Solidity](https://www.isa-afp.org/entries/Solidity.html), [Isabelle-Solidity](https://www.isa-afp.org/entries/Isabelle-Solidity.html)) | Denotational deep embedding, then a shallow layer with a VCG (SSCalc) | (1) The **invariant rule for external calls** (§4.3). (2) Gas as an abstract positive cost that justifies termination, our fuel. (3) Grammar-based fuzzing for conformance. (4) Their measurement that a VCG layer over the deep core cuts proof effort sharply. That is §3's premise |
| **Lolisa / FEther** (Yang & Lei, Coq, [arXiv 1803.09885](https://arxiv.org/abs/1803.09885)) | Deep, GADT-typed Solidity subset, with symbolic execution in Coq | The intrinsically typed AST idea (fallback option B) |
| **Clear** (Nethermind, [repo](https://github.com/NethermindEth/Clear)) | Lean 4 Yul model with a Haskell VC generator | How to structure Yul VCs, for embedded assembly |
| **Verity** (LFG Labs, 2026, [repo](https://github.com/lfglabs-dev/verity)) | Lean EDSL with a proved compiler to Yul; `solidity_import`; experimental translation validation of solc's Yul against EVMYulLean | Its translation-validation experiment against EVMYulLean |
| **EquiVM** (Lazaropoulos & Paraskevopoulou, 2026, [arXiv 2607.26306](https://arxiv.org/abs/2607.26306)) | LLM-written per-bytecode refinement proofs in Lean | Evidence that agent-written refinement proofs scale. Relevant to the swarm |
| **rocq-of-solidity** (Formal Land, [repo](https://github.com/formal-land/rocq-of-solidity)) | solc fork that translates Yul to Rocq; validated on solc's `semanticTests` (>90% pass) | Reuse `semanticTests` as a corpus (§5.2) |
| **solc-verify** (Hajdu & Jovanović, VSTTE 2019) and its **memory model** (ESOP 2020, [arXiv 2001.03256](https://arxiv.org/abs/2001.03256)) | Boogie/SMT verifier; a precise model of storage/memory aliasing and copy semantics | The ESOP case table as a checklist for typed storage views (§2.3) |
| **SolCMC** (Alt et al., CAV 2022) | solc's CHC-based checker; unknown external code may re-enter | The same rely shape as §4.3 |
| **ConCert** (Annenkov, Nielsen, Spitters, CPP 2020) | Coq framework: deep to shallow with soundness, plus a blockchain execution layer | Separating per-call semantics from the transaction-sequence layer, which is what `AsyncSwapProtocol` already is |
| **Interaction trees** (Xia et al., POPL 2020); Lean ports above | Coinductive semantics of effectful programs | Not adopted (§4.1). The handler-per-environment idea is kept |
| **Std.Do / Std.WP** (Lean FRO, 4.22 → 4.35), **Loom** (Gladshtein et al., POPL 2026) | Monadic Hoare logic and VC generation in Lean core | The proof engine (§3) |
| **CompCert translation validation** (Tristan & Leroy, PLDI 2009) | Unverified pass plus a verified checker per run | The shallow ↔ SolidCore bridge (§2.4) |

## 7. Plan

Sizes are for one person who knows Lean 4 and formal-ast, with the swarm porting proofs in parallel.
Each phase's "done" is checkable in CI.

| Phase | Scope | Size | Done when |
| --- | --- | --- | --- |
| **0. Spike** | Below | 2 weeks | Go/no-go on option A vs B, with timings |
| **1. Substrate** | SolidCore fork on Lean 4.35 + our Mathlib; formal-ast emits SolidCore's AST (Rust port of the importer's node handling); flattening; a coverage report of what fails closed in asyncswap; the differential harness shallow ↔ SolidCore (§2.4.2) | 4–6 weeks | AsyncSwap, Router, FeeVault and NativeClaims import, apart from assembly; the harness runs in CI |
| **2. Program logic** | `WP` for `SolI` under `h_adv`/`h_script`; `@[spec]` for interpreter choke points; typed storage views and frames; `sol_spec`; port `setExecutor`, Router's four functions and the matching pipeline (`_matchAmounts` → `_reduceAfterMatch`) as specs against `AsyncSwapProtocol.V2.step`; simulation theorems for the ported functions | 6–8 weeks | Those proofs pass the mutation suite (§3.3); old theorems about them transfer through `_sim` |
| **3. Embedded Yul and calls** | Embedded-Yul statement on EVMYulLean, offered upstream; `h_link` from `link.rs`; the reentrancy rule; `Ext` reduced to nothing | 8–10 weeks | Opaque count 0 for asyncswap's four contracts; `TransferSpec.frame`'s re-entry exclusion proved or reported as a finding |
| **4. Retire the shallow model** | Remaining proofs ported or transferred; `lean.rs` reduced to an AST printer; our contracts and solc `semanticTests` in the differential harness | 4–6 weeks | No proof depends on `Generated/`; the harness pass rate is stated in CI |

Total: about 6–8 months. Phase 2 already pays off: after it, a Solidity edit to a function with a
ported spec breaks at most that function's spec proof.

### 7.1 The spike (phase 0)

**Function:** `AsyncSwap.setExecutor(bytes32 poolId, address executor, bool allow)`. It is the
smallest AsyncSwap function with a full refinement to the protocol spec
(`formal/Refinement/AsyncSwap.lean`: `setExecutor_run`, `setExecutor_refines`, and six invariant
corollaries, all tested on the bytecode). Its body is one write to a mapping nested in a struct in a
mapping, keyed by `msg.sender`, plus an event. That exercises typed storage views and Keccak slots,
`msg.sender`, events, and the spec's abstraction `executors ext w poolId`.

**Steps:**

1. **Fork.** Bump solidity-lean to Lean 4.35 in a scratch fork. If the bump is large, run the spike on
   4.28 with `mvcgen` and record the gap.
2. **Import.** Use SolidCore's importer on a reduced contract: AsyncSwap's state-variable declarations
   (so the storage layout is identical) and `setExecutor`. Full AsyncSwap fails closed on assembly; run
   the importer on it anyway and keep the rejection list as phase 1's coverage baseline.
3. **Execute.** `#eval` the call under a scripted responder, and compare with the same call in Foundry
   (`vm.load` of the slot).
4. **Prove the spec.** A minimal `WP` for `SolI`, the typed storage lemma for
   `asyncOrders[p].isExecutor[a][e]`, then `setExecutor_spec` by `vcgen`, stated as refinement of
   `step cfg W (.setExecutor …)`. Derive the existing `setExecutor_refines` through `setExecutor_sim`.
5. **The durability demo.**
   - Edit the Solidity: add `require(executor != address(0), ZeroAddress())` and move the `emit` above
     the write.
   - Re-import.
   - Show that `setExecutor_spec`'s success branch re-checks unchanged and the revert superset gains
     one error, while today's `setExecutor_run` breaks, as it should, because it claims "never
     reverts".
6. **Measure.** Time `vcgen` plus simp through SolidCore's interpreter on this function. Then try one
   larger function with a loop and checked arithmetic (`AsyncSwap._matchAmounts`) to extrapolate.

**Exit:** a short report with the timings and the A-vs-B decision.

### 7.2 Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Symbolic execution through SolidCore's 11k-line interpreter is too slow, or needs too many simp lemmas | medium–high | The spike measures it first; `vcgen` was rebuilt for performance on deep embeddings; fallback B (§2.2) |
| `Std.WP`/`vcgen` is experimental and churning (`mvcgen` → `mvcgen'` → `vcgen` within 2026) | high | Pin the toolchain (already pinned); keep `@[spec]` lemmas thin; `mvcgen` stays usable while deprecated |
| Toolchain skew: SolidCore on 4.28, `formal/` on 4.35 | medium | Fork and bump; upstream the bump; or keep SolidCore in its own Lake package and only share the interface |
| Inline assembly is out of SolidCore's scope, and asyncswap needs it | certain | Oracle queries with named specs as a stopgap; embedded Yul in phase 3, offered upstream |
| Word-level storage and Keccak make proofs heavier than today's structured `State` | high | Typed storage views written once per layout feature; Keccak irreducible with a stated collision-freedom hypothesis |
| Upstream direction diverges (SolidCore is research software; the frozen corpus may stop growing; Paradigm's priorities may change) | medium | Pin by commit; keep fork patches small and upstreamable; its validation corpus is ours to rerun regardless |
| Interpreter disagrees with solc on a case our contracts hit | medium | Our contracts in the differential harness (§5.2); the bytecode tests stay authoritative until then |
| Proof engineers and the swarm must learn `Std.WP` | medium | Spike and phase 2 as worked examples; a `docs/` how-to |

### 7.3 Open questions

- **Partnering.** Should we ask Paradigm whether a program logic for SolidCore is in their plans? The
  proof layer here would be a natural upstream addition, and they may already have a direction for
  multi-contract execution and embedded Yul.
- **The importer.** Rust port in formal-ast, or call their Python importer? A port keeps one binary
  and the Mac/iOS builds simple; calling the script tracks upstream fixes for free.
- **Internal calls as queries.** Should calls to *internal* functions also be able to surface as
  queries, so a proof can abstract any callee by its spec without `vcgen`? That would unify opaque
  internals with assembly oracles, at the cost of a fork-local alphabet arm.
