//! The swarm's health log: one line per agent turn in turns.jsonl, in the app's log folder (~/Library/Logs/Formal Mind
//! on macOS), with what the turn did and anything that looks wrong. An anomaly is also said in the session as it
//! happens, and `swarm_health` (the MCP's `mac_get health`) reads the log back. It records counts and outcomes, never
//! the agents' words, the code or the prompts, and it stays on this machine.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

/// The log is moved aside to turns.1.jsonl past this size, so it never grows without bound.
const MAX_BYTES: u64 = 20 * 1024 * 1024;
/// The same tool with the same arguments this many times in one turn is a loop, not work.
const REPEATS: u32 = 8;
/// This many failed `lake build`s in one turn.
const LAKE_FAILS: u32 = 6;

fn log_file() -> PathBuf {
    crate::platform::log_dir().join("turns.jsonl")
}

/// One agent turn, counted as it runs.
pub struct Turn {
    started: Instant,
    at: u64,
    folder: String,
    run: String,
    job: u64,
    role: String,
    item: String,
    provider: String,
    model: String,
    /// The swarm's tools as Claude Code reported them at the start ("connected", "needs-auth", …); None on the API.
    pub tools: Option<String>,
    tool_calls: u32,
    /// Tool calls the agent wrote out as text, which nothing runs.
    text_calls: u32,
    calls: HashMap<String, u32>,
    lake_ok: u32,
    lake_failed: u32,
    /// The context the turn used at its largest, in tokens.
    pub tokens: u64,
}

impl Turn {
    pub fn new(folder: &str, run: &str, job: u64, role: &str, item: &str, provider: &str, model: &str) -> Turn {
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        Turn {
            started: Instant::now(),
            at,
            folder: folder.into(),
            run: run.into(),
            job,
            role: role.into(),
            item: item.into(),
            provider: provider.into(),
            model: model.into(),
            tools: None,
            tool_calls: 0,
            text_calls: 0,
            calls: HashMap::new(),
            lake_ok: 0,
            lake_failed: 0,
            tokens: 0,
        }
    }

    /// A tool the app ran for the agent, and what it answered.
    pub fn tool(&mut self, name: &str, input: &Value, answer: &str) {
        self.tool_calls += 1;
        *self.calls.entry(format!("{name} {input}")).or_default() += 1;
        if name == "run" && input["command"].as_str().is_some_and(|c| c.trim_start().starts_with("lake build")) {
            if answer.starts_with("exit 0") {
                self.lake_ok += 1;
            } else {
                self.lake_failed += 1;
            }
        }
    }

    /// The agent's words: tool calls written out as text there ran nowhere.
    pub fn said(&mut self, text: &str) {
        self.text_calls += (text.matches("<invoke name=").count() + text.matches("<function_calls>").count()) as u32;
    }

    /// What looks wrong with the turn, in words for the session.
    pub fn anomalies(&self, ended: &str) -> Vec<String> {
        let mut out = vec![];
        if let Some(t) = self.tools.as_deref().filter(|t| *t != "connected") {
            out.push(format!("its tools didn't connect (Claude Code reported them {t})"));
        }
        if self.text_calls > 0 {
            out.push(format!("it wrote {} tool calls out as text; none of them ran", self.text_calls));
        }
        if self.tool_calls == 0 && ended == "done" && self.tools.as_deref().is_none_or(|t| t == "connected") {
            out.push("it finished without running a single tool".into());
        }
        if let Some((call, n)) = self.calls.iter().max_by_key(|(_, n)| **n).filter(|(_, n)| **n >= REPEATS) {
            let name = call.split(' ').next().unwrap_or("");
            out.push(format!("it called `{name}` with the same arguments {n} times"));
        }
        if self.lake_failed >= LAKE_FAILS {
            out.push(format!("`lake build` failed {} times", self.lake_failed));
        }
        out
    }

