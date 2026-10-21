//! Formal Mind's internal audit: its own work on a folder (the swarm's findings with their PoCs, the Proofs coverage
//! and the proofs its reviewer approved) written as a `formalmind.audit/v1` file (docs/audit-format.md) in the audit
//! folder, `formal-mind.audit.json`, which Bugs reads like any other audit. That file is then rendered as Formal
//! Mind's report: AsciiDoc in .formal/report/ in the house style (learned from Spearbit's and Certora's reports: a
//! project scope table linking the repository and commit, colour-coded summaries, a header strip per finding, Context
//! links at the audited commit, the fix's pull request, and a Formal Verification chapter of properties and the
//! theorems that prove them), and a PDF beside the JSON when asciidoctor-pdf is installed. External audits are kept
//! separate and are not part of it. Nothing is read out of PDFs.

use crate::swarm_ctx::in_scope;
use formal_ast::{analyze_full, formal_json};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};


#[derive(Clone, Debug, PartialEq)]
pub struct Finding {
    pub id: String,
    /// Critical, High, Medium, Low or Informational.
    pub severity: String,
    pub title: String,
    /// Fixed, Works as expected, Acknowledged, Rejected or Open.
    pub status: String,
    pub evidence: String,
    /// The report it comes from (its file name, as the index's heading names it).
    pub report: String,
    /// The report's own section for it (Markdown), when the report is in the folder.
    pub body: Option<String>,
}

fn severity_of(s: &str) -> &'static str {
    let s = s.trim().to_ascii_lowercase();
    if s.starts_with("crit") {
        "Critical"
    } else if s.starts_with("high") {
        "High"
    } else if s.starts_with("med") {
        "Medium"
    } else if s.starts_with("low") {
        "Low"
    } else {
        "Informational"
    }
}

fn status_of(s: &str) -> &'static str {
    let s = s.to_ascii_lowercase();
    if s.contains("fixed") {
        "Fixed"
    } else if s.contains("works as expected") || s.contains("intended") {
        "Works as expected"
    } else if s.contains("acknowledged") {
        "Acknowledged"
    } else if s.contains("rejected") || s.contains("invalid") {
        "Rejected"
    } else {
        "Open"
    }
}

/// A Markdown table row's cells (`\|` stays inside a cell).
fn cells(line: &str) -> Vec<String> {
    let inner = line.trim().trim_start_matches('|');
    let inner = inner.strip_suffix('|').filter(|r| !r.ends_with('\\')).unwrap_or(inner);
    let mut out = vec![String::new()];
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'|') => {
                out.last_mut().unwrap().push('|');
                chars.next();
            }
            '|' => out.push(String::new()),
            _ => out.last_mut().unwrap().push(c),
        }
    }
    out.into_iter().map(|c| c.trim().to_string()).collect()
}

/// The findings in an audit index: every `| ID | Severity | Finding | Status | Evidence |` table, under the `## <report>`
/// heading it belongs to.
pub fn parse_index(text: &str) -> Vec<Finding> {
    let mut out = vec![];
    let mut report = String::new();
    let mut cols: Option<Vec<String>> = None;
    for line in text.lines() {
        let t = line.trim();
        if let Some(h) = t.strip_prefix("## ") {
            // `## lee-audit.md` or `## [lee-audit.md](lee-audit.md)`
            report = h.trim().trim_start_matches('[').split(']').next().unwrap_or(h).trim().to_string();
            cols = None;
            continue;
        }
        if !t.starts_with('|') {
            cols = None;
            continue;
        }
        let c = cells(t);
        match &cols {
            None if c.first().is_some_and(|x| x.eq_ignore_ascii_case("id")) => cols = Some(c.iter().map(|x| x.to_ascii_lowercase()).collect()),
            Some(_) if c.iter().all(|x| x.chars().all(|ch| ch == '-' || ch == ':')) => {}
            Some(h) => {
                let get = |k: &str| h.iter().position(|x| x.starts_with(k)).and_then(|i| c.get(i)).cloned().unwrap_or_default();
                out.push(Finding {
                    id: get("id"),
                    severity: severity_of(&get("severity")).into(),
                    title: get("finding"),
                    status: status_of(&get("status")).into(),
                    evidence: get("evidence"),
                    report: report.clone(),
                    body: None,
                });
            }
            None => {}
        }
    }
    out
}

/// The section `### [ID] …` of a Markdown report, without its heading, up to the next heading of that level or above.
pub fn section(text: &str, id: &str) -> Option<String> {
    if id.is_empty() || id == "—" || id == "-" {
        return None;
    }
    let lines: Vec<&str> = text.lines().collect();
    let is_head = |l: &str| {
        let l = l.trim_start_matches('#').trim();
        l.starts_with(&format!("[{id}]")) || l.starts_with(&format!("{id} ")) || l.starts_with(&format!("{id}:"))
    };
    let start = lines.iter().position(|l| l.starts_with("##") && is_head(l))?;
    let level = lines[start].chars().take_while(|c| *c == '#').count();
    let mut fence = false;
    let mut end = lines.len();
    for (i, l) in lines.iter().enumerate().skip(start + 1) {
        if l.trim_start().starts_with("```") {
            fence = !fence;
        }
        let h = l.chars().take_while(|c| *c == '#').count();
        if !fence && h > 0 && h <= level && l[h..].starts_with(' ') {
            end = i;
            break;
        }
    }
    let body = lines[start + 1..end].join("\n");
    let body = body.trim().trim_end_matches("---").trim();
    (!body.is_empty()).then(|| body.to_string())
}

/// A swarm bug (.formal/bugs/*.md: `# title`, `**Severity:** …`, `**Location:** …`) as a finding.
fn swarm_bug(name: &str, text: &str) -> Finding {
    let title = text.lines().next().unwrap_or("").trim_start_matches('#').trim().to_string();
    let sev = regex::Regex::new(r"(?i)\*\*Severity:?\*\*:?\s*([\w-]+)").unwrap().captures(text).map(|c| c[1].to_string()).unwrap_or_default();
    let body = text.lines().skip(1).collect::<Vec<_>>().join("\n").trim().to_string();
    Finding { id: name.trim_end_matches(".md").to_string(), severity: severity_of(&sev).into(), title, status: "Open".into(), evidence: String::new(), report: ".formal/bugs".into(), body: Some(body) }
}

// ---- code excerpts ----

/// Where a finding is: the section's `**Location**` (or the first `File.sol:N` it mentions), as (file, line or function).
fn location(body: &str) -> Option<(String, String)> {
    let token = regex::Regex::new(r"([\w./-]+\.sol)(?::|#L)([\w-]+)").unwrap();
    let loc = body.lines().find(|l| l.to_ascii_lowercase().contains("**location"));
    let pick = |hay: &str| token.captures_iter(hay).find(|c| !c[1].ends_with(".t.sol")).map(|c| (c[1].to_string(), c[2].trim_start_matches('L').to_string()));
    loc.and_then(pick).or_else(|| {
        let re = regex::Regex::new(r"([\w./-]+\.sol)(?::|#L)(\d+(?:-L?\d+)?)").unwrap();
        let found = re.captures_iter(body).find(|c| !c[1].ends_with(".t.sol")).map(|c| (c[1].to_string(), c[2].replace('L', "")));
        found
    })
}

/// The folder's files with this name (or path suffix), src/ first; skips dependencies and build output.
fn resolve(root: &Path, file: &str) -> Option<String> {
    if root.join(file).is_file() {
        return Some(file.to_string());
    }
    let name = file.rsplit('/').next()?;
    let mut found = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for e in read.flatten() {
            let p = e.path();
            let n = e.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                if !n.starts_with('.') && !["lib", "node_modules", "out", "cache", "broadcast", "target"].contains(&n.as_str()) {
                    stack.push(p);
                }
            } else if n == name {
                let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                if rel.ends_with(file) {
                    found.push(rel);
                }
            }
        }
    }
    found.sort_by_key(|r| (!r.starts_with("src/"), r.len()));
    found.into_iter().next()
}

