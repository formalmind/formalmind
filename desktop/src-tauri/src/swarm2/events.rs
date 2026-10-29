//! What a session tells the app, and what it leaves behind (SPEC.md §1.2, B44–B47): the `swarm` event and
//! `swarm-running`, the session's log `.formal/runs/<run>.jsonl`, its history as the chat reads it, the session list,
//! names, and the legacy `local-*` logs folded into the one session.
//!
//! Emitting goes through [`Emitter`], so tests capture events without Tauri ([`Recorder`]).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The `swarm` event's `kind`. The UI switches on these twelve names; keep them exactly.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Start,
    Status,
    Say,
    Tool,
    Result,
    You,
    Bug,
    Plan,
    Done,
    Error,
    /// `text` is a JSON string `{used, window, compact_at, system, tools, task, estimated?}`.
    Context,
    Ask,
}

impl Kind {
    pub const ALL: [Kind; 12] = [
        Kind::Start,
        Kind::Status,
        Kind::Say,
        Kind::Tool,
        Kind::Result,
        Kind::You,
        Kind::Bug,
        Kind::Plan,
        Kind::Done,
        Kind::Error,
        Kind::Context,
        Kind::Ask,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Start => "start",
            Kind::Status => "status",
            Kind::Say => "say",
            Kind::Tool => "tool",
            Kind::Result => "result",
            Kind::You => "you",
            Kind::Bug => "bug",
            Kind::Plan => "plan",
            Kind::Done => "done",
            Kind::Error => "error",
            Kind::Context => "context",
            Kind::Ask => "ask",
        }
    }

    /// Tool steps, results, statuses and context counts: the kinds a long history drops first (B45).
    pub fn is_step(self) -> bool {
        matches!(self, Kind::Tool | Kind::Result | Kind::Status | Kind::Context)
    }
}

/// The `swarm` event, and one line of `.formal/runs/<run>.jsonl`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SwarmEvent {
    /// The folder it runs in: sessions in other folders send events too.
    pub folder: String,
    pub run: String,
    pub kind: Kind,
    /// `swarm`, `planner`, `prover`, `reviewer`, `assistant`, `auditor` or `you`.
    pub role: String,
    /// A plan item number, `S-01.2` for a statement obligation, `plan`, `report`, `you`, a statement id, or empty.
    pub item: String,
    pub text: String,
    /// The session's spend so far, in dollars.
    pub spent: f64,
    /// When it happened (ms since the epoch): the chat times each tool step from its call to its result.
    pub at: u64,
}

impl SwarmEvent {
    /// An event stamped now.
    pub fn new(folder: &str, run: &str, kind: Kind, role: &str, item: &str, text: impl Into<String>, spent: f64) -> Self {
        SwarmEvent {
            folder: folder.into(),
            run: run.into(),
            kind,
            role: role.into(),
            item: item.into(),
            text: text.into(),
            spent,
            at: now_ms(),
        }
    }
}

/// The `swarm-running` payload: every folder with a running session, and those sessions' ids.
pub type Running = BTreeMap<String, Vec<String>>;

/// Builds `swarm-running` from the running sessions' keys, `folder\nrun`.
pub fn running<'a>(keys: impl IntoIterator<Item = &'a str>) -> Running {
    let mut by_folder = Running::new();
    for k in keys {
        if let Some((folder, run)) = k.split_once('\n') {
            by_folder.entry(folder.to_string()).or_default().push(run.to_string());
        }
    }
    by_folder.values_mut().for_each(|runs| runs.sort());
    by_folder
}

/// Where events go: the app's windows (Tauri), or a [`Recorder`] in tests.
pub trait Emitter: Send + Sync {
    fn swarm(&self, ev: &SwarmEvent);
    fn running(&self, running: &Running);
}

impl<R: tauri::Runtime> Emitter for tauri::AppHandle<R> {
    fn swarm(&self, ev: &SwarmEvent) {
        use tauri::Emitter as _;
        let _ = self.emit("swarm", ev);
    }

    fn running(&self, running: &Running) {
        use tauri::Emitter as _;
        let _ = self.emit("swarm-running", running);
    }
}

/// Keeps what was emitted, for tests.
#[derive(Default)]
pub struct Recorder {
    pub events: Mutex<Vec<SwarmEvent>>,
    pub running: Mutex<Vec<Running>>,
}

impl Recorder {
    pub fn kinds(&self) -> Vec<Kind> {
        self.events.lock().unwrap().iter().map(|e| e.kind).collect()
    }
}

