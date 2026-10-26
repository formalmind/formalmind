//! The Reach page: the entry contract's call graph from solc's AST, with every branch side (`JUMPI`) of each function
//! and what is known about it. A side the suite takes is **run**; of the others, explore (concolity) has either
//! **solved** it (an input of some fuzz test takes it), shown it **unsat** (no input of the tests that reach it does; a
//! dead guard or a test gap), **unsat under pinned values**, **unknown** (the solver gave up), **inputs don't decide it**
//! (it depends on state, not arguments), **not reached** by any fuzz test, or it hasn't been explored yet.
//!
//! The sides come from concolity's branch map of the suite (cached by the tree, filled by any coverage run) and the
//! last explore results (`.formal/explore.json`, kept by the explore tool); nothing runs here. Sides of code compiled
//! only into test contracts are left out: the page is about the protocol's own bytecode.

use formal_ast::analyze;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

/// One side's verdict, from the suite's counts and explore's outcome.
fn status(taken: u64, explored: Option<&Value>) -> &'static str {
    if taken > 0 {
        return "run";
    }
    match explored.and_then(|t| t["outcome"].as_str()) {
        Some("solved") => "solved",
        Some("unsat") => "unsat",
        Some("unsat_pinned") => "pinned",
        Some("unknown") => "unknown",
        Some("inputs_dont_reach") => "inputs",
        Some("not_reached") => "unreached",
        _ => "unexplored",
    }
}

/// Byte offset → 1-based line, for one file.
struct Lines(Vec<usize>);

impl Lines {
    fn of(text: &str) -> Lines {
        Lines(std::iter::once(0).chain(text.match_indices('\n').map(|(i, _)| i + 1)).collect())
    }
    fn line(&self, offset: usize) -> usize {
        self.0.partition_point(|&start| start <= offset)
    }
}

