//! Audit mode: what formal-ast reads from solc's AST for a folder's contract.

use formal_ast::{analyze, slice};
use serde_json::Value;
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
        Ok(formal_ast::audit_json(&a, started.elapsed().as_millis() as u64))
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
