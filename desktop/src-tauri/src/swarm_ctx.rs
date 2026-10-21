//! What the local swarm reads from formal-ast and where its results land, so its work shows on the app's other pages.
//! The AST organizes everything: `script_entries` says which contracts are in scope (deployed or called by script/,
//! with their bases and what they deploy), `audit_json` units are the functions (one plan item each, as on the Proofs
//! page), and `all_slices` is what an agent reads about a function — no listing or grepping of files;
//! proofs are checked by `lake build` in the folder's Lake project and count once the Proofs page's coverage sees a theorem
//! naming the def; findings go into the audit index (audit/README.md) that Bugs reads, with their PoC test.

use formal_ast::{all_slices, analyze_full, audit_json, formal_json, lean, script_entries};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// One function of an entry contract, as the Proofs page's Lean coverage sees it.
#[derive(Clone)]
pub struct Func {
    /// `Contract.name`
    pub name: String,
    /// Its Lean def in the generated model (what a theorem has to name), e.g. `Router.matchBook`.
    pub lean: String,
    pub def: Option<String>,
    /// Why it is opaque in the model, if it is.
    pub why: Option<String>,
    /// Named by a theorem without `sorry`.
    pub proved: bool,
    /// The theorems naming it (file:line name).
    pub theorems: Vec<String>,
    /// The Foundry scripts that call it.
    pub scripts: Vec<String>,
}

pub struct Contract {
    pub name: String,
    pub file: String,
    /// The generated Lean model, folder-relative, when there is one.
    pub model: Option<String>,
    pub functions: Vec<Func>,
    /// audit_json's units (footprint, calls, guards).
    pub units: Vec<Value>,
    /// Each unit's slice (Markdown), by unit name.
    pub slices: std::collections::BTreeMap<String, String>,
}

#[derive(Default)]
pub struct Context {
    pub contracts: Vec<Contract>,
    /// Why something couldn't be read (solc missing, a file that doesn't compile); shown to the planner.
    pub problems: Vec<String>,
}

/// The folder's Lake project: the folder itself, or formal/ in it.
pub fn lake_dir(root: &Path) -> Option<PathBuf> {
    [root.to_path_buf(), root.join("formal")].into_iter().find(|d| d.join("lakefile.toml").exists() || d.join("lakefile.lean").exists())
}

/// The contracts in scope that are deployed (by a script or by another in-scope contract) or called, as (file, name),
/// with `script_entries`' output: each is an entry analyzed on its own; its bases come with it, so a contract in scope
/// only as a base isn't analyzed again.
pub fn in_scope(root: &Path, problems: &mut Vec<String>) -> (Vec<(String, String)>, Value) {
    let scripts = match script_entries(root) {
        Ok(v) => v,
        Err(e) => {
            problems.push(format!("script entry points: {e:#}"));
            json!({})
        }
    };
    let mut files: Vec<(String, String)> = vec![];
    for c in scripts["contracts"].as_array().into_iter().flatten() {
        let base_only = c["via"].as_str().is_some_and(|v| v.starts_with("a base of"));
        if c["inScope"] == true && c["kind"] == "contract" && !base_only {
            if let (Some(name), Some(file)) = (c["name"].as_str(), c["file"].as_str()) {
                files.push((file.to_string(), name.to_string()));
            }
        }
    }
    if files.is_empty() {
        problems.push("no contract under src/ is deployed or called by a script under script/".into());
    }
    (files, scripts)
}

/// Reads the folder through formal-ast: the scripts' entry points, then each entry contract's coverage, units and
/// slices. Writes the generated model into the Lake project when it has none for a contract yet.
pub fn context(root: &Path) -> Context {
    let mut ctx = Context::default();
    let (files, scripts) = in_scope(root, &mut ctx.problems);
    let entry_points: Vec<Value> = scripts["entryPoints"].as_array().cloned().unwrap_or_default();
    let lake = lake_dir(root);
    for (file, contract) in files {
        let (a, output) = match analyze_full(root, &file, Some(&contract)) {
            Ok(x) => x,
            Err(e) => {
                ctx.problems.push(format!("{file}: {e:#}"));
                continue;
            }
        };
        let f = formal_json(&a, &output, 0);
        let name = f["contract"].as_str().unwrap_or("").to_string();
        let theorems: Vec<Value> = f["theorems"].as_array().cloned().unwrap_or_default();
        let functions: Vec<Func> = f["functions"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|x| {
                let by: Vec<&Value> = x["theorems"].as_array().into_iter().flatten().filter_map(|i| i.as_u64().and_then(|i| theorems.get(i as usize))).collect();
                let short = x["name"].as_str().unwrap_or("").rsplit('.').next().unwrap_or("").to_string();
                Func {
                    name: x["name"].as_str().unwrap_or("").to_string(),
                    lean: x["lean"].as_str().unwrap_or("").to_string(),
                    def: x["def"].as_str().map(String::from),
                    why: x["why"].as_str().map(String::from),
                    proved: by.iter().any(|t| t["sorry"] == false),
                    theorems: by.iter().map(|t| format!("{}:{} {}", t["file"].as_str().unwrap_or(""), t["line"], t["name"].as_str().unwrap_or(""))).collect(),
                    scripts: entry_points.iter().filter(|e| e["contract"] == name.as_str() && e["function"] == short.as_str()).flat_map(|e| e["scripts"].as_array().cloned().unwrap_or_default()).filter_map(|s| s.as_str().map(String::from)).collect(),
                }
            })
            .collect();
        // The model the provers write against: formal/Generated/<Contract>.lean, generated here when it is missing.
        let mut model = None;
        if let Some(dir) = &lake {
            let path = dir.join("Generated").join(format!("{name}.lean"));
            if !path.exists() {
                let m = lean::Gen::new(&output, &a.graph, &a.scope).generate(&lean::ident(&name));
                let _ = std::fs::create_dir_all(path.parent().unwrap_or(dir)).and_then(|_| std::fs::write(&path, m.text));
            }
            if path.exists() {
                model = path.strip_prefix(root).ok().map(|p| p.to_string_lossy().replace('\\', "/"));
            }
        }
        let mut units = audit_json(&a, 0)["units"].as_array().cloned().unwrap_or_default();
        // The Proofs page counts every function the model has a def for, not only the entry points: internal and
        // library functions join the plan after them, so the swarm keeps going until each is proved (or blocked).
        // Functions the model leaves opaque ("not modeled") have nothing to prove against and stay out.
        for f in &functions {
            if f.lean.is_empty() || f.why.is_some() || units.iter().any(|u| u["name"].as_str() == Some(f.name.as_str())) {
                continue;
            }
            units.push(json!({ "name": f.name, "mutability": "internal", "writes": [], "guards": 0, "external": 0, "arith": 0, "internal": true }));
        }
        ctx.contracts.push(Contract { name, file, model, functions, units, slices: all_slices(&a) });
    }
    ctx
}

/// One plan item: an external function of an in-scope contract (an `audit_json` unit), with where it stands on the
/// Proofs page.
pub struct Unit<'a> {
    pub contract: &'a Contract,
    pub unit: &'a Value,
    /// Its function in the Lean coverage (None when the model didn't reach it).
    pub func: Option<&'a Func>,
}

