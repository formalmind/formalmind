//! The rebuild's starting point (SPEC.md B65): one agent with read and write access to a folder and the skills added
//! on this computer. It lists, reads, searches and writes files, nothing else: no commands, no writes outside the
//! folder or into `.git/`. The proof swarm (swarm.rs) keeps its own, narrower tools.

use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use tauri::Emitter;

const OUTPUT_LIMIT: usize = 12_000;
const MAX_TURNS: usize = 200;
const MODEL: &str = "claude-opus-5-5";

/// A folder the agent works in. Every path it is given resolves inside it, or is refused.
pub struct Folder {
    root: PathBuf,
}

impl Folder {
    pub fn open(root: &Path) -> Result<Self, String> {
        let root = root.canonicalize().map_err(|e| format!("{}: {e}", root.display()))?;
        if !root.is_dir() {
            return Err(format!("{} is not a folder", root.display()));
        }
        Ok(Folder { root })
    }

    /// Relative, no `..`, and the nearest existing ancestor must resolve inside (no symlink out).
    pub fn path(&self, rel: &str) -> Result<PathBuf, String> {
        let rel = Path::new(rel.trim());
        let rel = rel.strip_prefix(&self.root).unwrap_or(rel);
        if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_))) {
            return Err(format!("{} is outside the folder", rel.display()));
        }
        let path = self.root.join(rel);
        let existing = path.ancestors().find(|p| p.exists()).unwrap_or(&self.root);
        let real = existing.canonicalize().map_err(|e| e.to_string())?;
        if !real.starts_with(&self.root) {
            return Err(format!("{} is outside the folder", rel.display()));
        }
        Ok(path)
    }

    fn writable(&self, rel: &str) -> Result<PathBuf, String> {
        let path = self.path(rel)?;
        if path.strip_prefix(&self.root).map(|p| p.starts_with(".git")).unwrap_or(true) {
            return Err(format!("{rel} is git's own data; the agent doesn't write there"));
        }
        if path.is_dir() {
            return Err(format!("{rel} is a folder"));
        }
        Ok(path)
    }

    /// Every file under `dir`, relative to the folder, skipping git's data, dependencies and build output.
    pub fn list(&self, dir: &str) -> Result<Vec<String>, String> {
        let start = self.path(if dir.is_empty() { "." } else { dir })?;
        let mut out = Vec::new();
        let mut stack = vec![start];
        while let Some(d) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&d) else { continue };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if matches!(name.as_str(), ".git" | "node_modules" | "target" | ".lake" | "dist" | "out" | "cache") {
                    continue;
                }
                let Ok(kind) = e.file_type() else { continue };
                if kind.is_dir() {
                    stack.push(e.path());
                } else if kind.is_file() {
                    if let Ok(rel) = e.path().strip_prefix(&self.root) {
                        out.push(rel.to_string_lossy().to_string());
                    }
                }
            }
        }
        out.sort();
        Ok(out)
    }

    pub fn read(&self, rel: &str) -> Result<String, String> {
        let path = crate::skills::resolve(rel).map(Ok).unwrap_or_else(|| self.path(rel))?;
        std::fs::read_to_string(&path).map_err(|e| format!("{rel}: {e}"))
    }

    pub fn write(&self, rel: &str, content: &str) -> Result<String, String> {
        let path = self.writable(rel)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, content).map_err(|e| e.to_string())?;
        Ok(format!("wrote {rel} ({} bytes)", content.len()))
    }

    /// Replaces one exact, unique occurrence of `old` in a file.
    pub fn edit(&self, rel: &str, old: &str, new: &str) -> Result<String, String> {
        let path = self.writable(rel)?;
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{rel}: {e}"))?;
        match text.matches(old).count() {
            0 => Err(format!("{rel} doesn't contain that text")),
            1 => {
                std::fs::write(&path, text.replacen(old, new, 1)).map_err(|e| e.to_string())?;
                Ok(format!("edited {rel}"))
            }
            n => Err(format!("{rel} contains that text {n} times; include more around it")),
        }
    }

    /// Lines containing `pattern`, as `path:line: text`.
    pub fn search(&self, pattern: &str, dir: &str) -> Result<String, String> {
        if pattern.is_empty() {
            return Err("empty pattern".into());
        }
        let mut hits = Vec::new();
        for f in self.list(dir)? {
            let Ok(text) = std::fs::read_to_string(self.root.join(&f)) else { continue };
            for (i, line) in text.lines().enumerate().filter(|(_, l)| l.contains(pattern)) {
                hits.push(format!("{f}:{}: {}", i + 1, line.trim()));
                if hits.len() >= 200 {
                    return Ok(hits.join("\n") + "\n… more matches; narrow the search");
                }
            }
        }
        Ok(if hits.is_empty() { "no matches".into() } else { hits.join("\n") })
    }

    pub fn call(&self, name: &str, args: &Value) -> String {
        let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("");
        let result = match name {
            "list_files" => self.list(s("dir")).map(|f| f.join("\n")),
            "read_file" => self.read(s("path")),
            "write_file" => self.write(s("path"), s("content")),
            "edit_file" => self.edit(s("path"), s("old"), s("new")),
            "search" => self.search(s("pattern"), s("dir")),
            _ => Err(format!("No tool called {name}")),
        };
        clip(result.unwrap_or_else(|e| format!("error: {e}")))
    }
}

