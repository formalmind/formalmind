//! The report folder (SPEC.md §2.2, B18, B30, B52): what the swarm files for the Bugs page, the website and the
//! maintainer's editor.
//!
//! - `<report dir>/README.md`, the index: the swarm's section `## formal-mind-swarm.md` with one row per finding,
//!   `| FM-NN | Severity | title | ⏳ Open | PoC `path`; `loc` |`, ids `FM-NN` = the highest in the index + 1.
//! - `<report dir>/formal-mind-swarm.md`: one `### [FM-NN] title` section per finding.
//! - `<report dir>/formal-mind.audit.json` (`formalmind.audit/v1`, kind internal): `findings[]`, and `properties[]` the
//!   reviewer approved, `P-NN` per plan item and `P-S01` per statement, upserted by id.
//! - `<report>.audit.json` next to each triaged report (kind external).
//! - `.formal/findings.sarif` (SARIF 2.1.0): the swarm's findings and tags in its own run; other tools' runs kept.
//!
//! The formats are byte-for-byte what earlier builds wrote; the golden tests below hold them.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The swarm's findings report, in the report folder.
pub const REPORT: &str = "formal-mind-swarm.md";
/// Formal Mind's own audit file, in the report folder.
pub const INTERNAL: &str = "formal-mind.audit.json";
pub const SCHEMA: &str = "formalmind.audit/v1";
/// The swarm's run in findings.sarif.
pub const SARIF_RUN: &str = "formal-mind/swarm/";
/// SARIF rule of a finding the swarm filed; tags are `formal-mind/tag/<kind>`.
pub const FINDING_RULE: &str = "formal-mind/finding";

const INDEX_HEADER: &str = "# Audits\n\nSecurity reports and the status of every finding.\n";
const REPORT_HEADER: &str = "# Formal Mind swarm findings\n\nFindings from Formal Mind's local swarm (planner, prover, reviewer) while proving this repository's contracts against the Lean model formal-ast generates from solc's AST. Each one has a Foundry PoC under `test/`; their status is kept in [README.md](README.md).\n";
const TABLE_HEAD: &str = "| ID | Severity | Finding | Status | Evidence |";
const TABLE_RULE: &str = "|----|----------|---------|--------|----------|";

/// The report folder: the first of `audit/`, `audits/`, `reports/` that exists, else `audit/`.
pub fn report_dir(root: &Path) -> PathBuf {
    ["audit", "audits", "reports"].iter().map(|d| root.join(d)).find(|d| d.is_dir()).unwrap_or_else(|| root.join("audit"))
}

pub fn internal_path(root: &Path) -> PathBuf {
    report_dir(root).join(INTERNAL)
}

pub fn sarif_path(root: &Path) -> PathBuf {
    root.join(".formal").join("findings.sarif")
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// Today as YYYY-MM-DD (UTC).
pub fn today() -> String {
    let days = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64;
    civil(days)
}

/// Days since 1970-01-01 as YYYY-MM-DD (Howard Hinnant's civil_from_days).
fn civil(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

// ---- FM findings: the index and the report -----------------------------------------------------------------------

/// A table cell: pipes escaped, one line.
fn cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ").trim().to_string()
}

/// The next finding id: `FM-NN`, one past the highest in the index (`FM-01` when there is none).
pub fn next_id(index: &str) -> String {
    let n = regex::Regex::new(r"\|\s*FM-(\d+)\s*\|").expect("valid regex").captures_iter(index).filter_map(|c| c[1].parse::<u32>().ok()).max().unwrap_or(0) + 1;
    format!("FM-{n:02}")
}

/// `high` → `High`; empty → `Medium`.
fn capitalized(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_else(|| "Medium".into())
}

/// SARIF level for a severity (B30): critical/high → error, medium → warning, else note.
pub fn sarif_level(severity: &str) -> &'static str {
    match severity {
        "critical" | "high" => "error",
        "medium" => "warning",
        _ => "note",
    }
}

