//! An agent's turn (SPEC.md §3 Executors, B35–B42, R6, R7, R10): one trait the swarm loop calls, [`Agent::turn`],
//! with three routes behind it — the API on a key or a formal.team session ([`api`]), Claude Code on your Claude plan
//! ([`claude_code`]) and Codex on your ChatGPT plan ([`codex`]).
//!
//! Every wait in a turn (a model call, a CLI thinking, a tool) races a [`Stop`], so Stop and Pause end the turn at
//! once, mid-call. The role's tools are the loop's: the turn hands each call to a [`ToolHost`], which runs it, records
//! what it means (files, a verdict, a bug) and emits its `tool`/`result` events. The turn itself emits `status`, `say`
//! and `context` (and a `tool` line when it compacts) through [`TurnEvents`].

pub mod api;
pub mod claude_code;
pub mod codex;
pub mod compaction;

use super::events::Kind;
use serde_json::{json, Value};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Ends a turn from outside. Clones share it; once stopped it stays stopped.
#[derive(Clone)]
pub struct Stop(Arc<tokio::sync::watch::Sender<bool>>);

impl Default for Stop {
    fn default() -> Self {
        Stop(Arc::new(tokio::sync::watch::channel(false).0))
    }
}

impl Stop {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn stop(&self) {
        self.0.send_replace(true);
    }

    pub fn is_stopped(&self) -> bool {
        *self.0.borrow()
    }

    /// Resolves once stopped (at once if it already is).
    pub async fn stopped(&self) {
        let mut rx = self.0.subscribe();
        if rx.wait_for(|s| *s).await.is_err() {
            std::future::pending::<()>().await;
        }
    }

    /// `f`'s output, or None if the stop came first (and `f` is dropped: an HTTP call is cancelled, a child killed).
    pub async fn race<T>(&self, f: impl Future<Output = T>) -> Option<T> {
        tokio::select! {
            biased;
            _ = self.stopped() => None,
            v = f => Some(v),
        }
    }
}

/// The role's tools, run by the swarm loop.
pub trait ToolHost: Send + Sync {
    /// Runs one call and returns what the agent reads; text starting `error:` is an error. Emits its own
    /// `tool`/`result` events. Dropped mid-way when the turn is stopped.
    fn call<'a>(&'a self, name: &'a str, input: &'a Value) -> BoxFuture<'a, String>;
}

/// Where a turn's events and spend go (the loop stamps folder/run/role/item and logs them).
pub trait TurnEvents: Send + Sync {
    fn event(&self, kind: Kind, text: String);
    /// Dollars a model call cost (API routes only; CLI routes run on your plan and charge nothing).
    fn spend(&self, _dollars: f64) {}
}

/// One agent's turn on one item of one job.
pub struct Turn {
    /// The project folder.
    pub folder: PathBuf,
    /// The session (`swarm` or another session id).
    pub run: String,
    pub job: u64,
    /// `planner`, `prover`, `reviewer`, `assistant`, `auditor`.
    pub role: String,
    pub item: String,
    /// The role's system prompt.
    pub system: String,
    /// The role's tool definitions, Messages-API shaped (`name`, `description`, `input_schema`).
    pub tools: Vec<Value>,
    /// The task: a string or content blocks (a report's PDF as a document block).
    pub task: Value,
    pub events: Arc<dyn TurnEvents>,
    /// Compact now (the Context panel): taken by the next API step.
    pub compact_now: Arc<AtomicBool>,
}

impl Turn {
    pub(crate) fn emit(&self, kind: Kind, text: impl Into<String>) {
        self.events.event(kind, text.into());
    }

    /// The `context` event's text.
    pub(crate) fn context(&self, used: u64, model: &str, fixed: (u64, u64, u64), estimated: bool) {
        let mut v = json!({
            "used": used,
            "window": compaction::window(model),
            "compact_at": compaction::compact_limit(model),
            "system": fixed.0, "tools": fixed.1, "task": fixed.2,
        });
        if estimated {
            v["estimated"] = json!(true);
        }
        self.emit(Kind::Context, v.to_string());
    }

