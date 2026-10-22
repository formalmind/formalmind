//! Interactive Lean checking, independent of the swarm and its proof-coverage heuristics.
use reqwest::Url;
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io::{BufRead, BufReader, Write}, path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicI64, Ordering}, mpsc::{channel, Sender}}, time::Duration};

const LIMIT: usize = 2 * 1024 * 1024;
#[derive(Default)]
struct Document { version: i64, text: String, diagnostics: Value, diagnostics_version: Option<i64>, processing: Value }
struct Server {
    child: Mutex<Child>, stdin: Mutex<ChildStdin>, pending: Mutex<HashMap<i64, Sender<Value>>>,
    documents: Mutex<HashMap<String, Document>>, next: AtomicI64, revision: AtomicI64, failure: Mutex<Option<String>>,
}
static SERVERS: OnceLock<Mutex<HashMap<PathBuf, Arc<Server>>>> = OnceLock::new();
fn servers() -> &'static Mutex<HashMap<PathBuf, Arc<Server>>> { SERVERS.get_or_init(Default::default) }

fn inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let p = Path::new(relative);
    if p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::Prefix(_))) {
        return Err("Use a path inside the added folder".into());
    }
    let path = root.join(p).canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(root) { return Err("File resolves outside the added folder".into()); }
    Ok(path)
}
fn file(folder: &str, path: &str) -> Result<(PathBuf, PathBuf), String> {
    if !crate::local::is_added(folder)? { return Err("Add the folder first".into()); }
    let root = Path::new(folder).canonicalize().map_err(|e| e.to_string())?;
    let path = inside(&root, path)?;
    if path.extension().is_none_or(|e| e != "lean") { return Err("Choose a Lean source file".into()); }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > LIMIT as u64 { return Err("Lean files must be smaller than 2 MiB".into()); }
    Ok((root, path))
}
fn project(root: &Path, path: &Path) -> Result<PathBuf, String> {
    for dir in path.parent().ok_or("No parent folder")?.ancestors() {
        if !dir.starts_with(root) { break; }
        if dir.join("lakefile.toml").is_file() || dir.join("lakefile.lean").is_file() { return Ok(dir.to_path_buf()); }
    }
    Err("No Lake project for this file. Add a lakefile.toml or lakefile.lean and lean-toolchain in its project folder.".into())
}
fn uri(path: &Path) -> Result<String, String> {
    Url::from_file_path(path).map(String::from).map_err(|_| "Invalid file URI".into())
}
fn frame(reader: &mut impl BufRead) -> Result<Value, String> {
    let mut length = None;
    let mut header_bytes = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 { return Err("Lean language server stopped".into()); }
        header_bytes += line.len();
        if header_bytes > 8192 { return Err("Invalid LSP header".into()); }
        if line.trim().is_empty() { break; }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") { length = value.trim().parse::<usize>().ok(); }
        }
    }
    let length = length.filter(|n| *n <= 16 * LIMIT).ok_or("Invalid LSP message length")?;
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
impl Server {
    fn send(&self, value: Value) -> Result<(), String> {
        let body = value.to_string();
        let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
        write!(stdin, "Content-Length: {}\r\n\r\n{}", body.len(), body).and_then(|_| stdin.flush()).map_err(|e| e.to_string())
    }
    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(json!({"jsonrpc":"2.0", "method":method, "params":params}))
    }
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if let Some(error) = self.failure.lock().map_err(|e| e.to_string())?.clone() { return Err(error); }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        self.pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
        let result = self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .and_then(|_| rx.recv_timeout(Duration::from_secs(30)).map_err(|_| format!("Lean timed out on {method}; check imports or restart Lean")));
        self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
        if result.is_err() { let _ = self.notify("$/cancelRequest", json!({"id":id})); }
        let response = result?;
        if let Some(error) = response.get("error") { return Err(error["message"].as_str().unwrap_or("Lean request failed").into()); }
        Ok(response["result"].clone())
    }
    fn notification(&self, method: &str, params: &Value) {
        let (uri, version) = if method == "textDocument/publishDiagnostics" {
            (params["uri"].as_str(), params["version"].as_i64())
        } else { (params["textDocument"]["uri"].as_str(), params["textDocument"]["version"].as_i64()) };
        let Ok(mut docs) = self.documents.lock() else { return };
        let Some(doc) = uri.and_then(|u| docs.get_mut(u)) else { return };
        // Notifications without an exact document version cannot attest to this buffer.
        if version != Some(doc.version) { return; }
        match method {
            "textDocument/publishDiagnostics" => { doc.diagnostics = params["diagnostics"].clone(); doc.diagnostics_version = version; }
            "$/lean/fileProgress" => doc.processing = params["processing"].clone(),
            _ => {}
        }
    }
    fn start(root: &Path) -> Result<Arc<Self>, String> {
        let mut child = Command::new(crate::platform::find_tool("lake")).arg("serve").current_dir(root)
            .env_remove("ELAN_TOOLCHAIN").env("PATH", crate::platform::tool_path(None))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
            .map_err(|e| format!("Could not start lake serve: {e}. Install elan and the project's pinned toolchain."))?;
        let stdin = child.stdin.take().ok_or("No Lean stdin")?;
        let stdout = child.stdout.take().ok_or("No Lean stdout")?;
        let s = Arc::new(Self { child: Mutex::new(child), stdin: Mutex::new(stdin), pending: Mutex::default(), documents: Mutex::default(), next: AtomicI64::new(1), revision: AtomicI64::new(1), failure: Mutex::new(None) });
        let weak = Arc::downgrade(&s);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let message = frame(&mut reader);
                let Some(s) = weak.upgrade() else { break };
                let message = match message { Ok(m) => m, Err(e) => {
                    if let Ok(mut failure) = s.failure.lock() { *failure = Some(e.clone()); }
                    if let Ok(mut pending) = s.pending.lock() { for (_, tx) in pending.drain() { let _ = tx.send(json!({"error":{"message":e}})); } }
                    break;
                }};
                match (message.get("id"), message["method"].as_str()) {
                    (Some(id), None) => { if let Some(tx) = id.as_i64().and_then(|id| s.pending.lock().ok()?.remove(&id)) { let _ = tx.send(message); } }
                    (Some(id), Some(method)) => {
                        let result = if method == "workspace/configuration" { json!(message["params"]["items"].as_array().map(|a| vec![Value::Null; a.len()]).unwrap_or_default()) } else { Value::Null };
                        let _ = s.send(json!({"jsonrpc":"2.0","id":id,"result":result}));
                    }
                    (_, Some(method)) => s.notification(method, &message["params"]),
                    _ => {}
                }
            }
        });
        s.request("initialize", json!({"processId":std::process::id(),"rootUri":uri(root)?,"capabilities":{"general":{"positionEncodings":["utf-16"]},"textDocument":{"publishDiagnostics":{"versionSupport":true}}},"workspaceFolders":[{"uri":uri(root)?,"name":"Lean proofs"}]}))?;
        s.notify("initialized", json!({}))?;
        Ok(s)
    }
    fn sync(&self, uri: &str, text: &str) -> Result<i64, String> {
        if text.len() > LIMIT { return Err("Lean buffer exceeds 2 MiB".into()); }
        let mut docs = self.documents.lock().map_err(|e| e.to_string())?;
        let (method, params, version) = if let Some(doc) = docs.get(uri) {
            if doc.text == text { return Ok(doc.version); }
            let v = self.revision.fetch_add(1, Ordering::Relaxed);
            ("textDocument/didChange", json!({"textDocument":{"uri":uri,"version":v},"contentChanges":[{"text":text}]}), v)
        } else { let v = self.revision.fetch_add(1, Ordering::Relaxed); ("textDocument/didOpen", json!({"textDocument":{"uri":uri,"languageId":"lean4","version":v,"text":text}}), v) };
        self.notify(method, params)?;
        docs.insert(uri.into(), Document { version, text: text.into(), diagnostics: json!([]), processing: Value::Null, diagnostics_version: None });
        Ok(version)
    }
    fn state(&self, uri: &str) -> Result<Value, String> {
        let docs = self.documents.lock().map_err(|e| e.to_string())?;
        let d = docs.get(uri).ok_or("Open the Lean file first")?;
        Ok(json!({"version":d.version,"diagnostics":d.diagnostics,"diagnosticsVersion":d.diagnostics_version,"processing":d.processing,"error":*self.failure.lock().map_err(|e| e.to_string())?}))
    }
    fn stop(&self) { if let Ok(mut child) = self.child.lock() { let _ = child.kill(); let _ = child.wait(); } }
}
impl Drop for Server { fn drop(&mut self) { self.stop(); } }
pub fn shutdown_all() { if let Ok(mut all) = servers().lock() { for (_, s) in all.drain() { s.stop(); } } }
fn server(root: &Path) -> Result<Arc<Server>, String> {
    let mut all = servers().lock().map_err(|e| e.to_string())?;
    if let Some(s) = all.get(root) {
        if s.child.lock().map_err(|e| e.to_string())?.try_wait().map_err(|e| e.to_string())?.is_none() && s.failure.lock().map_err(|e| e.to_string())?.is_none() { return Ok(s.clone()); }
    }
    let s = Server::start(root)?;
    all.insert(root.into(), s.clone());
    Ok(s)
}

