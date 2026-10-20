//! A swarm that runs on this machine, on one local folder, until the plan is proven, an agent finds a bug, the budget
//! runs out, or you stop it. Planner → prover → reviewer, one item at a time, with the state in the folder's
//! `.formal/` (plan.md, bugs/, runs/). Files, `lake` and `forge` stay here; only the model calls leave: through
//! formal.team's metered Claude proxy (charged to your credits as `local/<folder>` with the agent and item), or straight
//! to Anthropic with your own key.

use crate::executor::{call_tool, clip, inside};
use crate::local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const DEFAULT_MODEL: &str = "claude-opus-5-5";
const MAX_STEPS: usize = 40;
const MAX_ATTEMPTS: usize = 3;

pub struct Swarm {
    stop: AtomicBool,
    inbox: Mutex<Vec<String>>,
    /// Where the run's log lives and what it has spent, so quitting can record the pause.
    folder: String,
    spent: Mutex<f64>,
}

#[derive(Default)]
pub struct Swarms(Mutex<HashMap<String, Arc<Swarm>>>);

#[derive(Deserialize)]
pub struct SwarmRequest {
    pub folder: String,
    /// What to focus on; empty means the whole codebase.
    pub goal: Option<String>,
    pub budget_usd: f64,
    /// formal.team (or a local Worker) and the desktop session token, from the app.
    pub api_base: String,
    /// "formal" (formal.team credits, the default) or "anthropic" (your own key from the keychain, straight to Anthropic).
    pub provider: Option<String>,
    /// claude-opus-5-5 (default), claude-sonnet-5-5 or claude-haiku-5-5.
    pub model: Option<String>,
}

fn anthropic_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("team.formal.desktop", "anthropic").map_err(|e| e.to_string())
}

