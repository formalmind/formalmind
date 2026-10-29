//! B38, B40–B42 on Claude Code: one `claude -p` per turn on your Claude plan, with the role's system prompt in place
//! of Claude Code's, its built-in tools off (`--tools ""`) and only the swarm's tools, served over a per-turn MCP bridge.
//! Nothing from your Claude Code setup reaches it. The job's session id is saved once the first assistant line arrives,
//! so a quit mid-job resumes the same conversation (`--resume`).

use super::{drive, state_dir, write_private, Agent, BoxFuture, Cli, Ended, Outcome, Step, Stop, ToolHost, Turn, TurnError};
use crate::swarm2::events::Kind;
use crate::swarm2::queue::RESUMED;
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

pub struct ClaudeCodeAgent {
    /// The `claude` binary (`platform::find_tool("claude")` in the app; a script in tests).
    pub bin: PathBuf,
    /// `~/.formalmind`: run state goes under `claude-code/`.
    pub home: PathBuf,
    pub model: String,
    /// Settings' thinking effort, read by the loop for each turn.
    pub effort: Option<String>,
}

impl ClaudeCodeAgent {
    pub fn new(home: PathBuf, model: &str, effort: Option<String>) -> Self {
        ClaudeCodeAgent { bin: crate::platform::find_tool("claude"), home, model: model.to_string(), effort }
    }
}

/// The job's session id: a version-4-shaped UUID from (folder, run, job). DefaultHasher isn't stable across Rust
/// versions, but the id is saved once the job starts, so only an unstarted job is affected.
pub fn session_id(folder: &str, run: &str, job: u64) -> String {
    let half = |seed: u8| {
        let mut h = DefaultHasher::new();
        (seed, folder, run, job).hash(&mut h);
        h.finish()
    };
    let (a, b) = (half(1), half(2));
    format!("{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}", (a >> 32) as u32, (a >> 16) as u16, a as u16 & 0x0fff, (b >> 48) as u16 & 0x3fff | 0x8000, b & 0xffff_ffff_ffff)
}

/// A `result` line: its text, or why the turn failed (a usage limit says when it resets).
fn result_of(line: &Value) -> Result<String, String> {
    let text = line["result"].as_str().unwrap_or("").trim().to_string();
    if line["is_error"] == true || line["subtype"].as_str().is_some_and(|s| s != "success") {
        let why = if text.is_empty() { line["subtype"].as_str().unwrap_or("error").to_string() } else { text };
        return Err(format!("Claude Code stopped: {why}"));
    }
    Ok(text)
}

