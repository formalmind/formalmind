//! B35–B37, B42 on the API: a tool loop against the Messages API (Anthropic, or formal.team's metered proxy) or Chat
//! Completions (OpenAI, translated by `crate::openai`), with prompt caching, the conversation saved after every step
//! (`.formal/jobs/…`, resumed after a quit) and compaction past 75% of the window.

use super::compaction::{self as c, BETA};
use super::{Agent, BoxFuture, Ended, Outcome, Stop, ToolHost, Turn, TurnError};
use crate::swarm2::events::Kind;
use crate::swarm2::queue;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
pub const MAX_TOKENS: u64 = 16_000;
pub const PROVER_STEPS: usize = 90;
pub const STEPS: usize = 40;

/// The wire format.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wire {
    /// `POST {base}/v1/messages` (Anthropic, and formal.team's proxy).
    Messages,
    /// `POST {base}/v1/chat/completions` (OpenAI).
    ChatCompletions,
}

/// Where the key comes from.
#[derive(Clone, Debug)]
pub enum Access {
    /// Your own key from the keychain (`https://api.anthropic.com` / `https://api.openai.com`).
    Key { key: String, base: String },
    /// formal.team credits: `POST {api}/api/desktop/model-session` with the session token → `{key, base_url}`.
    Session { api: String, token: String },
}

pub struct ApiAgent {
    pub wire: Wire,
    pub access: Access,
    pub model: String,
    client: reqwest::Client,
}

impl ApiAgent {
    pub fn new(wire: Wire, access: Access, model: Option<&str>) -> Self {
        ApiAgent { wire, access, model: model.unwrap_or(DEFAULT_MODEL).to_string(), client: reqwest::Client::new() }
    }

    async fn key(&self, turn: &Turn) -> Result<(String, String), String> {
        match &self.access {
            Access::Key { key, base } => Ok((key.clone(), base.clone())),
            Access::Session { api, token } => {
                let folder = turn.folder.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let res = self
                    .client
                    .post(format!("{api}/api/desktop/model-session"))
                    .bearer_auth(token)
                    .json(&json!({ "folder": folder, "run": turn.run, "role": turn.role, "ref": turn.item }))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                let ok = res.status().is_success();
                let body: Value = res.json().await.unwrap_or(json!({}));
                if !ok {
                    return Err(body["error"].as_str().unwrap_or("formal.team refused the model session").to_string());
                }
                Ok((body["key"].as_str().unwrap_or("").to_string(), body["base_url"].as_str().unwrap_or("").to_string()))
            }
        }
    }

    /// A request: the step itself, or (with `compaction`) the summary of `messages`.
    fn body(&self, turn: &Turn, messages: &[Value], compaction: Option<Value>) -> Value {
        let mut body = json!({
            "model": self.model, "max_tokens": MAX_TOKENS, "system": turn.system,
            "messages": messages, "tools": turn.tools,
            // The stable prefix (system, tools, history) is read back from the cache each step.
            "cache_control": { "type": "ephemeral" },
            "output_config": { "effort": if turn.role == "prover" { "high" } else { "medium" } },
        });
        if let Some(c) = compaction {
            body["compaction"] = c;
        }
        body
    }

