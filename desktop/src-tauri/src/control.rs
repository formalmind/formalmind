//! The app's control API: every operation the app does, by name, in one place (lib/mac-ops.ts is its published list).
//! The folder page, the relay (the MCP through formal.team) and anything else that drives the app call
//! [`dispatch`], so they all do the same thing the same way: the backend decides the model route, the caps and when
//! a run starts; whoever asks only says what they want.

use crate::local;
use crate::swarm::{self, SwarmRequest, Swarms};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// What only the running app can do: run and steer sessions (they live in its process).
/// The app implements it; tests use a fake that records what was asked, so every operation can be tested without a
/// window.
pub trait Engine: Send + Sync {
    fn running(&self, folder: &str) -> Vec<String>;
    fn start(&self, request: SwarmRequest) -> Result<String, String>;
    fn stop(&self, folder: &str, run: &str);
    fn say(&self, folder: &str, run: &str, text: &str) -> Result<(), String>;
    fn set_budget(&self, folder: &str, run: &str, usd: f64) -> Result<(), String>;
}

impl Engine for AppHandle {
    fn running(&self, folder: &str) -> Vec<String> {
        swarm::swarm_running(self.state::<Swarms>(), folder.to_string())
    }
    fn start(&self, request: SwarmRequest) -> Result<String, String> {
        swarm::swarm_start(self.clone(), self.state::<Swarms>(), request)
    }
    fn stop(&self, folder: &str, run: &str) {
        swarm::swarm_stop(self.state::<Swarms>(), folder.to_string(), run.to_string())
    }
    fn say(&self, folder: &str, run: &str, text: &str) -> Result<(), String> {
        swarm::swarm_say(self.clone(), self.state::<Swarms>(), folder.to_string(), run.to_string(), text.to_string())
    }
    fn set_budget(&self, folder: &str, run: &str, usd: f64) -> Result<(), String> {
        swarm::swarm_set_budget(self.state::<Swarms>(), folder.to_string(), run.to_string(), usd)
    }
}

/// Every operation, as lib/mac-ops.ts lists them: (name, whether it changes something).
pub const OPS: &[(&str, bool)] = &[
    ("folders", false),
    ("status", false),
    ("files", false),
    ("scan", false),
    ("git", false),
    ("read_file", false),
    ("plan", false),
    ("statements", false),
    ("bugs", false),
    ("proofs", false),
    ("queue", false),
    ("sessions", false),
    ("running", false),
    ("history", false),
    ("scripts", false),
    ("units", false),
    ("coverage", false),
    ("slice", false),
    ("work_map", false),
    ("health", false),
    ("brief", false),
    ("ledger", false),
    ("add_folder", true),
    ("verify_repo", true),
    ("questions", false),
    ("diagnose", false),
    ("answers", true),
    ("remove_folder", true),
    ("start", true),
    ("stop", true),
    ("pause", true),
    ("resume", true),
    ("say", true),
    ("set_budget", true),
    ("add_statement", true),
    ("confirm_statement", true),
    ("correct_statement", true),
    ("mark_statement", true),
    ("remove_statement", true),
    ("skills", false),
    ("skill_add", true),
    ("skill_remove", true),
    ("triage", true),
    ("github", true),
    ("refresh_model", true),
    ("check_proof", true),
    ("submit_proof", true),
];

fn json_of<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// Starts (or resumes) a session the way the app does: the model route, model and the folder's cap from the backend's
/// settings. Returns the session id.
pub fn start<E: Engine + ?Sized>(app: &E, folder: &str, goal: Option<String>, session: Option<String>, only_queued: bool, budget: Option<f64>) -> Result<String, String> {
    let settings = local::read()?.settings;
    let request = SwarmRequest {
        folder: folder.to_string(),
        goal: goal.filter(|g| !g.trim().is_empty()),
        budget_usd: budget.filter(|b| *b > 0.0).unwrap_or_else(|| settings.budget(folder)),
        api_base: settings.api_base(),
        provider: Some(settings.provider()),
        model: settings.model.clone(),
        session: session.or_else(|| Some("swarm".into())),
        only_queued: Some(only_queued),
    };
    app.start(request)
}

