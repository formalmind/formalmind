//! The proof ledger (.formal/ledger.json): whether each function in scope is proved, as a fact the app derives and
//! checks, never a mark an agent writes. A function is proved when every theorem naming its generated def is in a
//! module Lake builds, Lean checks it (`#check`, `#print axioms`) with no `sorry` and no axioms beyond Lean's own, at
//! least one of them states something about the def itself, and the swarm's reviewer approved those theorems for
//! that def: the approval holds the hash of the def's generated text and of each theorem's, so a change to either
//! lets it lapse. Each theorem's `/-- … -/` comment is kept as its explanation in words. The plan, the Proofs page,
//! the work map and the MCP read the ledger.

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// The axioms Lean's own library uses; anything else (`sorryAx` above all) means the proof rests on an assumption.
const STANDARD_AXIOMS: [&str; 3] = ["propext", "Classical.choice", "Quot.sound"];
/// How the check is run and read: a change to either (a parser fix) makes earlier results stale.
const CHECK_VERSION: &str = "3";

fn ledger_path(root: &Path) -> PathBuf {
    root.join(".formal").join("ledger.json")
}

fn load(root: &Path) -> Value {
    std::fs::read_to_string(ledger_path(root)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({ "version": 1 }))
}

fn save(root: &Path, v: &Value) {
    let _ = std::fs::create_dir_all(root.join(".formal"));
    let _ = std::fs::write(ledger_path(root), serde_json::to_string_pretty(v).unwrap_or_default());
}

/// FNV-1a, 64 bits: stable across builds, so an approval doesn't lapse when the app is rebuilt.
pub fn hash(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The libraries the Lake project builds (`[[lean_lib]] name = …` in lakefile.toml, `lean_lib X` in lakefile.lean).
fn lean_libs(root: &Path) -> BTreeSet<String> {
    let Some(lake) = crate::swarm_ctx::lake_dir(root) else { return BTreeSet::new() };
    let mut libs = BTreeSet::new();
    if let Ok(t) = std::fs::read_to_string(lake.join("lakefile.toml")) {
        if let Ok(table) = t.parse::<toml::Table>() {
            for lib in table.get("lean_lib").and_then(|l| l.as_array()).into_iter().flatten() {
                if let Some(n) = lib.get("name").and_then(|n| n.as_str()) {
                    libs.insert(n.to_string());
                }
            }
        }
    }
    if let Ok(t) = std::fs::read_to_string(lake.join("lakefile.lean")) {
        for l in t.lines().map(str::trim) {
            if let Some(rest) = l.strip_prefix("lean_lib ").or_else(|| l.strip_prefix("@[default_target] lean_lib ")) {
                libs.insert(rest.split_whitespace().next().unwrap_or("").trim_matches('«').trim_matches('»').to_string());
            }
        }
    }
    libs
}

/// A file's module, from the Lake sources (`formal/Refinement/Swarm/X.lean` → `Refinement.Swarm.X`), when Lake builds it.
fn module_of(src: &Path, root: &Path, file: &str, libs: &BTreeSet<String>) -> Option<String> {
    let rel = root.join(file).strip_prefix(src).ok()?.to_string_lossy().replace('\\', "/");
    let module = rel.strip_suffix(".lean")?.replace('/', ".");
    libs.contains(module.split('.').next()?).then_some(module)
}

/// One hash of every `.lean` file in the Lake sources: a theorem's check depends on everything it imports, so the
/// ledger's Lean results are reused only while none of them changed.
fn sources_hash(src: &Path) -> String {
    let mut files = vec![];
    let mut stack = vec![src.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                if name != ".lake" && !name.starts_with('.') {
                    stack.push(p);
                }
            } else if name.ends_with(".lean") {
                files.push(p);
            }
        }
    }
    files.sort();
    let all: String = files.iter().map(|f| format!("{}:{}\n", f.display(), hash(&std::fs::read_to_string(f).unwrap_or_default()))).collect();
    hash(&all)
}

