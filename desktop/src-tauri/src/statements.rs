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
