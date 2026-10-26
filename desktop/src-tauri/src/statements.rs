//! The statements checklist, `.formal/statements.md`: claims about the code in plain words, from the maintainer or an
//! agent, each to be proved or disproved by the swarm (docs/statements.md). The file is read and edited line by line,
//! so what the maintainer writes there by hand stays as they wrote it.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Open, working, proved, disproved, waiting for the maintainer, can't be proved against this model.
pub const MARKS: [char; 6] = [' ', '~', 'x', '!', '?', '-'];

#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct Obligation {
    pub mark: String,
    pub text: String,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct Statement {
    /// `S-NN`, never reused.
    pub id: String,
    pub mark: String,
    /// "you", or the role that proposed it.
    pub author: String,
    /// The claim as it was written; never rewritten.
    pub text: String,
    /// The swarm's notes under it (its kind, the functions, why, the counterexample).
    pub details: Vec<String>,
    /// One per function, each with its own mark.
    pub obligations: Vec<Obligation>,
}

const HEADER: &str = "# Statements\n\nClaims about the code in plain words, each proved or disproved by the swarm: `- [ ]` open, `- [~]` working, `- [x]` proved, `- [!]` disproved, `- [?]` waiting for you, `- [-]` can't be proved against this model. Add your own as `- [ ] <the claim>`; the indented lines under each one are the swarm's.\n\n";

/// One writer at a time: the maintainer's list and the agents' tool share the file.
static LOCK: Mutex<()> = Mutex::new(());

pub fn path(root: &Path) -> PathBuf {
    root.join(".formal").join("statements.md")
}

/// A checklist line's mark and body: `- [m] body`.
fn item(line: &str) -> Option<(char, &str)> {
    let rest = line.strip_prefix("- [")?;
    let mut chars = rest.chars();
    let m = chars.next()?;
    let body = chars.as_str().strip_prefix(']')?;
    let m = if m == 'X' { 'x' } else if MARKS.contains(&m) { m } else { ' ' };
    Some((m, body.trim()))
}

