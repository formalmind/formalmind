//! The swarm agents' shared tools beyond formal-ast and Lean: tags on lines, statements, and forge commands in the
//! background. What the swarm finds or suspects goes to `.formal/findings.sarif` ([`sarif_add`]), where
//! solidity-language-server shows it on the line.

use serde_json::{json, Value};

const TOOLS: [&str; 4] = ["tag", "add_statement", "run_in_background", "background_results"];

pub fn is_tool(name: &str) -> bool {
    TOOLS.contains(&name)
}

pub fn tools() -> Vec<Value> {
    let s = |props: Value, req: Vec<&str>| json!({ "type": "object", "properties": props, "required": req, "additionalProperties": false });
    vec![
        json!({ "name": "tag", "description": "Tag a line of the Solidity with a short note the maintainer sees on that line in their editor and that the next agent reads: a suspicion you couldn't confirm yet, an assumption the code makes, an invariant that must hold there, or a todo. Not for confirmed bugs (report_bug those).", "input_schema": s(json!({ "file": { "type": "string", "description": "e.g. src/AsyncSwap.sol" }, "line": { "type": "integer" }, "kind": { "type": "string", "enum": ["suspicion", "assumption", "invariant", "todo"] }, "note": { "type": "string", "description": "One sentence, third person, e.g. \"Rounds in the taker's favour when amountIn < price\"" } }), vec!["file", "line", "kind", "note"]) }),
        json!({ "name": "run_in_background", "description": "Start a long forge command (`forge test …`, `forge build`) and keep working while it runs. Returns a task number at once; read the result later with background_results.", "input_schema": s(json!({ "command": { "type": "string" } }), vec!["command"]) }),
        json!({ "name": "background_results", "description": "Your background tasks: with no id, each one's tool, status and time so far; with an id, that task's result once it's done (wait: true waits until it is).", "input_schema": s(json!({ "id": { "type": "integer" }, "wait": { "type": "boolean" } }), vec![]) }),
        crate::statements::tool(),
    ]
}

/// Runs one of these tools for `role`.
pub async fn call(folder: &str, role: &str, name: &str, input: &Value) -> String {
    match name {
        "tag" => tag(folder, role, input),
        "add_statement" => crate::statements::add_tool(folder, role, input),
        "run_in_background" => start_task(folder, input),
        "background_results" => task_results(folder, input).await,
        _ => format!("error: no tool {name}"),
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

/// Adds one result to the swarm's run in `<root>/.formal/findings.sarif` (SARIF 2.1.0; other tools' runs in the same
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

// ---- Background tasks ------------------------------------------------------------------------------------------------

/// A task the agent started in the background: what it is, when it started, and its result once done.
struct Task {
    what: String,
    started: std::time::Instant,
    done: tokio::sync::watch::Receiver<Option<String>>,
    /// Its run, so a pause can cancel it (its command's process dies with it: kill_on_drop).
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
    cancel: Option<std::sync::Arc<tokio::sync::watch::Sender<Option<String>>>>,
}

/// Each folder's background tasks, by number.
fn tasks() -> &'static std::sync::Mutex<std::collections::HashMap<String, Vec<Task>>> {
    static TASKS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Vec<Task>>>> = std::sync::OnceLock::new();
    TASKS.get_or_init(Default::default)
}

/// Runs a forge command in the background; returns its task number.
fn spawn_task(folder: &str, command: &str) -> Result<usize, String> {
    if command.trim().is_empty() {
        return Err("run_in_background needs a command".into());
    }
    let what = command.to_string();
    let (tx, rx) = tokio::sync::watch::channel(None);
    let id = {
        let mut all = tasks().lock().unwrap();
        let list = all.entry(folder.to_string()).or_default();
        list.push(Task { what: what.clone(), started: std::time::Instant::now(), done: rx, handle: None, cancel: None });
        list.len()
    };
    let tx = std::sync::Arc::new(tx);
    let folder_s = folder.to_string();
    let task_tx = tx.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let out = crate::swarm2::lake::run(std::path::Path::new(&folder_s), &what).await.unwrap_or_else(|e| format!("error: {e}"));
        let _ = tx.send(Some(out));
    });
    if let Some(t) = tasks().lock().unwrap().get_mut(folder).and_then(|l| l.get_mut(id - 1)) {
        t.handle = Some(handle);
        t.cancel = Some(task_tx);
    }
    Ok(id)
}

/// Cancels the folder's background tasks still running (a pause): each one's process is killed, and anyone waiting on
/// it gets "cancelled". Returns how many were.
pub(crate) fn cancel_tasks(folder: &str) -> usize {
    let mut n = 0;
    for t in tasks().lock().unwrap().get_mut(folder).into_iter().flatten() {
        if t.done.borrow().is_some() {
            continue;
        }
        if let Some(h) = t.handle.take() {
            h.abort();
        }
        if let Some(c) = t.cancel.take() {
            let _ = c.send(Some("cancelled: the swarm was paused".into()));
        }
        n += 1;
    }
    n
}

fn start_task(folder: &str, input: &Value) -> String {
    match spawn_task(folder, input["command"].as_str().unwrap_or("")) {
        Ok(id) => format!("started background task {id}; keep working, and read it with background_results {{\"id\": {id}}} (wait: true to wait for it)"),
        Err(e) => format!("error: {e}"),
    }
}

/// The folder's background tasks: each one's number, what it runs, its status and time so far.
fn task_list(folder: &str) -> Value {
    let all = tasks().lock().unwrap();
    Value::Array(all.get(folder).map(|l| l.iter().enumerate().map(|(i, t)| json!({ "id": i + 1, "task": t.what, "status": if t.done.borrow().is_some() { "done" } else { "running" }, "seconds": t.started.elapsed().as_secs() })).collect()).unwrap_or_default())
}

async fn task_results(folder: &str, input: &Value) -> String {
    let Some(id) = input["id"].as_u64().map(|n| n as usize) else {
        let list = task_list(folder);
        return if list.as_array().is_none_or(|l| l.is_empty()) { "no background tasks".into() } else { list.to_string() };
    };
    let rx = tasks().lock().unwrap().get(folder).and_then(|l| l.get(id.wrapping_sub(1))).map(|t| t.done.clone());
    let Some(mut rx) = rx else { return format!("error: no background task {id}") };
    if input["wait"].as_bool().unwrap_or(false) {
        let _ = rx.wait_for(|v| v.is_some()).await;
    }
    let done = rx.borrow().clone();
    done.unwrap_or_else(|| format!("task {id} is still running; call again with wait: true to wait for it"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn locations_parse() {
        assert_eq!(super::location("src/AsyncSwap.sol:446"), Some(("src/AsyncSwap.sol".into(), 446)));
        assert_eq!(super::location("`./src/Router.sol#L116`"), Some(("src/Router.sol".into(), 116)));
        assert_eq!(super::location("src/Router.sol:116-120"), Some(("src/Router.sol".into(), 116)));
        assert_eq!(super::location("the router"), None);
    }

    #[test]
    fn swarm_results_keep_other_runs() {
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
}
