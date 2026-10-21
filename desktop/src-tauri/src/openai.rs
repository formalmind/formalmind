//! OpenAI as the swarm's model: the agents' requests are written for the Messages API (system, content blocks,
//! tool_use / tool_result, a PDF as a document block, compaction), so a call on your own OpenAI key is translated to
//! Chat Completions here and the reply translated back. The agent loop, its tools and its context tracking don't change.

use serde_json::{json, Value};

/// The OpenAI models the swarm offers; the first is the default.
pub const MODELS: [&str; 2] = ["gpt-5", "gpt-5-mini"];

/// A content field (a string or text blocks) as plain text.
fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// A user block other than a tool result, as a Chat Completions content part.
fn part(block: &Value) -> Option<Value> {
    match block["type"].as_str()? {
        "text" => Some(json!({ "type": "text", "text": block["text"] })),
        "document" if block["source"]["type"] == "base64" => Some(json!({
            "type": "file",
            "file": {
                "filename": block["title"].as_str().and_then(|t| t.rsplit('/').next()).unwrap_or("document.pdf"),
                "file_data": format!("data:{};base64,{}", block["source"]["media_type"].as_str().unwrap_or("application/pdf"), block["source"]["data"].as_str().unwrap_or("")),
            }
        })),
        "image" if block["source"]["type"] == "base64" => Some(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", block["source"]["media_type"].as_str().unwrap_or("image/png"), block["source"]["data"].as_str().unwrap_or("")) }
        })),
        _ => None,
    }
}

/// A Messages request body as a Chat Completions one. A request carrying `compaction` asks for a summary instead:
/// the summary instructions go last and no tool may be called.
pub fn request(body: &Value) -> Value {
    let mut messages = vec![];
    let system = text_of(&body["system"]);
    if !system.is_empty() {
        messages.push(json!({ "role": "developer", "content": system }));
    }
    for m in body["messages"].as_array().into_iter().flatten() {
        let blocks = match &m["content"] {
            Value::String(s) => vec![json!({ "type": "text", "text": s })],
            Value::Array(b) => b.clone(),
            _ => vec![],
        };
        if m["role"] == "assistant" {
            let mut text = vec![];
            let mut calls = vec![];
            for b in &blocks {
                match b["type"].as_str() {
                    Some("text") => text.push(b["text"].as_str().unwrap_or("").to_string()),
                    // A summary of earlier steps (see `reply`).
                    Some("compaction") => text.push(format!("Summary of the earlier steps:\n{}", b["content"].as_str().unwrap_or(""))),
                    Some("tool_use") => calls.push(json!({ "id": b["id"], "type": "function", "function": { "name": b["name"], "arguments": b["input"].to_string() } })),
                    _ => {}
                }
            }
            let mut msg = json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text.join("\n\n")) } });
            if !calls.is_empty() {
                msg["tool_calls"] = json!(calls);
            }
            messages.push(msg);
        } else {
            // Tool results answer the assistant's calls, so they come first, each as its own message.
            for b in blocks.iter().filter(|b| b["type"] == "tool_result") {
                let out = text_of(&b["content"]);
                messages.push(json!({ "role": "tool", "tool_call_id": b["tool_use_id"], "content": if b["is_error"] == true { format!("error: {out}") } else { out } }));
            }
            let parts: Vec<Value> = blocks.iter().filter(|b| b["type"] != "tool_result").filter_map(part).collect();
            if !parts.is_empty() {
                messages.push(json!({ "role": "user", "content": parts }));
            }
        }
    }
    let compaction = body.get("compaction").is_some();
    if compaction {
        messages.push(json!({ "role": "user", "content": body["compaction"]["instructions"].as_str().unwrap_or("Summarize the conversation so far.") }));
    }
    let mut out = json!({
        "model": body["model"],
        "messages": messages,
        "max_completion_tokens": body["max_tokens"],
    });
    if let Some(effort) = body["output_config"]["effort"].as_str() {
        out["reasoning_effort"] = json!(effort);
    }
    let tools: Vec<Value> = body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| json!({ "type": "function", "function": { "name": t["name"], "description": t["description"], "parameters": t["input_schema"] } }))
        .collect();
    if !tools.is_empty() {
        out["tools"] = json!(tools);
        if compaction {
            out["tool_choice"] = json!("none");
        }
    }
    out
}