fn is_id(s: &str) -> bool {
    s.strip_prefix("S-").is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

fn number(id: &str) -> u32 {
    id.trim_start_matches("S-").parse().unwrap_or(0)
}

/// `S-01 · you · the claim` as (id, author, claim); a line written by hand without an id is the maintainer's.
fn head(body: &str) -> (String, String, String) {
    let mut parts = body.splitn(3, " · ");
    match (parts.next(), parts.next(), parts.next()) {
        (Some(id), Some(author), Some(text)) if is_id(id.trim()) => (id.trim().into(), author.trim().into(), text.trim().into()),
        _ => (String::new(), "you".into(), body.trim().into()),
    }
}

fn is_top(line: &str) -> bool {
    !line.starts_with(char::is_whitespace) && item(line).is_some()
}

/// Each statement with the index of its line.
fn parse(text: &str) -> Vec<(usize, Statement)> {
    let mut out: Vec<(usize, Statement)> = vec![];
    let mut open = false;
    for (i, line) in text.lines().enumerate() {
        if is_top(line) {
            let (m, body) = item(line).expect("a checklist line");
            let (id, author, text) = head(body);
            out.push((i, Statement { id, mark: m.to_string(), author, text, details: vec![], obligations: vec![] }));
            open = true;
        } else if open && line.starts_with(char::is_whitespace) && line.trim_start().starts_with("- ") {
            let s = &mut out.last_mut().expect("an open statement").1;
            let t = line.trim_start();
            match item(t) {
                Some((m, body)) => s.obligations.push(Obligation { mark: m.to_string(), text: body.to_string() }),
                None => s.details.push(t[2..].trim().to_string()),
            }
        } else if !line.trim().is_empty() {
            open = false;
        }
    }
    out
}

/// The `<!-- next: S-NN -->` line: the next id, kept so a removed statement's id isn't handed out again.
fn next_line(lines: &[String]) -> Option<(usize, u32)> {
    lines.iter().enumerate().find_map(|(i, l)| {
        let n = l.trim().strip_prefix("<!-- next: S-")?.strip_suffix("-->")?.trim().parse().ok()?;
        Some((i, n))
    })
}

fn set_next(lines: &mut Vec<String>, n: u32) {
    let line = format!("<!-- next: S-{n:02} -->");
    match next_line(lines) {
        Some((i, _)) => lines[i] = line,
        None => lines.push(line),
    }
}

/// The file's lines with an id on every statement (hand-written ones get the next free ids), and the next id.
fn normalized(text: &str) -> (Vec<String>, u32, bool) {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let found = parse(text);
    let mut next = found.iter().map(|(_, s)| number(&s.id) + 1).max().unwrap_or(1).max(next_line(&lines).map_or(1, |(_, n)| n));
    let mut changed = false;
    for (i, s) in &found {
        if s.id.is_empty() {
            lines[*i] = format!("- [{}] S-{next:02} · you · {}", s.mark, s.text);
            next += 1;
            changed = true;
        }
    }
    if next_line(&lines).map(|(_, n)| n) != Some(next) {
        set_next(&mut lines, next);
        changed = true;
    }
    (lines, next, changed)
}

fn read(root: &Path) -> String {
    std::fs::read_to_string(path(root)).unwrap_or_default()
}

fn write(root: &Path, lines: &[String]) -> Result<(), String> {
    let p = path(root);
    std::fs::create_dir_all(p.parent().unwrap_or(root)).map_err(|e| e.to_string())?;
    std::fs::write(&p, lines.join("\n") + "\n").map_err(|e| e.to_string())
}

/// Every statement in the folder. Hand-written ones without an id get one, written back.
pub fn load(root: &Path) -> Result<Vec<Statement>, String> {
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let text = read(root);
    if parse(&text).is_empty() {
        return Ok(vec![]);
    }
    let (lines, _, changed) = normalized(&text);
    if changed {
        write(root, &lines)?;
    }
    Ok(parse(&(lines.join("\n") + "\n")).into_iter().map(|(_, s)| s).collect())
}

/// Adds a statement at the end of the list: open when the maintainer wrote it, `?` (proposed, waiting for them) when an
/// agent did. `details` go under it as the swarm's notes.
pub fn add(root: &Path, author: &str, text: &str, mark: char, details: &[String]) -> Result<Statement, String> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err("the statement is empty".into());
    }
    if text.chars().count() > 2000 {
        return Err("keep a statement to a few sentences (2,000 characters at most)".into());
    }
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let current = read(root);
    let current = if current.trim().is_empty() { HEADER.to_string() } else { current };
    let (mut lines, next, _) = normalized(&current);
    if let Some((_, s)) = parse(&current).into_iter().find(|(_, s)| s.text.eq_ignore_ascii_case(&text)) {
        return Err(format!("already in the list as {}", if s.id.is_empty() { "a statement".into() } else { s.id }));
    }
    let id = format!("S-{next:02}");
    let author = if author.trim().is_empty() { "you" } else { author.trim() };
    // New statements go after the last one (or at the end), before the next-id line.
    let at = next_line(&lines).map_or(lines.len(), |(i, _)| i);
    let mut block = vec![format!("- [{mark}] {id} · {author} · {text}")];
    block.extend(details.iter().map(|d| d.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|d| !d.is_empty()).map(|d| format!("  - {d}")));
    lines.splice(at..at, block);
    set_next(&mut lines, next + 1);
    write(root, &lines)?;
    Ok(Statement { id, mark: mark.to_string(), author: author.to_string(), text, details: details.to_vec(), obligations: vec![] })
}

/// Sets a statement's own mark (its obligations keep theirs).
pub fn set_mark(root: &Path, id: &str, mark: char) -> Result<(), String> {
    if !MARKS.contains(&mark) {
        return Err(format!("no mark `{mark}`"));
    }
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let text = read(root);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let (i, s) = parse(&text).into_iter().find(|(_, s)| s.id == id).ok_or_else(|| format!("no statement {id}"))?;
    lines[i] = format!("- [{mark}] {} · {} · {}", s.id, s.author, s.text);
    write(root, &lines)
}

/// Takes a statement and the swarm's lines under it out of the list. Its id isn't reused.
pub fn remove(root: &Path, id: &str) -> Result<(), String> {
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let text = read(root);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let (i, _) = parse(&text).into_iter().find(|(_, s)| s.id == id).ok_or_else(|| format!("no statement {id}"))?;
    let mut end = i + 1;
    while end < lines.len() && lines[end].starts_with(char::is_whitespace) && lines[end].trim_start().starts_with("- ") {
        end += 1;
    }
    lines.drain(i..end);
    write(root, &lines)
}

// ---- formalizing: from the words to the functions it is about ----

/// What a statement is about, from its `kind:` line once it has been formalized.
pub fn kind(s: &Statement) -> Option<&str> {
    s.details.iter().find_map(|d| d.strip_prefix("kind: ")).map(|k| k.split(" · ").next().unwrap_or(k).trim())
}

/// The kinds the swarm proves so far; the others are formalized, then wait for a later step.
const PROVABLE: [&str; 2] = ["function", "access"];

/// Lines under a statement that come from the maintainer or the agent that proposed it, kept when it is formalized again.
fn kept(detail: &str) -> bool {
    detail.starts_with("why: ") || detail.starts_with("you said: ")
}

