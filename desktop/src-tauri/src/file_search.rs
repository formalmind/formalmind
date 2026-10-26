//! The agents' file search, on fff (fff-search): each folder is indexed once, kept current by a watcher, and searched
//! from memory, instead of walking and reading every file on each call.

use fff_search::file_picker::FilePicker;
use fff_search::{Constraint, FFFMode, FFFQuery, FilePickerOptions, FileSearchConfig, FuzzyQuery, FuzzySearchOptions, GrepMode, GrepSearchOptions, PaginationArgs, SharedFilePicker, SharedFrecency};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Dependencies (lib/ for git submodules, dependencies/ for Soldeer, Mathlib in .lake), build output and the swarm's own logs.
pub(crate) const SKIP: [&str; 11] = [".git", "node_modules", "lib", "dependencies", "out", "cache", "broadcast", "target", ".lake", "dist", ".formal"];
const MAX_HITS: usize = 200;

/// The folder's index, made on first use and kept for the life of the app.
fn picker(root: &Path) -> Result<SharedFilePicker, String> {
    static PICKERS: OnceLock<Mutex<HashMap<PathBuf, SharedFilePicker>>> = OnceLock::new();
    let mut all = PICKERS.get_or_init(Default::default).lock().map_err(|e| e.to_string())?;
    if let Some(p) = all.get(root) {
        return Ok(p.clone());
    }
    let shared = SharedFilePicker::default();
    let options = FilePickerOptions { base_path: root.to_string_lossy().to_string(), mode: FFFMode::Ai, watch: true, ..Default::default() };
    FilePicker::new_with_shared_state(shared.clone(), SharedFrecency::default(), options).map_err(|e| e.to_string())?;
    shared.wait_for_scan(Duration::from_secs(30));
    all.insert(root.to_path_buf(), shared.clone());
    Ok(shared)
}

fn skipped() -> Vec<Constraint<'static>> {
    SKIP.iter().map(|d| Constraint::Not(Box::new(Constraint::PathSegment(d)))).collect()
}

fn wanted(path: &str, dir: &str, exts: &[&str]) -> bool {
    let dir = dir.trim_start_matches("./").trim_end_matches('/');
    (dir.is_empty() || dir == "." || path.starts_with(&format!("{dir}/"))) && (exts.is_empty() || exts.iter().any(|x| path.ends_with(x)))
}

/// Lines matching a regex in the files under `dir` with one of `exts`, as path:line: text.
pub(crate) fn grep(root: &Path, pattern: &str, dir: &str, exts: &[&str]) -> Result<String, String> {
    // fff falls back to literal text on a bad regex; the agent should hear it instead.
    regex::Regex::new(pattern).map_err(|e| format!("bad pattern: {e}"))?;
    let shared = picker(root)?;
    let guard = shared.read().map_err(|e| e.to_string())?;
    let p = guard.as_ref().ok_or("the folder isn't indexed yet")?;
    let query = FFFQuery { raw_query: pattern, constraints: skipped().into_iter().collect(), fuzzy_query: FuzzyQuery::Text(pattern), location: None };
    let options = GrepSearchOptions { mode: GrepMode::Regex, smart_case: false, page_limit: 5000, max_matches_per_file: MAX_HITS, trim_whitespace: true, time_budget_ms: 10_000, ..Default::default() };
    let r = p.grep(&query, &options);
    let mut hits = vec![];
    for m in &r.matches {
        let path = r.files[m.file_index].relative_path(p).replace('\\', "/");
        if !wanted(&path, dir, exts) {
            continue;
        }
        if hits.len() == MAX_HITS {
            hits.push(format!("… ({MAX_HITS} matches shown)"));
            break;
        }
        hits.push(format!("{path}:{}: {}", m.line_number, m.line_content.chars().take(200).collect::<String>()));
    }
    Ok(if hits.is_empty() { "no matches".into() } else { hits.join("\n") })
}

/// Files whose path fuzzy-matches `query` (typos and gaps allowed), best first.
pub(crate) fn find(root: &Path, query: &str, limit: usize) -> Result<String, String> {
    let shared = picker(root)?;
    let guard = shared.read().map_err(|e| e.to_string())?;
    let p = guard.as_ref().ok_or("the folder isn't indexed yet")?;
    let mut q = FFFQuery::parse(query, FileSearchConfig);
    q.constraints.extend(skipped());
    let r = p.fuzzy_search(&q, None, FuzzySearchOptions { pagination: PaginationArgs { offset: 0, limit }, ..Default::default() });
    let paths: Vec<String> = r.items.iter().map(|f| f.relative_path(p).replace('\\', "/")).collect();
    Ok(if paths.is_empty() { "no files match".into() } else { paths.join("\n") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greps_and_finds_outside_dependencies() {
        let dir = std::env::temp_dir().join(format!("fm-file-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("formal/Refinement")).unwrap();
        std::fs::create_dir_all(dir.join("formal/.lake/packages")).unwrap();
        std::fs::write(dir.join("formal/Refinement/WP.lean"), "@[simp] theorem wp_pure : True := trivial\n").unwrap();
        std::fs::write(dir.join("formal/.lake/packages/Dep.lean"), "theorem wp_pure_dep : True := trivial\n").unwrap();
        std::fs::write(dir.join("notes.md"), "theorem wp_pure in a note\n").unwrap();
        let hits = grep(&dir, r"theorem wp_\w+", "formal", &[".lean"]).unwrap();
        assert_eq!(hits, "formal/Refinement/WP.lean:1: @[simp] theorem wp_pure : True := trivial");
        assert!(grep(&dir, "(", "", &[]).unwrap_err().starts_with("bad pattern"));
        assert!(find(&dir, "refinemnt wp", 10).unwrap().starts_with("formal/Refinement/WP.lean"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
