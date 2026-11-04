//! The swarm's Tauri commands (SPEC.md §1.1), over the rebuilt core in `swarm2`: sessions run in its [`Engine`]
//! (managed as app state), and the reads come from its modules (plan, queue, events, Lake, the folder guard). The
//! names, arguments, return shapes and error strings are the ones the UI and the MCP already use.
//!
//! Also here: the keychain's keys (Anthropic, OpenAI, the session token), shared with the folder agent (agent.rs).

use crate::local;
use crate::swarm2::events;
use crate::swarm2::fsguard;
use crate::swarm2::lake;
use crate::swarm2::plan::{self, Mark};
use crate::swarm2::queue::{self, Queue};
pub use crate::swarm2::session::{Engine, SwarmRequest};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

/// The app's sessions: one [`Engine`], managed by Tauri.
pub type Swarms = Arc<Engine>;

/// The app's engine.
pub fn engine(app: &AppHandle) -> Arc<Engine> {
    app.state::<Swarms>().inner().clone()
}

/// The folder guard of the `[added]` commands.
fn added(folder: &str) -> Result<(), String> {
    if local::read()?.allows(folder) { Ok(()) } else { Err("Add the folder first".into()) }
}

// ---- keys (keychain service `team.formal.desktop`) ----

const SERVICE: &str = "team.formal.desktop";

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// Saves a key (trimmed); empty deletes it.
fn key_set(account: &str, key: &str) -> Result<(), String> {
    let entry = entry(account)?;
    if key.trim().is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    entry.set_password(key.trim()).map_err(|e| e.to_string())
}

fn key_get(account: &str) -> Option<String> {
    entry(account).ok()?.get_password().ok()
}

/// Saves your OpenAI API key in the keychain (empty clears it).
#[tauri::command]
pub fn openai_key_set(key: String) -> Result<(), String> {
    key_set("openai", &key)
}

#[tauri::command]
pub fn openai_key_status() -> bool {
    key_get("openai").is_some()
}

/// Saves your Anthropic API key in the keychain (empty clears it).
#[tauri::command]
pub fn anthropic_key_set(key: String) -> Result<(), String> {
    key_set("anthropic", &key)
}

#[tauri::command]
pub fn anthropic_key_status() -> bool {
    key_get("anthropic").is_some()
}

/// The Anthropic key saved in the keychain, if any.
pub(crate) fn anthropic_key() -> Option<String> {
    key_get("anthropic")
}

fn openai_key() -> Option<String> {
    key_get("openai")
}