/// Saves your Anthropic API key in the keychain (empty clears it).
#[tauri::command]
pub fn anthropic_key_set(key: String) -> Result<(), String> {
    let entry = anthropic_entry()?;
    if key.trim().is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    entry.set_password(key.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn anthropic_key_status() -> bool {
    anthropic_entry().and_then(|e| e.get_password().map_err(|e| e.to_string())).is_ok()
}

#[derive(Serialize, Clone)]
struct SwarmEvent {
    run: String,
    /// "status" | "say" | "tool" | "result" | "you" | "bug" | "plan" | "done"
    kind: &'static str,
    role: String,
    item: String,
    text: String,
    spent: f64,
}

fn token() -> Result<String, String> {
    keyring::Entry::new("team.formal.desktop", "session")
        .and_then(|e| e.get_password())
        .map_err(|_| "Sign in to Formal Mind first".to_string())
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

/// Dollars for one call at the model's list price (input, output, cache reads per million; writes 1.25x input).
fn cost(model: &str, usage: &Value) -> f64 {
    let (inp, out, read) = match model {
        m if m.contains("haiku") => (0.1, 0.5, 0.01),
        m if m.contains("sonnet") => (2.0, 10.0, 0.2),
        _ => (4.0, 20.0, 0.2),
    };
    let n = |k: &str| usage[k].as_f64().unwrap_or(0.0);
    (n("input_tokens") * inp + n("cache_creation_input_tokens") * inp * 1.25 + n("cache_read_input_tokens") * read + n("output_tokens") * out) / 1e6
}

fn model_of(req: &SwarmRequest) -> &str {
    match req.model.as_deref() {
        Some(m @ ("claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-5-5")) => m,
        _ => DEFAULT_MODEL,
    }
}

// ---- the plan: .formal/plan.md, a checklist ----

#[derive(Clone, Serialize)]
pub struct PlanItem {
    pub index: usize,
    /// " " todo, "x" proven, "!" blocked
    pub mark: String,
    pub text: String,
}

fn plan_path(root: &Path) -> PathBuf {
    root.join(".formal").join("plan.md")
}

fn read_plan(root: &Path) -> Vec<PlanItem> {
    let text = std::fs::read_to_string(plan_path(root)).unwrap_or_default();
    text.lines()
        .filter_map(|l| {
            let t = l.trim_start();
            let rest = t.strip_prefix("- [")?;
            let mark = rest.chars().next()?;
            let body = rest.get(2..)?.trim().to_string();
            Some((mark.to_string(), body))
        })
        .enumerate()
        .map(|(index, (mark, text))| PlanItem { index: index + 1, mark: if mark == "X" { "x".into() } else { mark }, text })
        .collect()
}

fn set_mark(root: &Path, index: usize, mark: char) {
    let path = plan_path(root);
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let mut n = 0;
    let out: Vec<String> = text
        .lines()
        .map(|l| {
            let t = l.trim_start();
            if t.starts_with("- [") && t.len() > 4 {
                n += 1;
                if n == index {
                    let indent = &l[..l.len() - t.len()];
                    return format!("{indent}- [{mark}]{}", &t[5..]);
                }
            }
            l.to_string()
        })
        .collect();
    let _ = std::fs::write(&path, out.join("\n") + "\n");
}

#[tauri::command]
pub fn swarm_plan(folder: String) -> Result<Vec<PlanItem>, String> {
    if !local::read()?.folders.contains(&folder) {
        return Err("Add the folder first".into());
    }
    Ok(read_plan(Path::new(&folder)))
}

#[derive(Serialize)]
pub struct Bug {
    pub file: String,
    pub title: String,
    pub body: String,
}

/// The bugs agents have reported in this folder, newest first.
#[tauri::command]
pub fn swarm_bugs(folder: String) -> Result<Vec<Bug>, String> {
    if !local::read()?.folders.contains(&folder) {
        return Err("Add the folder first".into());
    }
    let dir = Path::new(&folder).join(".formal").join("bugs");
    let mut bugs: Vec<Bug> = std::fs::read_dir(&dir)
        .map(|it| {
            it.flatten()
                .filter_map(|e| {
                    let body = std::fs::read_to_string(e.path()).ok()?;
                    let title = body.lines().next().unwrap_or("").trim_start_matches('#').trim().to_string();
                    Some(Bug { file: format!(".formal/bugs/{}", e.file_name().to_string_lossy()), title, body })
                })
                .collect()
        })
        .unwrap_or_default();
    bugs.sort_by(|a, b| b.file.cmp(&a.file));
    Ok(bugs)
}

// ---- roles ----

fn system(role: &str, folder: &str, goal: &str) -> String {
    let common = format!(
        "You are the formalmind {role}, one agent of a small swarm verifying the Ethereum smart contracts in a local folder ({folder}). \
Paths are relative to that folder. Tools run here, on the maintainer's machine: list_files, search, read_file (numbered line ranges), write_file, run (only lake/forge, no shell), report_bug. Proofs must be pure Lean: no #eval or IO. \
The shared state is .formal/: plan.md is the checklist of properties to prove (`- [ ]` todo, `- [x]` proven, `- [!]` blocked); bugs/ holds reported bugs. \
Lean proofs live under formal/ (a Lake project; create it with `lake init Formal` inside formal/ if it's missing — write formal/lakefile.toml and formal/lean-toolchain yourself, toolchain leanprover/lean4:v4.35.0, no Mathlib unless needed). \
Never leave `sorry`, `admit` or new axioms. If you find a real bug (a reachable violation of an intended property, loss of funds, broken accounting, access control), call report_bug with a concrete scenario; a Foundry PoC under test/formal/ that `forge test --match-path` shows failing or exploiting is strongly preferred. \
Be brief; end with one short paragraph saying what you did and what's next.{}",
        if goal.is_empty() { String::new() } else { format!("\n\nThe maintainer's focus: {goal}") }
    );
    let job = match role {
        "planner" => "Read the contracts (src/, README, docs/) and write .formal/plan.md: a title line, then 5 to 12 checklist items, most important first. Each item is one property worth proving or one risky area to check, phrased as a claim, naming the contract and function, e.g. `- [ ] Vault.withdraw never sends more than the caller's shares are worth (src/Vault.sol)`. Keep items small enough for one prover turn. Do not prove anything yourself.",
        "prover" => "Take the plan item you're given: model the relevant Solidity in Lean faithfully (under formal/), state the property, prove it, and check with `lake build` (run from formal/ via `lake build` — the run tool works in the folder root, so use `lake build` only if the lakefile is at the root, otherwise write proofs so that `lake env lean formal/<File>.lean` checks them). If the property is false, that's a bug: show it with a counterexample or a PoC and call report_bug. Address the reviewer's notes if there are any.",
        "reviewer" => "Review the prover's work on the plan item: does the Lean statement really say what the Solidity does (read both), does it check, is there any sorry/admit/axiom? Then call verdict exactly once: approve, or changes with concrete notes. Do not edit proofs yourself. If you spot a real bug in the contract, call report_bug.",
        _ => "The maintainer wrote to the swarm. Answer them directly and briefly, using the tools to look things up. If they ask for a change of focus or a new property, update .formal/plan.md accordingly.",
    };
    format!("{common}\n\n{job}")
}

fn tools(role: &str) -> Value {
    let s = |props: Value, req: Vec<&str>| json!({ "type": "object", "properties": props, "required": req, "additionalProperties": false });
    let mut t = vec![
        json!({ "name": "list_files", "description": "List files under a directory of the folder (skips .git, node_modules, lib, out, cache, target, .lake).", "input_schema": s(json!({ "dir": { "type": "string" } }), vec!["dir"]) }),
        json!({ "name": "read_file", "description": "Read a text file in the folder. Long files come back in numbered slices: pass start_line and end_line (up to 300 lines at a time).", "input_schema": s(json!({ "path": { "type": "string" }, "start_line": { "type": "integer" }, "end_line": { "type": "integer" } }), vec!["path"]) }),
        json!({ "name": "search", "description": "Find lines matching a regex in the folder's .sol, .lean, .md and .toml files (path:line: text). Use it to locate functions before reading them.", "input_schema": s(json!({ "pattern": { "type": "string" }, "dir": { "type": "string", "description": "Subdirectory, e.g. src; empty for all" } }), vec!["pattern"]) }),
        json!({ "name": "run", "description": "Run `lake build`, `lake env lean <file>`, `lake exe cache get`, `lake init|new <Name>`, `forge build` or `forge test [args]` in the folder. Returns exit code and output.", "input_schema": s(json!({ "command": { "type": "string" } }), vec!["command"]) }),
        json!({ "name": "report_bug", "description": "Report a real bug in the contracts. The swarm stops so the maintainer can look.", "input_schema": s(json!({
            "title": { "type": "string" }, "severity": { "type": "string", "enum": ["critical", "high", "medium", "low"] },
            "location": { "type": "string", "description": "file:line" }, "scenario": { "type": "string", "description": "Concrete steps and impact" },
            "evidence": { "type": "string", "description": "PoC test path and the forge output, or the Lean counterexample" } }), vec!["title", "severity", "location", "scenario"]) }),
    ];
    if role != "reviewer" {
        t.push(json!({ "name": "write_file", "description": "Create or overwrite a file in the folder.", "input_schema": s(json!({ "path": { "type": "string" }, "content": { "type": "string" } }), vec!["path", "content"]) }));
    }
    if role == "reviewer" {
        t.push(json!({ "name": "verdict", "description": "Your decision on the plan item.", "input_schema": s(json!({ "decision": { "type": "string", "enum": ["approve", "changes"] }, "notes": { "type": "string" } }), vec!["decision"]) }));
    }
    Value::Array(t)
}

/// What a turn ended with, besides its text.
#[derive(Default)]
struct Outcome {
    summary: String,
    /// Files the agent wrote this turn (the proof, a PoC), folder-relative.
    files: Vec<String>,
    verdict: Option<(bool, String)>,
    bug: Option<String>,
}

struct Turn<'a> {
    app: &'a AppHandle,
    run: &'a str,
    req: &'a SwarmRequest,
    swarm: &'a Swarm,
    client: reqwest::Client,
}

impl Turn<'_> {
    fn emit(&self, kind: &'static str, role: &str, item: &str, text: String) {
        let spent = *self.swarm.spent.lock().unwrap();
        let ev = SwarmEvent { run: self.run.into(), kind, role: role.into(), item: item.into(), text, spent };
        // Kept in the folder too: .formal/runs/<run>.jsonl.
        let log = Path::new(&self.req.folder).join(".formal").join("runs");
        let _ = std::fs::create_dir_all(&log);
        if let Ok(line) = serde_json::to_string(&ev) {
            use std::io::Write;
            let _ = std::fs::OpenOptions::new().create(true).append(true).open(log.join(format!("{}.jsonl", self.run))).and_then(|mut f| writeln!(f, "{line}"));
        }
        let _ = self.app.emit("swarm", ev);
    }

    async fn session(&self, role: &str, item: &str) -> Result<(String, String), String> {
        if self.req.provider.as_deref() == Some("anthropic") {
            let key = anthropic_entry()?.get_password().map_err(|_| "Add your Anthropic key first".to_string())?;
            return Ok((key, "https://api.anthropic.com".into()));
        }
        let folder = Path::new(&self.req.folder).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let res = self
            .client
            .post(format!("{}/api/desktop/model-session", self.req.api_base))
            .bearer_auth(token()?)
            .json(&json!({ "folder": folder, "run": self.run, "role": role, "ref": item }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(json!({}));
        if !status.is_success() {
            return Err(body["error"].as_str().unwrap_or("formal.team refused the model session").to_string());
        }
        Ok((body["key"].as_str().unwrap_or("").to_string(), body["base_url"].as_str().unwrap_or("").to_string()))
    }

    /// One agent turn: a tool loop against Claude until it stops calling tools.
    async fn agent(&self, role: &str, item: &str, task: String) -> Result<Outcome, String> {
        let root = PathBuf::from(&self.req.folder);
        let (key, base) = self.session(role, item).await?;
        let goal = self.req.goal.clone().unwrap_or_default();
        let mut messages = vec![json!({ "role": "user", "content": task })];
        let mut out = Outcome::default();
        self.emit("status", role, item, format!("{role} is working"));
        for _ in 0..MAX_STEPS {
            if self.swarm.stop.load(Ordering::SeqCst) {
                return Ok(out);
            }
            let body = json!({
                "model": model_of(self.req), "max_tokens": 16000, "system": system(role, &self.req.folder, &goal),
                "messages": messages, "tools": tools(role),
                "output_config": { "effort": if role == "prover" { "high" } else { "medium" } },
            });
            let res = self
                .client
                .post(format!("{base}/v1/messages"))
                .header("x-api-key", &key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = res.status();
            let reply: Value = res.json().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(reply["error"]["message"].as_str().unwrap_or("The model call failed").to_string());
            }
            *self.swarm.spent.lock().unwrap() += cost(model_of(self.req), &reply["usage"]);
            let content = reply["content"].clone();
            messages.push(json!({ "role": "assistant", "content": content }));
            let mut results = vec![];
            for block in content.as_array().cloned().unwrap_or_default() {
                match block["type"].as_str() {
                    Some("text") => {
                        let text = block["text"].as_str().unwrap_or("").to_string();
                        if !text.trim().is_empty() {
                            out.summary = text.clone();
                            self.emit("say", role, item, text);
                        }
                    }
                    Some("tool_use") => {
                        let name = block["name"].as_str().unwrap_or("");
                        let input = &block["input"];
                        let shown = input.as_object().map(|o| o.values().filter_map(Value::as_str).map(|v| v.chars().take(90).collect::<String>()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
                        let result = match name {
                            "verdict" => {
                                let ok = input["decision"].as_str() == Some("approve");
                                out.verdict = Some((ok, input["notes"].as_str().unwrap_or("").to_string()));
                                self.emit("tool", role, item, format!("verdict {}", if ok { "approve" } else { "changes" }));
                                "recorded".to_string()
                            }
                            "report_bug" => {
                                let file = write_bug(&root, input);
                                out.bug = Some(input["title"].as_str().unwrap_or("bug").to_string());
                                self.emit("bug", role, item, format!("{} — {}", input["title"].as_str().unwrap_or("bug"), file));
                                format!("recorded in {file}; the swarm will stop after this turn")
                            }
                            "write_file" if role == "planner" && !input["path"].as_str().unwrap_or("").trim_start_matches("./").starts_with(".formal/") => {
                                "error: the planner only writes under .formal/".to_string()
                            }
                            _ => {
                                if name == "write_file" {
                                    let path = input["path"].as_str().unwrap_or("").trim_start_matches("./").to_string();
                                    if !path.is_empty() && !path.starts_with(".formal/") && !out.files.contains(&path) {
                                        out.files.push(path);
                                    }
                                }
                                self.emit("tool", role, item, format!("{name} {shown}"));
                                let r = call_tool(&root, name, input).await;
                                self.emit("result", role, item, r.chars().take(500).collect());
                                r
                            }
                        };
                        results.push(json!({ "type": "tool_result", "tool_use_id": block["id"], "content": clip(result) }));
                    }
                    _ => {}
                }
            }
            if results.is_empty() || reply["stop_reason"].as_str() != Some("tool_use") {
                return Ok(out);
            }
            messages.push(json!({ "role": "user", "content": results }));
        }
        Ok(out)
    }
}

/// .formal/proofs.json: for each proven plan item, the files that prove it and the prover's summary.
fn proofs_path(root: &Path) -> PathBuf {
    root.join(".formal").join("proofs.json")
}

fn record_proof(root: &Path, index: usize, text: &str, files: Vec<String>, summary: &str) {
    let mut all: Value = std::fs::read_to_string(proofs_path(root)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    all[index.to_string()] = json!({ "item": text, "files": files, "summary": summary, "at": now_ms().to_string() });
    let _ = std::fs::write(proofs_path(root), serde_json::to_string_pretty(&all).unwrap_or_default());
}

/// What proves each plan item, by item number.
#[tauri::command]
pub fn swarm_proofs(folder: String) -> Result<Value, String> {
    if !local::read()?.folders.contains(&folder) {
        return Err("Add the folder first".into());
    }
    Ok(std::fs::read_to_string(proofs_path(Path::new(&folder))).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({})))
}

/// A text file in an added folder, for viewing a proof or a PoC.
#[tauri::command]
pub fn folder_read(folder: String, path: String) -> Result<String, String> {
    if !local::read()?.folders.contains(&folder) {
        return Err("Add the folder first".into());
    }
    let p = inside(Path::new(&folder), &path)?;
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

fn write_bug(root: &Path, input: &Value) -> String {
    let dir = root.join(".formal").join("bugs");
    let _ = std::fs::create_dir_all(&dir);
    let n = std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0) + 1;
    let title = input["title"].as_str().unwrap_or("bug");
    let slug: String = title.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>().split('-').filter(|s| !s.is_empty()).take(6).collect::<Vec<_>>().join("-");
    let rel = format!(".formal/bugs/{n:03}-{slug}.md");
    let body = format!(
        "# {title}\n\n**Severity:** {}\n**Location:** {}\n\n## Scenario\n\n{}\n\n## Evidence\n\n{}\n",
        input["severity"].as_str().unwrap_or("?"),
        input["location"].as_str().unwrap_or("?"),
        input["scenario"].as_str().unwrap_or(""),
        input["evidence"].as_str().unwrap_or("(none given)")
    );
    let body = body + &inline_cited(root, &format!("{} {}", input["evidence"].as_str().unwrap_or(""), input["scenario"].as_str().unwrap_or("")));
    let _ = inside(root, &rel).map(|p| std::fs::write(p, body));
    rel
}

/// The PoC tests and Lean files a report cites, inlined as code blocks so the report stands on its own.
fn inline_cited(root: &Path, text: &str) -> String {
    let re = regex::Regex::new(r"[\w./-]+\.(?:t\.sol|sol|lean)").expect("valid regex");
    let mut seen: Vec<String> = vec![];
    let mut out = String::new();
    for m in re.find_iter(text) {
        let path = m.as_str().trim_start_matches("./").to_string();
        // Only tests and proofs: the contracts themselves are already in the repo.
        let is_poc = path.ends_with(".t.sol") || path.ends_with(".lean") || path.contains("/formal/");
        if !is_poc || seen.contains(&path) || seen.len() >= 3 {
            continue;
        }
        let Ok(code) = inside(root, &path).and_then(|p| std::fs::read_to_string(p).map_err(|e| e.to_string())) else { continue };
        let lang = if path.ends_with(".lean") { "lean" } else { "solidity" };
        out.push_str(&format!("\n## Proof of concept: `{path}`\n\n```{lang}\n{}\n```\n", code.trim_end()));
        seen.push(path);
    }
    out
}

/// The loop: answer the maintainer first, plan if there's no plan, then prove and review one item at a time.
async fn run_swarm(turn: &Turn<'_>) -> String {
    let root = PathBuf::from(&turn.req.folder);
    let _ = std::fs::create_dir_all(root.join(".formal"));
    let mut attempts: HashMap<usize, usize> = HashMap::new();
    let mut notes: HashMap<usize, String> = HashMap::new();
    let mut written: HashMap<usize, Vec<String>> = HashMap::new();
    loop {
        if turn.swarm.stop.load(Ordering::SeqCst) {
            return "stopped".into();
        }
        let spent = *turn.swarm.spent.lock().unwrap();
        if spent >= turn.req.budget_usd {
            return format!("budget reached (${spent:.2})");
        }
        let said: Vec<String> = std::mem::take(&mut *turn.swarm.inbox.lock().unwrap());
        if !said.is_empty() {
            let task = format!("The maintainer says:\n\n{}", said.join("\n\n"));
            if let Err(e) = turn.agent("assistant", "you", task).await {
                return format!("failed: {e}");
            }
            continue;
        }
        let plan = read_plan(&root);
        if plan.is_empty() {
            match turn.agent("planner", "plan", "Write the plan.".into()).await {
                Ok(o) if o.bug.is_some() => return format!("bug found: {}", o.bug.unwrap()),
                Ok(_) => {}
                Err(e) => return format!("failed: {e}"),
            }
            let plan = read_plan(&root);
            turn.emit("plan", "planner", "plan", format!("{} items", plan.len()));
            if plan.is_empty() {
                return "failed: the planner wrote no checklist".into();
            }
            continue;
        }
        let Some(item) = plan.iter().find(|i| i.mark == " ").cloned() else {
            let blocked = plan.iter().filter(|i| i.mark == "!").count();
            return if blocked > 0 { format!("done ({} proven, {blocked} blocked)", plan.len() - blocked) } else { format!("done (all {} proven)", plan.len()) };
        };
        let id = item.index.to_string();
        let tries = attempts.entry(item.index).or_insert(0);
        *tries += 1;
        if *tries > MAX_ATTEMPTS {
            set_mark(&root, item.index, '!');
            turn.emit("plan", "reviewer", &id, format!("item {id} blocked after {MAX_ATTEMPTS} attempts"));
            continue;
        }
        let mut task = format!("Plan item {id}: {}", item.text);
        if let Some(n) = notes.get(&item.index) {
            task.push_str(&format!("\n\nThe reviewer asked for changes:\n{n}"));
        }
        let proved = match turn.agent("prover", &id, task).await {
            Ok(o) => o,
            Err(e) => return format!("failed: {e}"),
        };
        let files = written.entry(item.index).or_default();
        for f in &proved.files {
            if !files.contains(f) {
                files.push(f.clone());
            }
        }
        if let Some(bug) = proved.bug {
            return format!("bug found: {bug}");
        }
        if turn.swarm.stop.load(Ordering::SeqCst) {
            return "stopped".into();
        }
        let review = format!("Plan item {id}: {}\n\nThe prover says:\n{}", item.text, proved.summary);
        let reviewed = match turn.agent("reviewer", &id, review).await {
            Ok(o) => o,
            Err(e) => return format!("failed: {e}"),
        };
        if let Some(bug) = reviewed.bug {
            return format!("bug found: {bug}");
        }
        match reviewed.verdict {
            Some((true, _)) => {
                set_mark(&root, item.index, 'x');
                record_proof(&root, item.index, &item.text, written.get(&item.index).cloned().unwrap_or_default(), &proved.summary);
                turn.emit("plan", "reviewer", &id, format!("item {id} proven"));
            }
            Some((false, n)) => {
                notes.insert(item.index, n);
            }
            None => {
                notes.insert(item.index, "The reviewer gave no verdict; make the proof's statement and check obvious.".into());
            }
        }
    }
}

#[tauri::command]
pub fn swarm_start(app: AppHandle, swarms: State<'_, Swarms>, request: SwarmRequest) -> Result<String, String> {
    if !local::read()?.folders.contains(&request.folder) {
        return Err("Add the folder first".into());
    }
    if request.provider.as_deref() == Some("anthropic") {
        anthropic_entry()?.get_password().map_err(|_| "Add your Anthropic key first".to_string())?;
    } else {
        token()?;
    }
    if swarms.0.lock().unwrap().values().len() > 0 {
        return Err("A swarm is already running; stop it first".into());
    }
    let run = format!("local-{:x}", now_ms());
    let swarm = Arc::new(Swarm { stop: AtomicBool::new(false), inbox: Mutex::new(vec![]), folder: request.folder.clone(), spent: Mutex::new(0.0) });
    swarms.0.lock().unwrap().insert(run.clone(), swarm.clone());
    let id = run.clone();
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(600)).build().unwrap_or_default();
        let turn = Turn { app: &app, run: &id, req: &request, swarm: &swarm, client };
        turn.emit("status", "swarm", "", "starting".into());
        let outcome = run_swarm(&turn).await;
        turn.emit("done", "swarm", "", outcome);
        app.state::<Swarms>().0.lock().unwrap().remove(&id);
    });
    Ok(run)
}

#[tauri::command]
pub fn swarm_stop(swarms: State<'_, Swarms>, run: String) {
    if let Some(s) = swarms.0.lock().unwrap().get(&run) {
        s.stop.store(true, Ordering::SeqCst);
    }
}

/// A message to the swarm: the assistant answers it before the next turn.
#[tauri::command]
pub fn swarm_say(swarms: State<'_, Swarms>, run: String, text: String) -> Result<(), String> {
    let map = swarms.0.lock().unwrap();
    let s = map.get(&run).ok_or("The swarm isn't running")?;
    s.inbox.lock().unwrap().push(text);
    Ok(())
}

#[derive(Serialize)]
pub struct Session {
    pub run: String,
    /// The last line's text when the run finished ("done …", "bug found …"), else "".
    pub outcome: String,
    pub spent: f64,
    pub events: usize,
}

fn runs_dir(folder: &str) -> PathBuf {
    Path::new(folder).join(".formal").join("runs")
}

/// Past swarm sessions in this folder, newest first (from .formal/runs/*.jsonl).
#[tauri::command]
pub fn swarm_sessions(folder: String) -> Result<Vec<Session>, String> {
    if !local::read()?.folders.contains(&folder) {
        return Err("Add the folder first".into());
    }
    let mut out: Vec<Session> = std::fs::read_dir(runs_dir(&folder))
        .map(|it| {
            it.flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let run = name.strip_suffix(".jsonl")?.to_string();
                    let text = std::fs::read_to_string(e.path()).ok()?;
                    let last: Value = text.lines().last().and_then(|l| serde_json::from_str(l).ok()).unwrap_or(json!({}));
                    let outcome = if last["kind"] == "done" { last["text"].as_str().unwrap_or("").to_string() } else { String::new() };
                    Some(Session { run, outcome, spent: last["spent"].as_f64().unwrap_or(0.0), events: text.lines().count() })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.run.cmp(&a.run));
    Ok(out)
}

/// One session's events, oldest first.
#[tauri::command]
pub fn swarm_history(folder: String, run: String) -> Result<Vec<Value>, String> {
    if !local::read()?.folders.contains(&folder) {
        return Err("Add the folder first".into());
    }
    if !run.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Bad session id".into());
    }
    let text = std::fs::read_to_string(runs_dir(&folder).join(format!("{run}.jsonl"))).map_err(|e| e.to_string())?;
    Ok(text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
}

/// The app is quitting: stop every swarm and record the pause in its session, so Resume picks up from the plan.
pub fn pause_all(app: &AppHandle) {
    let swarms = app.state::<Swarms>();
    for (run, s) in swarms.0.lock().unwrap().iter() {
        s.stop.store(true, Ordering::SeqCst);
        let ev = SwarmEvent { run: run.clone(), kind: "done", role: "swarm".into(), item: String::new(), text: "paused: the app quit. Resume to carry on from the plan.".into(), spent: *s.spent.lock().unwrap() };
        if let Ok(line) = serde_json::to_string(&ev) {
            use std::io::Write;
            let _ = std::fs::OpenOptions::new().append(true).open(runs_dir(&s.folder).join(format!("{run}.jsonl"))).and_then(|mut f| writeln!(f, "{line}"));
        }
    }
}

/// The running swarm, if any (so the page can reattach after a reload).
#[tauri::command]
pub fn swarm_running(swarms: State<'_, Swarms>) -> Option<String> {
    swarms.0.lock().unwrap().keys().next().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_round_trip() {
        let root = std::env::temp_dir().join(format!("fm-plan-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".formal")).unwrap();
        std::fs::write(plan_path(&root), "# Plan\n\n- [ ] first (a.sol)\n- [x] second\n  - [ ] third\n").unwrap();
        let p = read_plan(&root);
        assert_eq!(p.len(), 3);
        assert_eq!((p[0].mark.as_str(), p[0].text.as_str()), (" ", "first (a.sol)"));
        set_mark(&root, 3, 'x');
        set_mark(&root, 1, '!');
        let p = read_plan(&root);
        assert_eq!(p.iter().map(|i| i.mark.as_str()).collect::<Vec<_>>(), vec!["!", "x", "x"]);
        assert!(std::fs::read_to_string(plan_path(&root)).unwrap().contains("  - [x] third"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
