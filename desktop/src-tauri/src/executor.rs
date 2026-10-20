//! The local executor: runs one agent turn on a folder on this machine. The model is called with the user's own
//! key (kept in the keychain); the agent reads and edits files only inside the folder and runs only `lake` and
//! `forge` there. Nothing from the folder is sent to formal.team.
//!
//! Turns are local for now. The protocol's claim / renew / report (docs/protocol.md, section 5) plugs in around
//! `run_turn`: claim a Grant instead of taking the task from the UI, renew while the loop runs, report the outcome.

use crate::local;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_STEPS: usize = 60;
const OUTPUT_LIMIT: usize = 12_000;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
pub struct Runs(Mutex<HashMap<String, Arc<AtomicBool>>>);

fn key_entry() -> Result<Entry, String> {
    Entry::new("team.formal.desktop", "openai").map_err(|e| e.to_string())
}

/// Saves the user's OpenAI key in the keychain (empty clears it).
#[tauri::command]
pub fn model_key_set(key: String) -> Result<(), String> {
    let entry = key_entry()?;
    if key.trim().is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    entry.set_password(key.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn model_key_status() -> bool {
    key_entry().and_then(|e| e.get_password().map_err(|e| e.to_string())).is_ok()
}

#[derive(Deserialize)]
pub struct TurnRequest {
    pub folder: String,
    pub role: String,
    pub task: String,
    pub model: Option<String>,
    /// Stop once the turn has used this many tokens (input + output).
    pub max_tokens: Option<u64>,
}

#[derive(Serialize, Clone)]
struct TurnEvent {
    run: String,
    /// "text" | "tool" | "result" | "done"
    kind: &'static str,
    text: String,
    tokens: u64,
}

/// A run id: time first so they sort.
fn run_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("local-{:x}", nanos)
}

#[tauri::command]
pub fn turn_start(app: AppHandle, runs: State<'_, Runs>, request: TurnRequest) -> Result<String, String> {
    if !local::read()?.folders.contains(&request.folder) {
        return Err("Add the folder first".into());
    }
    let key = key_entry()?.get_password().map_err(|_| "Add your OpenAI key first".to_string())?;
    let run = run_id();
    let stop = Arc::new(AtomicBool::new(false));
    runs.0.lock().unwrap().insert(run.clone(), stop.clone());
    let id = run.clone();
    tauri::async_runtime::spawn(async move {
        let emit = |kind: &'static str, text: String, tokens: u64| {
            let _ = app.emit("turn", TurnEvent { run: id.clone(), kind, text, tokens });
        };
        let (outcome, tokens) = match run_turn(&request, &key, &stop, &emit).await {
            Ok(t) => t,
            Err(e) => (format!("failed: {e}"), 0),
        };
        emit("done", outcome, tokens);
        let state = app.state::<Runs>();
        state.0.lock().unwrap().remove(&id);
    });
    Ok(run)
}

#[tauri::command]
pub fn turn_stop(runs: State<'_, Runs>, run: String) {
    if let Some(stop) = runs.0.lock().unwrap().get(&run) {
        stop.store(true, Ordering::SeqCst);
    }
}


fn instructions(role: &str, folder: &str) -> String {
    let common = format!(
        "You are the formalmind {role}, working in a local folder ({folder}) that holds a Solidity project and its Lean 4 proofs. \
Paths are relative to that folder. Tools: list_files, read_file, run (only `lake …` or `forge …`, no shell){}. \
Be concrete and brief. Finish with a short summary: what you did, what `lake build` says, and what's left.",
        if role == "prover" { ", write_file" } else { "" }
    );
    let job = match role {
        "reviewer" => "Review the proofs for the task: check that the Lean statements say what the Solidity does, that `lake build` passes and that there is no `sorry`, `admit` or new axiom. Do not edit files. End with a verdict: approve, changes (list them) or blocked.",
        _ => "Prove the task in Lean 4: model the Solidity faithfully, state the property, prove it, and check with `lake build`. Never leave `sorry`, `admit` or new axioms; if a proof won't close, say exactly where it's stuck.",
    };
    format!("{common}\n\n{job}")
}

