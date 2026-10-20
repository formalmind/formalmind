//! formal-ast: a Solidity protocol read through solc's AST, and nothing else.
//!
//! `solc` → [`graph::Graph`] (what every function reads, writes, calls, guards and computes) → [`scope::Scope`] (what
//! the entry contract can reach) → [`scope::Unit`]s and clusters (how to split the work) → [`slice::render`] (what an
//! agent reads). See desktop/AUDIT-ENGINE.md.

pub mod graph;
pub mod lean;
pub mod link;
pub mod scope;
pub mod slice;
pub mod solc;

use anyhow::Result;
use std::path::Path;

/// Everything for one entry file: the graph, its scope and units.
pub struct Analysis {
    pub project: solc::Project,
    pub entry_file: String,
    pub graph: graph::Graph,
    pub scope: scope::Scope,
    pub units: Vec<scope::Unit>,
}

pub fn analyze(root: &Path, entry_file: &str, contract: Option<&str>) -> Result<Analysis> {
    Ok(analyze_full(root, entry_file, contract)?.0)
}

/// Also returns solc's output, for generators that need the full AST (the Lean model).
pub fn analyze_full(root: &Path, entry_file: &str, contract: Option<&str>) -> Result<(Analysis, serde_json::Value)> {
    let project = solc::Project::load(root)?;
    let output = solc::compile(&project, entry_file)?;
    let mut graph = graph::Graph::build(&output);
    graph.mark_dependencies(&project.libs);
    let scope = scope::Scope::new(&graph, entry_file, contract)?;
    let units = scope.units(&graph);
    Ok((Analysis { project, entry_file: entry_file.to_string(), graph, scope, units }, output))
}

/// What audit mode shows for one entry contract: units with their footprint and risks, clusters, scope, timing.
pub fn audit_json(a: &Analysis, ms: u64) -> serde_json::Value {
    use serde_json::json;
    let g = &a.graph;
    let names = |ids: &std::collections::BTreeSet<i64>| ids.iter().filter_map(|v| g.state_vars.get(v).map(|s| s.name.clone())).collect::<Vec<_>>();
    let units: Vec<serde_json::Value> = a
        .units
        .iter()
        .map(|u| {
            json!({
                "name": u.name,
                "function": g.functions[&u.function].name,
                "mutability": u.mutability,
                "reads": names(&u.reads),
                "writes": names(&u.writes),
                "external": u.external_calls.len(),
                "guards": u.guards,
                "arith": u.arith,
                "unchecked": u.unchecked,
                "asm": u.asm,
                "closure": u.closure.len(),
            })
        })
        .collect();
    let clusters: Vec<serde_json::Value> = scope::clusters(&a.units)
        .iter()
        .filter(|c| c.units.len() > 1)
        .map(|c| json!({ "units": c.units.iter().map(|f| g.functions[f].name.clone()).collect::<Vec<_>>(), "shared": names(&c.shared) }))
        .collect();
    // The contract as the AST has it: the entry and its bases (most derived first), each with its state and functions.
    let tree: Vec<serde_json::Value> = a
        .scope
        .contracts
        .iter()
        .map(|c| {
            let ct = &g.contracts[c];
            let vars: Vec<serde_json::Value> = ct
                .state_vars
                .iter()
                .map(|v| {
                    let v = &g.state_vars[v];
                    json!({ "name": v.name, "type": v.type_string, "slot": v.slot, "offset": v.offset, "constant": v.constant, "immutable": v.immutable, "visibility": v.visibility })
                })
                .collect();
            let fns: Vec<serde_json::Value> = ct
                .functions
                .iter()
                .map(|f| {
                    let f = &g.functions[f];
                    json!({
                        "name": if f.name.is_empty() { f.kind.clone() } else { f.name.clone() },
                        "kind": f.kind,
                        "visibility": f.visibility,
                        "mutability": f.mutability,
                        "modifiers": f.modifiers.iter().filter_map(|m| g.functions.get(m).map(|m| m.name.clone())).collect::<Vec<_>>(),
                        "reached": a.scope.reachable.contains(&f.id),
                        "entry": a.scope.surface.contains(&f.id),
                    })
                })
                .collect();
            json!({ "name": ct.name, "kind": ct.kind, "file": g.files.get(&ct.file).map(|f| f.path.clone()), "stateVars": vars, "functions": fns })
        })
        .collect();
    let reached: Vec<serde_json::Value> = a
        .scope
        .reachable
        .iter()
        .map(|f| {
            let func = &g.functions[f];
            json!({
                "name": g.qualified(*f),
                "kind": func.kind,
                "visibility": func.visibility,
                "dependency": g.is_dependency(*f),
                "arith": func.arith.len(),
                "asm": func.asm.len(),
                "calls": func.calls.len(),
            })
        })
        .collect();
    let scope_files: Vec<serde_json::Value> = g
        .files
        .values()
        .map(|f| json!({ "path": f.path, "inScope": a.scope.files.contains(&f.id), "dependency": g.dependency_files.contains(&f.id), "imports": f.imports.len() }))
        .collect();
    json!({
        "contract": g.contracts[&a.scope.entry].name,
        "files": g.files.len(),
        "inScope": a.scope.files.len(),
        "reachable": a.scope.reachable.len(),
        "unusedImports": a.scope.unused_imports,
        "ms": ms,
        "units": units,
        "clusters": clusters,
        "tree": tree,
        "reached": reached,
        "scopeFiles": scope_files,
    })
}

