//! Runs the whole pipeline on tests/fixture (needs solc 0.8.30: `svm install 0.8.30`).

use formal_ast::graph::CallKind;
use formal_ast::{analyze, scope, slice, Analysis};
use std::collections::BTreeSet;
use std::path::Path;

fn fixture() -> Option<Analysis> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture");
    match analyze(&root, "src/Vault.sol", None) {
        Ok(a) => Some(a),
        Err(e) if e.to_string().contains("isn't installed") || e.to_string().contains("no solc") => {
            eprintln!("skipped: {e}");
            None
        }
        Err(e) => panic!("{e:#}"),
    }
}

fn var_names(a: &Analysis, ids: &BTreeSet<i64>) -> Vec<String> {
    ids.iter().map(|v| a.graph.state_vars[v].name.clone()).collect()
}

fn unit<'a>(a: &'a Analysis, name: &str) -> &'a scope::Unit {
    a.units.iter().find(|u| a.graph.functions[&u.function].name == name).unwrap_or_else(|| panic!("no unit {name}"))
}

#[test]
fn entry_and_surface() {
    let Some(a) = fixture() else { return };
    assert_eq!(a.graph.contracts[&a.scope.entry].name, "Vault");
    let surface: Vec<String> = a.units.iter().map(|u| a.graph.functions[&u.function].name.clone()).collect();
    for name in ["deposit", "withdraw", "lockSlot", "setOwner", "bump"] {
        assert!(surface.contains(&name.to_string()), "{name} missing from {surface:?}");
    }
    // Interface declarations without a body aren't entry points; `total` is a public variable's getter.
    assert!(!surface.contains(&"total".to_string()));
    assert!(!surface.contains(&"price".to_string()));
}

#[test]
fn writes_through_storage_pointers_and_parameters() {
    let Some(a) = fixture() else { return };
    // `acc` points at accounts[msg.sender]; `_credit(acc, …)` writes it through a storage parameter; push writes history.
    assert_eq!(var_names(&a, &unit(&a, "deposit").writes), vec!["total", "accounts", "history"]);
    assert_eq!(var_names(&a, &unit(&a, "withdraw").writes), vec!["total", "accounts"]);
}

#[test]
fn super_and_overrides() {
    let Some(a) = fixture() else { return };
    // bump() → _hook(), resolved to Vault._hook, whose super._hook() runs Base._hook.
    let writes = var_names(&a, &unit(&a, "bump").writes);
    assert!(writes.contains(&"baseCount".to_string()) && writes.contains(&"locked".to_string()), "{writes:?}");
}

#[test]
fn assembly_slot_writes_and_modifiers() {
    let Some(a) = fixture() else { return };
    let u = unit(&a, "lockSlot");
    assert_eq!(var_names(&a, &u.writes), vec!["locked"]);
    assert!(u.reads.iter().any(|v| a.graph.state_vars[v].name == "owner"), "onlyOwner reads owner");
    assert_eq!(u.asm, 1);
    assert_eq!(u.guards, 1);
}

#[test]
fn calls_guards_and_arithmetic() {
    let Some(a) = fixture() else { return };
    let w = unit(&a, "withdraw");
    let g = &a.graph;
    let ext: Vec<(String, CallKind, Vec<String>)> = w
        .external_calls
        .iter()
        .map(|e| {
            let c = &g.functions[&e.function].calls[e.call];
            (c.name.clone(), c.kind, var_names(&a, &e.written_after))
        })
        .collect();
    // price() is read first; transfer() happens before shares and total are written: the reentrancy question.
    assert_eq!(ext[0].0, "price");
    assert_eq!(ext[1], ("transfer".into(), CallKind::External, vec!["total".into(), "accounts".into()]));

    let wf = &g.functions[&w.function];
    assert!(wf.arith.iter().any(|x| x.op == "mulDiv" && x.rounding.as_deref() == Some("ceil")));
    assert!(wf.arith.iter().any(|x| x.op == "-" && !x.checked), "unchecked subtraction");

    let d = &g.functions[&unit(&a, "deposit").function];
    assert!(d.guards.iter().any(|x| x.kind == "if-revert"));
    assert!(d.arith.iter().any(|x| x.op == "mulDiv" && x.rounding.as_deref() == Some("floor")));
    // The library is a dependency: listed, not part of the closure.
    assert!(unit(&a, "deposit").dependencies.iter().any(|f| g.functions[f].name == "mulDiv"));
}

#[test]
fn scope_finds_unused_imports_and_clusters() {
    let Some(a) = fixture() else { return };
    assert_eq!(a.scope.unused_imports, vec!["src/Unused.sol".to_string()]);
    let clusters = scope::clusters(&a.units);
    let big = &clusters[0];
    let names: Vec<String> = big.shared.iter().map(|v| a.graph.state_vars[v].name.clone()).collect();
    assert!(names.contains(&"total".to_string()) && names.contains(&"accounts".to_string()), "{names:?}");
}

#[test]
fn slices_are_small_and_cut_from_source() {
    let Some(a) = fixture() else { return };
    let mut sources = slice::Sources::new(&a.project.root, &a.graph);
    let md = slice::render(&a.graph, &a.scope, unit(&a, "deposit"), &mut sources);
    assert!(md.contains("# Vault.deposit"));
    assert!(md.contains("function _credit(Account storage acc, uint256 shares) internal"));
    assert!(md.contains("MathLib.mulDiv"), "dependencies are listed");
    assert!(!md.contains("return a * b / c"), "dependency code isn't inlined");
    assert!(md.len() < 4000, "slice is {} bytes", md.len());
}

#[test]
fn lean_model_type_checks() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture");
    let (a, output) = match formal_ast::analyze_full(&root, "src/Vault.sol", None) {
        Ok(x) => x,
        Err(e) => return eprintln!("skipped: {e}"),
    };
    let model = formal_ast::lean::Gen::new(&output, &a.graph, &a.scope).generate("Model");
    // Storage parameters are lenses, so deposit → _credit translates; only the assembly is left opaque.
    assert_eq!(model.report.opaque.len(), 1, "{:?}", model.report.opaque);
    assert!(model.report.opaque[0].0.ends_with("lockSlot"));
    assert!(model.text.contains("def Vault.deposit"));
    assert!(model.text.contains("acc_set"));
    // OpenZeppelin's mulDiv gets the prelude's semantics; the fixture's own library is translated from its code.
    assert!(model.text.contains("MathLib.mulDivUp ext"));

    let dir = std::env::temp_dir().join(format!("formal-ast-lean-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("Vault.lean"), &model.text).unwrap();
    std::fs::copy(root.join("lean-toolchain"), dir.join("lean-toolchain")).unwrap();
    match std::process::Command::new("lean").arg("Vault.lean").current_dir(&dir).output() {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
            assert!(out.status.success() && !text.contains("error"), "lean rejected the model:\n{text}");
        }
        Err(_) => eprintln!("skipped the Lean check: no `lean` on PATH"),
    }
}
