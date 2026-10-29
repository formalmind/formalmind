//! The proof ledger, `.formal/ledger.json` (SPEC.md §2.2, B31–B33, R3): whether each function in scope is proved, as
//! a fact the app derives and checks, never a mark an agent writes.
//!
//! A function is proved when at least one theorem naming its generated def sits in a module Lake builds, Lean checks
//! every such theorem (`#check @T`, `#print axioms T`) against the current sources with no `sorryAx` and no axiom
//! beyond Lean's own, one checked statement mentions the def, the reviewer's approval holds for the def's text and each
//! theorem's text as they are now, and together they cover `reverts`, `writes` and `returns`.
//!
//! The file: `{version, checked: {at, sources: "<CHECK_VERSION>:<hash>", results: {theorem: Checked}},
//! reviews: {"<lean def>": {verdict: "approve", at, defHash, theorems: {name: hash}, notes}}}`. Every write re-reads
//! the file first, so a check that ran for minutes never drops an approval recorded meanwhile (R8: a verdict, once
//! given, survives anything the app does after it, a quit included).
//!
//! The core ([`entries`], [`review_state`], [`covers`], [`parse_check`]) is pure: the inputs ([`Function`]) come from
//! formal-ast, Lean's output from a runner the caller passes, so every rule is tested without Lean.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::{Path, PathBuf};

use super::plan::{self, Mark, PlanItem};

/// The axioms Lean's own library uses; anything else (`sorryAx` above all) means the proof rests on an assumption.
pub const STANDARD_AXIOMS: [&str; 3] = ["propext", "Classical.choice", "Quot.sound"];
/// How the check is run and read: a change to either makes earlier results stale.
pub const CHECK_VERSION: &str = "3";
/// What a function's proof has to cover to count as fully proved.
pub const FULL: [&str; 3] = ["reverts", "writes", "returns"];
/// The reviewer's notes are kept up to this many characters.
pub const NOTES_LIMIT: usize = 4000;

/// Review states, as the Proofs page shows them.
pub const APPROVED: &str = "approved";
pub const NOT_REVIEWED: &str = "not reviewed";
pub const LAPSED_CHANGED: &str = "lapsed: the def or a theorem changed since it was approved";
pub const LAPSED_LEGACY: &str = "lapsed: proved before the ledger, with no record of the code it proved";

pub fn path(root: &Path) -> PathBuf {
    root.join(".formal").join("ledger.json")
}

/// FNV-1a, 64 bits, lower-case hex: stable across builds, so an approval doesn't lapse when the app is rebuilt.
pub fn hash(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---- the file ------------------------------------------------------------------------------------------------------

/// What Lean says about one theorem.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Checked {
    pub ok: bool,
    /// Its statement, as `#check` prints it.
    #[serde(default)]
    pub ty: String,
    #[serde(default)]
    pub axioms: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The whole file as JSON: unknown fields (and a malformed section) are kept as they are, so an older or newer build's
/// file round-trips. Missing or corrupt reads as an empty ledger.
fn load(root: &Path) -> Value {
    std::fs::read_to_string(path(root))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "version": 1 }))
}

/// Pretty JSON via `ledger.json.tmp` + rename.
fn save(root: &Path, v: &Value) -> std::io::Result<()> {
    let p = path(root);
    std::fs::create_dir_all(p.parent().unwrap())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(v).unwrap_or_default())?;
    std::fs::rename(&tmp, &p)
}

/// Re-reads the file, applies `f`, writes it back: the only way the ledger is written.
fn update(root: &Path, f: impl FnOnce(&mut Value)) -> std::io::Result<()> {
    let mut v = load(root);
    f(&mut v);
    save(root, &v)
}

/// The last check: its sources stamp and results (empty when there is none or it can't be read).
pub fn last_check(root: &Path) -> (Option<String>, BTreeMap<String, Checked>) {
    let v = load(root);
    let sources = v["checked"]["sources"].as_str().map(String::from);
    (sources, serde_json::from_value(v["checked"]["results"].clone()).unwrap_or_default())
}

/// Records a check's results for these sources, keeping every review (read again just before writing).
pub fn record_check(root: &Path, sources: &str, results: &BTreeMap<String, Checked>) -> std::io::Result<()> {
    let checked = json!({ "at": now_ms(), "sources": sources, "results": results });
    update(root, |v| v["checked"] = checked)
}

/// The reviewer's approval of `def` (B32): `{verdict, at, defHash, theorems{name: hash}, notes≤4000}`, for the def's
/// generated text and its counted theorems' texts as they are now.
pub fn approve(root: &Path, def: &str, def_text: &str, theorems: &BTreeMap<String, String>, notes: &str) -> std::io::Result<()> {
    let entry = json!({
        "verdict": "approve",
        "at": now_ms(),
        "defHash": hash(def_text),
        "theorems": theorems,
        "notes": notes.chars().take(NOTES_LIMIT).collect::<String>(),
    });
    update(root, |v| {
        if !v["reviews"].is_object() {
            v["reviews"] = json!({});
        }
        v["reviews"][def] = entry;
    })
}

/// The stored review of `def` (Null when there is none).
pub fn review(root: &Path, def: &str) -> Value {
    load(root)["reviews"][def].clone()
}

// ---- inputs --------------------------------------------------------------------------------------------------------

/// One theorem naming a function's def, as formal-ast scanned it.
#[derive(Clone, Debug, Default)]
pub struct Theorem {
    /// Its full name, what `#check` takes.
    pub qualified: String,
    pub file: String,
    pub line: usize,
    pub doc: Option<String>,
    /// Its proof still has a `sorry` in the source.
    pub sorry: bool,
    /// Its statement and proof as written; its hash is what an approval holds.
    pub text: String,
    /// The module it is in, when Lake builds it ([`module_of`]); only these count.
    pub module: Option<String>,
}

