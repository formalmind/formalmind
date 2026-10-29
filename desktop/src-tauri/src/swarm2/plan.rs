//! `.formal/plan.md`: the swarm's checklist, one item per function in scope (SPEC.md §2.2).
//!
//! An item is any line whose trimmed start is `- [m] ` with `m` one of ` ` (open), `x`/`X` (proved), `!` (blocked or a
//! bug) or `~` (a confirmed statement obligation). Items are numbered 1.. in file order, nested ones included. Changing
//! a mark rewrites that one character and nothing else, so a folder's plan round-trips byte for byte.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// What a new plan starts with, before the first item.
pub const HEADER: &str = "# Plan\n\nOne item per function in scope, from formal-ast: the contracts the Foundry scripts deploy or call, with their bases; the scripts' calls first, then the internal and library functions the model has a def for. `- [x]` is proved on the Proofs page, `- [!]` blocked or a finding.\n\n";

/// An item's state, the character between the brackets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    /// ` `: waiting for the prover.
    Open,
    /// `x` (or `X` as written by hand): proved and approved.
    Proved,
    /// `!`: blocked after three attempts, or a bug was reported.
    Blocked,
    /// `~`: a confirmed statement obligation.
    Statement,
    /// Any other character, written by hand: still an item (so numbering matches older builds), kept as written and
    /// never picked as open work.
    Other(char),
}

impl Mark {
    pub fn from_char(c: char) -> Option<Mark> {
        match c {
            ' ' => Some(Mark::Open),
            'x' | 'X' => Some(Mark::Proved),
            '!' => Some(Mark::Blocked),
            '~' => Some(Mark::Statement),
            '\r' | '\n' => None,
            c => Some(Mark::Other(c)),
        }
    }

    /// The character written back (`X` reads as proved and is written as `x`).
    pub fn as_char(self) -> char {
        match self {
            Mark::Open => ' ',
            Mark::Proved => 'x',
            Mark::Blocked => '!',
            Mark::Statement => '~',
            Mark::Other(c) => c,
        }
    }
}

impl Serialize for Mark {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_char().encode_utf8(&mut [0; 4]))
    }
}

/// One plan item, as `swarm_plan` returns it: `{index, mark, text}`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PlanItem {
    /// 1-based, in file order.
    pub index: usize,
    pub mark: Mark,
    /// The line after `- [m] `, trimmed.
    pub text: String,
}

impl PlanItem {
    /// The item's Lean def: the first backticked token (`AsyncSwap.useNonce`), if any.
    pub fn def(&self) -> Option<&str> {
        self.text.split('`').nth(1).filter(|d| !d.is_empty())
    }
}

/// A generated item line (SPEC.md §2.2):
/// `` - [ ] `Lean.def` — Contract (src/X.sol:12): <mutability> · writes [a, b] · guards N · external calls N[ · called by S1, S2] ``.
#[derive(Clone, Debug, Default)]
pub struct ItemLine {
    pub def: String,
    pub contract: String,
    /// `src/X.sol:12`
    pub location: String,
    pub mutability: String,
    pub writes: Vec<String>,
    pub guards: usize,
    pub external_calls: usize,
    /// The scripts that call it; left out when empty.
    pub called_by: Vec<String>,
}

impl ItemLine {
    pub fn render(&self, mark: Mark) -> String {
        let called = if self.called_by.is_empty() { String::new() } else { format!(" · called by {}", self.called_by.join(", ")) };
        format!(
            "- [{}] `{}` — {} ({}): {} · writes [{}] · guards {} · external calls {}{called}",
            mark.as_char(),
            self.def,
            self.contract,
            self.location,
            self.mutability,
            self.writes.join(", "),
            self.guards,
            self.external_calls
        )
    }
}

pub fn path(root: &Path) -> PathBuf {
    root.join(".formal").join("plan.md")
}

/// The mark and text of an item line, or None for any other line.
fn item_of(line: &str) -> Option<(Mark, &str)> {
    let rest = line.trim_start().strip_prefix("- [")?;
    let mut chars = rest.chars();
    let mark = Mark::from_char(chars.next()?)?;
    let after = chars.as_str().strip_prefix(']')?;
    // `- [x] text`, or an empty item at the end of its line.
    let line_end = after.trim_end_matches(['\r', '\n']);
    if line_end.is_empty() {
        return Some((mark, ""));
    }
    Some((mark, after.strip_prefix(' ')?.trim()))
}

