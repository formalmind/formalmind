# Formal Mind, checked against itself

What Formal Mind claims, and what shows each claim holds. `[x]` a test shows it, `[ ]` nothing shows it yet,
`[!]` known to fail. A test shows that code runs and gives the stated results on its inputs; it doesn't prove the code
correct. Coverage numbers say how much of the code the tests run.

Rerun everything:

```bash
cd desktop/src-tauri && cargo llvm-cov --lib --summary-only -- --test-threads=1
```

```bash
bun test --coverage lib
```

## Control API and MCP

- [x] Every published op (`lib/mac-ops.ts`) is the Mac's own list: `control::tests` keeps them equal.
- [x] Every op runs against a mock app (`Fake` engine, fixture `desktop/src-tauri/tests/fixtures/control`):
  `control::ops::every_read`, `every_action`, and `refusals`, which fails if any op in `OPS` goes untested.
- [x] Proofs from outside: `check_proof` builds a sound proof, refuses `sorry` and paths outside `Refinement/`;
  `submit_proof` queues a review (`control::ops::proofs_from_outside`, needs `lake`).
- [x] Refusals: unknown ops, folders not added, paths outside the folder, missing arguments (`control::ops::refusals`).
- [x] Tests never touch `~/.formalmind` or the network: a per-test home and `api_base` `http://127.0.0.1:9`.

## Relay

- [x] `call`, `say`, `stop`, `start`, `history` go through the same dispatch; a call's reply carries its id; a refused
  command becomes an error event in its session (`control::ops::relay_commands`).
- [x] Whatever a client sends, `parseCommand` returns null or a well-formed command, and only published ops reach the
  Mac: 10,000 fuzzed bodies (`lib/relay.fuzz.test.ts`).
- [ ] The relay's HTTP loop (polling, posting, retries) has no test.

## Proof ledger

- [x] Reading Lean's output never panics, and coverage names only what the statement shows (`fuzz.rs`, 20,000 cases).
- [x] A module never resolves outside Lake's sources (`fuzz.rs`, 20,000 cases).
- [ ] "Proved" means proved: checked by hand on WETH9 and Morpho Blue, no test runs a whole swarm.

## Settings and health

- [x] Settings always give a runnable route, a valid effort and a positive cap (`fuzz.rs`).
- [x] Health flags a turn whose tools didn't connect, and never a clean one (`fuzz.rs`).

## Files we expect

- [x] A project has `foundry.toml`, `src/`, `formal/lakefile.toml` and `formal/lean-toolchain` (the fixture builds).
- [x] The swarm keeps its state in `.formal/` (`plan.md`, `ledger.json`); agents can't write there (swarm guard).
- [x] One app per folder: `.formal/run.lock`.

## Coverage (2026-10-27)

| Code | Lines run by tests |
| --- | --- |
| `control.rs` (control API) | 90.7% (was 8%) |
| `health.rs` | 76.6% |
| `local.rs` (settings, folders) | 63.6% |
| `ledger.rs` | 48.9% |
| `swarm.rs` | 32.2% |
| `relay.rs` | 21.9% (was 0%; the rest is the HTTP loop) |
| All desktop Rust | 51.2% (was about 40%) |
| `lib/relay.ts` | 93.9% |
| `lib/mac-ops.ts` | 100% |