    /// One call: the HTTP status and the reply as Messages, an error as `{error: {message}}`.
    async fn call(&self, key: &str, base: &str, body: &Value) -> Result<(u16, Value), String> {
        let summarizing = body.get("compaction").is_some();
        let req = match self.wire {
            Wire::ChatCompletions => self.client.post(format!("{base}/v1/chat/completions")).bearer_auth(key).json(&crate::openai::request(body)),
            Wire::Messages => {
                let mut r = self.client.post(format!("{base}/v1/messages")).header("x-api-key", key).header("anthropic-version", "2023-06-01");
                if summarizing || body["messages"].as_array().is_some_and(|m| c::has_compaction(m)) {
                    r = r.header("anthropic-beta", BETA);
                }
                r.json(body)
            }
        };
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let text = res.text().await.map_err(|e| e.to_string())?;
        let reply = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({ "error": { "message": text.trim() } }));
        Ok((status, if self.wire == Wire::ChatCompletions { crate::openai::reply(&reply, summarizing) } else { reply }))
    }

    /// `/v1/messages/count_tokens` (free); None on OpenAI or when it fails.
    async fn count(&self, key: &str, base: &str, body: &Value) -> Option<u64> {
        if self.wire != Wire::Messages {
            return None;
        }
        let mut r = self.client.post(format!("{base}/v1/messages/count_tokens")).header("x-api-key", key).header("anthropic-version", "2023-06-01");
        if body["messages"].as_array().is_some_and(|m| c::has_compaction(m)) {
            r = r.header("anthropic-beta", BETA);
        }
        let res = r.json(body).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        res.json::<Value>().await.ok()?["input_tokens"].as_u64()
    }

    /// B42: system, tools and task as differences of three counts; zeros where a count fails.
    async fn measure(&self, key: &str, base: &str, turn: &Turn) -> (u64, u64, u64) {
        let probe = json!([{ "role": "user", "content": "." }]);
        let Some(sys) = self.count(key, base, &json!({ "model": self.model, "system": turn.system, "messages": probe })).await else { return (0, 0, 0) };
        let tools = self.count(key, base, &json!({ "model": self.model, "system": turn.system, "tools": turn.tools, "messages": probe })).await.unwrap_or(sys);
        let task = self.count(key, base, &json!({ "model": self.model, "system": turn.system, "tools": turn.tools, "messages": [{ "role": "user", "content": turn.task }] })).await.unwrap_or(tools);
        (sys, tools.saturating_sub(sys), task.saturating_sub(tools))
    }

    fn charge(&self, turn: &Turn, out: &mut Outcome, usage: &Value) {
        let d = c::cost(&self.model, usage);
        out.spent += d;
        turn.events.spend(d);
    }

    /// Summarizes the older steps in place. Ok(false) when stopped.
    async fn compact(&self, key: &str, base: &str, turn: &Turn, messages: &mut Vec<Value>, stop: &Stop, out: &mut Outcome) -> Result<bool, String> {
        let mut cut = c::cut(messages, c::KEEP_STEPS).unwrap_or(messages.len());
        for _ in 0..c::TRIES {
            turn.emit(Kind::Status, format!("compacting: summarizing {cut} of {} messages", messages.len()));
            let body = self.body(turn, &messages[..cut], Some(json!({ "type": "summarize", "instructions": c::INSTRUCTIONS })));
            let Some(r) = stop.race(self.call(key, base, &body)).await else { return Ok(false) };
            let (status, reply) = r?;
            if status < 300 {
                self.charge(turn, out, &reply["usage"]);
            }
            let why = reply["stop_reason"].as_str().unwrap_or("");
            if status < 300 && why == "compaction" {
                let kept = messages.len() - cut;
                *messages = c::splice(messages, cut, reply["content"].clone(), &turn.task);
                turn.emit(Kind::Tool, format!("compact: the earlier steps summarized, the last {kept} messages kept"));
                return Ok(true);
            }
            if !c::overflowed(status, &reply) {
                return Err(if status < 300 { format!("no summary came back ({why})") } else { reply["error"]["message"].as_str().unwrap_or("the compaction call failed").to_string() });
            }
            cut = c::earlier_cut(messages, cut).ok_or("the conversation is too long to summarize")?;
        }
        Err("the conversation is too long to summarize".into())
    }

    async fn run(&self, turn: &Turn, tools: &dyn ToolHost, stop: &Stop) -> Result<Outcome, TurnError> {
        let mut out = Outcome::default();
        let stopped = |mut out: Outcome| {
            out.ended = Ended::Stopped;
            Ok(out)
        };
        let Some(access) = stop.race(self.key(turn)).await else { return stopped(out) };
        let (key, base) = access?;
        // B36: the conversation is on disk after every step; a quit resumes it.
        let saved = queue::load_transcript(&turn.folder, &turn.run, turn.job).filter(|m| !m.is_empty());
        out.resumed = saved.is_some();
        let mut messages = saved.map(queue::resume_transcript).unwrap_or_else(|| vec![json!({ "role": "user", "content": turn.task })]);
        let keep = |m: &[Value]| {
            let _ = queue::save_transcript(&turn.folder, &turn.run, turn.job, m);
        };
        keep(&messages);
        turn.emit(Kind::Status, format!("{} is working", turn.role));
        let Some(fixed) = stop.race(self.measure(&key, &base, turn)).await else { return stopped(out) };
        let (k, b) = (key.as_str(), base.as_str());
        let recount = |messages: Vec<Value>| async move { self.count(k, b, &json!({ "model": self.model, "system": turn.system, "tools": turn.tools, "messages": messages })).await };
        let steps = if turn.role == "prover" { PROVER_STEPS } else { STEPS };
        // What the last reply said the conversation takes (unknown after a resume).
        let mut used = 0u64;
        for step in 1..=steps {
            if stop.is_stopped() {
                return stopped(out);
            }
            let asked = turn.compact_now.swap(false, Ordering::SeqCst) && messages.len() > 1;
            if used >= c::compact_limit(&self.model) || asked {
                // Not fatal: if no summary comes back, the step runs as is and a too-long call compacts below.
                match self.compact(&key, &base, turn, &mut messages, stop, &mut out).await {
                    Ok(false) => return stopped(out),
                    Ok(true) => {
                        keep(&messages);
                        if let Some(Some(n)) = stop.race(recount(messages.clone())).await {
                            turn.context(n, &self.model, fixed, false);
                        }
                    }
                    Err(e) => turn.emit(Kind::Tool, format!("compact: no summary yet ({e})")),
                }
            }
            turn.emit(Kind::Status, format!("step {step}: thinking"));
            let mut retried = false;
            let reply = loop {
                let body = self.body(turn, &messages, None);
                let Some(r) = stop.race(self.call(&key, &base, &body)).await else { return stopped(out) };
                let (status, reply) = r?;
                let full = c::overflowed(status, &reply);
                if status < 300 && !full {
                    break reply;
                }
                if status < 300 {
                    self.charge(turn, &mut out, &reply["usage"]);
                }
                if !full || retried {
                    return Err(TurnError::Failed(if full { "the conversation is still too long after compacting it".into() } else { reply["error"]["message"].as_str().unwrap_or("the model call failed").to_string() }));
                }
                retried = true;
                turn.emit(Kind::Status, "the conversation no longer fits the context window: compacting it");
                if !self.compact(&key, &base, turn, &mut messages, stop, &mut out).await? {
                    return stopped(out);
                }
                keep(&messages);
            };
            out.steps += 1;
            self.charge(turn, &mut out, &reply["usage"]);
            used = c::context_used(&reply["usage"]);
            out.context = out.context.max(used);
            turn.context(used, &self.model, fixed, false);
            let content = reply["content"].clone();
            messages.push(json!({ "role": "assistant", "content": content }));
            keep(&messages);
            let mut results = vec![];
            for block in content.as_array().cloned().unwrap_or_default() {
                match block["type"].as_str() {
                    Some("text") => {
                        let text = block["text"].as_str().unwrap_or("").to_string();
                        if !text.trim().is_empty() {
                            out.summary = text.clone();
                            turn.emit(Kind::Say, text);
                        }
                    }
                    Some("tool_use") => {
                        out.tool_calls += 1;
                        // A stop mid-tool leaves the reply without results; a resume drops it and redoes the step.
                        let Some(r) = stop.race(tools.call(block["name"].as_str().unwrap_or(""), &block["input"])).await else { return stopped(out) };
                        results.push(json!({ "type": "tool_result", "tool_use_id": block["id"], "content": crate::swarm2::lake::clip(r) }));
                    }
                    _ => {}
                }
            }
            if results.is_empty() || reply["stop_reason"] != "tool_use" {
                return Ok(out);
            }
            messages.push(json!({ "role": "user", "content": results }));
            keep(&messages);
        }
        out.ended = Ended::OutOfSteps;
        Ok(out)
    }
}

