//! Sessions (SPEC.md §3 "Sessions, start, stop" and "The loop: one item per function"; B1, B3–B12, B14–B22, R4,
//! R6, R8, R9): the session registry, start/stop/pause/say, and the loop that takes one job at a time from the queue
//! (resumed → answer → queued → formalize → `~` obligation → first open plan item → plan), runs its agent through
//! [`executor::Agent`], and applies what the turn decided: prove → check → review, attempts, blocking, verdicts,
//! reopening.
//!
//! The Tauri commands call [`Engine`]: [`Engine::start`], [`Engine::stop`], [`Engine::pause`], [`Engine::say`],
//! [`Engine::set_budget`], [`Engine::compact`], [`Engine::running`], [`Engine::pause_all`]. Everything outside the loop
//! (credentials, formal-ast, Lean, publishing) goes through a [`World`]; the app's is [`Live`].

pub mod prompts;
mod run;
#[cfg(test)]
mod tests;
pub mod world;

pub use world::{Live, World};

use super::events::{self, Emitter, Kind, SwarmEvent};
use super::executor::{Agent, Stop};
use super::queue::{self, Claims, NewJob, Queue};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Attempts at a plan item before it is blocked `!` (B17, B18).
pub const MAX_ATTEMPTS: usize = 3;

/// B5/B9: the outcome of a Stop or Pause.
pub const PAUSED: &str = "paused: resume anytime, the queue carries on";
/// B11: the line a quit appends to each running session's log.
pub const QUIT: &str = "paused: the app quit. Resume to carry on from the plan.";
pub const QUEUED_DONE: &str = "done: the queued work is finished";
pub const ELSEWHERE: &str = "done: the rest of the plan is being worked in another session";
pub const NO_SCOPE: &str = "failed: formal-ast found no function in scope (no script under script/ deploys or calls the contracts)";
pub const NOT_RUNNING: &str = "The swarm isn't running";
pub const ALREADY: &str = "This session is already running";

/// `swarm_start`'s request, field for field as swarm.rs takes it.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct SwarmRequest {
    pub folder: String,
    /// What to focus on; empty means the whole codebase.
    pub goal: Option<String>,
    pub budget_usd: f64,
    /// formal.team (or a local Worker), for the session token's routes.
    pub api_base: String,
    /// `claude-code`, `codex`, `anthropic`, `openai` or `formal`.
    pub provider: Option<String>,
    pub model: Option<String>,
    /// The session to continue: `swarm` unless another was made with +.
    pub session: Option<String>,
    /// Only the jobs already queued, then stop (B12).
    pub only_queued: Option<bool>,
}

impl SwarmRequest {
    /// On Claude Code or Codex the plan pays and nothing is metered (B10).
    fn metered(&self) -> bool {
        !matches!(self.provider.as_deref(), Some("claude-code" | "codex"))
    }
}

/// One running session.
pub struct Session {
    pub folder: String,
    pub run: String,
    key: String,
    root: PathBuf,
    queue: PathBuf,
    req: SwarmRequest,
    agent: Arc<dyn Agent>,
    /// Stop and Pause: races every wait of the turn (B5).
    stop: Stop,
    spent: Mutex<f64>,
    /// The cap, raised from the chat's header while it runs (B10).
    budget: Mutex<f64>,
    compact_now: Arc<AtomicBool>,
    /// The plan's work goes on after the queued jobs (off for `only_queued` until `start_work`/`reopen`, B12/B19).
    work: AtomicBool,
    /// formal-ast's reading, for the tools.
    ast: Mutex<Option<Arc<crate::swarm_ctx::Context>>>,
}

impl Session {
    pub fn spent(&self) -> f64 {
        *self.spent.lock().unwrap()
    }

    fn stopped(&self) -> bool {
        self.stop.is_stopped()
    }
}