/// The next open statement nobody has formalized yet.
pub fn awaiting_formalize(root: &Path) -> Option<Statement> {
    load(root).ok()?.into_iter().find(|s| s.mark == " " && kind(s).is_none())
}

/// Statements formalized and waiting for the maintainer to say they mean what was intended.
pub fn awaiting_confirm(root: &Path) -> Vec<Statement> {
    load(root).unwrap_or_default().into_iter().filter(|s| s.mark == "?" && kind(s).is_some()).collect()
}

/// What formalizing a statement settled: its kind, the notes under it, one obligation line per function (in the plan's
/// format, so `Context::target` finds the function), and the replies drafted for the maintainer.
#[derive(Clone, Debug, PartialEq)]
pub struct Formalized {
    pub kind: String,
    pub means: String,
    pub details: Vec<String>,
    pub obligations: Vec<String>,
    pub replies: Vec<String>,
}

impl Formalized {
    /// Waits for the maintainer's yes before anything is proved (a kind the swarm can't prove yet doesn't ask).
    pub fn asks(&self) -> bool {
        PROVABLE.contains(&self.kind.as_str())
    }
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().into_iter().flatten().filter_map(Value::as_str).map(one_line).filter(|s| !s.is_empty()).collect()
}

/// Checks the formalize job's answer against formal-ast and derives the obligations. For `access`, the functions are
/// every entry point whose footprint writes one of the variables, whatever the agent listed.
pub fn derive(ctx: &crate::swarm_ctx::Context, input: &Value) -> Result<Formalized, String> {
    let kind = input["kind"].as_str().unwrap_or("").trim().to_string();
    let means = one_line(input["means"].as_str().unwrap_or(""));
    if means.is_empty() {
        return Err("means is required: the claim restated from your formalization, in plain words".into());
    }
    let units = ctx.units();
    let place = |u: &crate::swarm_ctx::Unit| format!("`{}` — {} ({})", u.lean(), u.contract.name, u.at());
    let mut details = vec![];
    let mut obligations = vec![];
    match kind.as_str() {
        "function" => {
            let name = input["function"].as_str().unwrap_or("").trim().trim_matches('`');
            let u = units.iter().find(|u| u.name() == name || u.lean() == name).ok_or_else(|| format!("no function {name:?} in scope; `functions` lists them (Contract.fn)"))?;
            let what = one_line(input["obligation"].as_str().unwrap_or(""));
            if what.is_empty() {
                return Err("obligation is required for a function statement: what to prove about it, one sentence".into());
            }
            details.push(format!("kind: function · {}", u.name()));
            obligations.push(format!("{}: {what}", place(u)));
        }
        "access" => {
            let vars = strings(&input["variables"]);
            if vars.is_empty() {
                return Err("variables is required for an access statement: the state variables, as `functions` lists them under writes".into());
            }
            let callers = one_line(input["callers"].as_str().unwrap_or(""));
            if callers.is_empty() {
                return Err("callers is required for an access statement: who may change them, in plain words".into());
            }
            let footprint = |u: &crate::swarm_ctx::Unit, k: &str| -> Vec<String> { u.unit[k].as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect() };
            for v in &vars {
                if !units.iter().any(|u| footprint(u, "writes").contains(v) || footprint(u, "reads").contains(v)) {
                    return Err(format!("no function in scope reads or writes {v:?}; use the names `functions` lists under writes"));
                }
            }
            let writers: Vec<_> = units.iter().filter(|u| u.unit["internal"] != true).filter(|u| footprint(u, "writes").iter().any(|w| vars.contains(w))).collect();
            details.push(format!("kind: access · {} · by {callers}", vars.join(", ")));
            for u in &writers {
                let written: Vec<String> = footprint(u, "writes").into_iter().filter(|w| vars.contains(w)).collect();
                obligations.push(format!("{}: reverts unless {callers} calls, before it writes {}", place(u), written.join(", ")));
            }
            if writers.is_empty() {
                details.push(format!("note: no entry point writes {}, so nothing in scope can change it", vars.join(", ")));
            }
        }
        "invariant" | "conservation" | "sequence" => {
            details.push(format!("kind: {kind}"));
            details.push(format!("note: the swarm proves function and access statements so far; {kind} statements come later"));
        }
        k => return Err(format!("no kind {k:?}: function, access, invariant, conservation or sequence")),
    }
    details.push(format!("means: {means}"));
    details.extend(strings(&input["assumptions"]).into_iter().map(|a| format!("assumes: {a}")));
    let replies = strings(&input["replies"]).into_iter().take(3).collect();
    Ok(Formalized { kind, means, details, obligations, replies })
}

