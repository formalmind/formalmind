//! The agents on Claude Code: `claude -p` with your own Claude plan (Max, Pro, or whatever `claude` is logged in to),
//! instead of an API key. The swarm's roles (prover, reviewer, assistant, auditor) run with their own prompt and tools
//! only, served by the swarm's loop over a Bridge (`start_role`). Their stream-json output becomes the session's events
//! (the chat and the canvas). The run's own state (the MCP config with its token, the Claude session id, the raw
//! stream and stderr) lives in ~/.formalmind/claude-code/, not in the project; what the project keeps is what it
//! needs: the session's events (.formal/runs), findings and PoCs.

use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// The `claude` binary: the tool folders first (a GUI app's PATH doesn't have ~/.local/bin), then PATH.
fn claude() -> PathBuf {
    crate::platform::find_tool("claude")
}

/// Whether Claude Code is installed and signed in: its version and what it bills (for Settings).
#[tauri::command(async)]
pub fn claude_code_status() -> Result<String, String> {
    let out = std::process::Command::new(claude()).arg("--version").env("PATH", crate::platform::tool_path(None)).output().map_err(|_| "Claude Code isn't installed (claude.com/claude-code)".to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().trim_end_matches("(Claude Code)").trim().to_string();
    Ok(format!("Claude Code {version} · {}", signed_in()?))
}

/// What `claude auth status` says it's signed in to, as the app runs it (no ANTHROPIC_API_KEY), e.g. "your Claude Max
/// plan". The sign-in is Claude Code's own (`claude` then /login): the app never sees or keeps its credentials.
pub fn signed_in() -> Result<String, String> {
    let out = std::process::Command::new(claude())
        .args(["auth", "status", "--json"])
        .env("PATH", crate::platform::tool_path(None))
        .env_remove("ANTHROPIC_API_KEY")
        .output()
        .map_err(|_| "Claude Code isn't installed (claude.com/claude-code)".to_string())?;
    let status: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    billing_of(&status)
}

fn billing_of(status: &Value) -> Result<String, String> {
    if status["loggedIn"] != true {
        return Err("Claude Code isn't signed in: run `claude` in a terminal and sign in with /login".into());
    }
    Ok(match (status["authMethod"].as_str(), status["subscriptionType"].as_str()) {
        (Some("claude.ai"), Some(plan)) if !plan.is_empty() => format!("signed in to your Claude {} plan", capitalized(plan)),
        (Some("claude.ai"), _) => "signed in to your Claude plan".into(),
        (Some(m), _) => format!("signed in ({m})"),
        _ => "signed in".into(),
    })
}

fn capitalized(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

// ---- The tools, over MCP ---------------------------------------------------------------------------------------------

/// The API's tool definitions as MCP lists them (MCP calls the schema inputSchema).
pub fn mcp_tools(tools: Vec<Value>) -> Vec<Value> {
    tools
        .into_iter()
        .map(|mut t| {
            if let Some(schema) = t.as_object_mut().and_then(|o| o.remove("input_schema")) {
                t["inputSchema"] = schema;
            }
            t
        })
        .collect()
}

/// What a JSON-RPC message asks of the server: a reply it can give at once (None for a notification), or a tool call.
pub enum Rpc {
    Reply(Option<Value>),
    Tool { id: Value, name: String, args: Value },
}

pub fn rpc(msg: &Value, tools: &[Value], instructions: &str) -> Rpc {
    let Some(id) = msg.get("id").cloned() else { return Rpc::Reply(None) };
    let reply = |result: Value| Rpc::Reply(Some(json!({ "jsonrpc": "2.0", "id": id, "result": result })));
    let method = msg["method"].as_str().unwrap_or("");
    match method {
        "initialize" => reply(json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "formalmind", "version": env!("CARGO_PKG_VERSION") },
            "instructions": instructions,
        })),
        "ping" => reply(json!({})),
        "tools/list" => reply(json!({ "tools": tools })),
        "tools/call" => Rpc::Tool { id: id.clone(), name: msg["params"]["name"].as_str().unwrap_or("").to_string(), args: msg["params"]["arguments"].clone() },
        _ => Rpc::Reply(Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("no method {method}") } }))),
    }
}