impl Emitter for Recorder {
    fn swarm(&self, ev: &SwarmEvent) {
        self.events.lock().unwrap().push(ev.clone());
    }

    fn running(&self, running: &Running) {
        self.running.lock().unwrap().push(running.clone());
    }
}

/// B44: logs the event to its session's jsonl, then sends it to the app.
pub fn emit(to: &impl Emitter, ev: SwarmEvent) {
    log(&ev);
    to.swarm(&ev);
}

/// Appends one line to `.formal/runs/<run>.jsonl` without emitting (a quit records its pause this way).
pub fn log(ev: &SwarmEvent) {
    let dir = runs_dir(Path::new(&ev.folder));
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(line) = serde_json::to_string(ev) {
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(format!("{}.jsonl", ev.run)))
            .and_then(|mut f| writeln!(f, "{line}"));
    }
}

pub fn runs_dir(folder: &Path) -> PathBuf {
    folder.join(".formal").join("runs")
}

/// A session id: ASCII alphanumerics and `-`, not empty (B2).
pub fn valid_run(run: &str) -> bool {
    !run.is_empty() && run.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// The tool steps (and statuses, context counts) a history keeps: the newest ones. Messages are all kept.
pub const HISTORY_STEPS: usize = 600;
/// How much of one event's text the chat is sent (a tool's output can be megabytes; the chat shows its start).
pub const HISTORY_TEXT: usize = 8_000;

/// B45: one session's events, oldest first, as `swarm_history` returns them.
pub fn history(folder: &Path, run: &str) -> Result<Vec<Value>, String> {
    if !valid_run(run) {
        return Err("Bad session id".into());
    }
    let text = std::fs::read_to_string(runs_dir(folder).join(format!("{run}.jsonl"))).map_err(|e| e.to_string())?;
    Ok(history_of(&text))
}

/// B45: every message, the newest [`HISTORY_STEPS`] steps, in order, each text cut to [`HISTORY_TEXT`] bytes plus
/// `\n…`. Lines are kept as JSON values, so fields a later version adds pass through.
pub fn history_of(log: &str) -> Vec<Value> {
    let is_step = |v: &Value| v["kind"].as_str().is_some_and(|k| matches!(k, "tool" | "result" | "status" | "context"));
    let mut steps = 0;
    let mut out: Vec<Value> = log
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| {
            if !is_step(v) {
                return true;
            }
            steps += 1;
            steps <= HISTORY_STEPS
        })
        .map(|mut v| {
            if let Some(t) = v["text"].as_str().filter(|t| t.len() > HISTORY_TEXT) {
                v["text"] = json!(format!("{}\n…", cut_bytes(t, HISTORY_TEXT)));
            }
            v
        })
        .collect();
    out.reverse();
    out
}

/// The longest start of `s` that fits in `max` bytes without splitting a character.
fn cut_bytes(s: &str, max: usize) -> &str {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// One past session, as `swarm_sessions` lists it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Session {
    pub run: String,
    /// Its name (B47).
    pub title: String,
    /// The last line's text when it is `done`, else "".
    pub outcome: String,
    /// The last line's spend.
    pub spent: f64,
    pub events: usize,
    /// The log's mtime (ms since the epoch).
    pub at: u64,
}

/// B47: the sessions in a folder (`.formal/runs/*.jsonl`), newest first.
pub fn sessions(folder: &Path) -> Vec<Session> {
    let Ok(dir) = std::fs::read_dir(runs_dir(folder)) else { return Vec::new() };
    let mut out: Vec<Session> = dir.flatten().filter_map(|e| session_of(&e.path())).collect();
    // Ties by id, newest-looking first, so the latest chat is the one that opens.
    out.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.run.cmp(&a.run)));
    out
}

fn session_of(path: &Path) -> Option<Session> {
    let run = path.file_name()?.to_str()?.strip_suffix(".jsonl")?.to_string();
    let log = std::fs::read_to_string(path).ok()?;
    let lines: Vec<Value> = log.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let last = log.lines().last().and_then(|l| serde_json::from_str::<Value>(l).ok()).unwrap_or(json!({}));
    let given = std::fs::read_to_string(path.with_extension("title")).ok().map(|t| t.trim().to_string());
    let at = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Some(Session {
        run,
        title: title_of(given.as_deref(), &lines),
        outcome: if last["kind"] == "done" { last["text"].as_str().unwrap_or("").to_string() } else { String::new() },
        spent: last["spent"].as_f64().unwrap_or(0.0),
        events: log.lines().count(),
        at,
    })
}

