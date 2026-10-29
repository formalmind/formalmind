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
