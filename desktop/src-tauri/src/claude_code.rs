//! The hunter on Claude Code: `claude -p` with your own Claude plan (Max, Pro, or whatever `claude` is logged in to),
//! instead of formal.team credits or an API key. The app serves the hunter's tools (its debugger, coverage, explore, tag,
//! report_bug) over MCP on 127.0.0.1 for the one run, with a token, so Claude Code drives the same debugger sessions the
//! Concolic tab follows; Claude Code's own Read/Write/Edit/Glob/Grep and `forge` do the rest. Its stream-json output
//! becomes the session's events (the chat and the canvas). The run's own state (the MCP config with its token, the
//! Claude session id, the raw stream and stderr) lives in ~/.formalmind/claude-code/, not in the project; what the
//! project keeps is what it needs: the session's events (.formal/runs), findings and PoCs.

use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

const ROLE: &str = "hunter";
const ITEM: &str = "hunt";

/// The `claude` binary: the tool folders first (a GUI app's PATH doesn't have ~/.local/bin), then PATH.
fn claude() -> PathBuf {
    crate::platform::find_tool("claude")
}

/// Whether Claude Code is installed, and its version (for Settings).
#[tauri::command(async)]
pub fn claude_code_status() -> Result<String, String> {
    let out = std::process::Command::new(claude()).arg("--version").env("PATH", crate::platform::tool_path(None)).output().map_err(|_| "Claude Code isn't installed (claude.com/claude-code)".to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ---- The tools, over MCP ---------------------------------------------------------------------------------------------

struct Served {
    /// The app (its debugger sessions and events); None in tests, where only `tag` works.
    app: Option<AppHandle>,
    folder: String,
    run: String,
    token: String,
    /// The hunter's debugger session (the Debug view follows it).
    debug: Mutex<Option<u32>>,
    /// The last bug filed, for the job's outcome.
    bug: Mutex<Option<String>>,
}

/// An MCP endpoint for one run; dropping it stops the server.
pub struct Server {
    pub url: String,
    pub token: String,
    stop: Arc<AtomicBool>,
    served: Arc<Served>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn tool_list() -> Vec<Value> {
    let mut all: Vec<Value> = crate::analysis::tools();
    all.push(crate::swarm::report_bug_tool());
    // MCP calls the schema inputSchema.
    all.into_iter()
        .map(|mut t| {
            if let Some(schema) = t.as_object_mut().and_then(|o| o.remove("input_schema")) {
                t["inputSchema"] = schema;
            }
            t
        })
        .collect()
}

/// One JSON-RPC message; None for a notification (no reply).
fn handle(s: &Served, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let reply = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let method = msg["method"].as_str().unwrap_or("");
    Some(match method {
        "initialize" => reply(json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "formalmind", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "Formal Mind's testing tools for this Foundry project: an EVM debugger the maintainer watches, solc coverage, concolic exploration (concolity), tags on lines, and report_bug for proven bugs.",
        })),
        "ping" => reply(json!({})),
        "tools/list" => reply(json!({ "tools": tool_list() })),
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or("").to_string();
            let args = msg["params"]["arguments"].clone();
            let text = tauri::async_runtime::block_on(call(s, &name, &args));
            let is_error = text.starts_with("error:");
            reply(json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
        }
        _ => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("no method {method}") } }),
    })
}

async fn call(s: &Served, name: &str, args: &Value) -> String {
    if name == "tag" {
        return crate::analysis::tag(&s.folder, ROLE, args);
    }
    let Some(app) = &s.app else { return format!("error: {name} needs the app") };
    if name == "report_bug" {
        let root = PathBuf::from(&s.folder);
        return match crate::swarm::file_bug(app, &s.folder, &s.run, &root, args, ROLE, ITEM).await {
            Ok((id, file)) => {
                *s.bug.lock().unwrap() = Some(format!("{id} {}", args["title"].as_str().unwrap_or("bug")));
                format!("filed as {id} in audit/README.md (open) and {file}, and on its line in .formal/findings.sarif")
            }
            Err(e) => format!("error: {e}"),
        };
    }
    if !crate::analysis::is_tool(name) {
        return format!("error: no tool {name}");
    }
    let session = *s.debug.lock().unwrap();
    let (text, opened) = crate::analysis::call(app, &s.folder, ROLE, session, name, args).await;
    if let Some(id) = opened {
        *s.debug.lock().unwrap() = Some(id);
    }
    text
}