/// Parses plan text into its items.
pub fn parse(text: &str) -> Vec<PlanItem> {
    text.lines()
        .filter_map(item_of)
        .enumerate()
        .map(|(i, (mark, text))| PlanItem { index: i + 1, mark, text: text.to_string() })
        .collect()
}

/// The folder's plan; a missing or unreadable file is an empty plan.
pub fn read(root: &Path) -> Vec<PlanItem> {
    parse(&std::fs::read_to_string(path(root)).unwrap_or_default())
}

/// `text` with item `index`'s mark set, every other byte unchanged; None when there is no such item.
pub fn with_mark(text: &str, index: usize, mark: Mark) -> Option<String> {
    let mut n = 0;
    let mut out = String::with_capacity(text.len());
    let mut found = false;
    for line in text.split_inclusive('\n') {
        if !found && item_of(line).is_some() {
            n += 1;
            if n == index {
                // The mark is the character right after the first `- [`.
                let at = line.find("- [").unwrap() + 3;
                let width = line[at..].chars().next().unwrap().len_utf8();
                out.push_str(&line[..at]);
                out.push(mark.as_char());
                out.push_str(&line[at + width..]);
                found = true;
                continue;
            }
        }
        out.push_str(line);
    }
    found.then_some(out)
}

/// Sets item `index`'s mark in the folder's plan. Ok(false) when the plan has no such item.
pub fn set_mark(root: &Path, index: usize, mark: Mark) -> std::io::Result<bool> {
    let p = path(root);
    let text = match std::fs::read_to_string(&p) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    match with_mark(&text, index, mark) {
        Some(out) if out != text => std::fs::write(&p, out).map(|_| true),
        Some(_) => Ok(true),
        None => Ok(false),
    }
}

/// Appends item lines (each without its newline), creating the plan with [`HEADER`] when there is none. A plan that
/// doesn't end in a newline gets one first.
pub fn append(root: &Path, lines: &[String]) -> std::io::Result<()> {
    if lines.is_empty() {
        return Ok(());
    }
    let p = path(root);
    let mut text = match std::fs::read_to_string(&p) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => HEADER.to_string(),
        Err(e) => return Err(e),
    };
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    for l in lines {
        text.push_str(l);
        text.push('\n');
    }
    std::fs::create_dir_all(p.parent().unwrap())?;
    std::fs::write(&p, text)
}

/// The item naming this def (its first backticked token); backticks around `def` are ignored.
pub fn find_def<'a>(items: &'a [PlanItem], def: &str) -> Option<&'a PlanItem> {
    let def = def.trim().trim_matches('`');
    items.iter().find(|i| i.def() == Some(def))
}

/// The first open item `taken` doesn't claim (B14: the next `prove` job).
pub fn first_open(items: &[PlanItem], taken: impl Fn(usize) -> bool) -> Option<&PlanItem> {
    items.iter().find(|i| i.mark == Mark::Open && !taken(i.index))
}

