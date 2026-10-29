//! The loop end to end (SPEC.md §5 `loop`): a scripted agent and a fake world drive real sessions on temp folders;
//! each test asserts queue states, plan marks, files and the event sequence for one behaviour.

use super::world::{Coverage, Scan, World};
use super::*;
use crate::swarm2::events::{Kind, Recorder};
use crate::swarm2::executor::{BoxFuture, Ended, Outcome, ToolHost, Turn, TurnError};
use crate::swarm2::fsguard::tests::TempDir;
use crate::swarm2::plan::{self, Mark};
use crate::swarm2::queue::{Job, Kind as JobKind, State};
use crate::swarm2::tools::{self, Effect};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::AtomicUsize;
use std::time::Instant;

// ---- the scripted agent ----

/// One thing an agent does in its turn.
enum Act {
    /// `write_file`.
    Write(&'static str, &'static str),
    /// Any tool call.
    Call(&'static str, Value),
    /// A model call that cost this much.
    Spend(f64),
    /// Runs in the turn (stops a session, sends a message).
    Then(Box<dyn Fn() + Send + Sync>),
    /// Thinks until Stop: a minutes-long model call.
    Think,
    /// A tool call that runs until Stop (a long `lake build`), raced as the routes race it.
    LongTool,
    Fail(TurnError),
}

#[derive(Default)]
struct Script {
    turns: Mutex<VecDeque<Vec<Act>>>,
    /// (role, item, task) of each turn.
    seen: Mutex<Vec<(String, String, String)>>,
}

impl Script {
    fn roles(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|t| t.0.clone()).collect()
    }
}

struct Scripted(Arc<Script>);

impl Agent for Scripted {
    fn turn<'a>(&'a self, turn: &'a Turn, tools: &'a dyn ToolHost, stop: &'a Stop) -> BoxFuture<'a, Result<Outcome, TurnError>> {
        Box::pin(async move {
            let task = crate::swarm2::executor::task_text(&turn.task);
            self.0.seen.lock().unwrap().push((turn.role.clone(), turn.item.clone(), task));
            let acts = self.0.turns.lock().unwrap().pop_front().unwrap_or_default();
            let stopped = || Ok(Outcome { ended: Ended::Stopped, summary: "partial".into(), ..Outcome::default() });
            for act in acts {
                match act {
                    Act::Write(path, content) => {
                        tools.call("write_file", &json!({ "path": path, "content": content })).await;
                    }
                    Act::Call(name, args) => {
                        tools.call(name, &args).await;
                    }
                    Act::Spend(d) => turn.events.spend(d),
                    Act::Then(f) => f(),
                    Act::Think => {
                        stop.stopped().await;
                        return stopped();
                    }
                    Act::LongTool => {
                        if stop.race(tools.call("run", &json!({ "command": "lake build Slow" }))).await.is_none() {
                            return stopped();
                        }
                    }
                    Act::Fail(e) => return Err(e),
                }
                if stop.is_stopped() {
                    return stopped();
                }
            }
            Ok(Outcome { summary: format!("{} done", turn.role), ..Outcome::default() })
        })
    }
}

// ---- the fake world ----

struct Fake {
    script: Arc<Script>,
    /// What `run` answers, in order (then `exit 0`).
    builds: Mutex<VecDeque<String>>,
    commands: Mutex<Vec<String>>,
    coverage: Mutex<Coverage>,
    ledger: Mutex<Value>,
    approved: Mutex<Vec<String>>,
    cancelled: Mutex<Vec<String>>,
    exits: AtomicUsize,
}

impl World for Fake {
    fn allowed(&self, folder: &str) -> Result<(), String> {
        if Path::new(folder).is_dir() { Ok(()) } else { Err("Add the folder first".into()) }
    }
    fn agent(&self, req: &SwarmRequest) -> Result<Arc<dyn Agent>, String> {
        if req.provider.as_deref() == Some("anthropic") {
            return Err("Add your Anthropic key first".into());
        }
        Ok(Arc::new(Scripted(self.script.clone())))
    }
    fn system(&self, role: &str, _folder: &str, _goal: &str) -> String {
        format!("you are the {role}")
    }
    fn ast<'a>(&'a self, _root: &'a Path) -> BoxFuture<'a, Option<Arc<crate::swarm_ctx::Context>>> {
        Box::pin(async { None })
    }
    fn scan<'a>(&'a self, _root: &'a Path, _plan: &'a str) -> BoxFuture<'a, Scan> {
        Box::pin(async { Scan { in_scope: "functions: 2 in scope across Vault".into(), ..Scan::default() } })
    }
    fn ledger<'a>(&'a self, _root: &'a Path) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async { Ok(self.ledger.lock().unwrap().clone()) })
    }
    fn brief(&self, _root: &Path, _ast: Option<&crate::swarm_ctx::Context>, text: &str) -> String {
        format!("brief of {text}")
    }
    fn run<'a>(&'a self, _root: &'a Path, command: &'a str) -> BoxFuture<'a, String> {
        self.commands.lock().unwrap().push(command.to_string());
        let out = self.builds.lock().unwrap().pop_front().unwrap_or_else(|| "exit 0\n".into());
        Box::pin(async move {
            if command == "lake build Slow" {
                tokio::time::sleep(Duration::from_secs(600)).await;
            }
            out
        })
    }
    fn coverage(&self, _ast: Option<&crate::swarm_ctx::Context>, _text: &str) -> Coverage {
        self.coverage.lock().unwrap().clone()
    }
    fn check_theorem<'a>(&'a self, _root: &'a Path, _s: &'a str, _lean: &'a str) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async { Ok("theorem type".into()) })
    }
    fn approved(&self, _root: &Path, item_text: &str, _notes: &str) {
        self.approved.lock().unwrap().push(item_text.to_string());
    }
    fn statement_proved(&self, _root: &Path, _id: &str) {}
    /// `report_bug` without forge: the bug is filed as the real tool would file it. `run` goes to [`Fake::run`].
    fn tool<'a>(&'a self, ctx: &'a tools::Ctx<'a>, role: &'a str, name: &'a str, args: &'a Value) -> BoxFuture<'a, String> {
        Box::pin(async move {
            match name {
                "report_bug" => {
                    ctx.hooks.effect(Effect::Bug(format!("FM-01 {}", args["title"].as_str().unwrap_or("bug"))));
                    "filed as FM-01".to_string()
                }
                "run" => self.run(ctx.root, args["command"].as_str().unwrap_or("")).await,
                _ => tools::call(ctx, role, name, args).await,
            }
        })
    }
    fn cancel_tasks(&self, folder: &str) {
        self.cancelled.lock().unwrap().push(folder.to_string());
    }
    fn exit(&self) {
        self.exits.fetch_add(1, Ordering::SeqCst);
    }
}