/// The lines (1-based, inclusive) a function spans, found by its `function name(` (or `receive(`/`fallback(`/
/// `constructor(`) and brace matching; at most `cap` lines.
fn function_lines(text: &str, name: &str, cap: usize) -> Option<(usize, usize)> {
    let lines: Vec<&str> = text.lines().collect();
    let needle = regex::Regex::new(&format!(r"\b(function\s+{0}|{0})\s*\(", regex::escape(name))).ok()?;
    let start = lines.iter().position(|l| needle.is_match(l) && (l.contains("function") || ["receive", "fallback", "constructor"].contains(&name)))?;
    let mut depth = 0i32;
    let mut opened = false;
    for (i, l) in lines.iter().enumerate().skip(start) {
        for c in l.chars() {
            match c {
                '{' => {
                    depth += 1;
                    opened = true;
                }
                '}' => depth -= 1,
                _ => {}
            }
        }
        if (opened && depth <= 0) || (!opened && l.trim_end().ends_with(';')) || i + 1 - start >= cap {
            return Some((start + 1, i + 1));
        }
    }
    Some((start + 1, lines.len()))
}

// ---- Markdown to AsciiDoc ----

/// Inline Markdown as AsciiDoc: code spans pass through literally, links become `url[text]` (or just the text for
/// links inside the repository).
fn inline(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    let link = regex::Regex::new(r"\[([^\]]+)\]\(([^)\s]+)\)").unwrap();
    while !rest.is_empty() {
        if let Some(i) = rest.find('`') {
            if let Some(j) = rest[i + 1..].find('`') {
                out.push_str(&text_part(&rest[..i], &link));
                let code = &rest[i + 1..i + 1 + j];
                out.push_str(&code_span(code));
                rest = &rest[i + 2 + j..];
                continue;
            }
        }
        out.push_str(&text_part(rest, &link));
        break;
    }
    out
}

/// A code span that AsciiDoc leaves alone (`*`, `_`, `{…}` and `+` included).
fn code_span(code: &str) -> String {
    if code.contains("++") {
        format!("`pass:c[{}]`", code.replace(']', "\\]"))
    } else {
        format!("`++{code}++`")
    }
}

fn text_part(s: &str, link: &regex::Regex) -> String {
    link.replace_all(s, |c: &regex::Captures| {
        let (t, u) = (&c[1], &c[2]);
        if u.starts_with("http://") || u.starts_with("https://") {
            format!("{u}[{}]", t.replace(']', "\\]"))
        } else {
            t.to_string()
        }
    })
    .to_string()
}

/// Markdown (a report's section, a bug's body) as AsciiDoc inside a finding: headings become `===`, fences source
/// blocks, tables AsciiDoc tables, lists AsciiDoc lists.
pub fn md_to_adoc(md: &str) -> String {
    let mut out: Vec<String> = vec![];
    let mut lines = md.lines().peekable();
    while let Some(line) = lines.next() {
        let t = line.trim_start();
        if let Some(lang) = t.strip_prefix("```") {
            let lang = lang.trim();
            let mut code = vec![];
            for l in lines.by_ref() {
                if l.trim_start().starts_with("```") {
                    break;
                }
                code.push(l.replace("tag::", "tag:{empty}:").replace("end::", "end:{empty}:"));
            }
            // A delimiter longer than any dash line in the code.
            let fence = "-".repeat(code.iter().filter(|l| l.trim().chars().all(|c| c == '-')).map(|l| l.trim().len() + 1).max().unwrap_or(4).max(4));
            out.push(if lang.is_empty() { "[source]".into() } else { format!("[source,{lang}]") });
            out.push(fence.clone());
            out.extend(code);
            out.push(fence);
            continue;
        }
        if t.starts_with('|') {
            let mut rows = vec![cells(t)];
            while let Some(l) = lines.peek() {
                if !l.trim_start().starts_with('|') {
                    break;
                }
                rows.push(cells(lines.next().unwrap()));
            }
            rows.retain(|r| !r.iter().all(|c| !c.is_empty() && c.chars().all(|ch| ch == '-' || ch == ':')));
            let width = rows.iter().map(Vec::len).max().unwrap_or(1);
            out.push(format!("[%header,cols=\"{width}*\"]"));
            out.push("|===".into());
            for r in rows {
                out.push(r.iter().map(|c| format!("| {}", inline(c).replace('|', "\\|"))).collect::<Vec<_>>().join(" "));
            }
            out.push("|===".into());
            continue;
        }
        let hashes = t.chars().take_while(|c| *c == '#').count();
        // Headings inside a finding become bold labels, as reports set them.
        if hashes > 0 && t[hashes..].starts_with(' ') {
            out.push(String::new());
            out.push(format!("*{}*", inline(t[hashes..].trim())));
            out.push(String::new());
            continue;
        }
        if t == "---" || t == "***" {
            out.push("'''".into());
            continue;
        }
        let indent = (line.len() - t.len()) / 2;
        if let Some(item) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            out.push(format!("{} {}", "*".repeat(indent + 1), inline(item)));
            continue;
        }
        if let Some(c) = regex::Regex::new(r"^\d+\.\s+(.*)$").unwrap().captures(t) {
            out.push(format!("{} {}", ".".repeat(indent + 1), inline(&c[1])));
            continue;
        }
        if let Some(q) = t.strip_prefix("> ") {
            out.push(format!("_{}_", inline(q)));
            continue;
        }
        // Tag directives would cut the report's own tagged blocks short.
        out.push(inline(line).replace("tag::", "tag:{empty}:").replace("end::", "end:{empty}:"));
    }
    out.join("\n")
}

// ---- the internal audit, in the standard format ----

/// One line's first match of `re`, group 1, trimmed of backticks.
fn field(body: &str, re: &str) -> Option<String> {
    regex::Regex::new(re).unwrap().captures(body).map(|c| c[1].trim().trim_matches('`').trim().to_string()).filter(|s| !s.is_empty())
}

/// The text under `#### <name>` (any heading level) up to the next heading.
fn subsection(body: &str, name: &str) -> Option<String> {
    let lines: Vec<&str> = body.lines().collect();
    let start = lines.iter().position(|l| l.starts_with('#') && l.trim_start_matches('#').trim().eq_ignore_ascii_case(name))?;
    let end = lines.iter().enumerate().skip(start + 1).find(|(_, l)| l.starts_with('#')).map(|(i, _)| i).unwrap_or(lines.len());
    let text = lines[start + 1..end].join("\n").trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// A location as `{ file, line }`, the file resolved in the folder and a function name turned into its line.
fn location_json(root: &Path, file: &str, at: &str) -> Value {
    let path = resolve(root, file).unwrap_or_else(|| file.to_string());
    let line = at.split('-').next().and_then(|n| n.parse::<usize>().ok()).or_else(|| {
        let text = std::fs::read_to_string(root.join(&path)).ok()?;
        function_lines(&text, at, 60).map(|(a, _)| a)
    });
    match line {
        Some(l) => json!({ "file": path, "line": l }),
        None => json!({ "file": path }),
    }
}

/// The test files a text names (`test/…/X.t.sol`).
fn tests_in(text: &str) -> Vec<String> {
    let mut out: Vec<String> = regex::Regex::new(r"([\w./-]+\.t\.sol)").unwrap().captures_iter(text).map(|c| c[1].to_string()).collect();
    out.dedup();
    out
}

/// The fix behind a finding: the commit that added the test covering it, and the pull request its message names.
fn fix_of(root: &Path, repo: Option<&str>, tests: &[String]) -> Option<Value> {
    let t = tests.iter().find(|t| root.join(t).is_file())?;
    let log = git(root, &["log", "--follow", "--diff-filter=A", "--format=%H %s", "--", t])?;
    let line = log.lines().last()?;
    let (commit, subject) = line.split_once(' ').unwrap_or((line, ""));
    let pr = regex::Regex::new(r"\(#(\d+)\)").unwrap().captures(subject).and_then(|c| c[1].parse::<u64>().ok());
    let url = repo.map(|r| match pr {
        Some(n) => format!("{r}/pull/{n}"),
        None => format!("{r}/commit/{commit}"),
    });
    let mut v = json!({ "commit": commit });
    if let Some(n) = pr {
        v["pr"] = json!(n);
    }
    if let Some(u) = url {
        v["url"] = json!(u);
    }
    Some(v)
}

/// The swarm's findings: its rows in an audit index (under `## formal-mind-swarm.md`), each with its section in that
/// report, then the bugs in .formal/bugs/ not already among them.
fn swarm_findings(root: &Path, dirs: &[String], repo: Option<&str>) -> Vec<Value> {
    let mut out: Vec<Value> = vec![];
    for d in dirs {
        let Ok(index) = std::fs::read_to_string(root.join(d).join("README.md")) else { continue };
        let report = std::fs::read_to_string(root.join(d).join(crate::swarm_ctx::REPORT)).unwrap_or_default();
        for f in parse_index(&index).into_iter().filter(|f| f.report == crate::swarm_ctx::REPORT) {
            let body = section(&report, &f.id).unwrap_or_default();
            let sev = field(&body, r"(?i)\*\*Severity:?\*\*:?\s*([\w-]+)").unwrap_or_else(|| f.severity.clone());
            let poc = field(&body, r"(?i)\*\*PoC:?\*\*:?\s*`([^`]+)`");
            let mut tests = tests_in(&f.evidence);
            if let Some(p) = &poc {
                tests.retain(|t| t != p);
            }
            let evidence = [Some(f.evidence.clone()).filter(|e| !e.is_empty()), subsection(&body, "Evidence")].into_iter().flatten().collect::<Vec<_>>().join("\n\n");
            let description = subsection(&body, "Scenario").unwrap_or_else(|| if body.is_empty() { f.title.clone() } else { body.clone() });
            let mut x = json!({
                "id": f.id,
                "title": f.title,
                "severity": severity_of(&sev).to_ascii_lowercase(),
                "status": f.status.to_ascii_lowercase(),
                "description": description,
                "evidence": evidence,
                "tests": tests,
            });
            if let Some((file, at)) = location(&body) {
                x["locations"] = json!([location_json(root, &file, &at)]);
            }
            if let Some(p) = poc {
                x["poc"] = json!(p);
            }
            if f.status == "Fixed" {
                let cover: Vec<String> = x["tests"].as_array().into_iter().flatten().filter_map(|t| t.as_str().map(String::from)).chain(x["poc"].as_str().map(String::from)).collect();
                if let Some(fix) = fix_of(root, repo, &cover) {
                    x["fix"] = fix;
                }
            }
            out.push(x);
        }
    }
    if let Ok(read) = std::fs::read_dir(root.join(".formal/bugs")) {
        let mut bugs: Vec<_> = read.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "md")).collect();
        bugs.sort_by_key(|e| e.file_name());
        for (i, e) in bugs.into_iter().enumerate() {
            let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
            let b = swarm_bug(&e.file_name().to_string_lossy(), &text);
            if out.iter().any(|x| x["title"] == b.title.as_str()) {
                continue;
            }
            let body = b.body.unwrap_or_default();
            let description = body.lines().filter(|l| !l.to_ascii_lowercase().starts_with("**severity") && !l.to_ascii_lowercase().starts_with("**location")).collect::<Vec<_>>().join("\n").trim().to_string();
            let mut x = json!({
                "id": format!("SB-{:02}", i + 1),
                "title": b.title,
                "severity": b.severity.to_ascii_lowercase(),
                "status": "open",
                "description": description,
                "tests": tests_in(&body),
            });
            if let Some((file, at)) = location(&body) {
                x["locations"] = json!([location_json(root, &file, &at)]);
            }
            if let Some(p) = tests_in(&body).first() {
                x["poc"] = json!(p);
            }
            out.push(x);
        }
    }
    out
}