fn clip(s: String) -> String {
    if s.len() <= OUTPUT_LIMIT {
        return s;
    }
    let mut cut = OUTPUT_LIMIT;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n… [cut: {} bytes more]", &s[..cut], s.len() - cut)
}

pub fn tools() -> Value {
    let p = |d: &str| json!({ "type": "string", "description": d });
    json!([
        { "name": "list_files", "description": "Every file under a folder (relative paths).", "input_schema": { "type": "object", "properties": { "dir": p("Folder to list; empty for the whole project.") } } },
        { "name": "read_file", "description": "A file's text. `@skills/<id>/…` reads a skill added on this computer.", "input_schema": { "type": "object", "properties": { "path": p("Relative path.") }, "required": ["path"] } },
        { "name": "write_file", "description": "Create or overwrite a file.", "input_schema": { "type": "object", "properties": { "path": p("Relative path."), "content": p("The whole new text.") }, "required": ["path", "content"] } },
        { "name": "edit_file", "description": "Replace one exact, unique piece of text in a file.", "input_schema": { "type": "object", "properties": { "path": p("Relative path."), "old": p("Text to replace, exactly once in the file."), "new": p("Replacement.") }, "required": ["path", "old", "new"] } },
        { "name": "search", "description": "Lines containing a literal text.", "input_schema": { "type": "object", "properties": { "pattern": p("Literal text."), "dir": p("Folder to search; empty for all.") }, "required": ["pattern"] } }
    ])
}

fn system(folder: &Folder) -> String {
    format!(
        "You work directly on the project in {}. You can list, read, search, write and edit its files with your tools; you can't run commands. Read before you change, keep to the project's own style, and say plainly what you changed when you're done.{}",
        folder.root.display(),
        crate::skills::prompt_note("builder")
    )
}

/// One model call: the conversation so far in, the assistant's message (Anthropic content blocks) out.
pub trait Model {
    fn reply(&mut self, system: &str, messages: &[Value], tools: &Value) -> impl std::future::Future<Output = Result<Value, String>> + Send;
}

/// What the agent did, for the UI and tests.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step {
    Text { text: String },
    Tool { name: String, input: Value, output: String },
    Done,
    Error { error: String },
}

/// Runs the agent on `goal` until it answers without calling a tool, the turn limit, or `stop`.
pub async fn run<M: Model>(model: &mut M, folder: &Folder, goal: &str, stop: &std::sync::atomic::AtomicBool, mut on: impl FnMut(Step)) -> Result<(), String> {
    let system = system(folder);
    let tools = tools();
    let mut messages = vec![json!({ "role": "user", "content": goal })];
    for _ in 0..MAX_TURNS {
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            on(Step::Done);
            return Ok(());
        }
        let content = match model.reply(&system, &messages, &tools).await {
            Ok(c) => c,
            Err(error) => {
                on(Step::Error { error: error.clone() });
                return Err(error);
            }
        };
        let blocks = content.as_array().cloned().unwrap_or_default();
        let mut results = Vec::new();
        for b in &blocks {
            match b["type"].as_str() {
                Some("text") => on(Step::Text { text: b["text"].as_str().unwrap_or("").to_string() }),
                Some("tool_use") => {
                    let name = b["name"].as_str().unwrap_or("").to_string();
                    let output = folder.call(&name, &b["input"]);
                    on(Step::Tool { name, input: b["input"].clone(), output: output.clone() });
                    results.push(json!({ "type": "tool_result", "tool_use_id": b["id"], "content": output }));
                }
                _ => {}
            }
        }
        messages.push(json!({ "role": "assistant", "content": blocks }));
        if results.is_empty() {
            on(Step::Done);
            return Ok(());
        }
        messages.push(json!({ "role": "user", "content": results }));
    }
    let error = format!("stopped after {MAX_TURNS} turns");
    on(Step::Error { error: error.clone() });
    Err(error)
}