/// B47: a chat's name: the one you gave it, else the first non-empty `start` text, else your first message, short.
pub fn title_of(given: Option<&str>, events: &[Value]) -> String {
    let first = |kind: &str| {
        events
            .iter()
            .find(|e| e["kind"] == kind && e["text"].as_str().is_some_and(|t| !t.trim().is_empty()))
            .and_then(|e| e["text"].as_str())
    };
    given
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(String::from)
        .or_else(|| first("start").map(String::from))
        .or_else(|| first("you").map(short_name))
        .unwrap_or_default()
}

/// A chat's name from a message: its first line, cut at a word to at most 60 characters, with `…`.
pub fn short_name(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or("").trim();
    if line.chars().count() <= 60 {
        return line.to_string();
    }
    let cut: String = line.chars().take(60).collect();
    let word = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    format!("{}…", word.trim_end_matches([',', '.', ';', ':']))
}

/// `swarm_rename`: names a session (`<run>.title` beside its log), at most 120 characters, control characters
/// dropped; an empty name goes back to the default.
pub fn rename(folder: &Path, run: &str, title: &str) -> Result<(), String> {
    if !valid_run(run) {
        return Err("Bad session id".into());
    }
    let path = runs_dir(folder).join(format!("{run}.title"));
    let title: String = title.trim().chars().filter(|c| !c.is_control()).take(120).collect();
    if title.is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    std::fs::create_dir_all(runs_dir(folder)).map_err(|e| e.to_string())?;
    std::fs::write(path, title).map_err(|e| e.to_string())
}