/// What Lean says about one theorem.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct Checked {
    ok: bool,
    /// Its statement, as `#check` prints it.
    #[serde(default)]
    ty: String,
    #[serde(default)]
    axioms: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// What a checked statement about `def` covers, read from its type as Lean prints it: when it reverts (`Except.error`),
/// what it writes (`ext.set`), what it returns (`Except.ok`), and money invariants (the conserved
/// ledger, held balances).
fn covers(ty: &str, def: &str) -> Vec<&'static str> {
    let mut out = vec![];
    if !ty.contains(def) {
        return out;
    }
    // `wp (f …) Q e w ↔ Q v w`, for every Q: the call ends exactly in `v` with the world as it was, so it never
    // reverts, writes nothing and returns `v`.
    if ty.contains("wp (") && ty.contains("↔ Q ") && ty.trim_end().ends_with(" w") {
        return vec!["reverts", "writes", "returns"];
    }
    if ty.contains("Except.error") {
        out.push("reverts");
    }
    // The storage it leaves, spelled out (`w' = ext.set w …`, `Except.ok (r, ext.set w …)`); a conserved quantity of
    // the post-state (`L.J ext w' t = …`) isn't a statement of what was written.
    if ty.contains("ext.set") {
        out.push("writes");
    }
    if ty.contains("Except.ok") {
        out.push("returns");
    }
    if ty.contains("L.J") || ty.contains(".held") {
        out.push("conservation");
    }
    out
}

/// What a function's proof has to cover to count as fully proved.
const FULL: [&str; 3] = ["reverts", "writes", "returns"];

/// A line Lean prints for an error: `path:12:3: error: …`, or `error: …` on its own.
fn is_lean_error(line: &str) -> bool {
    line.starts_with("error:") || line.contains(": error:")
}

/// The compiled file of a module, and whether it's at least as new as its source: `lake env lean` loads what Lake
/// last built, so a module that never built, or changed since, can't vouch for its theorems.
fn built(root: &Path, module: &str) -> Result<(), String> {
    let lake = crate::swarm_ctx::lake_dir(root).ok_or("there is no Lake project")?;
    let src = crate::swarm_ctx::lean_src(root).ok_or("there is no Lake project")?;
    let rel = module.replace('.', "/");
    let olean = lake.join(".lake/build/lib/lean").join(format!("{rel}.olean"));
    let source = src.join(format!("{rel}.lean"));
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    match (modified(&olean), modified(&source)) {
        (None, _) => Err(format!("{module} hasn't built: `lake build {module}`")),
        (Some(o), Some(s)) if o < s => Err(format!("{module} changed since it last built: `lake build {module}`")),
        _ => Ok(()),
    }
}