#[tauri::command]
pub async fn lean_open(folder: String, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, path) = file(&folder, &path)?;
        let project = project(&root, &path)?;
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let s = server(&project)?;
        let version = s.sync(&uri(&path)?, &text)?;
        Ok(json!({"text":text,"version":version,"project":project,"toolchain":fs::read_to_string(project.join("lean-toolchain")).unwrap_or_default().trim()}))
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn lean_sync(folder: String, path: String, text: String) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || { let (root, path) = file(&folder, &path)?; server(&project(&root, &path)?)?.sync(&uri(&path)?, &text) }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn lean_state(folder: String, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || { let (root, path) = file(&folder, &path)?; server(&project(&root, &path)?)?.state(&uri(&path)?) }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn lean_symbols(folder: String, path: String, version: i64) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, path) = file(&folder, &path)?;
        let s = server(&project(&root, &path)?)?;
        let uri = uri(&path)?;
        if s.state(&uri)?["version"].as_i64() != Some(version) { return Err("Buffer changed".into()); }
        let result = s.request("textDocument/documentSymbol", json!({"textDocument":{"uri":uri}}))?;
        if s.state(&uri)?["version"].as_i64() != Some(version) { return Err("Buffer changed".into()); }
        Ok(if result.is_null() { json!([]) } else { result })
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn proof_specs(folder: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !crate::local::is_added(&folder)? { return Err("Add the folder first".into()); }
        let root = Path::new(&folder).canonicalize().map_err(|e| e.to_string())?;
        if !root.join(".formal/proof-specs.json").exists() { return Ok(json!([])); }
        let path = inside(&root, ".formal/proof-specs.json")?;
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > LIMIT as u64 { return Err("Specification manifest exceeds 2 MiB".into()); }
        let manifest: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if manifest["schema"] != 1 { return Err("Expected proof-specs schema 1".into()); }
        let specs = manifest["specs"].as_array().ok_or("Expected a specs array")?;
        let mut ids = std::collections::HashSet::new();
        for spec in specs {
            for field in ["id", "title", "signature"] {
                if spec[field].as_str().is_none_or(|s| s.is_empty()) { return Err(format!("Each specification needs {field}")); }
            }
            if !ids.insert(spec["id"].as_str().unwrap()) { return Err("Duplicate specification id".into()); }
            if spec["assumptions"].as_array().is_none_or(|a| a.iter().any(|v| !v.is_string())) { return Err("Assumptions must be a list of strings".into()); }
            for (field, extension) in [("solidity", "sol"), ("lean", "lean")] {
                let path = inside(&root, spec[field]["path"].as_str().ok_or("Missing source path")?)?;
                if path.extension().is_none_or(|e| e != extension) || spec[field]["line"].as_u64().is_none_or(|n| n == 0) { return Err(format!("Invalid {field} source location")); }
            }
        }
        Ok(json!(specs))
    }).await.map_err(|e| e.to_string())?
}
// Curated source ranges are navigation evidence, never a computed dependency slice.
fn relevant_code(root: &Path, spec: &Value) -> Result<Value, String> {
    let ranges = spec["relevantCode"].as_array().ok_or("No relevant code recorded. Add relevantCode ranges to this specification's manifest entry.")?;
    if ranges.len() > 100 { return Err("At most 100 source ranges per specification".into()); }
    let mut result = Vec::new();
    let mut total = 0;
    for range in ranges {
        let relative = range["path"].as_str().ok_or("Missing relevant code path")?;
        let path = inside(root, relative)?;
        if path.extension().is_none_or(|e| e != "sol") { return Err("Relevant code must be Solidity source".into()); }
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > LIMIT as u64 { return Err("Source file exceeds 2 MiB".into()); }
        let reason = range["reason"].as_str().filter(|s| !s.trim().is_empty()).ok_or("Each source range needs a reason")?;
        let expected = range["expectedText"].as_str().ok_or("Each source range needs expectedText to detect changed source")?;
        let start = range["startLine"].as_u64().filter(|n| *n > 0).ok_or("Invalid startLine")?;
        let end = range["endLine"].as_u64().filter(|n| *n >= start).ok_or("Invalid endLine")?;
        let source = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let lines: Vec<_> = source.lines().collect();
        let available = end <= lines.len() as u64;
        let text = if available { lines[(start - 1) as usize..end as usize].join("\n") } else { String::new() };
        total += text.len();
        if total > LIMIT { return Err("Relevant code exceeds 2 MiB".into()); }
        result.push(json!({"path":relative,"startLine":start,"endLine":end,"reason":reason,"text":text,"stale":!available || text != expected,"available":available}));
    }
    Ok(json!(result))
}
#[tauri::command]
pub async fn proof_relevant_code(folder: String, spec_id: String) -> Result<Value, String> {
    let specs = proof_specs(folder.clone()).await?;
    let spec = specs.as_array().and_then(|specs| specs.iter().find(|s| s["id"].as_str() == Some(&spec_id))).cloned().ok_or("Specification not found")?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&folder).canonicalize().map_err(|e| e.to_string())?;
        relevant_code(&root, &spec)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn lean_goal(folder: String, path: String, line: u32, character: u32, version: i64) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, path) = file(&folder, &path)?;
        let s = server(&project(&root, &path)?)?;
        let uri = uri(&path)?;
        if s.state(&uri)?["version"].as_i64() != Some(version) { return Err("Buffer changed; requesting fresh goals".into()); }
        let params = json!({"textDocument":{"uri":uri},"position":{"line":line,"character":character}});
        let goals = s.request("$/lean/plainGoal", params.clone())?;
        let term = if goals.is_null() { s.request("$/lean/plainTermGoal", params)? } else { Value::Null };
        if s.state(&uri)?["version"].as_i64() != Some(version) { return Err("Buffer changed; requesting fresh goals".into()); }
        Ok(json!({"version":version,"goals":goals,"term":term}))
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn lean_save(folder: String, path: String, text: String, expected: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, path) = file(&folder, &path)?;
        save(&path, &text, &expected)
    }).await.map_err(|e| e.to_string())?
}
fn save(path: &Path, text: &str, expected: &str) -> Result<(), String> {
    if text.len() > LIMIT { return Err("Lean buffer exceeds 2 MiB".into()); }
    if fs::read_to_string(path).map_err(|e| e.to_string())? != expected { return Err("File changed on disk. Reload it before saving to avoid overwriting another edit.".into()); }
    fs::write(path, text).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn lean_close(folder: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, path) = file(&folder, &path)?;
        let project = project(&root, &path)?;
        if let Some(s) = servers().lock().map_err(|e| e.to_string())?.get(&project) {
            let uri = uri(&path)?;
            s.notify("textDocument/didClose", json!({"textDocument":{"uri":uri}}))?;
            s.documents.lock().map_err(|e| e.to_string())?.remove(&uri);
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn lean_restart(folder: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, path) = file(&folder, &path)?;
        if let Some(s) = servers().lock().map_err(|e| e.to_string())?.remove(&project(&root, &path)?) { s.stop(); }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("fm-lean-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            fs::create_dir(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn framing_uses_utf8_bytes_and_rejects_missing_length() {
        let value = json!({"message":"∀ x, x = x"});
        let body = value.to_string();
        let wire = format!("content-length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}", body.len(), body);
        assert_eq!(frame(&mut std::io::Cursor::new(wire)).unwrap(), value);
        assert!(frame(&mut std::io::Cursor::new("\r\n{}")).is_err());
    }
    #[test]
    fn paths_and_uris_are_bounded_and_encoded() {
        let f = Fixture::new();
        fs::write(f.0.join("A B λ.lean"), "").unwrap();
        let p = inside(&f.0, "A B λ.lean").unwrap();
        let u = uri(&p).unwrap();
        assert!(u.contains("%20"));
        assert_eq!(Url::parse(&u).unwrap().to_file_path().unwrap(), p);
        assert!(inside(&f.0, "../outside.lean").is_err());
        #[cfg(unix)] {
            std::os::unix::fs::symlink(std::env::temp_dir(), f.0.join("escape")).unwrap();
            assert!(inside(&f.0, "escape").is_err());
        }
    }
    #[test]
    fn relevant_ranges_detect_changes_and_reject_escape() {
        let f = Fixture::new();
        fs::write(f.0.join("Contract.sol"), "contract C {\n  uint value;\n}\n").unwrap();
        let mut spec = json!({"relevantCode":[{"path":"Contract.sol","startLine":2,"endLine":2,"reason":"State changed by the operation","expectedText":"  uint value;"}]});
        assert_eq!(relevant_code(&f.0, &spec).unwrap()[0]["stale"], false);
        fs::write(f.0.join("Contract.sol"), "contract C {\n  uint changed;\n}\n").unwrap();
        assert_eq!(relevant_code(&f.0, &spec).unwrap()[0]["stale"], true);
        spec["relevantCode"][0]["endLine"] = json!(20);
        assert_eq!(relevant_code(&f.0, &spec).unwrap()[0]["available"], false);
        spec["relevantCode"][0]["path"] = json!("../outside.sol");
        assert!(relevant_code(&f.0, &spec).is_err());
    }
    #[test]
    fn project_selects_nearest_lakefile() {
        let f = Fixture::new();
        fs::create_dir_all(f.0.join("formal/Sub")).unwrap();
        fs::write(f.0.join("lakefile.toml"), "").unwrap();
        fs::write(f.0.join("formal/lakefile.lean"), "").unwrap();
        assert_eq!(project(&f.0, &f.0.join("formal/Sub/Proof.lean")).unwrap(), f.0.join("formal"));
    }
    #[test]
    fn save_does_not_overwrite_external_edits() {
        let f = Fixture::new(); let path = f.0.join("Proof.lean");
        fs::write(&path, "someone else's change").unwrap();
        assert!(save(&path, "my draft", "old text").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "someone else's change");
        save(&path, "my draft", "someone else's change").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "my draft");
    }
    #[test]
    #[ignore = "Runs the installed Lean 4.28 language server; no network or swarm"]
    fn live_lean_goals_diagnostics_and_version_invalidation() {
        let f = Fixture::new();
        fs::write(f.0.join("lakefile.toml"), "name = \"proof_test\"\n").unwrap();
        fs::write(f.0.join("lean-toolchain"), "leanprover/lean4:v4.28.0\n").unwrap();
        let path = f.0.join("Proof.lean"); fs::write(&path, "").unwrap();
        let s = Server::start(&f.0).unwrap(); let u = uri(&path).unwrap();
        let bad = "theorem reflexive (n : Nat) : n = n := by\n  skip\n";
        let v1 = s.sync(&u, bad).unwrap();
        let goal = s.request("$/lean/plainGoal", json!({"textDocument":{"uri":u},"position":{"line":1,"character":2}})).unwrap();
        assert!(goal.to_string().contains("n = n"), "{goal}");
        let wait = |version| {
            for _ in 0..200 {
                let state = s.state(&u).unwrap();
                if state["diagnosticsVersion"] == version && state["processing"].as_array().is_some_and(|v| v.is_empty()) { return state; }
                std::thread::sleep(Duration::from_millis(100));
            }
            panic!("No completed diagnostics: {}", s.state(&u).unwrap());
        };
        assert!(wait(v1)["diagnostics"].as_array().unwrap().iter().any(|d| d["severity"] == 1));
        let v2 = s.sync(&u, &bad.replace("skip", "rfl")).unwrap();
        assert!(v2 > v1);
        s.notification("textDocument/publishDiagnostics", &json!({"uri":u,"version":v1,"diagnostics":[{"message":"stale"}]}));
        assert!(!s.state(&u).unwrap()["diagnostics"].to_string().contains("stale"));
        let checked = wait(v2);
        assert!(checked["diagnostics"].as_array().unwrap().is_empty(), "{checked}");
        let symbols = s.request("textDocument/documentSymbol", json!({"textDocument":{"uri":u}})).unwrap();
        assert!(symbols.to_string().contains("reflexive"), "{symbols}");
        s.notify("textDocument/didClose", json!({"textDocument":{"uri":u}})).unwrap();
        s.documents.lock().unwrap().remove(&u);
        let reopened = s.sync(&u, bad).unwrap();
        assert!(reopened > v2);
        s.notification("textDocument/publishDiagnostics", &json!({"uri":u,"version":v1,"diagnostics":[{"message":"stale reopen"}]}));
        assert!(!s.state(&u).unwrap()["diagnostics"].to_string().contains("stale reopen"));
        s.stop();
    }
}