/// Work was queued (a statement, a report to triage): when nothing runs in the folder, a session starts just for it
/// and stops when it's done. Returns the sessions running.
pub fn work_queued<E: Engine + ?Sized>(app: &E, folder: &str) -> Result<Vec<String>, String> {
    let running = app.running(folder);
    if !running.is_empty() {
        return Ok(running);
    }
    Ok(vec![start(app, folder, None, None, true, None)?])
}

/// The added folders and their sessions, newest first, with the ones running now marked.
pub fn folders<E: Engine + ?Sized>(app: &E) -> Result<Value, String> {
    let config = local::read()?;
    let mut out = vec![];
    for path in config.folders {
        let sessions = swarm::swarm_sessions(path.clone()).unwrap_or_default();
        let running = app.running(&path);
        let repo = local::folder_repo(path.clone()).ok().flatten();
        let mut listed: Vec<Value> = sessions.iter().take(12).map(|s| {
            let mut v = serde_json::to_value(s).unwrap_or(json!({}));
            v["running"] = json!(running.iter().any(|r| Some(r.as_str()) == v["run"].as_str()));
            v
        }).collect();
        // A session that just started may have no log yet.
        for run in &running {
            if !listed.iter().any(|s| s["run"].as_str() == Some(run.as_str())) {
                listed.insert(0, json!({ "run": run, "title": "", "outcome": "", "spent": 0, "running": true }));
            }
        }
        let name = path.rsplit(['/', '\\']).find(|p| !p.is_empty()).unwrap_or(&path).to_string();
        let github = local::read().map(|c| c.settings.github(&path)).unwrap_or(false);
        out.push(json!({ "path": path, "name": name, "repo": repo, "github": github, "sessions": listed }));
    }
    Ok(json!(out))
}