/// A Chat Completions reply as a Messages one: text and tool_use blocks, the stop reason and the usage the cost and
/// context tracking read. A summary (`compaction`) comes back as a `compaction` block. Errors pass through as they
/// are (both APIs put the text in `error.message`).
pub fn reply(v: &Value, compaction: bool) -> Value {
    if v.get("error").is_some() {
        return v.clone();
    }
    let choice = &v["choices"][0];
    let msg = &choice["message"];
    let mut content = vec![];
    if let Some(text) = msg["content"].as_str().filter(|t| !t.trim().is_empty()) {
        content.push(if compaction { json!({ "type": "compaction", "content": text }) } else { json!({ "type": "text", "text": text }) });
    }
    for call in msg["tool_calls"].as_array().into_iter().flatten() {
        let input = call["function"]["arguments"].as_str().and_then(|a| serde_json::from_str::<Value>(a).ok()).unwrap_or(json!({}));
        content.push(json!({ "type": "tool_use", "id": call["id"], "name": call["function"]["name"], "input": input }));
    }
    let stop = match choice["finish_reason"].as_str() {
        _ if compaction && !content.is_empty() => "compaction",
        Some("tool_calls") => "tool_use",
        Some("length") => "max_tokens",
        _ => "end_turn",
    };
    let u = &v["usage"];
    let cached = u["prompt_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0);
    let prompt = u["prompt_tokens"].as_u64().unwrap_or(0);
    json!({
        "content": content,
        "stop_reason": stop,
        "usage": {
            "input_tokens": prompt.saturating_sub(cached),
            "cache_read_input_tokens": cached,
            "output_tokens": u["completion_tokens"].as_u64().unwrap_or(0),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tool_step_goes_over_and_back() {
        let body = json!({
            "model": "gpt-5", "max_tokens": 100, "system": "You prove things.",
            "output_config": { "effort": "high" },
            "tools": [{ "name": "read_file", "description": "Read a file", "input_schema": { "type": "object" } }],
            "messages": [
                { "role": "user", "content": "Prove item 3." },
                { "role": "assistant", "content": [{ "type": "thinking", "thinking": "…" }, { "type": "text", "text": "Reading." }, { "type": "tool_use", "id": "t1", "name": "read_file", "input": { "path": "A.sol" } }] },
                { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": [{ "type": "text", "text": "contract A {}" }] }, { "type": "text", "text": "Go on." }] },
            ],
        });
        let r = request(&body);
        assert_eq!(r["messages"][0], json!({ "role": "developer", "content": "You prove things." }));
        assert_eq!(r["messages"][2]["tool_calls"][0]["function"]["arguments"], "{\"path\":\"A.sol\"}");
        assert_eq!(r["messages"][3], json!({ "role": "tool", "tool_call_id": "t1", "content": "contract A {}" }));
        assert_eq!(r["messages"][4]["content"][0]["text"], "Go on.");
        assert_eq!((r["reasoning_effort"].as_str(), r["max_completion_tokens"].as_u64()), (Some("high"), Some(100)));
        assert_eq!(r["tools"][0]["function"]["name"], "read_file");

        let back = reply(
            &json!({
                "choices": [{ "finish_reason": "tool_calls", "message": { "content": null, "tool_calls": [{ "id": "t2", "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"B.sol\"}" } }] } }],
                "usage": { "prompt_tokens": 1000, "completion_tokens": 50, "prompt_tokens_details": { "cached_tokens": 800 } },
            }),
            false,
        );
        assert_eq!(back["stop_reason"], "tool_use");
        assert_eq!(back["content"][0], json!({ "type": "tool_use", "id": "t2", "name": "read_file", "input": { "path": "B.sol" } }));
        assert_eq!(back["usage"], json!({ "input_tokens": 200, "cache_read_input_tokens": 800, "output_tokens": 50 }));
    }

    #[test]
    fn a_summary_round_trips_as_a_compaction_block() {
        let body = json!({ "model": "gpt-5", "max_tokens": 100, "messages": [{ "role": "user", "content": "x" }], "tools": [{ "name": "a", "input_schema": {} }], "compaction": { "type": "summarize", "instructions": "Summarize." } });
        let r = request(&body);
        assert_eq!(r["messages"].as_array().unwrap().last().unwrap()["content"], "Summarize.");
        assert_eq!(r["tool_choice"], "none");
        let back = reply(&json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "Did A, B." } }], "usage": {} }), true);
        assert_eq!((back["stop_reason"].as_str(), back["content"][0]["type"].as_str()), (Some("compaction"), Some("compaction")));
        // The summary goes back as text at the head of the next request.
        let next = request(&json!({ "model": "gpt-5", "messages": [{ "role": "assistant", "content": back["content"] }] }));
        assert_eq!(next["messages"][0]["content"], "Summary of the earlier steps:\nDid A, B.");
    }
}
