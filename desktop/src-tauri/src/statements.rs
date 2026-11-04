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
const PROVABLE: [&str; 5] = ["function", "access", "invariant", "conservation", "sequence"];
/// Properties of the whole contract: proved one entry point at a time, after every plan item is covered.
const PROPERTIES: [&str; 3] = ["invariant", "conservation", "sequence"];

/// Whether a statement is about the whole contract (invariant, conservation, sequence), not one function.
pub fn is_property(s: &Statement) -> bool {
    kind(s).is_some_and(|k| PROPERTIES.contains(&k))
}

/// Lines under a statement that come from the maintainer or the agent that proposed it, kept when it is formalized again.
fn kept(detail: &str) -> bool {
    detail.starts_with("why: ") || detail.starts_with("you said: ")
}

/// The next open statement nobody has formalized yet.
pub fn awaiting_formalize(root: &Path) -> Option<Statement> {
    // Properties formalized before the swarm proved them were left without obligations: formalize them again.
    for s in load(root).unwrap_or_default() {
        if s.details.iter().any(|d| d.ends_with("statements come later")) {
            let _ = rewrite(root, &s.id, ' ', &[], &[]);
        }
    }
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
            // A property of the whole contract, proved inductively: one obligation per entry point that changes state,
            // each showing a successful call keeps it (a sequence: that no other account's call breaks it).
            details.push(format!("kind: {kind}"));
            let what = match kind.as_str() {
                "invariant" => "if it holds before a successful call, it holds after",
                "conservation" => "a successful call keeps the conserved quantity unchanged",
                _ => "no call to it by another account makes the claim false",
            };
            let only = strings(&input["functions"]);
            for f in &only {
                if !units.iter().any(|u| u.name() == f.trim_matches('`') || u.lean() == f.trim_matches('`')) {
                    return Err(format!("no function {f:?} in scope; `functions` lists them (Contract.fn)"));
                }
            }
            let named = |u: &crate::swarm_ctx::Unit| only.is_empty() || only.iter().any(|f| u.name() == f.trim_matches('`') || u.lean() == f.trim_matches('`'));
            let entry = |u: &&crate::swarm_ctx::Unit| u.unit["internal"] != true && u.unit["writes"].as_array().is_some_and(|w| !w.is_empty()) && named(u);
            for u in units.iter().filter(entry) {
                obligations.push(format!("{}: {what}", place(u)));
            }
            if obligations.is_empty() {
                details.push("note: no entry point in scope changes state, so nothing can break it".into());
            }
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
    let assumes: Vec<&str> = f.details.iter().filter_map(|d| d.strip_prefix("assumes: ")).map(|a| a.trim_end_matches('.')).collect();
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
            "functions": { "type": "array", "items": { "type": "string" }, "description": "invariant, conservation or sequence: only when the claim is about some entry points, those (Contract.fn as `functions` names them); left out, every entry point that changes state" },
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

// ---- proving: each obligation is a plan-like item through the prove → check → review loop ----

/// The next obligation to prove: of a confirmed statement (open or working, of a kind the swarm proves), the first
/// one not proved or blocked. Its number counts from 1 within the statement. The loop asks only when its queue has
/// nothing queued or running, so one marked working then lost its job (a queue cleared by hand) and is taken again.
pub fn next_obligation(root: &Path, plan_done: bool) -> Option<(Statement, usize)> {
    load(root).ok()?.into_iter().filter(|s| (s.mark == " " || s.mark == "~") && kind(s).is_some_and(|k| PROVABLE.contains(&k)) && (plan_done || !is_property(s))).find_map(|s| {
        let n = s.obligations.iter().position(|o| o.mark == " " || o.mark == "~")? + 1;
        Some((s, n))
    })
}

/// A statement's own mark from its obligations': all proved is proved, one disproved (or blocked) is disproved,
/// any progress is working.
fn rolled_up(current: &str, obligations: &[Obligation]) -> char {
    if !obligations.is_empty() && obligations.iter().all(|o| o.mark == "x") {
        'x'
    } else if obligations.iter().any(|o| o.mark == "!") {
        '!'
    } else if obligations.iter().any(|o| o.mark == "x" || o.mark == "~") {
        '~'
    } else {
        current.chars().next().unwrap_or(' ')
    }
}

/// Sets obligation `n`'s mark and the statement's own from them; returns the statement's new mark.
pub fn set_obligation(root: &Path, id: &str, n: usize, mark: char) -> Result<char, String> {
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let text = read(root);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let (i, end, mut s) = block(&lines, &text, id)?;
    let o = s.obligations.get_mut(n.wrapping_sub(1)).ok_or_else(|| format!("{id} has no obligation {n}"))?;
    o.mark = mark.to_string();
    let target = o.text.clone();
    let own = rolled_up(&s.mark, &s.obligations);
    let mut seen = 0;
    for l in lines.iter_mut().take(end).skip(i + 1) {
        let t = l.trim_start();
        if item(t).is_some() {
            seen += 1;
            if seen == n {
                *l = format!("  - [{mark}] {target}");
            }
        }
    }
    lines[i] = format!("- [{own}] {} · {} · {}", s.id, s.author, s.text);
    write(root, &lines)?;
    Ok(own)
}

/// The theorem an obligation must prove, by name: `S01.Vault_setFee` for `Vault.setFee` in S-01.
pub fn theorem_name(id: &str, lean: &str) -> String {
    let parts: Vec<String> = lean.split('.').map(|p| crate::swarm_ctx::name_part(p, false)).collect();
    format!("{}.{}", id.replace('-', ""), parts.join("_"))
}

/// Where its proof goes, under the Lake project (`dir` from `swarm_ctx::informal_dir`):
/// `Proofs/InformalSpecs/S01/VaultSetFee.lean`.
pub fn proof_file(id: &str, lean: &str, dir: &str) -> String {
    let module: String = lean.split('.').map(|p| crate::swarm_ctx::name_part(p, true)).collect();
    format!("{dir}/{}/{module}.lean", id.replace('-', ""))
}

/// The backticked def an obligation line names first.
pub fn def_of(obligation: &str) -> Option<&str> {
    obligation.split('`').nth(1).filter(|d| !d.is_empty())
}

/// What the prover gets on top of the function's brief: the statement, what it was confirmed to mean, and the theorem
/// to prove by name and file.
pub fn obligation_task(s: &Statement, n: usize, lib: &str, dir: &str) -> String {
    let o = &s.obligations[n - 1];
    let lean = def_of(&o.text).unwrap_or("");
    let means = s.details.iter().find_map(|d| d.strip_prefix("means: ")).unwrap_or("");
    let assumes: Vec<&str> = s.details.iter().filter_map(|d| d.strip_prefix("assumes: ")).collect();
    format!(
        "Statement {} ({} of {} functions): \"{}\"\nThe maintainer confirmed it means: {means}\n{}\nProve this about the function:\n\n> {}\n\n\
Name the theorem `{}` exactly (write `theorem {} …`, not inside a namespace) and put it in `{lib}/{}`, not the file named below; its statement must name `{lean}` fully qualified. The swarm checks that the theorem exists under that name, has no `sorry` (Lean's `#print axioms`), and shows its type, as Lean reports it, to the reviewer.",
        s.id,
        n,
        s.obligations.len(),
        s.text,
        if assumes.is_empty() { String::new() } else { format!("Assumptions it may use: {}.\n", assumes.join("; ")) },
        o.text.split_once("): ").map_or(o.text.as_str(), |(_, w)| w),
        theorem_name(&s.id, lean),
        theorem_name(&s.id, lean),
        proof_file(&s.id, lean, dir),
    )
}

/// What the reviewer gets on top: the statement and the theorem's type to check against it.
pub fn review_task(s: &Statement, n: usize) -> String {
    let o = &s.obligations[n - 1];
    let means = s.details.iter().find_map(|d| d.strip_prefix("means: ")).unwrap_or("");
    format!(
        "This item is obligation {n} of {} for statement {}: \"{}\" (confirmed to mean: {means}). Approve only if the theorem's type, as Lean reports it in the prover's notes, says what the obligation says: {}",
        s.obligations.len(),
        s.id,
        s.text,
        o.text.split_once("): ").map_or(o.text.as_str(), |(_, w)| w)
    )
}

/// The swarm's check of an obligation's theorem, after `lake build` passes: it exists under its name in the file it
/// should be in, it depends on no `sorryAx`, and its type names the def. Returns the type as Lean prints it.
pub async fn check_theorem(root: &Path, id: &str, lean: &str) -> Result<String, String> {
    let name = theorem_name(id, lean);
    let file = proof_file(id, lean, &crate::swarm_ctx::informal_dir(root));
    let lake = crate::swarm_ctx::lean_src(root).ok_or("there is no Lake project to check the theorem in")?;
    let body = std::fs::read_to_string(lake.join(&file)).map_err(|_| format!("the proof isn't in {file}; write it there"))?;
    if !body.lines().any(|l| l.trim_start().strip_prefix("theorem ").is_some_and(|r| r.starts_with(&format!("{name} ")) || r == name)) {
        return Err(format!("{file} has no `theorem {name}`; name the theorem exactly that"));
    }
    let module = file.trim_end_matches(".lean").replace('/', ".");
    let check = format!(".formal/check/{}.lean", name.replace('.', "_"));
    let path = root.join(&check);
    std::fs::create_dir_all(path.parent().unwrap_or(root)).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("import {module}\n#check @{name}\n#print axioms {name}\n")).map_err(|e| e.to_string())?;
    let out = crate::swarm2::lake::run(root, &format!("lake env lean {check}")).await.unwrap_or_else(|e| format!("error: {e}"));
    if !out.starts_with("exit 0") {
        return Err(format!("Lean couldn't check `{name}`:\n{}", out.lines().skip(1).take(30).collect::<Vec<_>>().join("\n")));
    }
    if out.contains("sorryAx") {
        return Err(format!("`{name}` depends on `sorry` (#print axioms lists sorryAx); finish the proof"));
    }
    let ty: String = out.lines().skip(1).take_while(|l| !l.contains("depends on") && !l.contains("does not depend")).collect::<Vec<_>>().join("\n").trim().to_string();
    if !ty.contains(lean) {
        return Err(format!("`{name}`'s statement doesn't mention `{lean}`; state it about `{lean}` itself, fully qualified. Lean reports:\n{ty}"));
    }
    Ok(ty)
}