/// The statement's line, rebuilt with `mark`, and its block's end (the line after its last indented line).
fn block(lines: &[String], text: &str, id: &str) -> Result<(usize, usize, Statement), String> {
    let (i, s) = parse(text).into_iter().find(|(_, s)| s.id == id).ok_or_else(|| format!("no statement {id}"))?;
    let mut end = i + 1;
    while end < lines.len() && lines[end].starts_with(char::is_whitespace) && lines[end].trim_start().starts_with("- ") {
        end += 1;
    }
    Ok((i, end, s))
}

/// Rewrites a statement's block: its mark, and the lines under it (what `kept` keeps, then `details` and `obligations`).
fn rewrite(root: &Path, id: &str, mark: char, details: &[String], obligations: &[String]) -> Result<(), String> {
    let text = read(root);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let (i, end, s) = block(&lines, &text, id)?;
    let mut out = vec![format!("- [{mark}] {} · {} · {}", s.id, s.author, s.text)];
    out.extend(s.details.iter().filter(|d| kept(d)).map(|d| format!("  - {d}")));
    out.extend(details.iter().map(|d| format!("  - {d}")));
    out.extend(obligations.iter().map(|o| format!("  - [ ] {o}")));
    lines.splice(i..end, out);
    write(root, &lines)
}

/// Writes what formalizing settled under the statement: `?` until the maintainer confirms it, or open when it is a
/// kind the swarm can't prove yet.
pub fn record(root: &Path, id: &str, f: &Formalized) -> Result<(), String> {
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    rewrite(root, id, if f.asks() { '?' } else { ' ' }, &f.details, &f.obligations)
}

/// The formalize job ended without an answer: say so under the statement and wait for the maintainer.
pub fn record_failure(root: &Path, id: &str, why: &str) -> Result<(), String> {
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let why = one_line(why);
    let why: String = if why.is_empty() { "reword it, or name the function it is about".into() } else { why.chars().take(300).collect() };
    rewrite(root, id, '?', &[format!("note: couldn't formalize it: {why}")], &[])
}

/// The maintainer says the formalization means what they meant: it's open again, ready to prove.
pub fn confirm(root: &Path, id: &str) -> Result<(), String> {
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let text = read(root);
    let lines: Vec<String> = text.lines().map(str::to_string).collect();
    let (_, _, s) = block(&lines, &text, id)?;
    if s.mark != "?" || kind(&s).is_none() {
        return Err(format!("{id} isn't waiting for a confirmation"));
    }
    let details: Vec<String> = s.details.iter().filter(|d| !kept(d)).cloned().collect();
    let obligations: Vec<String> = s.obligations.iter().map(|o| o.text.clone()).collect();
    rewrite(root, id, ' ', &details, &obligations)
}

/// The maintainer corrects what it means (or asks for another try): the formalization goes, their words stay under
/// it, and it is formalized again.
pub fn correct(root: &Path, id: &str, correction: &str) -> Result<(), String> {
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let c = one_line(correction);
    rewrite(root, id, ' ', &if c.is_empty() { vec![] } else { vec![format!("you said: {c}")] }, &[])
}

/// The formalize job's task, for the assistant (its role prompt doesn't change).
pub fn formalize_task(s: &Statement) -> String {
    let said: Vec<&str> = s.details.iter().filter_map(|d| d.strip_prefix("you said: ")).collect();
    let why: Vec<&str> = s.details.iter().filter_map(|d| d.strip_prefix("why: ")).collect();
    let mut t = format!(
        "Statement {} ({}) in .formal/statements.md:\n\n> {}\n",
        s.id,
        if s.author == "you" { "the maintainer's words".to_string() } else { format!("proposed by the {}", s.author) },
        s.text
    );
    if !why.is_empty() {
        t.push_str(&format!("\nWhy it was proposed: {}\n", why.join(" ")));
    }
    if !said.is_empty() {
        t.push_str(&format!("\nThe maintainer corrected an earlier reading: {}\n", said.join(" / ")));
    }
    t.push_str(
        "\nFormalize it: work out exactly what it claims about the code, then call formalize_result once. Use `functions` and `function` (formal-ast) to find the functions and the state variables it is about. Don't write proofs or files, and don't change .formal/plan.md.\n\n\
Kinds:\n\
- function: a claim about one function (when it reverts, what it writes, returns or sends). Give `function` as `functions` names it (Contract.fn) and `obligation`, what to prove about it in one sentence.\n\
- access: who may change some state (\"only the owner can change fee\"). Give `variables`, the state variables as `functions` lists them under writes, and `callers`, who may change them in plain words. The swarm finds every function that writes them.\n\
- invariant, conservation or sequence: claims across calls (a relation that always holds, what each call changes in total, what a sequence of calls allows). The swarm doesn't prove these yet: give the kind and `means`, nothing else.\n\n\
`means` is the claim restated from your formalization alone, in plain words, so the maintainer can check it is what they meant: what exactly would be proved, about which functions, under which conditions. Don't copy their sentence. List in `assumptions` anything you had to assume. In `replies`, draft two or three short answers the maintainer might send back, in their voice: one that confirms (\"Yes, that's what I meant\") and one or two that correct the likeliest misreadings.",
    );
    t
}