/// The index with `row` in the swarm's section: after its table's last row, a table started under the heading when it
/// has none, or the section (and a line in the index's report table, when there is one) added at the end.
fn index_with(index: &str, row: &str, today: &str) -> String {
    let heading = format!("## {REPORT}");
    let mut l: Vec<String> = index.lines().map(String::from).collect();
    if let Some(h) = l.iter().position(|x| x.trim() == heading || x.trim() == format!("## [{REPORT}]({REPORT})")) {
        let mut at = h + 1;
        let mut last_row = None;
        while at < l.len() && !l[at].starts_with("## ") {
            if l[at].trim_start().starts_with('|') {
                last_row = Some(at);
            }
            at += 1;
        }
        match last_row {
            Some(r) => l.insert(r + 1, row.to_string()),
            None => {
                for (k, line) in ["", TABLE_HEAD, TABLE_RULE, row].into_iter().enumerate() {
                    l.insert(h + 1 + k, line.to_string());
                }
            }
        }
        return l.join("\n") + "\n";
    }
    if let Some(head) = l.iter().position(|x| x.trim_start().starts_with("| Report")) {
        let mut end = head + 1;
        while end < l.len() && l[end].trim_start().starts_with('|') {
            end += 1;
        }
        let cols = l[head].matches('|').count().saturating_sub(1);
        let mut cells = vec![format!("[{REPORT}]({REPORT})"), today.to_string(), "Formal Mind swarm".into(), "Local swarm: Lean proofs against the generated model".into()];
        cells.resize(cols.max(1), String::new());
        l.insert(end, format!("| {} |", cells.join(" | ")));
    }
    let mut text = l.join("\n").trim_end().to_string();
    text.push_str(&format!("\n\n{heading}\n\n{TABLE_HEAD}\n{TABLE_RULE}\n{row}\n"));
    text
}

/// A finding's section in the report.
fn report_section(id: &str, input: &Value, poc: &str, forge: &str, today: &str) -> String {
    let s = |k: &str| input[k].as_str().unwrap_or("").trim().to_string();
    let title = if s("title").is_empty() { "Finding".to_string() } else { s("title") };
    format!(
        "\n### [{id}] {title}\n\n**Severity:** {}\n**Location:** `{}`\n**PoC:** `{poc}`\n**Found:** {today}\n\n#### Scenario\n\n{}\n{}\n#### PoC run\n\n`forge test --match-path {poc}`\n\n```\n{}\n```\n",
        capitalized(&s("severity")).to_lowercase(),
        s("location"),
        s("scenario"),
        if s("evidence").is_empty() { String::new() } else { format!("\n#### Evidence\n\n{}\n", s("evidence")) },
        forge.trim()
    )
}

/// Files a bug (B30) once its PoC ran: its section in the report, its row (⏳ Open, the PoC as evidence) in the index,
/// its entry in the internal audit file. `input` is report_bug's (`title, severity, location, scenario, impact?,
/// recommendation?, evidence?`); `forge` the PoC run's tail. Returns (`FM-NN`, the report's folder-relative path).
pub fn file_finding(root: &Path, input: &Value, poc: &str, forge: &str) -> Result<(String, String), String> {
    file_finding_on(root, input, poc, forge, &today())
}

fn file_finding_on(root: &Path, input: &Value, poc: &str, forge: &str, today: &str) -> Result<(String, String), String> {
    let dir = report_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let index_path = dir.join("README.md");
    let index = std::fs::read_to_string(&index_path).unwrap_or_else(|_| INDEX_HEADER.into());
    let id = next_id(&index);
    let s = |k: &str| input[k].as_str().unwrap_or("").trim().to_string();
    let title = if s("title").is_empty() { "Finding".to_string() } else { s("title") };

    let report_path = dir.join(REPORT);
    let mut report = std::fs::read_to_string(&report_path).unwrap_or_else(|_| REPORT_HEADER.into());
    report.push_str(&report_section(&id, input, poc, forge, today));
    std::fs::write(&report_path, report).map_err(|e| e.to_string())?;

    let row = format!("| {id} | {} | {} | ⏳ Open | PoC `{poc}`; `{}` |", capitalized(&s("severity")), cell(&title), cell(&s("location")));
    std::fs::write(&index_path, index_with(&index, &row, today)).map_err(|e| e.to_string())?;

    record_internal_finding(root, &id, input, poc)?;
    Ok((id, rel(root, &report_path)))
}

/// A finding's line in the editor (B30): its result in findings.sarif, at its location, when that is a source file.
pub fn sarif_finding(root: &Path, id: &str, input: &Value, poc: &str, by: &str) -> Result<(), String> {
    let Some((file, line)) = source_location(input["location"].as_str().unwrap_or("")) else { return Ok(()) };
    let severity = input["severity"].as_str().unwrap_or("medium");
    let title = input["title"].as_str().unwrap_or("bug");
    let props = json!({ "id": id, "severity": severity, "poc": poc, "by": by, "scenario": input["scenario"], "impact": input["impact"], "recommendation": input["recommendation"] });
    sarif_add(root, FINDING_RULE, sarif_level(severity), &file, line, format!("{id} ({severity}): {title}. PoC: {poc}"), props)
}

// ---- formalmind.audit/v1 ------------------------------------------------------------------------------------------