/// Serves the hunter's tools on 127.0.0.1 (a free port) until the Server is dropped.
pub fn serve(app: Option<AppHandle>, folder: String, run: String) -> Result<Server, String> {
    let http = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = http.server_addr().to_ip().map(|a| a.port()).ok_or("no port")?;
    let token = format!("{:016x}{:016x}", rand64(), rand64());
    let stop = Arc::new(AtomicBool::new(false));
    let served = Arc::new(Served { app, folder, run, token: token.clone(), debug: Mutex::new(None), bug: Mutex::new(None) });
    let (st, sv) = (stop.clone(), served.clone());
    std::thread::Builder::new()
        .name("formalmind-mcp".into())
        .spawn(move || {
            while !st.load(Ordering::SeqCst) {
                let Ok(Some(mut req)) = http.recv_timeout(Duration::from_millis(300)) else { continue };
                let authed = req.headers().iter().any(|h| h.field.equiv("Authorization") && h.value.as_str() == format!("Bearer {}", sv.token));
                if !authed {
                    let _ = req.respond(tiny_http::Response::empty(401));
                    continue;
                }
                if req.method() != &tiny_http::Method::Post {
                    let _ = req.respond(tiny_http::Response::empty(405));
                    continue;
                }
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let msg: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                // A batch is answered as a batch; notifications get 202.
                let out = match &msg {
                    Value::Array(all) => {
                        let replies: Vec<Value> = all.iter().filter_map(|m| handle(&sv, m)).collect();
                        (!replies.is_empty()).then(|| Value::Array(replies))
                    }
                    m => handle(&sv, m),
                };
                let res = match out {
                    Some(v) => tiny_http::Response::from_string(v.to_string()).with_header("Content-Type: application/json".parse::<tiny_http::Header>().unwrap()).boxed(),
                    None => tiny_http::Response::empty(202).boxed(),
                };
                let _ = req.respond(res);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Server { url: format!("http://127.0.0.1:{port}/mcp"), token, stop, served })
}

fn rand64() -> u64 {
    let mut h = DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut h);
    std::process::id().hash(&mut h);
    std::thread::current().id().hash(&mut h);
    let x = 0u8;
    (&x as *const u8 as usize).hash(&mut h);
    h.finish()
}

// ---- The run ---------------------------------------------------------------------------------------------------------

/// FNV-1a: a short name for a folder that stays the same across Rust versions (DefaultHasher doesn't promise that).
fn fnv(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5u32, |h, b| (h ^ *b as u32).wrapping_mul(0x0100_0193))
}

/// A run's state folder under `base` (~/.formalmind): claude-code/<project>-<hash>/<session>/.
fn state_dir_in(base: &std::path::Path, root: &std::path::Path, run: &str) -> PathBuf {
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "project".into());
    base.join("claude-code").join(format!("{name}-{:08x}", fnv(root.to_string_lossy().as_bytes()))).join(run)
}

/// Writes a file only you can read (the MCP config carries the run's token).
fn write_private(path: &std::path::Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(path).and_then(|mut f| f.write_all(text.as_bytes())).map_err(|e| format!("{}: {e}", path.display()))
}

/// The Claude Code session id for a job (stable, so an interrupted hunt resumes the same conversation).
fn session_id(folder: &str, run: &str, job: u64) -> String {
    let half = |seed: u8| {
        let mut h = DefaultHasher::new();
        (seed, folder, run, job).hash(&mut h);
        h.finish()
    };
    let (a, b) = (half(1), half(2));
    // A version-4-shaped UUID (Claude Code checks the shape).
    format!("{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}", (a >> 32) as u32, (a >> 16) as u16, a as u16 & 0x0fff, (b >> 48) as u16 & 0x3fff | 0x8000, b & 0xffff_ffff_ffff)
}