/// Anthropic's Messages API with the key saved in the keychain.
pub struct Anthropic {
    client: reqwest::Client,
    key: String,
}

impl Model for Anthropic {
    async fn reply(&mut self, system: &str, messages: &[Value], tools: &Value) -> Result<Value, String> {
        let body = json!({ "model": MODEL, "max_tokens": 16_000, "system": system, "messages": messages, "tools": tools });
        let res = self.client.post("https://api.anthropic.com/v1/messages").header("x-api-key", &self.key).header("anthropic-version", "2023-06-01").json(&body).send().await.map_err(|e| e.to_string())?;
        let status = res.status();
        let v: Value = res.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(v["error"]["message"].as_str().unwrap_or(status.as_str()).to_string());
        }
        Ok(v["content"].clone())
    }
}

static STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Where each chat's Claude Code session or Codex thread is kept, so the next message continues it.
fn chat_state(chat: &str) -> Result<PathBuf, String> {
    let safe: String = chat.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    if safe.is_empty() {
        return Err("no chat".into());
    }
    let dir = crate::platform::home().join(".formalmind").join("agent");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(safe))
}

/// Claude Code's built-in file tools, and nothing that runs commands.
const CLAUDE_TOOLS: &str = "Read,Write,Edit,Glob,Grep";

/// What one line of Claude Code's stream-json says, as steps.
pub fn claude_steps(line: &Value) -> Vec<Step> {
    let mut out = vec![];
    match line["type"].as_str() {
        Some("assistant") => {
            for c in line["message"]["content"].as_array().into_iter().flatten() {
                match c["type"].as_str() {
                    Some("text") if !c["text"].as_str().unwrap_or("").trim().is_empty() => out.push(Step::Text { text: c["text"].as_str().unwrap_or("").trim().to_string() }),
                    Some("tool_use") => out.push(Step::Tool { name: c["name"].as_str().unwrap_or("").to_string(), input: c["input"].clone(), output: String::new() }),
                    _ => {}
                }
            }
        }
        Some("result") if line["is_error"] == true => out.push(Step::Error { error: line["result"].as_str().unwrap_or("Claude Code failed").to_string() }),
        _ => {}
    }
    out
}

/// What one line of `codex exec --json` says, as steps.
pub fn codex_steps(line: &Value) -> Vec<Step> {
    if let Some(error) = crate::codex::failure_of(line) {
        return vec![Step::Error { error }];
    }
    if line["type"] != "item.completed" {
        return vec![];
    }
    let item = &line["item"];
    match item["type"].as_str() {
        Some("agent_message") => crate::codex::said(line).map(|text| vec![Step::Text { text }]).unwrap_or_default(),
        Some("file_change") => item["changes"].as_array().into_iter().flatten().map(|c| Step::Tool { name: format!("{}_file", c["kind"].as_str().unwrap_or("edit")), input: json!({ "path": c["path"] }), output: String::new() }).collect(),
        Some("command_execution") => vec![Step::Tool { name: "run".into(), input: json!({ "path": item["command"] }), output: item["aggregated_output"].as_str().unwrap_or("").chars().take(500).collect() }],
        _ => vec![],
    }
}