// ---- the bench ----

const ITEM1: &str = "`Vault.deposit` — Vault (src/Vault.sol:12): nonpayable · writes [balance] · guards 1 · external calls 0";
const ITEM2: &str = "`Vault.withdraw` — Vault (src/Vault.sol:30): nonpayable · writes [balance] · guards 1 · external calls 1";
const PROOF1: &str = "Proofs/Functions/VaultDeposit.lean";
const GOOD: &str = "theorem Vault.deposit_ok : True := trivial\n";

struct Bench {
    dir: TempDir,
    script: Arc<Script>,
    world: Arc<Fake>,
    rec: Arc<Recorder>,
    engine: Arc<Engine>,
}

impl Bench {
    /// A folder with a Lake project (`Specs`/`Proofs` at the root) and a plan of `items`.
    fn new(tag: &str, items: &[(Mark, &str)]) -> Bench {
        let dir = TempDir::new(tag);
        dir.file("lakefile.toml", "name = \"t\"\n\n[[lean_lib]]\nname = \"Specs\"\n\n[[lean_lib]]\nname = \"Proofs\"\n");
        if !items.is_empty() {
            let lines: Vec<String> = items.iter().map(|(m, t)| format!("- [{}] {t}", m.as_char())).collect();
            plan::append(&dir.0, &lines).unwrap();
        }
        let script = Arc::new(Script::default());
        let world = Arc::new(Fake {
            script: script.clone(),
            builds: Mutex::default(),
            commands: Mutex::default(),
            coverage: Mutex::new(Coverage::NoTarget),
            ledger: Mutex::new(json!({ "entries": [] })),
            approved: Mutex::default(),
            cancelled: Mutex::default(),
            exits: AtomicUsize::new(0),
        });
        let rec = Arc::new(Recorder::default());
        let engine = Engine::new(rec.clone(), world.clone());
        let mut e = Arc::try_unwrap(engine).ok().unwrap();
        e.backoff = Duration::from_millis(10);
        Bench { dir, script, world, rec, engine: Arc::new(e) }
    }

    fn root(&self) -> &Path {
        &self.dir.0
    }

    fn folder(&self) -> String {
        self.dir.0.to_string_lossy().into_owned()
    }

    fn turn(&self, acts: Vec<Act>) -> &Self {
        self.script.turns.lock().unwrap().push_back(acts);
        self
    }

    fn req(&self) -> SwarmRequest {
        SwarmRequest { folder: self.folder(), budget_usd: 100.0, api_base: "http://localhost".into(), ..SwarmRequest::default() }
    }

    fn start(&self, req: SwarmRequest) -> tauri::async_runtime::JoinHandle<()> {
        self.engine.start_task(req).expect("starts").1
    }

    /// Runs a session to its end (failing after 20 s).
    fn run(&self, req: SwarmRequest) {
        let h = self.start(req);
        wait(h);
    }

    fn queue(&self, run: &str) -> Queue {
        Queue::load(&queue::queue_path(self.root(), run))
    }

    fn jobs(&self) -> Vec<Job> {
        self.queue("swarm").jobs
    }

    fn marks(&self) -> Vec<Mark> {
        plan::read(self.root()).into_iter().map(|i| i.mark).collect()
    }

    /// (kind, role, item, text) of every event but the steps.
    fn said(&self) -> Vec<(Kind, String, String, String)> {
        self.rec.events.lock().unwrap().iter().filter(|e| !e.kind.is_step() || e.kind == Kind::Status).map(|e| (e.kind, e.role.clone(), e.item.clone(), e.text.clone())).collect()
    }

    fn texts(&self, kind: Kind) -> Vec<String> {
        self.rec.events.lock().unwrap().iter().filter(|e| e.kind == kind).map(|e| e.text.clone()).collect()
    }