/// `reopen(defs)` (B19): sets each named item back to open. Returns (reopened, not in the plan), by def as given.
pub fn reopen(root: &Path, defs: &[String]) -> std::io::Result<(Vec<String>, Vec<String>)> {
    let items = read(root);
    let (mut done, mut unknown) = (vec![], vec![]);
    for d in defs {
        let name = d.trim().trim_matches('`').to_string();
        match find_def(&items, &name) {
            Some(i) => {
                if i.mark != Mark::Open {
                    set_mark(root, i.index, Mark::Open)?;
                }
                done.push(name);
            }
            None => unknown.push(name),
        }
    }
    Ok((done, unknown))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hand_written_marks_still_count_as_items() {
        let items = parse("- [?] `a` maybe\n- [ ] `b`\n");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].mark, Mark::Other('?'));
        assert_eq!(items[1].index, 2);
    }

    fn folder(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("fm2-plan-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".formal")).unwrap();
        root
    }

    #[test]
    fn plan_round_trip() {
        let root = folder("round-trip");
        // Hand edits, CRLF, no final newline and odd lines all survive a mark change untouched.
        let text = "# Plan\r\n\r\nNotes - [ ] not an item\n- [ ] first (a.sol)\n- [x] second\n  - [ ] third\n\t* [ ] bullet\n- [?] unknown mark\n- [~] `S-01.1` obligation";
        std::fs::write(path(&root), text).unwrap();
        assert_eq!(read(&root).len(), 5, "`- [?]` counts, as in older builds");
        set_mark(&root, 1, Mark::Open).unwrap();
        assert_eq!(std::fs::read_to_string(path(&root)).unwrap(), text, "an unchanged mark writes nothing new");
        set_mark(&root, 3, Mark::Proved).unwrap();
        set_mark(&root, 1, Mark::Blocked).unwrap();
        let after = std::fs::read_to_string(path(&root)).unwrap();
        assert_eq!(after, text.replace("- [ ] first", "- [!] first").replace("  - [ ] third", "  - [x] third"));
        set_mark(&root, 3, Mark::Open).unwrap();
        set_mark(&root, 1, Mark::Open).unwrap();
        assert_eq!(std::fs::read_to_string(path(&root)).unwrap(), text);
        assert!(!set_mark(&root, 9, Mark::Proved).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nested_items_count_and_capital_x_reads_as_proved() {
        let p = parse("# Plan\n\n- [ ] first (a.sol)\n- [X] second\n    - [!] third\n- [~] fourth\n");
        let marks: Vec<Mark> = p.iter().map(|i| i.mark).collect();
        assert_eq!(marks, vec![Mark::Open, Mark::Proved, Mark::Blocked, Mark::Statement]);
        assert_eq!(p.iter().map(|i| i.index).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
        assert_eq!((p[0].text.as_str(), p[2].text.as_str()), ("first (a.sol)", "third"));
        assert_eq!(serde_json::to_value(&p[1]).unwrap()["mark"], "x");
    }

    #[test]
    fn one_item_per_function_line_format() {
        let mut l = ItemLine {
            def: "AsyncSwap.useNonce".into(),
            contract: "AsyncSwap".into(),
            location: "src/AsyncSwap.sol:12".into(),
            mutability: "nonpayable".into(),
            writes: vec!["nonces".into(), "owner".into()],
            guards: 1,
            external_calls: 0,
            called_by: vec![],
        };
        assert_eq!(l.render(Mark::Open), "- [ ] `AsyncSwap.useNonce` — AsyncSwap (src/AsyncSwap.sol:12): nonpayable · writes [nonces, owner] · guards 1 · external calls 0");
        l.called_by = vec!["Deploy".into(), "Fill".into()];
        let line = l.render(Mark::Proved);
        assert!(line.ends_with("external calls 0 · called by Deploy, Fill"));
        let items = parse(&line);
        assert_eq!(items[0].def(), Some("AsyncSwap.useNonce"));
    }

    #[test]
    fn append_creates_the_header_once() {
        let root = folder("append");
        append(&root, &["- [ ] `A.f` — A".into()]).unwrap();
        append(&root, &["- [x] `A.g` — A".into()]).unwrap();
        let text = std::fs::read_to_string(path(&root)).unwrap();
        assert_eq!(text, format!("{HEADER}- [ ] `A.f` — A\n- [x] `A.g` — A\n"));
        // A hand-written plan without a final newline keeps its lines whole.
        std::fs::write(path(&root), "- [ ] `A.f` — A").unwrap();
        append(&root, &["- [ ] `A.h` — A".into()]).unwrap();
        assert_eq!(read(&root).len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn b14_first_open_item_not_claimed_elsewhere() {
        let p = parse("- [x] `A.a`\n- [ ] `A.b`\n- [!] `A.c`\n- [ ] `A.d`\n");
        assert_eq!(first_open(&p, |_| false).map(|i| i.index), Some(2));
        assert_eq!(first_open(&p, |i| i == 2).map(|i| i.index), Some(4));
        assert!(first_open(&p, |_| true).is_none());
    }

    #[test]
    fn b19_reopen_by_def() {
        let root = folder("reopen");
        std::fs::write(path(&root), "# Plan\n\n- [x] `AsyncSwap.useNonce` — AsyncSwap\n- [!] `AsyncFiller.fill` — AsyncFiller\n- [x] `AsyncSwap.key` — AsyncSwap\n").unwrap();
        let (done, unknown) = reopen(&root, &["`AsyncSwap.useNonce`".into(), "AsyncFiller.fill".into(), "Nope.f".into()]).unwrap();
        assert_eq!(done, vec!["AsyncSwap.useNonce", "AsyncFiller.fill"]);
        assert_eq!(unknown, vec!["Nope.f"]);
        let marks: Vec<Mark> = read(&root).iter().map(|i| i.mark).collect();
        assert_eq!(marks, vec![Mark::Open, Mark::Open, Mark::Proved]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_plan_is_empty() {
        let root = folder("missing");
        assert!(read(&root).is_empty());
        assert!(!set_mark(&root, 1, Mark::Proved).unwrap());
        assert!(!path(&root).exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
