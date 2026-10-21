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
    for k in ["id", "title", "severity", "status", "reportStatus", "locations", "description", "impact", "recommendation", "response", "evidence", "tests", "poc", "page"] {
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