/// The app's sessions and the loop's collaborators.
pub struct Engine {
    emitter: Arc<dyn Emitter>,
    world: Arc<dyn World>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    claims: Claims,
    /// ⌘Q while agents work: the app exits when the last session ends (B11).
    pub quit_when_done: AtomicBool,
    /// B40's retry wait (3 s in the app).
    pub backoff: Duration,
    /// Tests: runs after a loop returns, before the session decides whether to end (R4's window).
    #[cfg(test)]
    after_loop: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Engine {
    pub fn new(emitter: Arc<dyn Emitter>, world: Arc<dyn World>) -> Arc<Engine> {
        Arc::new(Engine { emitter, world, sessions: Mutex::new(HashMap::new()), claims: Claims::new(), quit_when_done: AtomicBool::new(false),
            backoff: Duration::from_secs(3),
            #[cfg(test)]
            after_loop: Mutex::new(None),
        })
    }

    /// The app's engine: events to the windows, the live world.
    pub fn live<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Arc<Engine> {
        Engine::new(Arc::new(app.clone()), Arc::new(Live { app }))
    }

    fn emit(&self, s: &Session, kind: Kind, role: &str, item: &str, text: impl Into<String>) {
        events::emit(&*self.emitter, SwarmEvent::new(&s.folder, &s.run, kind, role, item, text, s.spent()));
    }

    fn broadcast(&self) {
        let map = self.sessions.lock().unwrap();
        self.emitter.running(&events::running(map.keys().map(String::as_str)));
    }

    fn get(&self, folder: &str, run: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(&queue::session_key(folder, run)).cloned()
    }

    /// B1: starts (or resumes) a session and returns its id. The loop runs in the background.
    pub fn start(self: &Arc<Self>, req: SwarmRequest) -> Result<String, String> {
        self.start_task(req).map(|(run, _)| run)
    }

    /// [`Engine::start`], with the loop's handle (tests wait on it).
    pub fn start_task(self: &Arc<Self>, req: SwarmRequest) -> Result<(String, tauri::async_runtime::JoinHandle<()>), String> {
        self.world.allowed(&req.folder)?;
        let agent = self.world.agent(&req)?;
        let run = queue::session_id(req.session.as_deref());
        let key = queue::session_key(&req.folder, &run);
        let root = PathBuf::from(&req.folder);
        let session = {
            let mut map = self.sessions.lock().unwrap();
            if map.contains_key(&key) {
                return Err(ALREADY.into());
            }
            // B3: one app per folder; this app's other sessions there already hold it.
            if !map.values().any(|s| s.folder == req.folder) {
                queue::lock_folder(&root)?;
            }
            // B46: earlier per-start logs join the default session, their spend with them.
            let carried = events::merge_old_sessions(&root);
            if carried > 0.0 {
                let _ = Queue::update(&queue::queue_path(&root, queue::DEFAULT_SESSION), |q| q.spent += carried);
            }
            let qf = queue::queue_path(&root, &run);
            let spent = Queue::load(&qf).spent;
            if let Some(goal) = req.goal.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                let _ = Queue::update(&qf, |q| q.enqueue(NewJob::answer(goal)));
            }
            let s = Arc::new(Session {
                folder: req.folder.clone(),
                run: run.clone(),
                key: key.clone(),
                root,
                queue: qf,
                agent,
                stop: Stop::new(),
                spent: Mutex::new(spent),
                budget: Mutex::new(req.budget_usd.max(spent)),
                compact_now: Arc::new(AtomicBool::new(false)),
                work: AtomicBool::new(!req.only_queued.unwrap_or(false)),
                ast: Mutex::new(None),
                req,
            });
            map.insert(key, s.clone());
            s
        };
        self.broadcast();
        let me = self.clone();
        let handle = tauri::async_runtime::spawn(async move { me.session(session).await });
        Ok((run, handle))
    }

    /// The session's life: `start`, `status resuming`, the loop until it ends (again while a late message waits, R4),
    /// then `done`, claims released, the folder lock given back with the last session there (B8).
    async fn session(self: Arc<Self>, s: Arc<Session>) {
        self.emit(&s, Kind::Start, "swarm", "", s.req.goal.clone().unwrap_or_default());
        self.emit(&s, Kind::Status, "swarm", "", "resuming");
        self.world.prepare(&s.root);
        let left = loop {
            let outcome = self.run_loop(&s).await;
            #[cfg(test)]
            if let Some(f) = self.after_loop.lock().unwrap().take() {
                f();
            }
            // swarm_say queues under the same lock: a message either lands before this check or finds no session.
            let ended = {
                let mut map = self.sessions.lock().unwrap();
                if !s.stopped() && Queue::load(&s.queue).answer_waiting() {
                    None
                } else {
                    self.emit(&s, Kind::Done, "swarm", "", outcome);
                    self.claims.release(&s.key);
                    map.remove(&s.key);
                    if !map.values().any(|o| o.folder == s.folder) {
                        queue::unlock_folder(&s.root);
                    }
                    Some(map.len())
                }
            };
            if let Some(left) = ended {
                break left;
            }
        };
        self.broadcast();
        if left == 0 && self.quit_when_done.load(Ordering::SeqCst) {
            self.world.exit();
        }
    }

    /// B5/B7: Stop. The turn ends mid-call; the folder's background tasks stop with its last working session.
    pub fn stop(&self, folder: &str, run: &str) {
        let map = self.sessions.lock().unwrap();
        let key = queue::session_key(folder, run);
        if let Some(s) = map.get(&key) {
            s.stop.stop();
        }
        if !map.iter().any(|(k, s)| s.folder == folder && *k != key && !s.stopped()) {
            self.world.cancel_tasks(folder);
        }
    }