impl Unit<'_> {
    pub fn name(&self) -> &str {
        self.unit["name"].as_str().unwrap_or("")
    }

    /// What a theorem has to name: the Lean def, or the unit's name when the model has none.
    pub fn lean(&self) -> &str {
        self.func.map(|f| f.lean.as_str()).filter(|l| !l.is_empty()).unwrap_or_else(|| self.name())
    }

    /// Where it is in the Solidity, from its slice's header (`src/X.sol:12`).
    pub fn at(&self) -> String {
        let re = regex::Regex::new(r"[\w./-]+\.sol:\d+").expect("valid regex");
        self.contract.slices.get(self.name()).and_then(|s| re.find(s).map(|m| m.as_str().to_string())).unwrap_or_else(|| self.contract.file.clone())
    }

    fn list(&self, k: &str) -> String {
        self.unit[k].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")
    }

    /// The plan line: `- [ ] `Lean.def` — Contract (src/X.sol:12): writes [a, b] · guards 2 · external calls 1`.
    pub fn line(&self) -> String {
        let mark = if self.func.is_some_and(|f| f.proved) { 'x' } else { ' ' };
        let u = self.unit;
        let scripts = self.func.map(|f| f.scripts.clone()).unwrap_or_default();
        format!(
            "- [{mark}] `{}` — {} ({}): {} · writes [{}] · guards {} · external calls {}{}",
            self.lean(),
            self.contract.name,
            self.at(),
            u["mutability"].as_str().unwrap_or(""),
            self.list("writes"),
            u["guards"],
            u["external"],
            if scripts.is_empty() { String::new() } else { format!(" · called by {}", scripts.join(", ")) }
        )
    }
}

impl Context {
    /// Every plan item, as the Proofs page lists the functions: the in-scope contracts' units, the ones the Foundry
    /// scripts call first, then the ones that write storage, then the rest, each group simplest first (by the
    /// arithmetic, external calls and guards in its footprint); units the model left opaque are skipped
    /// (nothing can be proved about them against it).
    pub fn units(&self) -> Vec<Unit<'_>> {
        let mut out: Vec<Unit> = vec![];
        for c in &self.contracts {
            for u in &c.units {
                let name = u["name"].as_str().unwrap_or("");
                let func = c.functions.iter().find(|f| f.name == name);
                if func.is_some_and(|f| f.why.is_some()) {
                    continue;
                }
                let unit = Unit { contract: c, unit: u, func };
                // The same inherited function in two contracts' models is one item per contract.
                if !out.iter().any(|x| x.lean() == unit.lean() && x.contract.name == c.name) {
                    out.push(unit);
                }
            }
        }
        let rank = |u: &Unit| {
            let called = u.func.is_some_and(|f| !f.scripts.is_empty());
            let writes = u.unit["writes"].as_array().is_some_and(|w| !w.is_empty()) || u.unit["external"].as_u64().unwrap_or(0) > 0;
            let n = |k: &str| u.unit[k].as_u64().unwrap_or(0);
            let internal = u.unit["internal"] == true;
            (if called { 0 } else if internal { 3 } else if writes { 1 } else { 2 }, n("arith") + 2 * n("external") + n("guards"))
        };
        out.sort_by_key(|u| rank(u));
        out
    }

    /// The plan item a line names: its backticked def, in the contract the line names after the dash.
    pub fn target(&self, text: &str) -> Option<Unit<'_>> {
        let re = regex::Regex::new(r"`([^`]+)`").expect("valid regex");
        let names: Vec<String> = re.captures_iter(text).map(|c| c[1].trim().to_string()).collect();
        let units = self.units();
        let pick = |n: &String| {
            let hits: Vec<usize> = units.iter().enumerate().filter(|(_, u)| u.lean() == n || u.name() == n).map(|(i, _)| i).collect();
            hits.iter().copied().find(|&i| text.contains(&format!("— {} (", units[i].contract.name))).or(hits.first().copied())
        };
        let i = names.iter().find_map(pick)?;
        units.into_iter().nth(i)
    }

    /// Lines for the AST's plan items that `plan` doesn't have yet (matched by def and contract).
    pub fn missing_items(&self, plan: &str) -> Vec<String> {
        let lines: Vec<&str> = plan.lines().filter(|l| l.trim_start().starts_with("- [")).collect();
        self.units()
            .iter()
            .filter(|u| !lines.iter().any(|l| l.contains(&format!("`{}`", u.lean())) && (l.contains(&format!("— {} (", u.contract.name)) || !l.contains(" — "))))
            .map(|u| u.line())
            .collect()
    }

    /// The `functions` tool: every plan item's function, with its place and status.
    pub fn functions(&self) -> String {
        let mut s = String::new();
        for c in &self.contracts {
            s.push_str(&format!("## {} ({}) — Lean model {}\n", c.name, c.file, c.model.as_deref().unwrap_or("(none)")));
            for u in self.units().iter().filter(|u| std::ptr::eq(u.contract, c)) {
                s.push_str(&format!("- {} — {}\n", u.line().trim_start_matches("- "), u.func.map(status).unwrap_or_else(|| "not in the model".into())));
            }
            s.push('\n');
        }
        for p in &self.problems {
            s.push_str(&format!("(couldn't read {p})\n"));
        }
        s
    }

    /// The `function` tool: a function's slice from the AST (its guards, footprint, state and code), by name or def.
    pub fn slice(&self, name: &str) -> Option<String> {
        let short = name.rsplit('.').next().unwrap_or(name);
        for c in &self.contracts {
            if let Some(s) = c.slices.get(name) {
                return Some(s.clone());
            }
            if let Some(f) = c.functions.iter().find(|f| f.lean == name) {
                if let Some(s) = c.slices.get(&f.name) {
                    return Some(s.clone());
                }
            }
            if let Some((_, s)) = c.slices.iter().find(|(k, _)| k.rsplit('.').next() == Some(short) && name.starts_with(&c.name)) {
                return Some(s.clone());
            }
        }
        None
    }

    /// What the prover and the reviewer get for an item: the def, the generated model, the slice.
    pub fn brief(&self, text: &str, lake: Option<&Path>, root: &Path) -> String {
        let Some(u) = self.target(text) else {
            return "This item names no function in scope; prove it in the Lake project and say which file holds it.".into();
        };
        let c = u.contract;
        let lean = u.lean();
        let lib = lake.map(|d| d.strip_prefix(root).unwrap_or(d).to_string_lossy().to_string()).filter(|d| !d.is_empty()).unwrap_or_else(|| ".".into());
        let short = u.name().rsplit('.').next().unwrap_or("").trim_start_matches('_');
        let module = format!("{}{}", c.name, capitalize(short));
        let mut s = format!(
            "## The target\n\n`{}` in {} ({}) — Lean def `{lean}` in the generated model `{}`.\n{}\n\
Prove what its slice says: the conditions under which it reverts (its guards), and on success the storage it writes \
(its footprint) and what it returns or hands to its external calls. \
Write the proof as `{lib}/Refinement/Swarm/{module}.lean` (module `Refinement.Swarm.{module}`), starting with `import Generated.{}` (and `import Refinement.Monad` for its simp lemmas when the project has it). \
Every theorem about the def must spell it fully qualified as `{lean}` in its statement — the Proofs page counts the function as proved only when a theorem without `sorry` names exactly that. \
Check it with `lake build Refinement.Swarm.{module}` (lake runs in {lib}/). The swarm itself re-runs `lake build` and the coverage before your work goes to review.\n",
            u.name(),
            c.name,
            u.at(),
            c.model.as_deref().unwrap_or("(none)"),
            match u.func {
                Some(f) if !f.theorems.is_empty() => format!("Already named by: {}.", f.theorems.join("; ")),
                _ => "No theorem names it yet.".to_string(),
            },
            c.name,
        );
        if let Some(d) = u.func.and_then(|f| f.def.as_ref()) {
            s.push_str(&format!("\n### Its generated def\n\n```lean\n{}\n```\n", d.trim_end()));
        }
        if let Some(sl) = c.slices.get(u.name()) {
            s.push_str(&format!("\n### Its slice (from the AST)\n\n{}\n", crate::executor::clip(sl.clone())));
        }
        s
    }
}