/// The desktop session token (formal.team's routes).
pub(crate) fn token() -> Result<String, String> {
    key_get("session").ok_or_else(|| "Sign in to Formal Mind first".to_string())
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

// ---- sessions: the Engine ----

/// B1: starts (or resumes) a session; returns its id.
#[tauri::command]
pub fn swarm_start(swarms: State<'_, Swarms>, request: SwarmRequest) -> Result<String, String> {
    swarms.start(request)
}

/// B5: Stop (never fails).
#[tauri::command]
pub fn swarm_stop(swarms: State<'_, Swarms>, folder: String, run: String) {
    swarms.stop(&folder, &run)
}

/// B20: a message to a running session.
#[tauri::command]
pub fn swarm_say(swarms: State<'_, Swarms>, folder: String, run: String, text: String) -> Result<(), String> {
    swarms.say(&folder, &run, &text)
}

/// B10: a running session's cap.
#[tauri::command]
pub fn swarm_set_budget(swarms: State<'_, Swarms>, folder: String, run: String, usd: f64) -> Result<(), String> {
    swarms.set_budget(&folder, &run, usd)
}

/// B37: Compact now.
#[tauri::command]
pub fn swarm_compact(swarms: State<'_, Swarms>, folder: String, run: String) -> Result<(), String> {
    swarms.compact(&folder, &run)
}

/// The sessions running in this folder.
#[tauri::command]
pub fn swarm_running(swarms: State<'_, Swarms>, folder: String) -> Vec<String> {
    swarms.running(&folder)
}

/// B21: an audit report to read, queued as a `triage` job.
#[tauri::command(async)]
pub fn swarm_triage(swarms: State<'_, Swarms>, folder: String, path: String, session: Option<String>) -> Result<(), String> {
    swarms.triage(&folder, &path, session.as_deref())
}

/// B22: a proof written outside the app, queued for the reviewer.
#[tauri::command]
pub fn swarm_submit_proof(swarms: State<'_, Swarms>, folder: String, function: String, path: String, notes: Option<String>, session: Option<String>) -> Result<Value, String> {
    swarms.submit_proof(&folder, &function, &path, notes.as_deref(), session.as_deref())
}

// ---- reads ----

#[tauri::command(async)]
pub fn swarm_plan(folder: String) -> Result<Vec<plan::PlanItem>, String> {
    added(&folder)?;
    Ok(plan::read(Path::new(&folder)))
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
    added(&folder)?;
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

/// What proves each plan item, by item number (`.formal/proofs.json`).
#[tauri::command(async)]
pub fn swarm_proofs(folder: String) -> Result<Value, String> {
    added(&folder)?;
    let path = Path::new(&folder).join(".formal").join("proofs.json");
    Ok(std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({})))
}

/// A text file in an added folder, for viewing a proof or a PoC.
#[tauri::command(async)]
pub fn folder_read(folder: String, path: String) -> Result<String, String> {
    added(&folder)?;
    let p = fsguard::inside(Path::new(&folder), &path)?;
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

/// An image (or a PDF) in the folder as a `data:` URL.
#[tauri::command(async)]
pub fn folder_image(folder: String, path: String) -> Result<String, String> {
    added(&folder)?;
    let p = fsguard::inside(Path::new(&folder), &path)?;
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        _ => return Err("Not an image or a PDF".into()),
    };
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    if bytes.len() > if ext == "pdf" { 32 << 20 } else { 8 << 20 } {
        return Err("File too large".into());
    }
    Ok(format!("data:{mime};base64,{}", base64(&bytes)))
}

/// The queue as the app sees it: jobs not done yet, and the session's spend.
#[tauri::command(async)]
pub fn swarm_queue(folder: String) -> Result<Value, String> {
    swarm_queue_of(folder, None, false)
}

/// A session's queue (the default session's unless `run`), and with `done`, each finished job's result and summary.
pub fn swarm_queue_of(folder: String, run: Option<String>, done: bool) -> Result<Value, String> {
    added(&folder)?;
    let run = queue::session_id(run.as_deref());
    let q = Queue::load(&queue::queue_path(Path::new(&folder), &run));
    let finished = |j: &&queue::Job| j.state == queue::State::Done;
    let open: Vec<Value> = q.jobs.iter().filter(|j| !finished(j)).map(|j| json!({ "id": j.id, "kind": j.kind, "item": j.item, "state": j.state, "attempt": j.attempt })).collect();
    let mut out = json!({ "run": run, "open": open, "spent": q.spent, "done": q.jobs.iter().filter(finished).count() });
    if done {
        out["finished"] = json!(q
            .jobs
            .iter()
            .filter(finished)
            .map(|j| json!({ "id": j.id, "kind": j.kind, "item": j.item, "attempt": j.attempt, "result": j.result, "summary": j.summary.chars().take(4000).collect::<String>(), "files": j.files }))
            .collect::<Vec<_>>());
    }
    Ok(out)
}

/// B47: past sessions in this folder, newest first.
#[tauri::command(async)]
pub fn swarm_sessions(folder: String) -> Result<Vec<events::Session>, String> {
    added(&folder)?;
    Ok(events::sessions(Path::new(&folder)))
}

/// B47: renames a session.
#[tauri::command]
pub fn swarm_rename(folder: String, run: String, title: String) -> Result<(), String> {
    added(&folder)?;
    events::rename(Path::new(&folder), &run, &title)
}

/// B45: one session's events, oldest first.
#[tauri::command(async)]
pub fn swarm_history(folder: String, run: String) -> Result<Vec<Value>, String> {
    added(&folder)?;
    events::history(Path::new(&folder), &run)
}

// ---- work from outside the app: an agent through the MCP (lib/mac-ops.ts) ----

fn rel(root: &Path, p: &Path) -> Option<String> {
    p.strip_prefix(root).ok().map(|p| p.to_string_lossy().replace('\\', "/"))
}

/// What's covered and what's left (B53).
#[tauri::command(async)]
pub fn swarm_work_map(folder: String) -> Result<Value, String> {
    added(&folder)?;
    let root = PathBuf::from(&folder);
    let ctx = crate::swarm_ctx::context_with(&root, false);
    let lake = lake::lake_dir(&root).and_then(|d| rel(&root, &d));
    let sources = lake::lean_src(&root).and_then(|d| rel(&root, &d));
    let items = plan::read(&root);
    let mut totals: HashMap<&str, usize> = HashMap::new();
    let mut next: Vec<Value> = vec![];
    let contracts: Vec<Value> = ctx
        .contracts
        .iter()
        .map(|c| {
            let functions: Vec<Value> = c
                .functions
                .iter()
                .map(|f| {
                    let status = if f.why.is_some() || f.lean.is_empty() {
                        "not_modeled"
                    } else if f.proved {
                        "proved"
                    } else if !f.theorems.is_empty() {
                        "has_sorry"
                    } else {
                        "in_lean"
                    };
                    *totals.entry(status).or_default() += 1;
                    let item = plan::find_def(&items, &f.lean);
                    let proof = lake::proof_file(&root, &c.name, &f.name);
                    let row = json!({
                        "function": f.name,
                        "lean": f.lean,
                        "status": status,
                        "why": f.why,
                        "theorems": f.theorems,
                        "proofFile": proof,
                        "plan": item.map(|p| json!({ "item": p.index, "mark": p.mark })),
                        "scripts": f.scripts,
                    });
                    if matches!(status, "in_lean" | "has_sorry") && item.is_none_or(|p| p.mark != Mark::Blocked) {
                        next.push(json!({ "function": f.name, "lean": f.lean, "status": status, "proofFile": row["proofFile"], "calledByScripts": !f.scripts.is_empty() }));
                    }
                    row
                })
                .collect();
            json!({ "contract": c.name, "file": c.file, "model": c.model, "functions": functions })
        })
        .collect();
    next.sort_by_key(|n| n["calledByScripts"] != true);
    let count = |m: Mark| items.iter().filter(|p| p.mark == m).count();
    Ok(json!({
        "folder": folder,
        "lake": lake,
        "sources": sources,
        "totals": { "proved": totals.get("proved").copied().unwrap_or(0), "hasSorry": totals.get("has_sorry").copied().unwrap_or(0), "inLean": totals.get("in_lean").copied().unwrap_or(0), "notModeled": totals.get("not_modeled").copied().unwrap_or(0) },
        "plan": { "items": items.len(), "proved": count(Mark::Proved), "blocked": count(Mark::Blocked), "open": count(Mark::Open) },
        "next": next.into_iter().take(25).collect::<Vec<_>>(),
        "contracts": contracts,
        "problems": ctx.problems,
        "regenerated": ctx.regenerated,
    }))
}

/// What the swarm's prover gets for a function.
#[tauri::command(async)]
pub fn swarm_brief(folder: String, function: String) -> Result<String, String> {
    added(&folder)?;
    let root = PathBuf::from(&folder);
    let ctx = crate::swarm_ctx::context_with(&root, false);
    let items = plan::read(&root);
    let text = plan::find_def(&items, &function).map(|p| p.text.clone()).unwrap_or_else(|| format!("`{function}`"));
    Ok(ctx.brief(&text, lake::lake_dir(&root).as_deref(), &root))
}

/// A proof written outside the app, checked as the swarm checks its prover's: no cheats, `lake build` of its module,
/// and which functions the Proofs page now counts as proved by it.
#[tauri::command(async)]
pub async fn swarm_check_proof(folder: String, path: String, content: Option<String>) -> Result<Value, String> {
    added(&folder)?;
    let root = PathBuf::from(&folder);
    let Some(src) = lake::lean_src(&root) else {
        return Err("This folder has no Lake project yet; start the swarm once and its first prover sets one up in formal/".into());
    };
    let file = fsguard::inside(&root, &path)?;
    let proofs = crate::swarm_ctx::layout(&root).1;
    if !path.ends_with(".lean") || !file.starts_with(src.join(proofs)) {
        return Err(format!("Proofs go under {}/{proofs}/ as .lean files", src.strip_prefix(&root).unwrap_or(&src).display()));
    }
    if let Some(text) = &content {
        std::fs::create_dir_all(file.parent().unwrap_or(&src)).and_then(|_| std::fs::write(&file, text)).map_err(|e| e.to_string())?;
    }
    let body = std::fs::read_to_string(&file).map_err(|e| format!("{path}: {e}"))?;
    if let Some(w) = crate::swarm_ctx::cheats(&body) {
        return Ok(json!({ "ok": false, "path": path, "check": format!("{path} uses `{w}`; proofs here can't.") }));
    }
    // The model first: a def formal-ast can now translate has to be in the file Lake builds before a proof can name it.
    let r = root.clone();
    let regenerated = tauri::async_runtime::spawn_blocking(move || crate::swarm_ctx::context(&r).regenerated).await.unwrap_or_default();
    let build = lake::run(&root, &lake::build_command(&root, &[&path])).await.unwrap_or_else(|e| format!("error: {e}"));
    if !build.starts_with("exit 0") {
        let errors: Vec<String> = build.lines().filter(|l| l.contains("error")).take(40).map(String::from).collect();
        return Ok(json!({ "ok": false, "path": path, "regenerated": regenerated, "check": "lake build failed", "errors": if errors.is_empty() { vec![lake::clip(build.clone())] } else { errors } }));
    }
    let r = root.clone();
    let ctx = tauri::async_runtime::spawn_blocking(move || crate::swarm_ctx::context(&r)).await.unwrap_or_default();
    let proves: Vec<Value> = ctx
        .contracts
        .iter()
        .flat_map(|c| c.functions.iter())
        .filter(|f| f.theorems.iter().any(|t| t.starts_with(&path) || path.ends_with(t.split(':').next().unwrap_or("\0"))))
        .map(|f| json!({ "lean": f.lean, "proved": f.proved, "theorems": f.theorems }))
        .collect();
    Ok(json!({ "ok": true, "path": path, "check": "lake build passes, no cheats", "proves": proves, "regenerated": regenerated }))
}

/// B34: rewrites each generated model formal-ast now translates more of. Returns what was rewritten.
#[tauri::command(async)]
pub fn swarm_refresh_model(folder: String) -> Result<Vec<String>, String> {
    added(&folder)?;
    Ok(crate::swarm_ctx::context(&PathBuf::from(&folder)).regenerated)
}

/// B31: the ledger, Lean rerun only when the sources changed (or with `force`), as the loop builds it.
pub async fn ledger(root: &Path, check: bool, force: bool) -> Result<Value, String> {
    let r = root.to_path_buf();
    crate::swarm2::ledger::build(root, check, force, move |cmd: String| {
        let r = r.clone();
        async move { lake::run(&r, &cmd).await.unwrap_or_else(|e| e) }
    })
    .await
}

#[tauri::command(async)]
pub async fn swarm_ledger(folder: String, check: Option<bool>, force: Option<bool>) -> Result<Value, String> {
    added(&folder)?;
    ledger(Path::new(&folder), check.unwrap_or(true), force.unwrap_or(false)).await
}

// ---- the chat's suggested reply ----

const SUGGEST_SYSTEM: &str = "You draft the user's next message to a swarm of agents (planner, prover, reviewer) proving a codebase correct. Reply to what the agents last asked or reported, as the user, in one to three plain sentences. Output only the message.";

/// A key and base URL for one model call: your own key, or a formal.team session billed to your credits.
async fn model_access(client: &reqwest::Client, folder_path: &str, api_base: &str, provider: Option<&str>, run: &str, role: &str, item: &str) -> Result<(String, String), String> {
    match provider {
        Some("anthropic") => return Ok((anthropic_key().ok_or("Add your Anthropic key first")?, "https://api.anthropic.com".into())),
        Some("openai") => return Ok((openai_key().ok_or("Add your OpenAI key first")?, "https://api.openai.com".into())),
        Some("claude-code") => return Err("Claude Code runs this on your Claude plan, not through a key".into()),
        Some("codex") => return Err("Codex runs this on your ChatGPT plan, not through a key".into()),
        _ => {}
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

/// Drafts what you might say next in the swarm chat, from its recent lines; you edit or send it yourself.
#[tauri::command]
pub async fn swarm_suggest(folder: String, api_base: String, provider: Option<String>, run: String, transcript: String) -> Result<String, String> {
    let ask = format!("The chat so far:\n{transcript}\n\nDraft my next message.");
    if provider.as_deref() == Some("claude-code") {
        return crate::claude_code::ask(&folder, SUGGEST_SYSTEM, &ask, "claude-haiku-5-5").await;
    }
    if provider.as_deref() == Some("codex") {
        return crate::codex::ask(&folder, SUGGEST_SYSTEM, &ask, "gpt-5.6-luna").await;
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().unwrap_or_default();
    let (key, base) = model_access(&client, &folder, &api_base, provider.as_deref(), &run, "assistant", "suggest").await?;
    let openai = provider.as_deref() == Some("openai");
    let mut body = json!({
        "model": "claude-haiku-5-5", "max_tokens": 400,
        "system": SUGGEST_SYSTEM,
        "messages": [{ "role": "user", "content": ask }],
    });
    let res = if openai {
        body["model"] = json!("gpt-5-mini");
        client.post(format!("{base}/v1/chat/completions")).bearer_auth(&key).json(&crate::openai::request(&body)).send().await
    } else {
        client.post(format!("{base}/v1/messages")).header("x-api-key", &key).header("anthropic-version", "2023-06-01").json(&body).send().await
    }
    .map_err(|e| e.to_string())?;
    let status = res.status();
    let reply: Value = res.json().await.map_err(|e| e.to_string())?;
    let reply = if openai { crate::openai::reply(&reply, false) } else { reply };
    if !status.is_success() {
        return Err(reply["error"]["message"].as_str().unwrap_or("The model call failed").to_string());
    }
    Ok(reply["content"].as_array().into_iter().flatten().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("").trim().to_string())
}

// ---- the app's life: dev autostart (B13), quit (B11) ----

/// B13: debug builds only. `FM_SWARM_AUTOSTART=<added folder>` starts its session at launch, as Start does, with
/// `FM_SWARM_GOAL`, `FM_SWARM_BUDGET` (default 10), `FM_SWARM_PROVIDER`, `FM_SWARM_MODEL`, `FM_SWARM_SESSION`,
/// `FM_SWARM_ONLY_QUEUED` (`1`) and `FM_API_BASE`.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub fn autostart_request(env: impl Fn(&str) -> Option<String>) -> Option<SwarmRequest> {
    let folder = env("FM_SWARM_AUTOSTART")?;
    let env = |k: &str| env(k).filter(|v| !v.is_empty());
    Some(SwarmRequest {
        folder,
        goal: env("FM_SWARM_GOAL"),
        budget_usd: env("FM_SWARM_BUDGET").and_then(|v| v.parse().ok()).unwrap_or(10.0),
        api_base: env("FM_API_BASE").unwrap_or_else(|| "https://formal.team".into()),
        provider: env("FM_SWARM_PROVIDER"),
        model: env("FM_SWARM_MODEL"),
        session: env("FM_SWARM_SESSION"),
        only_queued: env("FM_SWARM_ONLY_QUEUED").map(|v| v == "1"),
    })
}

/// Whether any session is running, in any folder (⌘Q).
pub fn any_running(app: &AppHandle) -> bool {
    engine(app).any_running()
}

/// B11: the app is quitting: every session stops and its log records the pause.
pub fn pause_all(app: &AppHandle) {
    engine(app).pause_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b13_autostart_reads_the_environment() {
        let vars: HashMap<&str, &str> = [("FM_SWARM_AUTOSTART", "/f"), ("FM_SWARM_BUDGET", "2.5"), ("FM_SWARM_ONLY_QUEUED", "1"), ("FM_SWARM_GOAL", "")].into();
        let r = autostart_request(|k| vars.get(k).map(|v| v.to_string())).unwrap();
        assert_eq!((r.folder.as_str(), r.budget_usd, r.only_queued, r.goal), ("/f", 2.5, Some(true), None));
        assert_eq!(r.api_base, "https://formal.team");
        assert!(autostart_request(|_| None).is_none());
        let r = autostart_request(|k| (k == "FM_SWARM_AUTOSTART").then(|| "/f".into())).unwrap();
        assert_eq!((r.budget_usd, r.only_queued, r.session), (10.0, None, None));
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
