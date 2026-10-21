//! formal-ast: a Solidity protocol read through solc's AST, and nothing else.
//!
//! `solc` → [`graph::Graph`] (what every function reads, writes, calls, guards and computes) → [`scope::Scope`] (what
//! the entry contract can reach) → [`scope::Unit`]s and clusters (how to split the work) → [`slice::render`] (what an
//! agent reads). See desktop/AUDIT-ENGINE.md.

pub mod fs;
pub mod graph;
pub mod lean;
pub mod link;
pub mod scope;
pub mod slice;
pub mod solc;

use anyhow::Result;
use std::path::Path;

/// Milliseconds since it was made (always 0 in wasm, which has no clock: the website times the work itself).
#[cfg(not(target_arch = "wasm32"))]
fn clock() -> impl Fn() -> u64 {
    let started = std::time::Instant::now();
    move || started.elapsed().as_millis() as u64
}
#[cfg(target_arch = "wasm32")]
fn clock() -> impl Fn() -> u64 {
    || 0
}

/// Everything for one entry file: the graph, its scope and units.
pub struct Analysis {
    pub project: solc::Project,
    pub entry_file: String,
    pub graph: graph::Graph,
    pub scope: scope::Scope,
    pub units: Vec<scope::Unit>,
}

#[cfg(not(target_arch = "wasm32"))]
pub fn analyze(root: &Path, entry_file: &str, contract: Option<&str>) -> Result<Analysis> {
    Ok(analyze_full(root, entry_file, contract)?.0)
}

/// Also returns solc's output, for generators that need the full AST (the Lean model).
#[cfg(not(target_arch = "wasm32"))]
pub fn analyze_full(root: &Path, entry_file: &str, contract: Option<&str>) -> Result<(Analysis, serde_json::Value)> {
    let project = solc::Project::load(root)?;
    let output = solc::compile(&project, entry_file)?;
    Ok((analyze_output(project, entry_file, contract, &output)?, output))
}

/// The analysis of solc's output for the entry file (compiled from [`solc::input`] by whichever solc).
pub fn analyze_output(project: solc::Project, entry_file: &str, contract: Option<&str>, output: &serde_json::Value) -> Result<Analysis> {
    let mut graph = graph::Graph::build(output);
    graph.mark_dependencies(&project.libs);
    let scope = scope::Scope::new(&graph, entry_file, contract)?;
    let units = scope.units(&graph);
    Ok(Analysis { project, entry_file: entry_file.to_string(), graph, scope, units })
}

