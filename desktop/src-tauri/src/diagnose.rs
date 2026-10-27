//! Why an item of the swarm's work is blocked, read from its sessions' logs (`.formal/runs/<run>.jsonl`): the last
//! build's errors, what the prover last said, and whether the cause is the proof itself, another file, or the app.

use serde_json::{json, Value};
use std::path::Path;

/// The events of one item (a plan item's number, or a statement's obligation such as `S-01.2`) across the folder's
/// sessions, oldest first.
pub fn events_of(root: &Path, item: &str) -> Vec<Value> {
    let mut out: Vec<Value> = vec![];
    let dir = root.join(".formal").join("runs");
    for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
        out.extend(text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|e| e["item"].as_str() == Some(item)));
    }
    out.sort_by_key(|e| e["at"].as_u64().unwrap_or(0));
    out
}

/// The diagnosis from an item's events: `cause` is one of "proof" (Lean rejects the proof), "other file" (the build
/// broke on a file this item didn't write), "app" (the proof builds but Formal Mind refused it), or "unknown".
pub fn diagnose(item: &str, events: &[Value]) -> Value {
    let text = |e: &Value| e["text"].as_str().unwrap_or("").to_string();
    let last_block = events.iter().rposition(|e| e["kind"] == "plan" && text(e).contains("blocked"));
    let upto = &events[..last_block.map_or(events.len(), |i| i + 1)];
    let built_ok = upto.iter().any(|e| e["kind"] == "result" && text(e).starts_with("exit 0") && text(e).contains("Build completed"));
    let errors: Vec<String> = upto
        .iter()
        .rev()
        .filter(|e| e["kind"] == "result" && !text(e).starts_with("exit 0"))
        .take(1)
        .flat_map(|e| text(e).lines().filter(|l| l.contains("error")).map(String::from).collect::<Vec<_>>())
        .collect();
    let written: Vec<String> = upto
        .iter()
        .filter(|e| e["kind"] == "tool" && text(e).starts_with("write_file"))
        .filter_map(|e| text(e).split_whitespace().nth(1).map(String::from))
        .collect();
    let refused = upto.iter().rev().find(|e| e["kind"] == "result" && text(e).contains("No Lean file was written")).is_some();
    let errored_files: Vec<String> = errors.iter().filter_map(|l| l.split_whitespace().find(|w| w.contains(".lean:")).map(|w| w.split(".lean:").next().unwrap_or("").to_string() + ".lean")).collect();
    let (cause, why) = if errors.iter().any(|l| l.contains("expected a `Name`") || l.contains("«»")) {
        ("app", "a file's name isn't a valid Lean module name (the receive/fallback's `«»`), so every lake build fails before reading it")
    } else if refused {
        ("app", "the proof was already in place and this turn didn't rewrite it, so the app refused it as \"no Lean file was written\"")
    } else if !errored_files.is_empty() && errored_files.iter().all(|f| !written.iter().any(|w| w.ends_with(f.as_str()) || f.ends_with(w.as_str()))) {
        ("other file", "the build broke on a file this item didn't write (another agent's unfinished proof, or a stray file)")
    } else if !errors.is_empty() {
        ("proof", "Lean rejects the proof; the errors say where")
    } else if built_ok && last_block.is_some() {
        ("app", "the item's own module builds, yet the app's check failed: a full lake build broken elsewhere, or a check after the build (the theorem's name or file)")
    } else {
        ("unknown", "nothing in the log explains it")
    };
    let last_say = upto.iter().rev().find(|e| e["kind"] == "say").map(|e| text(e).chars().take(1200).collect::<String>());
    json!({
        "item": item,
        "blocked": last_block.is_some(),
        "cause": cause,
        "why": why,
        "errors": errors.iter().take(12).collect::<Vec<_>>(),
        "filesWritten": written,
        "builtOnItsOwn": built_ok,
        "proverSaid": last_say,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: &str, text: &str) -> Value {
        json!({ "kind": kind, "text": text, "item": "S-01.2" })
    }

    #[test]
    fn causes() {
        let name = [ev("result", "exit 1\nerror: Refinement/Statements/S01/WETH9«».lean: ModuleSetup.name: expected a `Name`"), ev("plan", "item S-01.2 blocked: the proof didn't check after 3 attempts")];
        assert_eq!(diagnose("S-01.2", &name)["cause"], "app");
        let untouched = [ev("result", "exit 0\nBuild completed successfully (6 jobs)."), ev("result", "No Lean file was written for this item; write the proof with write_file."), ev("plan", "item S-03.1 blocked: x")];
        assert!(diagnose("S-03.1", &untouched)["why"].as_str().unwrap().contains("didn't rewrite"));
        let other = [ev("tool", "write_file formal/Refinement/Statements/S02/WETH9Approve.lean"), ev("result", "exit 1\nerror: Refinement/Statements/S03/WETH9TransferFrom.lean:15:13: Unknown identifier"), ev("plan", "item S-02.1 blocked: x")];
        assert_eq!(diagnose("S-02.1", &other)["cause"], "other file");
        let proof = [ev("tool", "write_file formal/Refinement/Swarm/WETH9Deposit.lean"), ev("result", "exit 1\nerror: Refinement/Swarm/WETH9Deposit.lean:9:2: unsolved goals"), ev("plan", "item 3 blocked: x")];
        assert_eq!(diagnose("3", &proof)["cause"], "proof");
        assert_eq!(diagnose("9", &[])["cause"], "unknown");
    }
}