/// Runs one message through a CLI (Claude Code or Codex), streaming its steps, until it exits or `stop`.
async fn run_cli(mut cmd: tokio::process::Command, parse: fn(&Value) -> Vec<Step>, mut on_line: impl FnMut(&Value), on: &mut impl FnMut(Step)) -> Result<(), String> {
    use tokio::io::AsyncBufReadExt;
    cmd.env("PATH", crate::platform::tool_path(None)).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut lines = tokio::io::BufReader::new(child.stdout.take().ok_or("no output")?).lines();
    let mut stderr = child.stderr.take();
    let mut failed = false;
    loop {
        let next = tokio::select! {
            l = lines.next_line() => l.map_err(|e| e.to_string())?,
            _ = async { while !STOP.load(std::sync::atomic::Ordering::Relaxed) { tokio::time::sleep(std::time::Duration::from_millis(200)).await } } => {
                let _ = child.kill().await;
                on(Step::Done);
                return Ok(());
            }
        };
        let Some(line) = next else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        on_line(&v);
        for step in parse(&v) {
            failed |= matches!(step, Step::Error { .. });
            on(step);
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if !status.success() && !failed {
        let mut err = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = tokio::io::AsyncReadExt::read_to_string(e, &mut err).await;
        }
        let error = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("it stopped with an error").to_string();
        on(Step::Error { error: error.clone() });
        return Err(error);
    }
    on(Step::Done);
    Ok(())
}

/// One message on Claude Code (your Claude plan): its own file tools in the folder, the chat's session resumed.
async fn on_claude(folder: &Folder, chat: &str, goal: &str, model: &str, on: &mut impl FnMut(Step)) -> Result<(), String> {
    let state = chat_state(chat)?.with_extension("claude");
    let resume = state.exists();
    let mut cmd = tokio::process::Command::new(crate::platform::find_tool("claude"));
    cmd.current_dir(&folder.root).args(["-p", "--output-format", "stream-json", "--verbose", "--append-system-prompt"]).arg(system(folder));
    cmd.args(["--tools", CLAUDE_TOOLS, "--allowedTools", CLAUDE_TOOLS, "--permission-mode", "acceptEdits", "--strict-mcp-config"]);
    if !model.is_empty() {
        cmd.args(["--model", model]);
    }
    cmd.args([if resume { "--resume" } else { "--session-id" }, chat]).arg(goal);
    let result = run_cli(cmd, claude_steps, |_| {}, on).await;
    let _ = std::fs::write(&state, chat);
    result
}

/// One message on Codex (your ChatGPT plan): its workspace-write sandbox on the folder, the chat's thread resumed.
async fn on_codex(folder: &Folder, chat: &str, goal: &str, model: &str, on: &mut impl FnMut(Step)) -> Result<(), String> {
    let state = chat_state(chat)?.with_extension("codex");
    let thread = std::fs::read_to_string(&state).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let mut cmd = tokio::process::Command::new(crate::platform::find_tool("codex"));
    cmd.current_dir(&folder.root).arg("exec");
    if let Some(t) = &thread {
        cmd.args(["resume", t.as_str()]);
    }
    cmd.args(["--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"workspace-write\""]);
    if !model.is_empty() && !model.starts_with("claude") {
        cmd.args(["-m", model]);
    }
    let prompt = if thread.is_some() { goal.to_string() } else { format!("{}\n\n{goal}", system(folder)) };
    cmd.arg(prompt);
    let mut started = None;
    let result = run_cli(cmd, codex_steps, |v| {
        if v["type"] == "thread.started" {
            started = v["thread_id"].as_str().map(str::to_string);
        }
    }, on).await;
    if let Some(t) = started {
        let _ = std::fs::write(&state, t);
    }
    result
}

/// Starts the agent on a folder through the route picked in Settings → Models ("claude-code", "codex", or your own
/// Anthropic key); `chat` keeps one conversation going across messages. Steps arrive as `agent` events.
#[tauri::command]
pub async fn agent_start(app: tauri::AppHandle, folder: String, goal: String, chat: String, provider: Option<String>, model: Option<String>) -> Result<(), String> {
    let f = Folder::open(Path::new(&folder))?;
    STOP.store(false, std::sync::atomic::Ordering::Relaxed);
    let model = model.unwrap_or_default();
    let mut on = |step: Step| {
        let _ = app.emit("agent", json!({ "folder": folder, "chat": chat, "step": step }));
    };
    match provider.as_deref().unwrap_or("claude-code") {
        "claude-code" => on_claude(&f, &chat, &goal, &model, &mut on).await,
        "codex" => on_codex(&f, &chat, &goal, &model, &mut on).await,
        _ => {
            let key = crate::swarm::anthropic_key().ok_or("Add your Anthropic API key in Settings first")?;
            let mut m = Anthropic { client: reqwest::Client::new(), key };
            run(&mut m, &f, &goal, &STOP, on).await
        }
    }
}

#[tauri::command]
pub fn agent_stop() {
    STOP.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn temp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("fm-agent-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    struct Scripted(Vec<Value>);
    impl Model for Scripted {
        async fn reply(&mut self, _: &str, _: &[Value], _: &Value) -> Result<Value, String> {
            if self.0.is_empty() { Err("script ran out".into()) } else { Ok(self.0.remove(0)) }
        }
    }

    #[test]
    fn b65_paths_stay_inside() {
        let d = temp();
        let f = Folder::open(&d).unwrap();
        assert!(f.path("a/b.txt").is_ok());
        assert!(f.path("../x").is_err());
        assert!(f.path("/etc/passwd").is_err());
        assert!(f.path(&d.canonicalize().unwrap().join("ok.txt").to_string_lossy()).is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/tmp", d.join("out")).unwrap();
            assert!(f.path("out/x").is_err());
        }
    }

    #[test]
    fn b65_reads_writes_edits_and_searches() {
        let d = temp();
        let f = Folder::open(&d).unwrap();
        assert!(f.write("src/a.rs", "fn a() {}\nfn b() {}\n").is_ok());
        assert_eq!(f.read("src/a.rs").unwrap(), "fn a() {}\nfn b() {}\n");
        assert!(f.edit("src/a.rs", "fn", "pub fn").is_err(), "ambiguous edit refused");
        assert!(f.edit("src/a.rs", "fn b", "pub fn b").is_ok());
        assert_eq!(f.search("pub fn", "").unwrap(), "src/a.rs:2: pub fn b() {}");
        assert_eq!(f.list("").unwrap(), vec!["src/a.rs"]);
        assert!(f.write(".git/config", "x").is_err());
        assert!(f.write("src", "x").is_err());
    }

    #[test]
    fn b65_list_skips_dependencies_and_build_output() {
        let d = temp();
        let f = Folder::open(&d).unwrap();
        for p in ["a.txt", "node_modules/x.js", "target/y", ".lake/z", "src/b.txt"] {
            std::fs::create_dir_all(d.join(p).parent().unwrap()).unwrap();
            std::fs::write(d.join(p), "").unwrap();
        }
        assert_eq!(f.list("").unwrap(), vec!["a.txt", "src/b.txt"]);
    }

    #[tokio::test]
    async fn b65_the_loop_runs_tools_until_the_model_stops() {
        let d = temp();
        let f = Folder::open(&d).unwrap();
        let mut model = Scripted(vec![
            json!([{ "type": "text", "text": "Writing." }, { "type": "tool_use", "id": "t1", "name": "write_file", "input": { "path": "x.txt", "content": "hi" } }]),
            json!([{ "type": "text", "text": "Wrote x.txt." }]),
        ]);
        let mut steps = Vec::new();
        run(&mut model, &f, "make x", &AtomicBool::new(false), |s| steps.push(s)).await.unwrap();
        assert_eq!(std::fs::read_to_string(d.join("x.txt")).unwrap(), "hi");
        assert!(matches!(&steps[1], Step::Tool { name, output, .. } if name == "write_file" && output.starts_with("wrote")));
        assert_eq!(steps.last(), Some(&Step::Done));
    }

    #[tokio::test]
    async fn b65_stop_ends_the_run_before_the_next_call() {
        let d = temp();
        let f = Folder::open(&d).unwrap();
        let mut model = Scripted(vec![]);
        let mut steps = Vec::new();
        run(&mut model, &f, "x", &AtomicBool::new(true), |s| steps.push(s)).await.unwrap();
        assert_eq!(steps, vec![Step::Done]);
    }

    #[test]
    fn b65_claude_code_lines_become_steps() {
        let line = json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": " Done. " }, { "type": "tool_use", "name": "Edit", "input": { "file_path": "a.rs" } }] } });
        assert_eq!(claude_steps(&line), vec![Step::Text { text: "Done.".into() }, Step::Tool { name: "Edit".into(), input: json!({ "file_path": "a.rs" }), output: String::new() }]);
        assert!(matches!(claude_steps(&json!({ "type": "result", "is_error": true, "result": "limit" }))[..], [Step::Error { .. }]));
        assert!(claude_steps(&json!({ "type": "result", "is_error": false })).is_empty());
    }

    #[test]
    fn b65_codex_lines_become_steps() {
        let msg = json!({ "type": "item.completed", "item": { "type": "agent_message", "text": "Hi" } });
        assert_eq!(codex_steps(&msg), vec![Step::Text { text: "Hi".into() }]);
        let change = json!({ "type": "item.completed", "item": { "type": "file_change", "changes": [{ "path": "x.ts", "kind": "update" }] } });
        assert!(matches!(&codex_steps(&change)[..], [Step::Tool { name, .. }] if name == "update_file"));
        assert!(matches!(codex_steps(&json!({ "type": "turn.failed", "error": { "message": "usage limit" } }))[..], [Step::Error { .. }]));
    }

    #[tokio::test]
    async fn b65_model_errors_surface() {
        let d = temp();
        let f = Folder::open(&d).unwrap();
        let mut steps = Vec::new();
        assert!(run(&mut Scripted(vec![]), &f, "x", &AtomicBool::new(false), |s| steps.push(s)).await.is_err());
        assert!(matches!(steps[0], Step::Error { .. }));
    }
}
