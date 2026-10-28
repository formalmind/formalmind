//! Lean models of tests/fixture contracts that exercise what the generator models beyond plain functions
//! (needs solc 0.8.30: `svm install 0.8.30`; the Lean checks need `lean` on PATH).

use formal_ast::lean::{Gen, Model};
use std::path::Path;

fn model(file: &str, contract: &str) -> Option<Model> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture");
    match formal_ast::analyze_full(&root, file, Some(contract)) {
        Ok((a, output)) => Some(Gen::new(&output, &a.graph, &a.scope).generate("Model")),
        Err(e) if e.to_string().contains("isn't installed") || e.to_string().contains("no solc") => {
            eprintln!("skipped: {e}");
            None
        }
        Err(e) => panic!("{e:#}"),
    }
}

/// Writes `text` to a scratch file and checks it with `lean`, when there is one on PATH.
fn lean_checks(name: &str, text: &str) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture");
    let dir = std::env::temp_dir().join(format!("formal-ast-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.lean")), text).unwrap();
    std::fs::copy(root.join("lean-toolchain"), dir.join("lean-toolchain")).unwrap();
    match std::process::Command::new("lean").arg(format!("{name}.lean")).current_dir(&dir).output() {
        Ok(out) => {
            let msg = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
            assert!(out.status.success() && !msg.contains("error"), "lean rejected the model:\n{msg}\n{text}");
        }
        Err(_) => eprintln!("skipped the Lean check: no `lean` on PATH"),
    }
}

#[test]
fn constructors_set_immutables() {
    let Some(model) = model("src/Deploy.sol", "Deploy") else { return };
    assert!(model.report.opaque.is_empty(), "{:?}", model.report.opaque);
    let t = &model.text;
    // The deployment returns `ext` with its immutables set; they start at zero.
    assert!(t.contains("def Deploy.constructor {σ : Type} (ext : Ext σ) («_owner» : Nat) : M σ (Ext σ)"), "{t}");
    assert!(t.contains("let mut ext := { ext with owner := default, child := default, nameHash := default }"), "{t}");
    // The base's argument, then its state initializer and body, run before the entry's body.
    let base = t.find("let name_b1 : String := \"deploy\"").expect(t);
    let init = t.find("{ s with count := 7 }").expect(t);
    let hash = t.find("ext := { ext with nameHash := ").expect(t);
    let own = t.find("ext := { ext with owner := «_owner» }").expect(t);
    assert!(base < init && init < hash && hash < own, "{t}");
    assert!(t.contains("keccakBytes : List Nat → Nat"));
    // `new Child()`: an opaque creation returning the address.
    assert!(t.contains("new_Child : M σ Nat") && t.contains("← ext.new_Child"), "{t}");
    // At run time, immutables are read from `ext`.
    assert!(t.contains("return ext.nameHash"), "{t}");
    lean_checks("Deploy", t);
}

#[test]
fn constants_built_from_literals() {
    let Some(model) = model("src/Consts.sol", "Consts") else { return };
    assert!(model.report.opaque.is_empty(), "{:?}", model.report.opaque);
    let t = &model.text;
    // keccak256 of a bytes constant, and of abi.encodePacked of literals and constants: computed here.
    assert!(t.contains("Sigs.A_HASH : Nat := 0x8988d687b513e88abb9877146db58b35c367b58bc6305f31a77e0c4803826ed5"), "{t}");
    assert!(t.contains("Sigs.B_HASH : Nat := 0x8633e574b533cf099552f4fb2dbb664685db0f0434ce91dc19e6cbad249dc2f2"), "{t}");
    // A `string(abi.encodePacked(…))` constant is its text.
    assert!(t.contains("Sigs.WITNESS : String := \"B witness)A(uint256 x)\""), "{t}");
    lean_checks("Consts", t);
}

#[test]
fn abi_arrays_of_static_elements() {
    let Some(model) = model("src/Arrays.sol", "Arrays") else { return };
    assert!(model.report.opaque.is_empty(), "{:?}", model.report.opaque);
    let t = &model.text;
    // Encoding: the length, then each element's words in place.
    assert!(t.contains("abiEncode (items.length :: items.flatMap (fun "), "{t}");
    // Decoding: each element decoded and checked at `pos + 32 + i * stride` (an Item is three words).
    assert!(t.contains("← abiArrayAt data __o") && t.contains(" 96 (fun __b"), "{t}");
    assert!(t.contains("def Arrays.sum"), "{t}");
    // solc checks a calldata array's elements only when read, so `sum` isn't decoded eagerly by the dispatcher.
    assert!(!t.contains("Arrays.sum ext __d"), "{t}");
    lean_checks("Arrays", t);
}

#[test]
fn memory_calls_and_assembly() {
    let Some(model) = model("src/Memory.sol", "Memory") else { return };
    let t = &model.text;
    // Only the function where another local names the same memory stays opaque.
    let opaque: Vec<&str> = model.report.opaque.iter().map(|(f, _)| f.as_str()).collect();
    assert_eq!(opaque, ["Memory.aliased"], "{:?}", model.report.opaque);
    assert!(model.report.opaque[0].1.contains("another local also refers to"));
    // A memory parameter written through comes back after the results, and the caller writes it back.
    assert!(t.contains("def Batches.add {σ : Type} (ext : Ext σ) (b : Batches.Batch) (to : Nat) (amount : Nat) : M σ Batches.Batch"), "{t}");
    assert!(t.contains("← Batches.add ext x a 1\n  x := "), "{t}");
    // A fixed-size array starts as that many zero elements.
    assert!(t.contains("instance : Inhabited Batches.Batch := ⟨{ items := (List.replicate 4 default), count := default }⟩"), "{t}");
    // mload of a memory struct's field; bytes at the free memory pointer hashed byte by byte.
    assert!(t.contains("(r).d"), "{t}");
    assert!(t.contains("ext.keccakBytes (((wordBytes "), "{t}");
    // staticcall reads the world and can't write; bytes4 → bytes32 pads on the right.
    assert!(t.contains("view (fun env s => .ok (ext.staticCall env s t data))"), "{t}");
    assert!(t.contains("0x12345678 * 2 ^ 224"), "{t}");
    // A public variable's getter on another contract is a view call.
    assert!(t.contains("view_Owned_owner : Env → σ → Nat → Except Revert Nat"), "{t}");
    // hex"0f" as a bytes1, and `new uint256[](0)`.
    assert!(t.contains("return (0x0f, "), "{t}");
    assert!(t.contains("List.replicate 0 default"), "{t}");
    // keccak256(abi.encodePacked(two words)) is keccak256 over the words.
    assert!(t.contains("(ext.keccak [id, "), "{t}");
    // A storage parameter read as a value.
    assert!(t.contains("← store_get"), "{t}");
    lean_checks("Memory", t);
}