/// The question the chat shows once a statement is formalized, with the drafted replies (an `ask` event's text).
pub fn ask_text(id: &str, f: &Formalized) -> String {
    let functions = if f.obligations.is_empty() {
        String::new()
    } else {
        format!("\n\nIt would be proved for {}: {}.", if f.obligations.len() == 1 { "one function".into() } else { format!("{} functions", f.obligations.len()) }, f.obligations.iter().filter_map(|o| o.split('`').nth(1)).map(|d| format!("`{d}`")).collect::<Vec<_>>().join(", "))
    };
    let assumes: Vec<&str> = f.details.iter().filter_map(|d| d.strip_prefix("assumes: ")).collect();
    let assumes = if assumes.is_empty() { String::new() } else { format!("\n\nAssuming: {}.", assumes.join("; ")) };
    let question = format!("**{id}**: is this what you meant?\n\n> {}{functions}{assumes}", f.means);
    let mut replies = f.replies.clone();
    if replies.is_empty() {
        replies.push(format!("Yes, {id} means what I meant."));
    }
    json!({ "statement": id, "question": question, "replies": replies }).to_string()
}

/// The formalize job's answer, for the assistant.
pub fn formalize_tool() -> Value {
    json!({ "name": "formalize_result", "description": "Only in a formalize task: record what the statement claims about the code. The app checks the functions and variables against formal-ast, lists the functions it would be proved for, and asks the maintainer whether it means what they meant. An error says what to fix; call it again.", "input_schema": {
        "type": "object",
        "properties": {
            "kind": { "type": "string", "enum": ["function", "access", "invariant", "conservation", "sequence"] },
            "function": { "type": "string", "description": "function: the one function, as `functions` names it (Contract.fn)" },
            "obligation": { "type": "string", "description": "function: what to prove about it, one sentence" },
            "variables": { "type": "array", "items": { "type": "string" }, "description": "access: the state variables, as `functions` lists them under writes" },
            "callers": { "type": "string", "description": "access: who may change them, in plain words (the owner, an authorized executor)" },
            "means": { "type": "string", "description": "The claim restated from your formalization alone, in plain words" },
            "assumptions": { "type": "array", "items": { "type": "string" } },
            "replies": { "type": "array", "items": { "type": "string" }, "description": "Two or three answers the maintainer might send, in their voice: one confirming, the others correcting likely misreadings" }
        },
        "required": ["kind", "means"],
        "additionalProperties": false
    } })
}

/// The maintainer's answer to "is this what you meant?", relayed by the assistant from the chat.
pub fn confirm_tool() -> Value {
    json!({ "name": "confirm_statement", "description": "When the maintainer answers whether a formalized statement (waiting for them, listed in your task) means what they meant: record it. meant: true sends it on to be proved; false formalizes it again with their correction.", "input_schema": {
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "S-NN" },
            "meant": { "type": "boolean" },
            "correction": { "type": "string", "description": "When meant is false: what they said it should mean, in their words" }
        },
        "required": ["id", "meant"],
        "additionalProperties": false
    } })
}

pub fn confirm_tool_call(folder: &str, input: &Value) -> String {
    let id = input["id"].as_str().unwrap_or("").trim();
    let root = Path::new(folder);
    let r = if input["meant"].as_bool() == Some(true) { confirm(root, id).map(|_| format!("{id} confirmed: it goes on to be proved")) } else { correct(root, id, input["correction"].as_str().unwrap_or("")).map(|_| format!("{id} goes back to be formalized with the correction")) };
    r.unwrap_or_else(|e| format!("error: {e}"))
}

/// For the assistant's answer task: the statements waiting for the maintainer's yes, so a reply can be matched to one.
pub fn waiting_note(root: &Path) -> String {
    let waiting = awaiting_confirm(root);
    if waiting.is_empty() {
        return String::new();
    }
    let list: Vec<String> = waiting.iter().map(|s| format!("- {}: \"{}\" (formalized as: {})", s.id, s.text, s.details.iter().find_map(|d| d.strip_prefix("means: ")).unwrap_or(""))).collect();
    format!("\n\nStatements waiting for the maintainer to confirm what they mean:\n{}\nIf the message answers one, call confirm_statement.", list.join("\n"))
}