/// A report's own audit file: `audits/Spearbit.pdf` → `audits/Spearbit.audit.json`.
pub fn audit_json_path(root: &Path, report: &str) -> PathBuf {
    let p = root.join(report);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "report".into());
    p.with_file_name(format!("{stem}.audit.json"))
}

/// An audit file, or `fresh` when it is missing, unreadable or not `formalmind.audit/v1`.
fn load_audit(path: &Path, fresh: Value) -> Value {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v["schema"] == SCHEMA).unwrap_or(fresh)
}

/// Pretty JSON with a final newline; returns the folder-relative path.
fn save_audit(root: &Path, path: &Path, doc: &Value) -> Result<String, String> {
    std::fs::create_dir_all(path.parent().unwrap_or(root)).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    std::fs::write(path, text + "\n").map_err(|e| e.to_string())?;
    Ok(rel(root, path))
}

fn external(report: &str) -> Value {
    json!({ "schema": SCHEMA, "kind": "external", "title": "", "source": report, "findings": [] })
}

/// The report's own facts (title, auditor, authors, date, commit, repository, scope, summary, kind), merged into its
/// `.audit.json` (the auditor role's `record_report`).
pub fn record_report(root: &Path, report: &str, input: &Value) -> Result<String, String> {
    let path = audit_json_path(root, report);
    let mut doc = load_audit(&path, external(report));
    for k in ["title", "auditor", "authors", "date", "commit", "repository", "scope", "summary", "kind"] {
        if !input[k].is_null() {
            doc[k] = input[k].clone();
        }
    }
    doc["source"] = json!(report);
    save_audit(root, &path, &doc)
}

/// The status words the format allows.
fn status_of(s: &str) -> &'static str {
    match s.trim().to_ascii_lowercase().as_str() {
        "fixed" => "fixed",
        "works as expected" | "works-as-expected" | "intended" => "works as expected",
        "acknowledged" => "acknowledged",
        "rejected" | "invalid" => "rejected",
        _ => "open",
    }
}

/// One finding of a triaged report (the auditor role's `record_finding`), added or replacing the same id.
pub fn record_finding_json(root: &Path, report: &str, input: &Value) -> Result<String, String> {
    let id = input["id"].as_str().unwrap_or("").trim().to_string();
    if id.is_empty() {
        return Err("id is required (the report's own ID for the finding, e.g. H-01)".into());
    }
    let path = audit_json_path(root, report);
    let mut doc = load_audit(&path, external(report));
    let mut f = json!({});
    for k in ["id", "title", "severity", "status", "reportStatus", "locations", "description", "impact", "recommendation", "response", "evidence", "tests", "poc", "fix", "page"] {
        if !input[k].is_null() {
            f[k] = input[k].clone();
        }
    }
    f["id"] = json!(id);
    if let Some(s) = f["severity"].as_str() {
        f["severity"] = json!(s.trim().to_ascii_lowercase());
    }
    if let Some(s) = f["status"].as_str() {
        f["status"] = json!(status_of(s));
    }
    if !doc["findings"].is_array() {
        return Err("bad audit file".into());
    }
    upsert(&mut doc, "findings", f);
    save_audit(root, &path, &doc)
}

/// Re-reads the internal audit file, applies `f`, writes it back.
fn update_internal(root: &Path, f: impl FnOnce(&mut Value)) -> Result<String, String> {
    let path = internal_path(root);
    let mut doc = load_audit(&path, json!({ "schema": SCHEMA, "kind": "internal", "title": "", "auditor": "Formal Mind", "findings": [] }));
    f(&mut doc);
    save_audit(root, &path, &doc)
}

/// Adds `entry` to `doc[key]`, or replaces the entry with the same id.
fn upsert(doc: &mut Value, key: &str, entry: Value) {
    if !doc[key].is_array() {
        doc[key] = json!([]);
    }
    let list = doc[key].as_array_mut().expect("an array");
    match list.iter_mut().find(|x| x["id"] == entry["id"]) {
        Some(x) => *x = entry,
        None => list.push(entry),
    }
}

/// `src/Router.sol:120` (or `src/Router.sol`, or `:120-130`) as `{file, line?}`, only for a `.sol` file.
fn location_of(s: &str) -> Option<Value> {
    let s = s.trim().trim_matches('`');
    let (file, line) = match s.rsplit_once(':') {
        Some((f, l)) if l.trim().split('-').next().is_some_and(|n| n.parse::<u64>().is_ok()) => (f, l.trim().split('-').next().and_then(|n| n.parse::<u64>().ok())),
        _ => (s, None),
    };
    if !file.ends_with(".sol") {
        return None;
    }
    Some(match line {
        Some(l) => json!({ "file": file, "line": l }),
        None => json!({ "file": file }),
    })
}

