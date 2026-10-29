//! The durable queue (SPEC.md §2.2, B2–B4, B14, B36, R4, R11): `.formal/queue.json` (session `swarm`) or
//! `.formal/queues/<run>.json`, each job's API transcript under `.formal/jobs/`, item claims between sessions of one
//! app, and `.formal/run.lock` between apps.
//!
//! Every unit of work is a job, marked running before its agent starts and done when it ends; the file is rewritten
//! after each change, so a quit resumes the running job and never loses a queued message. A missing or corrupt file
//! reads as an empty queue, and fields this build doesn't know are kept.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The folder's default session.
pub const DEFAULT_SESSION: &str = "swarm";

/// B2: a session id is ASCII alphanumerics and `-`; anything else, or nothing, is the default session.
pub fn session_id(raw: Option<&str>) -> String {
    match raw {
        Some(s) if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => s.to_string(),
        _ => DEFAULT_SESSION.to_string(),
    }
}

/// A running session's key: the same session id exists in every folder.
pub fn session_key(folder: &str, session: &str) -> String {
    format!("{folder}\n{session}")
}

/// What a job is for. Kinds this build doesn't know are kept as written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub enum Kind {
    Plan,
    Prove,
    Review,
    Answer,
    Formalize,
    Triage,
    Other(String),
}

impl From<String> for Kind {
    fn from(s: String) -> Kind {
        match s.as_str() {
            "plan" => Kind::Plan,
            "prove" => Kind::Prove,
            "review" => Kind::Review,
            "answer" => Kind::Answer,
            "formalize" => Kind::Formalize,
            "triage" => Kind::Triage,
            _ => Kind::Other(s),
        }
    }
}

impl From<Kind> for String {
    fn from(k: Kind) -> String {
        match k {
            Kind::Plan => "plan".into(),
            Kind::Prove => "prove".into(),
            Kind::Review => "review".into(),
            Kind::Answer => "answer".into(),
            Kind::Formalize => "formalize".into(),
            Kind::Triage => "triage".into(),
            Kind::Other(s) => s,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    #[default]
    Queued,
    Running,
    Done,
}

/// One job, as stored. `result` is `approve`, `changes`, `bug` or empty.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Job {
    pub id: u64,
    pub kind: Kind,
    /// The plan item (or a statement's obligation number).
    #[serde(default)]
    pub item: usize,
    /// The plan item's text, or the maintainer's message, or a report's path.
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub state: State,
    #[serde(default)]
    pub attempt: usize,
    /// The reviewer's or the check's notes for a retry, or the prover's summary for a review.
    #[serde(default)]
    pub notes: String,
    /// Files written for this job, recorded as they are written (B29).
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub result: String,
    /// The prover's property notes for the report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub property: Option<Value>,
    /// The `verdict` tool's input, stored the moment it is called (R8).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<Value>,
    /// For a statement obligation: the statement's id (`S-01`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub statement: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Kind {
    fn default() -> Kind {
        Kind::Answer
    }
}

impl Job {
    /// Prove and review jobs on a plan item are claimed; statement obligations and other kinds aren't (B4).
    pub fn claims_item(&self) -> bool {
        matches!(self.kind, Kind::Prove | Kind::Review) && self.statement.is_empty()
    }
}

/// A job to add: the fields the caller chooses; the rest start empty.
#[derive(Clone, Debug, Default)]
pub struct NewJob {
    pub kind: Option<Kind>,
    pub item: usize,
    pub text: String,
    pub attempt: usize,
    pub notes: String,
    pub files: Vec<String>,
    pub property: Option<Value>,
    pub statement: String,
}

impl NewJob {
    pub fn new(kind: Kind) -> NewJob {
        NewJob { kind: Some(kind), ..Default::default() }
    }

