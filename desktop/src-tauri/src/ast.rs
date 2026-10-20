//! Audit mode: what formal-ast reads from solc's AST for a folder's contract.

use formal_ast::{analyze, scope, slice};
use serde_json::{json, Value};
use std::path::Path;

fn check(folder: &str) -> Result<(), String> {
    if crate::local::is_added(folder)? { Ok(()) } else { Err("Add the folder first".into()) }
}

/// The entry contract's units: one per public function, with its footprint, calls, guards and arithmetic, plus the
/// clusters of units that write the same state.
#[tauri::command]
pub async fn ast_units(folder: String, entry: String) -> Result<Value, String> {
    check(&folder)?;
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let a = analyze(Path::new(&folder), &entry, None).map_err(|e| format!("{e:#}"))?;
        let g = &a.graph;
        let names = |ids: &std::collections::BTreeSet<i64>| ids.iter().filter_map(|v| g.state_vars.get(v).map(|s| s.name.clone())).collect::<Vec<_>>();
        let units: Vec<Value> = a
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
        let clusters: Vec<Value> = scope::clusters(&a.units)
            .iter()
            .filter(|c| c.units.len() > 1)
            .map(|c| json!({ "units": c.units.iter().map(|f| g.functions[f].name.clone()).collect::<Vec<_>>(), "shared": names(&c.shared) }))
            .collect();
        Ok(json!({
            "contract": g.contracts[&a.scope.entry].name,
            "files": g.files.len(),
            "inScope": a.scope.files.len(),
            "reachable": a.scope.reachable.len(),
            "unusedImports": a.scope.unused_imports,
            "ms": started.elapsed().as_millis() as u64,
            "units": units,
            "clusters": clusters,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The slice an agent gets for one unit (Markdown).
#[tauri::command]
pub async fn ast_slice(folder: String, entry: String, function: String) -> Result<String, String> {
    check(&folder)?;
    tauri::async_runtime::spawn_blocking(move || {
        let a = analyze(Path::new(&folder), &entry, None).map_err(|e| format!("{e:#}"))?;
        let unit = a.units.iter().find(|u| u.name == function || a.graph.functions[&u.function].name == function).ok_or("no such unit")?;
        let mut sources = slice::Sources::new(&a.project.root, &a.graph);
        Ok(slice::render(&a.graph, &a.scope, unit, &mut sources))
    })
    .await
    .map_err(|e| e.to_string())?
}
