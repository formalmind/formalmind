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