    /// B42 on CLI routes: system, tools and task at about four characters a token.
    pub(crate) fn estimate(&self) -> (u64, u64, u64) {
        let tokens = |chars: usize| (chars as u64).div_ceil(4);
        (tokens(self.system.len()), tokens(Value::Array(self.tools.clone()).to_string().len()), tokens(task_text(&self.task).len()))
    }
}

/// How a turn that didn't fail ended.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Ended {
    /// The agent finished (no more tool calls, or the CLI's turn completed).
    #[default]
    Done,
    /// Stop or Pause came first; the job stays queued and resumes (R6, R9).
    Stopped,
    /// The API route used all its steps (90 for the prover, 40 otherwise).
    OutOfSteps,
}

/// What a turn did, for the loop and its health line (B43). What the tools recorded is the ToolHost's.
#[derive(Clone, Debug, Default)]
pub struct Outcome {
    pub ended: Ended,
    /// The agent's last words (or the CLI's final result).
    pub summary: String,
    /// Model calls made (API) or assistant messages seen (CLI).
    pub steps: usize,
    pub tool_calls: usize,
    /// Dollars spent (API routes).
    pub spent: f64,
    /// The largest context the turn reached, in tokens.
    pub context: u64,
    /// The tools' connection as the CLI reported it (`connected`, `failed`, …); None on the API.
    pub tools: Option<String>,
    /// The job's conversation was already there and was continued.
    pub resumed: bool,
}

/// Why a turn failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TurnError {
    /// B40/R10: the CLI's `formalmind` tools didn't connect; retried by [`turn_retrying`].
    NoTools(String),
    /// B41: the plan's limit or the CLI's own error. The session pauses with the job running, to resume later.
    Paused(String),
    /// Anything else (a refused key, an API error, a CLI that didn't start).
    Failed(String),
}

pub const NO_TOOLS: &str = "the agent's tools didn't connect";

impl std::fmt::Display for TurnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TurnError::NoTools(why) => write!(f, "{NO_TOOLS} ({why})"),
            TurnError::Paused(why) | TurnError::Failed(why) => f.write_str(why),
        }
    }
}

impl From<String> for TurnError {
    fn from(s: String) -> Self {
        TurnError::Failed(s)
    }
}

impl From<&str> for TurnError {
    fn from(s: &str) -> Self {
        TurnError::Failed(s.to_string())
    }
}

/// An agent: one route to a model.
pub trait Agent: Send + Sync {
    fn turn<'a>(&'a self, turn: &'a Turn, tools: &'a dyn ToolHost, stop: &'a Stop) -> BoxFuture<'a, Result<Outcome, TurnError>>;
}

/// B40: a turn whose tools didn't connect is tried twice more, `backoff` and twice that apart (3 s and 6 s in the app),
/// then fails with the error. Stop during the wait ends it as stopped.
pub async fn turn_retrying(agent: &dyn Agent, turn: &Turn, tools: &dyn ToolHost, stop: &Stop, backoff: Duration) -> Result<Outcome, TurnError> {
    let mut tries = 0u32;
    loop {
        match agent.turn(turn, tools, stop).await {
            Err(e @ TurnError::NoTools(_)) if tries < 2 => {
                tries += 1;
                turn.emit(Kind::Status, format!("{e}; starting the turn again"));
                if stop.race(tokio::time::sleep(backoff * tries)).await.is_none() {
                    return Ok(Outcome { ended: Ended::Stopped, ..Outcome::default() });
                }
            }
            other => return other,
        }
    }
}

// ---- shared by the routes ----

/// A task as plain text (the CLIs' prompt, the size estimate): document blocks go in as the text beside them.
pub(crate) fn task_text(task: &Value) -> String {
    match task {
        Value::String(t) => t.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n\n"),
        other => other.to_string(),
    }
}

/// FNV-1a: a folder's short name, stable across Rust versions.
pub(crate) fn fnv(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5u32, |h, b| (h ^ *b as u32).wrapping_mul(0x0100_0193))
}

/// A CLI route's state for one session: `<home>/<route>/<project>-<hash>/<run>/` (R11: per session).
pub(crate) fn state_dir(home: &Path, route: &str, root: &Path, run: &str) -> PathBuf {
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "project".into());
    home.join(route).join(format!("{name}-{:08x}", fnv(root.to_string_lossy().as_bytes()))).join(run)
}