/// One function in scope.
#[derive(Clone, Debug, Default)]
pub struct Function {
    /// `Contract.name`
    pub name: String,
    pub contract: String,
    /// Its Lean def (empty when not modeled).
    pub lean: String,
    /// The def's generated text; its hash is what an approval holds.
    pub def: Option<String>,
    /// Why it is opaque in the model, if it is.
    pub why: Option<String>,
    pub model: Option<String>,
    /// Its theorems, statement proofs already left out ([`statement_proof`]).
    pub theorems: Vec<Theorem>,
}

impl Function {
    fn modeled(&self) -> bool {
        !self.lean.is_empty() && self.why.is_none()
    }

    /// The counted theorems' text hashes, by name: what an approval records and must match.
    pub fn theorem_hashes(&self) -> BTreeMap<String, String> {
        self.theorems.iter().filter(|t| t.module.is_some()).map(|t| (t.qualified.clone(), hash(&t.text))).collect()
    }
}

/// A statement's proof (`…/InformalSpecs/…`, `…/Statements/…`): the statement's record, not one of the function's own
/// theorems, so it neither proves a function nor lapses its approval.
pub fn statement_proof(file: &str) -> bool {
    file.replace('\\', "/").split('/').any(|p| p == "InformalSpecs" || p == "Statements")
}

/// The libraries the Lake project in `lake_dir` declares (`[[lean_lib]] name = …` in lakefile.toml, `lean_lib X` in
/// lakefile.lean).
pub fn lean_libs(lake_dir: &Path) -> BTreeSet<String> {
    let mut libs = BTreeSet::new();
    if let Ok(t) = std::fs::read_to_string(lake_dir.join("lakefile.toml")) {
        if let Ok(table) = t.parse::<toml::Table>() {
            for lib in table.get("lean_lib").and_then(|l| l.as_array()).into_iter().flatten() {
                if let Some(n) = lib.get("name").and_then(|n| n.as_str()) {
                    libs.insert(n.to_string());
                }
            }
        }
    }
    if let Ok(t) = std::fs::read_to_string(lake_dir.join("lakefile.lean")) {
        for l in t.lines().map(str::trim) {
            if let Some(rest) = l.strip_prefix("lean_lib ").or_else(|| l.strip_prefix("@[default_target] lean_lib ")) {
                libs.insert(rest.split_whitespace().next().unwrap_or("").trim_matches(['«', '»']).to_string());
            }
        }
    }
    libs
}

/// A folder-relative file's module under the Lake sources (`formal/Refinement/Swarm/X.lean` →
/// `Refinement.Swarm.X`), only when its first segment is a library Lake builds. `.` segments are dropped; `..`, an
/// absolute path or a segment Lean can't name is no module.
pub fn module_of(src: &Path, root: &Path, file: &str, libs: &BTreeSet<String>) -> Option<String> {
    let mut parts: Vec<String> = vec![];
    for c in Path::new(file).components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(p) => parts.push(p.to_string_lossy().to_string()),
            _ => return None,
        }
    }
    let src_parts: Vec<String> = src.strip_prefix(root).ok()?.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
    let inside = parts.strip_prefix(src_parts.as_slice())?;
    let (last, dirs) = inside.split_last()?;
    let name = last.strip_suffix(".lean")?;
    let names: Vec<&str> = dirs.iter().map(String::as_str).chain([name]).collect();
    if names.iter().any(|n| n.is_empty() || !n.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '\'')) {
        return None;
    }
    libs.contains(names[0]).then(|| names.join("."))
}

/// One hash over every `.lean` file under the sources (`.lake` and dot-folders skipped): a theorem's check depends on
/// everything it imports, so results are reused only while none of them changed. Stamped with [`CHECK_VERSION`].
pub fn sources_stamp(src: Option<&Path>) -> String {
    let Some(src) = src else { return format!("{CHECK_VERSION}:") };
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
    format!("{CHECK_VERSION}:{}", hash(&all))
}

// ---- checking with Lean --------------------------------------------------------------------------------------------

/// A line Lean prints for an error: `path:12:3: error: …`, or `error: …` on its own (a statement mentioning
/// `Except.error` is not one).
pub fn is_lean_error(line: &str) -> bool {
    line.starts_with("error:") || line.contains(": error:")
}

/// The scratch file that checks a module's theorems: an import, then per theorem a marker, `#check @T`,
/// `#print axioms T`.
pub fn check_file(module: &str, names: &[&str]) -> String {
    let mut file = format!("import {module}\n");
    for (i, name) in names.iter().enumerate() {
        file.push_str(&format!("#print \"fm-ledger {i}\"\n#check @{name}\n#print axioms {name}\n"));
    }
    file
}

/// Where a module's check file goes, folder-relative.
pub fn check_path(module: &str) -> String {
    format!(".formal/check/ledger-{}.lean", module.replace('.', "_"))
}

/// Reads `lake env lean <check file>`'s output into one result per theorem (by position in `names`). Nothing printed
/// after any marker means the module didn't load: every theorem fails with Lean's first errors.
pub fn parse_check(module: &str, names: &[&str], out: &str) -> BTreeMap<String, Checked> {
    let mut current: Option<usize> = None;
    let mut parts: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    let mut seen = false;
    for line in out.lines() {
        if let Some(i) = line.trim().strip_prefix("fm-ledger ").and_then(|n| n.parse::<usize>().ok()) {
            current = Some(i);
            seen = true;
            parts.entry(i).or_default();
            continue;
        }
        if let Some(i) = current {
            parts.entry(i).or_default().push(line.to_string());
        }
    }
    let mut results = BTreeMap::new();
    if !seen {
        let why: String = out.lines().filter(|l| is_lean_error(l)).take(6).collect::<Vec<_>>().join("\n");
        let error = if why.is_empty() { format!("Lean couldn't load {module}") } else { why };
        for n in names {
            results.insert(n.to_string(), Checked { ok: false, error: Some(error.clone()), ..Default::default() });
        }
        return results;
    }
    for (i, name) in names.iter().enumerate() {
        let lines = parts.remove(&i).unwrap_or_default();
        let text = lines.join("\n");
        let error = lines.iter().find(|l| is_lean_error(l)).cloned();
        let ty = lines.iter().take_while(|l| !l.contains("depends on axioms") && !l.contains("does not depend on any axioms")).cloned().collect::<Vec<_>>().join("\n").trim().to_string();
        let axioms: Vec<String> = text
            .split("depends on axioms:")
            .nth(1)
            .map(|r| r.split(']').next().unwrap_or("").trim_start_matches([' ', '[']).split(',').map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect())
            .unwrap_or_default();
        results.insert(name.to_string(), Checked { ok: error.is_none() && !ty.is_empty(), ty, axioms, error });
    }
    results
}

