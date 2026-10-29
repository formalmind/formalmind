//! The agents on Codex: `codex exec` with your own ChatGPT plan (Pro, Plus, or whatever `codex` is logged in to),
//! instead of an OpenAI key. It mirrors claude_code.rs: the swarm's roles run with their own prompt and their own
//! tools, served by the swarm's loop over the same Bridge (claude_code::bridge), and Codex's JSONL events become the
//! session's events. The run's own state (the role's instructions, the Codex thread id, the raw stream and stderr)
//! lives in ~/.formalmind/codex/, not in the project.

use serde_json::Value;
use std::path::PathBuf;

/// The ChatGPT-plan models Codex offers, the first the default.
pub const MODELS: [&str; 4] = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

/// Codex's own tools the roles don't get: the swarm's tools are the only way they act, as on the API.
const DISABLED: [&str; 15] = [
    "shell_tool", "apps", "browser_use", "browser_use_external", "in_app_browser", "computer_use", "image_generation",
    "multi_agent", "multi_agent_v2", "plugins", "skill_search", "hooks", "goals", "memories", "fast_mode",
];

/// The `codex` binary: the tool folders first (a GUI app's PATH doesn't have ~/.local/bin), then PATH.
fn codex() -> PathBuf {
    crate::platform::find_tool("codex")
}