fn status(f: &Func) -> String {
    match (&f.why, f.proved, f.theorems.is_empty()) {
        (Some(why), _, _) => format!("opaque in the model ({why})"),
        (None, true, _) => format!("proved ({} theorem{})", f.theorems.len(), if f.theorems.len() == 1 { "" } else { "s" }),
        (None, false, false) => "named only by theorems with sorry".into(),
        (None, false, true) => "NOT PROVED".into(),
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// A Lean file that cheats: `sorry`, `admit`, a new `axiom`, or `native_decide`.
pub fn cheats(text: &str) -> Option<&'static str> {
    let words: Vec<&str> = text.split(|c: char| !(c.is_alphanumeric() || c == '_')).collect();
    ["sorry", "admit", "axiom", "native_decide"].into_iter().find(|w| words.contains(w))
}

// ---- findings: the audit index Bugs reads ----

pub const REPORT: &str = "formal-mind-swarm.md";

/// The folder's report folder: the first of audit/, audits/, reports/ that exists, else audit/.
pub fn report_dir(root: &Path) -> PathBuf {
    ["audit", "audits", "reports"].iter().map(|d| root.join(d)).find(|d| d.is_dir()).unwrap_or_else(|| root.join("audit"))
}

fn cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ").trim().to_string()
}

/// Files a finding: its section in audit/formal-mind-swarm.md and a row (⏳ Open, the PoC as evidence) in the index,
/// audit/README.md, under the report's heading. Returns the finding's ID and the report's path.
pub fn file_finding(root: &Path, input: &Value, poc: &str, forge: &str) -> Result<(String, String), String> {
    let dir = report_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let index_path = dir.join("README.md");
    let mut index = std::fs::read_to_string(&index_path).unwrap_or_else(|_| "# Audits\n\nSecurity reports and the status of every finding.\n".into());
    let n = regex::Regex::new(r"\|\s*FM-(\d+)\s*\|").expect("valid regex").captures_iter(&index).filter_map(|c| c[1].parse::<u32>().ok()).max().unwrap_or(0) + 1;
    let id = format!("FM-{n:02}");
    let s = |k: &str| input[k].as_str().unwrap_or("").trim().to_string();
    let title = if s("title").is_empty() { "Finding".to_string() } else { s("title") };
    let severity = {
        let v = s("severity");
        let mut c = v.chars();
        c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_else(|| "Medium".into())
    };
    let today = chrono_today();

    // The report: one section per finding.
    let report_path = dir.join(REPORT);
    let mut report = std::fs::read_to_string(&report_path).unwrap_or_else(|_| {
        format!("# Formal Mind swarm findings\n\nFindings from Formal Mind's local swarm (planner, prover, reviewer) while proving this repository's contracts against the Lean model formal-ast generates from solc's AST. Each one has a Foundry PoC under `test/`; their status is kept in [README.md](README.md).\n")
    });
    report.push_str(&format!(
        "\n### [{id}] {title}\n\n**Severity:** {}\n**Location:** `{}`\n**PoC:** `{poc}`\n**Found:** {today}\n\n#### Scenario\n\n{}\n{}\n#### PoC run\n\n`forge test --match-path {poc}`\n\n```\n{}\n```\n",
        severity.to_lowercase(),
        s("location"),
        s("scenario"),
        if s("evidence").is_empty() { String::new() } else { format!("\n#### Evidence\n\n{}\n", s("evidence")) },
        forge.trim()
    ));
    std::fs::write(&report_path, report).map_err(|e| e.to_string())?;

    // The index: the report's section with its table, created on the first finding.
    let row = format!("| {id} | {severity} | {} | ⏳ Open | PoC `{poc}`; `{}` |", cell(&title), cell(&s("location")));
    let heading = format!("## {REPORT}");
    let lines: Vec<String> = index.lines().map(String::from).collect();
    let out = if let Some(h) = lines.iter().position(|l| l.trim() == heading || l.trim() == format!("## [{REPORT}]({REPORT})")) {
        // After the last row of the section's table.
        let mut at = h + 1;
        let mut last_row = None;
        while at < lines.len() && !lines[at].starts_with("## ") {
            if lines[at].trim_start().starts_with('|') {
                last_row = Some(at);
            }
            at += 1;
        }
        let mut l = lines.clone();
        match last_row {
            Some(r) => l.insert(r + 1, row),
            None => {
                l.insert(h + 1, String::new());
                l.insert(h + 2, "| ID | Severity | Finding | Status | Evidence |".into());
                l.insert(h + 3, "|----|----------|---------|--------|----------|".into());
                l.insert(h + 4, row);
            }
        }
        l.join("\n") + "\n"
    } else {
        // List the report in the index's report table too, when it has one.
        let mut l = lines.clone();
        if let Some(head) = l.iter().position(|x| x.trim_start().starts_with("| Report")) {
            let mut end = head + 1;
            while end < l.len() && l[end].trim_start().starts_with('|') {
                end += 1;
            }
            let cols = l[head].matches('|').count().saturating_sub(1);
            let mut cells = vec![format!("[{REPORT}]({REPORT})"), today.clone(), "Formal Mind swarm".into(), "Local swarm: Lean proofs against the generated model".into()];
            cells.resize(cols.max(1), String::new());
            l.insert(end, format!("| {} |", cells.join(" | ")));
        }
        let mut text = l.join("\n").trim_end().to_string();
        text.push_str(&format!("\n\n{heading}\n\n| ID | Severity | Finding | Status | Evidence |\n|----|----------|---------|--------|----------|\n{row}\n"));
        text
    };
    index = out;
    std::fs::write(&index_path, index).map_err(|e| e.to_string())?;
    // And in Formal Mind's own audit file, as the report states it.
    record_internal_finding(root, &id, input, &poc)?;
    let rel = |p: &Path| p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/");
    Ok((id, rel(&report_path)))
}

/// Today as YYYY-MM-DD (UTC), without a date crate.
pub fn chrono_today() -> String {
    let days = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64;
    // Civil from days (Howard Hinnant).
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn findings_land_in_the_index() {
        let root = std::env::temp_dir().join(format!("fm-find-{}", std::process::id()));
        std::fs::create_dir_all(root.join("audit")).unwrap();
        std::fs::write(root.join("audit/README.md"), "# Audits\n\n| Report | Date | Author | Scope |\n|---|---|---|---|\n| [a.md](a.md) | 2026-01-01 | X | All |\n\n## a.md\n\n| ID | Severity | Finding | Status | Evidence |\n|----|---|---|---|---|\n| H-01 | High | x | ✅ Fixed | `test/A.t.sol` |\n").unwrap();
        let input = json!({ "title": "Fee | rounding", "severity": "high", "location": "src/R.sol:10", "scenario": "s" });
        let (id, report) = file_finding(&root, &input, "test/formal/Fee.t.sol", "exit 0").unwrap();
        assert_eq!((id.as_str(), report.as_str()), ("FM-01", "audit/formal-mind-swarm.md"));
        let (id2, _) = file_finding(&root, &input, "test/formal/Fee2.t.sol", "exit 0").unwrap();
        assert_eq!(id2, "FM-02");
        let index = std::fs::read_to_string(root.join("audit/README.md")).unwrap();
        assert!(index.contains("| [formal-mind-swarm.md](formal-mind-swarm.md) |"));
        let section = index.split("## formal-mind-swarm.md").nth(1).unwrap();
        assert!(section.contains("| FM-01 | High | Fee \\| rounding | ⏳ Open | PoC `test/formal/Fee.t.sol`"));
        assert!(section.find("FM-01").unwrap() < section.find("FM-02").unwrap());
        let report = std::fs::read_to_string(root.join("audit/formal-mind-swarm.md")).unwrap();
        assert!(report.contains("### [FM-02] Fee | rounding"));
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The planner's digest and a prover's brief for a real folder: `FM_FOLDER=… cargo test -- --ignored digest --nocapture`.
    #[test]
    #[ignore]
    fn digest_of_a_folder() {
        let root = PathBuf::from(std::env::var("FM_FOLDER").unwrap());
        let ctx = context(&root);
        println!("{}", ctx.functions());
        for l in ctx.missing_items("") {
            println!("{l}");
        }
        let item = std::env::var("FM_ITEM").unwrap_or("- [ ] `Router.matchBook` — Router (src/Router.sol)".into());
        println!("---\n{}", ctx.brief(&item, lake_dir(&root).as_deref(), &root));
    }

    #[test]
    fn cheating_is_seen() {
        assert_eq!(cheats("theorem a : True := by sorry"), Some("sorry"));
        assert_eq!(cheats("theorem sorryless : True := trivial"), None);
        assert_eq!(cheats("axiom x : False"), Some("axiom"));
    }
}

/// Where a report's findings are kept in the standard format (`formalmind.audit/v1`, docs/audit-format.md): next to
/// the report, `<name>.audit.json` (`audits/Spearbit.pdf` → `audits/Spearbit.audit.json`).
pub fn audit_json_path(root: &Path, report: &str) -> PathBuf {
    let p = root.join(report);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "report".into());
    p.with_file_name(format!("{stem}.audit.json"))
}

