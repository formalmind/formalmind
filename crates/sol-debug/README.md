# sol-debug

A local Solidity debugger, prototype. solc (standard-json, never forge) compiles; revm runs; every step is placed on
its Solidity line and AST node through the source map, and every storage access is named through the storage layout.
Design: [desktop/DEBUGGER.md](../../desktop/DEBUGGER.md).

```
cargo run -- ../formal-ast/tests/fixture src/Vault.sol --contract Vault \
  --stub 0x00000000000000000000000000000000000000aa=2000000000000000000 \
  --set oracle=0x00000000000000000000000000000000000000aa \
  --call deposit --arg 100 --lines

cargo run -- ../formal-ast/tests/fixture src/Vault.sol --contract Vault --map-line 58   # AST → bytecode
cargo run -- ../formal-ast/tests/fixture src/Vault.sol --contract Vault --map-pc 1621   # bytecode → AST
```

Tests need solc 0.8.30 (`svm install 0.8.30`): `cargo test`.
