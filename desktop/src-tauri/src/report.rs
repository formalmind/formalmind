//! Audit report: the folder's findings, Proofs coverage and in-scope code written as an AsciiDoc report in the layout of
//! mmsaki/audit-report-generator (report/README.adoc including intro, methodology, lines-of-code, findings-critical,
//! -high, -med, -low, manual-review, revisions, glossary and references, each finding a `tag::N[]` block with its code
//! `include::`d from the folder, and that generator's PDF theme), then rendered to PDF with asciidoctor-pdf when it is
//! installed. Nothing is read out of PDFs: the findings come from the audit index (README.md in the audit folders, one
//! table per report), each report's own Markdown section for the finding, and the swarm's bugs in .formal/bugs/.

use crate::swarm_ctx::in_scope;
use formal_ast::{analyze_full, formal_json};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const THEME: &str = include_str!("../report-template/pdf-theme.yml");
/// What the PDF is called, in the audit folder.
pub const PDF: &str = "formal-mind-report.pdf";

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

/// The excerpt for a location: around a line, a line range, or a whole function.
fn excerpt(root: &Path, file: &str, at: &str) -> Option<(String, usize, usize)> {
    let path = resolve(root, file)?;
    let text = std::fs::read_to_string(root.join(&path)).ok()?;
    let n = text.lines().count();
    let mut nums = at.split('-').filter_map(|x| x.parse::<usize>().ok());
    let (a, b) = match (nums.next(), nums.next()) {
        (Some(a), Some(b)) => (a.saturating_sub(2).max(1), (b + 2).min(a + 40)),
        (Some(a), None) => (a.saturating_sub(3).max(1), a + 6),
        _ => function_lines(&text, at, 60)?,
    };
    (a <= n).then(|| (path, a, b.min(n)))
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
        if hashes > 0 && t[hashes..].starts_with(' ') {
            out.push(String::new());
            out.push(format!("=== {}", inline(t[hashes..].trim())));
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

// ---- the report ----

#[derive(Default, Serialize)]
pub struct Coverage {
    pub contract: String,
    pub functions: usize,
    pub in_lean: usize,
    pub proved: usize,
    pub not_modeled: usize,
    pub theorems: usize,
    pub sorry: usize,
    /// (function, status, theorems naming it)
    pub rows: Vec<(String, String, usize)>,
}

#[derive(Default)]
pub struct Input {
    pub project: String,
    pub commit: Option<String>,
    pub date: String,
    pub repo_url: Option<String>,
    pub findings: Vec<Finding>,
    pub coverage: Vec<Coverage>,
    /// In-scope Solidity files, folder-relative.
    pub files: Vec<String>,
    /// The reports the findings come from, folder-relative.
    pub reports: Vec<String>,
    pub problems: Vec<String>,
}

/// Lines, blanks, comments and code of a Solidity file.
fn count_lines(text: &str) -> (usize, usize, usize, usize) {
    let (mut blank, mut comment, mut code) = (0, 0, 0);
    let mut block = false;
    for l in text.lines() {
        let t = l.trim();
        if block {
            comment += 1;
            if t.contains("*/") {
                block = false;
            }
        } else if t.is_empty() {
            blank += 1;
        } else if t.starts_with("//") {
            comment += 1;
        } else if t.starts_with("/*") {
            comment += 1;
            block = !t.contains("*/");
        } else {
            code += 1;
        }
    }
    (blank + comment + code, blank, comment, code)
}

/// The report's files, by name (README.adoc first).
pub fn render(root: &Path, report_dir: &Path, input: &Input) -> Vec<(String, String)> {
    let depth = report_dir.strip_prefix(root).map(|p| p.components().count()).unwrap_or(0);
    let src_dir = "../".repeat(depth);
    let short = input.commit.as_deref().map(|c| &c[..c.len().min(7)]).unwrap_or("working tree");
    let mut files: Vec<(String, String)> = vec![];

    let by_sev = |s: &str| input.findings.iter().filter(|f| f.severity == s).collect::<Vec<_>>();
    let sections = [("Critical", "findings-critical.adoc"), ("High", "findings-high.adoc"), ("Medium", "findings-med.adoc"), ("Low", "findings-low.adoc"), ("Informational", "manual-review.adoc")];

    // README.adoc: the generator's header and layout.
    let mut readme = format!(
        "= {project} Security Report\nFormal Mind\n:revnumber: {short}\n:revdate: {date}\n:revremark: Generated by Formal Mind\n:sectnums:\n:partnums:\n:toc: auto\n:doctype: book\n:!chapter-signifier:\n:appendix-caption: Exhibit\n:src-dir: {src_dir}\n",
        project = input.project,
        date = input.date
    );
    if let Some(url) = &input.repo_url {
        readme.push_str(&format!(":url-repo: {url}\n"));
        if let Some(c) = &input.commit {
            readme.push_str(&format!(":commit-hash: {c}\n:url-commit: {url}/commit/\n:url-blob: {url}/blob/{c}/\n"));
        }
    }
    readme.push_str(":source-highlighter: pygments\n:pygments-style: default\n:pygments-linenums-mode: inline\n:pdf-themesdir: {docdir}/themes\n:pdf-theme: report\n\n");
    readme.push_str("[preface]\n= Introduction\n\ninclude::revisions.adoc[leveloffset=1, tags=version]\n\ninclude::intro.adoc[leveloffset=1, tags=intro]\n\ninclude::intro.adoc[leveloffset=1, tags=summary]\n\n");
    readme.push_str("= Scope and Methodology\n\ninclude::methodology.adoc[tags=methodology]\n\ninclude::lines-of-code.adoc[tags=loc]\n\n");
    for (sev, file) in sections {
        let list = by_sev(sev);
        readme.push_str(&format!("= {sev}\n\n"));
        if list.is_empty() {
            readme.push_str(&format!("No {} findings.\n\n", sev.to_lowercase()));
        }
        for n in 1..=list.len() {
            readme.push_str(&format!("include::{file}[tags={n}]\n"));
        }
        readme.push('\n');
    }
    if !input.problems.is_empty() {
        readme.push_str("[appendix]\n== What couldn't be read\n\n");
        for p in &input.problems {
            readme.push_str(&format!("* {}\n", inline(p)));
        }
        readme.push('\n');
    }
    if !input.coverage.is_empty() {
        readme.push_str("[appendix]\n== Proofs coverage by function\n\ninclude::methodology.adoc[tags=functions]\n\n");
    }
    readme.push_str("[glossary]\n= Terminology\ninclude::glossary.adoc[tags=terminology]\n\n[bibliography]\n= References\ninclude::references.adoc[tags=refs]\n");
    files.push(("README.adoc".into(), readme));

    // revisions.adoc
    let commit_cell = match (&input.commit, &input.repo_url) {
        (Some(_), Some(_)) => format!("{{url-commit}}{{commit-hash}}[{short}]"),
        _ => format!("`{short}`"),
    };
    files.push((
        "revisions.adoc".into(),
        format!("// tag::version[]\n== Document Revisions\n\n|===\n| Version | Description | Commit | Date\n| {short} | Generated by Formal Mind | {commit_cell} | {}\n|===\n// end::version[]\n", input.date),
    ));

    // intro.adoc: what was reviewed, and the findings by severity and status.
    let statuses = ["Fixed", "Works as expected", "Acknowledged", "Rejected", "Open"];
    let mut intro = format!("// tag::intro[]\n== Summary\n\nThis report covers {} at commit {commit_cell}. It collects {} finding{} from {} report{} in the repository's audit index and Formal Mind's swarm, with the status of each in the current code, and the formal verification of the in-scope contracts against a Lean model generated from the Solidity compiler's AST.\n\nGenerated by Formal Mind on {}.\n// end::intro[]\n\n", input.repo_url.as_ref().map(|u| format!("{u}[{}]", input.project)).unwrap_or_else(|| input.project.clone()), input.findings.len(), if input.findings.len() == 1 { "" } else { "s" }, input.reports.len().max(1), if input.reports.len() == 1 { "" } else { "s" }, input.date);
    intro.push_str("// tag::summary[]\n== Findings\n\n[%header%footer,cols=\"7*\"]\n|===\n| Severity");
    for s in statuses {
        intro.push_str(&format!(" | {s}"));
    }
    intro.push_str(" | Total\n");
    for (sev, _) in sections {
        let list = by_sev(sev);
        intro.push_str(&format!("| {sev}"));
        for s in statuses {
            intro.push_str(&format!(" | {}", list.iter().filter(|f| f.status == s).count()));
        }
        intro.push_str(&format!(" | {}\n", list.len()));
    }
    intro.push_str("| Total");
    for s in statuses {
        intro.push_str(&format!(" | {}", input.findings.iter().filter(|f| f.status == s).count()));
    }
    intro.push_str(&format!(" | {}\n|===\n// end::summary[]\n", input.findings.len()));
    files.push(("intro.adoc".into(), intro));

    // methodology.adoc: the formal verification and its coverage.
    let total = |f: fn(&Coverage) -> usize| input.coverage.iter().map(f).sum::<usize>();
    let mut m = String::from("// tag::methodology[]\n== Methodology\n\n=== Approach\n\nFindings come from the repository's audit index, where every report's findings are listed with their status and the evidence for it (most often a regression test), and from Formal Mind's swarm, which files each bug it finds with a Foundry proof of concept. Each finding below carries the report's own description and the code at its location in this commit.\n\n=== Formal verification\n\nThe contracts in scope are those the Foundry scripts under `script/` deploy or call. For each, formal-ast compiles the code with solc and translates the AST into a Lean 4 model: every function it can translate becomes a Lean definition, and the rest stay opaque (not modeled), so a theorem about the model holds for every behaviour of them. A function counts as proved when a theorem in the repository without `sorry` names its definition.\n\n");
    if input.coverage.is_empty() {
        m.push_str("No in-scope contract could be read, so there is no coverage to report.\n");
    } else {
        let pct = |p: usize, n: usize| if n == 0 { "0%".to_string() } else { format!("{:.1}%", p as f64 * 100.0 / n as f64) };
        m.push_str(&format!(
            "{} of {} functions are proved ({}); {} are in the Lean model and {} are not modeled. The repository has {} theorems{}.\n\n",
            total(|c| c.proved),
            total(|c| c.functions),
            pct(total(|c| c.proved), total(|c| c.functions)),
            total(|c| c.in_lean),
            total(|c| c.not_modeled),
            // Every contract sees the repository's theorems.
            input.coverage.iter().map(|c| c.theorems).max().unwrap_or(0),
            match input.coverage.iter().map(|c| c.sorry).max().unwrap_or(0) {
                0 => String::new(),
                n => format!(", {n} still with `sorry`"),
            }
        ));
        m.push_str(".Proofs coverage by contract\n[%header%footer,cols=\"3,1,1,1,1,1\"]\n|===\n| Contract | Functions | In Lean | Proved | Not modeled | Proved %\n");
        for c in &input.coverage {
            m.push_str(&format!("| {} | {} | {} | {} | {} | {}\n", c.contract, c.functions, c.in_lean, c.proved, c.not_modeled, pct(c.proved, c.functions)));
        }
        m.push_str(&format!("| Total | {} | {} | {} | {} | {}\n|===\n\n", total(|c| c.functions), total(|c| c.in_lean), total(|c| c.proved), total(|c| c.not_modeled), pct(total(|c| c.proved), total(|c| c.functions))));
        m.push_str("Every function's status and the theorems that name it are listed in the appendix.\n\n");
    }
    m.push_str("// end::methodology[]\n\n// tag::functions[]\n");
    {
        for c in &input.coverage {
            m.push_str(&format!(".{} functions\n[%header,cols=\"4,2,1\"]\n|===\n| Function | Status | Theorems\n", c.contract));
            for (f, s, t) in &c.rows {
                m.push_str(&format!("| `+{f}+` | {s} | {t}\n"));
            }
            m.push_str("|===\n\n");
        }
    }
    m.push_str("// end::functions[]\n");
    files.push(("methodology.adoc".into(), m));

    // lines-of-code.adoc
    let mut loc = String::from("// tag::loc[]\n== Lines of Code\n\n.In-scope Solidity, by file\n[%header%footer,cols=\"5,1,1,1,1\"]\n|===\n| File | Lines | Blanks | Comments | Code\n");
    let mut sum = (0, 0, 0, 0);
    for f in &input.files {
        let (l, b, c, k) = std::fs::read_to_string(root.join(f)).map(|t| count_lines(&t)).unwrap_or_default();
        sum = (sum.0 + l, sum.1 + b, sum.2 + c, sum.3 + k);
        loc.push_str(&format!("| `{f}` | {l} | {b} | {c} | {k}\n"));
    }
    loc.push_str(&format!("| Total ({} files) | {} | {} | {} | {}\n|===\n", input.files.len(), sum.0, sum.1, sum.2, sum.3));
    if !input.files.is_empty() {
        loc.push_str("\n=== Files\n\n[source,shell]\n----\n");
        for f in &input.files {
            loc.push_str(&format!("{f}\n"));
        }
        loc.push_str("----\n");
    }
    loc.push_str("// end::loc[]\n");
    files.push(("lines-of-code.adoc".into(), loc));

    // findings-*.adoc and manual-review.adoc: one tagged block per finding.
    let tests = regex::Regex::new(r"\b(test[A-Z_]\w*)").unwrap();
    let test_files = regex::Regex::new(r"([\w./-]+\.t\.sol)").unwrap();
    for (sev, file) in sections {
        let mut text = String::new();
        for (n, f) in by_sev(sev).into_iter().enumerate() {
            let n = n + 1;
            let id = if f.id.is_empty() || f.id == "—" { String::new() } else { format!("{} ", f.id) };
            text.push_str(&format!("// tag::{n}[]\n== {id}{}\n", inline(&f.title)));
            text.push_str(&format!("Status: *{}*, Severity: {}, Report: `+{}+`\n\n", f.status, f.severity, f.report));
            // The code at the finding's location.
            if let Some((path, a, b)) = f.body.as_deref().and_then(location).and_then(|(file, at)| excerpt(root, &file, &at)) {
                text.push_str(&code_block(&path, a, b, input.repo_url.is_some() && input.commit.is_some(), None));
            }
            if !f.evidence.is_empty() {
                text.push_str(&format!("=== Status evidence\n\n{}\n\n", inline(&f.evidence)));
                // The regression tests the evidence names, each function as it is in this commit.
                let named: Vec<String> = test_files.captures_iter(&f.evidence).map(|c| c[1].to_string()).collect();
                let fns: Vec<String> = tests.captures_iter(&f.evidence).map(|c| c[1].to_string()).collect();
                let mut shown = 0;
                for t in named.iter().filter_map(|t| resolve(root, t)) {
                    let Ok(src) = std::fs::read_to_string(root.join(&t)) else { continue };
                    for name in &fns {
                        if let Some((a, b)) = function_lines(&src, name, 60) {
                            text.push_str(&code_block(&t, a, b, input.repo_url.is_some() && input.commit.is_some(), Some("Regression test")));
                            shown += 1;
                        }
                    }
                }
                // Only a file named: its first test.
                if shown == 0 {
                    if let Some(t) = named.iter().filter_map(|t| resolve(root, t)).next() {
                        if let Ok(src) = std::fs::read_to_string(root.join(&t)) {
                            if let Some(name) = regex::Regex::new(r"function\s+(test\w*)").unwrap().captures(&src).map(|c| c[1].to_string()) {
                                if let Some((a, b)) = function_lines(&src, &name, 60) {
                                    text.push_str(&code_block(&t, a, b, input.repo_url.is_some() && input.commit.is_some(), Some("Regression test")));
                                }
                            }
                        }
                    }
                }
            }
            match &f.body {
                Some(body) => {
                    let adoc = md_to_adoc(body);
                    // The report's text under its own headings; what comes before the first one is the description.
                    if !adoc.trim_start().starts_with("=== ") {
                        text.push_str(if adoc.contains("\n=== Description") { "=== Summary\n\n" } else { "=== Description\n\n" });
                    }
                    text.push_str(&adoc);
                    text.push('\n');
                }
                None => text.push_str("The report has no section for this finding; the index entry above is all there is.\n"),
            }
            text.push_str(&format!("\n// end::{n}[]\n\n"));
        }
        files.push((file.into(), text));
    }

    files.push((
        "glossary.adoc".into(),
        "// tag::terminology[]\nformal-ast:: Formal Mind's reader of the Solidity compiler's AST. It finds the contracts in scope from the deploy scripts and translates them into a Lean 4 model.\nLean model:: The Lean 4 definitions generated for a contract's functions, against which theorems are proved.\nNot modeled:: A function formal-ast could not translate; it stays opaque in the model, so a theorem holds for every behaviour of it.\nProved:: A function named by at least one theorem that has no `sorry`.\nPoC:: A Foundry test that reproduces a finding.\nRegression test:: A test that fails on the code before a fix and passes after it.\n// end::terminology[]\n".into(),
    ));
    let mut refs = String::from("// tag::refs[]\n");
    for (i, r) in input.reports.iter().enumerate() {
        let link = match (&input.repo_url, &input.commit) {
            (Some(_), Some(_)) => format!("{{url-blob}}{r}[{r}]"),
            _ => format!("`{r}`"),
        };
        refs.push_str(&format!("* [[[ref-{},{}]]] {link}\n", i + 1, i + 1));
    }
    refs.push_str("* [[[lean,Lean]]] https://lean-lang.org[Lean 4]\n* [[[generator,Generator]]] https://github.com/mmsaki/audit-report-generator[mmsaki/audit-report-generator], whose layout and theme this report uses\n// end::refs[]\n");
    files.push(("references.adoc".into(), refs));
    files.push(("themes/report-theme.yml".into(), THEME.to_string()));
    files
}

fn code_block(path: &str, a: usize, b: usize, linked: bool, what: Option<&str>) -> String {
    let lang = if path.ends_with(".sol") { "solidity" } else { "text" };
    let label = format!("{path}#L{a}-L{b}");
    let title = if linked { format!("{{url-blob}}{label}[{label}]") } else { label };
    format!(".{}{title}\n[source,{lang},linenums,start={a}]\n----\ninclude::{{src-dir}}{path}[lines={a}..{b}]\n----\n\n", what.map(|w| format!("{w} ")).unwrap_or_default())
}

// ---- reading the folder ----

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git").arg("-C").arg(root).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
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

/// Everything the report says, read from the folder.
pub fn gather(root: &Path, dirs: &[String]) -> Input {
    let mut input = Input { project: root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), ..Default::default() };
    input.commit = git(root, &["rev-parse", "HEAD"]);
    input.repo_url = git(root, &["remote", "get-url", "origin"]).and_then(|r| web_url(&r));
    if let Some(u) = &input.repo_url {
        input.project = u.rsplit('/').next().unwrap_or(&input.project).to_string();
    }
    input.date = crate::swarm_ctx::chrono_today();

    // The findings: each audit folder's index, with the report's own section for each.
    let mut reports = BTreeSet::new();
    for d in dirs {
        let dir = root.join(d);
        for idx in ["README.md", "INDEX.md", "readme.md", "index.md"] {
            let Ok(text) = std::fs::read_to_string(dir.join(idx)) else { continue };
            for mut f in parse_index(&text) {
                let report = dir.join(&f.report);
                if let Ok(md) = std::fs::read_to_string(&report) {
                    f.body = section(&md, &f.id);
                    reports.insert(report.strip_prefix(root).unwrap_or(&report).to_string_lossy().replace('\\', "/"));
                }
                input.findings.push(f);
            }
            break;
        }
    }
    // The swarm's bugs not already in an index.
    if let Ok(read) = std::fs::read_dir(root.join(".formal/bugs")) {
        let mut bugs: Vec<_> = read.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "md")).collect();
        bugs.sort_by_key(|e| e.file_name());
        for e in bugs {
            if let Ok(text) = std::fs::read_to_string(e.path()) {
                let b = swarm_bug(&e.file_name().to_string_lossy(), &text);
                if !input.findings.iter().any(|f| f.title == b.title) {
                    input.findings.push(b);
                }
            }
        }
    }
    input.reports = reports.into_iter().collect();

    // Coverage and scope, as the Proofs page reads them.
    let (contracts, _) = in_scope(root, &mut input.problems);
    let mut files = BTreeSet::new();
    for (file, name) in contracts {
        let (a, output) = match analyze_full(root, &file, Some(&name)) {
            Ok(x) => x,
            Err(e) => {
                input.problems.push(format!("{file}: {e:#}"));
                continue;
            }
        };
        let f = formal_json(&a, &output, 0);
        input.coverage.push(coverage(&f));
        files.insert(file);
        for func in f["functions"].as_array().into_iter().flatten() {
            if func["dependency"] == false {
                if let Some(p) = func["file"].as_str() {
                    files.insert(p.to_string());
                }
            }
        }
    }
    input.files = files.into_iter().collect();
    input
}

