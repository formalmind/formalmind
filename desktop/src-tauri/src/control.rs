//! The app's control API: every operation the app does, by name, in one place (lib/mac-ops.ts is its published list).
//! The folder page, the relay (the phone and the MCP through formal.team) and anything else that drives the app call
//! [`dispatch`], so they all do the same thing the same way: the backend decides the model route, the caps and when
//! a run starts; whoever asks only says what they want.

use crate::local;
use crate::swarm::{self, SwarmRequest, Swarms};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

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
    ("reach", false),
    ("report_quote", false),
    ("work_map", false),
    ("health", false),
    ("brief", false),
    ("add_folder", true),
    ("remove_folder", true),
    ("start", true),
    ("hunt", true),
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
    ("triage", true),
    ("reach_run", true),
    ("report", true),
    ("refresh_model", true),
    ("check_proof", true),
    ("submit_proof", true),
];

fn json_of<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// Starts (or resumes) a session the way the app does: the model route, model and the folder's cap from the backend's
/// settings. Returns the session id.
pub fn start(app: &AppHandle, folder: &str, goal: Option<String>, session: Option<String>, only_queued: bool, hunt: Option<String>, budget: Option<f64>) -> Result<String, String> {
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
        hunt,
    };
    swarm::swarm_start(app.clone(), app.state::<Swarms>(), request)
}

/// Work was queued (a statement, a report to triage): when nothing runs in the folder, a session starts just for it
/// and stops when it's done. Returns the sessions running.
pub fn work_queued(app: &AppHandle, folder: &str) -> Result<Vec<String>, String> {
    let running = swarm::swarm_running(app.state::<Swarms>(), folder.to_string());
    if !running.is_empty() {
        return Ok(running);
    }
    Ok(vec![start(app, folder, None, None, true, None, None)?])
}

/// The added folders and their sessions, newest first, with the ones running now marked.
pub fn folders(app: &AppHandle) -> Result<Value, String> {
    let config = local::read()?;
    let mut out = vec![];
    for path in config.folders {
        let sessions = swarm::swarm_sessions(path.clone()).unwrap_or_default();
        let running = swarm::swarm_running(app.state::<Swarms>(), path.clone());
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
        out.push(json!({ "path": path, "name": name, "repo": repo, "sessions": listed }));
    }
    Ok(json!(out))
}

/// One operation of the control API on `folder` (ignored by the ones about the whole app).
pub async fn dispatch(app: &AppHandle, op: &str, folder: &str, a: &Value) -> Result<Value, String> {
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
                "claudeCode": crate::claude_code::claude_code_status().unwrap_or_else(|e| format!("unavailable: {e}")),
                "anthropicKey": swarm::anthropic_key_status(),
                "openaiKey": swarm::openai_key_status(),
                "provider": settings.provider(),
                "model": settings.model,
            }));
        }
        "health" => return crate::health::swarm_health((!folder.is_empty()).then_some(folder), a["limit"].as_u64().map(|n| n as usize)),
        "add_folder" => return json_of(local::folder_add(need("path")?)),
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
        "queue" => swarm::swarm_queue(folder),
        "sessions" => json_of(swarm::swarm_sessions(folder)),
        "running" => Ok(json!(swarm::swarm_running(app.state::<Swarms>(), folder))),
        "history" => swarm::swarm_history(folder, need("run")?).map(|h| json!(h[h.len().saturating_sub(300)..])),
        "scripts" => crate::ast::ast_scripts(folder).await,
        "units" => crate::ast::ast_units(folder, need("entry")?).await,
        "coverage" => crate::ast::ast_formal(folder, need("entry")?).await,
        "slice" => crate::ast::ast_slice(folder, need("entry")?, need("function")?).await.map(Value::String),
        "reach" => crate::reach::reach_map(folder, need("entry")?).await,
        "report_quote" => crate::report::report_quote(folder, local::read()?.settings.api_base()).await,
        "work_map" => swarm::swarm_work_map(folder),
        "brief" => swarm::swarm_brief(folder, need("function")?).map(Value::String),
        "start" => Ok(json!({ "run": start(app, &folder, opt("goal"), opt("run"), false, None, usd("budget"))? })),
        "hunt" => {
            let run = opt("run").unwrap_or_else(|| format!("hunt-{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
            Ok(json!({ "run": start(app, &folder, None, Some(run), true, Some(s("focus")), usd("budget"))? }))
        }
        "stop" => {
            swarm::swarm_stop(app.state::<Swarms>(), folder, need("run")?);
            Ok(Value::Null)
        }
        "pause" => {
            let runs = match opt("run") {
                Some(run) => vec![run],
                None => swarm::swarm_running(app.state::<Swarms>(), folder.clone()),
            };
            for run in &runs {
                swarm::swarm_stop(app.state::<Swarms>(), folder.clone(), run.clone());
            }
            Ok(json!({ "paused": runs }))
        }
        "resume" => Ok(json!({ "run": start(app, &folder, None, opt("run"), false, None, None)? })),
        "say" => swarm::swarm_say(app.clone(), app.state::<Swarms>(), folder, need("run")?, need("text")?).map(|_| Value::Null),
        "set_budget" => {
            let amount = usd("usd").ok_or("set_budget needs usd")?;
            swarm::swarm_set_budget(app.state::<Swarms>(), folder, need("run")?, amount).map(|_| Value::Null)
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
        "remove_statement" => json_of(crate::statements::swarm_remove_statement(folder, need("id")?)),
        "triage" => {
            swarm::swarm_triage(folder.clone(), need("path")?, opt("run"))?;
            Ok(json!({ "running": work_queued(app, &folder)? }))
        }
        "reach_run" => crate::reach::reach_run(app.clone(), folder, need("tool")?, opt("target")).await.map(|n| json!({ "started": n })),
        "report" => {
            let dirs: Vec<String> = a["dirs"].as_array().map(|d| d.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_else(|| vec!["audit".into(), "audits".into(), "reports".into()]);
            json_of(crate::report::report_generate(folder, dirs, local::read()?.settings.api_base()).await)
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