/// B46: earlier versions kept one log per start (`runs/local-*.jsonl`). Appends them, in name order, to
/// `runs/swarm.jsonl` re-stamped `run: "swarm"`, moves them to `runs/archive/`, and returns the sum of their last
/// `spent` values for the caller to add to the default queue's spend.
pub fn merge_old_sessions(folder: &Path) -> f64 {
    let dir = runs_dir(folder);
    let mut old: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|it| {
            it.flatten()
                .map(|e| e.path())
                .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("local-") && n.ends_with(".jsonl")))
                .collect()
        })
        .unwrap_or_default();
    if old.is_empty() {
        return 0.0;
    }
    old.sort();
    let mut merged = std::fs::read_to_string(dir.join("swarm.jsonl")).unwrap_or_default();
    let mut carried = 0.0;
    let archive = dir.join("archive");
    let _ = std::fs::create_dir_all(&archive);
    for path in &old {
        let log = std::fs::read_to_string(path).unwrap_or_default();
        carried += log.lines().last().and_then(|l| serde_json::from_str::<Value>(l).ok()).and_then(|v| v["spent"].as_f64()).unwrap_or(0.0);
        for mut v in log.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
            v["run"] = json!("swarm");
            merged.push_str(&v.to_string());
            merged.push('\n');
        }
        let _ = std::fs::rename(path, archive.join(path.file_name().unwrap_or_default()));
    }
    let _ = std::fs::write(dir.join("swarm.jsonl"), merged);
    carried
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("fm-events-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn line(kind: &str, text: &str) -> String {
        json!({"folder": "/f", "run": "s-1", "kind": kind, "role": "swarm", "item": "", "text": text, "spent": 0.0, "at": 1})
            .to_string()
    }

    #[test]
    fn payload_matches_spec_1_2() {
        let ev = SwarmEvent {
            folder: "/f".into(),
            run: "s-1".into(),
            kind: Kind::Say,
            role: "prover".into(),
            item: "3".into(),
            text: "hi".into(),
            spent: 1.5,
            at: 42,
        };
        let v = serde_json::to_value(&ev).unwrap();
        let fields: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        let mut want = vec!["folder", "run", "kind", "role", "item", "text", "spent", "at"];
        let mut got = fields.clone();
        got.sort();
        want.sort();
        assert_eq!(got, want);
        assert_eq!(v, json!({"folder": "/f", "run": "s-1", "kind": "say", "role": "prover", "item": "3", "text": "hi", "spent": 1.5, "at": 42}));
        assert!(v["spent"].is_f64() && v["at"].is_u64());
        // The twelve kinds, by name, in SPEC order; and they read back.
        let names: Vec<String> = Kind::ALL.iter().map(|k| serde_json::to_value(k).unwrap().as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["start", "status", "say", "tool", "result", "you", "bug", "plan", "done", "error", "context", "ask"]);
        for k in Kind::ALL {
            assert_eq!(k.as_str(), serde_json::to_value(k).unwrap());
            assert_eq!(serde_json::from_value::<Kind>(json!(k.as_str())).unwrap(), k);
        }
    }

    #[test]
    fn swarm_running_lists_sessions_by_folder() {
        let r = running(["/a\nswarm", "/b\ns-2", "/a\ns-1", "no-newline"]);
        assert_eq!(serde_json::to_value(&r).unwrap(), json!({"/a": ["s-1", "swarm"], "/b": ["s-2"]}));
        let rec = Recorder::default();
        rec.running(&r);
        rec.running(&running([]));
        assert_eq!(serde_json::to_value(&rec.running.lock().unwrap()[1]).unwrap(), json!({}));
    }

    #[test]
    fn b44_events_are_logged_before_they_are_emitted() {
        let root = temp("b44");
        let folder = root.to_string_lossy().to_string();
        // The emitter checks the line is already on disk when it is handed the event.
        struct Checks(Recorder);
        impl Emitter for Checks {
            fn swarm(&self, ev: &SwarmEvent) {
                let log = std::fs::read_to_string(runs_dir(Path::new(&ev.folder)).join(format!("{}.jsonl", ev.run))).unwrap();
                assert_eq!(serde_json::from_str::<SwarmEvent>(log.lines().last().unwrap()).unwrap(), *ev);
                self.0.swarm(ev);
            }
            fn running(&self, r: &Running) {
                self.0.running(r);
            }
        }
        let to = Checks(Recorder::default());
        emit(&to, SwarmEvent::new(&folder, "s-1", Kind::Start, "swarm", "", "prove Vault", 0.0));
        emit(&to, SwarmEvent::new(&folder, "s-1", Kind::Tool, "prover", "1", "lake build", 0.25));
        emit(&to, SwarmEvent::new(&folder, "swarm", Kind::Done, "swarm", "", "done", 0.0));
        assert_eq!(to.0.kinds(), [Kind::Start, Kind::Tool, Kind::Done]);
        let s1 = std::fs::read_to_string(runs_dir(&root).join("s-1.jsonl")).unwrap();
        assert_eq!(s1.lines().count(), 2);
        assert!(runs_dir(&root).join("swarm.jsonl").exists());
        // `log` alone writes without emitting.
        log(&SwarmEvent::new(&folder, "s-1", Kind::Done, "swarm", "", "paused", 0.25));
        assert_eq!(to.0.events.lock().unwrap().len(), 3);
        assert_eq!(history(&root, "s-1").unwrap().len(), 3);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn long_histories_are_cut() {
        // B45: 700 steps of each noisy kind between messages; all messages stay, the newest 600 steps stay, in order.
        let mut log = vec![line("start", "go"), line("you", "first")];
        for i in 0..700 {
            log.push(line(["tool", "result", "status", "context"][i % 4], &format!("step {i}")));
        }
        log.push(line("say", "middle"));
        log.push("not json".into());
        log.push(line("bug", &"x".repeat(9_000)));
        log.push(line("tool", &"é".repeat(5_000)));
        log.push(line("ask", "last"));
        let h = history_of(&log.join("\n"));
        let kinds: Vec<&str> = h.iter().map(|v| v["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds.iter().filter(|k| matches!(**k, "tool" | "result" | "status" | "context")).count(), HISTORY_STEPS);
        assert_eq!(&kinds[..2], ["start", "you"]);
        assert_eq!(&kinds[kinds.len() - 5..], ["context", "say", "bug", "tool", "ask"]);
        // The oldest steps are the ones dropped: 700 + 1 steps, newest 600 kept, so the first kept is step 101.
        assert_eq!(h[2]["text"], "step 101");
        // Texts over 8000 bytes are cut at a character boundary, plus "\n…".
        let bug = h.iter().find(|v| v["kind"] == "bug").unwrap()["text"].as_str().unwrap();
        assert_eq!(bug, format!("{}\n…", "x".repeat(8_000)));
        let wide = h[h.len() - 2]["text"].as_str().unwrap();
        assert_eq!(wide, format!("{}\n…", "é".repeat(4_000)));
        // Short histories come back whole.
        assert_eq!(history_of(&[line("say", "a"), line("tool", "b")].join("\n")).len(), 2);
    }

    #[test]
    fn history_refuses_bad_session_ids() {
        let root = temp("bad-id");
        assert_eq!(history(&root, "../x").unwrap_err(), "Bad session id");
        assert_eq!(history(&root, "").unwrap_err(), "Bad session id");
        assert!(history(&root, "missing").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn chats_are_named() {
        // B47: the name you gave it, else the first non-empty start text, else your first message, short.
        let ev = |kind: &str, text: &str| json!({"kind": kind, "text": text});
        let started = [ev("start", "  "), ev("you", "hello"), ev("start", "prove the vault")];
        assert_eq!(title_of(Some(" Mine \n"), &started), "Mine");
        assert_eq!(title_of(Some("  "), &started), "prove the vault");
        assert_eq!(title_of(None, &[ev("start", ""), ev("you", "check deposit\nand more")]), "check deposit");
        assert_eq!(title_of(None, &[ev("say", "x")]), "");
        let long = "Please look at the withdraw path in Vault, the rounding, and whether shares can be inflated";
        let name = short_name(long);
        assert_eq!(name, "Please look at the withdraw path in Vault, the rounding…");
        assert!(name.chars().count() <= 61);
        assert_eq!(short_name(&"a".repeat(80)), format!("{}…", "a".repeat(60)));
        assert_eq!(short_name(&"é".repeat(60)), "é".repeat(60));
    }

    #[test]
    fn sessions_are_listed_newest_first() {
        // B47: title, outcome (the last line when it is done), spent (the last line's), events, at (mtime).
        let root = temp("sessions");
        let runs = runs_dir(&root);
        std::fs::create_dir_all(&runs).unwrap();
        let done = json!({"kind": "done", "text": "done: 3 proved", "spent": 2.5}).to_string();
        std::fs::write(runs.join("s-1.jsonl"), format!("{}\n{done}\n", line("you", "hi there"))).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(runs.join("s-2.jsonl"), format!("{}\n", line("start", "go"))).unwrap();
        std::fs::write(runs.join("notes.txt"), "ignored").unwrap();
        rename(&root, "s-2", "  Mine\u{7}  ").unwrap();
        let list = sessions(&root);
        assert_eq!(list.iter().map(|s| s.run.as_str()).collect::<Vec<_>>(), ["s-2", "s-1"]);
        assert_eq!(list[0].title, "Mine");
        assert_eq!(list[0].outcome, "");
        assert_eq!(list[1], Session { at: list[1].at, run: "s-1".into(), title: "hi there".into(), outcome: "done: 3 proved".into(), spent: 2.5, events: 2 });
        assert!(list[1].at > 0);
        // Renaming to nothing goes back to the default; a bad id is refused; names stop at 120 characters.
        rename(&root, "s-2", " ").unwrap();
        assert_eq!(sessions(&root)[0].title, "go");
        assert_eq!(rename(&root, "a/b", "x").unwrap_err(), "Bad session id");
        rename(&root, "s-1", &"n".repeat(200)).unwrap();
        assert_eq!(std::fs::read_to_string(runs.join("s-1.title")).unwrap().len(), 120);
        assert!(sessions(&root.join("nowhere")).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_sessions_merge_into_one() {
        // B46: local-*.jsonl appended in name order to swarm.jsonl as run "swarm", archived, their spend returned.
        let root = temp("merge");
        let runs = runs_dir(&root);
        std::fs::create_dir_all(&runs).unwrap();
        std::fs::write(runs.join("swarm.jsonl"), format!("{}\n", line("say", "already"))).unwrap();
        std::fs::write(runs.join("local-2.jsonl"), "{\"run\":\"local-2\",\"kind\":\"say\",\"text\":\"b\",\"spent\":2.5}\n").unwrap();
        std::fs::write(
            runs.join("local-1.jsonl"),
            "{\"run\":\"local-1\",\"kind\":\"say\",\"text\":\"a\",\"spent\":0.5}\n{\"run\":\"local-1\",\"kind\":\"done\",\"text\":\"a2\",\"spent\":1.0}\n",
        )
        .unwrap();
        assert_eq!(merge_old_sessions(&root), 3.5);
        let merged: Vec<Value> = std::fs::read_to_string(runs.join("swarm.jsonl")).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(merged.iter().map(|v| v["text"].as_str().unwrap()).collect::<Vec<_>>(), ["already", "a", "a2", "b"]);
        assert!(merged[1..].iter().all(|v| v["run"] == "swarm"));
        assert!(runs.join("archive").join("local-1.jsonl").exists() && runs.join("archive").join("local-2.jsonl").exists());
        assert!(!runs.join("local-1.jsonl").exists());
        // Nothing left to merge: nothing changes, nothing carried.
        assert_eq!(merge_old_sessions(&root), 0.0);
        assert_eq!(sessions(&root).len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
