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
    /// Models rewritten because formal-ast now translates functions the file on disk left opaque (folder-relative
    /// path, and what changed); proofs that used those functions' `Ext` fields need repair.
    pub regenerated: Vec<String>,
}

/// `formalmind.toml` at the folder's root: where its Lean proofs live, so every tool (the app, the swarm, an agent
/// through the MCP) finds them in the same place.
///
/// ```toml
/// [lean]
/// project = "formal"   # the Lake project: the folder with the lakefile
/// sources = "formal"   # where Lake reads Generated/ (the models) and Refinement/ (the proofs)
/// ```
pub const CONFIG: &str = "formalmind.toml";

/// A `[lean]` path from formalmind.toml, folder-relative, kept inside the folder.
fn configured(root: &Path, key: &str) -> Option<PathBuf> {
    let text = std::fs::read_to_string(root.join(CONFIG)).ok()?;
    let table: toml::Table = text.parse().ok()?;
    let rel = table.get("lean")?.get(key)?.as_str()?.trim().trim_matches('/');
    (!rel.split('/').any(|p| p == "..")).then(|| if rel.is_empty() || rel == "." { root.to_path_buf() } else { root.join(rel) })
}

fn has_lakefile(d: &Path) -> bool {
    d.join("lakefile.toml").exists() || d.join("lakefile.lean").exists()
}

/// The folder's Lake project: formalmind.toml's `lean.project`, else the folder itself or formal/ in it.
pub fn lake_dir(root: &Path) -> Option<PathBuf> {
    if let Some(d) = configured(root, "project").filter(|d| has_lakefile(d)) {
        return Some(d);
    }
    [root.to_path_buf(), root.join("formal")].into_iter().find(|d| has_lakefile(d))
}

/// Where the Lake project's Lean sources are: formalmind.toml's `lean.sources`, else the lakefile's `srcDir` in the
/// Lake project (Async Swap's `srcDir = "validation/lean"`), else the Lake project itself. `Generated/` and
/// `Refinement/` live here, and module names are relative to it.
/// A Lake project for a folder that has none: `formal/` with the two libraries, `Specs` (the generated models) and
/// `Proofs` (the proofs about them), on the toolchain the swarm proves with.
pub fn scaffold(root: &Path) -> std::io::Result<()> {
    let dir = root.join("formal");
    std::fs::create_dir_all(dir.join("Specs"))?;
    std::fs::create_dir_all(dir.join("Proofs"))?;
    std::fs::write(dir.join("lean-toolchain"), "leanprover/lean4:v4.35.0\n")?;
    std::fs::write(
        dir.join("lakefile.toml"),
        "name = \"formal\"\ndefaultTargets = [\"Specs\", \"Proofs\"]\n\n[[lean_lib]]\nname = \"Specs\"\nglobs = [\"Specs.+\"]\n\n[[lean_lib]]\nname = \"Proofs\"\nglobs = [\"Proofs.+\"]\n",
    )?;
    std::fs::write(dir.join(".gitignore"), ".lake/\n")
}

/// The two folders under the Lake sources: the generated models and the proofs about them. New projects use `Specs/`
/// and `Proofs/`; a project laid out before that (`Generated/`, `Refinement/`) keeps its names.
pub fn layout(root: &Path) -> (&'static str, &'static str) {
    let lakefile = lake_dir(root).map(|d| {
        ["lakefile.toml", "lakefile.lean"].iter().filter_map(|f| std::fs::read_to_string(d.join(f)).ok()).collect::<String>()
    });
    let declared = lakefile.is_some_and(|t| t.contains("\"Refinement\"") || t.contains("lean_lib Refinement") || t.contains("\"Generated\"") || t.contains("lean_lib Generated"));
    let legacy = declared || lean_src(root).is_some_and(|d| d.join("Generated").is_dir() || d.join("Refinement").is_dir());
    if legacy { ("Generated", "Refinement") } else { ("Specs", "Proofs") }
}

