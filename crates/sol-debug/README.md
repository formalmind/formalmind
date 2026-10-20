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
| `q` | quit |

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