/// A contract's coverage from `formal_json`, counted as the Proofs page counts it (library functions included).
pub fn coverage(f: &Value) -> Coverage {
    let theorems: Vec<Value> = f["theorems"].as_array().cloned().unwrap_or_default();
    let mut c = Coverage { contract: f["contract"].as_str().unwrap_or("").into(), theorems: theorems.len(), sorry: theorems.iter().filter(|t| t["sorry"] == true).count(), ..Default::default() };
    for func in f["functions"].as_array().into_iter().flatten() {
        let by: Vec<&Value> = func["theorems"].as_array().into_iter().flatten().filter_map(|i| theorems.get(i.as_u64()? as usize)).collect();
        let status = if func["why"].is_string() {
            c.not_modeled += 1;
            "Not modeled"
        } else if by.iter().any(|t| t["sorry"] == false) {
            c.in_lean += 1;
            c.proved += 1;
            "Proved"
        } else if !by.is_empty() {
            c.in_lean += 1;
            "Has sorry"
        } else {
            c.in_lean += 1;
            "In Lean"
        };
        c.functions += 1;
        c.rows.push((func["name"].as_str().unwrap_or("").into(), status.into(), by.len()));
    }
    c
}

// ---- asciidoctor-pdf ----

/// asciidoctor-pdf: on PATH as a login shell sees it, or where Homebrew and RubyGems put it.
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