/// The folder under the proofs where the swarm writes one file per function: `Functions/`, or `Swarm/` where the project
/// already keeps them there (an older project, or the `Refinement/` layout), so its proofs stay in one place.
pub fn functions_dir(root: &Path) -> &'static str {
    let proofs = layout(root).1;
    let has = |d: &str| lean_src(root).is_some_and(|src| src.join(proofs).join(d).is_dir());
    if proofs == "Refinement" || (has("Swarm") && !has("Functions")) { "Swarm" } else { "Functions" }
}

/// Where the proofs of statements (informal specs: claims in plain words) go, under the Lake sources:
/// `Proofs/InformalSpecs`, or `<proofs>/Statements` where the project already keeps them there.
pub fn informal_dir(root: &Path) -> String {
    let proofs = layout(root).1;
    let has = |d: &str| lean_src(root).is_some_and(|src| src.join(proofs).join(d).is_dir());
    let dir = if proofs == "Refinement" || (has("Statements") && !has("InformalSpecs")) { "Statements" } else { "InformalSpecs" };
    format!("{proofs}/{dir}")
}

pub fn lean_src(root: &Path) -> Option<PathBuf> {
    let lake = lake_dir(root)?;
    if let Some(d) = configured(root, "sources").filter(|d| d.starts_with(&lake)) {
        return Some(d);
    }
    let toml = std::fs::read_to_string(lake.join("lakefile.toml")).ok();
    let lean = std::fs::read_to_string(lake.join("lakefile.lean")).ok();
    let src = toml
        .as_deref()
        .and_then(|t| t.lines().map(str::trim).find_map(|l| l.strip_prefix("srcDir").map(|r| r.trim_start().trim_start_matches('=').trim().trim_matches('"').to_string())))
        .or_else(|| lean.as_deref().and_then(|t| t.split("srcDir").nth(1).and_then(|r| r.split('"').nth(1)).map(String::from)))
        .filter(|s| !s.is_empty() && s != "." && !s.contains(".."));
    Some(match src {
        Some(s) => lake.join(s),
        None => lake,
    })
}

/// Writes formalmind.toml with the layout found, when the folder has a Lake project and no formalmind.toml yet.
pub fn ensure_config(root: &Path) {
    let path = root.join(CONFIG);
    if path.exists() {
        return;
    }
    let (Some(lake), Some(src)) = (lake_dir(root), lean_src(root)) else { return };
    let rel = |d: &Path| match d.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")) {
        Ok(p) if !p.is_empty() => p,
        _ => ".".to_string(),
    };
    let text = format!(
        "# Formal Mind: where this repository's Lean proofs live (https://docs.formal.team/files).\n[lean]\n# The Lake project: the folder with the lakefile.\nproject = \"{}\"\n# Where Lake reads the sources: Generated/ (the models formal-ast writes) and Refinement/ (the proofs).\nsources = \"{}\"\n",
        rel(&lake),
        rel(&src)
    );
    let _ = std::fs::write(path, text);
}

/// Why the model on disk should be rewritten with the one formal-ast generates now, if it should: it is missing, the
/// contract's code changed (so a def no longer says what the function does, and proofs of the old def prove nothing
/// about the new code), or more functions are translated. Never when formal-ast translates fewer than the file has.
fn refresh(on_disk: Option<&str>, generated: &str) -> Option<String> {
    let Some(old) = on_disk else { return Some("missing".into()) };
    if old == generated {
        return None;
    }
    match (translated_count(old), translated_count(generated)) {
        (Some(o), Some(n)) if n < o => None,
        (Some(o), Some(n)) if n > o => Some(format!("{} more functions translated ({o} → {n}); proofs that used their `Ext` fields need repair", n - o)),
        _ => Some("the contract's code changed; proofs of the functions whose defs changed are checked again".into()),
    }
}

/// How many functions a generated model translated, from its header (`Translated: 7 functions.`).
fn translated_count(model: &str) -> Option<usize> {
    let rest = model.split("Translated: ").nth(1)?;
    rest.split(' ').next()?.parse().ok()
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
    context_with(root, true)
}