    /// A maintainer's message (`swarm_say`, a start's goal).
    pub fn answer(text: &str) -> NewJob {
        NewJob { text: text.into(), ..NewJob::new(Kind::Answer) }
    }
}

/// A session's queue file: `{next_id, jobs, spent}`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Queue {
    #[serde(default)]
    pub next_id: u64,
    #[serde(default)]
    pub jobs: Vec<Job>,
    /// Dollars this session has spent, across every start.
    #[serde(default)]
    pub spent: f64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One writer at a time for every queue file in this app (the loop and `swarm_say` both touch them).
static QUEUE_LOCK: Mutex<()> = Mutex::new(());

pub fn queue_path(root: &Path, session: &str) -> PathBuf {
    let formal = root.join(".formal");
    if session == DEFAULT_SESSION { formal.join("queue.json") } else { formal.join("queues").join(format!("{session}.json")) }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Writes `bytes` to `path` through `<path>.tmp` and a rename, so a quit never leaves half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

impl Queue {
    /// The queue at `path`; missing or corrupt reads as empty, never an error.
    pub fn load(path: &Path) -> Queue {
        std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    /// Pretty JSON via `.json.tmp` + rename.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        write_atomic(path, serde_json::to_string_pretty(self).unwrap_or_default().as_bytes())
    }

    /// Loads, changes and saves the queue at `path` under the app's queue lock; returns what `f` returns.
    pub fn update<T>(path: &Path, f: impl FnOnce(&mut Queue) -> T) -> std::io::Result<T> {
        let _guard = QUEUE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut q = Queue::load(path);
        let out = f(&mut q);
        q.save(path)?;
        Ok(out)
    }

    /// Adds a queued job and returns its id. A new queue numbers from the current Unix seconds, not 1, so a job never
    /// reuses an id a deleted `.formal/` once had (R11: CLI conversations are kept by job id outside the folder).
    pub fn enqueue(&mut self, new: NewJob) -> u64 {
        if self.next_id == 0 {
            self.next_id = now_secs();
        }
        self.next_id += 1;
        let id = self.next_id;
        self.jobs.push(Job {
            id,
            kind: new.kind.unwrap_or_default(),
            item: new.item,
            text: new.text,
            attempt: new.attempt,
            notes: new.notes,
            files: new.files,
            property: new.property,
            statement: new.statement,
            ..Default::default()
        });
        id
    }

    pub fn job(&self, id: u64) -> Option<&Job> {
        self.jobs.iter().find(|j| j.id == id)
    }

    pub fn job_mut(&mut self, id: u64) -> Option<&mut Job> {
        self.jobs.iter_mut().find(|j| j.id == id)
    }

    /// Marks a job running, before its agent starts (B14).
    pub fn start(&mut self, id: u64) -> bool {
        self.job_mut(id).map(|j| j.state = State::Running).is_some()
    }

    /// Marks a job done with its result (`approve`, `changes`, `bug` or empty) and the agent's summary.
    pub fn finish(&mut self, id: u64, result: &str, summary: &str) -> bool {
        self.job_mut(id)
            .map(|j| {
                j.state = State::Done;
                j.result = result.into();
                j.summary = summary.into();
            })
            .is_some()
    }

    /// Records a file written for the job, once (B29).
    pub fn record_file(&mut self, id: u64, file: &str) -> bool {
        self.job_mut(id)
            .map(|j| {
                if !j.files.iter().any(|f| f == file) {
                    j.files.push(file.into());
                }
            })
            .is_some()
    }

    /// Stores the `verdict` tool's input on the job (R8).
    pub fn record_verdict(&mut self, id: u64, verdict: Value) -> bool {
        self.job_mut(id).map(|j| j.verdict = Some(verdict)).is_some()
    }

    /// A maintainer's message is waiting (R4: a run that was about to end runs again instead).
    pub fn answer_waiting(&self) -> bool {
        self.jobs.iter().any(|j| j.kind == Kind::Answer && j.state == State::Queued)
    }

    /// The attempt number for a new `prove` job on `item`: the prove jobs it already had, plus one (B14).
    pub fn next_attempt(&self, item: usize) -> usize {
        self.jobs.iter().filter(|j| j.kind == Kind::Prove && j.item == item && j.statement.is_empty()).count() + 1
    }

    /// The first three steps of B14's order, from the queue alone: a running job (resumed) → the oldest queued
    /// `answer` → the oldest queued job. `taken(item)` says another session claims that plan item; claimed jobs are
    /// skipped. None means the loop goes on to statements, the plan, and a `plan` job.
    pub fn pick(&self, taken: impl Fn(usize) -> bool) -> Option<&Job> {
        let free = |j: &&Job| !j.claims_item() || !taken(j.item);
        let queued = |j: &&Job| j.state == State::Queued;
        self.jobs
            .iter()
            .filter(|j| j.state == State::Running)
            .find(free)
            .or_else(|| self.jobs.iter().filter(queued).find(|j| j.kind == Kind::Answer))
            .or_else(|| self.jobs.iter().filter(queued).find(free))
    }

    /// Jobs not done yet, oldest first.
    pub fn open(&self) -> impl Iterator<Item = &Job> {
        self.jobs.iter().filter(|j| j.state != State::Done)
    }
}

// ---- transcripts (B36) ----

/// A job's API conversation. The default session's are `.formal/jobs/<id>.json`; another session's are under its
/// name, so its jobs never resume the default session's conversations (R11).
pub fn transcript_path(root: &Path, session: &str, job: u64) -> PathBuf {
    let dir = root.join(".formal").join("jobs");
    if session == DEFAULT_SESSION { dir.join(format!("{job}.json")) } else { dir.join(session).join(format!("{job}.json")) }
}

/// The Messages array as sent and received (thinking blocks included), or None when there is none or it can't be read.
pub fn load_transcript(root: &Path, session: &str, job: u64) -> Option<Vec<Value>> {
    std::fs::read_to_string(transcript_path(root, session, job)).ok().and_then(|t| serde_json::from_str(&t).ok())
}

/// Saved after every step.
pub fn save_transcript(root: &Path, session: &str, job: u64, messages: &[Value]) -> std::io::Result<()> {
    write_atomic(&transcript_path(root, session, job), serde_json::to_string(messages).unwrap_or_default().as_bytes())
}

/// The line added to a resumed conversation.
pub const RESUMED: &str = "The app quit and this job is being resumed. Carry on from where you were; don't redo finished work.";

/// A saved conversation made ready to continue (B36): a trailing assistant message (tool calls whose results never
/// came) is dropped, and a user line says the job is being resumed. A conversation ending on a user turn gets the line
/// as a text block on that turn, so roles keep alternating.
pub fn resume_transcript(mut messages: Vec<Value>) -> Vec<Value> {
    if messages.last().is_some_and(|m| m["role"] == "assistant") {
        messages.pop();
    }
    match messages.last_mut() {
        Some(last) if last["role"] == "user" => {
            let text = json!({ "type": "text", "text": RESUMED });
            match &mut last["content"] {
                Value::Array(blocks) => blocks.push(text),
                Value::String(s) => last["content"] = json!([{ "type": "text", "text": s.clone() }, text]),
                _ => last["content"] = json!([text]),
            }
        }
        _ => messages.push(json!({ "role": "user", "content": RESUMED })),
    }
    messages
}

// ---- claims between sessions of one app (B4) ----

/// The plan items sessions are working on, by folder. A session holds one claim at a time.
#[derive(Default)]
pub struct Claims(Mutex<Vec<(String, usize, String)>>);

impl Claims {
    pub const fn new() -> Claims {
        Claims(Mutex::new(Vec::new()))
    }

    /// `session` (a [`session_key`]) takes `item` in `folder`, giving up any item it held.
    pub fn claim(&self, folder: &str, item: usize, session: &str) {
        let mut c = self.0.lock().unwrap_or_else(|e| e.into_inner());
        c.retain(|(_, _, s)| s != session);
        c.push((folder.into(), item, session.into()));
    }

    /// Another session in `folder` holds `item`.
    pub fn taken_by_other(&self, folder: &str, item: usize, session: &str) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|(f, i, s)| f == folder && *i == item && s != session)
    }

