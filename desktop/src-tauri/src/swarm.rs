//! A swarm that runs on this machine, on one local folder, until the plan is proven, the budget runs out, or you stop
//! it. Planner → prover → reviewer, one item at a time, with the state in the folder's `.formal/` (plan.md, queue.json,
//! runs/). The plan comes from formal-ast (the scripts' entry points, the units, what the Proofs page doesn't show as proved);
//! proofs go into the folder's Lake project against the generated model and must pass `lake build` and the Proofs page's
//! coverage before review; findings land in the audit index Bugs reads (see swarm_ctx). Files, `lake` and `forge` stay
//! here; only the model calls leave: through
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
/// Tool steps per agent turn; proofs take more than plans and reviews.
const MAX_STEPS: usize = 40;
const PROVER_STEPS: usize = 90;
const MAX_ATTEMPTS: usize = 3;

pub struct Swarm {
    stop: AtomicBool,
    /// This session's queue file.
    queue: PathBuf,
    /// Where the run's log lives and what it has spent, so quitting can record the pause.
    folder: String,
    spent: Mutex<f64>,
    /// The spending cap, raised from the chat's header while the swarm runs.
    budget: Mutex<f64>,
    /// Set by the Context panel's Compact now: the working agent compacts before its next step.
    compact_now: AtomicBool,
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
    /// The session to continue: "swarm" (the folder's default) unless you made another with +.
    pub session: Option<String>,
    /// Only the jobs already queued (e.g. reading an audit report), then stop, instead of going on to the plan.
    pub only_queued: Option<bool>,
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
    /// "start" | "status" | "say" | "tool" | "result" | "you" | "bug" | "plan" | "done"
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
    let one = |u: &Value| {
        let n = |k: &str| u[k].as_f64().unwrap_or(0.0);
        (n("input_tokens") * inp + n("cache_creation_input_tokens") * inp * 1.25 + n("cache_read_input_tokens") * read + n("output_tokens") * out) / 1e6
    };
    // A compaction call reports its tokens in `usage.iterations` and zeros at the top level; when the iterations list
    // the message itself, they are the whole bill.
    let iterations = usage["iterations"].as_array().cloned().unwrap_or_default();
    let listed = iterations.iter().any(|i| i["type"] == "message");
    iterations.iter().map(one).sum::<f64>() + if listed { 0.0 } else { one(usage) }
}

// ---- context: how full each agent's window is, and compaction ----
//
// Every reply's usage says how much of the window the conversation takes. Past COMPACT_AT of it, the older steps are
// summarized by the API's on-demand compaction (beta compact-2026-09-04): the summary is a signed `compaction` block
// that goes first in `messages` in place of the steps it covers, and the last KEEP_STEPS steps follow it word for word
// (their thinking stays valid because the cut falls at the reply to a request already sent). The task (and the
// report a triage job attaches) is restated after the kept steps, since a summary can't carry a document.

const COMPACTION_BETA: &str = "compact-2026-09-04";
const COMPACT_AT: f64 = 0.75;
const KEEP_STEPS: usize = 3;

/// The context window of the models the swarm uses (Opus, Sonnet and Haiku 5.5 all take 1M tokens).
fn context_window(_model: &str) -> u64 {
    1_000_000
}

/// Tokens the next request will carry: this reply's whole input (cached or not) plus the reply itself.
fn context_used(usage: &Value) -> u64 {
    ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].iter().map(|k| usage[*k].as_u64().unwrap_or(0)).sum()
}

/// Whether a failed call failed because the conversation no longer fits.
fn too_long(status: u16, message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    status == 413 || (status == 400 && (m.contains("too long") || m.contains("context window") || m.contains("maximum context")))
}

fn has_compaction(messages: &[Value]) -> bool {
    messages.iter().any(|m| m["content"].as_array().is_some_and(|c| c.iter().any(|b| b["type"] == "compaction")))
}

/// Where to cut the conversation: the summary covers `messages[..cut]` and `messages[cut..]` is kept. A cut falls on
/// an assistant reply whose request ended at `cut` (a user turn), so each tool call stays with its result and the kept
/// steps directly follow what was summarized. Keeps up to `keep` steps; None when there are none to keep (summarize all).
fn compact_cut(messages: &[Value], keep: usize) -> Option<usize> {
    let cuts: Vec<usize> = (2..messages.len()).filter(|&i| messages[i]["role"] == "assistant" && messages[i - 1]["role"] == "user").collect();
    match cuts.len() {
        0 => None,
        n => Some(cuts[n.saturating_sub(keep.max(1))]),
    }
}

/// A shorter range to summarize when `messages[..cut]` is itself too long for the summarizer: the cut about halfway.
fn earlier_cut(messages: &[Value], cut: usize) -> Option<usize> {
    (2..cut / 2 + 1).rev().find(|&i| messages[i]["role"] == "assistant" && messages[i - 1]["role"] == "user")
}

/// The conversation after compaction: the summary first, the kept steps unchanged, then the task restated on the last
/// user turn (which hasn't been answered yet, so adding to it edits nothing the model has seen reply to).
fn splice(messages: &[Value], cut: usize, summary: Value, task: &Value) -> Vec<Value> {
    let mut out = vec![json!({ "role": "assistant", "content": summary })];
    out.extend(messages[cut.min(messages.len())..].iter().cloned());
    let mut restated = vec![json!({ "type": "text", "text": "The earlier steps of this job were summarized above. Your task, as first given:" })];
    match task {
        Value::Array(blocks) => restated.extend(blocks.iter().cloned()),
        Value::String(s) => restated.push(json!({ "type": "text", "text": s })),
        other => restated.push(json!({ "type": "text", "text": other.to_string() })),
    }
    match out.last_mut() {
        Some(last) if last["role"] == "user" => {
            let mut content = match last["content"].take() {
                Value::Array(c) => c,
                Value::String(s) => vec![json!({ "type": "text", "text": s })],
                _ => vec![],
            };
            content.extend(restated);
            last["content"] = Value::Array(content);
        }
        _ => out.push(json!({ "role": "user", "content": restated })),
    }
    out
}

const SUMMARY_INSTRUCTIONS: &str = "Summarize this agent's work so far for the agent itself, which continues the job from your summary and the few most recent steps that follow it. Keep: the task and the plan item or report it is about; every file written or changed and what it now holds; the commands run and their results (which `lake build` or `forge test` runs passed or failed, and the errors that matter); findings recorded or bugs reported, with their IDs and statuses; what was tried and didn't work; and what is left to do next. Be specific: names of defs, theorems, lemmas, files, line numbers. Do not call tools; respond with the summary text only.";

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