/// A contract's coverage from `formal_json`, counted as the Proofs page counts it (library functions included).
pub fn coverage(f: &Value) -> Value {
    let theorems: Vec<Value> = f["theorems"].as_array().cloned().unwrap_or_default();
    let (mut n, mut in_lean, mut proved, mut not_modeled) = (0, 0, 0, 0);
    let mut rows = vec![];
    for func in f["functions"].as_array().into_iter().flatten() {
        let by: Vec<&Value> = func["theorems"].as_array().into_iter().flatten().filter_map(|i| theorems.get(i.as_u64()? as usize)).collect();
        n += 1;
        let status = if func["why"].is_string() {
            not_modeled += 1;
            "not modeled"
        } else if by.iter().any(|t| t["sorry"] == false) {
            in_lean += 1;
            proved += 1;
            "proved"
        } else if !by.is_empty() {
            in_lean += 1;
            "sorry"
        } else {
            in_lean += 1;
            "modeled"
        };
        let mut row = json!({ "function": func["name"], "status": status, "theorems": by.iter().map(|t| t["name"].clone()).collect::<Vec<_>>() });
        if let Some(w) = func["why"].as_str() {
            row["why"] = json!(w);
        }
        rows.push(row);
    }
    json!({
        "contract": f["contract"],
        "functions": n,
        "inLean": in_lean,
        "proved": proved,
        "notModeled": not_modeled,
        "theorems": theorems.len(),
        "sorry": theorems.iter().filter(|t| t["sorry"] == true).count(),
        "rows": rows,
    })
}