/// Checks every theorem, a module at a time (a module that doesn't build only takes its own theorems down): a file
/// that imports the module and prints, for each theorem, a marker, `#check @T` and `#print axioms T`.
async fn check_all(root: &Path, theorems: &[(String, String)]) -> Result<BTreeMap<String, Checked>, String> {
    let mut results: BTreeMap<String, Checked> = BTreeMap::new();
    let modules: BTreeSet<&String> = theorems.iter().map(|(_, m)| m).collect();
    std::fs::create_dir_all(root.join(".formal/check")).map_err(|e| e.to_string())?;
    for module in modules {
        let mine: Vec<&String> = theorems.iter().filter(|(_, m)| m == module).map(|(q, _)| q).collect();
        if let Err(why) = built(root, module) {
            for q in mine {
                results.insert(q.clone(), Checked { ok: false, error: Some(why.clone()), ..Default::default() });
            }
            continue;
        }
        let mut file = format!("import {module}\n");
        for (i, name) in mine.iter().enumerate() {
            file.push_str(&format!("#print \"fm-ledger {i}\"\n#check @{name}\n#print axioms {name}\n"));
        }
        let check = format!(".formal/check/ledger-{}.lean", module.replace('.', "_"));
        std::fs::write(root.join(&check), file).map_err(|e| e.to_string())?;
        let out = crate::executor::call_tool(root, "run", &json!({ "command": format!("lake env lean {check}") })).await;
        // The output, split at the markers: each part is one theorem's #check and #print axioms (or its error).
        let mut current: Option<usize> = None;
        let mut parts: BTreeMap<usize, Vec<String>> = BTreeMap::new();
        for line in out.lines().skip(1) {
            if let Some(i) = line.trim().strip_prefix("fm-ledger ").and_then(|n| n.parse::<usize>().ok()) {
                current = Some(i);
                continue;
            }
            if let Some(i) = current {
                parts.entry(i).or_default().push(line.to_string());
            }
        }
        if parts.is_empty() {
            // Nothing printed: the module itself didn't load.
            let why: String = out.lines().skip(1).filter(|l| is_lean_error(l)).take(6).collect::<Vec<_>>().join("\n");
            for q in mine {
                results.insert(q.clone(), Checked { ok: false, error: Some(if why.is_empty() { format!("Lean couldn't load {module}") } else { why.clone() }), ..Default::default() });
            }
            continue;
        }
        for (i, name) in mine.iter().enumerate() {
            let lines = parts.remove(&i).unwrap_or_default();
            let text = lines.join("\n");
            // Lean's errors read `file:line:col: error: …`; a statement may well mention `Except.error`.
            let err = lines.iter().find(|l| is_lean_error(l)).cloned();
            let ty: String = lines.iter().take_while(|l| !l.contains("depends on axioms") && !l.contains("does not depend on any axioms")).cloned().collect::<Vec<_>>().join("\n").trim().to_string();
            let axioms: Vec<String> = text
                .split("depends on axioms:")
                .nth(1)
                .map(|r| r.split(']').next().unwrap_or("").trim_start_matches([' ', '[']).split(',').map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect())
                .unwrap_or_default();
            results.insert((*name).clone(), Checked { ok: err.is_none() && !ty.is_empty(), ty, axioms, error: err });
        }
    }
    Ok(results)
}

