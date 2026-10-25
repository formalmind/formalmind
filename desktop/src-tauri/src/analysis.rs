//! The swarm agents' testing tools: the debugger (the same sessions the Debug view shows, which follows the agent's
//! cursor), solc coverage of the Foundry suite and concolic exploration of its untaken branches (concolity). The
//! agent gets compact JSON; the person sees the agent's debugger move and what it concluded.

use crate::debug::{self, Debuggers};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const TOOLS: [&str; 8] = ["debug_open", "debug_run", "debug_move", "debug_break", "debug_watch", "debug_look", "coverage", "explore"];

pub fn is_tool(name: &str) -> bool {
    TOOLS.contains(&name)
}

pub fn tools() -> Vec<Value> {
    let s = |props: Value, req: Vec<&str>| json!({ "type": "object", "properties": props, "required": req, "additionalProperties": false });
    vec![
        json!({ "name": "debug_open", "description": "Open a Foundry test file (or a script under script/) in your debugger: solc compiles it and the tests it can run are listed as Contract::test. The maintainer watches your debugger in the app. Opening another file replaces your session.", "input_schema": s(json!({ "file": { "type": "string", "description": "e.g. test/AsyncSwap.t.sol" } }), vec!["file"]) }),
        json!({ "name": "debug_run", "description": "Run one test of the open file in revm, every step recorded (setUp untraced), and stop at the first statement of its body. Returns the verdict (ok, or the revert), gas, the calls it made and where it stopped. A fuzz test runs with `args` (Solidity literals, one per parameter), e.g. inputs explore solved.", "input_schema": s(json!({ "test": { "type": "string", "description": "Contract::test, as debug_open lists them" }, "args": { "type": "array", "items": { "type": "string" } } }), vec!["test"]) }),
        json!({ "name": "debug_move", "description": "Move through the recorded run and see where you are (source line with its neighbours, op, stack top, call, recent storage). `to`: over (next line, over calls), into, out (to the caller), op (one instruction), continue (to the next breakpoint, watched write or revert), first, last, search (next line containing `arg`), step (step number `arg`), pc (`arg` in this frame). `back` moves backwards: the run is recorded, so you can go both ways.", "input_schema": s(json!({ "to": { "type": "string", "enum": ["over", "into", "out", "op", "continue", "first", "last", "search", "step", "pc"] }, "back": { "type": "boolean" }, "arg": { "type": "string" } }), vec!["to"]) }),
        json!({ "name": "debug_break", "description": "Toggle a line breakpoint (in `file`, a source name like AsyncSwap.sol, or the current file); `continue` stops there.", "input_schema": s(json!({ "line": { "type": "integer" }, "file": { "type": "string" } }), vec!["line"]) }),
        json!({ "name": "debug_watch", "description": "Watch storage writes whose named path contains `text` (e.g. priceBooks, orderCount); `continue` stops on each. `on: false` removes it.", "input_schema": s(json!({ "text": { "type": "string" }, "on": { "type": "boolean" } }), vec!["text"]) }),
        json!({ "name": "debug_look", "description": "Read the run without moving: here (the current step), summary (verdict, calls, events), lines (every Solidity line it ran, in order; `filter` keeps functions whose name contains it, e.g. AsyncSwap.beforeSwap), revert (why and where it reverted, decoded), writes (every storage write, named; `filter` keeps variables containing it), step (step `n` in full: stack, memory, storage).", "input_schema": s(json!({ "query": { "type": "string", "enum": ["here", "summary", "lines", "revert", "writes", "step"] }, "filter": { "type": "string" }, "n": { "type": "integer" } }), vec!["query"]) }),
        json!({ "name": "coverage", "description": "Run the Foundry suite in revm with solc's own compile (the optimized bytecode that ships) and report line and branch coverage of src/: per file the lines never run and the JUMPI sides never taken, the tests that failed, and calls into addresses with no code (an interface no test bound to an implementation). Takes about a minute on a large suite.", "input_schema": s(json!({ "include": { "type": "array", "items": { "type": "string" }, "description": "Only files under these prefixes (default src/)" }, "skip": { "type": "array", "items": { "type": "string" }, "description": "Leave out test files whose path contains one of these" } }), vec![]) }),
        json!({ "name": "explore", "description": "Concolic exploration: every JUMPI side coverage never took is a target; fuzz tests are the harnesses; z3 solves for inputs that take the side. Returns, by source line: solved (the inputs, ready for debug_run's args), unsat (unreachable from that test: a dead guard or a test-design gap), unknown, and findings (solved inputs that make a test fail: open them with debug_run). Slow on a whole suite (minutes): narrow it with `only`.", "input_schema": s(json!({ "only": { "type": "string", "description": "Only fuzz tests whose Contract::name contains this" }, "include": { "type": "array", "items": { "type": "string" } }, "skip": { "type": "array", "items": { "type": "string" } }, "timeout_ms": { "type": "integer", "description": "Per solver call (default 1000)" } }), vec![]) }),
    ]
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// Runs one tool for `role`. `session` is the role's debugger, if it opened one; the second value is a newly opened one.
pub async fn call(app: &AppHandle, folder: &str, role: &str, session: Option<u32>, name: &str, input: &Value) -> (String, Option<u32>) {
    let state = app.state::<Debuggers>();
    let need = |s: Option<u32>| s.ok_or_else(|| "error: open a test file first (debug_open)".to_string());
    let text = |r: Result<Value, String>| r.map(|v| serde_json::to_string(&v).unwrap_or_default()).unwrap_or_else(|e| format!("error: {e}"));
    match name {
        "debug_open" => {
            let file = input["file"].as_str().unwrap_or("").trim_start_matches("./").to_string();
            if let Some(old) = session {
                debug::close(&state, old);
            }
            match debug::open(&state, folder.to_string(), file.clone(), Some(app.clone())).await {
                Ok(o) => {
                    let tests = debug::test_names(&o);
                    let id = o_id(&o);
                    debug::follow(app, folder, role, id, "opened", json!({ "file": file, "tests": serde_json::to_value(&o).unwrap_or_default() }));
                    (text(Ok(json!({ "file": file, "tests": tests }))), Some(id))
                }
                Err(e) => (format!("error: {e}"), None),
            }
        }
        "debug_run" => {
            let Ok(id) = need(session) else { return (need(session).unwrap_err(), None) };
            let test = input["test"].as_str().unwrap_or("");
            let Some((contract, test)) = test.split_once("::") else { return ("error: write the test as Contract::test".into(), None) };
            match debug::agent_run(&state, id, contract.to_string(), test.to_string(), strings(&input["args"]), Some(app.clone())).await {
                Ok((rv, summary)) => {
                    debug::follow(app, folder, role, id, "ran", serde_json::to_value(&rv).unwrap_or_default());
                    (text(Ok(summary)), None)
                }
                Err(e) => (format!("error: {e}"), None),
            }
        }
        "debug_move" => {
            let Ok(id) = need(session) else { return (need(session).unwrap_err(), None) };
            let to = input["to"].as_str().unwrap_or("over").to_string();
            match debug::agent_move(&state, id, to, input["back"].as_bool().unwrap_or(false), input["arg"].as_str().map(str::to_string)).await {
                Ok((view, here)) => {
                    debug::follow(app, folder, role, id, "moved", serde_json::to_value(&view).unwrap_or_default());
                    (text(Ok(here)), None)
                }
                Err(e) => (format!("error: {e}"), None),
            }
        }
        "debug_break" | "debug_watch" => {
            let Ok(id) = need(session) else { return (need(session).unwrap_err(), None) };
            let view = if name == "debug_break" {
                let line = input["line"].as_u64().unwrap_or(0) as usize;
                debug::toggle_break(&state, id, line, None, input["file"].as_str().map(str::to_string), false).await
            } else {
                debug::watch(&state, id, input["text"].as_str().unwrap_or("").to_string(), input["on"].as_bool().unwrap_or(true), false).await
            };
            match view {
                Ok(view) => {
                    debug::follow(app, folder, role, id, "moved", serde_json::to_value(&view).unwrap_or_default());
                    (text(debug::agent_here(&state, id).await), None)
                }
                Err(e) => (format!("error: {e}"), None),
            }
        }
        "debug_look" => {
            let Ok(id) = need(session) else { return (need(session).unwrap_err(), None) };
            let r = debug::agent_look(&state, id, input["query"].as_str().unwrap_or("here").to_string(), input["filter"].as_str().map(str::to_string), input["n"].as_u64().map(|n| n as usize)).await;
            (text(r), None)
        }
        "coverage" => (text(coverage(folder, input).await), None),
        "explore" => (text(explore(folder, input).await), None),
        _ => (format!("error: no tool {name}"), None),
    }
}

fn o_id(o: &debug::Opened) -> u32 {
    serde_json::to_value(o).ok().and_then(|v| v["id"].as_u64()).unwrap_or(0) as u32
}

fn coverage_opts(folder: &str, input: &Value) -> concolity::coverage::Options {
    let include = strings(&input["include"]);
    concolity::coverage::Options {
        root: PathBuf::from(folder),
        test_dir: "test".into(),
        skip: strings(&input["skip"]),
        include: if include.is_empty() { vec!["src/".into()] } else { include },
        fuzz_runs: 32,
        fast: false,
    }
}

/// `[3, 4, 5, 9]` as `3-5, 9`: a file's uncovered lines stay short.
fn ranges(mut lines: Vec<usize>) -> String {
    lines.sort_unstable();
    let mut out: Vec<String> = vec![];
    let mut i = 0;
    while i < lines.len() {
        let mut j = i;
        while j + 1 < lines.len() && lines[j + 1] == lines[j] + 1 {
            j += 1;
        }
        out.push(if i == j { lines[i].to_string() } else { format!("{}-{}", lines[i], lines[j]) });
        i = j + 1;
    }
    out.join(", ")
}

async fn coverage(folder: &str, input: &Value) -> Result<Value, String> {
    if !crate::local::read()?.allows(folder) {
        return Err("Add the folder first".into());
    }
    let opts = coverage_opts(folder, input);
    let report = tauri::async_runtime::spawn_blocking(move || concolity::coverage::run(&opts)).await.map_err(|e| e.to_string())?.map_err(|e| format!("{e:#}"))?;
    let files: Vec<Value> = report
        .files
        .iter()
        .map(|(file, f)| {
            let (lh, lt) = f.lines_hit();
            let (bh, bt) = f.sides_hit();
            let uncovered = f.lines.iter().filter(|(_, n)| **n == 0).map(|(l, _)| *l).collect();
            let mut untaken: Vec<String> = f
                .branches
                .iter()
                .flat_map(|((line, _, _), (j, fl))| [(*j == 0).then(|| format!("{line} jump")), (*fl == 0).then(|| format!("{line} fall"))])
                .flatten()
                .collect();
            untaken.dedup();
            json!({ "file": file, "lines": format!("{lh}/{lt}"), "sides": format!("{bh}/{bt}"), "uncovered_lines": ranges(uncovered), "untaken_sides": untaken })
        })
        .collect();
    let failed: Vec<Value> = report
        .tests
        .iter()
        .filter_map(|t| match &t.status {
            concolity::coverage::Status::Fail(why) => Some(json!({ "test": format!("{}::{}", t.contract, t.test), "why": why })),
            _ => None,
        })
        .collect();
    let passed = report.tests.iter().filter(|t| t.status == concolity::coverage::Status::Pass).count();
    let missing: Vec<Value> = report.bindings.iter().filter(|b| b.missing && !b.varying).map(|b| json!({ "site": b.site, "callee": b.callee, "count": b.count })).collect();
    Ok(json!({
        "tests": { "passed": passed, "failed": failed, "total": report.tests.len() },
        "files": files,
        "missing_bytecode": missing,
        "compile_errors": report.compile_errors,
        "seconds": (report.compile_time + report.run_time).as_secs(),
    }))
}

async fn explore(folder: &str, input: &Value) -> Result<Value, String> {
    if !crate::local::read()?.allows(folder) {
        return Err("Add the folder first".into());
    }
    if std::process::Command::new("z3").arg("--version").output().is_err() {
        return Err("explore needs z3 on the PATH (brew install z3)".into());
    }
    let opts = concolity::explore::Options {
        coverage: coverage_opts(folder, input),
        runs_per_test: 12,
        flips_per_run: 6,
        timeout_ms: input["timeout_ms"].as_u64().unwrap_or(1000) as u32,
        seeds: 2,
        only: input["only"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
    };
    let report = tauri::async_runtime::spawn_blocking(move || concolity::explore::run(&opts)).await.map_err(|e| e.to_string())?.map_err(|e| format!("{e:#}"))?;
    let full = report.to_json();
    // The agent gets the sides something was learned about; the rest are counted.
    let mut counts = serde_json::Map::new();
    let mut by_line = vec![];
    for t in full["targets"].as_array().into_iter().flatten() {
        let o = t["outcome"].as_str().unwrap_or("");
        *counts.entry(o.to_string()).or_insert(json!(0)) = json!(counts.get(o).and_then(Value::as_u64).unwrap_or(0) + 1);
        if matches!(o, "solved" | "unsat" | "unsat_pinned" | "unknown") {
            by_line.push(json!({ "at": format!("{}:{}", t["file"].as_str().unwrap_or(""), t["line"]), "side": if t["jumped"].as_bool() == Some(true) { "jump" } else { "fall" }, "outcome": o, "test": t["test"], "args": t["args"], "test_failed": t["test_failed"] }));
        }
    }
    Ok(json!({
        "untaken_sides": counts,
        "learned": by_line,
        "findings": full["findings"],
        "model_mismatches": full["mismatches"],
        "runs": full["runs"],
        "solver_calls": full["solver_calls"],
        "seconds": full["ms"].as_u64().unwrap_or(0) / 1000,
    }))
}

#[cfg(test)]
mod tests {
    use super::ranges;

    /// The coverage tool on Async Swap (an added folder), as an agent gets it.
    #[test]
    #[ignore]
    fn coverage_of_async_swap() {
        let root = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join("developer/asyncswap/contracts");
        let v = tauri::async_runtime::block_on(super::coverage(&root.display().to_string(), &serde_json::json!({ "skip": ["test/formal/AsyncSwapBeforeSwap.t.sol"] }))).unwrap();
        assert!(v["tests"]["passed"].as_u64().unwrap() > 800, "{}", v["tests"]);
        let f = v["files"].as_array().unwrap().iter().find(|f| f["file"] == "src/AsyncSwap.sol").expect("AsyncSwap.sol covered");
        assert!(f["uncovered_lines"].is_string() && f["untaken_sides"].is_array(), "{f}");
        eprintln!("{}", serde_json::to_string(&v).unwrap().len());
    }

    #[test]
    fn uncovered_lines_as_ranges() {
        assert_eq!(ranges(vec![9, 3, 4, 5, 12, 13]), "3-5, 9, 12-13");
        assert_eq!(ranges(vec![]), "");
    }
}