/// A bug the swarm reported, in the internal audit file: open, with its PoC, in the report's words.
pub fn record_internal_finding(root: &Path, id: &str, input: &Value, poc: &str) -> Result<String, String> {
    let s = |k: &str| input[k].as_str().unwrap_or("").trim().to_string();
    let mut f = json!({
        "id": id,
        "title": s("title"),
        "severity": if s("severity").is_empty() { "medium".to_string() } else { s("severity").to_ascii_lowercase() },
        "status": "open",
        "description": s("scenario"),
        "poc": poc,
        "tests": [],
    });
    if let Some(l) = location_of(&s("location")) {
        f["locations"] = json!([l]);
    }
    for k in ["impact", "recommendation", "evidence"] {
        if !s(k).is_empty() {
            f[k] = json!(s(k));
        }
    }
    update_internal(root, |doc| upsert(doc, "findings", f))
}

/// The property that goes into the report (B18): the prover's notes, each non-empty field the reviewer gave
/// (`statement`, `assumptions`, `theorems`) replacing it. None without a statement.
pub fn merge_property(prover: Option<&Value>, reviewer: Option<&Value>) -> Option<Value> {
    let mut p = prover.cloned().unwrap_or_else(|| json!({}));
    for k in ["statement", "assumptions", "theorems"] {
        let given = reviewer.map(|r| &r[k]).filter(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()) || v.as_array().is_some_and(|a| !a.is_empty()));
        if let Some(v) = given {
            p[k] = v.clone();
        }
    }
    p["statement"].as_str().is_some_and(|s| !s.trim().is_empty()).then_some(p)
}

/// What holds and under which assumptions, as the description reads.
fn description(input: &Value) -> Result<String, String> {
    let statement = input["statement"].as_str().unwrap_or("").trim();
    if statement.is_empty() {
        return Err("statement is required: what the proof establishes".into());
    }
    let assumptions = input["assumptions"].as_str().unwrap_or("").trim();
    Ok(if assumptions.is_empty() { statement.to_string() } else { format!("{statement}\n\n**Assumptions.** {assumptions}") })
}

fn theorems(input: &Value) -> Vec<Value> {
    input["theorems"].as_array().into_iter().flatten().filter_map(|t| t.as_str()).map(|t| json!({ "name": t })).collect()
}

/// A plan item's approved property (B18): `P-NN` (the item's number), titled by its def, with the item's source
/// location, the theorems and the proof's files.
pub fn record_property(root: &Path, item: usize, item_text: &str, files: &[String], input: &Value) -> Result<String, String> {
    let mut p = json!({
        "id": format!("P-{item:02}"),
        "title": item_text.split('`').nth(1).unwrap_or(item_text).to_string(),
        "status": "verified",
        "description": description(input)?,
        "theorems": theorems(input),
        "files": files,
    });
    if let Some(c) = regex::Regex::new(r"\(((?:src|contracts)/[^):\s]+):(\d+)\)").expect("valid regex").captures(item_text) {
        p["locations"] = json!([{ "file": &c[1], "line": c[2].parse::<u64>().unwrap_or(0) }]);
    }
    update_internal(root, |doc| upsert(doc, "properties", p))
}

/// A proved statement (B52): `P-S01` for `S-01`, titled by the maintainer's words.
pub fn record_statement_property(root: &Path, id: &str, title: &str, files: &[String], input: &Value) -> Result<String, String> {
    let p = json!({
        "id": format!("P-{}", id.replace('-', "")),
        "statement": id,
        "title": title,
        "status": "verified",
        "description": description(input)?,
        "theorems": theorems(input),
        "files": files,
    });
    update_internal(root, |doc| upsert(doc, "properties", p))
}

// ---- findings.sarif -----------------------------------------------------------------------------------------------

/// `src/X.sol:446`, `src/X.sol:L446`, `src/X.sol#L446` (or a bare file, line 1) as (file, line), for `.sol`/`.huff`.
pub fn source_location(s: &str) -> Option<(String, usize)> {
    let s = s.trim().trim_matches('`').trim_start_matches("./");
    let (file, line) = s.rsplit_once(":L").or_else(|| s.rsplit_once("#L")).or_else(|| s.rsplit_once(':')).unwrap_or((s, "1"));
    let line = line.split(|c: char| !c.is_ascii_digit()).next().and_then(|n| n.parse().ok()).unwrap_or(1);
    (file.ends_with(".sol") || file.ends_with(".huff")).then(|| (file.to_string(), line))
}

