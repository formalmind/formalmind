#!/usr/bin/env bash
# Builds formal-ast for the browser (crates/formal-ast-wasm) into lib/formal-ast-wasm, which is committed so the
# website builds without Rust. Run it after changing crates/formal-ast. Needs the wasm32 target and wasm-bindgen 0.2.100:
#   rustup target add wasm32-unknown-unknown && cargo install wasm-bindgen-cli --version 0.2.100
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release --target wasm32-unknown-unknown --manifest-path crates/formal-ast-wasm/Cargo.toml
wasm-bindgen --target web --out-dir lib/formal-ast-wasm \
	crates/formal-ast-wasm/target/wasm32-unknown-unknown/release/formal_ast_wasm.wasm
rm -f lib/formal-ast-wasm/.gitignore