impl Agent for ApiAgent {
    fn turn<'a>(&'a self, turn: &'a Turn, tools: &'a dyn ToolHost, stop: &'a Stop) -> BoxFuture<'a, Result<Outcome, TurnError>> {
        Box::pin(self.run(turn, tools, stop))
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;
    use crate::swarm2::fsguard::tests::TempDir;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// One request the fake API saw.
    #[derive(Clone, Debug)]
    struct Seen {
        url: String,
        headers: Vec<(String, String)>,
        body: Value,
    }

    impl Seen {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
        }
    }

    /// A fake API on 127.0.0.1: count_tokens answers from the body's size; model-session hands out a key for itself;
    /// every other request takes the next scripted (status, body, delay).
    struct Fake {
        base: String,
        seen: Arc<Mutex<Vec<Seen>>>,
    }

    impl Fake {
        fn start(script: Vec<(u16, Value, Duration)>) -> Fake {
            let http = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let base = format!("http://127.0.0.1:{}", http.server_addr().to_ip().unwrap().port());
            let seen = Arc::new(Mutex::new(vec![]));
            let (s, b) = (seen.clone(), base.clone());
            let script = Arc::new(Mutex::new(VecDeque::from(script)));
            std::thread::spawn(move || {
                for mut req in http.incoming_requests() {
                    let mut text = String::new();
                    let _ = req.as_reader().read_to_string(&mut text);
                    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                    let url = req.url().to_string();
                    let headers = req.headers().iter().map(|h| (h.field.to_string(), h.value.to_string())).collect();
                    s.lock().unwrap().push(Seen { url: url.clone(), headers, body: body.clone() });
                    let (status, reply, delay) = if url.ends_with("/count_tokens") {
                        let n = 100 + if body.get("tools").is_some() { 50 } else { 0 } + if body["messages"][0]["content"] != "." { 25 } else { 0 };
                        (200, json!({ "input_tokens": n }), Duration::ZERO)
                    } else if url.ends_with("/model-session") {
                        (200, json!({ "key": "sess-key", "base_url": b }), Duration::ZERO)
                    } else {
                        script.lock().unwrap().pop_front().unwrap_or((500, json!({ "error": { "message": "unscripted" } }), Duration::ZERO))
                    };
                    let script = script.clone();
                    // Each answer on its own thread, so a hanging one doesn't hold the next request.
                    std::thread::spawn(move || {
                        std::thread::sleep(delay);
                        let _ = req.respond(tiny_http::Response::from_string(reply.to_string()).with_status_code(status));
                        drop(script);
                    });
                }
            });
            Fake { base, seen }
        }