/// The page's data for one entry contract.
pub fn map(folder: &str, entry: &str) -> Result<Value, String> {
    let root = Path::new(folder);
    let a = analyze(root, entry, None).map_err(|e| format!("{e:#}"))?;
    let g = &a.graph;
    let mut lines: HashMap<i64, Option<Lines>> = HashMap::new();
    let mut line_of = |file: i64, offset: usize| -> Option<usize> {
        let l = lines.entry(file).or_insert_with(|| g.files.get(&file).and_then(|f| std::fs::read_to_string(root.join(&f.path)).ok()).map(|t| Lines::of(&t)));
        l.as_ref().map(|l| l.line(offset))
    };

    // The functions the entry can run, with their source span.
    struct F {
        file: String,
        start: usize,
        end: usize,
    }
    let mut spans: BTreeMap<i64, F> = BTreeMap::new();
    for id in &a.scope.reachable {
        let f = &g.functions[id];
        let Some(file) = g.files.get(&f.src.file) else { continue };
        let (Some(start), Some(end)) = (line_of(f.src.file, f.src.start), line_of(f.src.file, f.src.start + f.src.len)) else { continue };
        spans.insert(*id, F { file: file.path.clone(), start, end });
    }

    // The protocol's own code: contracts the entry compiles that aren't tests.
    let protocol: BTreeSet<&str> = g.contracts.values().filter(|c| g.files.get(&c.file).is_none_or(|f| !f.path.starts_with("test/"))).map(|c| c.name.as_str()).collect();
    let cov = crate::analysis::coverage_opts(folder, &json!({}));
    // This tree's branch map, or else the project's last one (marked stale): forge rewriting an untracked file is a
    // new tree, and the map shouldn't go blank for that.
    let latest = concolity::coverage::latest(&cov);
    let current = latest.as_ref().map(|(_, now)| *now);
    let branches = latest.map(|(b, _)| b);
    let explored: HashMap<(String, usize, String, usize, bool), Value> = std::fs::read_to_string(root.join(".formal/explore.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| {
            v["targets"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|t| Some(((t["file"].as_str()?.to_string(), t["line"].as_u64()? as usize, t["code"].as_str()?.to_string(), t["pc"].as_u64()? as usize, t["jumped"].as_bool()?), t.clone())))
                .collect()
        })
        .unwrap_or_default();

    // Each side to the innermost function whose span holds its line.
    let mut sides: BTreeMap<i64, Vec<Value>> = BTreeMap::new();
    let mut outside = 0usize;
    for (file, line, code, pc, jumped_n, fell_n) in branches.iter().flatten() {
        let artifact = code.trim_end_matches(" (init)");
        if !protocol.contains(artifact) {
            continue;
        }
        let owner = spans.iter().filter(|(_, s)| file.ends_with(&s.file) && s.start <= *line && *line <= s.end).min_by_key(|(_, s)| s.end - s.start).map(|(id, _)| *id);
        let Some(owner) = owner else {
            outside += 2;
            continue;
        };
        for (jumped, n) in [(true, *jumped_n), (false, *fell_n)] {
            let e = explored.get(&(file.clone(), *line, code.clone(), *pc, jumped));
            let mut v = json!({ "line": line, "code": code, "pc": pc, "jumped": jumped, "count": n, "status": status(n, e) });
            if let Some(e) = e.filter(|_| n == 0) {
                v["test"] = e["test"].clone();
                v["args"] = e["args"].clone();
                v["test_failed"] = e["test_failed"].clone();
            }
            sides.entry(owner).or_default().push(v);
        }
    }

    let surface: BTreeSet<i64> = a.scope.surface.iter().copied().collect();
    let functions: Vec<Value> = spans
        .iter()
        .map(|(id, s)| {
            let f = &g.functions[id];
            let mine = sides.remove(id).unwrap_or_default();
            let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
            for v in &mine {
                *counts.entry(v["status"].as_str().unwrap_or("")).or_insert(0) += 1;
            }
            json!({
                "id": id,
                "name": if f.name.is_empty() { f.kind.clone() } else { f.name.clone() },
                "contract": g.contracts.get(&f.contract).map(|c| c.name.clone()),
                "contract_kind": g.contracts.get(&f.contract).map(|c| c.kind.clone()),
                "kind": f.kind,
                "visibility": f.visibility,
                "mutability": f.mutability,
                "entry": surface.contains(id),
                "file": s.file,
                "line": s.start,
                "end": s.end,
                "counts": counts,
                "sides": mine,
            })
        })
        .collect();
    let edges: BTreeSet<(i64, i64)> = spans
        .keys()
        .flat_map(|id| g.functions[id].calls.iter().filter_map(|c| c.target).filter(|t| spans.contains_key(t)).map(move |t| (*id, t)))
        .chain(spans.keys().flat_map(|id| g.functions[id].modifiers.iter().filter(|m| spans.contains_key(m)).map(move |m| (*id, *m))))
        .filter(|(a, b)| a != b)
        .collect();
    let updated = std::fs::read_to_string(root.join(".formal/explore.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["updated"].as_u64());
    Ok(json!({
        "entry": entry,
        "contract": g.contracts.get(&a.scope.entry).map(|c| c.name.clone()),
        "functions": functions,
        "edges": edges.into_iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>(),
        "coverage": current.map(|now| if now { "current" } else { "stale" }),
        "explored": updated,
        "outside": outside,
    }))
}

#[tauri::command]
pub async fn reach_map(folder: String, entry: String) -> Result<Value, String> {
    if !crate::local::is_added(&folder)? {
        return Err("Add the folder first".into());
    }
    tauri::async_runtime::spawn_blocking(move || map(&folder, &entry)).await.map_err(|e| e.to_string())?
}

/// Runs the suite's coverage, or explore (all of it, or one line's sides with `target`), in the background, as the
/// Bug Hunter's background tasks do; `reach:updated` fires when it's done.
#[tauri::command]
pub async fn reach_run(app: tauri::AppHandle, folder: String, tool: String, target: Option<String>) -> Result<usize, String> {
    if !crate::local::is_added(&folder)? {
        return Err("Add the folder first".into());
    }
    let input = match target {
        Some(t) => json!({ "target": t }),
        None => json!({}),
    };
    crate::analysis::spawn_task(&app, &folder, &tool, input)
}

/// The folder's background tasks: what runs, and for how long.
#[tauri::command]
pub async fn reach_tasks(folder: String) -> Result<Value, String> {
    Ok(crate::analysis::task_list(&folder))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_to_lines() {
        let l = Lines::of("a\nbc\n\nd");
        assert_eq!((l.line(0), l.line(2), l.line(3), l.line(5), l.line(6)), (1, 2, 2, 3, 4));
    }

    #[test]
    fn a_side_the_suite_takes_is_run_whatever_explore_says() {
        let solved = json!({ "outcome": "solved" });
        assert_eq!(status(3, Some(&solved)), "run");
        assert_eq!(status(0, Some(&solved)), "solved");
        assert_eq!(status(0, Some(&json!({ "outcome": "unsat_pinned" }))), "pinned");
        assert_eq!(status(0, None), "unexplored");
    }

    /// Async Swap (an added folder): the hook's functions, its calls, and sides once coverage has run.
    #[test]
    #[ignore]
    fn async_swap_map() {
        let root = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join("developer/asyncswap/contracts");
        let folder = root.display().to_string();
        // The branch map the page reads: the suite run once with the app's options (cached after).
        concolity::coverage::branches(&crate::analysis::coverage_opts(&folder, &json!({}))).unwrap();
        let v = map(&folder, "src/AsyncSwap.sol").unwrap();
        let fns = v["functions"].as_array().unwrap();
        assert!(fns.iter().any(|f| f["name"] == "cancelOrder" && f["entry"] == true), "{}", fns.len());
        assert!(v["edges"].as_array().unwrap().len() > 10);
        let sides: usize = fns.iter().map(|f| f["sides"].as_array().unwrap().len()).sum();
        eprintln!("{} functions, {} edges, {sides} sides, coverage {}, outside {}", fns.len(), v["edges"].as_array().unwrap().len(), v["coverage"], v["outside"]);
    }
}