/// A tool's text as the reply to its tools/call.
pub fn tool_reply(id: Value, text: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": text }], "isError": text.starts_with("error:") } })
}

/// Takes the authorized POSTs to an MCP endpoint, with their JSON bodies, on a thread of its own until `stop`.
fn accept(http: tiny_http::Server, token: String, stop: Arc<AtomicBool>, mut on: impl FnMut(tiny_http::Request, Value) + Send + 'static) -> Result<(), String> {
    std::thread::Builder::new()
        .name("formalmind-mcp".into())
        .spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                let Ok(Some(mut req)) = http.recv_timeout(Duration::from_millis(300)) else { continue };
                let authed = req.headers().iter().any(|h| h.field.equiv("Authorization") && h.value.as_str() == format!("Bearer {token}"));
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
                on(req, serde_json::from_str(&body).unwrap_or(Value::Null));
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Answers a request with JSON, or 202 when there's nothing to say (a notification).
fn respond(req: tiny_http::Request, out: Option<Value>) {
    let res = match out {
        Some(v) => tiny_http::Response::from_string(v.to_string()).with_header("Content-Type: application/json".parse::<tiny_http::Header>().unwrap()).boxed(),
        None => tiny_http::Response::empty(202).boxed(),
    };
    let _ = req.respond(res);
}

/// One request to a Bridge: the message, answered with `answer`.
pub struct Call {
    req: tiny_http::Request,
    pub msg: Value,
}

impl Call {
    pub fn answer(self, out: Option<Value>) {
        respond(self.req, out);
    }
}

/// An MCP endpoint for one swarm agent's turn whose requests are handed to the agent's loop (`calls`), so the swarm's
/// own tool code answers them, in order, with the turn's state at hand. Dropping it stops the server.
pub struct Bridge {
    pub url: String,
    pub token: String,
    pub calls: tokio::sync::mpsc::UnboundedReceiver<Call>,
    stop: Arc<AtomicBool>,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

pub fn bridge() -> Result<Bridge, String> {
    let http = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = http.server_addr().to_ip().map(|a| a.port()).ok_or("no port")?;
    let token = format!("{:016x}{:016x}", rand64(), rand64());
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, calls) = tokio::sync::mpsc::unbounded_channel();
    accept(http, token.clone(), stop.clone(), move |req, msg| {
        // Batches went away in MCP 2025-06-18, and Claude Code doesn't send them.
        if msg.is_array() {
            let _ = req.respond(tiny_http::Response::empty(400));
        } else if let Err(e) = tx.send(Call { req, msg }) {
            // The turn is over.
            let _ = e.0.req.respond(tiny_http::Response::empty(503));
        }
    })?;
    Ok(Bridge { url: format!("http://127.0.0.1:{port}/mcp"), token, calls, stop })
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
pub fn fnv(bytes: &[u8]) -> u32 {
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

/// The Claude Code session id for a job (stable, so an interrupted job resumes the same conversation).
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

/// What one line of Claude Code's stream-json says, as session events.
pub fn events_of(line: &Value) -> Vec<(&'static str, String)> {
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

/// One swarm agent's turn on Claude Code (prover, reviewer, assistant, auditor), started: the role's own system prompt
/// in place of Claude Code's, and only the role's own tools, which the swarm serves over a Bridge (`--tools ""` turns
/// Claude Code's built-in ones off). Nothing from your Claude Code setup or the project's reaches it (no settings,
/// hooks, CLAUDE.md, skills or other MCP servers), so the agent sees what it sees on the API; only the model calls
/// are your Claude plan's. Its stream-json lines are read with `lines`.
pub struct RoleRun {
    pub child: tokio::process::Child,
    pub lines: tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    /// The project, resolved, to check Claude Code's cwd against.
    pub root: PathBuf,
    /// Where the run's stream and stderr are kept (~/.formalmind/claude-code/…).
    pub state: PathBuf,
    /// The job's conversation was already there and is being continued (the app quit mid-job).
    pub resumed: bool,
    session: String,
    log: std::fs::File,
}

impl RoleRun {
    /// Claude Code has answered, so the job's conversation is on disk: a quit from here on resumes it.
    pub fn started(&self, job: u64) {
        let _ = std::fs::write(self.state.join(format!("job-{job}.session")), &self.session);
    }

    pub fn log(&mut self, line: &str) {
        use std::io::Write;
        let _ = writeln!(self.log, "{line}");
    }

    /// Why it exited, from the end of its stderr.
    pub fn stderr_tail(&self) -> String {
        let err = std::fs::read_to_string(self.state.join("stderr.log")).unwrap_or_default();
        let tail: String = err.trim().chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
        format!("{tail} (logs in {})", self.state.display())
    }
}

pub fn start_role(folder: &str, run: &str, job: u64, system: &str, task: &Value, model: &str, bridge: &Bridge) -> Result<RoleRun, String> {
    use tokio::io::AsyncBufReadExt;
    let root = std::fs::canonicalize(folder).map_err(|e| format!("{folder}: {e}"))?;
    let state = state_dir_in(&crate::local::home()?, &root, run);
    std::fs::create_dir_all(&state).map_err(|e| format!("{}: {e}", state.display()))?;
    let mcp = json!({ "mcpServers": { "formalmind": { "type": "http", "url": bridge.url, "headers": { "Authorization": format!("Bearer {}", bridge.token) } } } });
    let mcp_file = state.join("mcp.json");
    write_private(&mcp_file, &serde_json::to_string_pretty(&mcp).unwrap_or_default())?;
    // A job whose conversation Claude Code already has continues it; otherwise it starts under the job's own id.
    let saved = std::fs::read_to_string(state.join(format!("job-{job}.session"))).ok().filter(|s| !s.trim().is_empty());
    let resumed = saved.is_some();
    let session = saved.unwrap_or_else(|| session_id(folder, run, job));
    let content = if resumed { json!("The app quit and this job is being resumed. Carry on from where you were; don't redo finished work.") } else { task.clone() };
    let open_log = |name: &str| std::fs::OpenOptions::new().create(true).append(true).open(state.join(name)).map_err(|e| format!("{name}: {e}"));
    let mut cmd = tokio::process::Command::new(claude());
    cmd.current_dir(&root)
        .arg("-p")
        // The task goes in as a message, so a report's PDF stays a document block as on the API.
        .args(["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
        .arg("--system-prompt")
        .arg(system)
        .args(["--tools", ""])
        .arg("--mcp-config")
        .arg(&mcp_file)
        .arg("--strict-mcp-config")
        .args(["--allowedTools", "mcp__formalmind"])
        .args(["--setting-sources", ""])
        .arg("--disable-slash-commands")
        .args(["--model", model])
        // Thinking effort from Settings (the chat's picker), read at each turn so a change applies to the next one.
        .args(crate::local::read().ok().and_then(|c| c.settings.effort()).map(|e| vec!["--effort".to_string(), e]).unwrap_or_default())
        .args(if resumed { ["--resume", session.as_str()] } else { ["--session-id", session.as_str()] })
        .env("PATH", crate::platform::tool_path(None))
        .env("PWD", &root)
        // Your Claude plan, not an API key that happens to be in the environment.
        .env_remove("ANTHROPIC_API_KEY")
        // `lake build` on a big model takes a while; the tool call waits for it.
        .env("MCP_TOOL_TIMEOUT", "7200000")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::from(open_log("stderr.log")?))
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start Claude Code ({}): {e}", claude().display()))?;
    // The one message, then end of input: Claude Code works until the turn is done and exits.
    let message = json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string() + "\n";
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(message.as_bytes()).await;
    });
    let lines = tokio::io::BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();
    let log = open_log("stream.jsonl")?;
    Ok(RoleRun { child, lines, root, state, resumed, session, log })
}

/// One answer from Claude Code with no tools (a drafted message), on your Claude plan.
pub async fn ask(folder: &str, system: &str, prompt: &str, model: &str) -> Result<String, String> {
    let out = tokio::process::Command::new(claude())
        .current_dir(folder)
        .args(["-p", prompt, "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--model", model])
        .arg("--system-prompt")
        .arg(system)
        .env("PATH", crate::platform::tool_path(None))
        .env_remove("ANTHROPIC_API_KEY")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("couldn't start Claude Code ({}): {e}", claude().display()))?;
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| format!("Claude Code: {}", String::from_utf8_lossy(&out.stderr).trim()))?;
    result_of(&v)
}

/// A finished turn's `result` line: its text, or why it failed (a usage limit says when it resets).
pub fn result_of(line: &Value) -> Result<String, String> {
    let text = line["result"].as_str().unwrap_or("").trim().to_string();
    if line["is_error"] == true || line["subtype"].as_str().is_some_and(|s| s != "success") {
        let why = if text.is_empty() { line["subtype"].as_str().unwrap_or("error").to_string() } else { text };
        return Err(format!("Claude Code stopped: {why}"));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_are_stable_uuids() {
        let a = session_id("/p", "swarm", 1);
        assert_eq!(a, session_id("/p", "swarm", 1));
        assert_ne!(a, session_id("/p", "swarm", 2));
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

    #[test]
    fn state_lives_under_formalmind_by_project_and_session() {
        let base = std::path::Path::new("/home/me/.formalmind");
        let a = state_dir_in(base, std::path::Path::new("/work/contracts"), "swarm");
        assert!(a.to_string_lossy().starts_with("/home/me/.formalmind/claude-code/contracts-"), "{}", a.display());
        assert!(a.ends_with("swarm"));
        assert_ne!(a.parent(), state_dir_in(base, std::path::Path::new("/other/contracts"), "swarm").parent(), "two projects of the same name");
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
    fn signed_in_names_the_plan() {
        assert_eq!(billing_of(&json!({ "loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max" })).unwrap(), "signed in to your Claude Max plan");
        assert!(billing_of(&json!({ "loggedIn": false })).unwrap_err().contains("/login"));
        assert!(billing_of(&Value::Null).is_err(), "no claude, or output it can't read");
    }

    #[test]
    fn a_roles_tools_are_served_and_its_calls_handed_back() {
        let tools = mcp_tools(vec![json!({ "name": "verdict", "input_schema": { "type": "object" } })]);
        let list = |m: Value| match rpc(&m, &tools, "") {
            Rpc::Reply(r) => r,
            Rpc::Tool { .. } => panic!("not a tool call"),
        };
        assert_eq!(list(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).unwrap()["result"]["tools"][0]["inputSchema"], json!({ "type": "object" }));
        assert!(list(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        match rpc(&json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "verdict", "arguments": { "decision": "approve" } } }), &tools, "") {
            Rpc::Tool { id, name, args } => {
                assert_eq!((id, name.as_str(), args["decision"].as_str()), (json!(7), "verdict", Some("approve")));
                assert_eq!(tool_reply(json!(7), "error: no").pointer("/result/isError"), Some(&json!(true)));
            }
            Rpc::Reply(_) => panic!("a tool call"),
        }
        assert!(result_of(&json!({ "type": "result", "subtype": "success", "is_error": true, "result": "Claude usage limit reached" })).unwrap_err().contains("usage limit"));
        assert_eq!(result_of(&json!({ "type": "result", "subtype": "success", "is_error": false, "result": " done " })).unwrap(), "done");
    }
}