fn system_prompt(folder: &str) -> String {
    format!(
        "You are Formal Mind's hunter, working in the Foundry project at {folder} (paths are relative to it). \
Your testing tools are the formalmind MCP tools: coverage, explore, debug_open, debug_run, debug_move, debug_break, debug_watch, debug_look, tag and report_bug. \
The maintainer watches your debugger in Formal Mind while you work. Read, Glob, Grep, Write and Edit work on the project's files, and Bash runs `forge test` and `forge build` only.\n\n{}",
        crate::swarm::HUNTER
    )
}

/// What one line of Claude Code's stream-json says, as session events.
fn events_of(line: &Value) -> Vec<(&'static str, String)> {
    let mut out = vec![];
    match line["type"].as_str() {
        Some("system") if line["subtype"] == "init" => {
            let mcp = line["mcp_servers"].as_array().and_then(|a| a.iter().find(|m| m["name"] == "formalmind")).and_then(|m| m["status"].as_str()).unwrap_or("missing");
            // apiKeySource "none" is the claude login (your Claude plan); anything else names the key it found.
            let billing = match line["apiKeySource"].as_str() {
                Some("none") | None => "your Claude plan".to_string(),
                Some(k) => format!("API key from {k}"),
            };
            out.push(("status", format!("Claude Code {} · {} · {billing} · in {} · tools {}", line["claude_code_version"].as_str().unwrap_or(""), line["model"].as_str().unwrap_or(""), line["cwd"].as_str().unwrap_or("?"), mcp)));
        }
        Some("assistant") => {
            for c in line["message"]["content"].as_array().into_iter().flatten() {
                match c["type"].as_str() {
                    Some("text") => {
                        let t = c["text"].as_str().unwrap_or("").trim();
                        if !t.is_empty() {
                            out.push(("say", t.to_string()));
                        }
                    }
                    Some("tool_use") => {
                        let name = c["name"].as_str().unwrap_or("").trim_start_matches("mcp__formalmind__");
                        let shown = c["input"].as_object().map(|o| o.values().filter_map(Value::as_str).map(|v| v.chars().take(90).collect::<String>()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
                        out.push(("tool", format!("{name} {shown}").trim().to_string()));
                    }
                    _ => {}
                }
            }
        }
        Some("user") => {
            for c in line["message"]["content"].as_array().into_iter().flatten().filter(|c| c["type"] == "tool_result") {
                let text = match &c["content"] {
                    Value::String(t) => t.clone(),
                    Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
                    _ => String::new(),
                };
                out.push(("result", text.chars().take(500).collect()));
            }
        }
        _ => {}
    }
    out
}

/// Runs the hunt on Claude Code; returns the summary and the last bug filed.
#[allow(clippy::too_many_arguments)]
pub async fn hunt(app: &AppHandle, folder: &str, run: &str, job: u64, resumed: bool, focus: &str, model: Option<&str>, stop: &AtomicBool) -> Result<(String, Option<String>), String> {
    use tokio::io::AsyncBufReadExt;
    let emit = |kind: &'static str, text: String| crate::swarm::emit_as(app, folder, run, kind, ROLE, ITEM, text);
    // The project itself, resolved (symlinks, /tmp → /private/tmp), so the check below compares like with like.
    let root = std::fs::canonicalize(folder).map_err(|e| format!("{folder}: {e}"))?;
    let server = serve(Some(app.clone()), folder.to_string(), run.to_string())?;
    let state = state_dir_in(&crate::local::home()?, &root, run);
    std::fs::create_dir_all(&state).map_err(|e| format!("{}: {e}", state.display()))?;
    let mcp = json!({ "mcpServers": { "formalmind": { "type": "http", "url": server.url, "headers": { "Authorization": format!("Bearer {}", server.token) } } } });
    let mcp_file = state.join("mcp.json");
    write_private(&mcp_file, &serde_json::to_string_pretty(&mcp).unwrap_or_default())?;
    // The Claude session this job talks in: kept with the run, so a resumed hunt picks the same conversation.
    let session_file = state.join("session.json");
    let saved: Option<Value> = std::fs::read_to_string(&session_file).ok().and_then(|t| serde_json::from_str(&t).ok());
    let sid = saved.as_ref().filter(|v| v["job"] == job).and_then(|v| v["session_id"].as_str().map(str::to_string)).unwrap_or_else(|| session_id(folder, run, job));
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    write_private(&session_file, &serde_json::to_string_pretty(&json!({ "session_id": sid, "job": job, "project": root, "run": run, "resumed": resumed, "started": started })).unwrap_or_default())?;
    let open_log = |name: &str| std::fs::OpenOptions::new().create(true).append(true).open(state.join(name)).map_err(|e| format!("{name}: {e}"));
    let mut stream_log = open_log("stream.jsonl")?;
    let task = format!("Hunt for vulnerabilities in {focus}.");
    let mut cmd = tokio::process::Command::new(claude());
    cmd.current_dir(&root)
        .arg("-p")
        .arg(if resumed { "The app quit and this hunt is being resumed. Carry on from where you were; don't redo finished work." } else { task.as_str() })
        .args(["--output-format", "stream-json", "--verbose"])
        .arg("--append-system-prompt")
        .arg(system_prompt(folder))
        .arg("--mcp-config")
        .arg(&mcp_file)
        .arg("--strict-mcp-config")
        // The project's settings only: your own hooks, plugins and permission rules stay out of the hunter's session.
        .args(["--setting-sources", "project,local"])
        .arg("--add-dir")
        .arg(&root)
        .arg("--allowedTools")
        .args(["mcp__formalmind", "Read", "Glob", "Grep", "Write", "Edit", "Bash(forge test:*)", "Bash(forge build:*)"])
        .args(if resumed { ["--resume", sid.as_str()] } else { ["--session-id", sid.as_str()] })
        .env("PATH", crate::platform::tool_path(None))
        .env("PWD", &root)
        // Your Claude plan, not an API key that happens to be in the environment.
        .env_remove("ANTHROPIC_API_KEY")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::from(open_log("stderr.log")?))
        .kill_on_drop(true);
    if let Some(m) = model.filter(|m| m.starts_with("claude-")) {
        cmd.arg("--model").arg(m);
    }
    emit("status", "starting Claude Code".into());
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start Claude Code ({}): {e}", claude().display()))?;
    let mut lines = tokio::io::BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();
    let mut summary = String::new();
    let mut failed: Option<String> = None;
    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            return Ok(("paused".into(), server.served.bug.lock().unwrap().clone()));
        }
        let next = tokio::time::timeout(Duration::from_millis(500), lines.next_line()).await;
        let line = match next {
            Err(_) => continue,
            Ok(Ok(Some(l))) => l,
            Ok(Ok(None)) | Ok(Err(_)) => break,
        };
        {
            use std::io::Write;
            let _ = writeln!(stream_log, "{line}");
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        // It must be working in the project: anywhere else, its edits and `forge test` would land in the wrong place.
        if v["type"] == "system" && v["subtype"] == "init" {
            let cwd = v["cwd"].as_str().map(PathBuf::from).and_then(|p| std::fs::canonicalize(p).ok());
            if cwd.as_deref() != Some(root.as_path()) {
                let _ = child.kill().await;
                return Err(format!("Claude Code started in {}, not the project {}", v["cwd"].as_str().unwrap_or("?"), root.display()));
            }
        }
        if v["type"] == "result" {
            summary = v["result"].as_str().unwrap_or("").to_string();
            if v["is_error"] == true || v["subtype"].as_str().is_some_and(|s| s != "success") {
                failed = Some(format!("Claude Code stopped: {}", v["subtype"].as_str().unwrap_or("error")));
            }
            continue;
        }
        for (kind, text) in events_of(&v) {
            emit(kind, text);
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if !status.success() && summary.is_empty() {
        let err = std::fs::read_to_string(state.join("stderr.log")).unwrap_or_default();
        let tail: String = err.trim().chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("Claude Code exited with {status}: {tail} (logs in {})", state.display()));
    }
    if let Some(f) = failed {
        emit("status", f);
    }
    let bug = server.served.bug.lock().unwrap().clone();
    Ok((summary, bug))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_are_stable_uuids() {
        let a = session_id("/p", "hunt-1", 1);
        assert_eq!(a, session_id("/p", "hunt-1", 1));
        assert_ne!(a, session_id("/p", "hunt-1", 2));
        let parts: Vec<&str> = a.split('-').collect();
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), [8, 4, 4, 4, 12], "{a}");
        assert!(parts[2].starts_with('4'));
    }

    #[test]
    fn stream_lines_become_events() {
        let tool = json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Coverage first." }, { "type": "tool_use", "name": "mcp__formalmind__coverage", "input": { "skip": [] } }] } });
        assert_eq!(events_of(&tool), [("say", "Coverage first.".to_string()), ("tool", "coverage".to_string())]);
        let result = json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "content": [{ "type": "text", "text": "{\"tests\":1}" }] }] } });
        assert_eq!(events_of(&result), [("result", "{\"tests\":1}".to_string())]);
    }

    /// Claude Code on your plan, against the app's MCP server: it must see the tools and call one (tag, which writes
    /// .formal/findings.sarif). Needs `claude` logged in; spends a little of your plan's usage.
    #[test]
    #[ignore]
    fn claude_code_calls_the_served_tools() {
        let dir = std::env::temp_dir().join(format!("fm-claude-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/A.sol"), "contract A {}\n").unwrap();
        let server = serve(None, dir.display().to_string(), "hunt-test".into()).unwrap();
        let mcp = json!({ "mcpServers": { "formalmind": { "type": "http", "url": server.url, "headers": { "Authorization": format!("Bearer {}", server.token) } } } });
        // As hunt() passes it: a private file, not the JSON inline.
        let mcp_file = std::env::temp_dir().join(format!("fm-claude-mcp-{}.json", std::process::id()));
        write_private(&mcp_file, &mcp.to_string()).unwrap();
        let out = std::process::Command::new(claude())
            .current_dir(&dir)
            .args(["--setting-sources", "project,local"])
            .args(["-p", "Call the formalmind tag tool once with file src/A.sol, line 1, kind todo, note \"checked by the test\". Then reply with the single word done.", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--allowedTools", "mcp__formalmind", "--mcp-config"])
            .arg(&mcp_file)
            .env("PATH", crate::platform::tool_path(None))
            .env_remove("ANTHROPIC_API_KEY")
            .output()
            .unwrap();
        let lines: Vec<Value> = String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        let events: Vec<(&str, String)> = lines.iter().flat_map(events_of).collect();
        assert!(events.iter().any(|(k, t)| *k == "status" && t.ends_with("tools connected")), "{events:?}\n{}", String::from_utf8_lossy(&out.stderr));
        let init = lines.iter().find(|l| l["type"] == "system" && l["subtype"] == "init").unwrap();
        assert_eq!(std::fs::canonicalize(init["cwd"].as_str().unwrap()).unwrap(), std::fs::canonicalize(&dir).unwrap(), "runs in the project");
        assert!(events.iter().any(|(k, t)| *k == "tool" && t.starts_with("tag")), "{events:?}");
        let sarif = std::fs::read_to_string(dir.join(".formal/findings.sarif")).unwrap();
        assert!(sarif.contains("checked by the test") && sarif.contains("formal-mind/tag/todo"), "{sarif}");
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_file(mcp_file);
    }

    #[test]
    fn state_lives_under_formalmind_by_project_and_session() {
        let base = std::path::Path::new("/home/me/.formalmind");
        let a = state_dir_in(base, std::path::Path::new("/work/contracts"), "hunt-1");
        assert!(a.to_string_lossy().starts_with("/home/me/.formalmind/claude-code/contracts-"), "{}", a.display());
        assert!(a.ends_with("hunt-1"));
        assert_ne!(a.parent(), state_dir_in(base, std::path::Path::new("/other/contracts"), "hunt-1").parent(), "two projects of the same name");
        assert_eq!(fnv(b"a"), 0xe40c292c, "FNV-1a, stable");
    }

    #[cfg(unix)]
    #[test]
    fn the_mcp_config_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let p = std::env::temp_dir().join(format!("fm-mcp-{}.json", std::process::id()));
        write_private(&p, "{}").unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn tools_are_listed_with_input_schemas() {
        let list = tool_list();
        assert!(list.iter().any(|t| t["name"] == "report_bug") && list.iter().any(|t| t["name"] == "debug_run"));
        assert!(list.iter().all(|t| t.get("inputSchema").is_some() && t.get("input_schema").is_none()));
    }
}