/// Whether Codex is installed and signed in with ChatGPT: its version and what it bills (for Settings).
#[tauri::command(async)]
pub fn codex_status() -> Result<String, String> {
    let out = std::process::Command::new(codex()).arg("--version").env("PATH", crate::platform::tool_path(None)).output().map_err(|_| "Codex isn't installed (`npm install -g @openai/codex`)".to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().trim_start_matches("codex-cli").trim().to_string();
    Ok(format!("Codex {version} · {}", signed_in()?))
}

/// What `codex login status` says, as the app runs it (no OPENAI_API_KEY). The sign-in is Codex's own (`codex login`):
/// the app never sees or keeps its credentials.
pub fn signed_in() -> Result<String, String> {
    let out = std::process::Command::new(codex())
        .args(["login", "status"])
        .env("PATH", crate::platform::tool_path(None))
        .env_remove("OPENAI_API_KEY")
        .output()
        .map_err(|_| "Codex isn't installed (`npm install -g @openai/codex`)".to_string())?;
    billing_of(&format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

fn billing_of(status: &str) -> Result<String, String> {
    if status.contains("ChatGPT") && status.contains("Logged in") {
        Ok("signed in to your ChatGPT plan".into())
    } else if status.contains("Logged in") {
        // An API key saved in Codex: it would bill that key, not your plan.
        Err("Codex is signed in with an API key, not ChatGPT: run `codex login` and pick Sign in with ChatGPT".into())
    } else {
        Err("Codex isn't signed in: run `codex login` in a terminal and sign in with ChatGPT".into())
    }
}

/// A run's state folder under `base` (~/.formalmind): codex/<project>-<hash>/<session>/.
fn state_dir_in(base: &std::path::Path, root: &std::path::Path, run: &str) -> PathBuf {
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "project".into());
    base.join("codex").join(format!("{name}-{:08x}", crate::claude_code::fnv(root.to_string_lossy().as_bytes()))).join(run)
}

/// A TOML string for a `-c key=value` (JSON's escapes are TOML's).
fn toml(s: &str) -> String {
    Value::String(s.to_string()).to_string()
}

/// Settings' effort as Codex's reasoning effort (it has no "max").
fn effort_of(e: &str) -> &str {
    if e == "max" { "xhigh" } else { e }
}

/// One swarm agent's turn on Codex, started: the role's own instructions in place of Codex's, and only the role's own
/// tools, served over a Bridge. Your Codex config, rules, skills and plugins don't reach it; the sandbox is read-only,
/// so anything it writes goes through the swarm's tools. Its JSONL lines are read with `lines`.
pub struct RoleRun {
    pub child: tokio::process::Child,
    pub lines: tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    /// Where the run's stream and stderr are kept (~/.formalmind/codex/…).
    pub state: PathBuf,
    /// The job's thread was already there and is being continued (the app quit mid-job).
    pub resumed: bool,
    log: std::fs::File,
}

impl RoleRun {
    /// Codex has started the job's thread: a quit from here on resumes it.
    pub fn started(&self, job: u64, thread: &str) {
        let _ = std::fs::write(self.state.join(format!("job-{job}.thread")), thread);
    }

    pub fn log(&mut self, line: &str) {
        use std::io::Write;
        let _ = writeln!(self.log, "{line}");
    }

    /// Why it exited, from the end of its stderr.
    pub fn stderr_tail(&self) -> String {
        let err = std::fs::read_to_string(self.state.join("stderr.log")).unwrap_or_default();
        let err: String = err.lines().filter(|l| !l.starts_with("Reading additional input")).collect::<Vec<_>>().join("\n");
        let tail: String = err.trim().chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
        format!("{tail} (logs in {})", self.state.display())
    }
}

pub fn start_role(folder: &str, run: &str, job: u64, system: &str, task: &Value, model: &str, bridge: &crate::claude_code::Bridge) -> Result<RoleRun, String> {
    use tokio::io::AsyncBufReadExt;
    let root = std::fs::canonicalize(folder).map_err(|e| format!("{folder}: {e}"))?;
    let state = state_dir_in(&crate::local::home()?, &root, run);
    std::fs::create_dir_all(&state).map_err(|e| format!("{}: {e}", state.display()))?;
    let instructions = state.join("instructions.md");
    // Codex tells the model its sandbox is read-only, and a model then concludes it can't write at all; the swarm's own
    // tools (write_file, run, report_bug) write and run through the app, outside that sandbox.
    let system = format!("{system}\n\nYour own shell sandbox is read-only on purpose: write files only with the formalmind write_file tool, run lake and forge only with its run tool, and file bugs with report_bug. Those work; never say writing is blocked.");
    std::fs::write(&instructions, &system).map_err(|e| format!("{}: {e}", instructions.display()))?;
    let saved = std::fs::read_to_string(state.join(format!("job-{job}.thread"))).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let resumed = saved.is_some();
    // Codex takes text: a task's document blocks (a report's PDF) go in as the text beside them.
    let prompt = if resumed {
        "The app quit and this job is being resumed. Carry on from where you were; don't redo finished work.".to_string()
    } else {
        match task {
            Value::String(t) => t.clone(),
            Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n\n"),
            other => other.to_string(),
        }
    };
    let open_log = |name: &str| std::fs::OpenOptions::new().create(true).append(true).open(state.join(name)).map_err(|e| format!("{name}: {e}"));
    let mut cmd = tokio::process::Command::new(codex());
    cmd.current_dir(&root).arg("exec");
    if let Some(thread) = &saved {
        cmd.args(["resume", thread.as_str()]);
    }
    cmd.args(["--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-m", model]);
    for f in DISABLED {
        cmd.args(["--disable", f]);
    }
    let mut config = vec![
        format!("model_instructions_file={}", toml(&instructions.to_string_lossy())),
        "sandbox_mode=\"read-only\"".into(),
        "approval_policy=\"never\"".into(),
        "web_search=\"disabled\"".into(),
        "include_apply_patch_tool=false".into(),
        "tools.view_image=false".into(),
        "skills.include_instructions=false".into(),
        format!("mcp_servers.formalmind.url={}", toml(&bridge.url)),
        "mcp_servers.formalmind.bearer_token_env_var=\"FORMALMIND_MCP_TOKEN\"".into(),
        // Without its tools the agent can't do the job: Codex stops at once instead of working without them.
        "mcp_servers.formalmind.required=true".into(),
        "mcp_servers.formalmind.default_tools_approval_mode=\"approve\"".into(),
        // `lake build` on a big model takes a while; the tool call waits for it.
        "mcp_servers.formalmind.tool_timeout_sec=7200".into(),
        // Codex compacts its own thread past this, as the API route does; it has no limit for a model it doesn't know.
        format!("model_auto_compact_token_limit={}", crate::swarm::compact_limit(model)),
    ];
    // Thinking effort from Settings (the chat's picker), read at each turn so a change applies to the next one.
    if let Some(e) = crate::local::read().ok().and_then(|c| c.settings.effort()) {
        config.push(format!("model_reasoning_effort={}", toml(effort_of(&e))));
    }
    for c in config {
        cmd.args(["-c", &c]);
    }
    cmd.arg(&prompt)
        .env("PATH", crate::platform::tool_path(None))
        .env("PWD", &root)
        .env("FORMALMIND_MCP_TOKEN", &bridge.token)
        // Your ChatGPT plan, not an API key that happens to be in the environment.
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::from(open_log("stderr.log")?))
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start Codex ({}): {e}", codex().display()))?;
    let lines = tokio::io::BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();
    let log = open_log("stream.jsonl")?;
    Ok(RoleRun { child, lines, state, resumed, log })
}

/// One answer from Codex with no tools (a drafted message), on your ChatGPT plan.
pub async fn ask(folder: &str, system: &str, prompt: &str, model: &str) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(codex());
    cmd.current_dir(folder).args(["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-m", model]);
    for f in DISABLED {
        cmd.args(["--disable", f]);
    }
    for c in ["sandbox_mode=\"read-only\"", "web_search=\"disabled\"", "include_apply_patch_tool=false", "skills.include_instructions=false"] {
        cmd.args(["-c", c]);
    }
    let out = cmd
        .args(["-c", &format!("developer_instructions={}", toml(system))])
        .arg(prompt)
        .env("PATH", crate::platform::tool_path(None))
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("couldn't start Codex ({}): {e}", codex().display()))?;
    let mut text = None;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(e) = failure_of(&v) {
            return Err(e);
        }
        if let Some(t) = said(&v) {
            text = Some(t);
        }
    }
    text.ok_or_else(|| format!("Codex: {}", String::from_utf8_lossy(&out.stderr).lines().filter(|l| !l.starts_with("Reading additional input")).collect::<Vec<_>>().join("\n").trim()))
}

