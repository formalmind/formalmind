//! The swarm agents' testing tools: the debugger (the same sessions the Debug view shows, which follows the agent's
//! cursor), solc coverage of the Foundry suite and concolic exploration of its untaken branches (concolity). The
//! agent gets compact JSON; the person sees the agent's debugger move and what it concluded. What the swarm finds or
//! suspects goes to `.formal/findings.sarif` too ([`sarif_add`]), where solidity-language-server shows it on the line.

use crate::debug::{self, Debuggers};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const TOOLS: [&str; 9] = ["debug_open", "debug_run", "debug_move", "debug_break", "debug_watch", "debug_look", "coverage", "explore", "tag"];

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
        json!({ "name": "tag", "description": "Tag a line of the Solidity with a short note the maintainer sees on that line in their editor and that the next agent reads: a suspicion you couldn't confirm yet, an assumption the code makes, an invariant that must hold there, or a todo. Not for confirmed bugs (report_bug those).", "input_schema": s(json!({ "file": { "type": "string", "description": "e.g. src/AsyncSwap.sol" }, "line": { "type": "integer" }, "kind": { "type": "string", "enum": ["suspicion", "assumption", "invariant", "todo"] }, "note": { "type": "string", "description": "One sentence, third person, e.g. \"Rounds in the taker's favour when amountIn < price\"" } }), vec!["file", "line", "kind", "note"]) }),
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
        "tag" => (tag(folder, role, input), None),
        "coverage" => (text(coverage(folder, input).await), None),
        "explore" => (text(explore(folder, input).await), None),
        _ => (format!("error: no tool {name}"), None),
    }
}

/// The tag tool: a note on a line, in the swarm's run of `.formal/findings.sarif`.
pub fn tag(folder: &str, role: &str, input: &Value) -> String {
    let (file, line) = (input["file"].as_str().unwrap_or("").trim_start_matches("./"), input["line"].as_u64().unwrap_or(0) as usize);
    let kind = input["kind"].as_str().unwrap_or("suspicion");
    let note = input["note"].as_str().unwrap_or("").trim();
    if file.is_empty() || line == 0 || note.is_empty() {
        return "error: file, line and note are required".into();
    }
    match sarif_add(std::path::Path::new(folder), &format!("formal-mind/tag/{kind}"), "note", file, line, format!("{kind} ({role}): {note}"), json!({ "kind": kind, "by": role })) {
        Ok(()) => format!("tagged {file}:{line}"),
        Err(e) => format!("error: {e}"),
    }
}

/// Adds one result to the swarm's run in `<root>/.formal/findings.sarif` (SARIF 2.1.0; concolity's runs in the same
/// file are kept). The same rule, place and message again replaces it rather than adding a copy.
pub fn sarif_add(root: &std::path::Path, rule: &str, level: &str, file: &str, line: usize, message: String, properties: Value) -> Result<(), String> {
    const RUN: &str = "formal-mind/swarm/";
    let path = root.join(".formal").join("findings.sarif");
    let mut doc: Value = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| {
        json!({ "$schema": "https://json.schemastore.org/sarif-2.1.0.json", "version": "2.1.0", "runs": [] })
    });
    let runs = doc["runs"].as_array_mut().ok_or("findings.sarif has no runs")?;
    if !runs.iter().any(|r| r["automationDetails"]["id"] == RUN) {
        runs.push(json!({
            "tool": { "driver": { "name": "formal-mind", "informationUri": "https://formal.team", "rules": [] } },
            "automationDetails": { "id": RUN },
            "originalUriBaseIds": { "PROJECT": { "description": { "text": "The project root" } } },
            "results": [],
        }));
    }
    let run = runs.iter_mut().find(|r| r["automationDetails"]["id"] == RUN).expect("just added");
    let rules = run["tool"]["driver"]["rules"].as_array_mut().ok_or("bad rules")?;
    if !rules.iter().any(|r| r["id"] == rule) {
        rules.push(json!({ "id": rule, "defaultConfiguration": { "level": level } }));
    }
    let print = format!("{rule}:{file}:{line}:{message}");
    let results = run["results"].as_array_mut().ok_or("bad results")?;
    results.retain(|r| r["partialFingerprints"]["formal-mind/v1"] != print.as_str());
    results.push(json!({
        "ruleId": rule,
        "level": level,
        "message": { "text": message },
        "locations": [{ "physicalLocation": { "artifactLocation": { "uri": file, "uriBaseId": "PROJECT" }, "region": { "startLine": line.max(1) } } }],
        "partialFingerprints": { "formal-mind/v1": print },
        "properties": properties,
    }));
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap_or_default()).map_err(|e| e.to_string())
}

