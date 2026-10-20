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