#[tauri::command(async)]
pub fn swarm_plan(folder: String) -> Result<Vec<PlanItem>, String> {
    if !local::read()?.allows(&folder) {
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
#[tauri::command(async)]
pub fn swarm_bugs(folder: String) -> Result<Vec<Bug>, String> {
    if !local::read()?.allows(&folder) {
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


// ---- the durable queue: .formal/queue.json ----
//
// Every unit of work is a job: plan, prove item N, review item N, answer the maintainer. A job is marked running before
// its agent starts and done (with what it wrote and said) when it ends, and the file is rewritten after each change. If
// the app quits mid-job, the next start finds it still running and resumes it — told what it had already written — so
// finished work is never redone and nothing you sent is lost. Spend is kept here too, as the session's running total.

#[derive(Serialize, Deserialize, Clone, Default)]
struct Job {
    id: u64,
    /// "plan" | "prove" | "review" | "answer"
    kind: String,
    #[serde(default)]
    item: usize,
    /// The plan item's text, or the maintainer's message.
    #[serde(default)]
    text: String,
    /// "queued" | "running" | "done"
    state: String,
    #[serde(default)]
    attempt: usize,
    /// The reviewer's notes for a retry, or the prover's summary for a review.
    #[serde(default)]
    notes: String,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    summary: String,
    /// "approve" | "changes" | "bug" | ""
    #[serde(default)]
    result: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Queue {
    #[serde(default)]
    next_id: u64,
    #[serde(default)]
    jobs: Vec<Job>,
    /// Dollars spent by this folder's swarm, across every start.
    #[serde(default)]
    spent: f64,
}

/// One writer at a time for every folder's queue (the loop and swarm_say both touch it).
static QUEUE_LOCK: Mutex<()> = Mutex::new(());

/// The queue file for a session: the folder's default session keeps .formal/queue.json; ones you add get their own.
fn queue_file(root: &Path, session: &str) -> PathBuf {
    if session == "swarm" { root.join(".formal").join("queue.json") } else { root.join(".formal").join("queues").join(format!("{session}.json")) }
}

fn load_queue(qf: &Path) -> Queue {
    std::fs::read_to_string(qf).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_queue(qf: &Path, q: &Queue) {
    let _ = std::fs::create_dir_all(qf.parent().unwrap_or(qf));
    let tmp = qf.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_string_pretty(q).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, qf);
    }
}

/// Load, change and save a queue file under the lock; returns what `f` returns.
fn with_queue<T>(qf: &Path, f: impl FnOnce(&mut Queue) -> T) -> T {
    let _guard = QUEUE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut q = load_queue(qf);
    let out = f(&mut q);
    save_queue(qf, &q);
    out
}

fn session_of(req: &SwarmRequest) -> String {
    req.session.clone().filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).unwrap_or_else(|| "swarm".into())
}

fn enqueue(q: &mut Queue, kind: &str, item: usize, text: &str, attempt: usize, notes: &str) -> u64 {
    q.next_id += 1;
    let id = q.next_id;
    q.jobs.push(Job { id, kind: kind.into(), item, text: text.into(), state: "queued".into(), attempt, notes: notes.into(), ..Default::default() });
    id
}

fn transcript_path(root: &Path, job: u64) -> PathBuf {
    root.join(".formal").join("jobs").join(format!("{job}.json"))
}

/// Everything the model and the tools said in one job, exactly as sent and received (thinking blocks included).
fn load_transcript(root: &Path, job: u64) -> Option<Vec<Value>> {
    std::fs::read_to_string(transcript_path(root, job)).ok().and_then(|t| serde_json::from_str(&t).ok())
}

fn save_transcript(root: &Path, job: u64, messages: &[Value]) {
    let path = transcript_path(root, job);
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(root));
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_string(messages).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// The queue as the app sees it: jobs not done yet, oldest first, and the session's spend.
#[tauri::command(async)]
pub fn swarm_queue(folder: String) -> Result<Value, String> {
    if !local::read()?.allows(&folder) {
        return Err("Add the folder first".into());
    }
    let q = load_queue(&queue_file(Path::new(&folder), "swarm"));
    let open: Vec<Value> = q.jobs.iter().filter(|j| j.state != "done").map(|j| json!({ "id": j.id, "kind": j.kind, "item": j.item, "state": j.state, "attempt": j.attempt })).collect();
    Ok(json!({ "open": open, "spent": q.spent, "done": q.jobs.iter().filter(|j| j.state == "done").count() }))
}

// ---- roles ----

fn system(role: &str, folder: &str, goal: &str) -> String {
    let root = Path::new(folder);
    let lake = crate::swarm_ctx::lake_dir(root).map(|d| d.strip_prefix(root).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()).map(|d| if d.is_empty() { ".".to_string() } else { d });
    let lean = match &lake {
        Some(d) => format!("Lean proofs live in the folder's Lake project, {d}/ (its lakefile says which libraries `lake build` builds; `lake` always runs there). The model of each entry contract is generated by formal-ast from solc's AST into {d}/Generated/<Contract>.lean: prove things about those defs, never a hand-written model of the Solidity. Mathlib is already built in {d}/.lake; never run `lake update` or edit the lakefile's requires."),
        None => "There is no Lake project yet: create formal/ with `lake init Formal` (toolchain leanprover/lean4:v4.35.0) and write the proofs there.".to_string(),
    };
    let common = format!(
        "You are the formalmind {role}, one agent of a small swarm verifying the Ethereum smart contracts in a local folder ({folder}). \
Paths are relative to that folder. Tools run here, on the maintainer's machine. What you know about the Solidity comes from formal-ast, which reads solc's AST: `functions` lists every function in scope (the contracts the Foundry scripts deploy or call, with their bases), each with its Lean def, place and status on the Proofs page; `function` gives one function's slice (its guards, the storage it reads and writes, the state it touches, its code and its callees' code). Don't list or grep the Solidity sources. The other tools: read_file (numbered line ranges; for Lean files and the test setup a PoC needs), search (regex over the Lean project's .lean files, for lemmas), write_file, run (only lake/forge, no shell), report_bug. Proofs must be pure Lean: no #eval or IO. \
The shared state is .formal/: plan.md is the checklist (`- [ ]` todo, `- [x]` proven, `- [!]` blocked or a bug). {lean} \
Never leave `sorry`, `admit`, `native_decide` or new axioms. \
If you find a real bug (a reachable violation of an intended property, loss of funds, broken accounting, access control), first write a Foundry PoC test under test/formal/ (e.g. test/formal/RouterMatchBook.t.sol, reusing the repo's test setup under test/) whose test passes by demonstrating the exploit, run it with `forge test --match-path <file>`, then call report_bug with that path: it is filed in audit/README.md as an open finding. \
Be brief; end with one short paragraph saying what you did and what's next.{}",
        if goal.is_empty() { String::new() } else { format!("\n\nThe maintainer's focus: {goal}") }
    );
    let job = match role {
        "prover" => "Take the plan item you're given and prove it against the generated def named in your task: read the def in the model and the function's slice (call `function` for any callee you need), state the property as a theorem that names the def fully qualified, prove it, and check with `lake build <Module>`. Reuse the project's existing lemmas (search the Lake project for simp lemmas about the monad). If the property is false, that's a bug: show it with a Foundry PoC and call report_bug, with its scenario, impact and recommendation written as an audit report states them. Address the reviewer's notes if there are any.",
        "auditor" => "You are turning an audit report (attached, or in your task) into the standard audit format (formalmind.audit/v1) that the app shows on its Bugs page. First call record_report once with the report's facts: its title, the auditing firm, the authors, the date (YYYY-MM-DD), the commit and repository it reviewed, the files in scope, and a two-sentence summary. Then call record_finding once per finding, in the report's order, for every finding it lists including informational and gas ones: the report's own ID (H-01, M-2, L-03…; number them F-01, F-02… when it has none), the title, the severity as the report rates it, the full description (the report's words, cleaned of page headers and footers), its impact, its recommendation, the team's response if the report gives one, the locations (repository paths like src/PoolManager.sol with the line when given), the page it starts on, and the status the report gave (reportStatus). Then check the current code for each finding and set `status`: fixed (the issue is gone; say what changed in evidence and name the test that covers it), works as expected (intended, or invalid for this code; say why), acknowledged (accepted, as the report or code says), or open (still there). Use `functions`, `function`, read_file and `forge test --match-path …` for that. Don't fix code or write tests. End with one line: how many findings, and how many of each status.",
        "reviewer" => "Review the prover's work on the plan item: does the Lean statement really say what the Solidity does (read the def in the generated model and the function's slice, in your task), is it about the generated def rather than a restatement, does it check, is there any sorry/admit/axiom? Then call verdict exactly once: approve, or changes with concrete notes. When you approve, give `statement` (what the proof establishes, written for the audit report: third person, what holds, never \"no bug found\"), `assumptions` and `theorems`; they go into Formal Mind's audit file as the property. Do not edit proofs yourself. If you spot a real bug in the contract, say so in your notes; the prover writes the PoC.",
        _ => "The maintainer wrote to the swarm. Answer them directly and briefly, using the tools to look things up. If they ask for a change of focus or a new property, update .formal/plan.md accordingly.",
    };
    format!("{common}\n\n{job}")
}

fn tools(role: &str) -> Value {
    let s = |props: Value, req: Vec<&str>| json!({ "type": "object", "properties": props, "required": req, "additionalProperties": false });
    let mut t = vec![
        json!({ "name": "functions", "description": "Every function in scope, from formal-ast (solc's AST): the contracts the Foundry scripts deploy or call and their bases, each function with its Lean def, place, footprint and status on the Proofs page.", "input_schema": s(json!({}), vec![]) }),
        json!({ "name": "function", "description": "One function's slice from formal-ast: its guards, the storage it reads and writes, the state declarations it touches, its code and its callees' code. By name (`Contract.fn`) or Lean def.", "input_schema": s(json!({ "name": { "type": "string" } }), vec!["name"]) }),
        json!({ "name": "read_file", "description": "Read a text file in the folder (Lean files, the generated model, the test setup a PoC needs). Long files come back in numbered slices: pass start_line and end_line (up to 300 lines at a time).", "input_schema": s(json!({ "path": { "type": "string" }, "start_line": { "type": "integer" }, "end_line": { "type": "integer" } }), vec!["path"]) }),
        json!({ "name": "search", "description": "Find lines matching a regex in the Lean project's .lean files (path:line: text), e.g. simp lemmas about the monad.", "input_schema": s(json!({ "pattern": { "type": "string" } }), vec!["pattern"]) }),
        json!({ "name": "run", "description": "Run `lake build`, `lake env lean <file>`, `lake exe cache get`, `lake init|new <Name>`, `forge build` or `forge test [args]` in the folder. Returns exit code and output.", "input_schema": s(json!({ "command": { "type": "string" } }), vec!["command"]) }),
    ];
    if role == "auditor" {
        t.push(json!({ "name": "record_report", "description": "Record the report's own facts in its standard audit file (formalmind.audit/v1, next to the report). Call once, first.", "input_schema": s(json!({
            "title": { "type": "string" }, "auditor": { "type": "string", "description": "The auditing firm or person" },
            "authors": { "type": "array", "items": { "type": "string" } }, "date": { "type": "string", "description": "YYYY-MM-DD" },
            "commit": { "type": "string" }, "repository": { "type": "string" },
            "scope": { "type": "array", "items": { "type": "string" }, "description": "Files in scope, as repository paths" },
            "summary": { "type": "string" } }), vec!["title"]) }));
        t.push(json!({ "name": "record_finding", "description": "Record one of the report's findings in its standard audit file, with its status in the current code. Calling it again with the same id replaces that finding.", "input_schema": s(json!({
            "id": { "type": "string", "description": "The report's own ID, e.g. H-01" },
            "title": { "type": "string" },
            "severity": { "type": "string", "enum": ["critical", "high", "medium", "low", "informational", "gas"] },
            "status": { "type": "string", "enum": ["fixed", "works as expected", "acknowledged", "open"], "description": "Where it stands in the current code" },
            "reportStatus": { "type": "string", "description": "The status the report itself gave, e.g. Fixed in PR #123, Acknowledged" },
            "locations": { "type": "array", "items": { "type": "object", "properties": { "file": { "type": "string" }, "line": { "type": "integer" } }, "required": ["file"], "additionalProperties": false } },
            "description": { "type": "string" }, "impact": { "type": "string" }, "recommendation": { "type": "string" },
            "response": { "type": "string", "description": "The team's response in the report" },
            "evidence": { "type": "string", "description": "Why this status: what changed (file:line) and the test that covers it, or why it is intended" },
            "tests": { "type": "array", "items": { "type": "string" } },
            "page": { "type": "integer" } }), vec!["id", "title", "severity", "status", "description"]) }));
    }
    if role != "reviewer" && role != "auditor" {
        t.push(json!({ "name": "report_bug", "description": "Report a real bug in the contracts, with its Foundry PoC (already written and passing). The swarm runs the PoC, files the finding in audit/README.md (status Open), audit/formal-mind-swarm.md and Formal Mind's audit file (audit/formal-mind.audit.json, which its report is generated from), and moves on to the next item. Write the title, scenario, impact and recommendation as an audit report states a finding: third person, no process talk.", "input_schema": s(json!({
            "title": { "type": "string" }, "severity": { "type": "string", "enum": ["critical", "high", "medium", "low"] },
            "location": { "type": "string", "description": "file:line" }, "scenario": { "type": "string", "description": "What's wrong and the concrete steps that exploit it, as an audit report describes a finding" },
            "impact": { "type": "string", "description": "What an attacker gains or users lose, as a report states it" },
            "recommendation": { "type": "string", "description": "How to fix it" },
            "poc": { "type": "string", "description": "The PoC test file under test/, e.g. test/formal/RouterMatchBook.t.sol" },
            "evidence": { "type": "string", "description": "Anything else: the Lean counterexample, the property it breaks" } }), vec!["title", "severity", "location", "scenario", "poc"]) }));
        t.push(json!({ "name": "write_file", "description": "Create or overwrite a file in the folder.", "input_schema": s(json!({ "path": { "type": "string" }, "content": { "type": "string" } }), vec!["path", "content"]) }));
    }
    if role == "reviewer" {
        t.push(json!({ "name": "verdict", "description": "Your decision on the plan item. Approving records the property in Formal Mind's audit file (audit/formal-mind.audit.json), which its report is generated from, so approve with statement, assumptions and theorems.", "input_schema": s(json!({
            "decision": { "type": "string", "enum": ["approve", "changes"] },
            "notes": { "type": "string" },
            "statement": { "type": "string", "description": "Approve only: what the proof establishes about the function, as a report states a verified property: third person, present tense, what holds (e.g. \"`Router.swap` reverts unless the caller owns the order; on success it writes only …\"). Markdown; a bulleted list of the theorems' meanings is fine. No first person, no build or plan talk, and never a statement of what wasn't found." },
            "assumptions": { "type": "string", "description": "Approve only: what the proof takes as given (e.g. black-box helpers that don't change storage), stated plainly; empty if none" },
            "theorems": { "type": "array", "items": { "type": "string" }, "description": "Approve only: the names of the theorems that prove it" } }), vec!["decision"]) }));
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
    /// What an approving reviewer said holds (statement, assumptions, theorems), for Formal Mind's audit file.
    property: Option<Value>,
    bug: Option<String>,
}

struct Turn<'a> {
    app: &'a AppHandle,
    run: &'a str,
    req: &'a SwarmRequest,
    swarm: &'a Swarm,
    client: reqwest::Client,
    /// The queue job the current agent turn is working on; its file writes are recorded as they happen.
    job: Mutex<Option<u64>>,
    /// This session's queue file.
    queue: PathBuf,
    /// formal-ast's view of the folder for the current job (read again at each job, and after a proof).
    ctx: Mutex<Option<Arc<crate::swarm_ctx::Context>>>,
}

impl Turn<'_> {
    /// The folder through formal-ast; `fresh` reads it again (theorems change as provers write).
    async fn context(&self, fresh: bool) -> Arc<crate::swarm_ctx::Context> {
        if !fresh {
            if let Some(c) = self.ctx.lock().unwrap().clone() {
                return c;
            }
        }
        let c = Arc::new(read_context(Path::new(&self.req.folder)).await);
        *self.ctx.lock().unwrap() = Some(c.clone());
        c
    }

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
        model_access(&self.client, &self.req.folder, &self.req.api_base, self.req.provider.as_deref(), self.run, role, item).await
    }

    /// A finding needs its PoC: a test under test/ that exists and that the swarm runs before filing it in the
    /// audit index.
    async fn report_bug(&self, root: &Path, input: &Value, role: &str, item: &str) -> Result<(String, String), String> {
        let poc = input["poc"].as_str().unwrap_or("").trim().trim_start_matches("./").to_string();
        if !poc.starts_with("test/") || !poc.ends_with(".sol") {
            return Err("poc must be a Foundry test file under test/ (e.g. test/formal/X.t.sol); write it first".into());
        }
        if !inside(root, &poc)?.exists() {
            return Err(format!("{poc} doesn't exist; write the PoC test first"));
        }
        self.emit("status", role, item, format!("running the PoC {poc}"));
        let forge = crate::executor::run_command(root, &format!("forge test --match-path {poc}")).await.unwrap_or_else(|e| e);
        if forge.starts_with("exit ") && !forge.starts_with("exit 0") && forge.contains("Compiler run failed") {
            return Err(format!("the PoC doesn't compile:\n{}", clip(forge)));
        }
        let tail: String = { let l: Vec<&str> = forge.lines().collect(); l[l.len().saturating_sub(40)..].join("\n") };
        let (id, file) = crate::swarm_ctx::file_finding(root, input, &poc, &tail)?;
        self.emit("bug", role, item, format!("{id} {} — {poc}", input["title"].as_str().unwrap_or("bug")));
        Ok((id, file))
    }
}

/// A key and base URL for one model call: your own Anthropic key, or a formal.team session billed to your credits.
async fn model_access(client: &reqwest::Client, folder_path: &str, api_base: &str, provider: Option<&str>, run: &str, role: &str, item: &str) -> Result<(String, String), String> {
        if provider == Some("anthropic") {
            let key = anthropic_entry()?.get_password().map_err(|_| "Add your Anthropic key first".to_string())?;
            return Ok((key, "https://api.anthropic.com".into()));
        }
        let folder = Path::new(folder_path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let res = client
            .post(format!("{api_base}/api/desktop/model-session"))
            .bearer_auth(token()?)
            .json(&json!({ "folder": folder, "run": run, "role": role, "ref": item }))
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

impl Turn<'_> {
    /// A Messages request for this agent: the step itself, or (with `compaction`) the summary of `messages`.
    fn body(&self, role: &str, goal: &str, messages: &[Value], compaction: Option<Value>) -> Value {
        let mut body = json!({
            "model": model_of(self.req), "max_tokens": 16000, "system": system(role, &self.req.folder, goal),
            "messages": messages, "tools": tools(role),
            // Automatic prompt caching: the stable prefix (system, tools, history) is read back cheaply each step.
            "cache_control": { "type": "ephemeral" },
            "output_config": { "effort": if role == "prover" { "high" } else { "medium" } },
        });
        if let Some(c) = compaction {
            body["compaction"] = c;
        }
        body
    }

    /// POST /v1/messages; the compaction beta goes along when the request asks for a summary or carries one.
    async fn call(&self, key: &str, base: &str, body: &Value) -> Result<(u16, Value), String> {
        let mut req = self.client.post(format!("{base}/v1/messages")).header("x-api-key", key).header("anthropic-version", "2023-06-01");
        if body.get("compaction").is_some() || body["messages"].as_array().is_some_and(|m| has_compaction(m)) {
            req = req.header("anthropic-beta", COMPACTION_BETA);
        }
        let res = req.json(body).send().await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let reply: Value = res.json().await.map_err(|e| e.to_string())?;
        Ok((status, reply))
    }

    /// What the fixed parts of every request in this turn take, for the Context panel: the system prompt, the tool
    /// definitions and the task (with any attached report), counted by /v1/messages/count_tokens (free, not metered)
    /// as differences of three counts. Zeros where a count fails; the panel then shows them as messages.
    async fn measure(&self, key: &str, base: &str, role: &str, goal: &str, task: &Value) -> (u64, u64, u64) {
        let count = |body: Value| async move { self.count(key, base, &body).await };
        let model = model_of(self.req);
        let sys = system(role, &self.req.folder, goal);
        let probe = json!([{ "role": "user", "content": "." }]);
        let Some(with_system) = count(json!({ "model": model, "system": sys, "messages": probe })).await else { return (0, 0, 0) };
        let with_tools = count(json!({ "model": model, "system": sys, "tools": tools(role), "messages": probe })).await.unwrap_or(with_system);
        let with_task = count(json!({ "model": model, "system": sys, "tools": tools(role), "messages": [{ "role": "user", "content": task }] })).await.unwrap_or(with_tools);
        (with_system, with_tools.saturating_sub(with_system), with_task.saturating_sub(with_tools))
    }

    /// /v1/messages/count_tokens for a request body (free, not metered); None when the count fails.
    async fn count(&self, key: &str, base: &str, body: &Value) -> Option<u64> {
        let mut req = self.client.post(format!("{base}/v1/messages/count_tokens")).header("x-api-key", key).header("anthropic-version", "2023-06-01");
        if body["messages"].as_array().is_some_and(|m| has_compaction(m)) {
            req = req.header("anthropic-beta", COMPACTION_BETA);
        }
        let res = req.json(body).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        res.json::<Value>().await.ok()?["input_tokens"].as_u64()
    }

    /// Adds a call's cost to the session's spend.
    fn charge(&self, usage: &Value) {
        let total = {
            let mut spent = self.swarm.spent.lock().unwrap();
            *spent += cost(model_of(self.req), usage);
            *spent
        };
        with_queue(&self.queue, |q| q.spent = total);
    }

    /// Summarizes the older steps of `messages` in place (see `compact_cut` and `splice`). When even those don't fit
    /// the summarizer, a shorter, earlier range is summarized; the next steps compact the rest.
    #[allow(clippy::too_many_arguments)]
    async fn compact(&self, key: &str, base: &str, role: &str, item: &str, goal: &str, messages: &mut Vec<Value>, task: &Value) -> Result<(), String> {
        let mut cut = compact_cut(messages, KEEP_STEPS).unwrap_or(messages.len());
        for _ in 0..4 {
            self.emit("status", role, item, format!("compacting: summarizing {cut} of {} messages", messages.len()));
            let compaction = json!({ "type": "summarize", "instructions": SUMMARY_INSTRUCTIONS });
            let (status, reply) = self.call(key, base, &self.body(role, goal, &messages[..cut], Some(compaction))).await?;
            let message = reply["error"]["message"].as_str().unwrap_or("the compaction call failed").to_string();
            if status < 300 {
                self.charge(&reply["usage"]);
            }
            let stop = reply["stop_reason"].as_str().unwrap_or("");
            if status < 300 && stop == "compaction" {
                let kept = messages.len() - cut;
                *messages = splice(messages, cut, reply["content"].clone(), task);
                // Shown in the chat's tool trace.
                self.emit("tool", role, item, format!("compact: the earlier steps summarized, the last {kept} messages kept"));
                return Ok(());
            }
            let full = if status < 300 { stop == "model_context_window_exceeded" } else { too_long(status, &message) };
            if !full {
                return Err(if status < 300 { format!("no summary came back ({stop})") } else { message });
            }
            cut = earlier_cut(messages, cut).ok_or("the conversation is too long to summarize")?;
        }
        Err("the conversation is too long to summarize".into())
    }

    /// One agent turn: a tool loop against Claude until it stops calling tools.
    async fn agent(&self, role: &str, item: &str, task: impl Into<Value>) -> Result<Outcome, String> {
        let task: Value = task.into();
        let root = PathBuf::from(&self.req.folder);
        let (key, base) = self.session(role, item).await?;
        let goal = self.req.goal.clone().unwrap_or_default();
        // The whole conversation is kept on disk (.formal/jobs/<job>.json) after every step, so a job interrupted by a
        // quit continues the same conversation instead of starting over.
        let job = *self.job.lock().unwrap();
        let saved = job.and_then(|j| load_transcript(&root, j));
        let mut messages = match saved {
            Some(mut m) if !m.is_empty() => {
                // A reply whose tool calls never got results (the app quit mid-step) is dropped; the model redoes that step.
                if m.last().map(|x| x["role"] == "assistant").unwrap_or(false) {
                    m.pop();
                }
                m.push(json!({ "role": "user", "content": "The app quit and this job is being resumed. Carry on from where you were; don't redo finished work." }));
                m
            }
            _ => vec![json!({ "role": "user", "content": task.clone() })],
        };
        let keep = |m: &Vec<Value>| {
            if let Some(j) = job {
                save_transcript(&root, j, m);
            }
        };
        keep(&messages);
        let mut out = Outcome::default();
        self.emit("status", role, item, format!("{role} is working"));
        let steps = if role == "prover" { PROVER_STEPS } else { MAX_STEPS };
        let window = context_window(model_of(self.req));
        // What the last reply said the conversation takes; unknown (0) after a resume. Each step's reply sets it.
        let mut used: u64 = 0;
        let compact_at = (window as f64 * COMPACT_AT) as u64;
        let (sys_tokens, tool_tokens, task_tokens) = self.measure(&key, &base, role, &goal, &task).await;
        // How full this agent's window is and what fills it, for the Context card and panel: after every model call,
        // and after a compaction (counted, since no reply has said yet).
        let context = |used: u64| json!({ "used": used, "window": window, "compact_at": compact_at, "system": sys_tokens, "tools": tool_tokens, "task": task_tokens }).to_string();

        for step in 1..=steps {
            if self.swarm.stop.load(Ordering::SeqCst) {
                return Ok(out);
            }
            // Compact now does nothing on a conversation that is just the task.
            if used >= compact_at || (self.swarm.compact_now.swap(false, Ordering::SeqCst) && messages.len() > 2) {
                // Not fatal: if no summary comes back, the step runs as is and a too-long call compacts below.
                match self.compact(&key, &base, role, item, &goal, &mut messages, &task).await {
                    Ok(()) => {
                        if let Some(n) = self.count(&key, &base, &json!({ "model": model_of(self.req), "system": system(role, &self.req.folder, &goal), "tools": tools(role), "messages": messages })).await {
                            self.emit("context", role, item, context(n));
                        }
                    }
                    Err(e) => self.emit("tool", role, item, format!("compact: no summary yet ({e})")),
                }
                keep(&messages);
            }
            // A heartbeat before each model call, which can take minutes: the board and the plan card show it.
            self.emit("status", role, item, format!("step {step}: thinking"));
            // A conversation that no longer fits (a long job, a resumed one, a large report) is compacted and the step
            // retried once, instead of pausing the swarm on a job that would fail the same way on every resume.
            let mut retried = false;
            let reply = loop {
                let (status, reply) = self.call(&key, &base, &self.body(role, &goal, &messages, None)).await?;
                let message = reply["error"]["message"].as_str().unwrap_or("The model call failed").to_string();
                let full = if status < 300 { reply["stop_reason"] == "model_context_window_exceeded" } else { too_long(status, &message) };
                if status < 300 && !full {
                    break reply;
                }
                if status < 300 {
                    self.charge(&reply["usage"]);
                }
                if !full || retried {
                    return Err(if full { "the conversation is still too long after compacting it".into() } else { message });
                }
                retried = true;
                self.emit("status", role, item, "the conversation no longer fits the context window: compacting it".into());
                self.compact(&key, &base, role, item, &goal, &mut messages, &task).await?;
                keep(&messages);
                if let Some(n) = self.count(&key, &base, &json!({ "model": model_of(self.req), "system": system(role, &self.req.folder, &goal), "tools": tools(role), "messages": messages })).await {
                    self.emit("context", role, item, context(n));
                }
            };
            self.charge(&reply["usage"]);
            used = context_used(&reply["usage"]);
            self.emit("context", role, item, context(used));
            let content = reply["content"].clone();
            messages.push(json!({ "role": "assistant", "content": content }));
            keep(&messages);
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
                                if ok && input["statement"].as_str().is_none_or(|t| t.trim().is_empty()) {
                                    "error: approving needs `statement` (what the proof establishes, as the report states it), `assumptions` and `theorems`".to_string()
                                } else {
                                    out.verdict = Some((ok, input["notes"].as_str().unwrap_or("").to_string()));
                                    out.property = ok.then(|| input.clone());
                                    self.emit("tool", role, item, format!("verdict {}", if ok { "approve" } else { "changes" }));
                                    "recorded".to_string()
                                }
                            }
                            // The Solidity comes from formal-ast, not from the files.
                            "functions" | "function" => {
                                self.emit("tool", role, item, format!("{name} {shown}"));
                                let ctx = self.context(false).await;
                                let r = if name == "functions" {
                                    ctx.functions()
                                } else {
                                    let n = input["name"].as_str().unwrap_or("");
                                    ctx.slice(n).unwrap_or_else(|| format!("error: no function {n} in scope; `functions` lists them"))
                                };
                                self.emit("result", role, item, r.chars().take(500).collect());
                                r
                            }
                            "search" => {
                                self.emit("tool", role, item, format!("search {shown}"));
                                let lake = crate::swarm_ctx::lake_dir(&root).map(|d| d.strip_prefix(&root).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()).unwrap_or_default();
                                let r = crate::executor::search_in(&root, input["pattern"].as_str().unwrap_or(""), &lake, &[".lean"]).unwrap_or_else(|e| format!("error: {e}"));
                                self.emit("result", role, item, r.chars().take(500).collect());
                                r
                            }
                            "record_report" => {
                                let job = *self.job.lock().unwrap();
                                let report = with_queue(&self.queue, |q| q.jobs.iter().find(|j| Some(j.id) == job).map(|j| j.text.clone())).unwrap_or_default();
                                self.emit("tool", role, item, format!("record_report {}", input["title"].as_str().unwrap_or("")));
                                crate::swarm_ctx::record_report(&root, &report, input).map(|p| format!("recorded in {p}")).unwrap_or_else(|e| format!("error: {e}"))
                            }
                            "record_finding" => {
                                // The report is the job's text: its path in the folder.
                                let job = *self.job.lock().unwrap();
                                let report = with_queue(&self.queue, |q| q.jobs.iter().find(|j| Some(j.id) == job).map(|j| j.text.clone())).unwrap_or_default();
                                let r = crate::swarm_ctx::record_finding_json(&root, &report, input);
                                let label = format!("{} {} · {}", input["id"].as_str().unwrap_or(""), input["title"].as_str().unwrap_or(""), input["status"].as_str().unwrap_or(""));
                                self.emit("tool", role, item, format!("record_finding {label}"));
                                r.map(|idx| format!("recorded in {idx}")).unwrap_or_else(|e| format!("error: {e}"))
                            }
                            "report_bug" => {
                                self.emit("tool", role, item, format!("report_bug {shown}"));
                                let r = self.report_bug(&root, input, role, item).await;
                                if let Ok((id, _)) = &r {
                                    out.bug = Some(format!("{id} {}", input["title"].as_str().unwrap_or("bug")));
                                }
                                let r = r.map(|(id, file)| format!("filed as {id} in audit/README.md (open) and {file}; the swarm marks this item and moves on")).unwrap_or_else(|e| format!("error: {e}"));
                                self.emit("result", role, item, r.clone());
                                r
                            }
                            // The swarm keeps .formal/ (it ticks plan items only after the check and the review).
                            "write_file" if role == "prover" && input["path"].as_str().unwrap_or("").trim_start_matches("./").starts_with(".formal") => {
                                "error: .formal/ is the swarm's; it ticks the plan item once your proof checks and is approved".to_string()
                            }
                            _ => {
                                if name == "write_file" {
                                    let path = input["path"].as_str().unwrap_or("").trim_start_matches("./").to_string();
                                    if !path.is_empty() && !path.starts_with(".formal/") && !out.files.contains(&path) {
                                        out.files.push(path.clone());
                                        // Recorded now, so a quit mid-turn still knows what was written.
                                        if let Some(job) = *self.job.lock().unwrap() {
                                            with_queue(&self.queue, |q| {
                                                if let Some(j) = q.jobs.iter_mut().find(|j| j.id == job) {
                                                    if !j.files.contains(&path) {
                                                        j.files.push(path.clone());
                                                    }
                                                }
                                            });
                                        }
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
            keep(&messages);
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
#[tauri::command(async)]
pub fn swarm_proofs(folder: String) -> Result<Value, String> {
    if !local::read()?.allows(&folder) {
        return Err("Add the folder first".into());
    }
    Ok(std::fs::read_to_string(proofs_path(Path::new(&folder))).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({})))
}

/// A text file in an added folder, for viewing a proof or a PoC.
#[tauri::command(async)]
pub fn folder_read(folder: String, path: String) -> Result<String, String> {
    if !local::read()?.allows(&folder) {
        return Err("Add the folder first".into());
    }
    let p = inside(Path::new(&folder), &path)?;
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

/// An image in the folder as a `data:` URL, for Markdown previews (up to 8 MB).
#[tauri::command(async)]
pub fn folder_image(folder: String, path: String) -> Result<String, String> {
    if !local::read()?.allows(&folder) {
        return Err("Add the folder first".into());
    }
    let p = inside(Path::new(&folder), &path)?;
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        // PDFs too: the Code tab shows them in the web view's own PDF viewer.
        "pdf" => "application/pdf",
        _ => return Err("Not an image or a PDF".into()),
    };
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    if bytes.len() > if ext == "pdf" { 32 << 20 } else { 8 << 20 } {
        return Err("File too large".into());
    }
    Ok(format!("data:{mime};base64,{}", base64(&bytes)))
}

pub(crate) fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { T[(n >> (18 - 6 * i)) as usize & 63] as char } else { '=' });
        }
    }
    out
}

/// formal-ast's view of the folder, off the async runtime (solc runs here).
async fn read_context(root: &Path) -> crate::swarm_ctx::Context {
    let root = root.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || crate::swarm_ctx::context(&root)).await.unwrap_or_default()
}

/// Writes the AST's plan items that .formal/plan.md doesn't have yet (one per function in scope; ones the Proofs page
/// already shows as proved come checked). The planner's turn, without a model: returns how many were added.
async fn sync_plan(turn: &Turn<'_>, root: &Path) -> usize {
    turn.emit("status", "planner", "plan", "planner is working".into());
    turn.emit("status", "planner", "plan", "reading the contracts' AST (formal-ast)".into());
    let ctx = turn.context(true).await;
    let path = plan_path(root);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let missing = ctx.missing_items(&text);
    turn.emit("tool", "planner", "plan", format!("functions: {} in scope across {}", ctx.units().len(), ctx.contracts.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ")));
    if !missing.is_empty() {
        let mut out = if text.trim().is_empty() {
            "# Plan\n\nOne item per function in scope, from formal-ast: the contracts the Foundry scripts deploy or call, with their bases; the scripts' calls first, then the internal and library functions the model has a def for. `- [x]` is proved on the Proofs page, `- [!]` blocked or a finding.\n\n".to_string()
        } else {
            text.trim_end().to_string() + "\n"
        };
        for l in &missing {
            out.push_str(l);
            out.push('\n');
        }
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(root));
        let _ = std::fs::write(&path, out);
    }
    for p in &ctx.problems {
        turn.emit("result", "planner", "plan", format!("couldn't read {p}"));
    }
    turn.emit("plan", "planner", "plan", if missing.is_empty() { "the plan has every function in scope".into() } else { format!("{} items from the AST", missing.len()) });
    missing.len()
}

/// The swarm's own check of a prover's work: the Lean files it wrote don't cheat, `lake build` passes, and (when the
/// item names a def of the model) the Proofs page's coverage counts that def as proved. Returns the theorems that prove it.
async fn check_proof(turn: &Turn<'_>, root: &Path, id: &str, text: &str, files: &[String]) -> Result<Vec<String>, String> {
    let lean: Vec<&String> = files.iter().filter(|f| f.ends_with(".lean")).collect();
    if lean.is_empty() {
        return Err("No Lean file was written for this item; write the proof with write_file.".into());
    }
    for f in &lean {
        let body = inside(root, f).and_then(|p| std::fs::read_to_string(p).map_err(|e| e.to_string())).unwrap_or_default();
        if let Some(w) = crate::swarm_ctx::cheats(&body) {
            return Err(format!("{f} uses `{w}`; proofs here can't."));
        }
    }
    if crate::swarm_ctx::lake_dir(root).is_none() {
        return Ok(vec![]);
    }
    turn.emit("status", "prover", id, "checking: lake build".into());
    let build = call_tool(root, "run", &json!({ "command": "lake build" })).await;
    turn.emit("result", "prover", id, build.lines().filter(|l| l.starts_with("exit") || l.contains("error")).take(12).collect::<Vec<_>>().join("\n"));
    if !build.starts_with("exit 0") {
        let errors: Vec<&str> = build.lines().filter(|l| l.contains("error")).take(40).collect();
        return Err(format!("`lake build` failed:\n{}", if errors.is_empty() { clip(build.clone()) } else { errors.join("\n") }));
    }
    let ctx = turn.context(true).await;
    let Some(u) = ctx.target(text) else {
        return Ok(vec![]);
    };
    let lean = u.lean().to_string();
    turn.emit("status", "prover", id, format!("checking: the Proofs page's coverage of {lean}"));
    match u.func {
        Some(f) if f.proved => {
            turn.emit("result", "prover", id, format!("{lean} is proved on the Proofs page: {}", f.theorems.join("; ")));
            Ok(f.theorems.clone())
        }
        _ => Err(format!("`lake build` passes, but no theorem without sorry names `{lean}`, so the Proofs page still shows {} as not proved. State the theorem about `{lean}` itself, spelled fully qualified.", u.name())),
    }
}

/// The loop, driven by the queue: resume an interrupted job, answer the maintainer, then plan, prove and review one item
/// at a time. Works continuously; only the budget (raisable while it runs) or Stop ends it.
async fn run_swarm(turn: &Turn<'_>) -> String {
    let root = PathBuf::from(&turn.req.folder);
    let _ = std::fs::create_dir_all(root.join(".formal"));
    // The plan follows the AST: every function in scope that it doesn't list yet is added at each start.
    sync_plan(turn, &root).await;
    loop {
        if turn.swarm.stop.load(Ordering::SeqCst) {
            return "paused: resume anytime, the queue carries on".into();
        }
        let spent = *turn.swarm.spent.lock().unwrap();
        let budget = *turn.swarm.budget.lock().unwrap();
        if spent >= budget {
            return format!("budget reached (${spent:.2} of ${budget}); raise it and resume to carry on");
        }

        if turn.req.only_queued.unwrap_or(false) && with_queue(&turn.queue, |q| !q.jobs.iter().any(|j| j.state == "running" || j.state == "queued")) {
            return "done: the queued work is finished".into();
        }
        // Next job: an interrupted one first, then your messages, then the rest in order; derive one if the queue is empty.
        let next = with_queue(&turn.queue, |q| {
            let pick = q.jobs.iter().position(|j| j.state == "running")
                .or_else(|| q.jobs.iter().position(|j| j.state == "queued" && j.kind == "answer"))
                .or_else(|| q.jobs.iter().position(|j| j.state == "queued"));
            let idx = match pick {
                Some(i) => i,
                None => {
                    let plan = read_plan(&root);
                    match plan.iter().find(|i| i.mark == " ") {
                        Some(item) => {
                            let tries = q.jobs.iter().filter(|j| j.kind == "prove" && j.item == item.index).count();
                            enqueue(q, "prove", item.index, &item.text, tries + 1, "");
                        }
                        None => {
                            enqueue(q, "plan", 0, "", 1, "");
                        }
                    }
                    q.jobs.len() - 1
                }
            };
            let resumed = q.jobs[idx].state == "running";
            q.jobs[idx].state = "running".into();
            (q.jobs[idx].clone(), resumed)
        });
        let (job, resumed) = next;
        *turn.job.lock().unwrap() = Some(job.id);
        let id = job.item.to_string();
        let resume_note = if resumed {
            format!(
                "\n\nThis job was interrupted (the app quit) and is being resumed. {}Continue from where it stopped; don't redo work that is already there.",
                if job.files.is_empty() { String::new() } else { format!("Files already written for it: {}. ", job.files.join(", ")) }
            )
        } else {
            String::new()
        };

        let outcome = match job.kind.as_str() {
            "answer" => turn.agent("assistant", "you", format!("The maintainer says:\n\n{}{resume_note}", job.text)).await,
            // An audit report to read: a PDF goes to the model as a document; Markdown and text as text.
            "triage" => {
                let report = job.text.clone();
                turn.emit("status", "auditor", "report", format!("reading {report}"));
                let task = format!("The audit report {report} is attached. Record it and every finding it lists in the standard format, each with its status in the current code.{resume_note}");
                let content = match inside(&root, &report).and_then(|p| std::fs::read(&p).map_err(|e| e.to_string())) {
                    Ok(bytes) if report.to_ascii_lowercase().ends_with(".pdf") => json!([
                        { "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": base64(&bytes) }, "title": report },
                        { "type": "text", "text": task }
                    ]),
                    Ok(bytes) => json!(format!("The audit report {report}:\n\n{}\n\n{task}", String::from_utf8_lossy(&bytes))),
                    Err(e) => json!(format!("The report {report} can't be read ({e}). Say so and stop.")),
                };
                turn.agent("auditor", "report", content).await
            }
            "plan" => {
                let _ = &resume_note;
                let added = sync_plan(turn, &root).await;
                let after = read_plan(&root);
                if added == 0 && after.iter().all(|i| i.mark != " ") {
                    with_queue(&turn.queue, |q| if let Some(j) = q.jobs.iter_mut().find(|j| j.id == job.id) { j.state = "done".into(); });
                    return if after.is_empty() { "failed: formal-ast found no function in scope (no script under script/ deploys or calls the contracts)".into() } else { format!("done: every function in scope is proved or blocked ({} items)", after.len()) };
                }
                Ok(Outcome { summary: format!("{added} items from the AST"), ..Default::default() })
            }
            "prove" => {
                turn.emit("status", "prover", &id, "reading the item's def and slice (formal-ast)".into());
                let brief = turn.context(true).await.brief(&job.text, crate::swarm_ctx::lake_dir(&root).as_deref(), &root);
                let mut task = format!("Plan item {id}: {}\n\n{brief}", job.text);
                if !job.notes.is_empty() {
                    task.push_str(&format!("\n\nThe last attempt was sent back:\n{}", job.notes));
                }
                turn.agent("prover", &id, format!("{task}{resume_note}")).await
            }
            _ => {
                let files = if job.files.is_empty() { String::new() } else { format!("\nFiles: {}", job.files.join(", ")) };
                let brief = turn.context(false).await.brief(&job.text, crate::swarm_ctx::lake_dir(&root).as_deref(), &root);
                turn.agent("reviewer", &id, format!("Plan item {id}: {}\n\nThe prover says:\n{}{files}\n\n{brief}{resume_note}", job.text, job.notes)).await
            }
        };
        *turn.job.lock().unwrap() = None;
        let out = match outcome {
            Ok(o) => o,
            // The job stays running in the queue, so the next start picks it up.
            Err(e) => return format!("paused: {e}"),
        };
        if turn.swarm.stop.load(Ordering::SeqCst) && out.summary.is_empty() {
            return "paused: resume anytime, the queue carries on".into();
        }

        // A proof goes to review only once it checks: no cheats, `lake build` passes, and the Proofs page's coverage shows the
        // item's def as proved. Otherwise the prover gets the output back (or the item is blocked after the last try).
        let mut gate: Option<String> = None;
        let mut proved_by: Vec<String> = vec![];
        if job.kind == "prove" && out.bug.is_none() && !turn.swarm.stop.load(Ordering::SeqCst) {
            let files = with_queue(&turn.queue, |q| q.jobs.iter().find(|j| j.id == job.id).map(|j| j.files.clone()).unwrap_or_default());
            let mut all = files.clone();
            all.extend(out.files.iter().cloned());
            match check_proof(turn, &root, &id, &job.text, &all).await {
                Ok(by) => proved_by = by,
                Err(e) => gate = Some(e),
            }
        }

        // Finish the job and queue what follows from it.
        with_queue(&turn.queue, |q| {
            let Some(j) = q.jobs.iter_mut().find(|j| j.id == job.id) else { return };
            j.state = "done".into();
            j.summary = out.summary.clone();
            for f in &out.files {
                if !j.files.contains(f) {
                    j.files.push(f.clone());
                }
            }
            let files = j.files.clone();
            match job.kind.as_str() {
                "prove" if out.bug.is_some() => {
                    j.result = "bug".into();
                    set_mark(&root, job.item, '!');
                }
                "prove" if gate.is_some() => {
                    j.result = "changes".into();
                    let notes = format!("The swarm's check failed:\n{}", gate.clone().unwrap_or_default());
                    if job.attempt >= MAX_ATTEMPTS {
                        set_mark(&root, job.item, '!');
                    } else {
                        let id = enqueue(q, "prove", job.item, &job.text, job.attempt + 1, &notes);
                        if let Some(r) = q.jobs.iter_mut().find(|r| r.id == id) {
                            r.files = files;
                        }
                    }
                }
                "prove" => {
                    let summary = if proved_by.is_empty() { out.summary.clone() } else { format!("{}\n\nChecked by the swarm: `lake build` passes; the Proofs page counts it as proved by {}.", out.summary, proved_by.join("; ")) };
                    let id = enqueue(q, "review", job.item, &job.text, job.attempt, &summary);
                    if let Some(r) = q.jobs.iter_mut().find(|r| r.id == id) {
                        r.files = files;
                    }
                }
                "review" => match (&out.bug, &out.verdict) {
                    (Some(_), _) => {
                        set_mark(&root, job.item, '!');
                    }
                    (None, Some((true, _))) => {
                        set_mark(&root, job.item, 'x');
                        if let Some(p) = &out.property {
                            if let Err(e) = crate::swarm_ctx::record_property(&root, job.item, &job.text, &files, p) {
                                eprintln!("record_property: {e}");
                            }
                        }
                        record_proof(&root, job.item, &job.text, files, &job.notes);
                    }
                    (None, verdict) => {
                        let notes = verdict.as_ref().map(|v| v.1.clone()).unwrap_or_else(|| "The reviewer gave no verdict; make the proof's statement and check obvious.".into());
                        if job.attempt >= MAX_ATTEMPTS {
                            set_mark(&root, job.item, '!');
                        } else {
                            enqueue(q, "prove", job.item, &job.text, job.attempt + 1, &notes);
                        }
                    }
                },
                _ => {}
            }
        });
        match (job.kind.as_str(), &out.bug, &out.verdict) {
            ("prove" | "review", Some(_), _) => turn.emit("plan", &job.kind, &id, format!("item {id}: bug reported, moving on")),
            ("review", None, Some((true, _))) => turn.emit("plan", "reviewer", &id, format!("item {id} proven")),
            ("review", None, _) if job.attempt >= MAX_ATTEMPTS => turn.emit("plan", "reviewer", &id, format!("item {id} blocked after {MAX_ATTEMPTS} attempts")),
            ("prove", None, _) if gate.is_some() && job.attempt >= MAX_ATTEMPTS => turn.emit("plan", "prover", &id, format!("item {id} blocked: the proof didn't check after {MAX_ATTEMPTS} attempts")),
            ("prove", None, _) if gate.is_some() => turn.emit("plan", "prover", &id, format!("item {id}: the check failed, back to the prover")),
            ("prove", None, _) => turn.emit("plan", "prover", &id, format!("item {id} checks; to review")),
            ("triage", _, _) => turn.emit("plan", "auditor", "report", format!("read {}: its findings are in Bugs", job.text)),
            _ => {}
        }
    }
}

/// Earlier versions kept one log per start (runs/local-*.jsonl). Join them, oldest first, into the single session, move
/// the originals to runs/archive/, and carry their spend into the queue's total.
fn merge_old_sessions(root: &Path) {
    let dir = runs_dir(&root.to_string_lossy());
    let mut old: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|it| it.flatten().map(|e| e.path()).filter(|p| p.file_name().map(|n| n.to_string_lossy().starts_with("local-") && n.to_string_lossy().ends_with(".jsonl")).unwrap_or(false)).collect())
        .unwrap_or_default();
    if old.is_empty() {
        return;
    }
    old.sort();
    let mut merged = std::fs::read_to_string(dir.join("swarm.jsonl")).unwrap_or_default();
    let mut carried = 0.0;
    let archive = dir.join("archive");
    let _ = std::fs::create_dir_all(&archive);
    for p in &old {
        let text = std::fs::read_to_string(p).unwrap_or_default();
        carried += text.lines().last().and_then(|l| serde_json::from_str::<Value>(l).ok()).and_then(|v| v["spent"].as_f64()).unwrap_or(0.0);
        // Re-stamp each line as the one session.
        for line in text.lines() {
            if let Ok(mut v) = serde_json::from_str::<Value>(line) {
                v["run"] = json!("swarm");
                merged.push_str(&v.to_string());
                merged.push('\n');
            }
        }
        let _ = std::fs::rename(p, archive.join(p.file_name().unwrap_or_default()));
    }
    let _ = std::fs::write(dir.join("swarm.jsonl"), merged);
    with_queue(&queue_file(root, "swarm"), |q| q.spent += carried);
}