    /// Writes the turn's line; `ended` is "done", "error" or "paused". Returns its anomalies.
    pub fn finish(self, ended: &str, error: Option<&str>) -> Vec<String> {
        let anomalies = self.anomalies(ended);
        let line = json!({
            "at": self.at,
            "version": env!("CARGO_PKG_VERSION"),
            "folder": self.folder,
            "run": self.run,
            "job": self.job,
            "role": self.role,
            "item": self.item,
            "provider": self.provider,
            "model": self.model,
            "tools": self.tools,
            "toolCalls": self.tool_calls,
            "textCalls": self.text_calls,
            "lake": { "ok": self.lake_ok, "failed": self.lake_failed },
            "tokens": self.tokens,
            "seconds": self.started.elapsed().as_secs(),
            "ended": ended,
            "error": error.map(|e| e.chars().take(300).collect::<String>()),
            "anomalies": anomalies,
        });
        append(&line);
        anomalies
    }
}

fn append(line: &Value) {
    use std::io::Write;
    let file = log_file();
    let _ = std::fs::create_dir_all(file.parent().unwrap_or(&file));
    if std::fs::metadata(&file).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&file, file.with_file_name("turns.1.jsonl"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(f, "{line}");
    }
}

/// The newest turns (for one folder, or all), with totals and the anomalies among them: the swarm's health at a glance.
#[tauri::command(async)]
pub fn swarm_health(folder: Option<String>, limit: Option<usize>) -> Result<Value, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let text = std::fs::read_to_string(log_file()).unwrap_or_default();
    let turns: Vec<Value> = text
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|t| folder.as_deref().is_none_or(|f| t["folder"] == f))
        .collect();
    let recent: Vec<&Value> = turns.iter().rev().take(limit).collect();
    let flagged: Vec<&Value> = recent.iter().copied().filter(|t| t["anomalies"].as_array().is_some_and(|a| !a.is_empty())).collect();
    let count = |k: &str| recent.iter().filter(|t| t["ended"] == k).count();
    Ok(json!({
        "log": log_file(),
        "turns": recent.len(),
        "ended": { "done": count("done"), "error": count("error"), "paused": count("paused") },
        "toolCalls": recent.iter().map(|t| t["toolCalls"].as_u64().unwrap_or(0)).sum::<u64>(),
        "flagged": flagged.len(),
        "healthy": flagged.is_empty() && count("error") == 0,
        "anomalies": flagged.iter().map(|t| json!({ "at": t["at"], "role": t["role"], "item": t["item"], "job": t["job"], "anomalies": t["anomalies"] })).collect::<Vec<_>>(),
        "recent": recent.iter().take(20).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blind_turn_is_flagged() {
        let mut t = Turn::new("/f", "swarm", 121, "reviewer", "232", "claude-code", "claude-opus-5-5");
        t.tools = Some("needs-auth".into());
        t.said("<invoke name=\"search\">…</invoke> and <invoke name=\"verdict\">");
        let a = t.anomalies("done");
        assert!(a.iter().any(|x| x.contains("needs-auth")), "{a:?}");
        assert!(a.iter().any(|x| x.contains("2 tool calls out as text")), "{a:?}");
    }

    #[test]
    fn loops_and_failing_builds_are_flagged() {
        let mut t = Turn::new("/f", "swarm", 1, "prover", "3", "claude-code", "m");
        t.tools = Some("connected".into());
        for _ in 0..REPEATS {
            t.tool("read_file", &json!({ "path": "a.lean" }), "x");
        }
        for _ in 0..LAKE_FAILS {
            t.tool("run", &json!({ "command": "lake build" }), "exit 1\nerror: x");
        }
        let a = t.anomalies("done");
        assert!(a.iter().any(|x| x.contains("`read_file`") && x.contains(&REPEATS.to_string())), "{a:?}");
        assert!(a.iter().any(|x| x.contains("lake build")), "{a:?}");
    }

    #[test]
    fn a_working_turn_is_not() {
        let mut t = Turn::new("/f", "swarm", 1, "prover", "3", "claude-code", "m");
        t.tools = Some("connected".into());
        t.tool("run", &json!({ "command": "lake build" }), "exit 0");
        t.said("The proof builds.");
        assert!(t.anomalies("done").is_empty());
    }
}