    fn done(&self) -> Vec<String> {
        self.texts(Kind::Done)
    }

    /// Stops the session `run` once its agent is in a turn (from another thread, as the UI would).
    fn stop_soon(&self, run: &'static str) -> std::thread::JoinHandle<Instant> {
        let (engine, folder) = (self.engine.clone(), self.folder());
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            engine.stop(&folder, run);
            Instant::now()
        })
    }
}

fn wait(h: tauri::async_runtime::JoinHandle<()>) {
    tauri::async_runtime::block_on(async { tokio::time::timeout(Duration::from_secs(20), h).await.expect("the session ended").expect("no panic") });
}

/// `needle` appears in `hay` in order (other events may come between).
fn in_order(hay: &[String], needle: &[&str]) -> bool {
    let mut it = hay.iter();
    needle.iter().all(|n| it.any(|h| h.contains(n)))
}

fn verdict(decision: &str, notes: &str) -> Act {
    Act::Call("verdict", json!({ "decision": decision, "notes": notes }))
}

fn property() -> Act {
    Act::Call("record_property", json!({ "statement": "Deposits add to the balance.", "assumptions": "", "theorems": ["Vault.deposit_ok"] }))
}

fn job(kind: JobKind, item: usize, text: &str, state: State) -> Job {
    Job { id: 0, kind, item, text: text.into(), state, attempt: 1, ..Job::default() }
}

/// Puts jobs in the default session's queue, numbered from 1.
fn seed(root: &Path, jobs: Vec<Job>) {
    Queue::update(&queue::queue_path(root, "swarm"), |q| {
        for mut j in jobs {
            q.next_id += 1;
            j.id = q.next_id;
            q.jobs.push(j);
        }
    })
    .unwrap();
}

// ---- sessions ----

#[test]
fn b1_start_checks_then_emits_start_and_resuming_and_queues_the_goal() {
    let b = Bench::new("b1", &[]);
    assert_eq!(b.engine.start(SwarmRequest { folder: "/nowhere/at/all".into(), ..b.req() }).unwrap_err(), "Add the folder first");
    assert_eq!(b.engine.start(SwarmRequest { provider: Some("anthropic".into()), ..b.req() }).unwrap_err(), "Add your Anthropic key first");
    b.turn(vec![Act::Think]);
    let (run, h) = b.engine.start_task(SwarmRequest { goal: Some("  prove deposit  ".into()), only_queued: Some(true), ..b.req() }).unwrap();
    assert_eq!(run, "swarm");
    assert_eq!(b.engine.start(b.req()).unwrap_err(), ALREADY);
    assert_eq!(b.engine.running(&b.folder()), vec!["swarm"]);
    assert_eq!(std::fs::read_to_string(queue::lock_path(b.root())).unwrap(), std::process::id().to_string());
    b.stop_soon("swarm");
    wait(h);
    let said = b.said();
    assert_eq!(said[0], (Kind::Start, "swarm".into(), "".into(), "  prove deposit  ".into()));
    assert_eq!(said[1], (Kind::Status, "swarm".into(), "".into(), "resuming".into()));
    let answer = &b.jobs()[0];
    assert_eq!((answer.kind.clone(), answer.text.as_str()), (JobKind::Answer, "prove deposit"));
    assert_eq!(b.script.seen.lock().unwrap()[0].2, "The maintainer says:\n\nprove deposit");
    // swarm-running: the session, then nothing.
    let running = b.rec.running.lock().unwrap().clone();
    assert_eq!(running.first().unwrap()[&b.folder()], vec!["swarm"]);
    assert!(running.last().unwrap().is_empty());
}

#[test]
fn b5_stop_ends_a_turn_mid_model_call() {
    let b = Bench::new("b5", &[(Mark::Open, ITEM1)]);
    b.turn(vec![Act::Think]);
    let h = b.start(b.req());
    let stopped_at = b.stop_soon("swarm");
    wait(h);
    let ended = Instant::now();
    assert!(ended.duration_since(stopped_at.join().unwrap()) < Duration::from_secs(1));
    assert_eq!(b.done(), vec![PAUSED]);
}

#[test]
fn b6_a_stopped_turn_stays_queued_and_resumes() {
    let b = Bench::new("b6", &[(Mark::Open, ITEM1)]);
    b.turn(vec![Act::Write(PROOF1, GOOD), Act::Think]);
    let h = b.start(b.req());
    b.stop_soon("swarm");
    wait(h);
    let jobs = b.jobs();
    assert_eq!(jobs.len(), 1, "no follow-up job");
    assert_eq!((jobs[0].kind.clone(), jobs[0].state), (JobKind::Prove, State::Running));
    assert_eq!(jobs[0].files, vec![PROOF1]);
    // The next start resumes it, saying what was written.
    b.turn(vec![Act::Think]);
    let h = b.start(b.req());
    b.stop_soon("swarm");
    wait(h);
    let seen = b.script.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert!(seen[1].2.contains("This job was interrupted (the app quit) and is being resumed. Files already written for it: Proofs/Functions/VaultDeposit.lean."));
    assert_eq!(b.jobs().len(), 1);
}

