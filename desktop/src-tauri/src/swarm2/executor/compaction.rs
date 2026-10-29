//! B37's arithmetic: how full a window is, where to cut a conversation, how the summary is spliced in, and what a
//! call cost. The calls themselves are the API route's.
//!
//! Past [`COMPACT_AT`] of the window the older steps are summarized by the compaction beta: the summary (a
//! `compaction` block) goes first as an assistant message, the last [`KEEP_STEPS`] steps follow unchanged, and the task
//! is restated on the last user turn, since a summary can't carry a document.

use serde_json::{json, Value};

pub const BETA: &str = "compact-2026-09-04";
pub const COMPACT_AT: f64 = 0.75;
pub const KEEP_STEPS: usize = 3;
/// Tries at summarizing, each on an earlier cut when the summarizer itself overflows.
pub const TRIES: usize = 4;

pub const INSTRUCTIONS: &str = "Summarize this agent's work so far so it can carry on without the earlier steps: what the task is, \
what it has read and learned (names, files, line numbers), what it wrote and where, what it ran and what came back \
(errors verbatim), what it decided and why, and what is left to do. Keep exact identifiers, paths and Lean names.";

/// The context window: 1M for Claude (Opus, Sonnet, Haiku 5.5), 400k for `gpt-*`.
pub fn window(model: &str) -> u64 {
    if model.starts_with("gpt-") { 400_000 } else { 1_000_000 }
}

/// Where a conversation is compacted (R7: Codex is told this as `model_auto_compact_token_limit`).
pub fn compact_limit(model: &str) -> u64 {
    (window(model) as f64 * COMPACT_AT) as u64
}

/// What the next request carries: the reply's whole input (cached or not) plus the reply.
pub fn context_used(usage: &Value) -> u64 {
    ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].iter().map(|k| usage[*k].as_u64().unwrap_or(0)).sum()
}

/// A failed call that failed because the conversation no longer fits.
pub fn too_long(status: u16, message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    status == 413 || (status == 400 && (m.contains("too long") || m.contains("context window") || m.contains("maximum context")))
}

/// A reply (or an error) saying the conversation no longer fits.
pub fn overflowed(status: u16, reply: &Value) -> bool {
    if status < 300 {
        reply["stop_reason"] == "model_context_window_exceeded"
    } else {
        too_long(status, reply["error"]["message"].as_str().unwrap_or("")) || reply["error"]["code"] == "context_length_exceeded"
    }
}

pub fn has_compaction(messages: &[Value]) -> bool {
    messages.iter().any(|m| m["content"].as_array().is_some_and(|c| c.iter().any(|b| b["type"] == "compaction")))
}

/// Indices where a cut may fall: an assistant reply right after a user turn, so every tool_use keeps its tool_result
/// on the same side.
fn cuts(messages: &[Value], below: usize) -> impl DoubleEndedIterator<Item = usize> + '_ {
    (2..below.min(messages.len())).filter(move |&i| messages[i]["role"] == "assistant" && messages[i - 1]["role"] == "user")
}

/// The cut keeping the last `keep` steps: `messages[..cut]` is summarized. None when there is no step to keep.
pub fn cut(messages: &[Value], keep: usize) -> Option<usize> {
    let all: Vec<usize> = cuts(messages, messages.len()).collect();
    (!all.is_empty()).then(|| all[all.len().saturating_sub(keep.max(1))])
}

/// An earlier cut, about half of `cut`, for when `messages[..cut]` is too long for the summarizer.
pub fn earlier_cut(messages: &[Value], cut: usize) -> Option<usize> {
    cuts(messages, cut / 2 + 1).next_back()
}

/// The conversation after compaction: summary, kept steps, and the task restated on the last user turn.
pub fn splice(messages: &[Value], cut: usize, summary: Value, task: &Value) -> Vec<Value> {
    let mut out = vec![json!({ "role": "assistant", "content": summary })];
    out.extend(messages[cut.min(messages.len())..].iter().cloned());
    let mut restated = vec![json!({ "type": "text", "text": "The earlier steps of this job were summarized above. Your task, as first given:" })];
    match task {
        Value::Array(blocks) => restated.extend(blocks.iter().cloned()),
        Value::String(s) => restated.push(json!({ "type": "text", "text": s })),
        other => restated.push(json!({ "type": "text", "text": other.to_string() })),
    }
    match out.last_mut() {
        Some(last) if last["role"] == "user" => {
            let mut content = match last["content"].take() {
                Value::Array(c) => c,
                Value::String(s) => vec![json!({ "type": "text", "text": s })],
                _ => vec![],
            };
            content.extend(restated);
            last["content"] = Value::Array(content);
        }
        _ => out.push(json!({ "role": "user", "content": restated })),
    }
    out
}

