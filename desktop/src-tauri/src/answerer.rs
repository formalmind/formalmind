//! Who answers the swarm's questions (a statement's formalization: "is this what you meant?"). By default you do, in
//! the chat or through the MCP (`mac_get` `questions`, then `confirm_statement` / `correct_statement`). With Settings →
//! Questions set to the agent, an answerer agent reads the claim and its formalization and confirms it, or corrects it
//! once; a statement it already corrected and still doubts is left for you.

use serde_json::{json, Value};
use std::path::Path;

const SYSTEM: &str = "You answer for the maintainer of a Solidity project. The swarm turned a claim, written in plain words, into a precise statement it will prove in Lean. Decide whether the precise statement says what the claim means: no stronger (it must not demand something false, such as an equality that force-sent ETH breaks), no weaker (it must not drop part of the claim or assume away what the claim is about), and about the right functions. Answer with one JSON object and nothing else: {\"confirm\": true} when it matches; {\"correct\": \"<what the statement should mean instead, in plain words, naming the functions it is about as Contract.fn>\"} when it doesn't; {\"leave\": \"<why the maintainer should decide>\"} when the claim itself is unclear or a matter of taste.";

/// The pending questions: statements formalized and waiting for an answer, each with what it asks.
pub fn questions(root: &Path) -> Vec<Value> {
    crate::statements::awaiting_confirm(root)
        .into_iter()
        .map(|s| {
            let means = s.details.iter().find_map(|d| d.strip_prefix("means: ")).unwrap_or("").to_string();
            let assumes: Vec<&str> = s.details.iter().filter_map(|d| d.strip_prefix("assumes: ")).collect();
            json!({ "id": s.id, "author": s.author, "claim": s.text, "means": means, "assumes": assumes, "functions": s.obligations.iter().map(|o| o.text.clone()).collect::<Vec<_>>() })
        })
        .collect()
}

/// What the answerer decided, from its reply.
#[derive(Debug, PartialEq)]
pub enum Answer {
    Confirm,
    Correct(String),
    Leave(String),
}

pub fn parse(reply: &str) -> Answer {
    let body = reply.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let v: Value = body.find('{').and_then(|a| body.rfind('}').map(|b| &body[a..=b])).and_then(|t| serde_json::from_str(t).ok()).unwrap_or(Value::Null);
    match (v["confirm"].as_bool(), v["correct"].as_str(), v["leave"].as_str()) {
        (_, Some(c), _) if !c.trim().is_empty() => Answer::Correct(c.trim().to_string()),
        (Some(true), _, _) => Answer::Confirm,
        (_, _, Some(why)) => Answer::Leave(why.to_string()),
        _ => Answer::Leave("the answerer's reply wasn't one of confirm, correct or leave".into()),
    }
}

/// Whether the agent answers this folder's questions (Settings → Questions).
pub fn on() -> bool {
    crate::local::read().map(|c| c.settings.answers() == "agent").unwrap_or(false)
}

/// The answerer agent's turn on one statement; returns what it did.
pub async fn answer(folder: &str, id: &str) -> Result<String, String> {
    let root = Path::new(folder);
    let q = questions(root).into_iter().find(|q| q["id"] == id).ok_or_else(|| format!("{id} isn't waiting for an answer"))?;
    let corrected = crate::statements::load(root)?.into_iter().find(|s| s.id == id).is_some_and(|s| s.details.iter().any(|d| d.starts_with("you said: ")));
    let model = crate::local::read()?.settings.model.unwrap_or_else(|| "opus".into());
    let reply = crate::claude_code::ask(folder, SYSTEM, &serde_json::to_string_pretty(&q).unwrap_or_default(), &model).await?;
    match parse(&reply) {
        Answer::Confirm => {
            crate::statements::swarm_confirm_statement(folder.to_string(), id.to_string())?;
            Ok(format!("{id}: confirmed"))
        }
        // One correction per statement; after that a doubt goes to the maintainer.
        Answer::Correct(text) if !corrected => {
            crate::statements::swarm_correct_statement(folder.to_string(), id.to_string(), text.clone())?;
            Ok(format!("{id}: corrected: {text}"))
        }
        Answer::Correct(text) => Ok(format!("{id}: left for you (already corrected once; still: {text})")),
        Answer::Leave(why) => Ok(format!("{id}: left for you: {why}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies() {
        assert_eq!(parse("{\"confirm\": true}"), Answer::Confirm);
        assert_eq!(parse("```json\n{\"correct\": \"only transfer\"}\n```"), Answer::Correct("only transfer".into()));
        assert_eq!(parse("Sure! {\"leave\": \"taste\"}"), Answer::Leave("taste".into()));
        assert!(matches!(parse("yes"), Answer::Leave(_)));
        assert!(matches!(parse("{\"confirm\": false}"), Answer::Leave(_)));
    }
}