fn tools(role: &str) -> Value {
    let mut tools = vec![
        json!({"type": "function", "name": "list_files", "description": "List files under a directory of the folder (recursive, skips .git, node_modules, lib, out, cache, target, .lake).",
            "parameters": {"type": "object", "properties": {"dir": {"type": "string"}}, "required": ["dir"], "additionalProperties": false}}),
        json!({"type": "function", "name": "read_file", "description": "Read a text file in the folder.",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": false}}),
        json!({"type": "function", "name": "run", "description": "Run `lake build [target]`, `lake env lean <file>`, `forge build` or `forge test [args]` in the folder. Returns exit code and output.",
            "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"], "additionalProperties": false}}),
    ];
    if role == "prover" {
        tools.push(json!({"type": "function", "name": "write_file", "description": "Create or overwrite a file in the folder with the given content.",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"], "additionalProperties": false}}));
    }
    Value::Array(tools)
}

/// A path inside the folder, or an error: relative, no `..`, and (when it exists) not a symlink out of it.
pub(crate) fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // Models often echo the folder's absolute path back; that's fine as long as it points inside.
    let rel = Path::new(rel).strip_prefix(root).unwrap_or(Path::new(rel));
    let rel = rel.strip_prefix("./").unwrap_or(rel);
    let rel = if rel.as_os_str().is_empty() { Path::new(".") } else { rel };
    if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_))) {
        return Err(format!("{} is outside the folder", rel.display()));
    }
    let path = root.join(rel);
    // The nearest part that exists must resolve inside the folder, so a symlinked directory can't lead out.
    let root_real = root.canonicalize().map_err(|e| e.to_string())?;
    let existing = path.ancestors().find(|p| p.exists()).unwrap_or(root);
    let real = existing.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&root_real) {
        return Err(format!("{} is outside the folder", rel.display()));
    }
    Ok(path)
}

pub(crate) fn clip(mut s: String) -> String {
    if s.len() > OUTPUT_LIMIT {
        let mut cut = OUTPUT_LIMIT / 2;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        let tail_start = s.len() - OUTPUT_LIMIT / 2;
        let tail_start = (tail_start..s.len()).find(|&i| s.is_char_boundary(i)).unwrap_or(s.len());
        s = format!("{}\n… [cut] …\n{}", &s[..cut], &s[tail_start..]);
    }
    s
}

/// Where `lake` and `forge` usually live; apps started from the Dock don't get the shell's PATH.
fn tool_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let extra = [format!("{home}/.elan/bin"), format!("{home}/.foundry/bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into()];
    let current = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ";" } else { ":" };
    format!("{}{sep}{current}", extra.join(sep))
}

pub(crate) async fn run_command(root: &Path, command: &str) -> Result<String, String> {
    let argv: Vec<&str> = command.split_whitespace().collect();
    let allowed = match argv.as_slice() {
        ["lake", "build", ..] => true,
        ["lake", "exe", "cache", "get"] => true,
        ["lake", "init" | "new", name, ..] => name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        ["lake", "env", "lean", file] => inside(root, file).is_ok(),
        ["forge", "build" | "test", ..] => true,
        _ => false,
    };
    if !allowed {
        return Err("Only `lake build`, `lake env lean <file>`, `lake exe cache get`, `lake init|new <Name>`, `forge build` and `forge test` may run.".into());
    }
    let child = tokio::process::Command::new(argv[0])
        .args(&argv[1..])
        .current_dir(root)
        .env("PATH", tool_path())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(COMMAND_TIMEOUT, child).await.map_err(|_| "Timed out after 15 minutes".to_string())?.map_err(|e| e.to_string())?;
    let text = format!(
        "exit {}\n{}{}",
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(clip(text))
}

pub(crate) fn list_files(root: &Path, dir: &str) -> Result<String, String> {
    let start = inside(root, if dir.is_empty() { "." } else { dir })?;
    let skip = [".git", "node_modules", "lib", "out", "cache", "target", ".lake", "dist"];
    let mut files = vec![];
    let mut stack = vec![start];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let p = e.path();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if !skip.contains(&name.as_str()) {
                    stack.push(p);
                }
            } else if let Ok(rel) = p.strip_prefix(root) {
                files.push(rel.to_string_lossy().replace('\\', "/"));
            }
            if files.len() >= 2000 {
                break;
            }
        }
    }
    files.sort();
    Ok(clip(files.join("\n")))
}

pub(crate) async fn call_tool(root: &Path, name: &str, args: &Value) -> String {
    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let result = match name {
        "list_files" => list_files(root, &s("dir")),
        "read_file" => inside(root, &s("path")).and_then(|p| std::fs::read_to_string(p).map_err(|e| e.to_string())).map(clip),
        "write_file" => inside(root, &s("path")).and_then(|p| {
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&p, s("content")).map_err(|e| e.to_string()).map(|_| format!("wrote {}", s("path")))
        }),
        "run" => run_command(root, &s("command")).await,
        _ => Err(format!("No tool called {name}")),
    };
    result.unwrap_or_else(|e| format!("error: {e}"))
}