/// What audit mode shows for one entry contract: units with their footprint and risks, clusters, scope, timing.
pub fn audit_json(a: &Analysis, ms: u64) -> serde_json::Value {
    use serde_json::json;
    let g = &a.graph;
    let names = |ids: &std::collections::BTreeSet<i64>| ids.iter().filter_map(|v| g.state_vars.get(v).map(|s| s.name.clone())).collect::<Vec<_>>();
    let units: Vec<serde_json::Value> = a
        .units
        .iter()
        .map(|u| {
            json!({
                "name": u.name,
                "function": g.functions[&u.function].name,
                "mutability": u.mutability,
                "reads": names(&u.reads),
                "writes": names(&u.writes),
                "external": u.external_calls.len(),
                "guards": u.guards,
                "arith": u.arith,
                "unchecked": u.unchecked,
                "asm": u.asm,
                "closure": u.closure.len(),
            })
        })
        .collect();
    let clusters: Vec<serde_json::Value> = scope::clusters(&a.units)
        .iter()
        .filter(|c| c.units.len() > 1)
        .map(|c| json!({ "units": c.units.iter().map(|f| g.functions[f].name.clone()).collect::<Vec<_>>(), "shared": names(&c.shared) }))
        .collect();
    // The contract as the AST has it: the entry and its bases (most derived first), each with its state and functions.
    let tree: Vec<serde_json::Value> = a
        .scope
        .contracts
        .iter()
        .map(|c| {
            let ct = &g.contracts[c];
            let vars: Vec<serde_json::Value> = ct
                .state_vars
                .iter()
                .map(|v| {
                    let v = &g.state_vars[v];
                    json!({ "name": v.name, "type": v.type_string, "slot": v.slot, "offset": v.offset, "constant": v.constant, "immutable": v.immutable, "visibility": v.visibility })
                })
                .collect();
            let fns: Vec<serde_json::Value> = ct
                .functions
                .iter()
                .map(|f| {
                    let f = &g.functions[f];
                    json!({
                        "name": if f.name.is_empty() { f.kind.clone() } else { f.name.clone() },
                        "kind": f.kind,
                        "visibility": f.visibility,
                        "mutability": f.mutability,
                        "modifiers": f.modifiers.iter().filter_map(|m| g.functions.get(m).map(|m| m.name.clone())).collect::<Vec<_>>(),
                        "reached": a.scope.reachable.contains(&f.id),
                        "entry": a.scope.surface.contains(&f.id),
                    })
                })
                .collect();
            json!({ "name": ct.name, "kind": ct.kind, "file": g.files.get(&ct.file).map(|f| f.path.clone()), "stateVars": vars, "functions": fns })
        })
        .collect();
    let reached: Vec<serde_json::Value> = a
        .scope
        .reachable
        .iter()
        .map(|f| {
            let func = &g.functions[f];
            json!({
                "name": g.qualified(*f),
                "kind": func.kind,
                "visibility": func.visibility,
                "dependency": g.is_dependency(*f),
                "arith": func.arith.len(),
                "asm": func.asm.len(),
                "calls": func.calls.len(),
            })
        })
        .collect();
    let scope_files: Vec<serde_json::Value> = g
        .files
        .values()
        .map(|f| json!({ "path": f.path, "inScope": a.scope.files.contains(&f.id), "dependency": g.dependency_files.contains(&f.id), "imports": f.imports.len() }))
        .collect();
    json!({
        "contract": g.contracts[&a.scope.entry].name,
        "files": g.files.len(),
        "inScope": a.scope.files.len(),
        "reachable": a.scope.reachable.len(),
        "unusedImports": a.scope.unused_imports,
        "ms": ms,
        "units": units,
        "clusters": clusters,
        "tree": tree,
        "reached": reached,
        "scopeFiles": scope_files,
    })
}

/// Every unit's slice, by unit name.
pub fn all_slices(a: &Analysis) -> std::collections::BTreeMap<String, String> {
    let mut sources = slice::Sources::from_files(a.project.files.clone(), &a.graph);
    a.units.iter().map(|u| (u.name.clone(), slice::render(&a.graph, &a.scope, u, &mut sources))).collect()
}

/// A theorem (or lemma) in one of the project's own Lean files.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Theorem {
    pub name: String,
    pub file: String,
    pub line: usize,
    /// Its proof still has a `sorry`.
    pub sorry: bool,
    /// Its statement and proof, as written.
    pub text: String,
}

/// Every theorem in the project's own `.lean` files (dependencies, build output and Lake's packages skipped).
pub fn theorems(root: &Path) -> Vec<Theorem> {
    theorems_in(&fs::Disk(root.to_path_buf()))
}

