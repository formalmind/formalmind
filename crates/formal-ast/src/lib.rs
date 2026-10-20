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
    json!({
        "contract": g.contracts[&a.scope.entry].name,
        "files": g.files.len(),
        "inScope": a.scope.files.len(),
        "reachable": a.scope.reachable.len(),
        "unusedImports": a.scope.unused_imports,
        "ms": ms,
        "units": units,
        "clusters": clusters,
    })
}

/// Every unit's slice, by unit name.
pub fn all_slices(a: &Analysis) -> std::collections::BTreeMap<String, String> {
    let mut sources = slice::Sources::new(&a.project.root, &a.graph);
    a.units.iter().map(|u| (u.name.clone(), slice::render(&a.graph, &a.scope, u, &mut sources))).collect()
}