/// The agents' tool (the swarm's roles and Claude Code's hunter).
pub fn tool() -> Value {
    json!({ "name": "add_statement", "description": "Add a claim about the code to the statements checklist (.formal/statements.md), for the swarm to prove or disprove: a property in plain words with contract, function and variable names, e.g. \"`Vault.totalSupply` always equals the sum of `balanceOf`\" or \"Only the owner can change `fee`\". Use it when the maintainer states a claim to check (from: maintainer, their words as they gave them), or when you see one worth settling (from: me; it waits in the list until the maintainer accepts it). Not for bugs you have shown (report_bug) or notes on a line (tag).", "input_schema": {
        "type": "object",
        "properties": {
            "text": { "type": "string", "description": "The claim, one or two sentences" },
            "from": { "type": "string", "enum": ["maintainer", "me"], "description": "Who states it: the maintainer (their words) or you" },
            "why": { "type": "string", "description": "One line: what breaks if it doesn't hold, or what made you propose it" }
        },
        "required": ["text", "from"],
        "additionalProperties": false
    } })
}

pub fn add_tool(folder: &str, role: &str, input: &Value) -> String {
    let maintainer = input["from"].as_str() == Some("maintainer");
    let why = input["why"].as_str().map(str::trim).filter(|w| !w.is_empty()).map(|w| format!("why: {w}"));
    let (author, mark) = if maintainer { ("you", ' ') } else { (role, '?') };
    match add(Path::new(folder), author, input["text"].as_str().unwrap_or(""), mark, why.as_slice()) {
        Ok(s) if maintainer => format!("added {} to .formal/statements.md", s.id),
        Ok(s) => format!("proposed {} in .formal/statements.md: it waits there until the maintainer accepts it", s.id),
        Err(e) => format!("error: {e}"),
    }
}

fn allowed(folder: &str) -> Result<(), String> {
    if crate::local::read()?.allows(folder) {
        Ok(())
    } else {
        Err("Add the folder first".into())
    }
}

#[tauri::command(async)]
pub fn swarm_statements(folder: String) -> Result<Vec<Statement>, String> {
    allowed(&folder)?;
    load(Path::new(&folder))
}

#[tauri::command(async)]
pub fn swarm_add_statement(folder: String, text: String) -> Result<Statement, String> {
    allowed(&folder)?;
    add(Path::new(&folder), "you", &text, ' ', &[])
}

/// `mark` is one of [`MARKS`]; accepting a proposal sets it to " ".
#[tauri::command(async)]
pub fn swarm_statement_mark(folder: String, id: String, mark: String) -> Result<Vec<Statement>, String> {
    allowed(&folder)?;
    let m = mark.chars().next().unwrap_or(' ');
    set_mark(Path::new(&folder), &id, m)?;
    load(Path::new(&folder))
}

/// The list's Yes: the formalization means what the maintainer meant.
#[tauri::command(async)]
pub fn swarm_confirm_statement(folder: String, id: String) -> Result<Vec<Statement>, String> {
    allowed(&folder)?;
    confirm(Path::new(&folder), &id)?;
    load(Path::new(&folder))
}

/// The list's Edit (with what it should mean) or Try again (with nothing): formalized again.
#[tauri::command(async)]
pub fn swarm_correct_statement(folder: String, id: String, text: String) -> Result<Vec<Statement>, String> {
    allowed(&folder)?;
    correct(Path::new(&folder), &id, &text)?;
    load(Path::new(&folder))
}