#[test]
fn b7_stopping_the_last_session_cancels_background_tasks() {
    let b = Bench::new("b7", &[(Mark::Open, ITEM1), (Mark::Open, ITEM2)]);
    b.turn(vec![Act::Think]).turn(vec![Act::Think]);
    let h1 = b.start(b.req());
    std::thread::sleep(Duration::from_millis(100));
    let h2 = b.start(SwarmRequest { session: Some("two".into()), ..b.req() });
    std::thread::sleep(Duration::from_millis(100));
    b.engine.stop(&b.folder(), "two");
    assert!(b.world.cancelled.lock().unwrap().is_empty(), "the default session still works there");
    b.engine.stop(&b.folder(), "swarm");
    assert_eq!(*b.world.cancelled.lock().unwrap(), vec![b.folder()]);
    wait(h1);
    wait(h2);
}

#[test]
fn b8_session_end_releases_claims_and_the_folder_lock() {
    let b = Bench::new("b8", &[(Mark::Open, ITEM1), (Mark::Open, ITEM2)]);
    // Two sessions take different items (B4); the one that ends gives its item back.
    b.turn(vec![Act::Think]).turn(vec![Act::Think]);
    let h1 = b.start(b.req());
    std::thread::sleep(Duration::from_millis(100));
    let h2 = b.start(SwarmRequest { session: Some("two".into()), ..b.req() });
    std::thread::sleep(Duration::from_millis(100));
    let items: Vec<String> = b.script.seen.lock().unwrap().iter().map(|t| t.1.clone()).collect();
    assert_eq!(items, vec!["1", "2"]);
    b.engine.stop(&b.folder(), "swarm");
    wait(h1);
    assert!(queue::lock_path(b.root()).exists(), "kept while another session works in the folder");
    assert!(!b.engine.claims.taken_by_other(&b.folder(), 1, "x"));
    assert!(b.engine.claims.taken_by_other(&b.folder(), 2, "x"));
    b.engine.stop(&b.folder(), "two");
    wait(h2);
    assert!(!queue::lock_path(b.root()).exists());
    assert!(!b.engine.any_running());
    assert_eq!(b.done(), vec![PAUSED, PAUSED]);
}

#[test]
fn b9_outcomes() {
    // Nothing in scope.
    let b = Bench::new("b9a", &[]);
    b.run(b.req());
    assert_eq!(b.done(), vec![NO_SCOPE]);
    assert_eq!(b.jobs()[0].state, State::Done);
    // Everything proved or blocked.
    let b = Bench::new("b9b", &[(Mark::Proved, ITEM1), (Mark::Blocked, ITEM2)]);
    b.run(b.req());
    assert_eq!(b.done(), vec!["done: every function in scope is proved or blocked (2 items)"]);
    assert_eq!(b.texts(Kind::Plan), vec!["the plan has every function in scope", "the plan has every function in scope"]);
    // A turn error pauses with the job running.
    let b = Bench::new("b9c", &[(Mark::Open, ITEM1)]);
    b.turn(vec![Act::Fail(TurnError::Paused("You've hit your limit".into()))]);
    b.run(b.req());
    assert_eq!(b.done(), vec!["paused: You've hit your limit"]);
    assert_eq!(b.jobs()[0].state, State::Running);
}

#[test]
fn b10_budget_ends_the_session_before_the_next_job() {
    let b = Bench::new("b10", &[(Mark::Open, ITEM1)]);
    b.turn(vec![Act::Spend(1.5), Act::Write(PROOF1, GOOD)]);
    b.run(SwarmRequest { budget_usd: 1.0, ..b.req() });
    assert_eq!(b.done(), vec!["budget reached ($1.50 spent of $1.00); raise it and resume to carry on"]);
    assert_eq!(b.queue("swarm").spent, 1.5);
    assert_eq!(b.script.roles(), vec!["prover"], "the review waits for more budget");
    // A start below the spend is held at it, naming the cap asked for.
    b.run(SwarmRequest { budget_usd: 0.5, ..b.req() });
    assert_eq!(b.done()[1], "budget reached ($1.50 spent of $0.50); raise it and resume to carry on");
    // On Claude Code the plan pays: no cap.
    b.turn(vec![verdict("approve", "fine")]);
    b.run(SwarmRequest { budget_usd: 0.5, provider: Some("claude-code".into()), ..b.req() });
    assert_eq!(b.marks(), vec![Mark::Proved]);
    // Raised live.
    let b = Bench::new("b10b", &[(Mark::Open, ITEM1)]);
    let (engine, folder) = (b.engine.clone(), b.folder());
    b.turn(vec![Act::Spend(2.0), Act::Then(Box::new(move || engine.set_budget(&folder, "swarm", 10.0).unwrap())), Act::Write(PROOF1, GOOD)]).turn(vec![verdict("approve", "ok")]);
    b.run(SwarmRequest { budget_usd: 1.0, ..b.req() });
    assert_eq!(b.marks(), vec![Mark::Proved]);
}

#[test]
fn b11_quit_records_the_pause_and_exits_after_the_last_session() {
    let b = Bench::new("b11", &[(Mark::Open, ITEM1)]);
    b.turn(vec![Act::Think]);
    let h = b.start(b.req());
    std::thread::sleep(Duration::from_millis(150));
    b.engine.quit_when_done.store(true, Ordering::SeqCst);
    b.engine.pause_all();
    wait(h);
    assert!(!b.texts(Kind::Done).iter().any(|t| t == QUIT), "logged, not emitted");
    let log = std::fs::read_to_string(b.root().join(".formal/runs/swarm.jsonl")).unwrap();
    assert!(log.contains(QUIT));
    assert_eq!(b.world.exits.load(Ordering::SeqCst), 1);
}