    /// The session ended: its claim goes.
    pub fn release(&self, session: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).retain(|(_, _, s)| s != session);
    }
}

// ---- one app per folder (B3) ----

pub fn lock_path(root: &Path) -> PathBuf {
    root.join(".formal").join("run.lock")
}

/// Whether a process with this id is running (a crashed app's lock is stale).
pub fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    return std::process::Command::new("kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success());
    #[cfg(not(unix))]
    return std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()));
}

fn holder(root: &Path) -> Option<u32> {
    std::fs::read_to_string(lock_path(root)).ok().and_then(|t| t.trim().parse().ok())
}

/// Takes the folder for this app: refused while another live app holds it; a dead one's lock is taken over.
pub fn lock_folder(root: &Path) -> Result<(), String> {
    let me = std::process::id();
    if let Some(pid) = holder(root).filter(|p| *p != me && alive(*p)) {
        return Err(format!("Another Formal Mind (process {pid}) is running this folder's swarm; pause it there first"));
    }
    let _ = std::fs::create_dir_all(root.join(".formal"));
    std::fs::write(lock_path(root), me.to_string()).map_err(|e| format!(".formal/run.lock: {e}"))
}

/// Gives the folder back (call when this app's last session in it ends); another app's lock is left alone.
pub fn unlock_folder(root: &Path) {
    if holder(root) == Some(std::process::id()) {
        let _ = std::fs::remove_file(lock_path(root));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("fm2-queue-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".formal")).unwrap();
        root
    }

    #[test]
    fn b2_session_ids() {
        assert_eq!(session_id(Some("s-1")), "s-1");
        for bad in [None, Some(""), Some("../x"), Some("a b"), Some("é")] {
            assert_eq!(session_id(bad), "swarm");
        }
        let root = Path::new("/f");
        assert_eq!(queue_path(root, "swarm"), root.join(".formal/queue.json"));
        assert_eq!(queue_path(root, "s-1"), root.join(".formal/queues/s-1.json"));
        assert_ne!(session_key("/a", "swarm"), session_key("/b", "swarm"));
    }

    #[test]
    fn one_app_per_folder() {
        let root = folder("lock");
        // Ours: taken again freely, given back.
        assert!(lock_folder(&root).is_ok());
        assert!(lock_folder(&root).is_ok());
        unlock_folder(&root);
        assert!(!lock_path(&root).exists());
        // A live other app (this test's parent process) holds it: refused, and not given back by us.
        let parent = std::os::unix::process::parent_id();
        std::fs::write(lock_path(&root), parent.to_string()).unwrap();
        let err = lock_folder(&root).unwrap_err();
        assert_eq!(err, format!("Another Formal Mind (process {parent}) is running this folder's swarm; pause it there first"));
        unlock_folder(&root);
        assert!(lock_path(&root).exists());
        // A dead one's lock is stale.
        std::fs::write(lock_path(&root), "4000000").unwrap();
        assert!(lock_folder(&root).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn b4_a_claimed_item_is_left_to_its_session() {
        let claims = Claims::new();
        let (a, b) = (session_key("/f", "swarm"), session_key("/f", "s-1"));
        claims.claim("/f", 7, &a);
        assert!(claims.taken_by_other("/f", 7, &b));
        assert!(!claims.taken_by_other("/f", 7, &a));
        assert!(!claims.taken_by_other("/other", 7, &b));
        claims.claim("/f", 8, &a);
        assert!(!claims.taken_by_other("/f", 7, &b), "a session holds one item at a time");
        claims.release(&a);
        assert!(!claims.taken_by_other("/f", 8, &b));
    }

    #[test]
    fn queue_and_transcripts_survive_a_restart() {
        let root = folder("restart");
        let qf = queue_path(&root, "swarm");
        let id = Queue::update(&qf, |q| {
            let id = q.enqueue(NewJob { item: 3, text: "item three".into(), attempt: 1, ..NewJob::new(Kind::Prove) });
            q.start(id);
            q.record_file(id, "formal/Proofs/A.lean");
            q.record_file(id, "formal/Proofs/A.lean");
            q.record_verdict(id, json!({ "approve": true, "notes": "ok" }));
            q.spent = 1.25;
            id
        })
        .unwrap();
        // Reloaded from disk, as after a quit: the job still running, its files, verdict and the spend kept.
        let q = Queue::load(&qf);
        let j = q.job(id).unwrap();
        assert_eq!((j.state, j.id, q.spent), (State::Running, id, 1.25));
        assert_eq!(j.files, vec!["formal/Proofs/A.lean"]);
        assert_eq!(j.verdict.as_ref().unwrap()["approve"], true);
        assert_eq!(q.pick(|_| false).map(|j| j.id), Some(id), "the running job is resumed");
        assert!(!root.join(".formal/queue.json.tmp").exists());

        save_transcript(&root, "swarm", id, &[json!({"role": "user", "content": "go"}), json!({"role": "assistant", "content": [{"type": "tool_use"}]})]).unwrap();
        assert_eq!(load_transcript(&root, "swarm", id).unwrap().len(), 2);
        // Another session's job with the same id is its own conversation.
        assert!(load_transcript(&root, "s-1", id).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn b36_a_resumed_transcript_drops_unanswered_calls() {
        let m = vec![
            json!({ "role": "user", "content": "go" }),
            json!({ "role": "assistant", "content": [{ "type": "tool_use", "id": "t1" }] }),
            json!({ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1" }] }),
            json!({ "role": "assistant", "content": [{ "type": "tool_use", "id": "t2" }] }),
        ];
        let out = resume_transcript(m);
        assert_eq!(out.len(), 3);
        let last = &out[2]["content"];
        assert_eq!(last[0]["type"], "tool_result");
        assert_eq!(last[1]["text"], RESUMED);
        // Ending on an assistant reply after a plain task: the task gets the line.
        let out = resume_transcript(vec![json!({ "role": "user", "content": "go" }), json!({ "role": "assistant", "content": "…" })]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["content"][1]["text"], RESUMED);
        assert_eq!(resume_transcript(vec![])[0]["content"], RESUMED);
    }

    #[test]
    fn b14_job_order() {
        let mut q = Queue::default();
        let prove7 = q.enqueue(NewJob { item: 7, ..NewJob::new(Kind::Prove) });
        let review8 = q.enqueue(NewJob { item: 8, ..NewJob::new(Kind::Review) });
        let answer = q.enqueue(NewJob::answer("hi"));
        // The oldest queued answer comes before older work.
        assert_eq!(q.pick(|_| false).unwrap().id, answer);
        q.finish(answer, "", "said hi");
        assert_eq!(q.pick(|_| false).unwrap().id, prove7);
        // Claimed elsewhere: skipped, queued or running.
        assert_eq!(q.pick(|i| i == 7).unwrap().id, review8);
        q.start(review8);
        assert_eq!(q.pick(|_| false).unwrap().id, review8, "a running job first");
        assert_eq!(q.pick(|i| i == 8).unwrap().id, prove7);
        // Statement obligations aren't claimed.
        let ob = q.enqueue(NewJob { item: 7, statement: "S-01".into(), ..NewJob::new(Kind::Prove) });
        q.finish(prove7, "changes", "");
        assert_eq!(q.pick(|i| i == 7 || i == 8).unwrap().id, ob);
        assert_eq!(q.next_attempt(7), 2, "statement obligations don't count as the item's attempts");
        q.finish(ob, "", "");
        q.finish(review8, "approve", "");
        assert!(q.pick(|_| false).is_none());
    }

    #[test]
    fn r4_a_message_on_a_finishing_run_is_queued_work() {
        let root = folder("late");
        let qf = queue_path(&root, "s-1");
        // The loop has finished its last job and is about to end…
        let plan = Queue::update(&qf, |q| q.enqueue(NewJob::new(Kind::Plan))).unwrap();
        Queue::update(&qf, |q| q.finish(plan, "", "")).unwrap();
        assert!(!Queue::load(&qf).answer_waiting());
        // …when a message lands: it is on disk, and the session runs again to answer it.
        let id = Queue::update(&qf, |q| q.enqueue(NewJob::answer("one more thing"))).unwrap();
        let q = Queue::load(&qf);
        assert!(q.answer_waiting());
        assert_eq!(q.pick(|_| false).map(|j| (j.id, j.text.as_str())), Some((id, "one more thing")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn r11_job_ids_dont_collide_after_formal_is_deleted() {
        let root = folder("ids");
        let qf = queue_path(&root, "swarm");
        let before = now_secs();
        let first = Queue::update(&qf, |q| q.enqueue(NewJob::answer("a"))).unwrap();
        assert!(first > before, "seeded from the clock, not 1");
        std::fs::remove_dir_all(root.join(".formal")).unwrap();
        let again = Queue::update(&qf, |q| q.enqueue(NewJob::answer("b"))).unwrap();
        assert!(again >= first);
        assert_ne!(transcript_path(&root, "swarm", 5), transcript_path(&root, "s-1", 5));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_or_corrupt_queue_reads_as_empty() {
        let root = folder("corrupt");
        let qf = queue_path(&root, "swarm");
        assert_eq!(Queue::load(&qf), Queue::default());
        std::fs::write(&qf, "{ not json").unwrap();
        assert_eq!(Queue::load(&qf), Queue::default());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_fields_and_kinds_are_kept() {
        let root = folder("unknown");
        let qf = queue_path(&root, "swarm");
        std::fs::write(&qf, r#"{"next_id": 9, "spent": 0.5, "owner": "x", "jobs": [{"id": 9, "kind": "build", "state": "queued", "color": "red"}]}"#).unwrap();
        Queue::update(&qf, |q| q.enqueue(NewJob::answer("hi"))).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&qf).unwrap()).unwrap();
        assert_eq!((v["owner"].as_str(), v["jobs"][0]["kind"].as_str(), v["jobs"][0]["color"].as_str()), (Some("x"), Some("build"), Some("red")));
        assert_eq!((v["jobs"][1]["id"].as_u64(), v["jobs"][1]["state"].as_str()), (Some(10), Some("queued")));
        std::fs::remove_dir_all(root).unwrap();
    }
}