pub const INSTALL: &str = "asciidoctor-pdf isn't installed, so only the AsciiDoc was written. Install it with Homebrew (it brings Ruby, asciidoctor-pdf and the Rouge highlighter):\n\n    brew install asciidoctor\n\nthen generate the report again.";

#[derive(Serialize)]
pub struct Generated {
    /// The AsciiDoc folder, folder-relative (e.g. audit/report).
    pub adoc: String,
    /// The PDF, folder-relative, when asciidoctor-pdf made one.
    pub pdf: Option<String>,
    /// Why there's no PDF (how to install the toolchain, or what asciidoctor-pdf said).
    pub note: Option<String>,
    pub findings: usize,
    pub warnings: Vec<String>,
}

/// Writes the report into `<audit folder>/report/` and, with asciidoctor-pdf, the PDF next to it.
pub fn generate(root: &Path, dirs: &[String]) -> Result<Generated, String> {
    let dirs: Vec<String> = if dirs.is_empty() { vec!["audit".into(), "audits".into(), "reports".into()] } else { dirs.to_vec() };
    let audit = dirs.iter().map(|d| root.join(d)).find(|d| d.is_dir()).unwrap_or_else(|| crate::swarm_ctx::report_dir(root));
    let report_dir = audit.join("report");
    let input = gather(root, &dirs);
    for (name, text) in render(root, &report_dir, &input) {
        let p = report_dir.join(&name);
        std::fs::create_dir_all(p.parent().unwrap_or(&report_dir)).map_err(|e| e.to_string())?;
        std::fs::write(&p, text).map_err(|e| e.to_string())?;
    }
    let rel = |p: &Path| p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/");
    let mut out = Generated { adoc: rel(&report_dir), pdf: None, note: None, findings: input.findings.len(), warnings: input.problems.clone() };
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
        .current_dir(&report_dir)
        // Homebrew's Ruby, for a GUI app whose PATH lacks it.
        .env("PATH", format!("{}:/opt/homebrew/bin:/usr/local/bin:{}", bin.parent().map(|p| p.display().to_string()).unwrap_or_default(), std::env::var("PATH").unwrap_or_default()))
        .args(["--failure-level", "ERROR", "-o"])
        .arg(&pdf)
        .arg("README.adoc")
        .output()
        .map_err(|e| format!("{}: {e}", bin.display()))?;
    let log = String::from_utf8_lossy(&run.stderr).to_string();
    out.warnings.extend(log.lines().filter(|l| !l.trim().is_empty()).map(String::from));
    if pdf.exists() && run.status.success() {
        out.pdf = Some(rel(&pdf));
    } else {
        out.note = Some(format!("asciidoctor-pdf failed:\n{}", log.trim()));
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

    const INDEX: &str = "# Audits\n\n| Report | Date |\n|---|---|\n| [a.md](a.md) | x |\n\n## a.md\n\n| ID | Severity | Finding | Status | Evidence |\n|----|---|---|---|---|\n| H-01 | High | Fee \\| rounding | ✅ Fixed | `test/A.t.sol` |\n| I-02 | Info | Small | 📝 Acknowledged | why |\n\n## [b.md](b.md)\n\n| ID | Severity | Finding | Status | Evidence |\n|---|---|---|---|---|\n| — | — | Hardening | 🟢 Works as expected | |\n";

    #[test]
    fn index_rows_are_findings() {
        let f = parse_index(INDEX);
        assert_eq!(f.len(), 3);
        assert_eq!((f[0].id.as_str(), f[0].severity.as_str(), f[0].title.as_str(), f[0].status.as_str(), f[0].report.as_str()), ("H-01", "High", "Fee | rounding", "Fixed", "a.md"));
        assert_eq!((f[1].severity.as_str(), f[1].status.as_str()), ("Informational", "Acknowledged"));
        assert_eq!((f[2].report.as_str(), f[2].status.as_str()), ("b.md", "Works as expected"));
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
        assert!(a.contains("=== Impact"));
        assert!(a.contains("**Bold** `++a*b{c}++` https://e.com[x] y"));
        assert!(a.contains("* one\n** two\n. first"));
        assert!(a.contains("|===\n| A | B\n| `++p\\|q++` | 2\n|==="));
        assert!(a.contains("[source,solidity]\n----\nuint x;\n----"));
    }

    #[test]
    fn functions_by_braces() {
        let src = "contract C {\n    function a() external {\n        if (x) {\n            y();\n        }\n    }\n    receive() external payable {}\n}\n";
        assert_eq!(function_lines(src, "a", 60), Some((2, 6)));
        assert_eq!(function_lines(src, "receive", 60), Some((7, 7)));
    }

    #[test]
    fn report_files_follow_the_generator() {
        let root = std::env::temp_dir().join(format!("fm-report-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("audit")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/R.sol"), "contract R {\n    function fill() external {\n        x = 1;\n    }\n}\n").unwrap();
        std::fs::write(root.join("audit/README.md"), INDEX).unwrap();
        std::fs::write(root.join("audit/a.md"), "### [H-01] Fee\n\n**Location**: `R.sol:fill`\n\nBad.\n").unwrap();
        let mut input = gather(&root, &["audit".into()]);
        input.files = vec!["src/R.sol".into()];
        let files = render(&root, &root.join("audit/report"), &input);
        let get = |n: &str| files.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone()).unwrap();
        assert!(get("README.adoc").contains(":src-dir: ../../\n"));
        assert!(get("README.adoc").contains("include::findings-high.adoc[tags=1]"));
        let high = get("findings-high.adoc");
        assert!(high.contains("// tag::1[]\n== H-01 Fee | rounding"));
        assert!(high.contains("include::{src-dir}src/R.sol[lines=2..4]"));
        assert!(high.contains("Bad."));
        assert!(get("manual-review.adoc").contains("== I-02 Small"));
        assert!(get("lines-of-code.adoc").contains("| `src/R.sol` | 5 | 0 | 0 | 5"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The report for a real folder: `FM_FOLDER=… cargo test -- --ignored report_of_a_folder --nocapture`.
    #[test]
    #[ignore]
    fn report_of_a_folder() {
        let root = PathBuf::from(std::env::var("FM_FOLDER").unwrap());
        let g = generate(&root, &[]).unwrap();
        println!("adoc {} · pdf {:?} · {} findings\nnote {:?}", g.adoc, g.pdf, g.findings, g.note);
        for w in g.warnings {
            println!("  {w}");
        }
    }
}