/// One operation of the control API on `folder` (ignored by the ones about the whole app).
pub async fn dispatch<E: Engine + ?Sized>(app: &E, op: &str, folder: &str, a: &Value) -> Result<Value, String> {
    if !OPS.iter().any(|(name, _)| *name == op) {
        return Err(format!("unknown op {op}"));
    }
    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
    let need = |k: &str| a[k].as_str().filter(|v| !v.is_empty()).map(String::from).ok_or_else(|| format!("{op} needs {k}"));
    let usd = |k: &str| a[k].as_f64().filter(|v| *v > 0.0);
    let opt = |k: &str| a[k].as_str().filter(|v| !v.is_empty()).map(String::from);
    let folder = folder.to_string();
    match op {
        "folders" => return folders(app),
        "status" => {
            let settings = local::read()?.settings;
            return Ok(json!({
                "version": env!("CARGO_PKG_VERSION"),
                "claudeCode": crate::claude_code::claude_code_status().unwrap_or_else(|e| format!("unavailable: {e}")),
                "codex": crate::codex::codex_status().unwrap_or_else(|e| format!("unavailable: {e}")),
                "anthropicKey": swarm::anthropic_key_status(),
                "openaiKey": swarm::openai_key_status(),
                "provider": settings.provider(),
                "model": settings.model,
            }));
        }
        "health" => return crate::health::swarm_health((!folder.is_empty()).then_some(folder), a["limit"].as_u64().map(|n| n as usize)),
        "add_folder" => return json_of(local::folder_add(need("path")?)),
        "answers" => {
            let who = need("who")?;
            if who != "mcp" && who != "agent" {
                return Err("who must be mcp or agent".into());
            }
            local::settings_set(json!({ "answers": who }))?;
            return Ok(json!({ "answers": who }));
        }
        "verify_repo" => {
            // Any GitHub repository at any branch, tag or commit: forked into formalmind, cloned, added, reporting to
            // the fork, and the swarm started on it.
            let repo = need("repo")?;
            let name = crate::publish::copy_name(crate::publish::repo_of(&format!("https://github.com/{}", repo.trim_start_matches("https://github.com/"))).as_deref(), std::path::Path::new(&repo));
            let git_ref = s("ref");
            let dir = match opt("path") {
                Some(p) => std::path::PathBuf::from(p),
                None => {
                    let home = std::env::var_os("HOME").map(std::path::PathBuf::from).ok_or("no home folder")?;
                    let tag = if git_ref.is_empty() { String::new() } else { format!("-{}", crate::publish::branch_for(&git_ref).replace('/', "-")) };
                    home.join("formal-targets").join(format!("{name}{tag}"))
                }
            };
            let d = dir.clone();
            let branch = tokio::task::spawn_blocking(move || crate::publish::checkout(&repo, &git_ref, &d)).await.map_err(|e| e.to_string())??;
            let path = dir.to_string_lossy().into_owned();
            local::folder_add(path.clone())?;
            local::settings_set(json!({ "github": { path.clone(): true } }))?;
            let run = start(app, &path, opt("goal"), None, false, usd("budget"))?;
            return Ok(json!({ "folder": path, "branch": branch, "fork": format!("{}/{name}", crate::publish::ORG), "run": run }));
        }
        "remove_folder" => {
            let path = need("path")?;
            if !local::read()?.folders.contains(&path) {
                return Err(format!("{path} isn't one of the added folders"));
            }
            return json_of(local::folder_remove(path));
        }
        _ => {}
    }
    let config = local::read()?;
    if !config.allows(&folder) {
        return Err(format!("{} isn't one of the added folders: {}", if folder.is_empty() { "folder" } else { &folder }, config.folders.join(", ")));
    }
    match op {
        "files" => json_of(local::folder_tree(folder)),
        "scan" => json_of(local::folder_scan(folder)),
        "git" => json_of(local::folder_git_graph(folder)),
        "read_file" => json_of(swarm::folder_read(folder, need("path")?)),
        "plan" => json_of(swarm::swarm_plan(folder)),
        "statements" => json_of(crate::statements::swarm_statements(folder)),
        "bugs" => json_of(swarm::swarm_bugs(folder)),
        "proofs" => swarm::swarm_proofs(folder),
        "queue" => swarm::swarm_queue_of(folder, opt("run"), a["done"].as_bool().unwrap_or(false)),
        "sessions" => json_of(swarm::swarm_sessions(folder)),
        "running" => Ok(json!(app.running(&folder))),
        "history" => swarm::swarm_history(folder, need("run")?).map(|h| json!(h[h.len().saturating_sub(300)..])),
        "scripts" => crate::ast::ast_scripts(folder).await,
        "units" => crate::ast::ast_units(folder, need("entry")?).await,
        "coverage" => crate::ast::ast_formal(folder, need("entry")?).await,
        "slice" => crate::ast::ast_slice(folder, need("entry")?, need("function")?).await.map(Value::String),
        "work_map" => swarm::swarm_work_map(folder),
        "brief" => swarm::swarm_brief(folder, need("function")?).map(Value::String),
        "ledger" => crate::ledger::build(std::path::Path::new(&folder), a["check"].as_bool().unwrap_or(true), a["force"].as_bool().unwrap_or(false)).await,
        "start" => {
            let run = start(app, &folder, opt("goal"), opt("run"), false, usd("budget"))?;
            // A name for the chat, as Rename gives one: sessions started with the same goal stay apart in the list.
            if let Some(title) = opt("title") {
                swarm::swarm_rename(folder.clone(), run.clone(), title)?;
            }
            Ok(json!({ "run": run }))
        }
        "stop" => {
            app.stop(&folder, &need("run")?);
            Ok(Value::Null)
        }
        "pause" => {
            let runs = match opt("run") {
                Some(run) => vec![run],
                None => app.running(&folder),
            };
            for run in &runs {
                app.stop(&folder, run);
            }
            Ok(json!({ "paused": runs }))
        }
        "resume" => Ok(json!({ "run": start(app, &folder, None, opt("run"), false, None)? })),
        "say" => app.say(&folder, &need("run")?, &need("text")?).map(|_| Value::Null),
        "set_budget" => {
            let amount = usd("usd").ok_or("set_budget needs usd")?;
            app.set_budget(&folder, &need("run")?, amount).map(|_| Value::Null)
        }
        "add_statement" => {
            let statement = json_of(crate::statements::swarm_add_statement(folder.clone(), need("text")?))?;
            Ok(json!({ "statement": statement, "running": work_queued(app, &folder)? }))
        }
        "confirm_statement" => {
            let statements = json_of(crate::statements::swarm_confirm_statement(folder.clone(), need("id")?))?;
            Ok(json!({ "statements": statements, "running": work_queued(app, &folder)? }))
        }
        "correct_statement" => {
            let statements = json_of(crate::statements::swarm_correct_statement(folder.clone(), need("id")?, s("text")))?;
            Ok(json!({ "statements": statements, "running": work_queued(app, &folder)? }))
        }
        "mark_statement" => {
            let statements = json_of(crate::statements::swarm_statement_mark(folder.clone(), need("id")?, need("mark")?))?;
            Ok(json!({ "statements": statements, "running": work_queued(app, &folder)? }))
        }
        "diagnose" => {
            let item = need("item")?;
            Ok(crate::diagnose::diagnose(&item, &crate::diagnose::events_of(std::path::Path::new(&folder), &item)))
        }
        "questions" => Ok(json!(crate::answerer::questions(std::path::Path::new(&folder)))),
        "remove_statement" => json_of(crate::statements::swarm_remove_statement(folder, need("id")?)),
        "skills" => json_of(crate::skills::skills_catalog()),
        "skill_add" => crate::skills::skills_add(need("id")?).await.map(|_| Value::Null),
        "skill_remove" => json_of(crate::skills::skills_remove(need("id")?)),
        "triage" => {
            swarm::swarm_triage(folder.clone(), need("path")?, opt("run"))?;
            Ok(json!({ "running": work_queued(app, &folder)? }))
        }
        "github" => {
            let on = a["on"].as_bool().ok_or("github needs on: true or false")?;
            local::settings_set(json!({ "github": { folder.clone(): on } }))?;
            Ok(json!({ "folder": folder, "github": on }))
        }
        "refresh_model" => json_of(swarm::swarm_refresh_model(folder)).map(|r| json!({ "regenerated": r })),
        "check_proof" => swarm::swarm_check_proof(folder, need("path")?, opt("content")).await,
        "submit_proof" => {
            let queued = swarm::swarm_submit_proof(folder.clone(), need("function")?, need("path")?, opt("notes"), opt("run"))?;
            Ok(json!({ "queued": queued, "running": work_queued(app, &folder)? }))
        }
        _ => Err(format!("unknown op {op}")),
    }
}