#[tauri::command]
pub fn swarm_start(app: AppHandle, swarms: State<'_, Swarms>, request: SwarmRequest) -> Result<String, String> {
    if !local::read()?.allows(&request.folder) {
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
    // One continuous session per folder: every start appends to .formal/runs/swarm.jsonl and the queue carries on.
    let run = session_of(&request);
    merge_old_sessions(Path::new(&request.folder));
    let qf = queue_file(Path::new(&request.folder), &run);
    let spent = load_queue(&qf).spent;
    // What you typed before starting is a message too: the assistant answers it first (as with one sent while it runs).
    if let Some(text) = request.goal.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        with_queue(&qf, |q| {
            enqueue(q, "answer", 0, text, 1, "");
        });
    }
    let swarm = Arc::new(Swarm { stop: AtomicBool::new(false), folder: request.folder.clone(), queue: qf.clone(), spent: Mutex::new(spent), budget: Mutex::new(request.budget_usd.max(spent)), compact_now: AtomicBool::new(false) });
    swarms.0.lock().unwrap().insert(run.clone(), swarm.clone());
    let id = run.clone();
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(600)).build().unwrap_or_default();
        let turn = Turn { app: &app, run: &id, req: &request, swarm: &swarm, client, job: Mutex::new(None), queue: swarm.queue.clone(), ctx: Mutex::new(None) };
        // The session's title: the focus it was given (the latest start's focus wins).
        turn.emit("start", "swarm", "", request.goal.clone().unwrap_or_default());
        turn.emit("status", "swarm", "", "resuming".into());
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