#[tauri::command(async)]
pub fn swarm_remove_statement(folder: String, id: String) -> Result<Vec<Statement>, String> {
    allowed(&folder)?;
    remove(Path::new(&folder), &id)?;
    load(Path::new(&folder))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fm-statements-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reads_the_list_with_its_notes_and_obligations() {
        let text = "# Statements\n\n- [x] S-01 · you · Only the owner can change `fee`.\n  - kind: access\n- [~] S-02 · prover · `totalSupply` equals the sum of `balanceOf`.\n  - kind: invariant · 1/2\n  - [x] `Vault.deposit` preserves it\n  - [ ] `Vault.withdraw` preserves it\n\nSome prose.\n  - not a note of S-02\n";
        let s: Vec<Statement> = parse(text).into_iter().map(|(_, s)| s).collect();
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].id.as_str(), s[0].mark.as_str(), s[0].author.as_str()), ("S-01", "x", "you"));
        assert_eq!(s[0].details, vec!["kind: access"]);
        assert_eq!(s[1].obligations.len(), 2);
        assert_eq!(s[1].obligations[0], Obligation { mark: "x".into(), text: "`Vault.deposit` preserves it".into() });
        assert_eq!(s[1].details, vec!["kind: invariant · 1/2"]);
    }

    #[test]
    fn hand_written_lines_get_ids_and_keep_their_words() {
        let d = folder("hand");
        std::fs::create_dir_all(d.join(".formal")).unwrap();
        std::fs::write(path(&d), "# Statements\n\nmy own notes stay\n\n- [ ] withdraw never pays more than shares × pricePerShare\n- [X] S-04 · you · fee ≤ 1%\n").unwrap();
        let s = load(&d).unwrap();
        assert_eq!(s.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["S-05", "S-04"]);
        assert_eq!(s[0].text, "withdraw never pays more than shares × pricePerShare");
        assert_eq!(s[1].mark, "x");
        let text = read(&d);
        assert!(text.contains("my own notes stay"), "{text}");
        assert!(text.contains("<!-- next: S-06 -->"), "{text}");
        // Reading again changes nothing.
        load(&d).unwrap();
        assert_eq!(read(&d), text);
    }

    #[test]
    fn ids_are_never_reused_and_proposals_wait() {
        let d = folder("ids");
        let a = add(&d, "you", "Only the owner can change `fee`.", ' ', &[]).unwrap();
        let b = add(&d, "prover", "`totalSupply` equals the sum of `balanceOf`.", '?', &["why: minting must track balances".into()]).unwrap();
        assert_eq!((a.id.as_str(), b.id.as_str(), b.mark.as_str()), ("S-01", "S-02", "?"));
        assert!(add(&d, "you", "only the owner can change  `FEE`.", ' ', &[]).unwrap_err().contains("S-01"));
        remove(&d, "S-02").unwrap();
        let c = add(&d, "you", "withdraw reverts when shares > balance", ' ', &[]).unwrap();
        assert_eq!(c.id, "S-03");
        set_mark(&d, "S-01", 'x').unwrap();
        let s = load(&d).unwrap();
        assert_eq!(s.iter().map(|s| (s.id.as_str(), s.mark.as_str())).collect::<Vec<_>>(), vec![("S-01", "x"), ("S-03", " ")]);
        assert!(!read(&d).contains("minting"), "the removed statement's notes go with it");
    }

    /// A fixture vault as formal-ast sees it: who writes `fee`, `owner` and the balances.
    fn vault() -> crate::swarm_ctx::Context {
        let unit = |name: &str, writes: &[&str], reads: &[&str]| json!({ "name": name, "mutability": "nonpayable", "writes": writes, "reads": reads, "guards": 1, "external": 0, "arith": 0 });
        let mut internal = unit("Vault._setFee", &["fee"], &[]);
        internal["internal"] = json!(true);
        crate::swarm_ctx::Context {
            contracts: vec![crate::swarm_ctx::Contract {
                name: "Vault".into(),
                file: "src/Vault.sol".into(),
                model: None,
                functions: vec![],
                units: vec![
                    unit("Vault.setFee", &["fee"], &["owner"]),
                    unit("Vault.initialize", &["owner", "fee"], &[]),
                    unit("Vault.deposit", &["balanceOf", "totalSupply"], &["fee"]),
                    unit("Vault.transferOwnership", &["owner"], &["owner"]),
                    internal,
                ],
                slices: Default::default(),
            }],
            problems: vec![],
        }
    }

    #[test]
    fn only_the_owner_changes_fee_is_one_obligation_per_writer() {
        let f = derive(&vault(), &json!({ "kind": "access", "variables": ["fee"], "callers": "the owner", "means": "Every function that writes `fee` reverts unless the owner calls it.", "replies": ["Yes, that's what I meant", "No: initialize may set it once"] })).unwrap();
        assert_eq!(f.obligations, vec![
            "`Vault.setFee` — Vault (src/Vault.sol): reverts unless the owner calls, before it writes fee",
            "`Vault.initialize` — Vault (src/Vault.sol): reverts unless the owner calls, before it writes fee",
        ]);
        assert!(f.details.contains(&"kind: access · fee · by the owner".to_string()));
        assert!(f.asks());
        // Each obligation names its function the way the plan's items do.
        let ctx = vault();
        assert_eq!(ctx.target(&f.obligations[1]).map(|u| u.name().to_string()).as_deref(), Some("Vault.initialize"));
        let ask: Value = serde_json::from_str(&ask_text("S-01", &f)).unwrap();
        assert!(ask["question"].as_str().unwrap().contains("Every function that writes `fee` reverts unless the owner calls it."));
        assert!(ask["question"].as_str().unwrap().contains("2 functions: `Vault.setFee`, `Vault.initialize`"));
        assert_eq!(ask["replies"][1], "No: initialize may set it once");
    }

    #[test]
    fn what_formal_ast_doesnt_know_is_sent_back() {
        let ctx = vault();
        assert!(derive(&ctx, &json!({ "kind": "access", "variables": ["fees"], "callers": "the owner", "means": "x" })).unwrap_err().contains("\"fees\""));
        assert!(derive(&ctx, &json!({ "kind": "function", "function": "Vault.withdraw", "obligation": "x", "means": "x" })).unwrap_err().contains("no function"));
        assert!(derive(&ctx, &json!({ "kind": "access", "variables": ["fee"], "callers": "the owner", "means": " " })).unwrap_err().contains("means"));
        let f = derive(&ctx, &json!({ "kind": "function", "function": "Vault.deposit", "obligation": "reverts when assets is 0", "means": "deposit(0) reverts" })).unwrap();
        assert_eq!(f.obligations, vec!["`Vault.deposit` — Vault (src/Vault.sol): reverts when assets is 0"]);
        let later = derive(&ctx, &json!({ "kind": "invariant", "means": "totalSupply equals the sum of balanceOf" })).unwrap();
        assert!(!later.asks() && later.obligations.is_empty());
    }

    #[test]
    fn formalize_confirm_and_correct() {
        let d = folder("formalize");
        let s = add(&d, "you", "Only the owner can change `fee`.", ' ', &[]).unwrap();
        assert_eq!(awaiting_formalize(&d).map(|s| s.id), Some(s.id.clone()));
        let f = derive(&vault(), &json!({ "kind": "access", "variables": ["fee"], "callers": "the owner", "means": "Only the owner's calls write `fee`.", "assumptions": ["initialize runs once, from the deployer"] })).unwrap();
        record(&d, &s.id, &f).unwrap();
        let now = &load(&d).unwrap()[0];
        assert_eq!((now.mark.as_str(), kind(now)), ("?", Some("access")));
        assert_eq!(now.obligations.len(), 2);
        assert!(now.details.contains(&"assumes: initialize runs once, from the deployer".to_string()));
        assert_eq!(awaiting_confirm(&d).len(), 1);
        assert!(awaiting_formalize(&d).is_none());
        assert!(waiting_note(&d).contains("S-01"));

        // No: their correction stays under it, the reading goes, and it is formalized again with the correction.
        correct(&d, &s.id, "initialize may set it too, once").unwrap();
        let again = &load(&d).unwrap()[0];
        assert_eq!((again.mark.as_str(), kind(again), again.obligations.len()), (" ", None, 0));
        assert_eq!(again.details, vec!["you said: initialize may set it too, once"]);
        assert!(formalize_task(again).contains("initialize may set it too, once"));

        // Yes: open again with its obligations, ready to prove; a second yes is refused.
        record(&d, &s.id, &f).unwrap();
        assert!(confirm_tool_call(&d.to_string_lossy(), &json!({ "id": "S-01", "meant": true })).contains("confirmed"));
        let ready = &load(&d).unwrap()[0];
        assert_eq!((ready.mark.as_str(), kind(ready), ready.obligations.len()), (" ", Some("access"), 2));
        assert!(ready.details.contains(&"you said: initialize may set it too, once".to_string()));
        assert!(awaiting_formalize(&d).is_none(), "a confirmed statement isn't formalized again");
        assert!(confirm(&d, &s.id).is_err());

        // A job that ended without an answer says so and waits for the maintainer.
        let t = add(&d, "you", "the vault is safe", ' ', &[]).unwrap();
        record_failure(&d, &t.id, "").unwrap();
        let failed = load(&d).unwrap().into_iter().find(|x| x.id == t.id).unwrap();
        assert_eq!(failed.mark, "?");
        assert!(failed.details[0].starts_with("note: couldn't formalize it"));
    }

    #[test]
    fn the_tool_marks_who_said_it() {
        let d = folder("tool");
        let f = d.to_string_lossy().to_string();
        assert!(add_tool(&f, "assistant", &json!({ "text": "fee never exceeds 1%", "from": "maintainer" })).starts_with("added S-01"));
        assert!(add_tool(&f, "prover", &json!({ "text": "pricePerShare never drops", "from": "me", "why": "withdraw relies on it" })).starts_with("proposed S-02"));
        let s = load(&d).unwrap();
        assert_eq!((s[0].author.as_str(), s[0].mark.as_str()), ("you", " "));
        assert_eq!((s[1].author.as_str(), s[1].mark.as_str()), ("prover", "?"));
        assert_eq!(s[1].details, vec!["why: withdraw relies on it"]);
        assert!(add_tool(&f, "prover", &json!({ "text": "  ", "from": "me" })).starts_with("error:"));
    }
}
