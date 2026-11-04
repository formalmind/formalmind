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

/// A TOML string for a `-c key=value` (JSON's escapes are TOML's).
fn toml(s: &str) -> String {
    Value::String(s.to_string()).to_string()
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
    }

    #[test]
    fn config_values_are_toml_strings() {
        assert_eq!(toml("a \"b\"\nc"), "\"a \\\"b\\\"\\nc\"");
    }

}
