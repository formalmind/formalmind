//! B39–B42 and R7 on Codex: one `codex exec [resume <thread>] --json` per turn on your ChatGPT plan, with the role's
//! instructions in place of Codex's, its own tools and features off, a read-only sandbox, and the swarm's tools over
//! the same MCP bridge as Claude Code. Its thread id is saved on `thread.started`, so a quit resumes the thread, and
//! it compacts its own thread at 75% of the window (R7: with your config ignored it would otherwise never compact).

use super::{drive, state_dir, task_text, Agent, BoxFuture, Cli, Ended, Outcome, Step, Stop, ToolHost, Turn, TurnError};
use crate::swarm2::events::Kind;
use crate::swarm2::queue::RESUMED;
use serde_json::Value;
use std::path::PathBuf;

/// The ChatGPT-plan models, the first the default.
pub const MODELS: [&str; 4] = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

/// Codex's own features the roles don't get: the swarm's tools are the only way they act.
pub const DISABLED: [&str; 15] = [
    "shell_tool", "apps", "browser_use", "browser_use_external", "in_app_browser", "computer_use", "image_generation",
    "multi_agent", "multi_agent_v2", "plugins", "skill_search", "hooks", "goals", "memories", "fast_mode",
];

const SANDBOX_NOTE: &str = "Your own shell sandbox is read-only on purpose: write files only with the formalmind write_file tool, \
run lake and forge only with its run tool, and file bugs with report_bug. Those work; never say writing is blocked.";

pub struct CodexAgent {
    /// The `codex` binary (`platform::find_tool("codex")` in the app; a script in tests).
    pub bin: PathBuf,
    /// `~/.formalmind`: run state goes under `codex/`.
    pub home: PathBuf,
    pub model: String,
    pub effort: Option<String>,
}

impl CodexAgent {
    pub fn new(home: PathBuf, model: Option<&str>, effort: Option<String>) -> Self {
        CodexAgent { bin: crate::platform::find_tool("codex"), home, model: model.unwrap_or(MODELS[0]).to_string(), effort }
    }
}

/// A TOML string for `-c key=value` (JSON's escapes are TOML's).
fn toml(s: &str) -> String {
    Value::String(s.to_string()).to_string()
}

/// Codex has no `max` effort.
fn effort_of(e: &str) -> &str {
    if e == "max" { "xhigh" } else { e }
}

/// The `-c` overrides for a turn.
pub fn config(instructions: &str, bridge_url: &str, model: &str, effort: Option<&str>) -> Vec<String> {
    let mut c = vec![
        format!("model_instructions_file={}", toml(instructions)),
        "sandbox_mode=\"read-only\"".into(),
        "approval_policy=\"never\"".into(),
        "web_search=\"disabled\"".into(),
        "include_apply_patch_tool=false".into(),
        "tools.view_image=false".into(),
        "skills.include_instructions=false".into(),
        format!("mcp_servers.formalmind.url={}", toml(bridge_url)),
        "mcp_servers.formalmind.bearer_token_env_var=\"FORMALMIND_MCP_TOKEN\"".into(),
        "mcp_servers.formalmind.required=true".into(),
        "mcp_servers.formalmind.default_tools_approval_mode=\"approve\"".into(),
        "mcp_servers.formalmind.tool_timeout_sec=7200".into(),
        format!("model_auto_compact_token_limit={}", super::compaction::compact_limit(model)),
    ];
    if let Some(e) = effort {
        c.push(format!("model_reasoning_effort={}", toml(effort_of(e))));
    }
    c
}