/// What the agent said, from an `item.completed` agent message.
pub fn said(line: &Value) -> Option<String> {
    (line["type"] == "item.completed" && line["item"]["type"] == "agent_message").then(|| line["item"]["text"].as_str().unwrap_or("").trim().to_string()).filter(|t| !t.is_empty())
}

/// Why a turn failed (a usage limit says when it resets), from a `turn.failed` or `error` line.
pub fn failure_of(line: &Value) -> Option<String> {
    let why = match line["type"].as_str() {
        Some("turn.failed") => line["error"]["message"].as_str(),
        Some("error") => line["message"].as_str(),
        _ => None,
    }?;
    Some(format!("Codex stopped: {why}"))
}

/// The context a turn used, from `turn.completed`'s usage.
pub fn context_used(line: &Value) -> u64 {
    if line["type"] != "turn.completed" {
        return 0;
    }
    let u = &line["usage"];
    u["input_tokens"].as_u64().unwrap_or(0) + u["output_tokens"].as_u64().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn signed_in_needs_chatgpt() {
        assert_eq!(billing_of("Logged in using ChatGPT\n").unwrap(), "signed in to your ChatGPT plan");
        assert!(billing_of("Logged in using an API key - sk-…").unwrap_err().contains("Sign in with ChatGPT"));
        assert!(billing_of("Not logged in").unwrap_err().contains("codex login"));
    }

    #[test]
    fn jsonl_lines_are_read() {
        assert_eq!(said(&json!({ "type": "item.completed", "item": { "type": "agent_message", "text": " Coverage first. " } })).as_deref(), Some("Coverage first."));
        assert_eq!(said(&json!({ "type": "item.completed", "item": { "type": "mcp_tool_call" } })), None);
        assert!(failure_of(&json!({ "type": "turn.failed", "error": { "message": "You've hit your usage limit" } })).unwrap().contains("usage limit"));
        assert_eq!(context_used(&json!({ "type": "turn.completed", "usage": { "input_tokens": 100, "output_tokens": 5 } })), 105);
    }

    #[test]
    fn config_values_are_toml_strings() {
        assert_eq!(toml("a \"b\"\nc"), "\"a \\\"b\\\"\\nc\"");
        assert_eq!(effort_of("max"), "xhigh");
        assert_eq!(effort_of("low"), "low");
    }

    #[test]
    fn state_lives_under_formalmind_codex() {
        let a = state_dir_in(std::path::Path::new("/home/me/.formalmind"), std::path::Path::new("/work/contracts"), "swarm");
        assert!(a.to_string_lossy().starts_with("/home/me/.formalmind/codex/contracts-"), "{}", a.display());
    }
}