impl ClaudeCodeAgent {
    async fn run(&self, turn: &Turn, tools: &dyn ToolHost, stop: &Stop) -> Result<Outcome, TurnError> {
        use tokio::io::AsyncBufReadExt;
        let mut out = Outcome::default();
        let root = std::fs::canonicalize(&turn.folder).map_err(|e| format!("{}: {e}", turn.folder.display()))?;
        let state = state_dir(&self.home, "claude-code", &root, &turn.run);
        std::fs::create_dir_all(&state).map_err(|e| format!("{}: {e}", state.display()))?;
        let mut bridge = crate::claude_code::bridge()?;
        let mcp = json!({ "mcpServers": { "formalmind": { "type": "http", "url": bridge.url, "headers": { "Authorization": format!("Bearer {}", bridge.token) } } } });
        let mcp_file = state.join("mcp.json");
        write_private(&mcp_file, &serde_json::to_string_pretty(&mcp).unwrap_or_default())?;
        let session_file = state.join(format!("job-{}.session", turn.job));
        let saved = std::fs::read_to_string(&session_file).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        out.resumed = saved.is_some();
        let session = saved.unwrap_or_else(|| session_id(&turn.folder.to_string_lossy(), &turn.run, turn.job));
        let content = if out.resumed { json!(RESUMED) } else { turn.task.clone() };

        let mut cmd = tokio::process::Command::new(&self.bin);
        cmd.current_dir(&root)
            .arg("-p")
            .args(["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
            .arg("--system-prompt")
            .arg(&turn.system)
            .args(["--tools", ""])
            .arg("--mcp-config")
            .arg(&mcp_file)
            .arg("--strict-mcp-config")
            .args(["--allowedTools", "mcp__formalmind"])
            .args(["--setting-sources", ""])
            .arg("--disable-slash-commands")
            .args(["--model", &self.model]);
        if let Some(e) = &self.effort {
            cmd.args(["--effort", e]);
        }
        cmd.args(if out.resumed { ["--resume", session.as_str()] } else { ["--session-id", session.as_str()] })
            .env("PATH", crate::platform::tool_path(None))
            .env("PWD", &root)
            // Your Claude plan, not a key that happens to be in the environment.
            .env_remove("ANTHROPIC_API_KEY")
            .env("MCP_TOOL_TIMEOUT", "7200000")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::from(Cli::open_log(&state, "stderr.log")?))
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("couldn't start Claude Code ({}): {e}", self.bin.display()))?;
        // The one message, then end of input: Claude Code works until the turn is done and exits.
        let message = json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string() + "\n";
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(message.as_bytes()).await;
        });
        let lines = tokio::io::BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();
        let log = Cli::open_log(&state, "stream.jsonl")?;
        let mut cli = Cli { child, lines, state, log };
        turn.emit(Kind::Status, format!("{} is working on Claude Code{}", turn.role, if out.resumed { ", resuming its conversation" } else { "" }));

        let fixed = turn.estimate();
        let mut result: Option<Result<String, String>> = None;
        let mut started = false;
        let mut last_used = 0;
        let model = self.model.clone();
        let ended = {
            let mut on_line = |v: &Value, out: &mut Outcome| -> Step {
                match v["type"].as_str() {
                    Some("system") if v["subtype"] == "init" => {
                        // It must work in the folder: anywhere else, lake and forge would run in the wrong place.
                        let cwd = v["cwd"].as_str().and_then(|p| std::fs::canonicalize(p).ok());
                        if cwd.as_deref() != Some(root.as_path()) {
                            return Step::Fail(TurnError::Failed(format!("Claude Code started in {}, not the folder {}", v["cwd"].as_str().unwrap_or("?"), root.display())));
                        }
                        // R10: without its tools the agent writes tool calls out as text nothing runs. Stop at init.
                        let status = v["mcp_servers"].as_array().and_then(|a| a.iter().find(|m| m["name"] == "formalmind")).and_then(|m| m["status"].as_str()).unwrap_or("missing").to_string();
                        out.tools = Some(status.clone());
                        if status != "connected" {
                            return Step::Fail(TurnError::NoTools(format!("Claude Code reported them {status}")));
                        }
                        let billing = match v["apiKeySource"].as_str() {
                            Some("none") | None => "your Claude plan".to_string(),
                            Some(k) => format!("API key from {k}"),
                        };
                        turn.emit(Kind::Status, format!("Claude Code {} · {} · {billing} · in {} · tools {status}", v["claude_code_version"].as_str().unwrap_or(""), v["model"].as_str().unwrap_or(&model), root.display()));
                    }
                    Some("assistant") => {
                        // The conversation is on disk now: a quit from here resumes it.
                        if !started {
                            started = true;
                            let _ = std::fs::write(&session_file, &session);
                        }
                        out.steps += 1;
                        for c in v["message"]["content"].as_array().into_iter().flatten() {
                            if c["type"] == "text" {
                                let t = c["text"].as_str().unwrap_or("").trim();
                                if !t.is_empty() {
                                    out.summary = t.to_string();
                                    turn.emit(Kind::Say, t);
                                }
                            }
                        }
                        // Each block of a reply comes as its own line carrying the reply's usage (B42).
                        let used = super::compaction::context_used(&v["message"]["usage"]);
                        if used > 0 && used != last_used {
                            last_used = used;
                            out.context = out.context.max(used);
                            turn.context(used, &model, fixed, true);
                        }
                    }
                    Some("result") => result = Some(result_of(v)),
                    _ => {}
                }
                Step::Go
            };
            drive(&mut cli, &mut bridge, turn, tools, stop, &mut out, &mut on_line).await?
        };
        if !ended {
            out.ended = Ended::Stopped;
            return Ok(out);
        }
        let status = cli.child.wait().await.map_err(|e| e.to_string())?;
        match result {
            Some(Ok(text)) => {
                if !text.is_empty() {
                    out.summary = text;
                }
                Ok(out)
            }
            // B41: a usage limit or an API error; the job stays running and the next start resumes it.
            Some(Err(e)) => Err(TurnError::Paused(e)),
            None => Err(TurnError::Failed(format!("Claude Code exited with {status}: {}", cli.stderr_tail()))),
        }
    }
}

