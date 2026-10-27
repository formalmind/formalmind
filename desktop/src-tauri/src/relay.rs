//! This Mac's side of the relay through formal.team (lib/relay.ts, worker/relay-do.ts), run by the backend for as long
//! as the app runs, with or without a window: every swarm event goes up as it happens, with the added folders and
//! their sessions; commands from the phone and from agents through the MCP come down and run through the control API
//! ([`crate::control::dispatch`]), as if done in the app, and calls get their answer back. Off when Settings → Phone
//! is turned off, or while the app isn't signed in.

use crate::control::Engine;
use crate::local;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Listener};

/// Events are sent in batches this often.
const FLUSH: Duration = Duration::from_millis(400);
/// The folders and sessions are sent again at least this often (and whenever a session starts or ends).
const STATE_EVERY: Duration = Duration::from_secs(60);

struct Relay {
    app: AppHandle,
    client: reqwest::Client,
    /// Events waiting to be sent.
    queue: Mutex<Vec<Value>>,
    /// The folders and sessions changed and should be sent.
    state_due: std::sync::atomic::AtomicBool,
}

/// Where formal.team is and the app's sign-in, while the relay is on.
fn signed_in() -> Option<(String, String)> {
    // A dev build for a test (desktop/scripts/lifecycle.sh) stays off the relay, so it never answers for your app.
    if std::env::var("FM_RELAY").as_deref() == Ok("0") {
        return None;
    }
    let settings = local::read().ok()?.settings;
    if !settings.relay() {
        return None;
    }
    let token = crate::swarm::token().ok()?;
    Some((settings.api_base(), token))
}

impl Relay {
    async fn post(&self, body: Value) -> bool {
        let Some((api, token)) = signed_in() else { return false };
        self.client.post(format!("{api}/api/relay/mac")).bearer_auth(token).json(&body).send().await.is_ok_and(|r| r.status().is_success())
    }

    async fn publish_state(&self) {
        let Ok(folders) = crate::control::folders(&self.app) else { return };
        // The relay's folder shape: path, name, repo and each session's run, title, outcome, spend and whether it runs.
        let folders: Vec<Value> = folders
            .as_array()
            .into_iter()
            .flatten()
            .map(|f| {
                let sessions: Vec<Value> = f["sessions"].as_array().into_iter().flatten().map(|s| json!({ "run": s["run"], "title": s["title"], "outcome": s["outcome"], "spent": s["spent"], "running": s["running"] })).collect();
                json!({ "path": f["path"], "name": f["name"], "repo": f["repo"], "sessions": sessions })
            })
            .collect();
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        self.post(json!({ "state": { "folders": folders, "at": at, "name": local::machine_name() } })).await;
    }

    async fn flush(&self) {
        let events = std::mem::take(&mut *self.queue.lock().unwrap());
        if !events.is_empty() {
            self.post(json!({ "events": events })).await;
        }
    }

    /// One command, done as the app does it, then sent where it goes.
    async fn run(&self, cmd: &Value) {
        let out = handle(&self.app, cmd).await;
        if let Some(reply) = out.reply {
            self.post(json!({ "replies": [reply] })).await;
        }
        if let Some(history) = out.history {
            self.post(json!({ "history": history })).await;
        }
        self.queue.lock().unwrap().extend(out.errors);
    }
}

/// What a command produced: a call's reply, a session's history, or an error said in its session (so the phone sees
/// why nothing happened).
#[derive(Default)]
pub struct Handled {
    pub reply: Option<Value>,
    pub history: Option<Value>,
    pub errors: Vec<Value>,
}