/// [`context`], writing models only when `write`: otherwise an out-of-date model is only noted in `regenerated`.
pub fn context_with(root: &Path, write: bool) -> Context {
    let mut ctx = Context::default();
    let (files, scripts) = in_scope(root, &mut ctx.problems);
    let entry_points: Vec<Value> = scripts["entryPoints"].as_array().cloned().unwrap_or_default();
    if write && !files.is_empty() && lake_dir(root).is_none() {
        if let Err(e) = scaffold(root) {
            ctx.problems.push(format!("couldn't set up formal/: {e}"));
        }
    }
    let lake = lean_src(root);
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
        // The model the provers write against: Specs/<Contract>.lean (Generated/ in older projects) in the Lake project's sources, generated here
        // when it is missing, and again when the contract's code changed or formal-ast now translates more functions
        // than the file on disk does (see `refresh`).
        let mut model = None;
        if let Some(dir) = &lake {
            let path = dir.join(layout(root).0).join(format!("{name}.lean"));
            let on_disk = std::fs::read_to_string(&path).ok();
            let m = lean::Gen::new(&output, &a.graph, &a.scope).generate(&lean::ident(&name));
            if let Some(why) = refresh(on_disk.as_deref(), &m.text) {
                if write {
                    let _ = std::fs::create_dir_all(path.parent().unwrap_or(dir)).and_then(|_| std::fs::write(&path, &m.text));
                }
                if on_disk.is_some() {
                    let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                    ctx.regenerated.push(if write { format!("{rel}: regenerated, {why}") } else { format!("{rel}: out of date, {why}; refreshing the model (or starting the swarm) rewrites it") });
                }
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
        for r in &self.regenerated {
            s.push_str(&format!("({r})\n"));
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
        let rel = |d: &Path| d.strip_prefix(root).unwrap_or(d).to_string_lossy().replace('\\', "/");
        let lake_rel = lake.map(rel).filter(|d| !d.is_empty()).unwrap_or_else(|| ".".into());
        // Where Lake reads the sources (its srcDir), which can differ from where it runs.
        let lib = lean_src(root).map(|d| rel(&d)).filter(|d| !d.is_empty()).unwrap_or_else(|| lake_rel.clone());
        let short = u.name().rsplit('.').next().unwrap_or("").trim_start_matches('_');
        let module = format!("{}{}", c.name, name_part(short, true));
        let (specs, proofs) = layout(root);
        let functions = functions_dir(root);
        let mut s = format!(
            "## The target\n\n`{}` in {} ({}) — Lean def `{lean}` in the generated model `{}`.\n{}\n\
Prove what its slice says: the conditions under which it reverts (its guards), and on success the storage it writes \
(its footprint) and what it returns or hands to its external calls. \
Write the proof as `{lib}/{proofs}/{functions}/{module}.lean` (module `{proofs}.{functions}.{module}`), starting with `import {specs}.{}` (and `import {proofs}.Monad` for its simp lemmas when the project has it). \
Every theorem about the def must spell it fully qualified as `{lean}` in its statement — the Proofs page counts the function as proved only when a theorem without `sorry` names exactly that. \
Check it with `lake build {proofs}.{functions}.{module}` (lake runs in {lake_rel}/). The swarm itself re-runs `lake build` and the coverage before your work goes to review.\n",
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
        let earlier = archived_proofs(root, &lean);
        if !earlier.is_empty() {
            s.push_str("\n### Earlier proofs of it (the archive, read only)\n\nThese theorems proved this def against an older version of the code and its model (formalmind.toml's `lean.archive`). Start from them: keep what still holds, adapt the rest to the def above, and drop what the new code no longer does. Write your proof in the file named above, never in the archive, and don't import from it.\n");
            let mut room = ARCHIVE_ROOM;
            for t in &earlier {
                let text = t.text.trim_end();
                if text.len() > room {
                    s.push_str(&format!("\n(more in the archive: {}:{} {})\n", t.file, t.line, t.qualified));
                    continue;
                }
                room -= text.len();
                s.push_str(&format!("\n`{}` ({}:{}):\n\n```lean\n{text}\n```\n", t.qualified, t.file, t.line));
            }
        }
        s
    }
}

/// How much of the archive's text a brief carries, in bytes; the rest is named by place.
const ARCHIVE_ROOM: usize = 12_000;

/// formalmind.toml's `lean.archive`: a folder of earlier proofs (an old checkout, e.g. a git worktree at the commit
/// they were written for), read where it is and never copied into the project. Folder-relative or absolute.
pub fn archive(root: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(root.join(CONFIG)).ok()?;
    let table: toml::Table = text.parse().ok()?;
    let at = table.get("lean")?.get("archive")?.as_str()?.trim();
    let p = Path::new(at);
    let dir = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    dir.is_dir().then_some(dir)
}

/// The archive's theorems that name `lean`, those without `sorry`, files shown relative to the folder: by its full
/// name, or by its short name inside the contract's namespace (`namespace AsyncSwap … setMinOrder`).
pub fn archived_proofs(root: &Path, lean: &str) -> Vec<formal_ast::Theorem> {
    let Some(dir) = archive(root) else { return vec![] };
    let names = |hay: &str, name: &str| {
        !name.is_empty()
            && hay.match_indices(name).any(|(at, _)| {
                let edge = |c: Option<char>| c.map_or(true, |c| !(c.is_alphanumeric() || c == '_' || c == '.' || c == '\''));
                edge(hay[..at].chars().next_back()) && edge(hay[at + name.len()..].chars().next())
            })
    };
    let (ns, short) = lean.rsplit_once('.').unwrap_or(("", lean));
    let shown = dir.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| dir.to_string_lossy().to_string());
    formal_ast::theorems(&dir)
        .into_iter()
        .filter(|t| !t.sorry && (names(&t.text, lean) || (!ns.is_empty() && t.qualified.starts_with(&format!("{ns}.")) && names(&t.text, short))))
        .map(|mut t| {
            t.file = format!("{shown}/{}", t.file);
            t
        })
        .collect()
}

fn status(f: &Func) -> String {
    match (&f.why, f.proved, f.theorems.is_empty()) {
        (Some(why), _, _) => format!("opaque in the model ({why})"),
        (None, true, _) => format!("proved ({} theorem{})", f.theorems.len(), if f.theorems.len() == 1 { "" } else { "s" }),
        (None, false, false) => "named only by theorems with sorry".into(),
        (None, false, true) => "NOT PROVED".into(),
    }
}

/// One part of a Lean def's name as it may appear in a file or theorem name: the receive/fallback function (`«»`, no
/// name in Solidity) is `fallback`, guillemets and other characters a module name can't hold are dropped, and for a
/// file the part is capitalized (`_setFee` → `SetFee`).
pub fn name_part(part: &str, file: bool) -> String {
    let p: String = part.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect();
    let p = if p.trim_matches('_').is_empty() { "fallback".to_string() } else { p };
    if file { capitalize(p.trim_start_matches('_')) } else { p }
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
    #[test]
    fn the_archive_gives_the_prover_its_old_proofs() {
        let root = std::env::temp_dir().join(format!("fm-archive-{}", std::process::id()));
        let old = root.join(".claude/worktrees/old/formal");
        std::fs::create_dir_all(old.join("Refinement/Swarm")).unwrap();
        std::fs::write(old.join("lakefile.toml"), "name = \"old\"\n").unwrap();
        std::fs::write(
            old.join("Refinement/Swarm/PoolFee.lean"),
            "theorem fee_ok : AsyncSwap.fee 1 = 1 := by simp [AsyncSwap.fee]\n\ntheorem feeX_ok : AsyncSwap.feeX = 0 := rfl\n\ntheorem fee_todo : AsyncSwap.fee 2 = 2 := by sorry\n\nnamespace AsyncSwap\ntheorem inner : fee 3 = 3 := rfl\nend AsyncSwap\n\ntheorem other : Router.fee 4 = 4 := rfl\n",
        )
        .unwrap();
        assert!(super::archived_proofs(&root, "AsyncSwap.fee").is_empty(), "no archive set");
        std::fs::write(root.join(super::CONFIG), "[lean]\narchive = \".claude/worktrees/old\"\n").unwrap();
        let got = super::archived_proofs(&root, "AsyncSwap.fee");
        assert_eq!(got.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["fee_ok", "inner"], "whole-word matches without sorry, short names inside the namespace");
        assert_eq!(got[0].file, ".claude/worktrees/old/formal/Refinement/Swarm/PoolFee.lean");
        assert!(!root.join("validation").exists() && !root.join("Refinement").exists(), "nothing copied into the project");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_model_is_rewritten_when_the_code_changes() {
        let m = |n: usize, body: &str| format!("-- Translated: {n} functions.\ndef fee := {body}\n");
        assert_eq!(super::refresh(None, &m(2, "30")).as_deref(), Some("missing"));
        assert_eq!(super::refresh(Some(&m(2, "30")), &m(2, "30")), None, "the same model stays");
        assert!(super::refresh(Some(&m(2, "30")), &m(2, "2")).unwrap().contains("code changed"), "a changed body");
        assert!(super::refresh(Some(&m(2, "30")), &m(3, "30")).unwrap().contains("1 more"));
        assert_eq!(super::refresh(Some(&m(3, "30")), &m(2, "2")), None, "never fewer functions than the file has");
    }

    #[test]
    fn lean_sources_follow_the_config_then_the_lakefile() {
        let root = std::env::temp_dir().join(format!("fm-src-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("validation/lean")).unwrap();
        std::fs::write(root.join("lakefile.toml"), "name = \"x\"\nsrcDir = \"validation/lean\"\n").unwrap();
        assert_eq!(super::lean_src(&root), Some(root.join("validation/lean")));
        super::ensure_config(&root);
        let cfg = std::fs::read_to_string(root.join(super::CONFIG)).unwrap();
        assert!(cfg.contains("project = \".\"") && cfg.contains("sources = \"validation/lean\""), "{cfg}");
        std::fs::write(root.join(super::CONFIG), "[lean]\nproject = \".\"\nsources = \"validation\"\n").unwrap();
        assert_eq!(super::lean_src(&root), Some(root.join("validation")));
        std::fs::write(root.join(super::CONFIG), "[lean]\nsources = \"../elsewhere\"\n").unwrap();
        assert_eq!(super::lean_src(&root), Some(root.join("validation/lean")));
        let _ = std::fs::remove_dir_all(&root);
    }

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

fn update_internal(root: &Path, f: impl FnOnce(&mut Value)) -> Result<String, String> {
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

/// A proved statement (.formal/statements.md) in Formal Mind's audit file: `P-S01`, titled by the maintainer's words.
pub fn record_statement_property(root: &Path, id: &str, title: &str, files: &[String], input: &Value) -> Result<String, String> {
    let statement = input["statement"].as_str().unwrap_or("").trim();
    if statement.is_empty() {
        return Err("statement is required: what the proof establishes".into());
    }
    let assumptions = input["assumptions"].as_str().unwrap_or("").trim();
    let description = if assumptions.is_empty() { statement.to_string() } else { format!("{statement}\n\n**Assumptions.** {assumptions}") };
    let p = json!({
        "id": format!("P-{}", id.replace('-', "")),
        "statement": id,
        "title": title,
        "status": "verified",
        "description": description,
        "theorems": input["theorems"].as_array().into_iter().flatten().filter_map(|t| t.as_str()).map(|t| json!({ "name": t })).collect::<Vec<_>>(),
        "files": files,
    });
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

    #[test]
    fn new_projects_get_specs_and_proofs_and_old_ones_keep_their_names() {
        let base = std::env::temp_dir().join(format!("fm-layout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (new, old) = (base.join("new"), base.join("old"));
        std::fs::create_dir_all(&new).unwrap();
        super::scaffold(&new).unwrap();
        assert_eq!(super::layout(&new), ("Specs", "Proofs"));
        assert!(std::fs::read_to_string(new.join("formal/lakefile.toml")).unwrap().contains("name = \"Proofs\""));
        std::fs::create_dir_all(old.join("formal/Generated")).unwrap();
        std::fs::write(old.join("formal/lakefile.toml"), "name = \"x\"\n").unwrap();
        assert_eq!(super::layout(&old), ("Generated", "Refinement"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
