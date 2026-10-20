# sol-debug

A local Solidity debugger. solc (standard-json, never forge) compiles; revm runs; every step is placed on its
Solidity line and AST node through the source map, and every storage access is named through the storage layout.
Design: [desktop/DEBUGGER.md](../../desktop/DEBUGGER.md).

## Debug a Foundry test

Runs `setUp()` then the test, with forge's common cheatcodes (prank, deal, etch, getCode/deployCodeTo, warp, roll,
addr, sign, label, assume, expectRevert, assert*). Libraries are deployed and linked like forge does.

```
cargo build --release
./target/release/sol-debug ~/developer/asyncswap/contracts test/AsyncSwap.t.sol \
  --contract AsyncSwapTest --test test_swap_createsOrderWithPrice --tui
```

Drop `--tui` to print the trace (`--lines` for one line per Solidity line) and the named storage writes.

| Key | |
|---|---|
| `j` / `k` | next / previous opcode |
| `n` / `N` (or `l` / `h`) | next / previous line, stepping over calls |
| `s` / `S` | step into / back |
| `f` / `F` | step out / back to the call |
| `c` / `C` | continue to a breakpoint, watched write or revert |
| `g` / `G` | first / last step |
| `/text`, then `;` `,` | search source lines |
| `:b 58`, `:b File.sol:58` | toggle a line breakpoint |
| `:w priceBooks` | stop on storage writes whose name contains it |
| `:pc 1621`, `:step 1200` | jump |
| `[` / `]` | focus the previous / next pane |
| `H` `J` `K` `L`, PgUp/PgDn | scroll the focused pane (the mouse wheel scrolls the pane under it; shift-wheel sideways) |
| `z` / `0` | zoom the focused pane / reset its scroll |
| `T`, `:theme dracula` | next theme / a theme by name (`--theme` at start) |
| `q` | quit |

## Compare a protocol with its port

Runs the same test in two projects (e.g. Solidity and its Huff port) and reports the first place they disagree on
calls, events or storage. Exit code 1 on divergence. `--tui` opens both runs at it (Tab switches, `=` goes back).

```
./target/release/sol-debug ~/developer/asyncswap/contracts test/AsyncSwap.t.sol --contract AsyncSwapTest \
  --test test_swap_createsOrderWithPrice --diff ~/developer/asyncswap/v2-raff
```

`vm.ffi` runs only `hnc` (to compile Huff). `--slot-map` names the port's storage slots (solc storageLayout JSON per
contract name).

## One call on one contract

```
./target/release/sol-debug ../formal-ast/tests/fixture src/Vault.sol --contract Vault \
  --stub 0x00000000000000000000000000000000000000aa=2000000000000000000 \
  --set oracle=0x00000000000000000000000000000000000000aa --call deposit --arg 100 --lines

./target/release/sol-debug ../formal-ast/tests/fixture src/Vault.sol --contract Vault --map-line 58   # AST → bytecode
./target/release/sol-debug ../formal-ast/tests/fixture src/Vault.sol --contract Vault --map-pc 1621   # bytecode → AST
```

Tests: `cargo test` (solc 0.8.30 for the fixture; the Async Swap test runs when a `contracts` checkout sits next to
a parent folder, or at `$ASYNCSWAP_CONTRACTS`).