    /// `control pause(run?)`: stops one session, or every session in the folder; returns the runs paused. Unlike Stop,
    /// it leaves the folder's background tasks alone.
    pub fn pause(&self, folder: &str, run: Option<&str>) -> Vec<String> {
        let map = self.sessions.lock().unwrap();
        let mut paused: Vec<String> = map
            .values()
            .filter(|s| s.folder == folder && run.is_none_or(|r| s.run == r) && !s.stopped())
            .map(|s| {
                s.stop.stop();
                s.run.clone()
            })
            .collect();
        paused.sort();
        paused
    }

    /// B11: the app is quitting: every session stops and its log gets the quit line (not emitted).
    pub fn pause_all(&self) {
        for s in self.sessions.lock().unwrap().values() {
            s.stop.stop();
            events::log(&SwarmEvent::new(&s.folder, &s.run, Kind::Done, "swarm", "", QUIT, s.spent()));
        }
    }

    /// B20: a message, queued as an `answer` job and shown as `you`.
    pub fn say(&self, folder: &str, run: &str, text: &str) -> Result<(), String> {
        let spent = {
            let map = self.sessions.lock().unwrap();
            let s = map.get(&queue::session_key(folder, run)).ok_or(NOT_RUNNING)?;
            Queue::update(&s.queue, |q| q.enqueue(NewJob::answer(text))).map_err(|e| e.to_string())?;
            s.spent()
        };
        events::emit(&*self.emitter, SwarmEvent::new(folder, run, Kind::You, "you", "", text, spent));
        Ok(())
    }

    /// B10: the cap, live (≥ 0).
    pub fn set_budget(&self, folder: &str, run: &str, usd: f64) -> Result<(), String> {
        let s = self.get(folder, run).ok_or(NOT_RUNNING)?;
        *s.budget.lock().unwrap() = usd.max(0.0);
        Ok(())
    }

    /// B37: Compact now, taken by the next API step.
    pub fn compact(&self, folder: &str, run: &str) -> Result<(), String> {
        let s = self.get(folder, run).ok_or(NOT_RUNNING)?;
        s.compact_now.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// `swarm_running`: the folder's running sessions.
    pub fn running(&self, folder: &str) -> Vec<String> {
        let mut r: Vec<String> = self.sessions.lock().unwrap().values().filter(|s| s.folder == folder).map(|s| s.run.clone()).collect();
        r.sort();
        r
    }

    /// B21: an audit report to read, queued as a `triage` job in the session (a running one takes it next).
    pub fn triage(&self, folder: &str, path: &str, session: Option<&str>) -> Result<(), String> {
        self.world.allowed(folder)?;
        queue_triage(folder, path, session)
    }

    /// B22: a proof written outside the app (the MCP), queued for review on the plan item naming `function`.
    pub fn submit_proof(&self, folder: &str, function: &str, path: &str, notes: Option<&str>, session: Option<&str>) -> Result<serde_json::Value, String> {
        self.world.allowed(folder)?;
        queue_review(folder, function, path, notes, session)
    }

    /// Whether any session runs, in any folder (⌘Q).
    pub fn any_running(&self) -> bool {
        !self.sessions.lock().unwrap().is_empty()
    }
}

/// B21 after the folder guard: the report checked and queued as a `triage` job.
pub fn queue_triage(folder: &str, path: &str, session: Option<&str>) -> Result<(), String> {
    let root = PathBuf::from(folder);
    let p = super::fsguard::inside(&root, path)?;
    if !p.is_file() {
        return Err(format!("{path} isn't a file"));
    }
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["pdf", "md", "markdown", "txt"].contains(&ext.as_str()) {
        return Err("Reports are PDF, Markdown or text files".into());
    }
    let qf = queue::queue_path(&root, &queue::session_id(session));
    Queue::update(&qf, |q| q.enqueue(NewJob { text: path.into(), attempt: 1, ..NewJob::new(queue::Kind::Triage) })).map_err(|e| e.to_string())?;
    Ok(())
}

/// B22 after the folder guard: queued for review on the plan item naming `function`.
pub fn queue_review(folder: &str, function: &str, path: &str, notes: Option<&str>, session: Option<&str>) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(folder);
    super::fsguard::inside(&root, path)?;
    let items = super::plan::read(&root);
    let Some(item) = super::plan::find_def(&items, function) else {
        return Err(format!("No plan item names `{function}`; the plan names each function by its Lean def (see the work map)"));
    };
    let summary = format!("Written by an agent outside the app, through Formal Mind's MCP, in {path}.\n\n{}", notes.unwrap_or_default().trim());
    let qf = queue::queue_path(&root, &queue::session_id(session));
    let job = Queue::update(&qf, |q| {
        q.enqueue(NewJob { item: item.index, text: item.text.clone(), attempt: 1, notes: summary, files: vec![path.into()], ..NewJob::new(queue::Kind::Review) })
    })
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "item": item.index, "job": job, "queued": "review" }))
}