/// `src/AsyncSwap.sol:446` (or `src/AsyncSwap.sol#L446`) as (file, line); a bare file is line 1.
pub fn location(s: &str) -> Option<(String, usize)> {
    let s = s.trim().trim_matches('`').trim_start_matches("./");
    let (file, line) = s.rsplit_once(":L").or_else(|| s.rsplit_once("#L")).or_else(|| s.rsplit_once(':')).unwrap_or((s, "1"));
    let line = line.split(|c: char| !c.is_ascii_digit()).next().and_then(|n| n.parse().ok()).unwrap_or(1);
    (file.ends_with(".sol") || file.ends_with(".huff")).then(|| (file.to_string(), line))
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

fn fnv64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x0100_0000_01b3))
}

/// What the suite's result depends on: the commit, every change to tracked files, and the untracked files (by size and
/// time). None outside git: no cache.
fn tree_key(folder: &str) -> Option<String> {
    let git = |args: &[&str]| std::process::Command::new("git").arg("-C").arg(folder).args(args).output().ok().filter(|o| o.status.success()).map(|o| o.stdout);
    let head = git(&["rev-parse", "HEAD"])?;
    let diff = git(&["diff", "HEAD", "--binary"])?;
    let untracked = git(&["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut stamp = Vec::new();
    for f in untracked.split(|b| *b == 0).filter(|f| !f.is_empty()) {
        let path = std::path::Path::new(folder).join(String::from_utf8_lossy(f).as_ref());
        if let Ok(m) = std::fs::metadata(&path) {
            stamp.extend_from_slice(f);
            stamp.extend_from_slice(&m.len().to_le_bytes());
            if let Ok(t) = m.modified().map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()) {
                stamp.extend_from_slice(&t.to_le_bytes());
            }
        }
    }
    Some(format!("{:016x}{:016x}{:016x}", fnv64(&head), fnv64(&diff), fnv64(&stamp)))
}

/// Coverage, cached by the tree and the options (~/.formalmind/cache/coverage/): a second hunt on unchanged code gets
/// it at once instead of running the suite again.
async fn coverage(folder: &str, input: &Value) -> Result<Value, String> {
    if !crate::local::read()?.allows(folder) {
        return Err("Add the folder first".into());
    }
    let key = tree_key(folder).map(|t| format!("{t}-{:016x}", fnv64(json!({ "include": input["include"], "skip": input["skip"] }).to_string().as_bytes())));
    let file = key.as_ref().and_then(|k| crate::local::home().ok().map(|h| h.join("cache").join("coverage").join(format!("{:016x}", fnv64(folder.as_bytes()))).join(format!("{k}.json"))));
    if let Some(hit) = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        let mut v = hit;
        v["cached"] = json!("the code hasn't changed since this run; it wasn't run again");
        return Ok(v);
    }
    let v = coverage_fresh(folder, input).await?;
    if let Some(f) = &file {
        let _ = std::fs::create_dir_all(f.parent().unwrap());
        let _ = std::fs::write(f, v.to_string());
    }
    Ok(v)
}

async fn coverage_fresh(folder: &str, input: &Value) -> Result<Value, String> {
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
    fn locations_parse() {
        assert_eq!(super::location("src/AsyncSwap.sol:446"), Some(("src/AsyncSwap.sol".into(), 446)));
        assert_eq!(super::location("`./src/Router.sol#L116`"), Some(("src/Router.sol".into(), 116)));
        assert_eq!(super::location("src/Router.sol:116-120"), Some(("src/Router.sol".into(), 116)));
        assert_eq!(super::location("the router"), None);
    }

    #[test]
    fn swarm_results_keep_concolity_runs() {
        let root = std::env::temp_dir().join(format!("fm-sarif-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".formal")).unwrap();
        std::fs::write(root.join(".formal/findings.sarif"), r#"{"version":"2.1.0","runs":[{"automationDetails":{"id":"concolity/explore/"},"results":[1]}]}"#).unwrap();
        super::sarif_add(&root, "formal-mind/tag/suspicion", "note", "src/A.sol", 3, "x".into(), serde_json::json!({})).unwrap();
        super::sarif_add(&root, "formal-mind/tag/suspicion", "note", "src/A.sol", 3, "x".into(), serde_json::json!({})).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join(".formal/findings.sarif")).unwrap()).unwrap();
        assert_eq!(doc["runs"].as_array().unwrap().len(), 2);
        assert_eq!(doc["runs"][1]["results"].as_array().unwrap().len(), 1, "the same tag twice is one result");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn uncovered_lines_as_ranges() {
        assert_eq!(ranges(vec![9, 3, 4, 5, 12, 13]), "3-5, 9, 12-13");
        assert_eq!(ranges(vec![]), "");
    }
}