/// An audit report to read (a PDF, Markdown or text file in the folder): queued as a "triage" job in the session, so a
/// running swarm picks it up next and a stopped one reads it when it starts. The auditor records each finding, with its
/// status in the current code, in the README.md next to the report.
#[tauri::command(async)]
pub fn swarm_triage(folder: String, path: String, session: Option<String>) -> Result<(), String> {
    if !local::read()?.allows(&folder) {
        return Err("Add the folder first".into());
    }
    let root = PathBuf::from(&folder);
    let p = inside(&root, &path)?;
    if !p.is_file() {
        return Err(format!("{path} isn't a file"));
    }
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["pdf", "md", "markdown", "txt"].contains(&ext.as_str()) {
        return Err("Reports are PDF, Markdown or text files".into());
    }
    let qf = queue_file(&root, session.as_deref().unwrap_or("swarm"));
    with_queue(&qf, |q| {
        enqueue(q, "triage", 0, &path, 1, "");
    });
    Ok(())
}

/// A message to the swarm: queued as an "answer" job (on disk, so a quit can't lose it), answered before the next turn.
#[tauri::command]
pub fn swarm_say(swarms: State<'_, Swarms>, run: String, text: String) -> Result<(), String> {
    let qf = {
        let map = swarms.0.lock().unwrap();
        map.get(&run).ok_or("The swarm isn't running")?.queue.clone()
    };
    with_queue(&qf, |q| {
        enqueue(q, "answer", 0, &text, 1, "");
    });
    Ok(())
}