impl Agent for ClaudeCodeAgent {
    fn turn<'a>(&'a self, turn: &'a Turn, tools: &'a dyn ToolHost, stop: &'a Stop) -> BoxFuture<'a, Result<Outcome, TurnError>> {
        Box::pin(self.run(turn, tools, stop))
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;
    use crate::swarm2::fsguard::tests::TempDir;
    use std::sync::Arc;
    use std::time::Duration;

    const INIT: &str = r#"echo "{\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"$(pwd -P)\",\"model\":\"claude-opus-5-5\",\"apiKeySource\":\"none\",\"mcp_servers\":[{\"name\":\"formalmind\",\"status\":\"$TOOLS\"}]}""#;
    const SAY: &str = r#"echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Checking the proof."}],"usage":{"input_tokens":5000,"output_tokens":20}}}'"#;
    const RESULT: &str = r#"echo '{"type":"result","subtype":"success","is_error":false,"result":"Approved."}'"#;

    /// A fake `claude` in `dir`: saves its stdin's first line (`stdin-$n`), then runs `body`.
    fn claude(dir: &std::path::Path, tools: &str, body: &str) -> ClaudeCodeAgent {
        let bin = script(dir, "claude", &format!("IFS= read -r first; printf '%s\\n' \"$first\" > \"$D/stdin-$n\"\nTOOLS={tools}\n{body}\n"));
        ClaudeCodeAgent { bin, home: dir.join("home"), model: "claude-opus-5-5".into(), effort: Some("high".into()) }
    }

    fn stop_after(ms: u64) -> Stop {
        let stop = Stop::new();
        let s = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            s.stop();
        });
        stop
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b38_claude_code_runs_with_only_the_swarms_tools() {
        let (bin, folder) = (TempDir::new("cc-bin"), TempDir::new("cc-folder"));
        let a = claude(&bin.0, "connected", &format!("{INIT}\n{SAY}\n{RESULT}"));
        let events = Arc::new(Events::default());
        let out = a.turn(&turn(&folder.0, "reviewer", events.clone()), &Host::default(), &Stop::new()).await.unwrap();
        assert_eq!((out.ended, out.summary.as_str(), out.tools.as_deref(), out.spent), (Ended::Done, "Approved.", Some("connected"), 0.0));
        let args = args(&bin.0, 1);
        assert!(has(&args, "--tools", ""), "{args:?}");
        assert!(has(&args, "--system-prompt", "You review proofs."));
        assert!(has(&args, "--allowedTools", "mcp__formalmind"));
        assert!(has(&args, "--setting-sources", ""));
        assert!(has(&args, "--model", "claude-opus-5-5"));
        assert!(has(&args, "--effort", "high"));
        assert!(args.contains(&"--strict-mcp-config".to_string()) && args.contains(&"--disable-slash-commands".to_string()));
        let sid = session_id(&folder.0.to_string_lossy(), "swarm", 7);
        assert!(has(&args, "--session-id", &sid));
        // The MCP config points at a local bridge with a bearer token, and only its owner can read it.
        let cfg_path = &args[args.iter().position(|a| a == "--mcp-config").unwrap() + 1];
        let cfg: Value = serde_json::from_str(&std::fs::read_to_string(cfg_path).unwrap()).unwrap();
        assert!(cfg["mcpServers"]["formalmind"]["url"].as_str().unwrap().starts_with("http://127.0.0.1:"));
        assert!(cfg["mcpServers"]["formalmind"]["headers"]["Authorization"].as_str().unwrap().starts_with("Bearer "));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(cfg_path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let stdin: Value = serde_json::from_str(&std::fs::read_to_string(bin.0.join("stdin-1")).unwrap()).unwrap();
        assert_eq!(stdin["message"]["content"], "Review item 3.");
        assert_eq!(events.of(Kind::Say), ["Checking the proof."]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b38_its_tool_calls_go_through_the_bridge_to_the_loop() {
        let (bin, folder) = (TempDir::new("cc-bin"), TempDir::new("cc-folder"));
        let call = r#"cfg=$(awk 'p{print;exit} $0=="--mcp-config"{p=1}' "$D/args-$n")
url=$(sed -n 's/.*"url": "\([^"]*\)".*/\1/p' "$cfg")
auth=$(sed -n 's/.*"Authorization": "\([^"]*\)".*/\1/p' "$cfg")
curl -s -X POST -H "Authorization: $auth" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"x":"hi"}}}' "$url" > "$D/reply"
curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' "$url" > "$D/unauthed""#;
        let a = claude(&bin.0, "connected", &format!("{INIT}\n{call}\n{RESULT}"));
        let host = Host::default();
        let out = a.turn(&turn(&folder.0, "reviewer", Arc::new(Events::default())), &host, &Stop::new()).await.unwrap();
        assert_eq!(host.calls.lock().unwrap()[0], ("echo".to_string(), json!({ "x": "hi" })));
        assert_eq!(out.tool_calls, 1);
        let reply: Value = serde_json::from_str(&std::fs::read_to_string(bin.0.join("reply")).unwrap()).unwrap();
        assert_eq!(reply["result"]["content"][0]["text"], "echo {\"x\":\"hi\"}");
        assert_eq!(std::fs::read_to_string(bin.0.join("unauthed")).unwrap(), "401");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn r6_stop_mid_claude_code_turn_ends_it_promptly() {
        let (bin, folder) = (TempDir::new("cc-bin"), TempDir::new("cc-folder"));
        let a = claude(&bin.0, "connected", &format!("{INIT}\n{SAY}\nexec sleep 30"));
        let at = std::time::Instant::now();
        let out = a.turn(&turn(&folder.0, "reviewer", Arc::new(Events::default())), &Host::default(), &stop_after(500)).await.unwrap();
        assert_eq!(out.ended, Ended::Stopped);
        assert!(at.elapsed() < Duration::from_secs(3), "{:?}", at.elapsed());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b38_a_quit_mid_job_resumes_the_same_session() {
        let (bin, folder) = (TempDir::new("cc-bin"), TempDir::new("cc-folder"));
        // The first run answers, then the app quits; the second finishes.
        let body = format!("{INIT}\n{SAY}\nif [ $n = 1 ]; then exec sleep 30; fi\n{RESULT}");
        let a = claude(&bin.0, "connected", &body);
        let out = a.turn(&turn(&folder.0, "reviewer", Arc::new(Events::default())), &Host::default(), &stop_after(500)).await.unwrap();
        assert_eq!(out.ended, Ended::Stopped);
        let events = Arc::new(Events::default());
        let out = a.turn(&turn(&folder.0, "reviewer", events.clone()), &Host::default(), &Stop::new()).await.unwrap();
        assert!(out.resumed);
        let sid = session_id(&folder.0.to_string_lossy(), "swarm", 7);
        assert!(has(&args(&bin.0, 2), "--resume", &sid));
        let stdin: Value = serde_json::from_str(&std::fs::read_to_string(bin.0.join("stdin-2")).unwrap()).unwrap();
        assert_eq!(stdin["message"]["content"], RESUMED);
        assert!(events.of(Kind::Status)[0].ends_with("resuming its conversation"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b38_a_job_that_never_started_starts_fresh() {
        let (bin, folder) = (TempDir::new("cc-bin"), TempDir::new("cc-folder"));
        // Stopped before any assistant line: nothing to resume.
        let a = claude(&bin.0, "connected", &format!("{INIT}\nif [ $n = 1 ]; then exec sleep 30; fi\n{RESULT}"));
        a.turn(&turn(&folder.0, "reviewer", Arc::new(Events::default())), &Host::default(), &stop_after(300)).await.unwrap();
        a.turn(&turn(&folder.0, "reviewer", Arc::new(Events::default())), &Host::default(), &Stop::new()).await.unwrap();
        assert!(args(&bin.0, 2).contains(&"--session-id".to_string()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn r10_a_turn_without_its_tools_stops_at_init() {
        let (bin, folder) = (TempDir::new("cc-bin"), TempDir::new("cc-folder"));
        let a = claude(&bin.0, "failed", &format!("{INIT}\n{SAY}\nexec sleep 30"));
        let events = Arc::new(Events::default());
        let at = std::time::Instant::now();
        let e = a.turn(&turn(&folder.0, "reviewer", events.clone()), &Host::default(), &Stop::new()).await.unwrap_err();
        assert_eq!(e, TurnError::NoTools("Claude Code reported them failed".into()));
        assert!(at.elapsed() < Duration::from_secs(3));
        assert!(events.of(Kind::Say).is_empty(), "the agent never got to work");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b40_claude_code_without_tools_is_retried_then_fails() {
        let (bin, folder) = (TempDir::new("cc-bin"), TempDir::new("cc-folder"));
        let a = claude(&bin.0, "pending", &format!("{INIT}\nexec sleep 30"));
        let r = super::super::turn_retrying(&a, &turn(&folder.0, "reviewer", Arc::new(Events::default())), &Host::default(), &Stop::new(), Duration::from_millis(10)).await;
        assert!(r.unwrap_err().to_string().starts_with("the agent's tools didn't connect"));
        assert_eq!(runs(&bin.0), 3);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b38_a_cwd_other_than_the_folder_is_an_error() {
        let (bin, folder) = (TempDir::new("cc-bin"), TempDir::new("cc-folder"));
        let a = claude(&bin.0, "connected", &format!("cd /\n{INIT}\nexec sleep 30"));
        let e = a.turn(&turn(&folder.0, "reviewer", Arc::new(Events::default())), &Host::default(), &Stop::new()).await.unwrap_err();
        assert!(e.to_string().starts_with("Claude Code started in /"), "{e}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b41_a_plan_limit_pauses_with_the_job_resumable() {
        let (bin, folder) = (TempDir::new("cc-bin"), TempDir::new("cc-folder"));
        let limit = r#"echo '{"type":"result","subtype":"success","is_error":true,"result":"Claude usage limit reached; resets 5pm"}'"#;
        let a = claude(&bin.0, "connected", &format!("{INIT}\n{SAY}\n{limit}"));
        let e = a.turn(&turn(&folder.0, "reviewer", Arc::new(Events::default())), &Host::default(), &Stop::new()).await.unwrap_err();
        assert_eq!(e, TurnError::Paused("Claude Code stopped: Claude usage limit reached; resets 5pm".into()));
        a.turn(&turn(&folder.0, "reviewer", Arc::new(Events::default())), &Host::default(), &Stop::new()).await.ok();
        assert!(args(&bin.0, 2).contains(&"--resume".to_string()), "the next start resumes");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b42_claude_code_context_is_estimated() {
        let (bin, folder) = (TempDir::new("cc-bin"), TempDir::new("cc-folder"));
        let a = claude(&bin.0, "connected", &format!("{INIT}\n{SAY}\n{SAY}\n{RESULT}"));
        let events = Arc::new(Events::default());
        a.turn(&turn(&folder.0, "reviewer", events.clone()), &Host::default(), &Stop::new()).await.unwrap();
        let ctx = events.of(Kind::Context);
        assert_eq!(ctx.len(), 1, "one event per reply, not per block");
        let v: Value = serde_json::from_str(&ctx[0]).unwrap();
        assert_eq!((v["used"].as_u64(), v["estimated"].as_bool(), v["system"].as_u64(), v["task"].as_u64()), (Some(5020), Some(true), Some(5), Some(4)));
    }

    #[test]
    fn session_ids_are_stable_v4_uuids() {
        let a = session_id("/p", "swarm", 1);
        assert_eq!(a, session_id("/p", "swarm", 1));
        assert_ne!(a, session_id("/p", "swarm", 2));
        assert_ne!(a, session_id("/p", "other", 1), "per session (R11)");
        let parts: Vec<&str> = a.split('-').collect();
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), [8, 4, 4, 4, 12]);
        assert!(parts[2].starts_with('4'));
    }
}