impl CodexAgent {
    async fn run(&self, turn: &Turn, tools: &dyn ToolHost, stop: &Stop) -> Result<Outcome, TurnError> {
        use tokio::io::AsyncBufReadExt;
        let mut out = Outcome::default();
        let root = std::fs::canonicalize(&turn.folder).map_err(|e| format!("{}: {e}", turn.folder.display()))?;
        let state = state_dir(&self.home, "codex", &root, &turn.run);
        std::fs::create_dir_all(&state).map_err(|e| format!("{}: {e}", state.display()))?;
        let instructions = state.join("instructions.md");
        std::fs::write(&instructions, format!("{}\n\n{SANDBOX_NOTE}", turn.system)).map_err(|e| format!("{}: {e}", instructions.display()))?;
        let mut bridge = crate::claude_code::bridge()?;
        let thread_file = state.join(format!("job-{}.thread", turn.job));
        let saved = std::fs::read_to_string(&thread_file).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        out.resumed = saved.is_some();
        let prompt = if out.resumed { RESUMED.to_string() } else { task_text(&turn.task) };

        let mut cmd = tokio::process::Command::new(&self.bin);
        cmd.current_dir(&root).arg("exec");
        if let Some(thread) = &saved {
            cmd.args(["resume", thread.as_str()]);
        }
        cmd.args(["--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-m", &self.model]);
        for f in DISABLED {
            cmd.args(["--disable", f]);
        }
        for c in config(&instructions.to_string_lossy(), &bridge.url, &self.model, self.effort.as_deref()) {
            cmd.args(["-c", &c]);
        }
        cmd.arg(&prompt)
            .env("PATH", crate::platform::tool_path(None))
            .env("PWD", &root)
            .env("FORMALMIND_MCP_TOKEN", &bridge.token)
            // Your ChatGPT plan, not a key that happens to be in the environment.
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::from(Cli::open_log(&state, "stderr.log")?))
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("couldn't start Codex ({}): {e}", self.bin.display()))?;
        let lines = tokio::io::BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();
        let log = Cli::open_log(&state, "stream.jsonl")?;
        let mut cli = Cli { child, lines, state, log };
        turn.emit(Kind::Status, format!("{} is working on Codex{}", turn.role, if out.resumed { ", resuming its thread" } else { "" }));

        let fixed = turn.estimate();
        let mut failed: Option<String> = None;
        let mut finished = false;
        let model = self.model.clone();
        let ended = {
            let mut on_line = |v: &Value, out: &mut Outcome| -> Step {
                match v["type"].as_str() {
                    // A thread starts only once its required tools connected.
                    Some("thread.started") => {
                        out.tools = Some("connected".into());
                        let _ = std::fs::write(&thread_file, v["thread_id"].as_str().unwrap_or(""));
                        turn.emit(Kind::Status, format!("Codex · {model} · your ChatGPT plan · in {}", root.display()));
                    }
                    Some("item.completed") if v["item"]["type"] == "agent_message" => {
                        out.steps += 1;
                        let t = v["item"]["text"].as_str().unwrap_or("").trim();
                        if !t.is_empty() {
                            out.summary = t.to_string();
                            turn.emit(Kind::Say, t);
                        }
                    }
                    Some("turn.completed") => {
                        finished = true;
                        let u = &v["usage"];
                        let used = u["input_tokens"].as_u64().unwrap_or(0) + u["output_tokens"].as_u64().unwrap_or(0);
                        if used > 0 {
                            out.context = out.context.max(used);
                            turn.context(used, &model, fixed, true);
                        }
                    }
                    Some("turn.failed") => failed = Some(format!("Codex stopped: {}", v["error"]["message"].as_str().unwrap_or("the turn failed"))),
                    Some("error") => failed = Some(format!("Codex stopped: {}", v["message"].as_str().unwrap_or("error"))),
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
        let why = cli.stderr_tail();
        match failed {
            // B40 before B41: a required server that failed is a tools problem, retried.
            _ if !finished && why.contains("required MCP servers failed") => Err(TurnError::NoTools("Codex couldn't connect them".into())),
            // B41: a usage limit or an API error; the thread is kept to resume.
            Some(e) => Err(TurnError::Paused(e)),
            None if finished || status.success() => Ok(out),
            None => Err(TurnError::Failed(format!("Codex exited with {status}: {why}"))),
        }
    }
}

impl Agent for CodexAgent {
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

    const STARTED: &str = r#"echo '{"type":"thread.started","thread_id":"th-1"}'"#;
    const SAY: &str = r#"echo '{"type":"item.completed","item":{"type":"agent_message","text":"Proved it."}}'"#;
    const DONE: &str = r#"echo '{"type":"turn.completed","usage":{"input_tokens":1200,"output_tokens":30}}'"#;

    fn codex(dir: &std::path::Path, body: &str) -> CodexAgent {
        CodexAgent { bin: script(dir, "codex", body), home: dir.join("home"), model: "gpt-6-astra".into(), effort: Some("max".into()) }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b39_codex_runs_read_only_with_only_the_swarms_tools() {
        let (bin, folder) = (TempDir::new("cx-bin"), TempDir::new("cx-folder"));
        let a = codex(&bin.0, &format!("{STARTED}\n{SAY}\n{DONE}"));
        let events = Arc::new(Events::default());
        let out = a.turn(&turn(&folder.0, "prover", events.clone()), &Host::default(), &Stop::new()).await.unwrap();
        assert_eq!((out.ended, out.summary.as_str(), out.tools.as_deref()), (Ended::Done, "Proved it.", Some("connected")));
        let args = args(&bin.0, 1);
        assert_eq!(args[0], "exec");
        for f in ["--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"] {
            assert!(args.contains(&f.to_string()), "{f}");
        }
        assert!(has(&args, "-m", "gpt-6-astra"));
        assert_eq!(args.iter().filter(|a| *a == "--disable").count(), 15);
        for c in ["sandbox_mode=\"read-only\"", "approval_policy=\"never\"", "mcp_servers.formalmind.required=true", "model_reasoning_effort=\"xhigh\""] {
            assert!(has(&args, "-c", c), "{c}");
        }
        assert_eq!(args.last().unwrap(), "Review item 3.");
        let instructions = args.iter().find_map(|a| a.strip_prefix("model_instructions_file=")).unwrap();
        let text = std::fs::read_to_string(serde_json::from_str::<String>(instructions).unwrap()).unwrap();
        assert!(text.starts_with("You review proofs.") && text.contains("read-only on purpose"));
        let ctx: Value = serde_json::from_str(&events.of(Kind::Context)[0]).unwrap();
        assert_eq!((ctx["used"].as_u64(), ctx["estimated"].as_bool(), ctx["window"].as_u64()), (Some(1230), Some(true), Some(400_000)));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn r7_codex_is_given_a_compaction_limit() {
        let (bin, folder) = (TempDir::new("cx-bin"), TempDir::new("cx-folder"));
        let a = codex(&bin.0, &format!("{STARTED}\n{DONE}"));
        a.turn(&turn(&folder.0, "prover", Arc::new(Events::default())), &Host::default(), &Stop::new()).await.unwrap();
        assert!(has(&args(&bin.0, 1), "-c", "model_auto_compact_token_limit=300000"));
        assert!(config("i", "u", "claude-opus-5-5", None).contains(&"model_auto_compact_token_limit=750000".to_string()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b39_a_quit_mid_job_resumes_the_same_thread() {
        let (bin, folder) = (TempDir::new("cx-bin"), TempDir::new("cx-folder"));
        let a = codex(&bin.0, &format!("{STARTED}\nif [ $n = 1 ]; then exec sleep 30; fi\n{SAY}\n{DONE}"));
        let stop = Stop::new();
        let s = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            s.stop();
        });
        let at = std::time::Instant::now();
        let out = a.turn(&turn(&folder.0, "prover", Arc::new(Events::default())), &Host::default(), &stop).await.unwrap();
        assert_eq!(out.ended, Ended::Stopped);
        assert!(at.elapsed() < Duration::from_secs(3), "R6: stop ends it promptly");
        let out = a.turn(&turn(&folder.0, "prover", Arc::new(Events::default())), &Host::default(), &Stop::new()).await.unwrap();
        assert!(out.resumed);
        let args = args(&bin.0, 2);
        assert_eq!(&args[..3], ["exec", "resume", "th-1"]);
        assert_eq!(args.last().unwrap(), RESUMED);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b40_codex_without_its_tools_is_a_tools_error() {
        let (bin, folder) = (TempDir::new("cx-bin"), TempDir::new("cx-folder"));
        let a = codex(&bin.0, "echo 'Error: required MCP servers failed to initialize: formalmind' >&2\nexit 1");
        let e = a.turn(&turn(&folder.0, "prover", Arc::new(Events::default())), &Host::default(), &Stop::new()).await.unwrap_err();
        assert_eq!(e, TurnError::NoTools("Codex couldn't connect them".into()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b41_a_codex_usage_limit_pauses() {
        let (bin, folder) = (TempDir::new("cx-bin"), TempDir::new("cx-folder"));
        let a = codex(&bin.0, &format!("{STARTED}\necho '{{\"type\":\"turn.failed\",\"error\":{{\"message\":\"You have hit your usage limit\"}}}}'\nexit 1"));
        let e = a.turn(&turn(&folder.0, "prover", Arc::new(Events::default())), &Host::default(), &Stop::new()).await.unwrap_err();
        assert_eq!(e, TurnError::Paused("Codex stopped: You have hit your usage limit".into()));
    }

    #[test]
    fn config_values_are_toml_strings() {
        assert_eq!(toml("a \"b\"\nc"), "\"a \\\"b\\\"\\nc\"");
        assert_eq!(effort_of("max"), "xhigh");
        assert_eq!(effort_of("low"), "low");
    }
}