#[derive(Serialize)]
pub struct Session {
    pub run: String,
    /// The focus the session was started with, or "" when none was given.
    pub title: String,
    /// The last line's text when the run finished ("done …", "bug found …"), else "".
    pub outcome: String,
    pub spent: f64,
    pub events: usize,
}

fn runs_dir(folder: &str) -> PathBuf {
    Path::new(folder).join(".formal").join("runs")
}

/// Past swarm sessions in this folder, newest first (from .formal/runs/*.jsonl).
#[tauri::command(async)]
pub fn swarm_sessions(folder: String) -> Result<Vec<Session>, String> {
    if !local::read()?.allows(&folder) {
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
                    let title = text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|e| e["kind"] == "start").and_then(|e| e["text"].as_str().map(String::from)).unwrap_or_default();
                    let outcome = if last["kind"] == "done" { last["text"].as_str().unwrap_or("").to_string() } else { String::new() };
                    Some(Session { run, title, outcome, spent: last["spent"].as_f64().unwrap_or(0.0), events: text.lines().count() })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.run.cmp(&a.run));
    Ok(out)
}

/// One session's events, oldest first.
#[tauri::command(async)]
pub fn swarm_history(folder: String, run: String) -> Result<Vec<Value>, String> {
    if !local::read()?.allows(&folder) {
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

/// Raises (or lowers) a running swarm's spending cap.
#[tauri::command]
pub fn swarm_set_budget(swarms: State<'_, Swarms>, run: String, usd: f64) -> Result<(), String> {
    let map = swarms.0.lock().unwrap();
    let s = map.get(&run).ok_or("The swarm isn't running")?;
    *s.budget.lock().unwrap() = usd.max(0.0);
    Ok(())
}

/// Compacts the working agent's conversation before its next step (the Context panel's Compact now).
#[tauri::command]
pub fn swarm_compact(swarms: State<'_, Swarms>, run: String) -> Result<(), String> {
    let map = swarms.0.lock().unwrap();
    let s = map.get(&run).ok_or("The swarm isn't running")?;
    s.compact_now.store(true, Ordering::SeqCst);
    Ok(())
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
    fn queue_and_transcripts_survive_a_restart() {
        let root = std::env::temp_dir().join(format!("fm-queue-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".formal")).unwrap();
        let qf = queue_file(&root, "swarm");
        let id = with_queue(&qf, |q| {
            let id = enqueue(q, "prove", 3, "item three", 1, "");
            q.jobs[0].state = "running".into();
            q.spent = 1.25;
            id
        });
        // Reloaded from disk, as after a quit: the job is still running and the spend kept.
        let q = load_queue(&qf);
        assert_eq!((q.jobs[0].state.as_str(), q.jobs[0].id, q.spent), ("running", id, 1.25));
        save_transcript(&root, id, &[json!({"role": "user", "content": "go"}), json!({"role": "assistant", "content": [{"type": "tool_use"}]})]);
        assert_eq!(load_transcript(&root, id).unwrap().len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A job's conversation: the task (a report attached), then `steps` replies each calling a tool and its result.
    fn conversation(steps: usize) -> (Value, Vec<Value>) {
        let task = json!([
            { "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": "JVBERi0=" }, "title": "audit/report.pdf" },
            { "type": "text", "text": "Record every finding." }
        ]);
        let mut m = vec![json!({ "role": "user", "content": task.clone() })];
        for s in 0..steps {
            m.push(json!({ "role": "assistant", "content": [
                { "type": "thinking", "thinking": "", "signature": format!("sig{s}") },
                { "type": "tool_use", "id": format!("t{s}"), "name": "functions", "input": {} }
            ] }));
            m.push(json!({ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": format!("t{s}"), "content": format!("result {s}") }] }));
        }
        (task, m)
    }

    /// Every tool_use is answered by a tool_result in the next message, and every tool_result answers one.
    fn pairs_valid(m: &[Value]) -> bool {
        let ids = |v: &Value, ty: &str, key: &str| -> Vec<String> {
            v["content"].as_array().map(|c| c.iter().filter(|b| b["type"] == ty).map(|b| b[key].as_str().unwrap_or("").to_string()).collect()).unwrap_or_default()
        };
        (0..m.len()).all(|i| {
            let uses = ids(&m[i], "tool_use", "id");
            let answered = m.get(i + 1).map(|n| ids(n, "tool_result", "tool_use_id")).unwrap_or_default();
            let results = ids(&m[i], "tool_result", "tool_use_id");
            let asked = if i == 0 { vec![] } else { ids(&m[i - 1], "tool_use", "id") };
            uses.iter().all(|u| answered.contains(u)) && results.iter().all(|r| asked.contains(r))
        })
    }

    #[test]
    fn compaction_keeps_head_and_tail_with_valid_pairs() {
        let (task, m) = conversation(10);
        let cut = compact_cut(&m, KEEP_STEPS).unwrap();
        // The cut is the reply to a request that ended on a user turn, KEEP_STEPS steps from the end.
        assert_eq!(m[cut]["role"], "assistant");
        assert_eq!(m[cut - 1]["role"], "user");
        assert_eq!(m.len() - cut, 2 * KEEP_STEPS);
        assert!(pairs_valid(&m[..cut]));

        let summary = json!([{ "type": "compaction", "content": "Summary.", "signature": "s" }]);
        let out = splice(&m, cut, summary.clone(), &task);
        assert!(pairs_valid(&out));
        // The summary first, as an assistant message of its own.
        assert_eq!(out[0], json!({ "role": "assistant", "content": summary }));
        assert!(has_compaction(&out));
        // The kept steps follow it unchanged, thinking blocks included.
        assert_eq!(&out[1..out.len() - 1], &m[cut..m.len() - 1]);
        // The last user turn keeps its tool results first, then the task (with its document) restated.
        let last = out.last().unwrap()["content"].as_array().unwrap().clone();
        assert_eq!(last[0], m.last().unwrap()["content"][0]);
        assert_eq!(last[0]["type"], "tool_result");
        assert_eq!(&last[last.len() - 2..], task.as_array().unwrap().as_slice());
        assert_eq!(out.len(), 1 + 2 * KEEP_STEPS);
    }

    #[test]
    fn compaction_of_a_short_or_resumed_job() {
        // Fewer steps than KEEP_STEPS: the first step is summarized, the rest kept; one step alone is summarized whole.
        assert_eq!(compact_cut(&conversation(2).1, KEEP_STEPS), Some(3));
        assert_eq!(compact_cut(&conversation(1).1, KEEP_STEPS), None);
        // Nothing to keep: the whole conversation is summarized and the task restated as a new user turn.
        let task = json!("Prove item 3.");
        let only = vec![json!({ "role": "user", "content": "Prove item 3." })];
        assert_eq!(compact_cut(&only, KEEP_STEPS), None);
        let out = splice(&only, only.len(), json!([{ "type": "compaction", "content": "S", "signature": "s" }]), &task);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1]["role"], "user");
        assert_eq!(out[1]["content"][1]["text"], "Prove item 3.");
        // A resumed job ends with the quit note (a string); the task joins it as blocks.
        let (task, mut m) = conversation(6);
        m.push(json!({ "role": "user", "content": "The app quit and this job is being resumed." }));
        let cut = compact_cut(&m, KEEP_STEPS).unwrap();
        let out = splice(&m, cut, json!([{ "type": "compaction", "content": "S", "signature": "s" }]), &task);
        assert!(pairs_valid(&out));
        assert_eq!(out.last().unwrap()["content"][0]["text"], "The app quit and this job is being resumed.");
        // Compacting again: the old summary is inside the new range, never kept in front of it.
        let again = compact_cut(&out, 1).unwrap();
        assert!(again > 0 && out[again]["role"] == "assistant");
        // A range too long for the summarizer halves, still on a valid cut.
        let (_, m) = conversation(20);
        let half = earlier_cut(&m, m.len()).unwrap();
        assert!(half <= m.len() / 2 && m[half]["role"] == "assistant" && m[half - 1]["role"] == "user");
        assert!(pairs_valid(&m[..half]));
    }

    #[test]
    fn usage_counts_the_window_and_compaction_cost() {
        let u = json!({ "input_tokens": 10, "cache_creation_input_tokens": 200, "cache_read_input_tokens": 3000, "output_tokens": 40 });
        assert_eq!(context_used(&u), 3250);
        // A compaction call: zeros at the top level, the cost in iterations.
        let c = json!({ "input_tokens": 0, "output_tokens": 0, "iterations": [{ "type": "compaction", "input_tokens": 1_000_000, "output_tokens": 0 }] });
        assert!((cost("claude-opus-5-5", &c) - 4.0).abs() < 1e-9);
        assert!(too_long(400, "prompt is too long: 1200000 tokens > 1000000 maximum"));
        assert!(!too_long(400, "messages.1: tool_use ids must be unique"));
    }

    #[test]
    fn old_sessions_merge_into_one() {
        let root = std::env::temp_dir().join(format!("fm-merge-{}", std::process::id()));
        let runs = root.join(".formal").join("runs");
        std::fs::create_dir_all(&runs).unwrap();
        std::fs::write(runs.join("local-1.jsonl"), "{\"run\":\"local-1\",\"kind\":\"say\",\"spent\":1.0}\n").unwrap();
        std::fs::write(runs.join("local-2.jsonl"), "{\"run\":\"local-2\",\"kind\":\"say\",\"spent\":2.5}\n").unwrap();
        merge_old_sessions(&root);
        let merged = std::fs::read_to_string(runs.join("swarm.jsonl")).unwrap();
        assert_eq!(merged.lines().count(), 2);
        assert!(merged.lines().all(|l| l.contains("\"run\":\"swarm\"")));
        assert!(runs.join("archive").join("local-1.jsonl").exists());
        assert_eq!(load_queue(&queue_file(&root, "swarm")).spent, 3.5);
        std::fs::remove_dir_all(root).unwrap();
    }

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

/// Drafts what you might say next in the swarm chat, from its recent lines; you edit or send it yourself.
#[tauri::command]
pub async fn swarm_suggest(folder: String, api_base: String, provider: Option<String>, run: String, transcript: String) -> Result<String, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().unwrap_or_default();
    let (key, base) = model_access(&client, &folder, &api_base, provider.as_deref(), &run, "assistant", "suggest").await?;
    let body = json!({
        "model": "claude-haiku-5-5", "max_tokens": 400,
        "system": "You draft the user's next message to a swarm of agents (planner, prover, reviewer) proving a codebase correct. Reply to what the agents last asked or reported, as the user, in one to three plain sentences. Output only the message.",
        "messages": [{ "role": "user", "content": format!("The chat so far:\n{transcript}\n\nDraft my next message.") }],
    });
    let res = client.post(format!("{base}/v1/messages")).header("x-api-key", &key).header("anthropic-version", "2023-06-01").json(&body).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let reply: Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(reply["error"]["message"].as_str().unwrap_or("The model call failed").to_string());
    }
    Ok(reply["content"].as_array().into_iter().flatten().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("").trim().to_string())
}