/// A file only you can read (the MCP config carries the bridge's token).
pub(crate) fn write_private(path: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(path).and_then(|mut f| f.write_all(text.as_bytes())).map_err(|e| format!("{}: {e}", path.display()))
}

/// What a line of a CLI's output means to its turn.
pub(crate) enum Step {
    Go,
    Fail(TurnError),
}

/// A running CLI turn: its child, its stdout lines and where its raw stream and stderr go.
pub(crate) struct Cli {
    pub child: tokio::process::Child,
    pub lines: tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    pub state: PathBuf,
    pub log: std::fs::File,
}

impl Cli {
    /// The end of its stderr, for an exit nobody explained.
    pub fn stderr_tail(&self) -> String {
        let err = std::fs::read_to_string(self.state.join("stderr.log")).unwrap_or_default();
        let err: String = err.lines().filter(|l| !l.starts_with("Reading additional input")).collect::<Vec<_>>().join("\n");
        let tail: String = err.trim().chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
        format!("{tail} (logs in {})", self.state.display())
    }

    pub fn open_log(state: &Path, name: &str) -> Result<std::fs::File, String> {
        std::fs::OpenOptions::new().create(true).append(true).open(state.join(name)).map_err(|e| format!("{name}: {e}"))
    }
}

/// Runs a CLI turn: answers its MCP bridge (tool calls go to `tools`), hands each stdout line to `on_line`, and kills
/// it at Stop — mid-line, mid-tool, whatever it is doing. Ok(true) when its output ended, Ok(false) when stopped.
pub(crate) async fn drive(
    cli: &mut Cli,
    bridge: &mut crate::claude_code::Bridge,
    turn: &Turn,
    tools: &dyn ToolHost,
    stop: &Stop,
    out: &mut Outcome,
    on_line: &mut (dyn FnMut(&Value, &mut Outcome) -> Step + Send),
) -> Result<bool, TurnError> {
    use crate::claude_code::{mcp_tools, rpc, tool_reply, Rpc};
    use std::io::Write;
    let defs = mcp_tools(turn.tools.clone());
    let instructions = format!("Formal Mind's tools for the {}, run by the app in the folder.", turn.role);
    loop {
        tokio::select! {
            biased;
            _ = stop.stopped() => {
                let _ = cli.child.kill().await;
                return Ok(false);
            }
            call = bridge.calls.recv() => {
                let Some(call) = call else { continue };
                match rpc(&call.msg, &defs, &instructions) {
                    Rpc::Reply(r) => call.answer(r),
                    Rpc::Tool { id, name, args } => {
                        out.tool_calls += 1;
                        match stop.race(tools.call(&name, &args)).await {
                            Some(text) => call.answer(Some(tool_reply(id, &super::lake::clip(text)))),
                            None => {
                                call.answer(Some(tool_reply(id, "stopped: the swarm was paused; this call didn't finish")));
                                let _ = cli.child.kill().await;
                                return Ok(false);
                            }
                        }
                    }
                }
            }
            line = cli.lines.next_line() => {
                let Ok(Some(line)) = line else { return Ok(true) };
                let _ = writeln!(cli.log, "{line}");
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if let Step::Fail(e) = on_line(&v, out) {
                    let _ = cli.child.kill().await;
                    return Err(e);
                }
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod testkit {
    //! Fakes shared by the routes' tests: events, a tool host, and scripts standing in for `claude`/`codex`.
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct Events {
        pub got: Mutex<Vec<(Kind, String)>>,
        pub spent: Mutex<f64>,
    }

    impl Events {
        pub fn of(&self, kind: Kind) -> Vec<String> {
            self.got.lock().unwrap().iter().filter(|(k, _)| *k == kind).map(|(_, t)| t.clone()).collect()
        }
    }

    impl TurnEvents for Events {
        fn event(&self, kind: Kind, text: String) {
            self.got.lock().unwrap().push((kind, text));
        }
        fn spend(&self, d: f64) {
            *self.spent.lock().unwrap() += d;
        }
    }

    /// Answers `echo` with its input, after `delay`.
    #[derive(Default)]
    pub struct Host {
        pub calls: Mutex<Vec<(String, Value)>>,
        pub delay: Duration,
    }

    impl ToolHost for Host {
        fn call<'a>(&'a self, name: &'a str, input: &'a Value) -> BoxFuture<'a, String> {
            Box::pin(async move {
                self.calls.lock().unwrap().push((name.to_string(), input.clone()));
                tokio::time::sleep(self.delay).await;
                format!("echo {input}")
            })
        }
    }

    pub fn turn(folder: &Path, role: &str, events: Arc<Events>) -> Turn {
        Turn {
            folder: folder.to_path_buf(),
            run: "swarm".into(),
            job: 7,
            role: role.into(),
            item: "3".into(),
            system: "You review proofs.".into(),
            tools: vec![json!({ "name": "echo", "description": "Echo", "input_schema": { "type": "object" } })],
            task: json!("Review item 3."),
            events,
            compact_now: Arc::new(AtomicBool::new(false)),
        }
    }

    /// An executable bash script at `dir/name` that counts its runs (`$n`) and records its args (`args-$n`).
    pub fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        let head = format!(
            "#!/bin/bash\nD='{}'\nn=$(( $(cat \"$D/count\" 2>/dev/null || echo 0) + 1 )); echo $n > \"$D/count\"\nprintf '%s\\n' \"$@\" > \"$D/args-$n\"\n",
            dir.display()
        );
        std::fs::write(&path, head + body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    /// The args of run `n` of a script in `dir`.
    pub fn args(dir: &Path, n: u32) -> Vec<String> {
        std::fs::read_to_string(dir.join(format!("args-{n}"))).unwrap_or_default().lines().map(String::from).collect()
    }

    pub fn runs(dir: &Path) -> u32 {
        std::fs::read_to_string(dir.join("count")).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
    }

    /// Whether `flag` is followed by `value` in `args`.
    pub fn has(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2).any(|w| w[0] == flag && w[1] == value)
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use crate::swarm2::fsguard::tests::TempDir;

    struct NeverConnects(std::sync::atomic::AtomicUsize);
    impl Agent for NeverConnects {
        fn turn<'a>(&'a self, _: &'a Turn, _: &'a dyn ToolHost, _: &'a Stop) -> BoxFuture<'a, Result<Outcome, TurnError>> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async { Err(TurnError::NoTools("Claude Code reported them failed".into())) })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b40_a_turn_without_tools_is_tried_three_times_then_fails() {
        let t = TempDir::new("exec-b40");
        let events = Arc::new(Events::default());
        let agent = NeverConnects(Default::default());
        let r = turn_retrying(&agent, &turn(&t.0, "reviewer", events.clone()), &Host::default(), &Stop::new(), Duration::from_millis(5)).await;
        assert_eq!(agent.0.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(r.unwrap_err().to_string(), "the agent's tools didn't connect (Claude Code reported them failed)");
        assert_eq!(events.of(Kind::Status).len(), 2, "two retries announced");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn r6_stop_during_the_retry_wait_ends_the_turn() {
        let t = TempDir::new("exec-r6w");
        let agent = NeverConnects(Default::default());
        let stop = Stop::new();
        let s = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            s.stop();
        });
        let at = std::time::Instant::now();
        let r = turn_retrying(&agent, &turn(&t.0, "reviewer", Arc::new(Events::default())), &Host::default(), &stop, Duration::from_secs(30)).await;
        assert_eq!(r.unwrap().ended, Ended::Stopped);
        assert!(at.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn r6_a_stop_cuts_through_any_wait() {
        let stop = Stop::new();
        stop.stop();
        assert!(stop.race(std::future::pending::<()>()).await.is_none());
        assert!(stop.is_stopped());
        assert_eq!(Stop::new().race(async { 1 }).await, Some(1));
    }

    #[test]
    fn cli_state_is_per_project_and_session() {
        let a = state_dir(Path::new("/h/.formalmind"), "claude-code", Path::new("/w/contracts"), "s-1");
        assert!(a.to_string_lossy().starts_with("/h/.formalmind/claude-code/contracts-"));
        assert!(a.ends_with("s-1"));
        assert_ne!(a.parent(), state_dir(Path::new("/h/.formalmind"), "claude-code", Path::new("/x/contracts"), "s-1").parent());
        assert_eq!(fnv(b"a"), 0xe40c292c);
    }
}