/// The ledger: one entry per function in scope, with why it is or isn't proved. `check` runs Lean when the sources
/// changed since the last check (or always, with `force`); without it, the last check is used as it stands.
pub async fn build(root: &Path, check: bool, force: bool) -> Result<Value, String> {
    let ctx = crate::swarm_ctx::context_with(root, false);
    let src = crate::swarm_ctx::lean_src(root);
    let libs = lean_libs(root);
    let all = formal_ast::theorems(root);
    let by_place: BTreeMap<(String, usize), &formal_ast::Theorem> = all.iter().map(|t| ((t.file.clone(), t.line), t)).collect();
    let mut ledger = load(root);
    let plan: BTreeMap<String, String> = std::fs::read_to_string(root.join(".formal/plan.md"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let rest = l.trim_start().strip_prefix("- [")?;
            let mark = rest.chars().next()?.to_string();
            let def = rest.split('`').nth(1)?.to_string();
            Some((def, mark))
        })
        .collect();

    // Each function's theorems (file:line name, as the coverage gives them), resolved to the scanned theorems.
    let mut wanted: Vec<(String, String)> = vec![];
    let mut per_fn: Vec<(&crate::swarm_ctx::Contract, &crate::swarm_ctx::Func, Vec<(&formal_ast::Theorem, Option<String>)>)> = vec![];
    for c in &ctx.contracts {
        for f in &c.functions {
            let theorems: Vec<(&formal_ast::Theorem, Option<String>)> = f
                .theorems
                .iter()
                .filter_map(|t| {
                    let (place, _) = t.split_once(' ')?;
                    let (file, line) = place.rsplit_once(':')?;
                    by_place.get(&(file.to_string(), line.parse().ok()?)).copied()
                })
                .map(|t| (t, src.as_deref().and_then(|s| module_of(s, root, &t.file, &libs))))
                .collect();
            for (t, m) in &theorems {
                if let Some(m) = m {
                    if !wanted.iter().any(|(q, _)| *q == t.qualified) {
                        wanted.push((t.qualified.clone(), m.clone()));
                    }
                }
            }
            per_fn.push((c, f, theorems));
        }
    }

    // Lean's word on each theorem: the last check while the sources are unchanged, else a new one.
    let sources = format!("{CHECK_VERSION}:{}", src.as_deref().map(sources_hash).unwrap_or_default());
    let fresh = ledger["checked"]["sources"].as_str() == Some(sources.as_str());
    let mut results: BTreeMap<String, Checked> = serde_json::from_value(ledger["checked"]["results"].clone()).unwrap_or_default();
    let missing = wanted.iter().any(|(q, _)| !results.contains_key(q));
    if check && !wanted.is_empty() && (force || !fresh || missing) {
        results = check_all(root, &wanted).await?;
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        // Read again before writing: an approval recorded while Lean ran (by the swarm, minutes) must not be lost.
        let checked = json!({ "at": at, "sources": sources, "results": results });
        ledger = load(root);
        ledger["checked"] = checked;
        save(root, &ledger);
    }
    let checked_now = ledger["checked"]["sources"].as_str() == Some(sources.as_str());

    let proofs_json: Value = std::fs::read_to_string(root.join(".formal/proofs.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    let mut entries = vec![];
    let (mut proved, mut total) = (0, 0);
    for (c, f, theorems) in per_fn {
        if f.lean.is_empty() || f.why.is_some() {
            entries.push(json!({ "function": f.name, "contract": c.name, "lean": f.lean, "status": "not_modeled", "why": f.why }));
            continue;
        }
        total += 1;
        let def_hash = hash(f.def.as_deref().unwrap_or(""));
        let mut reasons: Vec<String> = vec![];
        let rows: Vec<Value> = theorems
            .iter()
            .map(|(t, module)| {
                let r = results.get(&t.qualified);
                let extra: Vec<&String> = r.map(|r| r.axioms.iter().filter(|a| !STANDARD_AXIOMS.contains(&a.as_str())).collect()).unwrap_or_default();
                json!({
                    "theorem": t.qualified,
                    "file": t.file,
                    "line": t.line,
                    "doc": t.doc,
                    "module": module,
                    "built": module.is_some(),
                    "checked": r.map(|r| r.ok),
                    "type": r.map(|r| r.ty.clone()),
                    "axioms": r.map(|r| r.axioms.clone()),
                    "sorry": t.sorry || extra.iter().any(|a| *a == "sorryAx"),
                    "extraAxioms": extra,
                    "namesDef": r.is_some_and(|r| r.ty.contains(&f.lean)),
                    "covers": r.map(|r| covers(&r.ty, &f.lean)).unwrap_or_default(),
                    "error": r.and_then(|r| r.error.clone()),
                })
            })
            .collect();
        // Only theorems in modules Lake builds count, for and against: a scratch file outside the build neither proves
        // a function nor blocks one.
        let counted: Vec<&Value> = rows.iter().filter(|r| r["built"] == true).collect();
        if counted.is_empty() {
            reasons.push(if rows.is_empty() { "no theorem names its def".into() } else { "no theorem naming its def is in a module Lake builds".to_string() });
        }
        if !checked_now {
            reasons.push("not checked against the current sources yet".into());
        } else if counted.iter().any(|r| r["checked"] != true) {
            reasons.push("Lean doesn't check every theorem".into());
        }
        if counted.iter().any(|r| r["sorry"] == true) {
            reasons.push("a theorem depends on sorry".into());
        }
        if counted.iter().any(|r| r["extraAxioms"].as_array().is_some_and(|a| a.iter().any(|x| x != "sorryAx"))) {
            reasons.push("a theorem rests on an axiom beyond Lean's own".into());
        }
        if checked_now && !counted.is_empty() && !counted.iter().any(|r| r["namesDef"] == true) {
            reasons.push(format!("no checked theorem's statement mentions `{}`", f.lean));
        }
        // The reviewer's approval, for this def and these theorems as they are now.
        let texts: BTreeMap<String, String> = theorems.iter().filter(|(_, m)| m.is_some()).map(|(t, _)| (t.qualified.clone(), hash(&t.text))).collect();
        let review = ledger["reviews"][&f.lean].clone();
        let approved_for_now = review["verdict"] == "approve" && review["defHash"] == json!(def_hash) && serde_json::from_value::<BTreeMap<String, String>>(review["theorems"].clone()).ok().as_ref() == Some(&texts);
        // Proved before the ledger: ticked in the plan with what proved it recorded.
        let legacy = !approved_for_now && review.is_null() && plan.get(&f.lean).is_some_and(|m| m == "x") && proofs_json.as_object().is_some_and(|o| o.values().any(|p| p["item"].as_str().is_some_and(|i| i.contains(&format!("`{}`", f.lean)))));
        let review_state = if approved_for_now {
            "approved"
        } else if legacy {
            "approved before the ledger"
        } else if review["verdict"] == "approve" {
            "lapsed: the def or a theorem changed since it was approved"
        } else {
            "not reviewed"
        };
        if !approved_for_now && !legacy {
            reasons.push(format!("the reviewer's approval: {review_state}"));
        }
        // What the checked, built theorems cover together; fully proved needs reverts, writes and returns.
        let mut covered: Vec<String> = counted.iter().filter(|r| r["checked"] == true).flat_map(|r| r["covers"].as_array().cloned().unwrap_or_default()).filter_map(|c| c.as_str().map(String::from)).collect();
        covered.sort();
        covered.dedup();
        let missing: Vec<&str> = FULL.iter().copied().filter(|c| !covered.iter().any(|x| x == c)).collect();
        let is_proved = reasons.is_empty() && missing.is_empty();
        let partly = reasons.is_empty() && !missing.is_empty();
        if !missing.is_empty() {
            reasons.push(format!("covers {}; not yet {}", if covered.is_empty() { "nothing of its behaviour".to_string() } else { covered.join(", ") }, missing.join(", ")));
        }
        if is_proved {
            proved += 1;
        }
        entries.push(json!({
            "function": f.name,
            "contract": c.name,
            "lean": f.lean,
            "model": c.model,
            "defHash": def_hash,
            "status": if is_proved { "proved" } else if partly { "partly proved" } else if rows.is_empty() { "unproved" } else { "pending" },
            "covers": covered,
            "review": { "state": review_state, "at": review["at"], "notes": review["notes"] },
            "theorems": rows,
            "notYet": reasons,
        }));
    }
    Ok(json!({
        "folder": root,
        "proved": proved,
        "functions": total,
        "checked": { "at": ledger["checked"]["at"], "current": checked_now },
        "entries": entries,
    }))
}

/// The reviewer approved the proof of the plan item `item_text` names: recorded for its def and its theorems as they
/// are now, with the reviewer's notes.
pub fn approve(root: &Path, item_text: &str, notes: &str) {
    let Some(def) = item_text.split('`').nth(1) else { return };
    let ctx = crate::swarm_ctx::context_with(root, false);
    let Some(f) = ctx.contracts.iter().flat_map(|c| c.functions.iter()).find(|f| f.lean == def) else { return };
    let all = formal_ast::theorems(root);
    let (src, libs) = (crate::swarm_ctx::lean_src(root), lean_libs(root));
    let theorems: BTreeMap<String, String> = f
        .theorems
        .iter()
        .filter_map(|t| {
            let (place, _) = t.split_once(' ')?;
            let (file, line) = place.rsplit_once(':')?;
            let line: usize = line.parse().ok()?;
            all.iter().find(|x| x.file == file && x.line == line)
        })
        .filter(|t| src.as_deref().and_then(|s| module_of(s, root, &t.file, &libs)).is_some())
        .map(|t| (t.qualified.clone(), hash(&t.text)))
        .collect();
    let mut ledger = load(root);
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    ledger["reviews"][def] = json!({ "verdict": "approve", "at": at, "defHash": hash(f.def.as_deref().unwrap_or("")), "theorems": theorems, "notes": notes.chars().take(4000).collect::<String>() });
    save(root, &ledger);
}

/// The ledger, for the app's pages and the control API. `check` runs Lean when the sources changed; `force` always.
#[tauri::command(async)]
pub async fn swarm_ledger(folder: String, check: Option<bool>, force: Option<bool>) -> Result<Value, String> {
    if !crate::local::read()?.allows(&folder) {
        return Err("Add the folder first".into());
    }
    build(Path::new(&folder), check.unwrap_or(true), force.unwrap_or(false)).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn coverage_comes_from_the_statement() {
        let spec = "@S : ∀ … , Morpho.Morpho.setFeeRecipient ext r e w =\n if e.sender ≠ o then Except.error { reason := \"require\" } else Except.ok ((), ext.set w s)";
        assert_eq!(super::covers(spec, "Morpho.setFeeRecipient"), ["reverts", "writes", "returns"]);
        let conserve = "@C : … MorphoProofs.wp (Morpho.Morpho.supply ext p a s o d) (fun x w' => ∀ t, L.J ext w' t = L.J ext w t) e w";
        assert_eq!(super::covers(conserve, "Morpho.supply"), ["conservation"]);
        assert!(super::covers(conserve, "Morpho.borrow").is_empty());
        let exact = "@Z : ∀ … , MorphoProofs.wp (Morpho.UtilsLib.zeroFloorSub ext x y) Q e w ↔ Q (MorphoProofs.zfsv x y) w";
        assert_eq!(super::covers(exact, "UtilsLib.zeroFloorSub"), ["reverts", "writes", "returns"]);
    }

    #[test]
    fn hashes_are_stable() {
        assert_eq!(super::hash(""), "cbf29ce484222325");
        assert_eq!(super::hash("a"), "af63dc4c8601ec8c");
    }

    #[test]
    fn a_statement_mentioning_error_is_not_an_error() {
        assert!(!super::is_lean_error("  (e : FormalAst.Revert), WETH9.WETH9.approve ext guy wad env w ≠ Except.error e"));
        assert!(super::is_lean_error("/p/.formal/check/ledger.lean:4:7: error: unknown identifier 'x'"));
    }

    #[test]
    fn modules_are_built_only_inside_a_lib() {
        let root = std::path::Path::new("/p");
        let src = root.join("formal");
        let libs = std::collections::BTreeSet::from(["Refinement".to_string(), "Generated".to_string()]);
        assert_eq!(super::module_of(&src, root, "formal/Refinement/Swarm/WETH9Approve.lean", &libs).as_deref(), Some("Refinement.Swarm.WETH9Approve"));
        assert_eq!(super::module_of(&src, root, "formal/Scratch.lean", &libs), None);
        assert_eq!(super::module_of(&src, root, "src/Other.lean", &libs), None);
    }
}

#[cfg(test)]
mod probe {
    /// On a real folder: the ledger, then an approval and what it does, then a theorem change and what that does.
    /// `PROBE=<folder> [FORCE=1] [APPROVE=<plan item text>] cargo test --lib ledger::probe -- --ignored --nocapture`
    #[tokio::test(flavor = "current_thread")]
    #[ignore]
    async fn probe() {
        let root = std::path::PathBuf::from(std::env::var("PROBE").unwrap());
        if let Ok(item) = std::env::var("APPROVE") {
            super::approve(&root, &item, &std::env::var("NOTES").unwrap_or_else(|_| "approved by the ledger probe".into()));
        }
        let l = super::build(&root, true, std::env::var("FORCE").is_ok()).await.unwrap();
        println!("PROVED {} of {} | checked {}", l["proved"], l["functions"], l["checked"]);
        for e in l["entries"].as_array().unwrap().iter().filter(|e| e["status"] != "unproved").take(40) {
            println!("ENTRY {} [{}] review={} notYet={}", e["lean"], e["status"], e["review"]["state"], e["notYet"]);
        }
    }
}