/// Every unit's slice, by unit name.
pub fn all_slices(a: &Analysis) -> std::collections::BTreeMap<String, String> {
    let mut sources = slice::Sources::new(&a.project.root, &a.graph);
    a.units.iter().map(|u| (u.name.clone(), slice::render(&a.graph, &a.scope, u, &mut sources))).collect()
}

/// A theorem (or lemma) in one of the project's own Lean files.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Theorem {
    pub name: String,
    pub file: String,
    pub line: usize,
    /// Its proof still has a `sorry`.
    pub sorry: bool,
    /// Its statement and proof, as written.
    pub text: String,
}

/// Every theorem in the project's own `.lean` files (dependencies, build output and Lake's packages skipped).
pub fn theorems(root: &Path) -> Vec<Theorem> {
    const SKIP: [&str; 9] = [".git", ".lake", "lib", "dependencies", "node_modules", "out", "cache", "broadcast", "target"];
    let mut files = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for e in read.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if !SKIP.contains(&name.as_str()) {
                    stack.push(path);
                }
            } else if name.ends_with(".lean") {
                files.push(path);
            }
        }
    }
    files.sort();
    let mut out = vec![];
    for path in files {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();
        let lines: Vec<&str> = text.lines().collect();
        // A declaration starts at column 0 (after attributes and modifiers); it runs to the next one.
        let starts_decl = |l: &str| {
            let t = l.trim_start_matches("private ").trim_start_matches("protected ").trim_start_matches("noncomputable ");
            !l.starts_with(' ') && !l.starts_with('\t') && ["theorem ", "lemma ", "def ", "abbrev ", "structure ", "inductive ", "instance ", "namespace ", "end ", "section ", "open ", "example ", "@["].iter().any(|k| t.starts_with(k))
        };
        let mut i = 0;
        while i < lines.len() {
            let l = lines[i];
            let t = l.trim_start_matches("private ").trim_start_matches("protected ");
            let kw = if t.starts_with("theorem ") { Some("theorem ") } else if t.starts_with("lemma ") { Some("lemma ") } else { None };
            if let (Some(kw), false) = (kw, l.starts_with(' ')) {
                let name = t[kw.len()..].split_whitespace().next().unwrap_or("").to_string();
                let mut j = i + 1;
                while j < lines.len() && !starts_decl(lines[j]) {
                    j += 1;
                }
                let body = lines[i..j].join("\n").trim_end().to_string();
                out.push(Theorem { name, file: rel.clone(), line: i + 1, sorry: body.split(|c: char| !c.is_alphanumeric() && c != '_').any(|w| w == "sorry"), text: body });
                i = j;
            } else {
                i += 1;
            }
        }
    }
    out
}

/// What the Audit page shows for one entry contract: every function the Lean model reached (translated or opaque),
/// where it is in Solidity, its Lean definition, and which of the project's theorems name it.
pub fn formal_json(a: &Analysis, output: &serde_json::Value, ms: u64) -> serde_json::Value {
    use serde_json::json;
    let g = &a.graph;
    let started = std::time::Instant::now();
    let namespace = lean::ident(&g.contracts[&a.scope.entry].name);
    let model = lean::Gen::new(output, g, &a.scope).generate(&namespace);
    let theorems = theorems(&a.project.root);
    let mut sources = slice::Sources::new(&a.project.root, g);
    // A theorem covers a function when it names its Lean definition (or, for an opaque one, its `Ext` field).
    let names = |hay: &str, needle: &str| {
        let mut from = 0;
        while let Some(k) = hay[from..].find(needle) {
            let at = from + k;
            let before = hay[..at].chars().next_back();
            let after = hay[at + needle.len()..].chars().next();
            let edge = |c: Option<char>| c.map_or(true, |c| !(c.is_alphanumeric() || c == '_' || c == '.' || c == '\''));
            if edge(before) && edge(after) {
                return true;
            }
            from = at + needle.len();
        }
        false
    };
    let functions: Vec<serde_json::Value> = model
        .report
        .functions
        .iter()
        .map(|f| {
            let func = &g.functions[&f.id];
            let file = g.files.get(&func.src.file).map(|x| x.path.clone());
            let line = sources.line(func.src);
            let end = sources.line(graph::Src { start: func.src.start + func.src.len, ..func.src });
            let by: Vec<usize> = theorems.iter().enumerate().filter(|(_, t)| !f.lean.is_empty() && names(&t.text, &f.lean)).map(|(i, _)| i).collect();
            json!({
                "name": f.name,
                "kind": func.kind,
                "visibility": func.visibility,
                "mutability": func.mutability,
                "entry": a.scope.surface.contains(&f.id),
                "dependency": g.is_dependency(f.id),
                "file": file,
                "line": line,
                "endLine": end,
                "solidity": sources.lines(func.src),
                "lean": f.lean,
                "def": f.def,
                "why": f.why,
                "theorems": by,
            })
        })
        .collect();
    json!({
        "contract": g.contracts[&a.scope.entry].name,
        "namespace": namespace,
        "modelLines": model.text.lines().count(),
        "translated": model.report.translated.len(),
        "opaque": model.report.opaque.len(),
        "ext": model.report.ext.len(),
        "functions": functions,
        "theorems": theorems,
        "ms": ms + started.elapsed().as_millis() as u64,
    })
}