#[test]
fn b12_only_queued_answers_and_ends() {
    let b = Bench::new("b12", &[(Mark::Open, ITEM1)]);
    b.turn(vec![]);
    b.run(SwarmRequest { goal: Some("what does deposit do?".into()), only_queued: Some(true), ..b.req() });
    assert_eq!(b.script.roles(), vec!["assistant"]);
    assert_eq!(b.done(), vec![QUEUED_DONE]);
    assert_eq!(b.marks(), vec![Mark::Open]);
    // A queued report in an only-queued run is read, then the run ends.
    b.dir.file("audit/report.md", "# Report\n");
    b.engine.triage(&b.folder(), "audit/report.md", None).unwrap();
    b.turn(vec![]);
    b.run(SwarmRequest { only_queued: Some(true), ..b.req() });
    assert_eq!(b.script.roles(), vec!["assistant", "auditor"]);
    assert_eq!(b.done()[1], QUEUED_DONE);
}

#[test]
fn b14_job_order() {
    let b = Bench::new("b14", &[(Mark::Open, ITEM1), (Mark::Open, ITEM2)]);
    b.dir.file("audit/report.md", "# Report\n");
    seed(
        b.root(),
        vec![
            job(JobKind::Triage, 0, "audit/report.md", State::Queued),
            job(JobKind::Answer, 0, "hello", State::Queued),
            Job { verdict: Some(json!({ "decision": "changes", "notes": "weak" })), ..job(JobKind::Review, 2, ITEM2, State::Queued) },
            Job { attempt: 1, ..job(JobKind::Prove, 2, ITEM2, State::Running) },
        ],
    );
    // resumed prove of 2 → answer → triage → the queued review of 2 → the oldest queued job (the retry of the resumed
    // prove, whose check failed) → only then the plan.
    b.turn(vec![]).turn(vec![]).turn(vec![]).turn(vec![verdict("changes", "weak")]).turn(vec![Act::Think]);
    let h = b.start(b.req());
    let stop = std::thread::spawn({
        let (engine, folder, script) = (b.engine.clone(), b.folder(), b.script.clone());
        move || {
            while script.seen.lock().unwrap().len() < 5 {
                std::thread::sleep(Duration::from_millis(20));
            }
            engine.stop(&folder, "swarm");
        }
    });
    wait(h);
    stop.join().unwrap();
    let seen: Vec<(String, String)> = b.script.seen.lock().unwrap().iter().map(|t| (t.0.clone(), t.1.clone())).collect();
    let want = [("prover", "2"), ("assistant", "you"), ("auditor", "report"), ("reviewer", "2"), ("prover", "2")];
    assert_eq!(seen, want.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>());
    // Marked running before its agent started.
    let retry = b.jobs().into_iter().find(|j| j.kind == JobKind::Prove && j.attempt == 2).unwrap();
    assert_eq!(retry.state, State::Running);
    assert!(b.jobs().iter().all(|j| j.item != 1), "the plan waits for the queue");
}

// ---- prove → check → review ----

#[test]
fn b17_passing_check_goes_to_review_building_only_its_modules() {
    let b = Bench::new("b17a", &[(Mark::Open, ITEM1)]);
    b.dir.file("Proofs/Functions/Other.lean", "broken");
    *b.world.coverage.lock().unwrap() = Coverage::Proved { lean: "Vault.deposit".into(), theorems: vec!["Vault.deposit_ok".into()] };
    b.turn(vec![Act::Write(PROOF1, GOOD), property()]).turn(vec![Act::Think]);
    let h = b.start(b.req());
    b.stop_soon("swarm");
    wait(h);
    // R12: only the item's module.
    assert_eq!(*b.world.commands.lock().unwrap(), vec!["lake build Proofs.Functions.VaultDeposit"]);
    let jobs = b.jobs();
    let review = jobs.iter().find(|j| j.kind == JobKind::Review).unwrap();
    assert_eq!((review.item, review.attempt, review.files.clone()), (1, 1, vec![PROOF1.to_string()]));
    assert!(review.notes.starts_with("prover done\n\nChecked by the swarm: `lake build` passes; the Proofs page counts it as proved by Vault.deposit_ok."));
    assert_eq!(review.property.as_ref().unwrap()["statement"], "Deposits add to the balance.");
    assert_eq!(jobs[0].state, State::Done);
    let texts: Vec<String> = b.said().into_iter().map(|e| e.3).collect();
    assert!(in_order(&texts, &["reading the item's def and slice (formal-ast)", "checking: lake build Proofs.Functions.VaultDeposit", "checking: the Proofs page's coverage of Vault.deposit", "item 1 checks; to review"]));
    // The reviewer's task carries the prover's summary, notes and files.
    let task = &b.script.seen.lock().unwrap()[1].2;
    assert!(task.contains("The prover says:\nprover done") && task.contains("Statement: Deposits add to the balance.") && task.contains("Files: Proofs/Functions/VaultDeposit.lean"));
}