/// Whether a module's compiled file is at least as new as its source: `lake env lean` loads what Lake last built.
fn built(lake_dir: &Path, src: &Path, module: &str) -> Result<(), String> {
    let rel = module.replace('.', "/");
    let olean = lake_dir.join(".lake/build/lib/lean").join(format!("{rel}.olean"));
    let source = src.join(format!("{rel}.lean"));
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    match (modified(&olean), modified(&source)) {
        (None, _) => Err(format!("{module} hasn't built: `lake build {module}`")),
        (Some(o), Some(s)) if o < s => Err(format!("{module} changed since it last built: `lake build {module}`")),
        _ => Ok(()),
    }
}

/// Checks `(theorem, module)` pairs a module at a time (a module that doesn't load only takes its own theorems down).
/// `run` runs a command (`lake env lean <file>`) in the folder and returns its output.
pub async fn check_all<F, Fut>(root: &Path, theorems: &[(String, String)], run: F) -> Result<BTreeMap<String, Checked>, String>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = String>,
{
    let lake = super::lake::lake_dir(root).ok_or("there is no Lake project")?;
    let src = super::lake::lean_src(root).ok_or("there is no Lake project")?;
    std::fs::create_dir_all(root.join(".formal/check")).map_err(|e| e.to_string())?;
    let mut results = BTreeMap::new();
    let modules: BTreeSet<&String> = theorems.iter().map(|(_, m)| m).collect();
    for module in modules {
        let mine: Vec<&str> = theorems.iter().filter(|(_, m)| m == module).map(|(q, _)| q.as_str()).collect();
        if let Err(why) = built(&lake, &src, module) {
            for q in mine {
                results.insert(q.to_string(), Checked { ok: false, error: Some(why.clone()), ..Default::default() });
            }
            continue;
        }
        let check = check_path(module);
        std::fs::write(root.join(&check), check_file(module, &mine)).map_err(|e| e.to_string())?;
        let out = run(format!("lake env lean {check}")).await;
        results.extend(parse_check(module, &mine, &out));
    }
    Ok(results)
}

// ---- the rules -----------------------------------------------------------------------------------------------------

/// What a checked statement about `def` covers, read from its type as Lean prints it: `reverts` (`Except.error`),
/// `writes` (`ext.set`), `returns` (`Except.ok`), `conservation` (`L.J`, `.held`). An exact `wp (…) Q e w ↔ Q v w`
/// covers all three. Nothing when the type doesn't mention the def.
pub fn covers(ty: &str, def: &str) -> Vec<&'static str> {
    let mut out = vec![];
    if !ty.contains(def) {
        return out;
    }
    if ty.contains("wp (") && ty.contains("↔ Q ") && ty.trim_end().ends_with(" w") {
        return vec!["reverts", "writes", "returns"];
    }
    if ty.contains("Except.error") {
        out.push("reverts");
    }
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

/// Where the reviewer's approval of a def stands (B32): (holds for the def and theorems as they are now, the state
/// shown). `legacy_tick`: the plan has the def ticked `x` with no review in the ledger and proofs.json records it, a
/// tick from before the ledger. Nothing ever recorded which code such a tick proved (`record_proof` never wrote a
/// `defHash`), so it never holds: it goes back to the reviewer.
pub fn review_state(review: &Value, def_hash: &str, theorems: &BTreeMap<String, String>, legacy_tick: bool) -> (bool, &'static str) {
    let holds = review["verdict"] == "approve"
        && review["defHash"].as_str() == Some(def_hash)
        && serde_json::from_value::<BTreeMap<String, String>>(review["theorems"].clone()).ok().as_ref() == Some(theorems);
    let state = if holds {
        APPROVED
    } else if review.is_null() && legacy_tick {
        LAPSED_LEGACY
    } else if review["verdict"] == "approve" {
        LAPSED_CHANGED
    } else {
        NOT_REVIEWED
    };
    (holds, state)
}

/// What the ledger needs besides the functions: the stored reviews, Lean's results and whether they are for the
/// current sources, the plan's marks by def, and the defs proofs.json has a record for.
#[derive(Default)]
pub struct Facts {
    pub reviews: Value,
    pub results: BTreeMap<String, Checked>,
    pub checked_now: bool,
    pub marks: BTreeMap<String, Mark>,
    pub recorded: BTreeSet<String>,
}