/// [`theorems`], read from a project's files.
pub fn theorems_in(files: &dyn fs::Files) -> Vec<Theorem> {
    const SKIP: [&str; 9] = [".git", ".lake", "lib", "dependencies", "node_modules", "out", "cache", "broadcast", "target"];
    let mut paths = vec![];
    let mut stack = vec![String::new()];
    while let Some(dir) = stack.pop() {
        for (name, is_dir) in files.read_dir(&dir) {
            let path = if dir.is_empty() { name.clone() } else { format!("{dir}/{name}") };
            if is_dir {
                if !SKIP.contains(&name.as_str()) {
                    stack.push(path);
                }
            } else if name.ends_with(".lean") {
                paths.push(path);
            }
        }
    }
    // Folder by folder, as paths sort.
    paths.sort_by(|a, b| a.split('/').cmp(b.split('/')));
    let mut out = vec![];
    for rel in paths {
        let Some(text) = files.read(&rel) else { continue };
        let lines: Vec<&str> = text.lines().collect();
        // A declaration starts at column 0 (after attributes and modifiers); it runs to the next one.
        let starts_decl = |l: &str| {
            let t = l.trim_start_matches("private ").trim_start_matches("protected ").trim_start_matches("noncomputable ");
            !l.starts_with(' ') && !l.starts_with('\t') && ["theorem ", "lemma ", "def ", "abbrev ", "structure ", "inductive ", "instance ", "namespace ", "end ", "section ", "open ", "example ", "@[", "/--", "/-!", "set_option ", "variable ", "include "].iter().any(|k| t.starts_with(k))
        };
        let mut i = 0;
        while i < lines.len() {
            let l = lines[i];
            let t = l.trim_start_matches("private ").trim_start_matches("protected ");
            let kw = if t.starts_with("theorem ") { Some("theorem ") } else if t.starts_with("lemma ") { Some("lemma ") } else { None };
            if let (Some(kw), false) = (kw, l.starts_with(' ')) {
                let name = t[kw.len()..].split_whitespace().next().unwrap_or("").to_string();
                let mut j = i + 1;
                while j < lines.len() && !starts_decl(lines[j]) {
                    j += 1;
                }
                let body = lines[i..j].join("\n").trim_end().to_string();
                out.push(Theorem { name, file: rel.clone(), line: i + 1, sorry: body.split(|c: char| !c.is_alphanumeric() && c != '_').any(|w| w == "sorry"), text: body });
                i = j;
            } else {
                i += 1;
            }
        }
    }
    out
}

/// What the Audit page shows for one entry contract: every function the Lean model reached (translated or opaque),
/// where it is in Solidity, its Lean definition, and which of the project's theorems name it.
pub fn formal_json(a: &Analysis, output: &serde_json::Value, ms: u64) -> serde_json::Value {
    use serde_json::json;
    let g = &a.graph;
    let elapsed = clock();
    let namespace = lean::ident(&g.contracts[&a.scope.entry].name);
    let model = lean::Gen::new(output, g, &a.scope).generate(&namespace);
    let theorems = theorems_in(&*a.project.files);
    let mut sources = slice::Sources::from_files(a.project.files.clone(), g);
    // A theorem covers a function when it names its Lean definition (or, for an opaque one, its `Ext` field).
    let names = |hay: &str, needle: &str| {
        let mut from = 0;
        while let Some(k) = hay[from..].find(needle) {
            let at = from + k;
            let before = hay[..at].chars().next_back();
            let after = hay[at + needle.len()..].chars().next();
            let edge = |c: Option<char>| c.map_or(true, |c| !(c.is_alphanumeric() || c == '_' || c == '.' || c == '\''));
            if edge(before) && edge(after) {
                return true;
            }
            from = at + needle.len();
        }
        false
    };
    let functions: Vec<serde_json::Value> = model
        .report
        .functions
        .iter()
        .map(|f| {
            let func = &g.functions[&f.id];
            let file = g.files.get(&func.src.file).map(|x| x.path.clone());
            let line = sources.line(func.src);
            let end = sources.line(graph::Src { start: func.src.start + func.src.len, ..func.src });
            let by: Vec<usize> = theorems.iter().enumerate().filter(|(_, t)| !f.lean.is_empty() && names(&t.text, &f.lean)).map(|(i, _)| i).collect();
            json!({
                "name": f.name,
                "kind": func.kind,
                "visibility": func.visibility,
                "mutability": func.mutability,
                "entry": a.scope.surface.contains(&f.id),
                "dependency": g.is_dependency(f.id),
                "file": file,
                "line": line,
                "endLine": end,
                "solidity": sources.lines(func.src),
                "lean": f.lean,
                "def": f.def,
                "why": f.why,
                "theorems": by,
            })
        })
        .collect();
    json!({
        "contract": g.contracts[&a.scope.entry].name,
        "namespace": namespace,
        "modelLines": model.text.lines().count(),
        "translated": model.report.translated.len(),
        "opaque": model.report.opaque.len(),
        "ext": model.report.ext.len(),
        "functions": functions,
        "theorems": theorems,
        "ms": ms + elapsed(),
    })
}