#[test]
fn b17_failed_check_requeues_with_notes() {
    let b = Bench::new("b17b", &[(Mark::Open, ITEM1)]);
    b.world.builds.lock().unwrap().push_back("exit 1\nerror: unknown identifier 'foo'\n".into());
    b.turn(vec![Act::Write(PROOF1, GOOD)]).turn(vec![Act::Think]);
    let h = b.start(b.req());
    b.stop_soon("swarm");
    wait(h);
    let jobs = b.jobs();
    assert_eq!(jobs[0].result, "changes");
    let retry = &jobs[1];
    assert_eq!((retry.kind.clone(), retry.attempt, retry.files.clone()), (JobKind::Prove, 2, vec![PROOF1.to_string()]));
    assert_eq!(retry.notes, "The swarm's check failed:\n`lake build` failed:\nerror: unknown identifier 'foo'");
    assert!(b.texts(Kind::Plan).contains(&"item 1: the check failed, back to the prover".to_string()));
    assert!(b.script.seen.lock().unwrap()[1].2.contains("The last attempt was sent back:\nThe swarm's check failed:"));
}

#[test]
fn b17_cheats_and_missing_proofs_fail_and_block_after_three() {
    let b = Bench::new("b17c", &[(Mark::Open, ITEM1)]);
    b.turn(vec![Act::Write(PROOF1, "theorem t : False := sorry\n")]).turn(vec![]).turn(vec![Act::Write(PROOF1, "axiom bad : False\n")]);
    b.run(b.req());
    let jobs = b.jobs();
    let proves: Vec<&Job> = jobs.iter().filter(|j| j.kind == JobKind::Prove).collect();
    assert_eq!(proves.len(), 3);
    assert!(proves[1].notes.contains("uses `sorry`"));
    // The second turn wrote nothing, but the file from the first is where the item's proof goes: checked there.
    assert!(proves[2].notes.contains("uses `sorry`"));
    assert_eq!(b.marks(), vec![Mark::Blocked]);
    assert!(b.texts(Kind::Plan).contains(&"item 1 blocked: the proof didn't check after 3 attempts".to_string()));
    assert_eq!(b.done(), vec!["done: every function in scope is proved or blocked (1 items)"]);
    assert!(b.world.commands.lock().unwrap().is_empty(), "cheats never reach lake");
}

#[test]
fn b18_approval_marks_proved_and_records_it() {
    let b = Bench::new("b18a", &[(Mark::Open, ITEM1)]);
    b.turn(vec![Act::Write(PROOF1, GOOD), property()]).turn(vec![Act::Call("verdict", json!({ "decision": "approve", "notes": "sound", "assumptions": "no reentrancy" }))]);
    b.run(b.req());
    assert_eq!(b.marks(), vec![Mark::Proved]);
    assert_eq!(*b.world.approved.lock().unwrap(), vec![ITEM1]);
    let review = b.jobs().into_iter().find(|j| j.kind == JobKind::Review).unwrap();
    assert_eq!((review.state, review.result.as_str()), (State::Done, "approve"));
    let proofs: Value = serde_json::from_str(&std::fs::read_to_string(b.root().join(".formal/proofs.json")).unwrap()).unwrap();
    assert_eq!(proofs["1"]["files"], json!([PROOF1]));
    let audit: Value = serde_json::from_str(&std::fs::read_to_string(crate::swarm2::audit::internal_path(b.root())).unwrap()).unwrap();
    let p = &audit["properties"][0];
    assert_eq!(p["id"], "P-01");
    assert!(p["description"].as_str().unwrap().contains("Deposits add to the balance.\n\n**Assumptions.** no reentrancy"));
    assert_eq!(b.texts(Kind::Plan), vec!["the plan has every function in scope", "item 1 checks; to review", "item 1 proven", "the plan has every function in scope"]);
    assert_eq!(b.done(), vec!["done: every function in scope is proved or blocked (1 items)"]);
}

#[test]
fn b18_changes_go_back_to_the_prover_and_block_after_three() {
    let b = Bench::new("b18b", &[(Mark::Open, ITEM1)]);
    for n in 0..3 {
        b.turn(vec![Act::Write(PROOF1, GOOD)]);
        b.turn(if n == 1 { vec![] } else { vec![verdict("changes", "too weak")] });
    }
    b.run(b.req());
    let proves: Vec<Job> = b.jobs().into_iter().filter(|j| j.kind == JobKind::Prove).collect();
    assert_eq!(proves.iter().map(|j| j.attempt).collect::<Vec<_>>(), vec![1, 2, 3]);
    assert_eq!(proves[1].notes, "too weak");
    assert_eq!(proves[2].notes, "The reviewer gave no verdict; make the proof's statement and check obvious.");
    assert_eq!(b.marks(), vec![Mark::Blocked]);
    assert!(b.texts(Kind::Plan).contains(&"item 1 blocked after 3 attempts".to_string()));
}

#[test]
fn b18_a_bug_blocks_the_item_and_moves_on() {
    let b = Bench::new("b18c", &[(Mark::Open, ITEM1), (Mark::Open, ITEM2)]);
    b.turn(vec![Act::Call("report_bug", json!({ "title": "deposit mints twice" }))]).turn(vec![Act::Think]);
    let h = b.start(b.req());
    b.stop_soon("swarm");
    wait(h);
    assert_eq!(b.marks(), vec![Mark::Blocked, Mark::Open]);
    assert_eq!(b.jobs()[0].result, "bug");
    assert!(b.world.commands.lock().unwrap().is_empty(), "no check after a bug");
    assert!(b.texts(Kind::Plan).contains(&"item 1: bug reported, moving on".to_string()));
    assert_eq!(b.script.seen.lock().unwrap()[1].1, "2");
}