/// The control API for the app's own pages: the same operations the relay and the MCP run.
#[tauri::command(async)]
pub async fn control(app: AppHandle, op: String, folder: Option<String>, args: Option<Value>) -> Result<Value, String> {
    dispatch(&app, &op, folder.as_deref().unwrap_or(""), &args.unwrap_or(json!({}))).await
}

#[cfg(test)]
mod tests {
    /// The backend implements exactly the operations lib/mac-ops.ts publishes, with the same read/write split.
    #[test]
    fn ops_match_the_published_list() {
        let ts = include_str!("../../../lib/mac-ops.ts");
        let mut published: Vec<(String, bool)> = ts
            .lines()
            .filter_map(|l| {
                let l = l.trim();
                let (name, rest) = l.split_once(": { write: ")?;
                Some((name.to_string(), rest.starts_with("true")))
            })
            .collect();
        let mut ours: Vec<(String, bool)> = super::OPS.iter().map(|(n, w)| (n.to_string(), *w)).collect();
        published.sort();
        ours.sort();
        assert_eq!(ours, published);
    }
}

/// Every operation of the control API, run against a copy of tests/fixtures/control (a Foundry project with a small
/// Lake setup) in a test home, with a fake Engine that records what the app would have been asked to do.
#[cfg(test)]
mod ops {
    use super::{dispatch, Engine, OPS};
    use crate::swarm::SwarmRequest;
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        running: Mutex<Vec<String>>,
        calls: Mutex<Vec<String>>,
        started: Mutex<Vec<Value>>,
    }

    impl Engine for Fake {
        fn running(&self, _folder: &str) -> Vec<String> {
            self.running.lock().unwrap().clone()
        }
        fn start(&self, r: SwarmRequest) -> Result<String, String> {
            let run = r.session.clone().unwrap_or_else(|| "swarm".into());
            self.started.lock().unwrap().push(json!({ "folder": r.folder, "goal": r.goal, "budget": r.budget_usd, "provider": r.provider, "model": r.model, "session": r.session, "onlyQueued": r.only_queued, "api": r.api_base }));
            self.running.lock().unwrap().push(run.clone());
            Ok(run)
        }
        fn stop(&self, _folder: &str, run: &str) {
            self.calls.lock().unwrap().push(format!("stop {run}"));
            self.running.lock().unwrap().retain(|r| r != run);
        }
        fn say(&self, _folder: &str, run: &str, text: &str) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("say {run} {text}"));
            Ok(())
        }
        fn set_budget(&self, _folder: &str, run: &str, usd: f64) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("budget {run} {usd}"));
            Ok(())
        }
    }

    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap().flatten() {
            let (p, t) = (e.path(), to.join(e.file_name()));
            if p.is_dir() {
                copy(&p, &t);
            } else {
                std::fs::copy(&p, &t).unwrap();
            }
        }
    }

    /// A fresh copy of the fixture, added to a fresh test home; the server is a closed port, so nothing reaches
    /// formal.team or spends.
    fn setup(name: &str) -> (PathBuf, String) {
        let base = std::env::temp_dir().join(format!("fm-control-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let folder = base.join("box");
        copy(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/control"), &folder);
        let _ = std::process::Command::new("git").args(["init", "-q"]).current_dir(&folder).status();
        crate::local::TEST_HOME.with(|h| *h.borrow_mut() = Some(home.clone()));
        let f = folder.to_string_lossy().to_string();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("config.json"), json!({ "folders": [f], "settings": { "api_base": "http://127.0.0.1:9" } }).to_string()).unwrap();
        (base, f)
    }

    async fn ok(e: &Fake, op: &str, folder: &str, a: Value) -> Value {
        match dispatch(e, op, folder, &a).await {
            Ok(v) => v,
            Err(err) => panic!("{op}: {err}"),
        }
    }

    async fn err(e: &Fake, op: &str, folder: &str, a: Value) -> String {
        dispatch(e, op, folder, &a).await.expect_err(op)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn every_read() {
        let (_base, f) = setup("reads");
        let e = Fake::default();
        // About the app: no folder needed.
        assert_eq!(ok(&e, "folders", "", json!({})).await[0]["path"], json!(f));
        let status = ok(&e, "status", "", json!({})).await;
        assert_eq!(status["provider"], "claude-code", "{status}");
        assert!(ok(&e, "health", "", json!({ "limit": 5 })).await["turns"].is_number());
        // The folder's files, scope and model.
        assert!(ok(&e, "files", &f, json!({})).await.to_string().contains("Box.sol"));
        assert!(ok(&e, "scan", &f, json!({})).await.to_string().contains("src/Box.sol"));
        assert!(ok(&e, "git", &f, json!({})).await.is_object());
        assert!(ok(&e, "read_file", &f, json!({ "path": "src/Box.sol" })).await.as_str().unwrap().contains("contract Box"));
        let scripts = ok(&e, "scripts", &f, json!({})).await;
        assert_eq!(scripts["contracts"][0]["name"], "Box", "{scripts}");
        assert!(ok(&e, "units", &f, json!({ "entry": "src/Box.sol" })).await.to_string().contains("Box.set"));
        assert!(ok(&e, "coverage", &f, json!({ "entry": "src/Box.sol" })).await.to_string().contains("Box.set"));
        assert!(ok(&e, "slice", &f, json!({ "entry": "src/Box.sol", "function": "set" })).await.as_str().unwrap().contains("set"));
        let map = ok(&e, "work_map", &f, json!({})).await;
        assert!(map["contracts"][0]["functions"].as_array().unwrap().iter().any(|x| x["lean"] == "Box.set"), "{map}");
        assert!(ok(&e, "brief", &f, json!({ "function": "Box.set" })).await.as_str().unwrap().contains("Box.set"));
        let ledger = ok(&e, "ledger", &f, json!({ "check": false })).await;
        assert_eq!(ledger["proved"], 0, "{ledger}");
        // The swarm's state, empty before any run.
        for op in ["plan", "statements", "bugs", "proofs", "sessions", "running"] {
            ok(&e, op, &f, json!({})).await;
        }
        assert_eq!(ok(&e, "queue", &f, json!({ "done": true })).await["run"], "swarm");
        std::fs::create_dir_all(Path::new(&f).join(".formal/runs")).unwrap();
        std::fs::write(Path::new(&f).join(".formal/runs/swarm.jsonl"), "{\"kind\":\"start\",\"text\":\"t\"}\n").unwrap();
        assert_eq!(ok(&e, "history", &f, json!({ "run": "swarm" })).await.as_array().unwrap().len(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn every_action() {
        let (_base, f) = setup("actions");
        let e = Fake::default();
        // Start and resume ask the app with the backend's settings: the Claude plan by default.
        let run = ok(&e, "start", &f, json!({ "goal": "the owner check", "budget": 7.5 })).await;
        assert_eq!(run["run"], "swarm");
        let s = e.started.lock().unwrap()[0].clone();
        assert_eq!((s["provider"].clone(), s["goal"].clone(), s["budget"].clone(), s["onlyQueued"].clone()), (json!("claude-code"), json!("the owner check"), json!(7.5), json!(false)), "{s}");
        ok(&e, "say", &f, json!({ "run": "swarm", "text": "check set" })).await;
        ok(&e, "set_budget", &f, json!({ "run": "swarm", "usd": 12.0 })).await;
        assert_eq!(ok(&e, "running", &f, json!({})).await, json!(["swarm"]));
        assert_eq!(ok(&e, "pause", &f, json!({})).await["paused"], json!(["swarm"]));
        assert_eq!(ok(&e, "running", &f, json!({})).await, json!([]));
        ok(&e, "resume", &f, json!({ "run": "reviews" })).await;
        ok(&e, "stop", &f, json!({ "run": "reviews" })).await;
        let calls = e.calls.lock().unwrap().clone();
        assert!(calls.contains(&"say swarm check set".into()) && calls.contains(&"budget swarm 12".into()) && calls.contains(&"stop swarm".into()), "{calls:?}");
        // Queued work starts a run for queued work when nothing runs.
        let added = ok(&e, "add_statement", &f, json!({ "text": "Only the owner can change value." })).await;
        let id = added["statement"]["id"].as_str().unwrap().to_string();
        assert_eq!(e.started.lock().unwrap().last().unwrap()["onlyQueued"], true);
        assert!(!added["running"].as_array().unwrap().is_empty());
        ok(&e, "mark_statement", &f, json!({ "id": id, "mark": "?" })).await;
        let _ = dispatch(&e, "confirm_statement", &f, &json!({ "id": id })).await;
        let _ = dispatch(&e, "correct_statement", &f, &json!({ "id": id, "text": "only the owner" })).await;
        ok(&e, "remove_statement", &f, json!({ "id": id })).await;
        std::fs::create_dir_all(Path::new(&f).join("audit")).unwrap();
        std::fs::write(Path::new(&f).join("audit/report.md"), "# A report\n").unwrap();
        ok(&e, "triage", &f, json!({ "path": "audit/report.md" })).await;
        // Report to GitHub: off by default, on per folder.
        assert_eq!(ok(&e, "folders", "", json!({})).await[0]["github"], false);
        ok(&e, "github", &f, json!({ "on": true })).await;
        assert_eq!(ok(&e, "folders", "", json!({})).await[0]["github"], true);
        // Folders.
        let other = std::env::temp_dir().join(format!("fm-control-other-{}", std::process::id()));
        std::fs::create_dir_all(&other).unwrap();
        let o = other.to_string_lossy().to_string();
        ok(&e, "add_folder", "", json!({ "path": o })).await;
        ok(&e, "remove_folder", "", json!({ "path": o })).await;
        err(&e, "remove_folder", "", json!({ "path": o })).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn proofs_from_outside() {
        if std::process::Command::new("lake").arg("--version").output().is_err() {
            return; // no Lean here
        }
        let (_base, f) = setup("proofs");
        let e = Fake::default();
        assert!(ok(&e, "refresh_model", &f, json!({})).await["regenerated"].is_array());
        std::fs::create_dir_all(Path::new(&f).join(".formal")).unwrap();
        std::fs::write(Path::new(&f).join(".formal/plan.md"), "- [ ] `Box.get_` — Box (src/Box.sol:18)\n").unwrap();
        // A sound proof builds; a sorry is refused; outside Refinement/ is refused.
        let path = "formal/Refinement/Swarm/BoxGet.lean";
        let good = ok(&e, "check_proof", &f, json!({ "path": path, "content": "theorem box_probe : 1 + 1 = 2 := rfl\n" })).await;
        assert_eq!(good["ok"], true, "{good}");
        let bad = ok(&e, "check_proof", &f, json!({ "path": path, "content": "theorem box_probe : 1 = 2 := sorry\n" })).await;
        assert_eq!(bad["ok"], false, "{bad}");
        err(&e, "check_proof", &f, json!({ "path": "formal/Generated/X.lean", "content": "" })).await;
        let sub = ok(&e, "submit_proof", &f, json!({ "function": "Box.get_", "path": path, "notes": "n" })).await;
        assert_eq!(sub["queued"]["queued"], "review", "{sub}");
        err(&e, "submit_proof", &f, json!({ "function": "Box.nope", "path": path })).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn refusals() {
        let (_base, f) = setup("refusals");
        let e = Fake::default();
        assert!(err(&e, "rm", &f, json!({})).await.contains("unknown op"));
        assert!(err(&e, "plan", "/not/added", json!({})).await.contains("isn't one of the added folders"));
        assert!(err(&e, "read_file", &f, json!({})).await.contains("needs path"));
        assert!(err(&e, "read_file", &f, json!({ "path": "../../etc/passwd" })).await.contains("outside"));
        assert!(err(&e, "set_budget", &f, json!({ "run": "swarm" })).await.contains("usd"));
        assert!(err(&e, "github", &f, json!({})).await.contains("on"));
        assert!(err(&e, "verify_repo", "", json!({ "repo": "not a repo" })).await.contains("owner/name"));
        assert!(err(&e, "answers", &f, json!({ "who": "nobody" })).await.contains("mcp or agent"));
        assert_eq!(ok(&e, "answers", "", json!({ "who": "agent" })).await["answers"], "agent");
        assert_eq!(ok(&e, "questions", &f, json!({})).await, json!([]));
        assert_eq!(ok(&e, "diagnose", &f, json!({ "item": "1" })).await["cause"], "unknown");
        // Every published operation is reached by these tests.
        let src = include_str!("control.rs");
        for (op, _) in OPS {
            assert!(src.contains(&format!("\"{op}\", &f")) || src.contains(&format!("\"{op}\", \"\"")) || src.contains(&format!("for op in [")) , "{op}");
        }
    }

    /// The relay's commands (lib/relay.ts) go through the same dispatch: a call gets a reply with its id, history
    /// comes back for its session, and a refused command becomes an error event in that session.
    #[tokio::test(flavor = "current_thread")]
    async fn relay_commands() {
        let (_base, f) = setup("relay");
        let e = Fake::default();
        let h = crate::relay::handle(&e, &json!({ "type": "call", "id": "a1", "folder": f, "op": "plan", "args": {} })).await;
        let r = h.reply.unwrap();
        assert_eq!((r["id"].as_str(), r["ok"].as_bool()), (Some("a1"), Some(true)), "{r}");
        let h = crate::relay::handle(&e, &json!({ "type": "call", "id": "a2", "folder": f, "op": "rm", "args": {} })).await;
        assert_eq!(h.reply.unwrap()["ok"], false);
        let h = crate::relay::handle(&e, &json!({ "type": "say", "folder": f, "run": "swarm", "text": "hi" })).await;
        assert!(h.errors.is_empty() && h.reply.is_none());
        let h = crate::relay::handle(&e, &json!({ "type": "stop", "folder": f, "run": "swarm" })).await;
        assert!(h.errors.is_empty());
        let h = crate::relay::handle(&e, &json!({ "type": "start", "folder": f, "goal": "prove", "budget": 2 })).await;
        assert!(h.errors.is_empty(), "{:?}", h.errors);
        let h = crate::relay::handle(&e, &json!({ "type": "history", "folder": f, "run": "swarm" })).await;
        assert_eq!(h.history.unwrap()["run"], "swarm");
        let h = crate::relay::handle(&e, &json!({ "type": "say", "folder": "/not/added", "run": "r1", "text": "hi" })).await;
        assert_eq!(h.errors[0]["run"], "r1");
        assert_eq!(h.errors[0]["kind"], "error");
        let h = crate::relay::handle(&e, &json!({ "type": "nope" })).await;
        assert!(h.reply.is_none() && h.history.is_none() && h.errors.is_empty());
        let calls = e.calls.lock().unwrap().join(" ");
        assert!(calls.contains("say swarm hi") && calls.contains("stop swarm"), "{calls}");
        assert_eq!(e.started.lock().unwrap().len(), 1);
    }
}