/// The protocol as production uses it: every Foundry script under `script/` (`*.s.sol`), what each deploys and which
/// of the project's own functions it calls. Those are the entry points; the project's contracts nothing deploys or
/// calls are out of scope. (Tests only show the code runs; scripts are what will run on chain.)
#[cfg(not(target_arch = "wasm32"))]
pub fn script_entries(root: &Path) -> Result<serde_json::Value> {
    let project = solc::Project::load(root)?;
    script_entries_with(&project, |script| solc::compile(&project, script))
}

/// The Foundry scripts under `script/` (`*.s.sol`), sorted.
pub fn script_files(files: &dyn fs::Files) -> Vec<String> {
    let mut scripts = vec![];
    let mut stack = vec!["script".to_string()];
    while let Some(dir) = stack.pop() {
        for (name, is_dir) in files.read_dir(&dir) {
            let p = format!("{dir}/{name}");
            if is_dir {
                stack.push(p);
            } else if p.ends_with(".s.sol") {
                scripts.push(p);
            }
        }
    }
    scripts.sort();
    scripts
}

/// [`script_entries`], with each script's solc output from `compile` (the website compiles them with solc-js, several
/// scripts in one output).
pub fn script_entries_with<O: std::borrow::Borrow<serde_json::Value>>(project: &solc::Project, mut compile: impl FnMut(&str) -> Result<O>) -> Result<serde_json::Value> {
    use serde_json::json;
    use std::collections::{BTreeMap, BTreeSet};
    let scripts = script_files(&*project.files);
    // Project code: not a dependency, not a script or test.
    let own = |path: &str| !path.starts_with("script/") && !path.starts_with("test/") && !path.contains("/test/") && !path.ends_with(".t.sol") && !path.ends_with(".s.sol");
    // (contract, function) → the scripts that call it; contract → the scripts that deploy it.
    let mut calls: BTreeMap<(String, String), (String, usize, BTreeSet<String>)> = BTreeMap::new();
    let mut deploys: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut seen_contracts: BTreeMap<String, (String, String)> = BTreeMap::new(); // name → (file, kind)
    // Contracts in scope because a deployed or called one inherits them or deploys them itself: name → why.
    let mut reached: BTreeMap<String, String> = BTreeMap::new();
    let mut out = vec![];
    for script in &scripts {
        let elapsed = clock();
        let result = (|| -> Result<serde_json::Value> {
            let output = compile(script)?;
            let mut g = graph::Graph::build(output.borrow());
            g.mark_dependencies(&project.libs);
            let scope = scope::Scope::new(&g, script, None)?;
            let mut src = slice::Sources::from_files(project.files.clone(), &g);
            for c in g.contracts.values() {
                let file = &g.files[&c.file].path;
                if !g.dependency_files.contains(&c.file) && own(file) {
                    seen_contracts.insert(c.name.clone(), (file.clone(), c.kind.clone()));
                }
            }
            let mut mine_deploys = BTreeSet::new();
            let mut mine_calls = vec![];
            for f in &scope.reachable {
                for c in &g.functions[f].calls {
                    if c.kind != graph::CallKind::External {
                        continue;
                    }
                    if let Some(rest) = c.name.strip_prefix("new ") {
                        let name = rest.rsplit(' ').next().unwrap_or(rest).to_string();
                        if g.contract_by_name(&name).is_some_and(|k| !g.dependency_files.contains(&k.file) && own(&g.files[&k.file].path)) {
                            deploys.entry(name.clone()).or_default().insert(script.clone());
                            mine_deploys.insert(name);
                        }
                        continue;
                    }
                    let Some(t) = c.target else { continue };
                    let Some(func) = g.functions.get(&t) else { continue };
                    let target = &g.contracts[&func.contract];
                    if g.dependency_files.contains(&target.file) || !own(&g.files[&target.file].path) {
                        continue;
                    }
                    // A call through one of the project's interfaces runs whichever project contract implements it.
                    let mut owners: Vec<&graph::Contract> = vec![];
                    if target.kind == "interface" {
                        owners.extend(g.contracts.values().filter(|k| k.kind == "contract" && k.id != target.id && k.bases.contains(&target.id) && own(&g.files[&k.file].path) && !g.dependency_files.contains(&k.file)));
                    }
                    if owners.is_empty() {
                        owners.push(target);
                    }
                    for o in owners {
                        let line = src.line(c.src);
                        let e = calls.entry((o.name.clone(), func.name.clone())).or_insert_with(|| (g.files[&o.file].path.clone(), 0, BTreeSet::new()));
                        e.2.insert(script.clone());
                        mine_calls.push(json!({ "contract": o.name, "function": func.name, "line": line }));
                    }
                }
            }
            // What those contracts bring with them: their bases, and what their own code deploys (transitively).
            let mut todo: Vec<String> = mine_deploys.iter().cloned().chain(mine_calls.iter().filter_map(|c| c["contract"].as_str().map(String::from))).collect();
            let mut done = BTreeSet::new();
            while let Some(name) = todo.pop() {
                if !done.insert(name.clone()) {
                    continue;
                }
                let Some(k) = g.contract_by_name(&name) else { continue };
                for b in &k.bases {
                    let base = &g.contracts[b];
                    if base.id != k.id && !g.dependency_files.contains(&base.file) && own(&g.files[&base.file].path) {
                        reached.entry(base.name.clone()).or_insert_with(|| format!("a base of {name}"));
                        todo.push(base.name.clone());
                    }
                    for f in &base.functions {
                        for c in &g.functions[f].calls {
                            if let Some(rest) = c.name.strip_prefix("new ") {
                                let made = rest.rsplit(' ').next().unwrap_or(rest).to_string();
                                if g.contract_by_name(&made).is_some_and(|m| !g.dependency_files.contains(&m.file) && own(&g.files[&m.file].path)) {
                                    reached.entry(made.clone()).or_insert_with(|| format!("deployed by {name}"));
                                    todo.push(made);
                                }
                            }
                        }
                    }
                }
            }
            mine_calls.sort_by_key(|c| c["line"].as_u64());
            mine_calls.dedup_by(|a, b| a["contract"] == b["contract"] && a["function"] == b["function"]);
            Ok(json!({ "contract": g.contracts[&scope.entry].name, "deploys": mine_deploys, "calls": mine_calls }))
        })();
        let ms = elapsed();
        out.push(match result {
            Ok(mut v) => {
                v["file"] = json!(script);
                v["ms"] = json!(ms);
                v
            }
            Err(e) => json!({ "file": script, "error": format!("{e:#}"), "ms": ms }),
        });
    }
    let entry_points: Vec<serde_json::Value> = calls.iter().map(|((c, f), (file, _, by))| json!({ "contract": c, "function": f, "file": file, "scripts": by })).collect();
    let used: BTreeSet<&String> = deploys.keys().chain(calls.keys().map(|(c, _)| c)).collect();
    let contracts: Vec<serde_json::Value> = seen_contracts
        .iter()
        .filter(|(_, (_, kind))| kind == "contract" || kind == "abstract")
        .map(|(name, (file, kind))| {
            let direct = used.contains(name);
            json!({
                "name": name,
                "file": file,
                "kind": kind,
                "inScope": direct || reached.contains_key(name),
                "deployedBy": deploys.get(name).cloned().unwrap_or_default(),
                "via": if direct { None } else { reached.get(name).cloned() },
            })
        })
        .collect();
    Ok(json!({ "scripts": out, "entryPoints": entry_points, "contracts": contracts }))
}