/// One ledger entry per function, in order (B31), and how many are proved.
pub fn entries(functions: &[Function], facts: &Facts) -> (Vec<Value>, usize) {
    let mut out = vec![];
    let mut proved = 0;
    for f in functions {
        if !f.modeled() {
            out.push(json!({ "function": f.name, "contract": f.contract, "lean": f.lean, "status": "not_modeled", "why": f.why }));
            continue;
        }
        let def_hash = hash(f.def.as_deref().unwrap_or(""));
        let mut reasons: Vec<String> = vec![];
        let rows: Vec<Value> = f
            .theorems
            .iter()
            .map(|t| {
                let r = facts.results.get(&t.qualified);
                let extra: Vec<&String> = r.map(|r| r.axioms.iter().filter(|a| !STANDARD_AXIOMS.contains(&a.as_str())).collect()).unwrap_or_default();
                json!({
                    "theorem": t.qualified,
                    "file": t.file,
                    "line": t.line,
                    "doc": t.doc,
                    "module": t.module,
                    "built": t.module.is_some(),
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
        // Only theorems in modules Lake builds count, for and against.
        let counted: Vec<&Value> = rows.iter().filter(|r| r["built"] == true).collect();
        if counted.is_empty() {
            reasons.push(if rows.is_empty() { "no theorem names its def".into() } else { "no theorem naming its def is in a module Lake builds".into() });
        }
        if !facts.checked_now {
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
        if facts.checked_now && !counted.is_empty() && !counted.iter().any(|r| r["namesDef"] == true) {
            reasons.push(format!("no checked theorem's statement mentions `{}`", f.lean));
        }
        let review = facts.reviews[&f.lean].clone();
        let legacy_tick = facts.marks.get(&f.lean) == Some(&Mark::Proved) && facts.recorded.contains(&f.lean);
        let (holds, state) = review_state(&review, &def_hash, &f.theorem_hashes(), legacy_tick);
        if !holds {
            reasons.push(format!("the reviewer's approval: {state}"));
        }
        let mut covered: Vec<String> = counted.iter().filter(|r| r["checked"] == true).flat_map(|r| r["covers"].as_array().cloned().unwrap_or_default()).filter_map(|c| c.as_str().map(String::from)).collect();
        // A def that can't revert (no `throw`) or write (no `set`/`modify`) has nothing to show there once what it
        // returns is covered.
        let def_text = f.def.as_deref().unwrap_or("");
        if !def_text.is_empty() && covered.iter().any(|c| c == "returns") {
            if !def_text.contains("throw") {
                covered.push("reverts".into());
            }
            if !["set", "modify"].iter().any(|w| def_text.contains(w)) {
                covered.push("writes".into());
            }
        }
        covered.sort();
        covered.dedup();
        let missing: Vec<&str> = FULL.iter().copied().filter(|c| !covered.iter().any(|x| x == c)).collect();
        let is_proved = reasons.is_empty() && missing.is_empty();
        let partly = reasons.is_empty() && !missing.is_empty();
        if !missing.is_empty() {
            reasons.push(format!("covers {}; not yet {}", if covered.is_empty() { "nothing of its behaviour".to_string() } else { covered.join(", ") }, missing.join(", ")));
        }
        proved += is_proved as usize;
        out.push(json!({
            "function": f.name,
            "contract": f.contract,
            "lean": f.lean,
            "model": f.model,
            "defHash": def_hash,
            "status": if is_proved { "proved" } else if partly { "partly proved" } else if rows.is_empty() { "unproved" } else { "pending" },
            "covers": covered,
            "review": { "state": state, "at": review["at"], "notes": review["notes"] },
            "theorems": rows,
            "notYet": reasons,
        }));
    }
    (out, proved)
}

/// The defs `.formal/proofs.json` has a record for (`{"<n>": {item, files, summary, at}}`, the def being the item's
/// first backticked token). Any other shape, an older build's extra fields (`defHash`) included, is read without error
/// and ignored.
pub fn recorded_defs(root: &Path) -> BTreeSet<String> {
    let v: Value = std::fs::read_to_string(root.join(".formal/proofs.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    v.as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .filter_map(|p| p["item"].as_str())
        .filter_map(|i| i.split('`').nth(1).filter(|d| !d.is_empty()).map(String::from))
        .collect()
}

/// The ledger (B31) from given functions: Lean runs (through `run`) only when `check` and there's something to check
/// and the sources changed, a theorem has no result, or `force`. Returns the `swarm_ledger` value.
pub async fn build_with<F, Fut>(root: &Path, functions: &[Function], check: bool, force: bool, run: F) -> Result<Value, String>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = String>,
{
    let sources = sources_stamp(super::lake::lean_src(root).as_deref());
    let mut wanted: Vec<(String, String)> = vec![];
    for t in functions.iter().filter(|f| f.modeled()).flat_map(|f| &f.theorems) {
        if let Some(m) = &t.module {
            if !wanted.iter().any(|(q, _)| *q == t.qualified) {
                wanted.push((t.qualified.clone(), m.clone()));
            }
        }
    }
    let (stamp, mut results) = last_check(root);
    let fresh = stamp.as_deref() == Some(sources.as_str());
    let missing = wanted.iter().any(|(q, _)| !results.contains_key(q));
    let mut checked_now = fresh;
    if check && !wanted.is_empty() && (force || !fresh || missing) {
        results = check_all(root, &wanted, run).await?;
        record_check(root, &sources, &results).map_err(|e| e.to_string())?;
        checked_now = true;
    }
    let ledger = load(root);
    let facts = Facts {
        reviews: ledger["reviews"].clone(),
        results,
        checked_now,
        marks: plan::read(root).into_iter().filter_map(|i| Some((i.def()?.to_string(), i.mark))).collect(),
        recorded: recorded_defs(root),
    };
    let (list, proved) = entries(functions, &facts);
    Ok(json!({
        "folder": root,
        "proved": proved,
        "functions": list.iter().filter(|e| e["status"] != "not_modeled").count(),
        "checked": { "at": ledger["checked"]["at"], "current": checked_now },
        "entries": list,
    }))
}

// ---- reopening (B33) ----------------------------------------------------------------------------------------------

/// A proved plan item whose ledger entry isn't proved: its index, def and the first reason.
#[derive(Debug, PartialEq)]
pub struct Lapsed {
    pub index: usize,
    pub def: String,
    pub reason: String,
}

impl Lapsed {
    /// The `result` the chat gets: ``reopened `def`: <reason>``.
    pub fn message(&self) -> String {
        format!("reopened `{}`: {}", self.def, self.reason)
    }
}

/// Every `x` item whose def has a ledger entry that isn't `proved` (B33, R3). An item whose def isn't in the ledger at
/// all (out of scope now, or a hand-written line) is left as it is.
pub fn lapsed(items: &[PlanItem], ledger: &Value) -> Vec<Lapsed> {
    let by_def: BTreeMap<&str, &Value> = ledger["entries"].as_array().into_iter().flatten().filter_map(|e| Some((e["lean"].as_str()?, e))).collect();
    items
        .iter()
        .filter(|i| i.mark == Mark::Proved)
        .filter_map(|i| {
            let def = i.def()?;
            let e = by_def.get(def)?;
            (e["status"] != "proved").then(|| Lapsed {
                index: i.index,
                def: def.to_string(),
                reason: e["notYet"][0].as_str().unwrap_or("it isn't proved").to_string(),
            })
        })
        .collect()
}

/// Sets each lapsed item back to open in the folder's plan; returns what was reopened.
pub fn reopen_lapsed(root: &Path, ledger: &Value) -> std::io::Result<Vec<Lapsed>> {
    let found = lapsed(&plan::read(root), ledger);
    for l in &found {
        plan::set_mark(root, l.index, Mark::Open)?;
    }
    Ok(found)
}

/// The ledger's step of a plan sync (B15/B33): after a ledger result, the reopened items' messages; after a failure,
/// one message saying marks were left as they are.
pub fn sync_messages(root: &Path, ledger: Result<Value, String>) -> Vec<String> {
    match ledger.and_then(|l| reopen_lapsed(root, &l).map_err(|e| e.to_string())) {
        Ok(found) => found.iter().map(Lapsed::message).collect(),
        Err(e) => vec![format!("the ledger couldn't be built ({e}); the plan's marks are left as they are")],
    }
}

// ---- inputs from formal-ast ----------------------------------------------------------------------------------------

/// The functions in scope with their theorems, from the current formal-ast context (no models written). Glue until
/// the rebuilt `ast` module owns the context.
pub fn functions(root: &Path) -> Vec<Function> {
    let ctx = crate::swarm_ctx::context_with(root, false);
    let src = super::lake::lean_src(root);
    let libs = super::lake::lake_dir(root).map(|d| lean_libs(&d)).unwrap_or_default();
    let all = formal_ast::theorems(root);
    let by_place: BTreeMap<(&str, usize), &formal_ast::Theorem> = all.iter().map(|t| ((t.file.as_str(), t.line), t)).collect();
    let mut out = vec![];
    for c in &ctx.contracts {
        for f in &c.functions {
            let theorems = f
                .theorems
                .iter()
                .filter_map(|t| {
                    let (place, _) = t.split_once(' ')?;
                    let (file, line) = place.rsplit_once(':')?;
                    by_place.get(&(file, line.parse().ok()?)).copied()
                })
                .filter(|t| !statement_proof(&t.file))
                .map(|t| Theorem {
                    qualified: t.qualified.clone(),
                    file: t.file.clone(),
                    line: t.line,
                    doc: t.doc.clone(),
                    sorry: t.sorry,
                    text: t.text.clone(),
                    module: src.as_deref().and_then(|s| module_of(s, root, &t.file, &libs)),
                })
                .collect();
            out.push(Function { name: f.name.clone(), contract: c.name.clone(), lean: f.lean.clone(), def: f.def.clone(), why: f.why.clone(), model: c.model.clone(), theorems });
        }
    }
    out
}

/// `ledger::build(check, force)` (B31) on the folder as it is, Lean run through `run`.
pub async fn build<F, Fut>(root: &Path, check: bool, force: bool, run: F) -> Result<Value, String>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = String>,
{
    build_with(root, &functions(root), check, force, run).await
}

/// The reviewer approved the plan item `item_text` names (B18/B32): recorded for its def and counted theorems as they
/// are now. Err when the item names no function in scope.
pub fn approve_item(root: &Path, item_text: &str, notes: &str) -> Result<(), String> {
    let def = item_text.split('`').nth(1).filter(|d| !d.is_empty()).ok_or("the item names no def")?;
    let fns = functions(root);
    let f = fns.iter().find(|f| f.lean == def).ok_or_else(|| format!("`{def}` isn't a function in scope"))?;
    approve(root, def, f.def.as_deref().unwrap_or(""), &f.theorem_hashes(), notes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("fm2-ledger-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".formal")).unwrap();
        root
    }

    const DEF: &str = "def Pool.fee (ext) (w) : Except Revert (Nat × World) := if w.x = 0 then throw r else pure (1, ext.set w 1)";
    const TY: &str = "@fee_spec : ∀ ext w, Pool.fee ext w = if w.x = 0 then Except.error r else Except.ok (1, ext.set w 1)";

    fn pool_fee(theorem_text: &str) -> Function {
        Function {
            name: "Pool.fee".into(),
            contract: "Pool".into(),
            lean: "Pool.fee".into(),
            def: Some(DEF.into()),
            theorems: vec![Theorem { qualified: "fee_spec".into(), file: "formal/Proofs/PoolFee.lean".into(), line: 3, text: theorem_text.into(), module: Some("Proofs.PoolFee".into()), ..Default::default() }],
            ..Default::default()
        }
    }

    fn checked_ok() -> BTreeMap<String, Checked> {
        BTreeMap::from([("fee_spec".to_string(), Checked { ok: true, ty: TY.into(), axioms: vec!["propext".into()], error: None })])
    }

    fn approved_for(f: &Function) -> Value {
        json!({ "Pool.fee": { "verdict": "approve", "at": 1, "defHash": hash(f.def.as_deref().unwrap()), "theorems": f.theorem_hashes(), "notes": "ok" } })
    }

    fn facts(reviews: Value) -> Facts {
        Facts { reviews, results: checked_ok(), checked_now: true, ..Default::default() }
    }

    #[test]
    fn hashes_are_stable() {
        assert_eq!(hash(""), "cbf29ce484222325");
        assert_eq!(hash("a"), "af63dc4c8601ec8c");
    }

    #[test]
    fn coverage_comes_from_the_statement() {
        let spec = "@S : ∀ … , Morpho.Morpho.setFeeRecipient ext r e w =\n if e.sender ≠ o then Except.error { reason := \"require\" } else Except.ok ((), ext.set w s)";
        assert_eq!(covers(spec, "Morpho.setFeeRecipient"), ["reverts", "writes", "returns"]);
        let conserve = "@C : … MorphoProofs.wp (Morpho.Morpho.supply ext p a s o d) (fun x w' => ∀ t, L.J ext w' t = L.J ext w t) e w";
        assert_eq!(covers(conserve, "Morpho.supply"), ["conservation"]);
        assert!(covers(conserve, "Morpho.borrow").is_empty());
        let exact = "@Z : ∀ … , MorphoProofs.wp (Morpho.UtilsLib.zeroFloorSub ext x y) Q e w ↔ Q (MorphoProofs.zfsv x y) w";
        assert_eq!(covers(exact, "UtilsLib.zeroFloorSub"), ["reverts", "writes", "returns"]);
    }

    #[test]
    fn a_statement_mentioning_error_is_not_an_error() {
        assert!(!is_lean_error("  (e : FormalAst.Revert), WETH9.WETH9.approve ext guy wad env w ≠ Except.error e"));
        assert!(is_lean_error("/p/.formal/check/ledger.lean:4:7: error: unknown identifier 'x'"));
    }

    #[test]
    fn modules_are_built_only_inside_a_lib() {
        let root = Path::new("/p");
        let src = root.join("formal");
        let libs = BTreeSet::from(["Refinement".to_string(), "Generated".to_string()]);
        assert_eq!(module_of(&src, root, "formal/Refinement/Swarm/WETH9Approve.lean", &libs).as_deref(), Some("Refinement.Swarm.WETH9Approve"));
        assert_eq!(module_of(&src, root, "formal/./Refinement/X.lean", &libs).as_deref(), Some("Refinement.X"));
        assert_eq!(module_of(&src, root, "formal/Refinement/../X.lean", &libs), None);
        assert_eq!(module_of(&src, root, "formal/Scratch.lean", &libs), None);
        assert_eq!(module_of(&src, root, "src/Other.lean", &libs), None);
    }

    #[test]
    fn lake_libraries_come_from_either_lakefile() {
        let root = folder("libs");
        std::fs::write(root.join("lakefile.toml"), "name = \"p\"\n[[lean_lib]]\nname = \"Specs\"\n[[lean_lib]]\nname = \"Proofs\"\n").unwrap();
        std::fs::write(root.join("lakefile.lean"), "import Lake\n@[default_target] lean_lib «Generated» where\nlean_lib Refinement\n").unwrap();
        assert_eq!(lean_libs(&root).into_iter().collect::<Vec<_>>(), ["Generated", "Proofs", "Refinement", "Specs"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn statement_proofs_are_not_a_functions_theorems() {
        assert!(statement_proof("formal/Proofs/InformalSpecs/S01/A.lean"));
        assert!(statement_proof("formal\\Statements\\S01.lean"));
        assert!(!statement_proof("formal/Proofs/Functions/PoolFee.lean"));
    }

    #[test]
    fn lean_output_is_read_per_theorem() {
        let out = "exit 0\nfm-ledger 0\n@a : Pool.fee = 1\n'a' depends on axioms: [propext, sorryAx]\nfm-ledger 1\nX.lean:3:1: error: unknown identifier 'b'\n";
        let r = parse_check("M", &["a", "b"], out);
        assert_eq!(r["a"], Checked { ok: true, ty: "@a : Pool.fee = 1".into(), axioms: vec!["propext".into(), "sorryAx".into()], error: None });
        assert!(!r["b"].ok && r["b"].error.as_deref().unwrap().contains("unknown identifier"));
        let none = parse_check("M", &["a"], "exit 1\nX.lean:1:0: error: unknown module prefix 'M'\n");
        assert_eq!(none["a"].error.as_deref(), Some("X.lean:1:0: error: unknown module prefix 'M'"));
        assert_eq!(parse_check("M", &["a"], "")["a"].error.as_deref(), Some("Lean couldn't load M"));
        assert_eq!(check_file("Proofs.X", &["a"]), "import Proofs.X\n#print \"fm-ledger 0\"\n#check @a\n#print axioms a\n");
        assert_eq!(check_path("Proofs.X"), ".formal/check/ledger-Proofs_X.lean");
    }

    #[test]
    fn b31_proved_needs_every_condition() {
        let f = pool_fee("theorem fee_spec : … := by simp");
        let (e, n) = entries(&[f.clone()], &facts(approved_for(&f)));
        assert_eq!((n, e[0]["status"].as_str()), (1, Some("proved")), "{}", e[0]);
        assert_eq!(e[0]["review"]["state"], APPROVED);
        // Each missing condition, alone, keeps it from proved, with its reason.
        let reason = |f: &Function, facts: &Facts| entries(&[f.clone()], facts).0[0]["notYet"][0].as_str().unwrap().to_string();
        assert_eq!(reason(&f, &Facts { checked_now: false, ..facts(approved_for(&f)) }), "not checked against the current sources yet");
        assert_eq!(reason(&f, &facts(json!({}))), "the reviewer's approval: not reviewed");
        let mut sorry = facts(approved_for(&f));
        sorry.results.get_mut("fee_spec").unwrap().axioms.push("sorryAx".into());
        assert_eq!(reason(&f, &sorry), "a theorem depends on sorry");
        let mut extra = facts(approved_for(&f));
        extra.results.get_mut("fee_spec").unwrap().axioms.push("Foo.trustMe".into());
        assert_eq!(reason(&f, &extra), "a theorem rests on an axiom beyond Lean's own");
        let mut unbuilt = f.clone();
        unbuilt.theorems[0].module = None;
        assert_eq!(reason(&unbuilt, &facts(approved_for(&unbuilt))), "no theorem naming its def is in a module Lake builds");
        let mut none = f.clone();
        none.theorems.clear();
        assert_eq!(entries(&[none.clone()], &facts(approved_for(&none))).0[0]["status"], "unproved");
        let mut other = facts(approved_for(&f));
        other.results.get_mut("fee_spec").unwrap().ty = "@fee_spec : True".into();
        assert_eq!(reason(&f, &other), "no checked theorem's statement mentions `Pool.fee`");
        // Opaque functions aren't counted.
        let opaque = Function { name: "Pool.asm".into(), why: Some("inline assembly".into()), lean: "Pool.asm".into(), ..Default::default() };
        let (e, _) = entries(&[opaque], &facts(json!({})));
        assert_eq!((e[0]["status"].as_str(), e[0]["why"].as_str()), (Some("not_modeled"), Some("inline assembly")));
    }

    #[test]
    fn b31_partly_proved_until_reverts_writes_and_returns_are_covered() {
        let f = pool_fee("t");
        let mut only_reverts = facts(approved_for(&f));
        only_reverts.results.get_mut("fee_spec").unwrap().ty = "@fee_spec : ∀ w, w.x = 0 → Pool.fee ext w = Except.error r".into();
        let e = &entries(&[f.clone()], &only_reverts).0[0];
        assert_eq!(e["status"], "partly proved");
        assert_eq!(e["notYet"][0], "covers reverts; not yet writes, returns");
        // A def with no throw and no set: returns covers it.
        let pure_def = Function { def: Some("def Pool.fee (w) := pure 1".into()), ..f.clone() };
        let mut returns = facts(approved_for(&pure_def));
        returns.results.get_mut("fee_spec").unwrap().ty = "@fee_spec : Pool.fee w = Except.ok 1".into();
        assert_eq!(entries(&[pure_def], &returns).0[0]["status"], "proved");
    }

    #[test]
    fn b32_an_approval_holds_for_the_code_not_the_mark() {
        let f = pool_fee("theorem fee_spec : … := by simp");
        let texts = f.theorem_hashes();
        let review = approved_for(&f)["Pool.fee"].clone();
        let def_hash = hash(DEF);
        assert_eq!(review_state(&review, &def_hash, &texts, false), (true, APPROVED));
        // The def changed, or a theorem's text did: lapsed.
        assert_eq!(review_state(&review, &hash("def Pool.fee := 2"), &texts, false), (false, LAPSED_CHANGED));
        let changed = pool_fee("theorem fee_spec : … := by simp; rfl").theorem_hashes();
        assert_eq!(review_state(&review, &def_hash, &changed, false), (false, LAPSED_CHANGED));
        // A new theorem naming the def lapses it too.
        let mut more = texts.clone();
        more.insert("fee_more".into(), hash("x"));
        assert_eq!(review_state(&review, &def_hash, &more, false).1, LAPSED_CHANGED);
        assert_eq!(review_state(&Value::Null, &def_hash, &texts, false), (false, NOT_REVIEWED));
    }

    #[test]
    fn a_legacy_tick_goes_back_to_the_reviewer() {
        // Ticked in the plan, recorded in proofs.json (even with the defHash no build wrote), never reviewed in the
        // ledger: it doesn't hold, whatever the record says.
        let root = folder("legacy");
        std::fs::write(
            root.join(".formal/proofs.json"),
            r#"{ "3": { "item": "`Pool.fee` — Pool (src/Pool.sol:4)", "files": [], "summary": "s", "at": "1", "defHash": "whatever" }, "S-01": { "1": { "theorem": "t" } }, "bad": 7 }"#,
        )
        .unwrap();
        assert_eq!(recorded_defs(&root), BTreeSet::from(["Pool.fee".to_string()]));
        std::fs::write(root.join(".formal/proofs.json"), "not json").unwrap();
        assert!(recorded_defs(&root).is_empty(), "an unreadable file is no records, not an error");
        let f = pool_fee("t");
        let legacy = Facts { marks: BTreeMap::from([("Pool.fee".into(), Mark::Proved)]), recorded: BTreeSet::from(["Pool.fee".into()]), ..facts(json!({})) };
        let e = &entries(&[f.clone()], &legacy).0[0];
        assert_eq!((e["status"].as_str(), e["review"]["state"].as_str()), (Some("pending"), Some(LAPSED_LEGACY)));
        assert_eq!(review_state(&Value::Null, &hash(DEF), &f.theorem_hashes(), true), (false, LAPSED_LEGACY));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_verdict_survives_a_quit_and_a_check() {
        let root = folder("persist");
        let f = pool_fee("t");
        approve(&root, "Pool.fee", DEF, &f.theorem_hashes(), &"n".repeat(5000)).unwrap();
        // A check that started before the approval writes its results: the approval is still there.
        record_check(&root, "3:abc", &checked_ok()).unwrap();
        // As after a quit: read back from disk.
        let r = review(&root, "Pool.fee");
        assert_eq!((r["verdict"].as_str(), r["defHash"].as_str()), (Some("approve"), Some(hash(DEF).as_str())));
        assert_eq!(r["notes"].as_str().unwrap().chars().count(), NOTES_LIMIT);
        assert_eq!(last_check(&root), (Some("3:abc".into()), checked_ok()));
        assert!(!root.join(".formal/ledger.json.tmp").exists());
        // Unknown fields survive both writes; a corrupt file reads as empty.
        let mut v: Value = serde_json::from_str(&std::fs::read_to_string(path(&root)).unwrap()).unwrap();
        v["future"] = json!(1);
        std::fs::write(path(&root), v.to_string()).unwrap();
        approve(&root, "Pool.other", "d", &BTreeMap::new(), "").unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path(&root)).unwrap()).unwrap();
        assert_eq!((v["future"].as_i64(), v["reviews"].as_object().unwrap().len()), (Some(1), 2));
        std::fs::write(path(&root), "{").unwrap();
        assert_eq!(review(&root, "Pool.fee"), Value::Null);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lapsed() {
        let items = plan::parse("- [x] `Pool.fee` — a\n- [x] `Pool.ok` — b\n- [ ] `Pool.open` — c\n- [x] `Gone.f` — d\n");
        let ledger = json!({ "entries": [
            { "lean": "Pool.fee", "status": "pending", "notYet": ["the reviewer's approval: lapsed: the def or a theorem changed since it was approved"] },
            { "lean": "Pool.ok", "status": "proved", "notYet": [] },
            { "lean": "Pool.open", "status": "unproved", "notYet": ["no theorem names its def"] },
        ] });
        let found = super::lapsed(&items, &ledger);
        assert_eq!(found, vec![Lapsed { index: 1, def: "Pool.fee".into(), reason: "the reviewer's approval: lapsed: the def or a theorem changed since it was approved".into() }]);
        assert_eq!(found[0].message(), "reopened `Pool.fee`: the reviewer's approval: lapsed: the def or a theorem changed since it was approved");
    }

    #[test]
    fn changed_functions_are_reopened() {
        // R3: approved and ticked, then the def changes; the next plan sync reopens it with the reason.
        let root = folder("reopen");
        std::fs::write(plan::path(&root), "# Plan\n\n- [x] `Pool.fee` — Pool (src/Pool.sol:4)\n  - [X] `Pool.ok` — Pool\n").unwrap();
        let f = pool_fee("t");
        approve(&root, "Pool.fee", DEF, &f.theorem_hashes(), "ok").unwrap();
        let ok = Function { name: "Pool.ok".into(), lean: "Pool.ok".into(), def: Some("def Pool.ok := pure 1".into()), theorems: vec![], ..f.clone() };
        let changed = Function { def: Some(format!("{DEF} -- edited")), ..f.clone() };
        let reviews = load(&root)["reviews"].clone();
        let (list, _) = entries(&[changed, ok], &Facts { reviews, results: checked_ok(), checked_now: true, ..Default::default() });
        let msgs = sync_messages(&root, Ok(json!({ "entries": list })));
        assert_eq!(msgs, ["reopened `Pool.fee`: the reviewer's approval: lapsed: the def or a theorem changed since it was approved", "reopened `Pool.ok`: no theorem names its def"]);
        let text = std::fs::read_to_string(plan::path(&root)).unwrap();
        assert_eq!(text, "# Plan\n\n- [ ] `Pool.fee` — Pool (src/Pool.sol:4)\n  - [ ] `Pool.ok` — Pool\n");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn b33_a_ledger_failure_leaves_the_marks() {
        let root = folder("fail");
        let plan_text = "- [x] `Pool.fee` — a\n";
        std::fs::write(plan::path(&root), plan_text).unwrap();
        let msgs = sync_messages(&root, Err("there is no Lake project".into()));
        assert_eq!(msgs, ["the ledger couldn't be built (there is no Lake project); the plan's marks are left as they are"]);
        assert_eq!(std::fs::read_to_string(plan::path(&root)).unwrap(), plan_text);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn b31_lean_reruns_only_when_needed() {
        let root = folder("rerun");
        let lake = root.join("formal");
        std::fs::create_dir_all(lake.join("Proofs")).unwrap();
        std::fs::write(lake.join("lakefile.toml"), "name = \"p\"\n[[lean_lib]]\nname = \"Proofs\"\n").unwrap();
        std::fs::write(lake.join("Proofs/PoolFee.lean"), "theorem fee_spec : True := trivial\n").unwrap();
        // Built after the source.
        std::fs::create_dir_all(lake.join(".lake/build/lib/lean/Proofs")).unwrap();
        std::fs::write(lake.join(".lake/build/lib/lean/Proofs/PoolFee.olean"), "").unwrap();
        let runs = std::cell::Cell::new(0);
        let run = |cmd: String| {
            runs.set(runs.get() + 1);
            assert_eq!(cmd, "lake env lean .formal/check/ledger-Proofs_PoolFee.lean");
            async move { format!("fm-ledger 0\n{TY}\n'fee_spec' depends on axioms: [propext]\n") }
        };
        let f = pool_fee("t");
        approve(&root, "Pool.fee", DEF, &f.theorem_hashes(), "ok").unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let l = rt.block_on(build_with(&root, &[f.clone()], true, false, &run)).unwrap();
        assert_eq!((runs.get(), l["proved"].as_u64(), l["checked"]["current"].as_bool()), (1, Some(1), Some(true)), "{l}");
        rt.block_on(build_with(&root, &[f.clone()], true, false, &run)).unwrap();
        assert_eq!(runs.get(), 1, "same sources: the last check stands");
        rt.block_on(build_with(&root, &[f.clone()], true, true, &run)).unwrap();
        assert_eq!(runs.get(), 2, "force");
        std::fs::write(lake.join("Proofs/PoolFee.lean"), "theorem fee_spec : True := by trivial\n").unwrap();
        let l = rt.block_on(build_with(&root, &[f.clone()], false, false, &run)).unwrap();
        assert_eq!((runs.get(), l["checked"]["current"].as_bool()), (2, Some(false)), "without check, a stale check is only reported");
        assert_eq!(review(&root, "Pool.fee")["verdict"], "approve", "checks never drop the approval");
        std::fs::remove_dir_all(root).unwrap();
    }
}