/// Adds one result to the swarm's run in findings.sarif, creating the file or the run as needed and keeping other
/// tools' runs. The same rule, place and message again replaces it rather than adding a copy.
pub fn sarif_add(root: &Path, rule: &str, level: &str, file: &str, line: usize, message: String, properties: Value) -> Result<(), String> {
    let path = sarif_path(root);
    let mut doc: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({ "$schema": "https://json.schemastore.org/sarif-2.1.0.json", "version": "2.1.0", "runs": [] }));
    let runs = doc["runs"].as_array_mut().ok_or("findings.sarif has no runs")?;
    if !runs.iter().any(|r| r["automationDetails"]["id"] == SARIF_RUN) {
        runs.push(json!({
            "tool": { "driver": { "name": "formal-mind", "informationUri": "https://formal.team", "rules": [] } },
            "automationDetails": { "id": SARIF_RUN },
            "originalUriBaseIds": { "PROJECT": { "description": { "text": "The project root" } } },
            "results": [],
        }));
    }
    let run = runs.iter_mut().find(|r| r["automationDetails"]["id"] == SARIF_RUN).expect("just added");
    let rules = run["tool"]["driver"]["rules"].as_array_mut().ok_or("bad rules")?;
    if !rules.iter().any(|r| r["id"] == rule) {
        rules.push(json!({ "id": rule, "defaultConfiguration": { "level": level } }));
    }
    let print = format!("{rule}:{file}:{line}:{message}");
    let results = run["results"].as_array_mut().ok_or("bad results")?;
    results.retain(|r| r["partialFingerprints"]["formal-mind/v1"] != print.as_str());
    results.push(json!({
        "ruleId": rule,
        "level": level,
        "message": { "text": message },
        "locations": [{ "physicalLocation": { "artifactLocation": { "uri": file, "uriBaseId": "PROJECT" }, "region": { "startLine": line.max(1) } } }],
        "partialFingerprints": { "formal-mind/v1": print },
        "properties": properties,
    }));
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap_or_default()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("fm2-audit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn read(p: PathBuf) -> String {
        std::fs::read_to_string(p).unwrap()
    }

    fn bug() -> Value {
        json!({ "title": "Fill drains | the pool", "severity": "high", "location": "src/R.sol:12", "scenario": "Anyone fills.", "impact": "Funds lost.", "recommendation": "Guard it.", "evidence": "fill_drains", "poc": "test/formal/F.t.sol" })
    }

    const GOLDEN_INDEX: &str = "# Audits

| Report | Date | Author | Scope |
|---|---|---|---|
| [a.md](a.md) | 2026-01-01 | X | All |
| [formal-mind-swarm.md](formal-mind-swarm.md) | 2026-10-29 | Formal Mind swarm | Local swarm: Lean proofs against the generated model |

## a.md

| ID | Severity | Finding | Status | Evidence |
|----|---|---|---|---|
| H-01 | High | x | ✅ Fixed | `test/A.t.sol` |

## formal-mind-swarm.md

| ID | Severity | Finding | Status | Evidence |
|----|----------|---------|--------|----------|
| FM-01 | High | Fill drains \\| the pool | ⏳ Open | PoC `test/formal/F.t.sol`; `src/R.sol:12` |
| FM-02 | Medium | Finding | ⏳ Open | PoC `test/formal/G.t.sol`; `` |
";

    const GOLDEN_REPORT: &str = "# Formal Mind swarm findings

Findings from Formal Mind's local swarm (planner, prover, reviewer) while proving this repository's contracts against the Lean model formal-ast generates from solc's AST. Each one has a Foundry PoC under `test/`; their status is kept in [README.md](README.md).

### [FM-01] Fill drains | the pool

**Severity:** high
**Location:** `src/R.sol:12`
**PoC:** `test/formal/F.t.sol`
**Found:** 2026-10-29

#### Scenario

Anyone fills.

#### Evidence

fill_drains

#### PoC run

`forge test --match-path test/formal/F.t.sol`

```
[PASS] test_fill()
```

### [FM-02] Finding

**Severity:** medium
**Location:** ``
**PoC:** `test/formal/G.t.sol`
**Found:** 2026-10-29

#### Scenario



#### PoC run

`forge test --match-path test/formal/G.t.sol`