/// One command from the relay (lib/relay.ts `RelayCommand`), done through the control API.
pub async fn handle<E: Engine + ?Sized>(engine: &E, cmd: &Value) -> Handled {
    let s = |k: &str| cmd[k].as_str().unwrap_or("").to_string();
    let folder = s("folder");
    let mut out = Handled::default();
    let outcome: Result<Value, String> = match cmd["type"].as_str() {
        Some("call") => {
            out.reply = Some(match crate::control::dispatch(engine, &s("op"), &folder, &cmd["args"]).await {
                Ok(result) => json!({ "id": s("id"), "ok": true, "result": result }),
                Err(e) => json!({ "id": s("id"), "ok": false, "error": e }),
            });
            Ok(Value::Null)
        }
        Some("say") => crate::control::dispatch(engine, "say", &folder, &json!({ "run": s("run"), "text": s("text") })).await,
        Some("stop") => crate::control::dispatch(engine, "stop", &folder, &json!({ "run": s("run") })).await,
        Some("start") => crate::control::dispatch(engine, "start", &folder, &json!({ "goal": cmd["goal"], "budget": cmd["budget"], "run": cmd["run"] })).await,
        Some("history") => {
            let run = s("run");
            let events = crate::swarm::swarm_history(folder.clone(), run.clone()).unwrap_or_default();
            let events: Vec<Value> = events[events.len().saturating_sub(600)..]
                .iter()
                .map(|e| {
                    let mut e = e.clone();
                    e["folder"] = json!(folder);
                    e["run"] = json!(run);
                    e
                })
                .collect();
            out.history = Some(json!({ "folder": folder, "run": run, "events": events }));
            Ok(Value::Null)
        }
        _ => Ok(Value::Null),
    };
    if let Err(e) = outcome {
        let run = cmd["run"].as_str().filter(|r| !r.is_empty()).unwrap_or("swarm");
        out.errors.push(json!({ "folder": folder, "run": run, "kind": "error", "role": "swarm", "item": "", "text": e, "spent": 0 }));
    }
    out
}

/// Starts the relay for the app's life.
pub fn start(app: &AppHandle) {
    let relay = Arc::new(Relay {
        app: app.clone(),
        client: reqwest::Client::builder().timeout(Duration::from_secs(60)).build().unwrap_or_default(),
        queue: Mutex::new(vec![]),
        state_due: std::sync::atomic::AtomicBool::new(true),
    });
    // Every swarm event goes up; a session starting or ending sends the folders and sessions too.
    {
        let r = relay.clone();
        app.listen_any("swarm", move |event| {
            if let Ok(v) = serde_json::from_str::<Value>(event.payload()) {
                if matches!(v["kind"].as_str(), Some("start" | "done")) {
                    r.state_due.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                r.queue.lock().unwrap().push(v);
            }
        });
        let r = relay.clone();
        app.listen_any("swarm-running", move |_| r.state_due.store(true, std::sync::atomic::Ordering::SeqCst));
    }
    // Sending: events in batches, the state when it changed or a minute has passed.
    let r = relay.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_state = std::time::Instant::now() - STATE_EVERY;
        loop {
            tokio::time::sleep(FLUSH).await;
            if signed_in().is_none() {
                r.queue.lock().unwrap().clear();
                continue;
            }
            r.flush().await;
            if r.state_due.swap(false, std::sync::atomic::Ordering::SeqCst) || last_state.elapsed() >= STATE_EVERY {
                r.publish_state().await;
                last_state = std::time::Instant::now();
            }
        }
    });
    // Commands: one waiting request at a time; asking with `after` acknowledges what was done.
    let r = relay;
    tauri::async_runtime::spawn(async move {
        let mut after: u64 = 0;
        let mut failures: u32 = 0;
        loop {
            let Some((api, token)) = signed_in() else {
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            };
            let res = r.client.get(format!("{api}/api/relay/mac?after={after}&wait=1")).bearer_auth(token).send().await;
            let body = match res {
                Ok(res) if res.status().is_success() => res.json::<Value>().await.ok(),
                _ => None,
            };
            let Some(body) = body else {
                failures += 1;
                tokio::time::sleep(Duration::from_secs((2 * failures as u64).min(60))).await;
                continue;
            };
            failures = 0;
            for cmd in body["commands"].as_array().into_iter().flatten() {
                r.run(cmd).await;
            }
            after = body["last"].as_u64().unwrap_or(after);
        }
    });
}