fn load_audit(path: &Path, report: &str) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| v["schema"] == "formalmind.audit/v1")
        .unwrap_or_else(|| json!({ "schema": "formalmind.audit/v1", "kind": "external", "title": "", "source": report, "findings": [] }))
}

fn save_audit(root: &Path, path: &Path, doc: &Value) -> Result<String, String> {
    let text = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    std::fs::write(path, text + "\n").map_err(|e| e.to_string())?;
    Ok(path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/"))
}

/// The report's own facts (title, auditor, date, commit, scope…), merged into its `.audit.json`.
pub fn record_report(root: &Path, report: &str, input: &Value) -> Result<String, String> {
    let path = audit_json_path(root, report);
    let mut doc = load_audit(&path, report);
    for k in ["title", "auditor", "authors", "date", "commit", "repository", "scope", "summary", "kind"] {
        if !input[k].is_null() {
            doc[k] = input[k].clone();
        }
    }
    doc["source"] = json!(report);
    save_audit(root, &path, &doc)
}

/// One finding in the standard format, added to the report's `.audit.json` or replacing the same ID's entry.
pub fn record_finding_json(root: &Path, report: &str, input: &Value) -> Result<String, String> {
    let id = input["id"].as_str().unwrap_or("").trim().to_string();
    if id.is_empty() {
        return Err("id is required (the report's own ID for the finding, e.g. H-01)".into());
    }
    let path = audit_json_path(root, report);
    let mut doc = load_audit(&path, report);
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
        f["status"] = json!(match s.trim().to_ascii_lowercase().as_str() {
            "fixed" => "fixed",
            "works as expected" | "works-as-expected" | "intended" => "works as expected",
            "acknowledged" => "acknowledged",
            "rejected" | "invalid" => "rejected",
            _ => "open",
        });
    }
    let list = doc["findings"].as_array_mut().ok_or("bad audit file")?;
    match list.iter_mut().find(|x| x["id"].as_str() == Some(id.as_str())) {
        Some(x) => *x = f,
        None => list.push(f),
    }
    save_audit(root, &path, &doc)
}

#[cfg(test)]
mod audit_json_tests {
    use super::{audit_json_path, record_finding_json, record_report};
    use serde_json::json;