/// The properties the swarm proved and its reviewer approved (.formal/proofs.json), as P-01…, with each function's
/// status and theorems from the coverage.
fn properties(root: &Path, coverage: &[Value], theorems: &std::collections::BTreeMap<String, Value>) -> Vec<Value> {
    let Some(proofs) = std::fs::read_to_string(root.join(".formal/proofs.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return vec![] };
    let Some(map) = proofs.as_object() else { return vec![] };
    let mut items: Vec<(&String, &Value)> = map.iter().collect();
    items.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(u64::MAX));
    let rows: Vec<&Value> = coverage.iter().flat_map(|c| c["rows"].as_array().into_iter().flatten()).collect();
    let loc = regex::Regex::new(r"\(((?:src|contracts)/[^):\s]+):(\d+)\)").unwrap();
    items
        .into_iter()
        .enumerate()
        .map(|(i, (_, p))| {
            let item = p["item"].as_str().unwrap_or("");
            let name = item.split('`').nth(1).unwrap_or(item).to_string();
            let row = rows.iter().find(|r| r["function"].as_str() == Some(name.as_str()));
            let status = match row.and_then(|r| r["status"].as_str()) {
                Some("proved") | None => "verified",
                Some("sorry") => "sorry",
                _ => "unproved",
            };
            let mut x = json!({
                "id": format!("P-{:02}", i + 1),
                "title": name,
                "status": status,
                "description": clean_summary(p["summary"].as_str().unwrap_or(item)),
                "theorems": row.and_then(|r| r["theorems"].as_array()).into_iter().flatten().filter_map(|t| t.as_str()).map(|t| theorems.get(t).cloned().unwrap_or_else(|| json!({ "name": t }))).collect::<Vec<_>>(),
                "files": p["files"].clone(),
            });
            if let Some(c) = loc.captures(item) {
                x["locations"] = json!([{ "file": &c[1], "line": c[2].parse::<u64>().unwrap_or(0) }]);
            }
            x
        })
        .collect()
}

/// A prover's summary as a report states a property: what was proved and under which assumptions, without the
/// conversation around it (what it did, which build passed, the plan, what's next, answers to questions).
fn clean_summary(md: &str) -> String {
    const CHAT: [&str; 18] = ["i proved", "i didn't", "i did not", "i haven't", "i have not", "i'm leaving", "i left", "i reused", "i found", "what's next", "next is", "next,", "on your", "checked by the swarm", "the theorems are written", "every theorem names", "plan item", "item "];
    let kept: Vec<&str> = md
        .split("\n\n")
        .map(str::trim)
        .filter(|p| {
            let l = p.to_ascii_lowercase();
            let l = l.trim_start_matches(|c: char| !c.is_alphanumeric());
            !p.is_empty() && !CHAT.iter().any(|c| l.starts_with(c)) && !l.contains("plan item") && !l.contains("proofs page") && !l.contains("lake build") && !l.contains("plan.md")
        })
        .collect();
    if kept.is_empty() { md.split("\n\n").next().unwrap_or(md).trim().to_string() } else { kept.join("\n\n") }
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git").arg("-C").arg(root).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

/// A repository's name as its owner writes it: `https://github.com/asyncswap/contracts` → `asyncswap/contracts`.
fn repo_name(url: &str) -> Option<String> {
    let path = url.split_once("://").map_or(url, |(_, r)| r).split_once('/')?.1.trim_matches('/');
    (!path.is_empty()).then(|| path.to_string())
}

/// `git@github.com:o/r.git` or `https://github.com/o/r.git` as `https://github.com/o/r`.
fn web_url(remote: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches(".git");
    if let Some(rest) = r.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        return Some(format!("https://{host}/{path}"));
    }
    r.starts_with("https://").then(|| r.to_string())
}

/// Formal Mind's internal audit of the folder in `formalmind.audit/v1`: the swarm's findings, the Proofs coverage, the
/// reviewed proofs and the external audits it doesn't restate. `previous` (the file as it was) keeps what was written
/// by hand: fields this doesn't derive, and findings it doesn't know.
pub fn internal_audit(root: &Path, dirs: &[String], previous: Option<&Value>) -> (Value, Vec<String>) {
    let mut problems = vec![];
    let commit = git(root, &["rev-parse", "HEAD"]);
    let repo = git(root, &["remote", "get-url", "origin"]).and_then(|r| web_url(&r));
    let project = repo.as_deref().and_then(repo_name).unwrap_or_else(|| root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());

    let (contracts, _) = in_scope(root, &mut problems);
    let mut cov = vec![];
    let mut scope = BTreeSet::new();
    // Every theorem by name, with where it is: the properties link each one.
    let mut theorems = std::collections::BTreeMap::new();
    for (file, name) in contracts {
        match analyze_full(root, &file, Some(&name)) {
            Ok((a, output)) => {
                let f = formal_json(&a, &output, 0);
                cov.push(coverage(&f));
                for t in f["theorems"].as_array().into_iter().flatten() {
                    if let Some(n) = t["name"].as_str() {
                        theorems.insert(n.to_string(), json!({ "name": n, "file": t["file"], "line": t["line"], "sorry": t["sorry"] }));
                    }
                }
                scope.insert(file);
                for func in f["functions"].as_array().into_iter().flatten() {
                    if let (false, Some(p)) = (func["dependency"] == true, func["file"].as_str()) {
                        scope.insert(p.to_string());
                    }
                }
            }
            Err(e) => problems.push(format!("{file}: {e:#}")),
        }
    }

    let mut findings = swarm_findings(root, dirs, repo.as_deref());
    // Hand edits survive: fields not derived here, a status set on a swarm bug, findings added by hand.
    if let Some(prev) = previous.and_then(|p| p["findings"].as_array()) {
        for old in prev {
            match findings.iter_mut().find(|f| f["id"] == old["id"]) {
                Some(f) => {
                    for (k, v) in old.as_object().into_iter().flatten() {
                        if f[k].is_null() || (k == "status" && f["id"].as_str().is_some_and(|i| i.starts_with("SB-"))) {
                            f[k] = v.clone();
                        }
                    }
                }
                None => findings.push(old.clone()),
            }
        }
    }
    let props = properties(root, &cov, &theorems);
    let total = |k: &str| cov.iter().map(|c| c[k].as_u64().unwrap_or(0)).sum::<u64>();
    let summary = format!(
        "Formal Mind's swarm verified {project} against a Lean 4 model generated from the Solidity compiler's AST: {} of {} functions in scope are proved, with {} reviewed properties. It filed {} finding{}, each with a proof-of-concept test.",
        total("proved"),
        total("functions"),
        props.len(),
        findings.len(),
        if findings.len() == 1 { "" } else { "s" }
    );
    let mut doc = json!({
        "schema": "formalmind.audit/v1",
        "kind": "internal",
        "title": format!("{project} Security Assessment & Formal Verification"),
        "auditor": "Formal Mind",
        "date": crate::swarm_ctx::chrono_today(),
        "scope": scope.into_iter().collect::<Vec<_>>(),
        "summary": summary,
        "findings": findings,
        "coverage": cov,
        "properties": props,
    });
    if let Some(c) = commit {
        doc["commit"] = json!(c);
    }
    if let Some(r) = repo {
        doc["repository"] = json!(r);
    }
    if let Some(prev) = previous {
        for k in ["authors", "summary", "title"] {
            if prev[k].is_string() || prev[k].is_array() {
                if k != "summary" || prev["summaryByHand"] == true {
                    doc[k] = prev[k].clone();
                }
            }
        }
    }
    (doc, problems)
}

// ---- rendering: Formal Mind's report ----

const THEME: &str = include_str!("../report-template/formal-mind-theme.yml");
/// The brand's lockups: light text for the black cover, dark text for the running header.
const LOGO_LIGHT: &str = include_str!("../report-template/formal-mind-lockup-light.svg");
const LOGO_DARK: &str = include_str!("../report-template/formal-mind-lockup-dark.svg");
/// Inter for the report's text and JetBrains Mono for its code (both OFL 1.1; the licence travels with them).
const FONTS: [(&str, &[u8]); 4] = [
    ("Inter-Regular.ttf", include_bytes!("../report-template/fonts/Inter-Regular.ttf")),
    ("Inter-SemiBold.ttf", include_bytes!("../report-template/fonts/Inter-SemiBold.ttf")),
    ("JetBrainsMono-Regular.ttf", include_bytes!("../report-template/fonts/JetBrainsMono-Regular.ttf")),
    ("LICENSE.txt", include_bytes!("../report-template/fonts/LICENSE.txt")),
];
/// The internal audit's files in the audit folder: the standard file, and the PDF beside it.
pub const JSON: &str = "formal-mind.audit.json";
pub const PDF: &str = "formal-mind.pdf";

// The report's colours: a block's colour says what it is, as in the legends (verification, severity, status).
const GREEN: &str = "#B7E4C7";
const WHITE: &str = "#FFFFFF";
const HEAD: &str = "#F4F4F5";
const BLUE: &str = "#C9DAF8";
const GRAY: &str = "#EEEEEE";
const AMBER: &str = "#FCE5CD";

const SEVERITIES: [(&str, &str, &str); 6] = [
    ("critical", "Critical", "#F4C7C3"),
    ("high", "High", "#F9D9D6"),
    ("medium", "Medium", "#FCE5CD"),
    ("low", "Low", "#D9EAD3"),
    ("informational", "Informational", "#D6E4F7"),
    ("gas", "Gas", "#EEEEEE"),
];

fn status_label(s: &str) -> (&'static str, &'static str) {
    match s {
        "fixed" => ("Fixed", GREEN),
        "acknowledged" => ("Acknowledged", "#FFF2CC"),
        "works as expected" => ("Works as expected", "#D6E4F7"),
        "rejected" => ("Rejected", "#EEEEEE"),
        _ => ("Open", "#F4C7C3"),
    }
}

/// A table cell with its own background (every cell of a coloured table sets or clears it, as the setting carries
/// over to the next cell).
fn cell(color: Option<&str>, text: &str) -> String {
    // The space keeps the text's own formatting (bold, code) from touching the directive.
    format!("|{{set:cellbgcolor:{}}} {text}", color.unwrap_or(WHITE))
}

/// A header cell of a coloured table.
fn head(text: &str) -> String {
    cell(Some(HEAD), &format!("**{text}**"))
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

/// The report (AsciiDoc) for an audit in the standard format, read from nothing but the JSON and, for code excerpts,
/// the folder at `src_dir` (relative to where the AsciiDoc is written).
pub fn render(root: &Path, doc: &Value, src_dir: &str) -> String {
    let repo = doc["repository"].as_str();
    let commit = doc["commit"].as_str();
    let linked = repo.is_some() && commit.is_some();
    let short = commit.map(|c| &c[..c.len().min(7)]).unwrap_or("working tree");
    let project = repo.and_then(repo_name).unwrap_or_else(|| s(doc, "title").split(' ').next().unwrap_or("").to_string());
    // A repository path, linked at the audited commit.
    let at = |file: &str, line: Option<u64>| {
        let label = match line {
            Some(l) => format!("{file}#L{l}"),
            None => file.to_string(),
        };
        if linked { format!("{{url-blob}}{label}[{label}]") } else { format!("`{label}`") }
    };
    let findings: Vec<&Value> = doc["findings"].as_array().into_iter().flatten().collect();
    let coverage: Vec<&Value> = doc["coverage"].as_array().into_iter().flatten().collect();
    let props: Vec<&Value> = doc["properties"].as_array().into_iter().flatten().collect();
    let total = |k: &str| coverage.iter().map(|c| c[k].as_u64().unwrap_or(0)).sum::<u64>();
    let pct = |p: u64, n: u64| if n == 0 { "0%".to_string() } else { format!("{:.1}%", p as f64 * 100.0 / n as f64) };
    let solc = std::fs::read_to_string(root.join("foundry.toml")).ok().and_then(|t| field(&t, r#"(?m)^\s*solc(?:_version)?\s*=\s*"([^"]+)""#));
    let lean = crate::swarm_ctx::lake_dir(root).and_then(|d| std::fs::read_to_string(d.join("lean-toolchain")).ok()).map(|t| t.trim().rsplit(':').next().unwrap_or("").trim_start_matches('v').to_string());

    let mut a = format!(
        "= Security Assessment & Formal Verification: {project}\nFormal Mind\n:doctype: book\n:title-page:\n:toc:\n:toclevels: 3\n:sectnums:\n:sectnumlevels: 3\n:!chapter-signifier:\n:appendix-caption: Appendix\n:revnumber: {short}\n:revdate: {}\n:revremark: Security assessment\n:source-highlighter: pygments\n:pygments-style: default\n:pygments-linenums-mode: inline\n:pdf-themesdir: {{docdir}}\n:pdf-fontsdir: {{docdir}}/fonts;GEM_FONTS_DIR\n:pdf-theme: formal-mind\n:title-logo-image: image:formal-mind-lockup-light.svg[pdfwidth=2.6in]\n:src-dir: {src_dir}\n",
        s(doc, "date")
    );
    if let (Some(r), Some(c)) = (repo, commit) {
        a.push_str(&format!(":url-repo: {r}\n:commit-hash: {c}\n:url-blob: {r}/blob/{c}/\n"));
    }
    a.push('\n');

    // ---- Introduction ----
    a.push_str(&format!(
        "== Introduction\n\n=== About Formal Mind\n\nFormal Mind is a formal audit workspace for Solidity. A local swarm of agents reads the contracts through the Solidity compiler's AST, proves their functions against a Lean 4 model generated from it, and files every bug it finds with a Foundry proof of concept. Its reviewer checks each proof before it counts. Learn more at https://formal.team[formal.team].\n\n=== About This Report\n\nThis report presents Formal Mind's security assessment of {project} at commit {}: the bugs its swarm found, each with a proof of concept; the Lean proofs of the code and how much of the code they cover. Every code reference links to the audited commit, and every fix to the pull request or commit that made it.\n\nThe report is generated from `{}` (the `formalmind.audit/v1` format), which is the source of truth; edit that file and generate the report again to change it.\n\n=== Disclaimer\n\nThis assessment is a snapshot of the code at the commit above and does not guarantee against a hack. Proofs hold for the Lean model formal-ast generates, under the assumptions stated in <<_assumptions_and_simplifications>>. Code the model leaves opaque, the compiler, and contracts outside the scope are not verified. Any change to the code needs a new assessment.\n\n",
        if linked { format!("{{url-repo}}/commit/{{commit-hash}}[{short}]") } else { format!("`{short}`") },
        JSON
    ));

    // ---- Project summary ----
    a.push_str("== Project Summary\n\n=== Project Scope\n\n[%header,cols=\"3,4,2,3\"]\n|===\n| Project | Repository | Commit | Platform\n");
    let platform = format!("EVM / Solidity {}{}", solc.as_deref().unwrap_or(""), lean.as_deref().map(|l| format!(" +\nLean {l}")).unwrap_or_default());
    a.push_str(&format!(
        "| *{project}* | {} | {} | {platform}\n|===\n\n",
        repo.map(|r| format!("{r}[{}]", r.trim_start_matches("https://github.com/"))).unwrap_or_else(|| "—".into()),
        if linked { format!("{{url-repo}}/commit/{{commit-hash}}[{short}]") } else { format!("`{short}`") }
    ));
    a.push_str(&format!("=== Project Overview\n\n{}\n\nThe contracts in scope are the ones the repository's Foundry scripts under `script/` deploy or call, with the code they reach.\n\n", inline(s(doc, "summary"))));
    let scope: Vec<&str> = doc["scope"].as_array().into_iter().flatten().filter_map(|x| x.as_str()).collect();
    if !scope.is_empty() {
        a.push_str("The following files are in scope:\n\n.Files in scope\n[%header%footer,cols=\"6,1,1\"]\n|===\n| File | Lines | Code\n");
        let (mut l, mut c) = (0, 0);
        for f in &scope {
            let (lines, code) = std::fs::read_to_string(root.join(f)).map(|t| count_lines(&t)).unwrap_or_default();
            l += lines;
            c += code;
            a.push_str(&format!("| {} | {lines} | {code}\n", at(f, None)));
        }
        a.push_str(&format!("| Total ({} files) | {l} | {c}\n|===\n\n", scope.len()));
    }

    a.push_str("=== Findings Summary\n\n[%header%footer,cols=\"3,2,2,2,2\"]\n|===\n");
    a.push_str(&[head("Severity"), head("Found"), head("Fixed"), head("Acknowledged"), head("Open")].join(" "));
    a.push('\n');
    for (key, label, color) in SEVERITIES {
        let of: Vec<&&Value> = findings.iter().filter(|f| s(f, "severity") == key).collect();
        if key == "gas" && of.is_empty() {
            continue;
        }
        let n = |st: &str| of.iter().filter(|f| s(f, "status") == st).count();
        a.push_str(&[cell(Some(color), label), cell(None, &of.len().to_string()), cell(None, &n("fixed").to_string()), cell(None, &n("acknowledged").to_string()), cell(None, &n("open").to_string())].join(" "));
        a.push('\n');
    }
    let n = |st: &str| findings.iter().filter(|f| s(f, "status") == st).count();
    a.push_str(&[head("Total"), head(&findings.len().to_string()), head(&n("fixed").to_string()), head(&n("acknowledged").to_string()), head(&n("open").to_string())].join(" "));
    a.push_str("\n|===\n\n");

    a.push_str("=== Severity Matrix\n\nSeverity combines what a bug costs when exploited (impact) with how likely it is to be (likelihood).\n\n[cols=\"2,2,3,3,3\"]\n|===\n");
    let sev = |k: &str| SEVERITIES.iter().find(|x| x.0 == k).map(|x| (x.1, x.2)).unwrap();
    for (row, cols) in [("High", ["medium", "high", "critical"]), ("Medium", ["low", "medium", "high"]), ("Low", ["low", "low", "medium"])] {
        a.push_str(&cell(None, if row == "High" { "*Impact*" } else { "" }));
        a.push(' ');
        a.push_str(&head(row));
        for k in cols {
            let (l, c) = sev(k);
            a.push(' ');
            a.push_str(&cell(Some(c), l));
        }
        a.push('\n');
    }
    a.push_str(&[cell(None, ""), cell(None, ""), head("Low"), head("Medium"), head("High")].join(" "));
    a.push_str("\n|===\n_Likelihood runs left to right._\n\n");

    // ---- Detailed findings ----
    a.push_str("== Detailed Findings\n\n");
    if findings.is_empty() {
        a.push_str(&format!("Formal Mind's swarm has filed no findings at commit {short}. Its work on this code is the formal verification below.\n\n"));
    } else {
        a.push_str("[%header,cols=\"1,5,2,2\"]\n|===\n");
        a.push_str(&[head("ID"), head("Title"), head("Severity"), head("Status")].join(" "));
        a.push('\n');
        for (key, label, color) in SEVERITIES {
            for f in findings.iter().filter(|f| s(f, "severity") == key) {
                let (st, sc) = status_label(s(f, "status"));
                a.push_str(&[cell(None, &format!("<<{},{}>>", anchor(s(f, "id")), s(f, "id"))), cell(None, &inline(s(f, "title"))), cell(Some(color), label), cell(Some(sc), st)].join(" "));
                a.push('\n');
            }
        }
        a.push_str("|===\n\n");
        for (key, label, color) in SEVERITIES {
            let of: Vec<&&Value> = findings.iter().filter(|f| s(f, "severity") == key).collect();
            if of.is_empty() {
                continue;
            }
            a.push_str(&format!("=== {label} Severity Issues\n\n"));
            for f in of {
                a.push_str(&finding(root, f, label, color, &at, linked));
            }
        }
    }

    // ---- Formal verification ----
    a.push_str("== Formal Verification\n\n=== Assumptions and Simplifications\n\n");
    a.push_str(&format!(
        ". formal-ast compiles the contracts{} and translates solc's AST into a Lean {}model; the theorems are about that model.\n. Functions formal-ast can't translate stay opaque (not modeled): a theorem then holds for every behaviour of them, and says nothing about their own code.\n. External calls are parameters of the model, so a theorem holds whatever the called contract does unless it states otherwise.\n. A function counts as proved when a theorem without `sorry` names its Lean definition. The swarm's own proofs also pass `lake build` with no `sorry`, `admit`, `axiom` or `native_decide`, and are approved by its reviewer.\n\n",
        solc.as_deref().map(|v| format!(" with solc {v}")).unwrap_or_default(),
        lean.as_deref().map(|v| format!("{v} ")).unwrap_or_default()
    ));
    a.push_str("=== Verification Notations\n\n[cols=\"1,3\"]\n|===\n");
    for (l, c, d) in [
        ("Proved", GREEN, "Verified: a theorem without `sorry` names the function's Lean definition, so the property holds for every state and input of the model, under the assumptions above."),
        ("Has sorry", BLUE, "Theorems name it, but each still has a `sorry`: the proof isn't finished."),
        ("In Lean", GRAY, "Modeled in Lean, but no theorem about it yet."),
        ("Not modeled", AMBER, "Left opaque by formal-ast: theorems hold for every behaviour of it (the reason is in the appendix)."),
    ] {
        a.push_str(&format!("{} {}\n", cell(Some(c), l), cell(None, d)));
    }
    a.push_str("|===\n\n=== Coverage\n\n");
    if coverage.is_empty() {
        a.push_str("No contract in scope could be read, so there is no coverage to report.\n\n");
    } else {
        a.push_str(&format!(
            "*{}* of *{}* functions are proved ({}); {} are in the Lean model and {} are not modeled. The repository has {} theorems{}.\n\n",
            total("proved"),
            total("functions"),
            pct(total("proved"), total("functions")),
            total("inLean"),
            total("notModeled"),
            coverage.iter().map(|c| c["theorems"].as_u64().unwrap_or(0)).max().unwrap_or(0),
            match coverage.iter().map(|c| c["sorry"].as_u64().unwrap_or(0)).max().unwrap_or(0) {
                0 => String::new(),
                n => format!(", {n} still with `sorry`"),
            }
        ));
        a.push_str("[%header%footer,cols=\"3,1,1,1,1,1\"]\n|===\n| Contract | Functions | In Lean | Proved | Not modeled | Proved\n");
        for c in &coverage {
            a.push_str(&format!("| {} | {} | {} | {} | {} | {}\n", s(c, "contract"), c["functions"], c["inLean"], c["proved"], c["notModeled"], pct(c["proved"].as_u64().unwrap_or(0), c["functions"].as_u64().unwrap_or(0))));
        }
        a.push_str(&format!("| Total | {} | {} | {} | {} | {}\n|===\n\nEvery function's status is in <<function-coverage>>.\n\n", total("functions"), total("inLean"), total("proved"), total("notModeled"), pct(total("proved"), total("functions"))));
    }
    if !props.is_empty() {
        a.push_str("=== Formal Verification Properties\n\nEach property is a function the swarm's prover proved against the model and its reviewer approved: what the proof establishes, in the prover's words, and the theorems that prove it, each linked where it is.\n\n");
        // Grouped by contract, as the model is.
        let mut groups: Vec<String> = vec![];
        for p in &props {
            let c = s(p, "title").split('.').next().unwrap_or("").to_string();
            if !groups.contains(&c) {
                groups.push(c);
            }
        }
        for g in groups {
            a.push_str(&format!("==== {g}\n\n"));
            for p in props.iter().filter(|p| s(p, "title").split('.').next() == Some(g.as_str())) {
                let (st, sc) = match s(p, "status") {
                    "verified" => ("Verified", GREEN),
                    "sorry" => ("Has sorry", BLUE),
                    _ => ("Not proved", GRAY),
                };
                let loc = p["locations"].as_array().and_then(|l| l.first()).map(|l| at(s(l, "file"), l["line"].as_u64())).unwrap_or_else(|| "—".into());
                let files: Vec<String> = p["files"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).map(|f| at(f, None)).collect();
                a.push_str(&format!("[[{}]]\n[cols=\"1,1,1\"]\n|===\n3+{}\n", anchor(s(p, "id")), cell(Some(HEAD), &format!("*{}. {}*", s(p, "id"), code_span(s(p, "title"))))));
                a.push_str(&[cell(Some(sc), &format!("Status: *{st}*")), cell(Some(sc), &format!("Function: {loc}")), cell(Some(sc), &format!("Proof: {}", if files.is_empty() { "—".into() } else { files.join(", ") }))].join(" "));
                a.push_str("\n|===\n\n");
                a.push_str(&md_to_adoc(s(p, "description")));
                a.push_str("\n\n");
                let thms: Vec<&Value> = p["theorems"].as_array().into_iter().flatten().collect();
                if !thms.is_empty() {
                    a.push_str("[%header,cols=\"4,1,4\"]\n|===\n");
                    a.push_str(&[head("Theorem"), head("Status"), head("Where")].join(" "));
                    a.push('\n');
                    for t in thms {
                        let (ts, tc) = if t["sorry"] == true { ("Has sorry", BLUE) } else { ("Verified", GREEN) };
                        let place = t["file"].as_str().map(|f| at(f, t["line"].as_u64())).unwrap_or_else(|| "—".into());
                        a.push_str(&[cell(None, &code_span(s(t, "name"))), cell(Some(tc), ts), cell(None, &place)].join(" "));
                        a.push('\n');
                    }
                    a.push_str("|===\n\n");
                }
            }
        }
    }

    if !coverage.is_empty() {
        a.push_str("[appendix]\n[[function-coverage]]\n== Function Coverage\n\n");
        for c in &coverage {
            a.push_str(&format!(".{}\n[%header,cols=\"5,2,1\"]\n|===\n{} {} {}\n", s(c, "contract"), head("Function"), head("Status"), head("Theorems")));
            for r in c["rows"].as_array().into_iter().flatten() {
                let (l, col) = match s(r, "status") {
                    "proved" => ("Proved", GREEN),
                    "sorry" => ("Has sorry", BLUE),
                    "not modeled" => ("Not modeled", AMBER),
                    _ => ("In Lean", GRAY),
                };
                a.push_str(&format!("{} {} {}\n", cell(None, &code_span(s(r, "function"))), cell(Some(col), l), cell(None, &r["theorems"].as_array().map(|t| t.len()).unwrap_or(0).to_string())));
            }
            a.push_str("|===\n\n");
        }
    }
    a
}

/// Lines and code lines (not blank, not comments) of a Solidity file.
fn count_lines(text: &str) -> (usize, usize) {
    let (mut lines, mut code, mut block) = (0, 0, false);
    for l in text.lines() {
        lines += 1;
        let t = l.trim();
        if block {
            block = !t.contains("*/");
        } else if t.starts_with("/*") {
            block = !t.contains("*/");
        } else if !t.is_empty() && !t.starts_with("//") {
            code += 1;
        }
    }
    (lines, code)
}

fn anchor(id: &str) -> String {
    format!("finding-{}", id.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect::<String>())
}

/// One finding: the header strip (severity, status, files), Context, Description with the code, Impact,
/// Recommendation, Proof of concept, and Fix review with the fix's pull request or commit.
fn finding(root: &Path, f: &Value, label: &str, color: &str, at: &dyn Fn(&str, Option<u64>) -> String, linked: bool) -> String {
    let id = s(f, "id");
    let (st, sc) = status_label(s(f, "status"));
    let locs: Vec<&Value> = f["locations"].as_array().into_iter().flatten().collect();
    let context: Vec<String> = locs.iter().map(|l| at(s(l, "file"), l["line"].as_u64())).collect();
    let mut a = format!("[[{}]]\n==== {id} {}\n\n[cols=\"1,1,1\"]\n|===\n", anchor(id), inline(s(f, "title")));
    a.push_str(&[cell(Some(color), &format!("Severity: *{label}*")), cell(Some(sc), &format!("Status: *{st}*")), cell(None, &format!("PoC: {}", f["poc"].as_str().map(|p| at(p, None)).unwrap_or_else(|| "—".into())))].join(" "));
    a.push_str("\n|===\n\n");
    if !context.is_empty() {
        a.push_str(&format!("*Context:* {}\n\n", context.join(", ")));
    }
    a.push_str(&format!("*Description:* {}\n\n", md_to_adoc(s(f, "description")).trim_start()));
    if let Some(l) = locs.first() {
        let file = s(l, "file");
        if let Ok(text) = std::fs::read_to_string(root.join(file)) {
            let n = text.lines().count() as u64;
            let line = l["line"].as_u64().unwrap_or(1);
            // The function around the line, else the lines around it.
            let before: Vec<&str> = text.lines().take(line as usize).collect();
            let fn_name = before.iter().rev().find_map(|x| regex::Regex::new(r"function\s+(\w+)").unwrap().captures(x).map(|c| c[1].to_string()));
            let (s0, e0) = fn_name.and_then(|f| function_lines(&text, &f, 40)).filter(|(s0, e0)| (*s0 as u64) <= line && line <= *e0 as u64).map(|(a, b)| (a as u64, b as u64)).unwrap_or((line.saturating_sub(3).max(1), (line + 6).min(n)));
            a.push_str(&code_block(file, s0 as usize, e0 as usize, linked, None));
        }
    }
    for (k, l) in [("impact", "Impact"), ("recommendation", "Recommendation"), ("response", "Response")] {
        if !s(f, k).is_empty() {
            a.push_str(&format!("*{l}:* {}\n\n", md_to_adoc(s(f, k)).trim_start()));
        }
    }
    if let Some(p) = f["poc"].as_str() {
        a.push_str(&format!("*Proof of concept:* {} reproduces it.\n\n", at(p, None)));
        if let Ok(text) = std::fs::read_to_string(root.join(p)) {
            if let Some((s0, e0)) = regex::Regex::new(r"function\s+(test\w*)").unwrap().captures(&text).and_then(|c| function_lines(&text, &c[1], 50)) {
                a.push_str(&code_block(p, s0, e0, linked, None));
            }
        }
    }
    // Fix review: where it stands, the fix's pull request or commit, and the tests that cover it.
    let mut review = String::new();
    if let Some(fix) = f["fix"].as_object() {
        let commit = fix.get("commit").and_then(|c| c.as_str()).unwrap_or("");
        let shortc = &commit[..commit.len().min(7)];
        let url = fix.get("url").and_then(|u| u.as_str());
        review.push_str(&match (fix.get("pr").and_then(|p| p.as_u64()), url) {
            (Some(n), Some(u)) => format!("Fixed in {u}[PR #{n}] (commit `{shortc}`). "),
            (None, Some(u)) => format!("Fixed in commit {u}[{shortc}]. "),
            _ if !commit.is_empty() => format!("Fixed in commit `{shortc}`. "),
            _ => String::new(),
        });
    } else {
        review.push_str(&format!("{st}. "));
    }
    if !s(f, "evidence").is_empty() {
        review.push_str(md_to_adoc(s(f, "evidence")).trim());
    }
    a.push_str(&format!("*Fix review:* {}\n\n", review.trim()));
    let tests: Vec<String> = f["tests"].as_array().into_iter().flatten().filter_map(|t| t.as_str().map(String::from)).filter(|t| Some(t.as_str()) != f["poc"].as_str()).collect();
    let fns: Vec<String> = regex::Regex::new(r"\b(test[A-Z_]\w*)").unwrap().captures_iter(s(f, "evidence")).map(|c| c[1].to_string()).collect();
    for t in tests {
        let Ok(text) = std::fs::read_to_string(root.join(&t)) else { continue };
        let named: Vec<(usize, usize)> = fns.iter().filter_map(|n| function_lines(&text, n, 50)).collect();
        let shown = if named.is_empty() { regex::Regex::new(r"function\s+(test\w*)").unwrap().captures(&text).and_then(|c| function_lines(&text, &c[1], 50)).into_iter().collect() } else { named };
        for (s0, e0) in shown {
            a.push_str(&code_block(&t, s0, e0, linked, Some("Regression test")));
        }
    }
    a
}

fn code_block(path: &str, a: usize, b: usize, linked: bool, what: Option<&str>) -> String {
    let lang = if path.ends_with(".sol") { "solidity" } else { "text" };
    let label = format!("{path}#L{a}-L{b}");
    let title = if linked { format!("{{url-blob}}{label}[{label}]") } else { label };
    format!(".{}{title}\n[source,{lang},linenums,start={a}]\n----\ninclude::{{src-dir}}{path}[lines={a}..{b}]\n----\n\n", what.map(|w| format!("{w} ")).unwrap_or_default())
}

// ---- asciidoctor-pdf (an optional export) ----

/// asciidoctor-pdf: where Homebrew puts it, on PATH as a login shell sees it, or in RubyGems' user bin.
fn asciidoctor_pdf() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut found = ["/opt/homebrew/bin/asciidoctor-pdf", "/usr/local/bin/asciidoctor-pdf"].into_iter().map(PathBuf::from).find(|p| p.exists());
    if found.is_none() {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        found = std::process::Command::new(shell)
            .args(["-lc", "command -v asciidoctor-pdf"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
            .filter(|p| p.is_file());
    }
    found.or_else(|| {
        let gems = PathBuf::from(&home).join(".gem/ruby");
        std::fs::read_dir(gems).ok()?.flatten().map(|e| e.path().join("bin/asciidoctor-pdf")).find(|p| p.exists())
    })
}

pub const INSTALL: &str = "The audit is saved; the PDF needs asciidoctor-pdf, which isn't installed. Install it with Homebrew (it brings Ruby and asciidoctor-pdf; Solidity highlighting uses python3):\n\n    brew install asciidoctor\n\nthen generate the report again.";

#[derive(Serialize)]
pub struct Generated {
    /// The internal audit in the standard format, folder-relative (e.g. audit/formal-mind.audit.json).
    pub json: String,
    /// The AsciiDoc it was rendered to, folder-relative.
    pub adoc: String,
    /// The PDF, folder-relative, when asciidoctor-pdf made one.
    pub pdf: Option<String>,
    /// Why there's no PDF (how to install the toolchain, or what asciidoctor-pdf said).
    pub note: Option<String>,
    pub findings: usize,
    pub warnings: Vec<String>,
}

/// Writes Formal Mind's internal audit (`<audit folder>/formal-mind.audit.json`), renders it to AsciiDoc in
/// .formal/report/, and with asciidoctor-pdf to `<audit folder>/formal-mind.pdf`.
pub fn generate(root: &Path, dirs: &[String]) -> Result<Generated, String> {
    let dirs: Vec<String> = if dirs.is_empty() { vec!["audit".into(), "audits".into(), "reports".into()] } else { dirs.to_vec() };
    let audit = dirs.iter().map(|d| root.join(d)).find(|d| d.is_dir()).unwrap_or_else(|| crate::swarm_ctx::report_dir(root));
    std::fs::create_dir_all(&audit).map_err(|e| e.to_string())?;
    let json_path = audit.join(JSON);
    let previous = std::fs::read_to_string(&json_path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v["schema"] == "formalmind.audit/v1");
    let (doc, problems) = internal_audit(root, &dirs, previous.as_ref());
    std::fs::write(&json_path, serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())? + "\n").map_err(|e| e.to_string())?;

    let out_dir = root.join(".formal").join("report");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let adoc = out_dir.join("formal-mind.adoc");
    std::fs::write(&adoc, render(root, &doc, "../../")).map_err(|e| e.to_string())?;
    std::fs::write(out_dir.join("formal-mind-theme.yml"), THEME).map_err(|e| e.to_string())?;
    std::fs::write(out_dir.join("formal-mind-lockup-light.svg"), LOGO_LIGHT).map_err(|e| e.to_string())?;
    std::fs::write(out_dir.join("formal-mind-lockup-dark.svg"), LOGO_DARK).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(out_dir.join("fonts")).map_err(|e| e.to_string())?;
    for (name, bytes) in FONTS {
        std::fs::write(out_dir.join("fonts").join(name), bytes).map_err(|e| e.to_string())?;
    }

    let rel = |p: &Path| p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/");
    let mut out = Generated { json: rel(&json_path), adoc: rel(&adoc), pdf: None, note: None, findings: doc["findings"].as_array().map_or(0, Vec::len), warnings: problems };
    let Some(bin) = asciidoctor_pdf() else {
        out.note = Some(INSTALL.into());
        return Ok(out);
    };
    let pdf = audit.join(PDF);
    let mut cmd = std::process::Command::new(&bin);
    // Pygments (bundled with asciidoctor-pdf's pygments.rb) highlights Solidity but needs python3; Rouge doesn't need
    // it but has no Solidity lexer.
    if !std::process::Command::new("python3").arg("--version").output().is_ok_and(|o| o.status.success()) {
        cmd.args(["-a", "source-highlighter=rouge"]);
    }
    let run = cmd
        .current_dir(&out_dir)
        // Homebrew's Ruby, for a GUI app whose PATH lacks it.
        .env("PATH", format!("{}:/opt/homebrew/bin:/usr/local/bin:{}", bin.parent().map(|p| p.display().to_string()).unwrap_or_default(), std::env::var("PATH").unwrap_or_default()))
        .args(["--failure-level", "ERROR", "-o"])
        .arg(&pdf)
        .arg("formal-mind.adoc")
        .output()
        .map_err(|e| format!("{}: {e}", bin.display()))?;
    let log = String::from_utf8_lossy(&run.stderr).to_string();
    out.warnings.extend(log.lines().filter(|l| !l.trim().is_empty()).map(String::from));
    if pdf.exists() && run.status.success() {
        out.pdf = Some(rel(&pdf));
    } else {
        out.note = Some(format!("The audit is saved, but asciidoctor-pdf failed:\n{}", log.trim()));
    }
    Ok(out)
}

#[tauri::command]
pub async fn report_generate(folder: String, dirs: Vec<String>) -> Result<Generated, String> {
    if !crate::local::is_added(&folder)? {
        return Err("Add the folder first".into());
    }
    tauri::async_runtime::spawn_blocking(move || generate(Path::new(&folder), &dirs)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const INDEX: &str = "# Audits\n\n| Report | Date | Author | Scope |\n|---|---|---|---|\n| [a.md](a.md) | 2026-01-01 | Lee | All |\n\n## a.md\n\n| ID | Severity | Finding | Status | Evidence |\n|----|---|---|---|---|\n| H-01 | High | Fee \\| rounding | ✅ Fixed | `test/A.t.sol` |\n| I-02 | Info | Small | 📝 Acknowledged | why |\n\n## formal-mind-swarm.md\n\n| ID | Severity | Finding | Status | Evidence |\n|---|---|---|---|---|\n| FM-01 | High | Fill drains | ⏳ Open | PoC `test/formal/Fill.t.sol`; `src/R.sol:2` |\n";

    #[test]
    fn index_rows_are_findings() {
        let f = parse_index(INDEX);
        assert_eq!(f.len(), 3);
        assert_eq!((f[0].id.as_str(), f[0].severity.as_str(), f[0].title.as_str(), f[0].status.as_str(), f[0].report.as_str()), ("H-01", "High", "Fee | rounding", "Fixed", "a.md"));
        assert_eq!((f[1].severity.as_str(), f[1].status.as_str()), ("Informational", "Acknowledged"));
        assert_eq!(f[2].report, "formal-mind-swarm.md");
    }

    #[test]
    fn sections_and_locations() {
        let md = "# R\n\n## Findings\n\n### [H-01] Fee\n\nText at [R.sol:10-12](R.sol#L10).\n\n```solidity\n### not a heading\n```\n\n**Location**: `src/R.sol:fill`\n\n### [L-01] Next\n\nx\n";
        let s = section(md, "H-01").unwrap();
        assert!(s.contains("### not a heading") && !s.contains("Next"));
        assert_eq!(location(&s), Some(("src/R.sol".into(), "fill".into())));
        assert_eq!(location("see [R.sol:10-12](R.sol#L10)"), Some(("R.sol".into(), "10-12".into())));
        assert_eq!(section(md, "—"), None);
    }

    #[test]
    fn markdown_becomes_asciidoc() {
        let a = md_to_adoc("#### Impact\n\n**Bold** `a*b{c}` [x](https://e.com) [y](y.md)\n\n- one\n  - two\n1. first\n\n| A | B |\n|---|---|\n| `p\\|q` | 2 |\n\n```solidity\nuint x;\n```");
        assert!(a.contains("*Impact*"));
        assert!(a.contains("**Bold** `++a*b{c}++` https://e.com[x] y"));
        assert!(a.contains("* one\n** two\n. first"));
        assert!(a.contains("|===\n| A | B\n| `++p\\|q++` | 2\n|==="));
        assert!(a.contains("[source,solidity]\n----\nuint x;\n----"));
    }

    #[test]
    fn repository_names_keep_the_owner() {
        assert_eq!(repo_name("https://github.com/asyncswap/contracts").as_deref(), Some("asyncswap/contracts"));
        assert_eq!(repo_name(&web_url("git@github.com:asyncswap/contracts.git").unwrap()).as_deref(), Some("asyncswap/contracts"));
    }

    #[test]
    fn functions_by_braces() {
        let src = "contract C {\n    function a() external {\n        if (x) {\n            y();\n        }\n    }\n    receive() external payable {}\n}\n";
        assert_eq!(function_lines(src, "a", 60), Some((2, 6)));
        assert_eq!(function_lines(src, "receive", 60), Some((7, 7)));
    }

    #[test]
    fn the_internal_audit_is_ours_alone() {
        let root = std::env::temp_dir().join(format!("fm-report-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("audit")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/R.sol"), "contract R {\n    function fill() external {\n        x = 1;\n    }\n}\n").unwrap();
        std::fs::write(root.join("audit/README.md"), INDEX).unwrap();
        std::fs::write(root.join("audit/a.md"), "### [H-01] Fee\n\nBad.\n").unwrap();
        std::fs::write(root.join("audit/formal-mind-swarm.md"), "# x\n\n### [FM-01] Fill drains\n\n**Severity:** high\n**Location:** `src/R.sol:2`\n**PoC:** `test/formal/Fill.t.sol`\n\n#### Scenario\n\nAnyone fills.\n").unwrap();
        let prev = json!({ "findings": [{ "id": "FM-01", "recommendation": "Guard it." }, { "id": "X-1", "title": "By hand", "severity": "low", "status": "open", "description": "d" }] });
        let (doc, _) = internal_audit(&root, &["audit".into()], Some(&prev));
        assert_eq!(doc["kind"], "internal");
        let f = doc["findings"].as_array().unwrap();
        // Only Formal Mind's findings (and the one added by hand); the external report stays out.
        assert_eq!(f.iter().map(|x| x["id"].as_str().unwrap()).collect::<Vec<_>>(), ["FM-01", "X-1"]);
        assert_eq!(f[0]["description"], "Anyone fills.");
        assert_eq!(f[0]["locations"][0], json!({ "file": "src/R.sol", "line": 2 }));
        assert_eq!(f[0]["poc"], "test/formal/Fill.t.sol");
        assert_eq!(f[0]["recommendation"], "Guard it.");
        assert!(doc["references"].is_null());
        let adoc = render(&root, &doc, "../../");
        assert!(adoc.contains("==== FM-01 Fill drains"));
        assert!(adoc.contains("include::{src-dir}src/R.sol[lines=2..4]"));
        assert!(adoc.contains("*Recommendation:* Guard it."));
        assert!(!adoc.contains("H-01"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A finding's page, rendered against a real folder's code: `FM_FOLDER=… FM_OUT=… cargo test -- --ignored demo_finding`.
    #[test]
    #[ignore]
    fn demo_finding() {
        let root = PathBuf::from(std::env::var("FM_FOLDER").unwrap());
        let out = PathBuf::from(std::env::var("FM_OUT").unwrap());
        let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(root.join("audit").join(JSON)).unwrap()).unwrap();
        doc["findings"] = json!([{
            "id": "FM-01", "title": "Demo: a self-owned native-output order drains the hook", "severity": "high", "status": "fixed",
            "locations": [{ "file": "src/libraries/AsyncFiller.sol", "line": 325 }],
            "description": "Sample finding (demo data) to show the layout. `fill` settles native output from `address(hook).balance`.",
            "impact": "Anyone can take the hook's native balance.", "recommendation": "Keep a per-order native ledger.",
            "poc": "test/security/NativeOutputEscrow.t.sol", "tests": [],
            "evidence": "Per-tx native deposit ledger; `test_RevertWhen_FillerDoesNotDepositNativeOutput` covers it.",
            "fix": { "commit": "6cf3ac56644f6242accfa81f08f14a123e847b28", "pr": 20, "url": "https://github.com/asyncswap/contracts/pull/20" }
        }]);
        doc["properties"] = json!(doc["properties"].as_array().unwrap()[..2]);
        std::fs::create_dir_all(&out).unwrap();
        let depth = out.strip_prefix(&root).map(|p| p.components().count()).ok();
        let src = depth.map(|d| "../".repeat(d)).unwrap_or_else(|| format!("{}/", root.display()));
        std::fs::write(out.join("demo.adoc"), render(&root, &doc, &src)).unwrap();
        std::fs::write(out.join("formal-mind-theme.yml"), THEME).unwrap();
        std::fs::write(out.join("formal-mind-lockup-light.svg"), LOGO_LIGHT).unwrap();
        std::fs::write(out.join("formal-mind-lockup-dark.svg"), LOGO_DARK).unwrap();
        std::fs::create_dir_all(out.join("fonts")).unwrap();
        for (name, bytes) in FONTS {
            std::fs::write(out.join("fonts").join(name), bytes).unwrap();
        }
    }

    /// The report for a real folder: `FM_FOLDER=… cargo test -- --ignored report_of_a_folder --nocapture`.
    #[test]
    #[ignore]
    fn report_of_a_folder() {
        let root = PathBuf::from(std::env::var("FM_FOLDER").unwrap());
        let g = generate(&root, &[]).unwrap();
        println!("json {} · adoc {} · pdf {:?} · {} findings\nnote {:?}", g.json, g.adoc, g.pdf, g.findings, g.note);
        for w in g.warnings {
            println!("  {w}");
        }
    }
}