#[test]
fn b19_start_work_and_reopen_turn_the_plan_on() {
    let b = Bench::new("b19", &[(Mark::Proved, ITEM1)]);
    b.turn(vec![Act::Call("reopen", json!({ "defs": ["Vault.deposit", "Vault.nope"] }))]).turn(vec![Act::Think]);
    let h = b.start(SwarmRequest { goal: Some("prove deposit again".into()), only_queued: Some(true), ..b.req() });
    std::thread::spawn({
        let (engine, folder, script) = (b.engine.clone(), b.folder(), b.script.clone());
        move || {
            while script.seen.lock().unwrap().len() < 2 {
                std::thread::sleep(Duration::from_millis(20));
            }
            engine.stop(&folder, "swarm");
        }
    });
    wait(h);
    assert_eq!(b.script.roles(), vec!["assistant", "prover"]);
    assert!(b.texts(Kind::Result).contains(&"reopened Vault.deposit; after your answer, the swarm proves them; not in the plan: Vault.nope".to_string()));
    // start_work alone does the same.
    let b = Bench::new("b19b", &[(Mark::Open, ITEM1)]);
    b.turn(vec![Act::Call("start_work", json!({}))]).turn(vec![Act::Write(PROOF1, GOOD)]).turn(vec![verdict("approve", "ok")]);
    b.run(SwarmRequest { goal: Some("prove the plan".into()), only_queued: Some(true), ..b.req() });
    assert_eq!(b.script.roles(), vec!["assistant", "prover", "reviewer"]);
    assert_eq!(b.marks(), vec![Mark::Proved]);
}

#[test]
fn b20_say_queues_an_answer_and_shows_it() {
    let b = Bench::new("b20", &[(Mark::Open, ITEM1)]);
    assert_eq!(b.engine.say(&b.folder(), "swarm", "hi").unwrap_err(), NOT_RUNNING);
    let (engine, folder) = (b.engine.clone(), b.folder());
    b.turn(vec![Act::Spend(0.25), Act::Then(Box::new(move || engine.say(&folder, "swarm", "stop after this one").unwrap())), Act::Write(PROOF1, GOOD)]);
    b.turn(vec![Act::Think]);
    let h = b.start(b.req());
    std::thread::spawn({
        let (engine, folder, script) = (b.engine.clone(), b.folder(), b.script.clone());
        move || {
            while script.seen.lock().unwrap().len() < 2 {
                std::thread::sleep(Duration::from_millis(20));
            }
            engine.stop(&folder, "swarm");
        }
    });
    wait(h);
    let you = b.rec.events.lock().unwrap().iter().find(|e| e.kind == Kind::You).cloned().unwrap();
    assert_eq!((you.role.as_str(), you.text.as_str(), you.spent), ("you", "stop after this one", 0.25));
    // Answered before the review.
    assert_eq!(b.script.seen.lock().unwrap()[1].0, "assistant");
}

#[test]
fn b21_triage_reads_the_report() {
    let b = Bench::new("b21", &[]);
    b.dir.file("audit/report.md", "# H-01 Reentrancy\n");
    assert_eq!(b.engine.triage(&b.folder(), "audit/missing.md", None).unwrap_err(), "audit/missing.md isn't a file");
    b.dir.file("audit/report.docx", "x");
    assert_eq!(b.engine.triage(&b.folder(), "audit/report.docx", None).unwrap_err(), "Reports are PDF, Markdown or text files");
    b.engine.triage(&b.folder(), "audit/report.md", None).unwrap();
    b.turn(vec![]);
    b.run(SwarmRequest { only_queued: Some(true), ..b.req() });
    let seen = b.script.seen.lock().unwrap();
    assert_eq!((seen[0].0.as_str(), seen[0].1.as_str()), ("auditor", "report"));
    assert!(seen[0].2.starts_with("The audit report audit/report.md:\n\n# H-01 Reentrancy\n"));
    let texts: Vec<String> = b.said().into_iter().map(|e| e.3).collect();
    assert!(in_order(&texts, &["reading audit/report.md", "read audit/report.md: its findings are in Bugs", QUEUED_DONE]));
}

#[test]
fn b22_a_submitted_proof_is_reviewed() {
    let b = Bench::new("b22", &[(Mark::Open, ITEM1)]);
    b.dir.file(PROOF1, GOOD);
    assert!(b.engine.submit_proof(&b.folder(), "Vault.nope", PROOF1, None, None).unwrap_err().starts_with("No plan item names `Vault.nope`"));
    let r = b.engine.submit_proof(&b.folder(), "Vault.deposit", PROOF1, Some("by hand"), None).unwrap();
    assert_eq!((r["item"].clone(), r["queued"].clone()), (json!(1), json!("review")));
    b.turn(vec![verdict("approve", "ok")]);
    b.run(SwarmRequest { only_queued: Some(true), ..b.req() });
    assert_eq!(b.script.roles(), vec!["reviewer"]);
    assert!(b.script.seen.lock().unwrap()[0].2.contains("The prover says:\nWritten by an agent outside the app, through Formal Mind's MCP, in Proofs/Functions/VaultDeposit.lean.\n\nby hand"));
    assert_eq!(b.marks(), vec![Mark::Proved]);
}

