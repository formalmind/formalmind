//! Code navigation in the Code tab: one solidity-language-server per folder, spoken to over stdio (JSON-RPC).
//!
//! The server builds the project's AST in the background after a file opens, so the first request on a file can come
//! back empty; requests retry for a few seconds before giving up.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

struct Server {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<i64, Sender<Value>>>>,
    next: AtomicI64,
    opened: Mutex<HashSet<String>>,
}

fn servers() -> &'static Mutex<HashMap<String, Arc<Server>>> {
    static S: OnceLock<Mutex<HashMap<String, Arc<Server>>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Apps opened from Finder don't get the shell's PATH, so look where cargo and Homebrew install it first.
fn binary() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    [home.join(".cargo/bin/solidity-language-server"), "/opt/homebrew/bin/solidity-language-server".into(), "/usr/local/bin/solidity-language-server".into()]
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| "solidity-language-server".into())
}

fn send(stdin: &Mutex<ChildStdin>, msg: &Value) -> Result<(), String> {
    let body = msg.to_string();
    let mut w = stdin.lock().map_err(|e| e.to_string())?;
    write!(w, "Content-Length: {}\r\n\r\n{body}", body.len()).and_then(|_| w.flush()).map_err(|e| format!("the language server stopped: {e}"))
}

impl Server {
    fn start(folder: &str) -> Result<Arc<Server>, String> {
        let mut child = Command::new(binary())
            .arg("--stdio")
            .current_dir(folder)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Couldn't start solidity-language-server ({e}). Install it with `cargo install solidity-language-server`."))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let pending: Arc<Mutex<HashMap<i64, Sender<Value>>>> = Arc::default();
        let server = Arc::new(Server { child: Mutex::new(child), stdin: Mutex::new(stdin), pending: pending.clone(), next: AtomicI64::new(1), opened: Mutex::default() });

        // Responses go to whoever is waiting on their id; the server's own requests get an empty answer.
        let weak = Arc::downgrade(&server);
        std::thread::spawn(move || {
            let mut r = BufReader::new(stdout);
            loop {
                let mut len = 0usize;
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let line = line.trim();
                    if line.is_empty() {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut buf = vec![0; len];
                if r.read_exact(&mut buf).is_err() {
                    return;
                }
                let Ok(msg) = serde_json::from_slice::<Value>(&buf) else { continue };
                match (msg.get("id").and_then(Value::as_i64), msg.get("method")) {
                    (Some(id), None) => {
                        if let Some(tx) = pending.lock().ok().and_then(|mut p| p.remove(&id)) {
                            let _ = tx.send(msg);
                        }
                    }
                    (Some(_), Some(_)) => {
                        if let Some(s) = weak.upgrade() {
                            let _ = send(&s.stdin, &json!({ "jsonrpc": "2.0", "id": msg["id"], "result": null }));
                        }
                    }
                    _ => {}
                }
            }
        });

        let root = format!("file://{folder}");
        server.request("initialize", json!({ "processId": std::process::id(), "rootUri": root, "capabilities": { "general": { "positionEncodings": ["utf-16"] } }, "workspaceFolders": [{ "uri": root, "name": "folder" }] }), Duration::from_secs(30))?;
        send(&server.stdin, &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }))?;
        Ok(server)
    }

    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();
        self.pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
        send(&self.stdin, &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        let msg = rx.recv_timeout(timeout).map_err(|_| format!("the language server didn't answer {method}"))?;
        if let Some(err) = msg.get("error") {
            return Err(err["message"].as_str().unwrap_or("language server error").to_string());
        }
        Ok(msg["result"].clone())
    }

    fn open(&self, folder: &str, path: &str) -> Result<String, String> {
        let uri = format!("file://{}", Path::new(folder).join(path).display());
        if self.opened.lock().map_err(|e| e.to_string())?.insert(uri.clone()) {
            let text = std::fs::read_to_string(Path::new(folder).join(path)).map_err(|e| e.to_string())?;
            send(&self.stdin, &json!({ "jsonrpc": "2.0", "method": "textDocument/didOpen", "params": { "textDocument": { "uri": uri, "languageId": "solidity", "version": 1, "text": text } } }))?;
        }
        Ok(uri)
    }
}

fn server(folder: &str) -> Result<Arc<Server>, String> {
    if !crate::local::is_added(folder)? {
        return Err("Add the folder first".into());
    }
    let mut all = servers().lock().map_err(|e| e.to_string())?;
    if let Some(s) = all.get(folder) {
        // A server that exited is started again.
        if s.child.lock().ok().is_some_and(|mut c| matches!(c.try_wait(), Ok(None))) {
            return Ok(s.clone());
        }
    }
    let s = Server::start(folder)?;
    all.insert(folder.to_string(), s.clone());
    Ok(s)
}

/// Asks about a position, retrying while the server is still building the project after a file opened.
fn ask(folder: &str, path: &str, method: &str, line: u32, character: u32) -> Result<Value, String> {
    let s = server(folder)?;
    let uri = s.open(folder, path)?;
    let params = json!({ "textDocument": { "uri": uri }, "position": { "line": line, "character": character } });
    let started = Instant::now();
    loop {
        let r = s.request(method, params.clone(), Duration::from_secs(20))?;
        if !r.is_null() || started.elapsed() > Duration::from_secs(6) {
            return Ok(r);
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

/// Where the symbol at a position is defined: paths relative to the folder, 0-based lines and characters.
#[tauri::command]
pub async fn lsp_definition(folder: String, path: String, line: u32, character: u32) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = ask(&folder, &path, "textDocument/definition", line, character)?;
        let list = if r.is_array() { r.as_array().cloned().unwrap_or_default() } else if r.is_null() { vec![] } else { vec![r] };
        Ok(list
            .iter()
            .filter_map(|l| {
                // Location or LocationLink.
                let uri = l.get("uri").or_else(|| l.get("targetUri"))?.as_str()?;
                let range = l.get("range").or_else(|| l.get("targetSelectionRange"))?;
                let abs = uri.strip_prefix("file://")?;
                let rel = Path::new(abs).strip_prefix(&folder).ok()?.to_string_lossy().into_owned();
                Some(json!({ "path": rel, "line": range["start"]["line"], "character": range["start"]["character"] }))
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The hover text (Markdown) for the symbol at a position.
#[tauri::command]
pub async fn lsp_hover(folder: String, path: String, line: u32, character: u32) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = ask(&folder, &path, "textDocument/hover", line, character)?;
        let c = &r["contents"];
        Ok(c["value"].as_str().or_else(|| c.as_str()).map(String::from))
    })
    .await
    .map_err(|e| e.to_string())?
}