```
exit 0
```
";

    #[test]
    fn b30_findings_are_filed_in_the_index_and_report() {
        let root = folder("index");
        std::fs::create_dir_all(root.join("audit")).unwrap();
        std::fs::write(root.join("audit/README.md"), "# Audits\n\n| Report | Date | Author | Scope |\n|---|---|---|---|\n| [a.md](a.md) | 2026-01-01 | X | All |\n\n## a.md\n\n| ID | Severity | Finding | Status | Evidence |\n|----|---|---|---|---|\n| H-01 | High | x | ✅ Fixed | `test/A.t.sol` |\n").unwrap();
        let (id, report) = file_finding_on(&root, &bug(), "test/formal/F.t.sol", "\n[PASS] test_fill()\n", "2026-10-29").unwrap();
        assert_eq!((id.as_str(), report.as_str()), ("FM-01", "audit/formal-mind-swarm.md"));
        let (id2, _) = file_finding_on(&root, &json!({}), "test/formal/G.t.sol", "exit 0", "2026-10-29").unwrap();
        assert_eq!(id2, "FM-02");
        assert_eq!(read(root.join("audit/README.md")), GOLDEN_INDEX);
        assert_eq!(read(root.join("audit/formal-mind-swarm.md")), GOLDEN_REPORT);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_first_finding_starts_the_index() {
        let root = folder("fresh");
        file_finding_on(&root, &bug(), "test/formal/F.t.sol", "ok", "2026-10-29").unwrap();
        assert_eq!(
            read(root.join("audit/README.md")),
            "# Audits\n\nSecurity reports and the status of every finding.\n\n## formal-mind-swarm.md\n\n| ID | Severity | Finding | Status | Evidence |\n|----|----------|---------|--------|----------|\n| FM-01 | High | Fill drains \\| the pool | ⏳ Open | PoC `test/formal/F.t.sol`; `src/R.sol:12` |\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_new_row_goes_under_the_swarms_heading() {
        // The heading linked, its table followed by another section; ids continue from the highest anywhere.
        let index = "# Audits\n\n## [formal-mind-swarm.md](formal-mind-swarm.md)\n\n| ID | Severity | Finding | Status | Evidence |\n|----|----------|---------|--------|----------|\n| FM-07 | Low | a | ✅ Fixed | x |\n\n## other.md\n\n| FM-03 | x |\n";
        assert_eq!(next_id(index), "FM-08");
        let out = index_with(index, "| FM-08 | row |", "d");
        assert_eq!(out, "# Audits\n\n## [formal-mind-swarm.md](formal-mind-swarm.md)\n\n| ID | Severity | Finding | Status | Evidence |\n|----|----------|---------|--------|----------|\n| FM-07 | Low | a | ✅ Fixed | x |\n| FM-08 | row |\n\n## other.md\n\n| FM-03 | x |\n");
        // A heading with no table yet gets one.
        assert_eq!(index_with("## formal-mind-swarm.md\n", "| FM-01 | r |", "d"), format!("## formal-mind-swarm.md\n\n{TABLE_HEAD}\n{TABLE_RULE}\n| FM-01 | r |\n"));
    }

    #[test]
    fn the_report_folder_is_the_first_that_exists() {
        let root = folder("dir");
        assert_eq!(report_dir(&root), root.join("audit"));
        std::fs::create_dir_all(root.join("reports")).unwrap();
        assert_eq!(report_dir(&root), root.join("reports"));
        std::fs::create_dir_all(root.join("audits")).unwrap();
        assert_eq!(report_dir(&root), root.join("audits"));
        file_finding_on(&root, &bug(), "test/formal/F.t.sol", "", "2026-10-29").unwrap();
        assert!(root.join("audits/README.md").exists() && root.join("audits/formal-mind.audit.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    const GOLDEN_INTERNAL: &str = r#"{
  "auditor": "Formal Mind",
  "findings": [
    {
      "description": "Anyone fills.",
      "evidence": "fill_drains",
      "id": "FM-01",
      "impact": "Funds lost.",
      "locations": [
        {
          "file": "src/R.sol",
          "line": 12
        }
      ],
      "poc": "test/formal/F.t.sol",
      "recommendation": "Guard it.",
      "severity": "high",
      "status": "open",
      "tests": [],
      "title": "Fill drains | the pool"
    }
  ],
  "kind": "internal",
  "properties": [
    {
      "description": "It reverts unless the caller owns the order.\n\n**Assumptions.** `ext.get` returns what `ext.set` wrote.",
      "files": [],
      "id": "P-04",
      "locations": [
        {
          "file": "src/Router.sol",
          "line": 113
        }
      ],
      "status": "verified",
      "theorems": [
        {
          "name": "swap_owner"
        }
      ],
      "title": "Router.swap"
    },
    {
      "description": "Every transfer needs the owner.",
      "files": [
        "formal/Proofs/InformalSpecs/S01/A.lean"
      ],
      "id": "P-S01",
      "statement": "S-01",
      "status": "verified",
      "theorems": [
        {
          "name": "owner_only"
        }
      ],
      "title": "Only the owner moves funds"
    }
  ],
  "schema": "formalmind.audit/v1",
  "title": ""
}
"#;

    #[test]
    fn b18_approved_properties_and_findings_go_into_the_audit_file() {
        let root = folder("internal");
        std::fs::create_dir_all(root.join("audit")).unwrap();
        file_finding_on(&root, &bug(), "test/formal/F.t.sol", "", "2026-10-29").unwrap();
        let item = "`Router.swap` — Router (src/Router.sol:113): payable";
        let p = json!({ "statement": "It reverts unless the caller owns the order.", "assumptions": "`ext.get` returns what `ext.set` wrote.", "theorems": ["swap_owner"] });
        record_property(&root, 4, item, &["formal/Proofs/Functions/RouterSwap.lean".into()], &p).unwrap();
        // Approving again replaces it, by id.
        record_property(&root, 4, item, &[], &p).unwrap();
        assert_eq!(record_property(&root, 5, item, &[], &json!({})).unwrap_err(), "statement is required: what the proof establishes");
        let s = json!({ "statement": "Every transfer needs the owner.", "assumptions": " ", "theorems": ["owner_only"] });
        let path = record_statement_property(&root, "S-01", "Only the owner moves funds", &["formal/Proofs/InformalSpecs/S01/A.lean".into()], &s).unwrap();
        assert_eq!(path, "audit/formal-mind.audit.json");
        assert_eq!(read(internal_path(&root)), GOLDEN_INTERNAL);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_unreadable_audit_file_starts_again() {
        let root = folder("corrupt");
        std::fs::create_dir_all(root.join("audit")).unwrap();
        std::fs::write(internal_path(&root), r#"{"schema": "something/else", "findings": [1]}"#).unwrap();
        record_internal_finding(&root, "FM-01", &json!({ "title": "t", "location": "README.md" }), "test/X.t.sol").unwrap();
        let doc: Value = serde_json::from_str(&read(internal_path(&root))).unwrap();
        assert_eq!((doc["kind"].as_str(), doc["findings"].as_array().unwrap().len()), (Some("internal"), 1));
        assert_eq!(doc["findings"][0]["severity"], "medium");
        assert!(doc["findings"][0].get("locations").is_none(), "only .sol locations");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn b18_the_reviewers_fields_replace_the_provers() {
        let prover = json!({ "statement": "p", "assumptions": "a", "theorems": ["t1"] });
        let reviewer = json!({ "statement": "r", "assumptions": "  ", "theorems": [] });
        assert_eq!(merge_property(Some(&prover), Some(&reviewer)), Some(json!({ "statement": "r", "assumptions": "a", "theorems": ["t1"] })));
        assert_eq!(merge_property(None, Some(&json!({ "theorems": ["t"] }))), None, "no statement, no property");
        assert_eq!(merge_property(Some(&prover), None), Some(prover));
    }

    const GOLDEN_EXTERNAL: &str = r#"{
  "auditor": "Spearbit",
  "date": "2024-05-01",
  "findings": [
    {
      "description": "d2",
      "id": "H-1",
      "locations": [
        {
          "file": "src/X.sol",
          "line": 3
        }
      ],
      "severity": "high",
      "status": "fixed",
      "title": "A"
    },
    {
      "id": "M-2",
      "status": "works as expected"
    }
  ],
  "kind": "external",
  "schema": "formalmind.audit/v1",
  "source": "docs/audits/Spearbit core.pdf",
  "title": "Uniswap v4-core Security Review"
}
"#;

    #[test]
    fn triaged_reports_get_their_own_audit_file() {
        let root = folder("external");
        std::fs::create_dir_all(root.join("docs/audits")).unwrap();
        let r = "docs/audits/Spearbit core.pdf";
        assert_eq!(audit_json_path(&root, r), root.join("docs/audits/Spearbit core.audit.json"));
        record_report(&root, r, &json!({ "title": "Uniswap v4-core Security Review", "auditor": "Spearbit", "date": "2024-05-01" })).unwrap();
        record_finding_json(&root, r, &json!({ "id": "H-1", "title": "A", "severity": "High", "status": "Open", "description": "d" })).unwrap();
        let p = record_finding_json(&root, r, &json!({ "id": "H-1", "title": "A", "severity": "high", "status": "fixed", "description": "d2", "locations": [{ "file": "src/X.sol", "line": 3 }] })).unwrap();
        record_finding_json(&root, r, &json!({ "id": "M-2", "status": "intended" })).unwrap();
        assert!(record_finding_json(&root, r, &json!({ "id": " " })).is_err());
        assert_eq!(p, "docs/audits/Spearbit core.audit.json");
        assert_eq!(read(root.join(p)), GOLDEN_EXTERNAL);
        std::fs::remove_dir_all(root).unwrap();
    }

    const GOLDEN_SARIF: &str = r#"{
  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "slither"
        }
      }
    },
    {
      "automationDetails": {
        "id": "formal-mind/swarm/"
      },
      "originalUriBaseIds": {
        "PROJECT": {
          "description": {
            "text": "The project root"
          }
        }
      },
      "results": [
        {
          "level": "error",
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": {
                  "uri": "src/R.sol",
                  "uriBaseId": "PROJECT"
                },
                "region": {
                  "startLine": 12
                }
              }
            }
          ],
          "message": {
            "text": "FM-01 (high): Fill drains | the pool. PoC: test/formal/F.t.sol"
          },
          "partialFingerprints": {
            "formal-mind/v1": "formal-mind/finding:src/R.sol:12:FM-01 (high): Fill drains | the pool. PoC: test/formal/F.t.sol"
          },
          "properties": {
            "by": "prover",
            "id": "FM-01",
            "impact": "Funds lost.",
            "poc": "test/formal/F.t.sol",
            "recommendation": "Guard it.",
            "scenario": "Anyone fills.",
            "severity": "high"
          },
          "ruleId": "formal-mind/finding"
        },
        {
          "level": "note",
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": {
                  "uri": "src/R.sol",
                  "uriBaseId": "PROJECT"
                },
                "region": {
                  "startLine": 1
                }
              }
            }
          ],
          "message": {
            "text": "suspicion (prover): Rounds up"
          },
          "partialFingerprints": {
            "formal-mind/v1": "formal-mind/tag/suspicion:src/R.sol:0:suspicion (prover): Rounds up"
          },
          "properties": {
            "by": "prover",
            "kind": "suspicion"
          },
          "ruleId": "formal-mind/tag/suspicion"
        }
      ],
      "tool": {
        "driver": {
          "informationUri": "https://formal.team",
          "name": "formal-mind",
          "rules": [
            {
              "defaultConfiguration": {
                "level": "error"
              },
              "id": "formal-mind/finding"
            },
            {
              "defaultConfiguration": {
                "level": "note"
              },
              "id": "formal-mind/tag/suspicion"
            }
          ]
        }
      }
    }
  ],
  "version": "2.1.0"
}"#;

    #[test]
    fn b30_findings_go_into_sarif_beside_other_tools() {
        let root = folder("sarif");
        std::fs::create_dir_all(root.join(".formal")).unwrap();
        std::fs::write(sarif_path(&root), r#"{"$schema": "https://json.schemastore.org/sarif-2.1.0.json", "version": "2.1.0", "runs": [{"tool": {"driver": {"name": "slither"}}}]}"#).unwrap();
        sarif_finding(&root, "FM-01", &bug(), "test/formal/F.t.sol", "prover").unwrap();
        sarif_finding(&root, "FM-01", &bug(), "test/formal/F.t.sol", "prover").unwrap();
        let tag = |line| sarif_add(&root, "formal-mind/tag/suspicion", "note", "src/R.sol", line, "suspicion (prover): Rounds up".into(), json!({ "kind": "suspicion", "by": "prover" }));
        tag(0).unwrap();
        tag(0).unwrap();
        assert_eq!(read(sarif_path(&root)), GOLDEN_SARIF);
        // No source location: nothing to put on a line.
        sarif_finding(&root, "FM-02", &json!({ "location": "the pool" }), "test/X.t.sol", "prover").unwrap();
        assert_eq!(read(sarif_path(&root)), GOLDEN_SARIF);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn b30_severity_sets_the_sarif_level() {
        assert_eq!(["critical", "high", "medium", "low", ""].map(sarif_level), ["error", "error", "warning", "note", "note"]);
        assert_eq!(source_location("`./src/A.sol#L446`"), Some(("src/A.sol".into(), 446)));
        assert_eq!(source_location("src/A.huff:L9"), Some(("src/A.huff".into(), 9)));
        assert_eq!(source_location("src/A.sol"), Some(("src/A.sol".into(), 1)));
        assert_eq!(source_location("docs/A.md:3"), None);
    }

    #[test]
    fn dates_are_civil() {
        assert_eq!(civil(0), "1970-01-01");
        assert_eq!(civil(20_755), "2026-10-29");
        assert_eq!(civil(11_016), "2000-02-29");
    }
}