// ---- regressions ----

#[test]
fn r4_a_message_on_a_finishing_run_is_answered_before_it_ends() {
    let b = Bench::new("r4", &[]);
    b.turn(vec![]).turn(vec![]);
    let (engine, folder) = (b.engine.clone(), b.folder());
    *b.engine.after_loop.lock().unwrap() = Some(Box::new(move || engine.say(&folder, "swarm", "one more thing").unwrap()));
    b.run(SwarmRequest { goal: Some("hi".into()), only_queued: Some(true), ..b.req() });
    assert_eq!(b.script.roles(), vec!["assistant", "assistant"]);
    assert_eq!(b.done(), vec![QUEUED_DONE], "one end, after the late message");
    assert!(b.jobs().iter().all(|j| j.state == State::Done));
    let kinds = b.rec.kinds();
    assert_eq!(kinds.last(), Some(&Kind::Done));
}

#[test]
fn r6_stop_during_a_long_tool_call_ends_the_turn() {
    let b = Bench::new("r6", &[(Mark::Open, ITEM1)]);
    b.turn(vec![Act::LongTool]);
    let h = b.start(b.req());
    let at = b.stop_soon("swarm");
    wait(h);
    assert!(Instant::now().duration_since(at.join().unwrap()) < Duration::from_secs(1));
    assert_eq!(b.jobs()[0].state, State::Running);
    assert_eq!(b.done(), vec![PAUSED]);
}

#[test]
fn r8_a_verdict_survives_a_quit() {
    // Stopped right after the verdict: the verdict counts.
    let b = Bench::new("r8a", &[(Mark::Open, ITEM1)]);
    seed(b.root(), vec![Job { files: vec![PROOF1.into()], ..job(JobKind::Review, 1, ITEM1, State::Queued) }]);
    b.turn(vec![verdict("approve", "ok"), Act::Think]);
    let h = b.start(b.req());
    b.stop_soon("swarm");
    wait(h);
    assert_eq!(b.marks(), vec![Mark::Proved]);
    assert_eq!(b.jobs()[0].result, "approve");
    // The app quit after the verdict was stored: the resumed job applies it without asking again.
    let b = Bench::new("r8b", &[(Mark::Open, ITEM1)]);
    seed(b.root(), vec![Job { verdict: Some(json!({ "decision": "approve", "notes": "ok" })), ..job(JobKind::Review, 1, ITEM1, State::Running) }]);
    b.run(b.req());
    assert!(b.script.roles().is_empty());
    assert_eq!(b.marks(), vec![Mark::Proved]);
    assert!(b.texts(Kind::Plan).contains(&"item 1 proven".to_string()));
}

#[test]
fn r9_a_stopped_turn_isnt_finished_though_it_said_something() {
    let b = Bench::new("r9", &[(Mark::Open, ITEM1)]);
    b.turn(vec![Act::Write(PROOF1, GOOD), property(), Act::Think]);
    let h = b.start(b.req());
    b.stop_soon("swarm");
    wait(h);
    let jobs = b.jobs();
    assert_eq!(jobs.len(), 1);
    assert_eq!((jobs[0].state, jobs[0].summary.as_str()), (State::Running, ""));
    assert!(b.world.commands.lock().unwrap().is_empty(), "no check of a stopped turn");
    assert_eq!(b.marks(), vec![Mark::Open]);
}

#[test]
fn b33_lapsed_ticks_are_reopened_at_plan_sync() {
    let b = Bench::new("b33", &[(Mark::Proved, ITEM1)]);
    *b.world.ledger.lock().unwrap() = json!({ "entries": [{ "lean": "Vault.deposit", "status": "unproved", "notYet": [crate::swarm2::ledger::LAPSED_CHANGED] }] });
    b.turn(vec![Act::Think]);
    let h = b.start(b.req());
    b.stop_soon("swarm");
    wait(h);
    assert!(b.texts(Kind::Result).contains(&format!("reopened `Vault.deposit`: {}", crate::swarm2::ledger::LAPSED_CHANGED)));
    assert_eq!(b.texts(Kind::Plan)[0], "1 proved items reopened: their code changed or Lean no longer checks them");
    assert_eq!(b.script.roles(), vec!["prover"]);
}

#[test]
fn b40_tools_that_dont_connect_are_retried_then_pause() {
    let b = Bench::new("b40", &[(Mark::Open, ITEM1)]);
    for _ in 0..3 {
        b.turn(vec![Act::Fail(TurnError::NoTools("failed".into()))]);
    }
    b.run(b.req());
    assert_eq!(b.script.roles().len(), 3);
    assert_eq!(b.done(), vec!["paused: the agent's tools didn't connect (failed)"]);
}

#[test]
fn the_prompts_are_swarm_rs_word_for_word() {
    let ours = include_str!("prompts.rs");
    let theirs = include_str!("../../swarm.rs");
    let body = ours.split_once("pub fn system(role: &str, folder: &str, goal: &str) -> String {").unwrap().1;
    assert!(theirs.contains(body.trim_end()), "prompts.rs's system() must equal swarm.rs::system");
}