/// The agent loop over the OpenAI Responses API. Returns the outcome and tokens used.
async fn run_turn(request: &TurnRequest, key: &str, stop: &AtomicBool, emit: &impl Fn(&'static str, String, u64)) -> Result<(String, u64), String> {
    let root = PathBuf::from(&request.folder);
    let model = request.model.clone().unwrap_or_else(|| "gpt-6-luna".into());
    let budget = request.max_tokens.unwrap_or(400_000);
    let client = reqwest::Client::new();
    let mut tokens = 0u64;
    let mut previous: Option<String> = None;
    let mut input = json!([{ "role": "user", "content": request.task }]);

    for _ in 0..MAX_STEPS {
        if stop.load(Ordering::SeqCst) {
            return Ok(("stopped".into(), tokens));
        }
        let mut body = json!({ "model": model, "instructions": instructions(&request.role, &request.folder), "input": input, "tools": tools(&request.role) });
        if let Some(id) = &previous {
            body["previous_response_id"] = json!(id);
        }
        let res = client.post("https://api.openai.com/v1/responses").bearer_auth(key).json(&body).send().await.map_err(|e| e.to_string())?;
        let status = res.status();
        let reply: Value = res.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let message = reply["error"]["message"].as_str().unwrap_or("model request failed");
            return Err(format!("{status}: {message}"));
        }
        tokens += reply["usage"]["total_tokens"].as_u64().unwrap_or(0);
        previous = reply["id"].as_str().map(String::from);

        let mut outputs = vec![];
        for item in reply["output"].as_array().cloned().unwrap_or_default() {
            match item["type"].as_str() {
                Some("message") => {
                    let text: String = item["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect();
                    if !text.is_empty() {
                        emit("text", text, tokens);
                    }
                }
                Some("function_call") => {
                    let name = item["name"].as_str().unwrap_or("");
                    let args: Value = serde_json::from_str(item["arguments"].as_str().unwrap_or("{}")).unwrap_or(json!({}));
                    emit("tool", format!("{name} {}", args.as_object().map(|o| o.values().filter_map(Value::as_str).map(|v| v.chars().take(80).collect::<String>()).collect::<Vec<_>>().join(" ")).unwrap_or_default()), tokens);
                    let output = call_tool(&root, name, &args).await;
                    emit("result", output.chars().take(600).collect(), tokens);
                    outputs.push(json!({ "type": "function_call_output", "call_id": item["call_id"], "output": output }));
                }
                _ => {}
            }
        }
        if outputs.is_empty() {
            return Ok(("done".into(), tokens));
        }
        if tokens >= budget {
            return Ok((format!("capped at {tokens} tokens"), tokens));
        }
        input = Value::Array(outputs);
    }
    Ok((format!("stopped after {MAX_STEPS} steps"), tokens))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside() {
        let root = std::env::temp_dir();
        assert!(inside(&root, "src/A.sol").is_ok());
        assert!(inside(&root, "../etc/passwd").is_err());
        assert!(inside(&root, "/etc/passwd").is_err());
        assert!(inside(&root, &root.join("x.lean").to_string_lossy()).is_ok());
        assert!(inside(&root, "").is_ok());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn only_lake_and_forge_run() {
        let root = std::env::temp_dir();
        assert!(run_command(&root, "rm -rf /").await.is_err());
        assert!(run_command(&root, "lake env lean ../x.lean").await.is_err());
        assert!(run_command(&root, "forge script X").await.is_err());
    }
}

/// A real turn against the model: `FM_OPENAI_KEY=… FM_FOLDER=… cargo test -- --ignored live_turn --nocapture`.
#[cfg(test)]
mod live {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    #[ignore]
    async fn live_turn() {
        let request = TurnRequest {
            folder: std::env::var("FM_FOLDER").unwrap(),
            role: std::env::var("FM_ROLE").unwrap_or("prover".into()),
            task: std::env::var("FM_TASK").unwrap(),
            model: None,
            max_tokens: None,
        };
        let stop = AtomicBool::new(false);
        let emit = |kind: &'static str, text: String, tokens: u64| println!("[{kind} {tokens}] {}", text.chars().take(300).collect::<String>());
        let (outcome, tokens) = run_turn(&request, &std::env::var("FM_OPENAI_KEY").unwrap(), &stop, &emit).await.unwrap();
        println!("outcome={outcome} tokens={tokens}");
    }
}