/// Dollars for a call at list price (per million: input, output, cache read; cache writes 1.25× input). A compaction
/// call bills its `usage.iterations`; when they list the message itself they are the whole bill.
pub fn cost(model: &str, usage: &Value) -> f64 {
    let (inp, out, read) = match model {
        "gpt-5-mini" => (0.25, 2.0, 0.025),
        m if m.starts_with("gpt-") => (1.25, 10.0, 0.125),
        m if m.contains("haiku") => (0.1, 0.5, 0.01),
        m if m.contains("sonnet") => (2.0, 10.0, 0.2),
        _ => (4.0, 20.0, 0.2),
    };
    let one = |u: &Value| {
        let n = |k: &str| u[k].as_f64().unwrap_or(0.0);
        (n("input_tokens") * inp + n("cache_creation_input_tokens") * inp * 1.25 + n("cache_read_input_tokens") * read + n("output_tokens") * out) / 1e6
    };
    let iterations = usage["iterations"].as_array().cloned().unwrap_or_default();
    let listed = iterations.iter().any(|i| i["type"] == "message");
    iterations.iter().map(one).sum::<f64>() + if listed { 0.0 } else { one(usage) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The task, then `steps` tool steps (assistant tool_use, user tool_result).
    fn conversation(steps: usize) -> Vec<Value> {
        let mut m = vec![json!({ "role": "user", "content": "task" })];
        for i in 0..steps {
            m.push(json!({ "role": "assistant", "content": [{ "type": "tool_use", "id": format!("t{i}"), "name": "x", "input": {} }] }));
            m.push(json!({ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": format!("t{i}"), "content": "ok" }] }));
        }
        m
    }

    #[test]
    fn b37_cuts_keep_the_last_three_steps_with_their_results() {
        let m = conversation(6);
        let c = cut(&m, KEEP_STEPS).unwrap();
        assert_eq!(c, 7, "steps 4–6 kept");
        let out = splice(&m, c, json!([{ "type": "compaction", "content": "S" }]), &json!("task"));
        assert_eq!(out[0]["content"][0]["type"], "compaction");
        assert_eq!(out[1]["content"][0]["type"], "tool_use");
        assert_eq!(out[2]["content"][0]["tool_use_id"], out[1]["content"][0]["id"]);
        assert_eq!(out.last().unwrap()["content"].as_array().unwrap().last().unwrap()["text"], "task", "the task restated");
        assert!(has_compaction(&out));
        let e = earlier_cut(&m, c).unwrap();
        assert!(e < c && m[e]["role"] == "assistant" && m[e - 1]["role"] == "user");
        assert_eq!(cut(&conversation(1), KEEP_STEPS), None, "nothing before the only step");
    }

    #[test]
    fn b37_the_limit_is_three_quarters_of_the_window() {
        assert_eq!(compact_limit("claude-opus-5-5"), 750_000);
        assert_eq!(compact_limit("gpt-6-astra"), 300_000);
        assert_eq!(context_used(&json!({ "input_tokens": 1, "cache_creation_input_tokens": 2, "cache_read_input_tokens": 3, "output_tokens": 4 })), 10);
        assert!(too_long(413, ""));
        assert!(too_long(400, "prompt is too long: 1200000 tokens > 1000000 maximum"));
        assert!(!too_long(400, "bad request"));
        assert!(overflowed(200, &json!({ "stop_reason": "model_context_window_exceeded" })));
    }

    #[test]
    fn b37_compaction_cost_counts_iterations() {
        let c = json!({ "input_tokens": 0, "output_tokens": 0, "iterations": [{ "type": "compaction", "input_tokens": 1_000_000, "output_tokens": 0 }] });
        assert!((cost("claude-opus-5-5", &c) - 4.0).abs() < 1e-9);
        let both = json!({ "input_tokens": 9, "iterations": [{ "type": "message", "input_tokens": 1_000_000 }] });
        assert!((cost("claude-opus-5-5", &both) - 4.0).abs() < 1e-9, "listed message: top level not added");
    }
}