        fn calls(&self) -> Vec<Seen> {
            self.seen.lock().unwrap().iter().filter(|s| !s.url.ends_with("/count_tokens")).cloned().collect()
        }
    }

    fn ok(v: Value) -> (u16, Value, Duration) {
        (200, v, Duration::ZERO)
    }

    fn tool_use(input_tokens: u64) -> Value {
        json!({ "content": [{ "type": "text", "text": "Reading." }, { "type": "tool_use", "id": "t1", "name": "echo", "input": { "x": 1 } }], "stop_reason": "tool_use", "usage": { "input_tokens": input_tokens, "output_tokens": 10 } })
    }

    fn done() -> Value {
        json!({ "content": [{ "type": "text", "text": "Approved." }], "stop_reason": "end_turn", "usage": { "input_tokens": 1000, "output_tokens": 10 } })
    }

    fn agent(fake: &Fake) -> ApiAgent {
        ApiAgent::new(Wire::Messages, Access::Key { key: "k".into(), base: fake.base.clone() }, None)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b35_an_api_turn_runs_tools_until_the_model_stops() {
        let t = TempDir::new("api-b35");
        let fake = Fake::start(vec![ok(tool_use(1000)), ok(done())]);
        let events = Arc::new(Events::default());
        let host = Host::default();
        let out = agent(&fake).turn(&turn(&t.0, "reviewer", events.clone()), &host, &Stop::new()).await.unwrap();
        assert_eq!((out.ended, out.steps, out.tool_calls, out.summary.as_str()), (Ended::Done, 2, 1, "Approved."));
        assert!(out.spent > 0.0 && (*events.spent.lock().unwrap() - out.spent).abs() < 1e-12);
        assert_eq!(host.calls.lock().unwrap()[0], ("echo".to_string(), json!({ "x": 1 })));
        let calls = fake.calls();
        let first = &calls[0];
        assert!(first.url.ends_with("/v1/messages"));
        assert_eq!(first.header("x-api-key"), Some("k"));
        assert_eq!(first.body["model"], DEFAULT_MODEL);
        assert_eq!(first.body["max_tokens"], 16000);
        assert_eq!(first.body["cache_control"], json!({ "type": "ephemeral" }));
        assert_eq!(first.body["output_config"]["effort"], "medium", "high only for the prover");
        assert_eq!(first.body["system"], "You review proofs.");
        assert_eq!(first.body["tools"][0]["name"], "echo");
        assert_eq!(calls[1].body["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(events.of(Kind::Status), ["reviewer is working", "step 1: thinking", "step 2: thinking"]);
        assert_eq!(events.of(Kind::Say), ["Reading.", "Approved."]);
        // B42: the fixed parts come from count_tokens (not estimated).
        let ctx: Value = serde_json::from_str(&events.of(Kind::Context)[0]).unwrap();
        assert_eq!((ctx["system"].as_u64(), ctx["tools"].as_u64(), ctx["task"].as_u64(), ctx["used"].as_u64()), (Some(100), Some(50), Some(25), Some(1010)));
        assert!(ctx.get("estimated").is_none());
        assert_eq!(ctx["compact_at"], 750_000);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b35_the_openai_route_speaks_chat_completions() {
        let t = TempDir::new("api-oai");
        let fake = Fake::start(vec![ok(json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "Done." } }], "usage": { "prompt_tokens": 10, "completion_tokens": 2 } }))]);
        let a = ApiAgent::new(Wire::ChatCompletions, Access::Key { key: "sk".into(), base: fake.base.clone() }, Some("gpt-5"));
        let events = Arc::new(Events::default());
        let out = a.turn(&turn(&t.0, "prover", events.clone()), &Host::default(), &Stop::new()).await.unwrap();
        assert_eq!(out.summary, "Done.");
        let seen = fake.seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1, "no count_tokens on OpenAI");
        assert!(seen[0].url.ends_with("/v1/chat/completions"));
        assert_eq!(seen[0].header("authorization"), Some("Bearer sk"));
        assert_eq!(seen[0].body["reasoning_effort"], "high");
        assert_eq!(seen[0].body["messages"][0]["role"], "developer");
        let ctx: Value = serde_json::from_str(&events.of(Kind::Context)[0]).unwrap();
        assert_eq!(ctx["window"], 400_000);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b35_the_formal_route_gets_a_model_session() {
        let t = TempDir::new("api-formal");
        let fake = Fake::start(vec![ok(done())]);
        let a = ApiAgent::new(Wire::Messages, Access::Session { api: fake.base.clone(), token: "tok".into() }, None);
        a.turn(&turn(&t.0, "reviewer", Arc::new(Events::default())), &Host::default(), &Stop::new()).await.unwrap();
        let calls = fake.calls();
        assert!(calls[0].url.ends_with("/api/desktop/model-session"));
        assert_eq!(calls[0].header("authorization"), Some("Bearer tok"));
        let folder = t.0.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(calls[0].body, json!({ "folder": folder, "run": "swarm", "role": "reviewer", "ref": "3" }));
        assert_eq!(calls[1].header("x-api-key"), Some("sess-key"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn r6_stop_mid_model_call_ends_the_turn_promptly() {
        let t = TempDir::new("api-r6");
        let fake = Fake::start(vec![(200, done(), Duration::from_secs(30))]);
        let stop = Stop::new();
        let s = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            s.stop();
        });
        let at = std::time::Instant::now();
        let out = agent(&fake).turn(&turn(&t.0, "reviewer", Arc::new(Events::default())), &Host::default(), &stop).await.unwrap();
        assert_eq!(out.ended, Ended::Stopped);
        assert!(at.elapsed() < Duration::from_secs(2), "{:?}", at.elapsed());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn r6_stop_mid_tool_call_ends_the_turn_promptly() {
        let t = TempDir::new("api-r6t");
        let fake = Fake::start(vec![ok(tool_use(10))]);
        let host = Host { delay: Duration::from_secs(30), ..Host::default() };
        let stop = Stop::new();
        let s = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            s.stop();
        });
        let at = std::time::Instant::now();
        let out = agent(&fake).turn(&turn(&t.0, "reviewer", Arc::new(Events::default())), &host, &stop).await.unwrap();
        assert_eq!(out.ended, Ended::Stopped);
        assert!(at.elapsed() < Duration::from_secs(2));
        // The reply's tool call never got its result: a resume drops it (B36).
        let saved = queue::load_transcript(&t.0, "swarm", 7).unwrap();
        assert_eq!(saved.last().unwrap()["role"], "assistant");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b36_a_quit_mid_job_resumes_the_same_conversation() {
        let t = TempDir::new("api-b36");
        // First run: a tool step, then the app quits during the next model call.
        let fake = Fake::start(vec![ok(tool_use(10)), (200, done(), Duration::from_secs(30))]);
        let stop = Stop::new();
        let s = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            s.stop();
        });
        let out = agent(&fake).turn(&turn(&t.0, "reviewer", Arc::new(Events::default())), &Host::default(), &stop).await.unwrap();
        assert_eq!(out.ended, Ended::Stopped);
        // Second run, a new app: the saved conversation continues.
        let fake = Fake::start(vec![ok(done())]);
        let out = agent(&fake).turn(&turn(&t.0, "reviewer", Arc::new(Events::default())), &Host::default(), &Stop::new()).await.unwrap();
        assert!(out.resumed);
        let m = fake.calls()[0].body["messages"].as_array().unwrap().clone();
        assert_eq!(m.len(), 3, "task, tool step, results");
        assert_eq!(m[0]["content"], "Review item 3.");
        assert_eq!(m[1]["content"][1]["type"], "tool_use");
        let last = m[2]["content"].as_array().unwrap();
        assert_eq!(last[0]["type"], "tool_result");
        assert_eq!(last.last().unwrap()["text"], queue::RESUMED);
        assert_eq!(queue::load_transcript(&t.0, "swarm", 7).unwrap().len(), 4, "saved after the last step too");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b37_compaction_kicks_in_past_the_limit() {
        let t = TempDir::new("api-b37");
        let summary = json!({ "content": [{ "type": "compaction", "content": "Read A.sol; echo said 1." }], "stop_reason": "compaction", "usage": { "input_tokens": 0, "output_tokens": 0, "iterations": [{ "type": "compaction", "input_tokens": 800_000, "output_tokens": 500 }] } });
        let fake = Fake::start(vec![ok(tool_use(800_000)), ok(summary), ok(done())]);
        let events = Arc::new(Events::default());
        let out = agent(&fake).turn(&turn(&t.0, "reviewer", events.clone()), &Host::default(), &Stop::new()).await.unwrap();
        assert_eq!(out.ended, Ended::Done);
        let calls = fake.calls();
        assert_eq!(calls[1].body["compaction"]["type"], "summarize");
        assert_eq!(calls[1].header("anthropic-beta"), Some(BETA));
        let m = calls[2].body["messages"].as_array().unwrap();
        assert_eq!(m[0]["role"], "assistant");
        assert_eq!(m[0]["content"][0]["type"], "compaction");
        assert_eq!(m.last().unwrap()["content"].as_array().unwrap().last().unwrap()["text"], "Review item 3.", "task restated");
        assert_eq!(calls[2].header("anthropic-beta"), Some(BETA), "a request carrying a summary needs the beta");
        assert!(events.of(Kind::Tool).iter().any(|t| t.starts_with("compact: the earlier steps summarized")));
        assert!(out.spent > 3.2, "the summary's iterations are billed: {}", out.spent);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b37_compact_now_compacts_before_the_next_step() {
        let t = TempDir::new("api-b37n");
        let summary = json!({ "content": [{ "type": "compaction", "content": "S" }], "stop_reason": "compaction", "usage": {} });
        let fake = Fake::start(vec![ok(tool_use(10)), ok(summary), ok(done())]);
        let events = Arc::new(Events::default());
        let tr = turn(&t.0, "reviewer", events);
        // Pressed while the first step's tool runs.
        struct Presses(Arc<std::sync::atomic::AtomicBool>);
        impl ToolHost for Presses {
            fn call<'a>(&'a self, _: &'a str, _: &'a Value) -> BoxFuture<'a, String> {
                self.0.store(true, Ordering::SeqCst);
                Box::pin(async { "ok".to_string() })
            }
        }
        agent(&fake).turn(&tr, &Presses(tr.compact_now.clone()), &Stop::new()).await.unwrap();
        assert!(fake.calls()[1].body.get("compaction").is_some());
        assert!(!tr.compact_now.load(Ordering::SeqCst), "taken");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b37_a_step_too_long_compacts_and_retries_once() {
        let t = TempDir::new("api-b37r");
        let too_long = (400, json!({ "error": { "message": "prompt is too long: 1200000 tokens > 1000000 maximum" } }), Duration::ZERO);
        let summary = json!({ "content": [{ "type": "compaction", "content": "S" }], "stop_reason": "compaction", "usage": {} });
        let fake = Fake::start(vec![too_long.clone(), ok(summary.clone()), ok(done())]);
        let out = agent(&fake).turn(&turn(&t.0, "reviewer", Arc::new(Events::default())), &Host::default(), &Stop::new()).await.unwrap();
        assert_eq!(out.summary, "Approved.");
        assert_eq!(fake.calls().len(), 3);
        // Too long even after compacting: the turn fails rather than looping.
        let t = TempDir::new("api-b37r2");
        let fake = Fake::start(vec![too_long.clone(), ok(summary), too_long]);
        let e = agent(&fake).turn(&turn(&t.0, "reviewer", Arc::new(Events::default())), &Host::default(), &Stop::new()).await.unwrap_err();
        assert_eq!(e.to_string(), "the conversation is still too long after compacting it");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b37_an_overflowing_summarizer_tries_an_earlier_cut() {
        let t = TempDir::new("api-b37e");
        // Five tool steps saved from before, then a step past the limit.
        let mut m = vec![json!({ "role": "user", "content": "Review item 3." })];
        for i in 0..5 {
            m.push(json!({ "role": "assistant", "content": [{ "type": "tool_use", "id": format!("t{i}"), "name": "echo", "input": {} }] }));
            m.push(json!({ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": format!("t{i}"), "content": "ok" }] }));
        }
        queue::save_transcript(&t.0, "swarm", 7, &m).unwrap();
        let too_long = (413, json!({ "error": { "message": "request too large" } }), Duration::ZERO);
        let summary = json!({ "content": [{ "type": "compaction", "content": "S" }], "stop_reason": "compaction", "usage": {} });
        let fake = Fake::start(vec![ok(tool_use(900_000)), too_long, ok(summary), ok(done())]);
        agent(&fake).turn(&turn(&t.0, "reviewer", Arc::new(Events::default())), &Host::default(), &Stop::new()).await.unwrap();
        let calls = fake.calls();
        let (first, second) = (calls[1].body["messages"].as_array().unwrap().len(), calls[2].body["messages"].as_array().unwrap().len());
        assert!(second < first, "the second summary covers less: {first} then {second}");
    }
}