/// .formal/statements.json: what proved each obligation (the theorems, the files, the approved notes), kept until the
/// statement is proved and its property goes into the audit file.
fn proofs_path(root: &Path) -> PathBuf {
    root.join(".formal").join("statements.json")
}

pub fn record_obligation(root: &Path, id: &str, n: usize, theorem: &str, files: &[String], notes: Option<&Value>) {
    let mut all: Value = std::fs::read_to_string(proofs_path(root)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    all[id][n.to_string()] = json!({ "theorem": theorem, "files": files, "notes": notes.cloned().unwrap_or(Value::Null) });
    let _ = std::fs::create_dir_all(root.join(".formal"));
    let _ = std::fs::write(proofs_path(root), serde_json::to_string_pretty(&all).unwrap_or_default());
}

/// A proved statement in Formal Mind's audit file, as `P-S01`: the maintainer's words as its title, what it was
/// confirmed to mean and each function's approved notes as its description, every obligation's theorem.
pub fn record_property(root: &Path, id: &str) -> Result<String, String> {
    let s = load(root)?.into_iter().find(|s| s.id == id).ok_or_else(|| format!("no statement {id}"))?;
    let all: Value = std::fs::read_to_string(proofs_path(root)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    let mut theorems: Vec<String> = vec![];
    let mut files: Vec<String> = vec![];
    let mut sections = vec![];
    // The statement's own assumptions, then each function's (the prover's or reviewer's notes), each once.
    let mut assumptions: Vec<String> = s.details.iter().filter_map(|d| d.strip_prefix("assumes: ")).map(sentence).collect();
    let add = |list: &mut Vec<String>, x: String| {
        if !x.is_empty() && !list.contains(&x) {
            list.push(x);
        }
    };
    for n in 1..=s.obligations.len() {
        let p = &all[id][n.to_string()];
        // The theorem it was asked for first, then the others the notes name.
        add(&mut theorems, p["theorem"].as_str().unwrap_or("").to_string());
        for t in p["notes"]["theorems"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            add(&mut theorems, t.to_string());
        }
        for f in p["files"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            add(&mut files, f.to_string());
        }
        for a in p["notes"]["assumptions"].as_str().unwrap_or("").split("; ").map(sentence) {
            add(&mut assumptions, a);
        }
        let o = &s.obligations[n - 1].text;
        let notes = p["notes"]["statement"].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string).unwrap_or_else(|| o.split_once("): ").map_or(o.clone(), |(_, w)| w.to_string()));
        sections.push(if s.obligations.len() == 1 { notes } else { format!("**`{}`**\n\n{notes}", def_of(o).unwrap_or("")) });
    }
    let means = s.details.iter().find_map(|d| d.strip_prefix("means: ")).unwrap_or("");
    let statement = format!("{means}\n\n{}", sections.join("\n\n"));
    let input = json!({ "statement": statement, "assumptions": assumptions.join(" "), "theorems": theorems });
    crate::swarm_ctx::record_statement_property(root, id, &s.text, &files, &input)
}

/// An assumption as a sentence of its own: trimmed, ending in one full stop.
fn sentence(a: &str) -> String {
    let a = one_line(a);
    let a = a.trim_end_matches(['.', ';']);
    if a.is_empty() { String::new() } else { format!("{a}.") }
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
            regenerated: vec![],
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
        let dotted = Formalized { details: vec!["assumes: one.".into(), "assumes: two.".into()], ..f.clone() };
        assert!(serde_json::from_str::<Value>(&ask_text("S-01", &dotted)).unwrap()["question"].as_str().unwrap().ends_with("Assuming: one; two."));
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
        assert!(later.asks() && !later.obligations.is_empty() && later.obligations.iter().all(|o| o.contains("holds after")), "{:?}", later.obligations);
        let units = ctx.units();
        let some = units.iter().find(|u| u.unit["internal"] != true && u.unit["writes"].as_array().is_some_and(|w| !w.is_empty())).unwrap();
        let only = derive(&ctx, &json!({ "kind": "conservation", "means": "m", "functions": [some.name()] })).unwrap();
        assert_eq!(only.obligations.len(), 1, "{:?}", only.obligations);
        assert!(derive(&ctx, &json!({ "kind": "conservation", "means": "m", "functions": ["Nope.f"] })).is_err());
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

    /// S-01 confirmed on the fixture vault: two functions to prove.
    fn confirmed(d: &Path) -> Statement {
        let s = add(d, "you", "Only the owner can change `fee`.", ' ', &[]).unwrap();
        let f = derive(&vault(), &json!({ "kind": "access", "variables": ["fee"], "callers": "the owner", "means": "Only the owner's calls write `fee`.", "assumptions": ["initialize runs once"] })).unwrap();
        record(d, &s.id, &f).unwrap();
        confirm(d, &s.id).unwrap();
        load(d).unwrap().into_iter().find(|x| x.id == s.id).unwrap()
    }

    #[test]
    fn obligations_are_proved_one_function_at_a_time() {
        let d = folder("obligations");
        // Not confirmed yet: nothing to prove.
        let waiting = add(&d, "you", "deposit(0) reverts", ' ', &[]).unwrap();
        record(&d, &waiting.id, &derive(&vault(), &json!({ "kind": "function", "function": "Vault.deposit", "obligation": "reverts when assets is 0", "means": "deposit(0) reverts" })).unwrap()).unwrap();
        assert!(next_obligation(&d, true).is_none());
        let s = confirmed(&d);
        assert_eq!(next_obligation(&d, true).map(|(s, n)| (s.id, n)), Some((s.id.clone(), 1)));
        assert_eq!(set_obligation(&d, &s.id, 1, '~').unwrap(), '~');
        // Still the first: working and nothing queued means its job was lost.
        assert_eq!(next_obligation(&d, true).map(|(_, n)| n), Some(1));
        assert_eq!(set_obligation(&d, &s.id, 1, 'x').unwrap(), '~');
        assert_eq!(next_obligation(&d, true).map(|(_, n)| n), Some(2));
        assert_eq!(set_obligation(&d, &s.id, 2, 'x').unwrap(), 'x');
        assert!(next_obligation(&d, true).is_none());
        let done = load(&d).unwrap().into_iter().find(|x| x.id == s.id).unwrap();
        assert_eq!(done.obligations.iter().map(|o| o.mark.as_str()).collect::<Vec<_>>(), vec!["x", "x"]);
        assert_eq!(done.mark, "x");
        // The obligation lines keep their words, so the plan's lookup still finds their functions.
        assert_eq!(vault().target(&done.obligations[1].text).map(|u| u.name().to_string()).as_deref(), Some("Vault.initialize"));
        // A blocked function leaves the statement blocked, never proved.
        let b = folder("blocked");
        let t = confirmed(&b);
        set_obligation(&b, &t.id, 1, 'x').unwrap();
        assert_eq!(set_obligation(&b, &t.id, 2, '!').unwrap(), '!');
        assert!(next_obligation(&b, true).is_none());
    }

    #[test]
    fn the_theorem_and_its_file_are_named_for_the_statement() {
        assert_eq!(theorem_name("S-01", "Vault.setFee"), "S01.Vault_setFee");
        assert_eq!(proof_file("S-01", "WETH9.«»", "Refinement/Statements"), "Refinement/Statements/S01/WETH9Fallback.lean");
        assert_eq!(theorem_name("S-01", "WETH9.«»"), "S01.WETH9_fallback");
        assert_eq!(theorem_name("S-01", "Vault._setFee"), "S01.Vault__setFee");
        assert_eq!(proof_file("S-01", "Vault._setFee", "Refinement/Statements"), "Refinement/Statements/S01/VaultSetFee.lean");
        let s = confirmed(&folder("task"));
        let t = obligation_task(&s, 2, "formal", "Refinement/Statements");
        assert!(t.contains("`S01.Vault_initialize`") && t.contains("formal/Refinement/Statements/S01/VaultInitialize.lean"), "{t}");
        assert!(t.contains("Only the owner's calls write `fee`.") && t.contains("initialize runs once"), "{t}");
        assert!(review_task(&s, 1).contains("reverts unless the owner calls, before it writes fee"));
    }

    #[test]
    fn a_proved_statement_is_one_property_in_the_audit_file() {
        let d = folder("property");
        let s = confirmed(&d);
        record_obligation(&d, &s.id, 1, "S01.Vault_setFee", &["formal/Refinement/Statements/S01/VaultSetFee.lean".into()], Some(&json!({ "statement": "`Vault.setFee` reverts unless `owner` calls.", "assumptions": "The model matches the Solidity.; initialize runs once", "theorems": ["S01.Vault_setFee", "Vault_setFee_spec"] })));
        record_obligation(&d, &s.id, 2, "S01.Vault_initialize", &["formal/Refinement/Statements/S01/VaultInitialize.lean".into()], None);
        let at = record_property(&d, &s.id).unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(d.join(&at)).unwrap_or_else(|_| std::fs::read_to_string(&at).unwrap())).unwrap();
        let p = doc["properties"].as_array().unwrap().iter().find(|p| p["id"] == "P-S01").expect("P-S01");
        assert_eq!(p["title"], "Only the owner can change `fee`.");
        assert_eq!(p["statement"], "S-01");
        assert_eq!(p["theorems"], json!([{ "name": "S01.Vault_setFee" }, { "name": "Vault_setFee_spec" }, { "name": "S01.Vault_initialize" }]));
        assert!(p["description"].as_str().unwrap().ends_with("**Assumptions.** initialize runs once. The model matches the Solidity."), "{}", p["description"]);
        let desc = p["description"].as_str().unwrap();
        assert!(desc.starts_with("Only the owner's calls write `fee`."), "{desc}");
        assert!(desc.contains("**`Vault.setFee`**\n\n`Vault.setFee` reverts unless `owner` calls.") && desc.contains("**`Vault.initialize`**\n\nreverts unless the owner calls"), "{desc}");
        assert!(desc.contains("**Assumptions.** initialize runs once."), "{desc}");
        assert_eq!(p["files"].as_array().unwrap().len(), 2);
    }

    /// The theorem check on a real (tiny) Lake project: the right name and no sorry pass, with Lean's type; a sorry,
    /// a wrong name or a statement about something else don't. Skipped without lake.
    #[tokio::test(flavor = "current_thread")]
    async fn the_theorem_check_asks_lean() {
        if std::process::Command::new("lake").arg("--version").output().is_err() {
            return;
        }
        let d = folder("lean");
        let lake = d.join("formal");
        std::fs::create_dir_all(lake.join("Refinement/Statements/S01")).unwrap();
        std::fs::write(lake.join("lakefile.toml"), "name = \"fixture\"\ndefaultTargets = [\"Refinement\"]\n\n[[lean_lib]]\nname = \"Refinement\"\nglobs = [\"Refinement.+\"]\n").unwrap();
        std::fs::write(lake.join("lean-toolchain"), "leanprover/lean4:v4.35.0\n").unwrap();
        let file = lake.join(proof_file("S-01", "Vault.setFee", "Refinement/Statements"));
        let write = |body: &str| std::fs::write(&file, format!("def Vault.setFee (owner sender fee : Nat) : Option Nat := if sender = owner then some fee else none\n\n{body}\n")).unwrap();
        write("theorem S01.Vault_setFee (owner sender fee : Nat) (h : sender ≠ owner) : Vault.setFee owner sender fee = none := by\n  simp [Vault.setFee, h]");
        let build = crate::swarm2::lake::run(&d, "lake build").await.unwrap_or_else(|e| format!("error: {e}"));
        assert!(build.starts_with("exit 0"), "{build}");
        let ty = check_theorem(&d, "S-01", "Vault.setFee").await.unwrap();
        assert!(ty.contains("Vault.setFee owner sender fee = none"), "{ty}");

        write("theorem S01.Vault_setFee (owner sender fee : Nat) (h : sender ≠ owner) : Vault.setFee owner sender fee = none := by\n  sorry");
        crate::swarm2::lake::run(&d, "lake build").await.unwrap_or_else(|e| format!("error: {e}"));
        assert!(check_theorem(&d, "S-01", "Vault.setFee").await.unwrap_err().contains("sorry"));

        write("theorem S01.setFee (owner : Nat) : owner = owner := rfl");
        assert!(check_theorem(&d, "S-01", "Vault.setFee").await.unwrap_err().contains("has no `theorem S01.Vault_setFee`"));

        write("theorem S01.Vault_setFee (owner : Nat) : owner = owner := rfl");
        crate::swarm2::lake::run(&d, "lake build").await.unwrap_or_else(|e| format!("error: {e}"));
        assert!(check_theorem(&d, "S-01", "Vault.setFee").await.unwrap_err().contains("doesn't mention `Vault.setFee`"));
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