    #[test]
    fn findings_land_in_the_standard_file() {
        let dir = std::env::temp_dir().join(format!("fm-audit-json-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("docs/audits")).unwrap();
        let r = "docs/audits/Spearbit core.pdf";
        assert!(audit_json_path(&dir, r).ends_with("docs/audits/Spearbit core.audit.json"));
        record_report(&dir, r, &json!({ "title": "Uniswap v4-core Security Review", "auditor": "Spearbit", "date": "2024-05-01" })).unwrap();
        record_finding_json(&dir, r, &json!({ "id": "H-1", "title": "A", "severity": "High", "status": "Open", "description": "d" })).unwrap();
        let p = record_finding_json(&dir, r, &json!({ "id": "H-1", "title": "A", "severity": "high", "status": "fixed", "description": "d2", "locations": [{ "file": "src/X.sol", "line": 3 }] })).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(p)).unwrap()).unwrap();
        assert_eq!(doc["schema"], "formalmind.audit/v1");
        assert_eq!(doc["auditor"], "Spearbit");
        assert_eq!(doc["source"], r);
        assert_eq!(doc["findings"].as_array().unwrap().len(), 1);
        assert_eq!(doc["findings"][0]["status"], "fixed");
        assert_eq!(doc["findings"][0]["severity"], "high");
        assert_eq!(doc["findings"][0]["locations"][0]["line"], 3);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ---- Formal Mind's own audit: the file its report is generated from ----

/// Formal Mind's audit of the folder in the standard format (`formalmind.audit/v1`, kind internal), in the report
/// folder. The swarm writes its findings and reviewed properties here as it goes; Generate report adds the coverage
/// and renders it.
pub const INTERNAL: &str = "formal-mind.audit.json";

pub fn internal_path(root: &Path) -> PathBuf {
    report_dir(root).join(INTERNAL)
}

pub(crate) fn update_internal(root: &Path, f: impl FnOnce(&mut Value)) -> Result<String, String> {
    let path = internal_path(root);
    std::fs::create_dir_all(path.parent().unwrap_or(root)).map_err(|e| e.to_string())?;
    let mut doc = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| v["schema"] == "formalmind.audit/v1")
        .unwrap_or_else(|| json!({ "schema": "formalmind.audit/v1", "kind": "internal", "title": "", "auditor": "Formal Mind", "findings": [] }));
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

/// `src/Router.sol:120` (or `src/Router.sol`) as `{ file, line }`.
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

/// A bug the swarm reported, in Formal Mind's audit file: open, with its PoC, in the report's words.
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

/// A property the reviewer approved, in Formal Mind's audit file: `P-<plan item>`, the function, what holds and under
/// which assumptions (the reviewer's words), the theorems that prove it and the proof's files.
pub fn record_property(root: &Path, item: usize, item_text: &str, files: &[String], input: &Value) -> Result<String, String> {
    let statement = input["statement"].as_str().unwrap_or("").trim();
    if statement.is_empty() {
        return Err("statement is required: what the proof establishes".into());
    }
    let assumptions = input["assumptions"].as_str().unwrap_or("").trim();
    let description = if assumptions.is_empty() { statement.to_string() } else { format!("{statement}\n\n**Assumptions.** {assumptions}") };
    let mut p = json!({
        "id": format!("P-{item:02}"),
        "title": item_text.split('`').nth(1).unwrap_or(item_text).to_string(),
        "status": "verified",
        "description": description,
        "theorems": input["theorems"].as_array().into_iter().flatten().filter_map(|t| t.as_str()).map(|t| json!({ "name": t })).collect::<Vec<_>>(),
        "files": files,
    });
    if let Some(c) = regex::Regex::new(r"\(((?:src|contracts)/[^):\s]+):(\d+)\)").expect("valid regex").captures(item_text) {
        p["locations"] = json!([{ "file": &c[1], "line": c[2].parse::<u64>().unwrap_or(0) }]);
    }
    update_internal(root, |doc| upsert(doc, "properties", p))
}

#[cfg(test)]
mod internal_tests {
    use super::*;

    #[test]
    fn the_swarm_writes_its_own_audit() {
        let root = std::env::temp_dir().join(format!("fm-internal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("audit")).unwrap();
        let bug = json!({ "title": "Fill drains", "severity": "high", "location": "src/R.sol:12", "scenario": "Anyone fills.", "impact": "Funds lost.", "recommendation": "Guard it.", "poc": "test/formal/F.t.sol" });
        let (id, _) = file_finding(&root, &bug, "test/formal/F.t.sol", "exit 0").unwrap();
        let item = "`Router.swap` — Router (src/Router.sol:113): payable";
        let p = json!({ "statement": "It reverts unless the caller owns the order.", "assumptions": "`ext.get` returns what `ext.set` wrote.", "theorems": ["swap_owner"] });
        record_property(&root, 4, item, &["formal/Refinement/Swarm/RouterSwap.lean".into()], &p).unwrap();
        // Approving again replaces it.
        record_property(&root, 4, item, &[], &p).unwrap();
        assert!(record_property(&root, 5, item, &[], &json!({})).is_err());
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(internal_path(&root)).unwrap()).unwrap();
        assert_eq!((doc["kind"].as_str(), doc["findings"][0]["id"].as_str()), (Some("internal"), Some(id.as_str())));
        let f = &doc["findings"][0];
        assert_eq!((f["status"].as_str(), f["impact"].as_str(), f["recommendation"].as_str()), (Some("open"), Some("Funds lost."), Some("Guard it.")));
        assert_eq!(f["locations"][0], json!({ "file": "src/R.sol", "line": 12 }));
        let props = doc["properties"].as_array().unwrap();
        assert_eq!(props.len(), 1);
        assert_eq!((props[0]["id"].as_str(), props[0]["title"].as_str()), (Some("P-04"), Some("Router.swap")));
        assert_eq!(props[0]["locations"][0], json!({ "file": "src/Router.sol", "line": 113 }));
        assert!(props[0]["description"].as_str().unwrap().ends_with("**Assumptions.** `ext.get` returns what `ext.set` wrote."));
        assert_eq!(props[0]["theorems"][0]["name"], "swap_owner");
        let _ = std::fs::remove_dir_all(&root);
    }
}

// ---- the rebuild cycle: the protocol rebuilt from the proofs alone, compared with the draft ----
//
// The rebuilder writes `rebuild/` (its own Foundry project) from the Lake project alone: the spec, the generated model
// and the refinement theorems. It never reads the draft (`src/`, `test/`, `script/`); its tools refuse to. The editor
// then holds the draft and the rebuild side by side and classifies every difference as a gap, an improvement, a
// divergence or a bug. The cycle's state (number, phase, each contract's progress, the maintainer's decisions) is
// `.formal/cycle.json`; the differences are the `rebuild` section of Formal Mind's audit file, which Bugs and the
// report show.

pub const REBUILD_DIR: &str = "rebuild";

#[derive(serde::Serialize, serde::Deserialize, Clone, Default, Debug, PartialEq)]
pub struct CycleContract {
    pub name: String,
    /// The draft's file (for the editor; the rebuilder is never told).
    #[serde(default)]
    pub draft: String,
    /// "queued" (to rebuild) | "rebuilt" (to compare) | "polish" (sent back to the rebuilder) | "agreed" (no open
    /// difference) | "compared" (compared; differences wait on the maintainer or the spec) | "blocked"
    pub state: String,
    /// Polish rounds so far in this cycle.
    #[serde(default)]
    pub polish: u32,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default, Debug)]
pub struct Cycle {
    /// The cycle's number, from 1; 0 before the first.
    #[serde(default)]
    pub n: u32,
    /// "rebuild" | "compare" | "polish" | "close" | "rest"
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub contracts: Vec<CycleContract>,
    /// What the maintainer decided, through the assistant: `{ id, contract, decision, at }`.
    #[serde(default)]
    pub decisions: Vec<Value>,
    /// Proved plan items when the cycle started: a later cycle starts only once more are proved.
    #[serde(default)]
    pub proved: usize,
    /// Each closed cycle's summary: `{ n, closed, summary, confidence }`.
    #[serde(default)]
    pub history: Vec<Value>,
}

impl Cycle {
    /// The phase the contracts' states put the cycle in.
    pub fn phase_now(&self) -> &'static str {
        let any = |s: &str| self.contracts.iter().any(|c| c.state == s);
        if self.contracts.is_empty() {
            "rest"
        } else if any("queued") {
            "rebuild"
        } else if any("polish") {
            "polish"
        } else if any("rebuilt") {
            "compare"
        } else if self.phase == "rest" {
            "rest"
        } else {
            "close"
        }
    }

    pub fn contract_mut(&mut self, name: &str) -> Option<&mut CycleContract> {
        self.contracts.iter_mut().find(|c| c.name == name)
    }
}

pub fn cycle_path(root: &Path) -> PathBuf {
    root.join(".formal").join("cycle.json")
}

pub fn load_cycle(root: &Path) -> Cycle {
    std::fs::read_to_string(cycle_path(root)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save_cycle(root: &Path, c: &Cycle) {
    let path = cycle_path(root);
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(root));
    let _ = std::fs::write(&path, serde_json::to_string_pretty(c).unwrap_or_default() + "\n");
}

/// Queues `contracts` (name, draft file) for rebuilding: into the running cycle, or a new one when the last has
/// closed. Returns the names newly queued (the ones already in the running cycle are left as they are).
pub fn start_cycle(root: &Path, contracts: &[(String, String)], proved: usize) -> (Cycle, Vec<String>) {
    let mut c = load_cycle(root);
    if c.n == 0 || c.phase == "rest" {
        c.n += 1;
        c.contracts.clear();
        c.proved = proved;
    }
    let mut queued = vec![];
    for (name, draft) in contracts {
        if c.contracts.iter().any(|x| &x.name == name) {
            continue;
        }
        c.contracts.push(CycleContract { name: name.clone(), draft: draft.clone(), state: "queued".into(), polish: 0 });
        queued.push(name.clone());
    }
    c.phase = c.phase_now().into();
    save_cycle(root, &c);
    (c, queued)
}

/// A path relative to the folder, `/`-separated, after resolving symlinks where it exists.
fn rel_real(root: &Path, p: &Path) -> String {
    // The nearest part that exists, resolved, and the rest as written.
    let base_of = p.ancestors().find(|a| a.exists()).unwrap_or(root);
    let rest = p.strip_prefix(base_of).unwrap_or(Path::new(""));
    let real = base_of.canonicalize().map(|b| b.join(rest)).unwrap_or_else(|_| p.to_path_buf());
    let base = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    real.strip_prefix(&base).unwrap_or(&real).to_string_lossy().replace('\\', "/")
}

/// What the rebuilder may read: the Lake project (the spec, the generated model, the refinement theorems), the rebuild
/// itself, and third-party dependencies (interfaces such as v4-core's). Never the draft: `src/`, `test/`, `script/`
/// or anything else in the folder.
pub fn rebuild_may_read(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = crate::executor::inside(root, rel)?;
    let r = rel_real(root, &p);
    let lake = lake_dir(root).map(|d| rel_real(root, &d)).unwrap_or_default();
    let under = |dir: &str| !dir.is_empty() && (r == dir || r.starts_with(&format!("{dir}/")));
    let draft = ["src", "test", "script", "contracts"].iter().any(|d| under(d));
    let ok = !draft && (under(REBUILD_DIR) || under("dependencies") || under("lib") || under(&lake) || r.ends_with(".lean") || r == "FORMAL_MIND.md");
    if ok {
        Ok(p)
    } else {
        Err(format!("{rel} is not yours to read: the rebuild comes from the proofs alone (the Lake project {}/, rebuild/ and dependencies/)", if lake.is_empty() { "." } else { &lake }))
    }
}

/// What the rebuilder may write: its own files under rebuild/ (the Foundry setup there is the swarm's).
pub fn rebuild_may_write(root: &Path, rel: &str) -> Result<(), String> {
    let p = crate::executor::inside(root, rel)?;
    let r = p.strip_prefix(root).map(|x| x.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    if !r.starts_with(&format!("{REBUILD_DIR}/")) {
        return Err(format!("{rel}: the rebuilder writes only under {REBUILD_DIR}/"));
    }
    if ["rebuild/foundry.toml", "rebuild/remappings.txt"].contains(&r.as_str()) || r.starts_with("rebuild/out/") || r.starts_with("rebuild/cache/") {
        return Err(format!("{r} is the swarm's (it keeps the rebuild's Foundry setup)"));
    }
    if p.exists() && !rel_real(root, &p).starts_with(&format!("{REBUILD_DIR}/")) {
        return Err(format!("{rel} leads out of {REBUILD_DIR}/"));
    }
    Ok(())
}

/// What the rebuilder may run: forge in the rebuild's own project (`--root rebuild`), which never compiles the draft.
pub fn rebuild_may_run(command: &str) -> Result<(), String> {
    let argv: Vec<&str> = command.split_whitespace().collect();
    let rooted = argv.windows(2).any(|w| w[0] == "--root" && w[1].trim_end_matches('/') == REBUILD_DIR) || argv.iter().any(|a| a.trim_end_matches('/') == "--root=rebuild");
    let bad = argv.iter().find(|a| a.contains("..") || a.starts_with('/') || ["--contracts", "--lib-paths", "--remappings", "--config-path", "-C"].iter().any(|f| a.starts_with(f)));
    match (argv.as_slice(), rooted, bad) {
        (["forge", "build" | "test", ..], true, None) => Ok(()),
        (_, _, Some(b)) => Err(format!("`{b}` isn't allowed here: the rebuild is built on its own, with `--root rebuild`")),
        _ => Err("The rebuilder runs only `forge build --root rebuild [args]` and `forge test --root rebuild [args]`".into()),
    }
}

/// Sets up rebuild/ as a Foundry project of its own: the folder's compiler settings, and remappings to the folder's
/// dependencies only (a remapping into the draft, like `@app/=src/`, is left out).
pub fn prepare_rebuild(root: &Path) -> Result<(), String> {
    let dir = root.join(REBUILD_DIR);
    for d in ["src", "test"] {
        std::fs::create_dir_all(dir.join(d)).map_err(|e| e.to_string())?;
    }
    let toml = std::fs::read_to_string(root.join("foundry.toml")).unwrap_or_default();
    let keep = regex::Regex::new(r"(?m)^\s*(solc_version|solc|evm_version|optimizer|optimizer_runs|via_ir)\s*=.*$").expect("valid regex");
    let mut settings: Vec<String> = vec![];
    for m in keep.find_iter(&toml) {
        let line = m.as_str().trim().to_string();
        let key = line.split('=').next().unwrap_or("").trim().to_string();
        if !settings.iter().any(|s| s.split('=').next().unwrap_or("").trim() == key) {
            settings.push(line);
        }
    }
    let libs: Vec<String> = ["dependencies", "lib"].iter().filter(|d| root.join(d).is_dir()).map(|d| format!("\"../{d}\"")).collect();
    let out = format!(
        "# Written by Formal Mind: the rebuild is a Foundry project of its own, so `forge --root rebuild` never compiles the draft.\n[profile.default]\nsrc = \"src\"\ntest = \"test\"\nout = \"out\"\nlibs = [{}]\n{}\n",
        libs.join(", "),
        settings.join("\n")
    );
    std::fs::write(dir.join("foundry.toml"), out).map_err(|e| e.to_string())?;
    let remaps = std::fs::read_to_string(root.join("remappings.txt")).unwrap_or_default();
    let mapped: Vec<String> = remaps
        .lines()
        .filter_map(|l| {
            let (from, to) = l.trim().split_once('=')?;
            let to = to.trim().trim_start_matches("./");
            (to.starts_with("dependencies/") || to.starts_with("lib/")).then(|| format!("{}=../{to}", from.trim()))
        })
        .collect();
    std::fs::write(dir.join("remappings.txt"), mapped.join("\n") + "\n").map_err(|e| e.to_string())?;
    if !dir.join(".gitignore").exists() {
        std::fs::write(dir.join(".gitignore"), "out/\ncache/\n").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The rebuild's Solidity files (sources and tests), folder-relative.
pub fn rebuild_files(root: &Path) -> Vec<String> {
    crate::executor::list_files(root, REBUILD_DIR).map(|l| l.lines().filter(|f| f.ends_with(".sol")).map(String::from).collect()).unwrap_or_default()
}

/// An import in the rebuild that leads out of it (a relative path past rebuild/, or an absolute one): the rebuild must
/// stand on the proofs and its dependencies, never on the draft's code.
pub fn rebuild_escape(root: &Path) -> Option<String> {
    let re = regex::Regex::new(r#"import\s+(?:[^"';]*\s+from\s+)?["']([^"']+)["']"#).expect("valid regex");
    for f in rebuild_files(root) {
        let text = std::fs::read_to_string(root.join(&f)).unwrap_or_default();
        for c in re.captures_iter(&text) {
            let path = &c[1];
            if path.starts_with('/') {
                return Some(format!("{f} imports {path}"));
            }
            if path.starts_with('.') {
                // Resolved by hand: the dir of the file, then each part.
                let mut parts: Vec<&str> = f.split('/').collect();
                parts.pop();
                for seg in path.split('/') {
                    match seg {
                        "." | "" => {}
                        ".." => {
                            parts.pop();
                        }
                        s => parts.push(s),
                    }
                }
                if parts.first() != Some(&REBUILD_DIR) {
                    return Some(format!("{f} imports {path}, outside {REBUILD_DIR}/"));
                }
            }
        }
    }
    None
}

/// The rebuild's own list of what the proofs left open: the bullets under the README's "What the proofs did not
/// determine" heading.
pub fn undetermined(root: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(root.join(REBUILD_DIR).join("README.md")).ok()?;
    let mut lines = text.lines().skip_while(|l| !(l.starts_with('#') && l.to_ascii_lowercase().contains("did not determine")));
    lines.next()?;
    Some(lines.take_while(|l| !l.starts_with('#')).filter_map(|l| l.trim_start().strip_prefix("- ").or_else(|| l.trim_start().strip_prefix("* "))).map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

/// The internal audit as it is now (empty when there is none).
pub fn internal_doc(root: &Path) -> Value {
    std::fs::read_to_string(internal_path(root)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v["schema"] == "formalmind.audit/v1").unwrap_or_else(|| json!({}))
}

/// The differences the editor recorded, every cycle's.
pub fn differences(root: &Path) -> Vec<Value> {
    internal_doc(root)["rebuild"]["differences"].as_array().cloned().unwrap_or_default()
}

pub const CLASSES: [&str; 4] = ["gap", "improvement", "divergence", "bug"];
/// "open" (found) | "asked" (a question with the maintainer) | "fixing" (sent to the rebuilder) | "decided" (the
/// maintainer answered) | "closed" (resolved: the rebuild or the spec now agrees, or nothing is left to do)
pub const DIFF_STATUSES: [&str; 5] = ["open", "asked", "fixing", "decided", "closed"];

/// Writes the cycle's state into the audit file's `rebuild` section: the cycle, its phase, each contract with its
/// rebuild files and what the proofs left open, and (once closed) the summary.
pub fn sync_rebuild(root: &Path, c: &Cycle) -> Result<String, String> {
    let files = rebuild_files(root);
    let open = undetermined(root).unwrap_or_default();
    update_internal(root, |doc| {
        if !doc["rebuild"].is_object() {
            doc["rebuild"] = json!({ "differences": [] });
        }
        let r = &mut doc["rebuild"];
        r["cycle"] = json!(c.n);
        r["phase"] = json!(c.phase);
        r["contracts"] = json!(c
            .contracts
            .iter()
            .map(|k| {
                let re = regex::Regex::new(&format!(r"\b(contract|library|interface)\s+{}\b", regex::escape(&k.name))).expect("valid regex");
                let own: Vec<&String> = files.iter().filter(|f| f.starts_with("rebuild/src/") && std::fs::read_to_string(root.join(f)).is_ok_and(|t| re.is_match(&t))).collect();
                json!({ "contract": k.name, "draft": k.draft, "rebuild": own, "state": k.state })
            })
            .collect::<Vec<_>>());
        r["tests"] = json!(files.iter().filter(|f| f.starts_with("rebuild/test/")).collect::<Vec<_>>());
        r["undetermined"] = json!(open);
        if let Some(h) = c.history.last().filter(|h| h["n"] == c.n) {
            r["summary"] = h["summary"].clone();
            r["confidence"] = h["confidence"].clone();
        }
    })
}

/// One difference the editor found (or an update to one, by id): its class, what differs, where in the draft and in
/// the rebuild, the Lean it bears on, and what follows from its class (a fix for the rebuild, a question for the
/// maintainer, or the finding a bug was filed as). Returns the difference as recorded.
pub fn record_difference(root: &Path, cycle: u32, contract: &str, input: &Value) -> Result<Value, String> {
    let s = |k: &str| input[k].as_str().unwrap_or("").trim().to_string();
    let doc = internal_doc(root);
    let all = doc["rebuild"]["differences"].as_array().cloned().unwrap_or_default();
    let earlier = (!s("id").is_empty()).then(|| all.iter().find(|d| d["id"].as_str() == Some(s("id").as_str())).cloned()).flatten();
    if !s("id").is_empty() && earlier.is_none() {
        return Err(format!("no difference {}; leave id out to record a new one", s("id")));
    }
    let mut d = earlier.clone().unwrap_or_else(|| {
        let n = all.iter().filter_map(|d| d["id"].as_str()?.strip_prefix("D-")?.parse::<u32>().ok()).max().unwrap_or(0) + 1;
        json!({ "id": format!("D-{n:02}"), "cycle": cycle, "contract": contract, "status": "open" })
    });
    for k in ["class", "title", "description", "theorem", "fix", "question", "recommendation", "finding", "status"] {
        if !s(k).is_empty() {
            d[k] = json!(if k == "class" || k == "status" { s(k).to_ascii_lowercase() } else { s(k) });
        }
    }
    for (k, side) in [("draft", "draft"), ("rebuild", "rebuild")] {
        if let Some(l) = location_of(&s(k)) {
            d[side] = json!([l]);
        }
    }
    let class = d["class"].as_str().unwrap_or("").to_string();
    if !CLASSES.contains(&class.as_str()) {
        return Err("class must be gap, improvement, divergence or bug".into());
    }
    if d["title"].as_str().is_none_or(|t| t.trim().is_empty()) || d["description"].as_str().is_none_or(|t| t.trim().is_empty()) {
        return Err("title and description are required".into());
    }
    let status = d["status"].as_str().unwrap_or("open").to_string();
    if !DIFF_STATUSES.contains(&status.as_str()) {
        return Err(format!("status must be one of {}", DIFF_STATUSES.join(", ")));
    }
    let has = |k: &str| d[k].as_str().is_some_and(|t| !t.trim().is_empty());
    if status != "closed" {
        match class.as_str() {
            "gap" if !has("fix") => return Err("a gap needs `fix`: what the rebuild should do, in your words, citing the Lean it should satisfy (never the draft's code), and `theorem`: the theorem the spec is missing".into()),
            "improvement" | "divergence" if !has("question") && status != "decided" => return Err("an improvement or a divergence needs `question`: one question for the maintainer, answerable in a line, your recommendation first".into()),
            "bug" if !has("finding") && !has("fix") => return Err("a bug in the draft is filed with report_bug first (with its PoC): pass its id as `finding`; a bug in the rebuild needs `fix`".into()),
            _ => {}
        }
    }
    if let Some(f) = d["finding"].as_str().filter(|f| !f.is_empty()) {
        if !doc["findings"].as_array().is_some_and(|l| l.iter().any(|x| x["id"].as_str() == Some(f))) {
            return Err(format!("no finding {f} in Formal Mind's audit file; file it with report_bug first"));
        }
    }
    // A question goes to the maintainer once.
    if earlier.is_none() && matches!(class.as_str(), "improvement" | "divergence") && status == "open" {
        d["status"] = json!("asked");
    }
    let out = d.clone();
    update_internal(root, |doc| {
        if !doc["rebuild"].is_object() {
            doc["rebuild"] = json!({ "differences": [] });
        }
        upsert(&mut doc["rebuild"], "differences", d);
    })?;
    Ok(out)
}

/// Changes one difference in place (a decision, a status the swarm moves it to).
pub fn update_difference(root: &Path, id: &str, f: impl FnOnce(&mut Value)) -> Result<Value, String> {
    let mut found = None;
    update_internal(root, |doc| {
        if let Some(d) = doc["rebuild"]["differences"].as_array_mut().and_then(|l| l.iter_mut().find(|d| d["id"].as_str() == Some(id))) {
            f(d);
            found = Some(d.clone());
        }
    })?;
    found.ok_or_else(|| format!("no difference {id}"))
}

/// How sure the cycle is, as the rebuild cycle states it: low while a gap or a bug is open, medium once draft and
/// rebuild agree (the rebuild's own spec, S′, isn't written by the local swarm yet).
pub fn confidence(diffs: &[Value], n: u32) -> &'static str {
    let open = diffs.iter().filter(|d| d["cycle"] == n).any(|d| matches!(d["class"].as_str(), Some("gap" | "bug")) && !matches!(d["status"].as_str(), Some("closed" | "decided")));
    if open { "low" } else { "medium" }
}

/// The cycle's close summary: the differences found by class and where they stand.
pub fn cycle_summary(diffs: &[Value], c: &Cycle) -> String {
    let of: Vec<&Value> = diffs.iter().filter(|d| d["cycle"] == c.n).collect();
    let count = |class: &str| of.iter().filter(|d| d["class"] == class).count();
    let closed = of.iter().filter(|d| matches!(d["status"].as_str(), Some("closed" | "decided"))).count();
    let waiting = of.iter().filter(|d| d["status"] == "asked").count();
    let names: Vec<&str> = c.contracts.iter().map(|k| k.name.as_str()).collect();
    format!(
        "Cycle {} rebuilt {} from the proofs and compared {} with the draft: {} difference{} ({} gap{}, {} improvement{}, {} divergence{}, {} bug{}); {closed} resolved, {waiting} waiting on the maintainer.",
        c.n,
        names.join(", "),
        if names.len() == 1 { "it" } else { "them" },
        of.len(),
        if of.len() == 1 { "" } else { "s" },
        count("gap"),
        if count("gap") == 1 { "" } else { "s" },
        count("improvement"),
        if count("improvement") == 1 { "" } else { "s" },
        count("divergence"),
        if count("divergence") == 1 { "" } else { "s" },
        count("bug"),
        if count("bug") == 1 { "" } else { "s" },
    )
}

#[cfg(test)]
mod cycle_tests {
    use super::*;

    fn folder(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("fm-cycle-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["src", "test", "formal/Generated", "dependencies/v4-core/src", "audit"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::write(root.join("formal/lakefile.toml"), "name = \"Formal\"\n").unwrap();
        std::fs::write(root.join("formal/Generated/Vault.lean"), "def Vault.collect := 1\n").unwrap();
        std::fs::write(root.join("src/Vault.sol"), "contract Vault {}\n").unwrap();
        std::fs::write(root.join("foundry.toml"), "[profile.default]\nsrc = \"src\"\nsolc_version = \"0.8.26\"\noptimizer = true\n").unwrap();
        std::fs::write(root.join("remappings.txt"), "@app/=src/\nv4-core/=dependencies/v4-core/src\nforge-std/=lib/forge-std/src/\n").unwrap();
        root
    }

    #[test]
    fn the_rebuilder_never_sees_the_draft() {
        let root = folder("read");
        assert!(rebuild_may_read(&root, "formal/Generated/Vault.lean").is_ok());
        assert!(rebuild_may_read(&root, "formal").is_ok());
        assert!(rebuild_may_read(&root, "dependencies/v4-core/src").is_ok());
        assert!(rebuild_may_read(&root, "rebuild/src/Vault.sol").is_ok());
        for bad in ["src/Vault.sol", "./src/Vault.sol", "test/X.t.sol", "script/Deploy.s.sol", "foundry.toml", "formal/../src/Vault.sol", "audit/README.md"] {
            assert!(rebuild_may_read(&root, bad).is_err(), "{bad}");
        }
        // A symlink in the rebuild that points at the draft leads nowhere.
        std::fs::create_dir_all(root.join("rebuild")).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("src"), root.join("rebuild/draft")).unwrap();
            assert!(rebuild_may_read(&root, "rebuild/draft/Vault.sol").is_err());
            assert!(rebuild_may_write(&root, "rebuild/draft/Vault.sol").is_err());
        }
        assert!(rebuild_may_write(&root, "rebuild/src/Vault.sol").is_ok());
        assert!(rebuild_may_write(&root, "rebuild/foundry.toml").is_err());
        assert!(rebuild_may_write(&root, "src/Vault.sol").is_err());
        assert!(rebuild_may_write(&root, "formal/Spec.lean").is_err());
        assert!(rebuild_may_run("forge test --root rebuild -vv").is_ok());
        assert!(rebuild_may_run("forge build --sizes --root=rebuild").is_ok());
        assert!(rebuild_may_run("forge build").is_err());
        assert!(rebuild_may_run("forge test --root rebuild --match-path ../test/X.t.sol").is_err());
        assert!(rebuild_may_run("forge build --root rebuild --contracts src").is_err());
        assert!(rebuild_may_run("lake build").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_rebuild_is_its_own_project() {
        let root = folder("prep");
        prepare_rebuild(&root).unwrap();
        let toml = std::fs::read_to_string(root.join("rebuild/foundry.toml")).unwrap();
        assert!(toml.contains("libs = [\"../dependencies\"]") && toml.contains("solc_version = \"0.8.26\"") && toml.contains("optimizer = true"));
        let remaps = std::fs::read_to_string(root.join("rebuild/remappings.txt")).unwrap();
        assert_eq!(remaps, "v4-core/=../dependencies/v4-core/src\nforge-std/=../lib/forge-std/src/\n");
        std::fs::write(root.join("rebuild/src/Vault.sol"), "import {X} from \"v4-core/X.sol\";\nimport \"./Lib.sol\";\ncontract Vault {}\n").unwrap();
        assert_eq!(rebuild_escape(&root), None);
        std::fs::write(root.join("rebuild/src/Vault.sol"), "import {Vault as V} from \"../../src/Vault.sol\";\n").unwrap();
        assert!(rebuild_escape(&root).unwrap().contains("outside rebuild/"));
        std::fs::write(root.join("rebuild/README.md"), "# Rebuild\n\n## What the proofs did not determine\n\n- The event names.\n- Who may call `sweep`.\n\n## Tests\n- x\n").unwrap();
        assert_eq!(undetermined(&root).unwrap(), vec!["The event names.", "Who may call `sweep`."]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn differences_are_classified_into_the_audit() {
        let root = folder("diff");
        let (c, queued) = start_cycle(&root, &[("Vault".into(), "src/Vault.sol".into())], 3);
        assert_eq!((c.n, c.phase.as_str(), queued.len()), (1, "rebuild", 1));
        // Queuing again in the running cycle adds nothing.
        assert!(start_cycle(&root, &[("Vault".into(), "src/Vault.sol".into())], 3).1.is_empty());
        let gap = json!({ "class": "gap", "title": "Sweep has no owner check", "description": "The draft restricts `sweep` to the owner; no theorem says so.", "draft": "src/Vault.sol:12", "rebuild": "rebuild/src/Vault.sol:30", "theorem": "sweep reverts unless msg.sender = owner", "fix": "Only the owner may sweep (AsyncSwapSpec/Admin.lean)." });
        let d = record_difference(&root, 1, "Vault", &gap).unwrap();
        assert_eq!((d["id"].as_str(), d["status"].as_str()), (Some("D-01"), Some("open")));
        assert_eq!(d["draft"][0], json!({ "file": "src/Vault.sol", "line": 12 }));
        // Each class needs what follows from it.
        assert!(record_difference(&root, 1, "Vault", &json!({ "class": "gap", "title": "t", "description": "d" })).is_err());
        assert!(record_difference(&root, 1, "Vault", &json!({ "class": "divergence", "title": "t", "description": "d" })).is_err());
        assert!(record_difference(&root, 1, "Vault", &json!({ "class": "bug", "title": "t", "description": "d", "finding": "FM-09" })).is_err());
        assert!(record_difference(&root, 1, "Vault", &json!({ "class": "typo", "title": "t", "description": "d" })).is_err());
        let q = record_difference(&root, 1, "Vault", &json!({ "class": "improvement", "title": "One step", "description": "The rebuild collects in one call.", "question": "Take the one-call collect? Recommended: yes." })).unwrap();
        assert_eq!((q["id"].as_str(), q["status"].as_str()), (Some("D-02"), Some("asked")));
        // An update by id keeps what it doesn't restate.
        let closed = record_difference(&root, 1, "Vault", &json!({ "id": "D-01", "status": "closed" })).unwrap();
        assert_eq!((closed["status"].as_str(), closed["class"].as_str()), (Some("closed"), Some("gap")));
        update_difference(&root, "D-02", |d| {
            d["status"] = json!("decided");
            d["decision"] = json!("Yes.");
        })
        .unwrap();
        let all = differences(&root);
        assert_eq!(all.len(), 2);
        assert_eq!(confidence(&all, 1), "medium");
        let mut c = load_cycle(&root);
        c.contract_mut("Vault").unwrap().state = "agreed".into();
        assert_eq!(c.phase_now(), "close");
        c.history.push(json!({ "n": 1, "summary": cycle_summary(&all, &c), "confidence": "medium" }));
        c.phase = "rest".into();
        save_cycle(&root, &c);
        sync_rebuild(&root, &c).unwrap();
        let doc = internal_doc(&root);
        assert_eq!((doc["rebuild"]["cycle"].as_u64(), doc["rebuild"]["phase"].as_str()), (Some(1), Some("rest")));
        assert!(doc["rebuild"]["summary"].as_str().unwrap().contains("2 differences (1 gap, 1 improvement, 0 divergences, 0 bugs); 2 resolved"));
        assert_eq!(doc["rebuild"]["differences"].as_array().unwrap().len(), 2);
        // The next start opens cycle 2.
        assert_eq!(start_cycle(&root, &[("Vault".into(), "src/Vault.sol".into())], 5).0.n, 2);
        let _ = std::fs::remove_dir_all(&root);
    }
}
