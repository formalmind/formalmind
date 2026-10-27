//! Compiling with solc, and nothing else: `solc --standard-json`, AST and storage layout only.
//!
//! Follows the language server's approach (asyncswap/solidity-language-server `src/solc.rs`): the version comes from
//! foundry.toml or the pragma, remappings from the project's files, and the output selection asks for no bytecode,
//! so a large protocol compiles in a fraction of a second. There is no forge fallback: a solc error is returned as
//! is, and nothing is built from a partial AST.
//!
//! Building solc's input ([`input`]) and reading its output ([`check`]) are apart from running it ([`compile`]): the
//! website runs solc-js in the browser on the same input.

use crate::fs::{Disk, Files};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// What foundry.toml says about compiling, read directly (no `forge` call).
#[derive(Clone)]
pub struct Project {
    /// The folder on disk; empty when the files are in memory.
    pub root: PathBuf,
    /// The project's files.
    pub files: Arc<dyn Files>,
    pub solc_version: Option<String>,
    pub evm_version: Option<String>,
    pub remappings: Vec<String>,
    /// Library folders (foundry.toml `libs`, default `lib`): code there is a trusted dependency.
    pub libs: Vec<String>,
    /// The active profile's source and test folders (`src`, `test` by default).
    pub src: String,
    pub test: String,
}

impl Project {
    pub fn load(root: &Path) -> Result<Self> {
        let root = root.canonicalize().with_context(|| format!("no such folder: {}", root.display()))?;
        Project::from_files(root.clone(), Arc::new(Disk(root)))
    }

    /// A project whose files come from `files` (`root` is only kept for callers that write next to them).
    pub fn from_files(root: PathBuf, files: Arc<dyn Files>) -> Result<Self> {
        let mut project = Project { root, files: files.clone(), solc_version: None, evm_version: None, remappings: vec![], libs: vec![], src: "src".into(), test: "test".into() };
        if let Some(text) = files.read("foundry.toml") {
            toml::from_str::<toml::Table>(&text).context("foundry.toml doesn't parse")?;
            // The active profile (FOUNDRY_PROFILE) over the default one, as forge reads it.
            let p = crate::foundry::profile(&text).unwrap_or_default();
            let profile = Some(&p);
            let get = |k: &str| crate::foundry::get_str(&p, k);
            project.solc_version = get("solc_version").or_else(|| get("solc"));
            project.evm_version = get("evm_version");
            if let Some(src) = get("src") {
                project.src = src.trim_end_matches('/').to_string();
            }
            if let Some(test) = get("test") {
                project.test = test.trim_end_matches('/').to_string();
            }
            if let Some(list) = profile.and_then(|p| p.get("libs")).and_then(|v| v.as_array()) {
                project.libs.extend(list.iter().filter_map(|v| v.as_str()).map(str::to_string));
            }
            if let Some(list) = profile.and_then(|p| p.get("remappings")).and_then(|v| v.as_array()) {
                project.remappings.extend(list.iter().filter_map(|v| v.as_str()).map(str::to_string));
            }
        }
        if let Some(text) = files.read("remappings.txt") {
            for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
                // foundry.toml wins when both name the same prefix.
                let prefix = line.split('=').next().unwrap_or("");
                if !project.remappings.iter().any(|r| r.split('=').next() == Some(prefix)) {
                    project.remappings.push(line.to_string());
                }
            }
        }
        // Like forge, a remapping between folders ends in `/` on both sides (`v4-core/=dependencies/v4-core/src` →
        // `…/src/`); solc takes them literally and would look for `dependencies/v4-core/srctypes/…`.
        for r in &mut project.remappings {
            *r = normalize_remapping(r);
        }
        if project.libs.is_empty() {
            project.libs.push("lib".into());
        }
        // forge's automatic remappings, after the declared ones: each library folder's `name/` to its `src/` (or the
        // folder), then the libraries inside those (forge-std's own `lib/ds-test`).
        for lib in project.libs.clone() {
            let mut dirs: Vec<String> = files.read_dir(&lib).into_iter().filter(|(_, dir)| *dir).map(|(name, _)| name).collect();
            dirs.sort();
            let mut nested = vec![];
            for dep in &dirs {
                project.auto_remap(&format!("{lib}/{dep}"), dep);
                let inner = format!("{lib}/{dep}/lib");
                let mut more: Vec<String> = files.read_dir(&inner).into_iter().filter(|(_, dir)| *dir).map(|(name, _)| name).collect();
                more.sort();
                nested.extend(more.into_iter().map(|n| (format!("{inner}/{n}"), n)));
            }
            for (path, name) in nested {
                project.auto_remap(&path, &name);
            }
        }
        // A dependency's own remappings.txt, scoped to imports from inside it (forge does the same): v4-core's
        // `solmate/=lib/solmate/` becomes `dependencies/v4-core/:solmate/=dependencies/v4-core/lib/solmate/`.
        for lib in project.libs.clone() {
            let mut dirs: Vec<String> = files.read_dir(&lib).into_iter().map(|(name, _)| name).collect();
            dirs.sort();
            for dep in dirs {
                let Some(text) = files.read(&format!("{lib}/{dep}/remappings.txt")) else { continue };
                let base = format!("{lib}/{dep}/");
                for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#') && !l.contains(':')) {
                    if let Some((from, to)) = line.split_once('=') {
                        if files.exists(&format!("{base}{to}")) {
                            project.remappings.push(normalize_remapping(&format!("{base}:{from}={base}{to}")));
                        }
                    }
                }
            }
        }
        Ok(project)
    }
}

impl Project {
    /// `name/=path/src/` (or `path/`) unless a remapping already claims `name/`.
    fn auto_remap(&mut self, path: &str, name: &str) {
        let prefix = format!("{name}/");
        if self.remappings.iter().any(|r| r.split(':').next_back().unwrap_or(r).split('=').next() == Some(prefix.as_str())) {
            return;
        }
        let to = if self.files.exists(&format!("{path}/src")) { format!("{path}/src/") } else { format!("{path}/") };
        self.remappings.push(format!("{prefix}={to}"));
    }
}

/// `[context:]from=to` with a trailing `/` added to both sides when `from` names a folder (ends in `/`).
fn normalize_remapping(r: &str) -> String {
    let (ctx, rest) = match r.split_once(':') {
        Some((c, rest)) if !c.contains('=') => (format!("{c}:"), rest),
        _ => (String::new(), r),
    };
    let Some((from, to)) = rest.split_once('=') else { return r.to_string() };
    if from.ends_with('/') && !to.is_empty() && !to.ends_with('/') {
        format!("{ctx}{from}={to}/")
    } else {
        r.to_string()
    }
}

/// The solc binary for a version: svm's install folder, then `solc` on PATH if its version matches (or none was asked).
#[cfg(not(target_arch = "wasm32"))]
pub fn solc_binary(version: Option<&str>) -> Result<PathBuf> {
    use std::process::Command;
    let home = std::env::var("HOME").unwrap_or_default();
    if let Some(v) = version {
        for dir in [format!("{home}/Library/Application Support/svm"), format!("{home}/.svm"), format!("{home}/.local/share/svm")] {
            let bin = PathBuf::from(&dir).join(v).join(format!("solc-{v}"));
            if bin.exists() {
                return Ok(bin);
            }
        }
    }
    let out = Command::new("solc").arg("--version").output();
    match (out, version) {
        (Ok(o), Some(v)) if String::from_utf8_lossy(&o.stdout).contains(&format!("Version: {v}+")) => Ok("solc".into()),
        (Ok(_), None) => Ok("solc".into()),
        (_, Some(v)) => bail!("solc {v} isn't installed; install it with `svm install {v}`"),
        (Err(_), None) => bail!("no solc found; install one with `svm install <version>`"),
    }
}

/// The version an entry file asks for, when foundry.toml doesn't pin one: an exact `pragma solidity =x.y.z` / `x.y.z`.
pub fn pragma_version(source: &str) -> Option<String> {
    let line = source.lines().find(|l| l.trim_start().starts_with("pragma solidity"))?;
    let spec = line.trim().trim_start_matches("pragma solidity").trim().trim_end_matches(';').trim();
    let exact = spec.trim_start_matches('=');
    exact.chars().all(|c| c.is_ascii_digit() || c == '.').then(|| exact.to_string())
}

/// What to compile for one entry file: solc's standard JSON input (AST and storage layout only) and the version to
/// compile it with (foundry.toml's, else the entry's exact pragma; None takes whatever solc there is). The entry is
/// given by `urls`, so solc reads it and its imports itself (natively from the root, solc-js through its callback).
pub fn input(project: &Project, entry: &str) -> Result<(Value, Option<String>)> {
    let entry_source = project.files.read(entry).with_context(|| format!("can't read {entry}"))?;
    let version = project.solc_version.clone().or_else(|| pragma_version(&entry_source));
    let mut settings = json!({
        "remappings": project.remappings,
        "outputSelection": { "*": { "*": ["storageLayout"], "": ["ast"] } },
    });
    if let Some(evm) = &project.evm_version {
        settings["evmVersion"] = json!(evm);
    }
    Ok((json!({ "language": "Solidity", "sources": { entry: { "urls": [entry] } }, "settings": settings }), version))
}

/// solc's output, or its errors as one: nothing is built from a partial AST.
pub fn check(output: Value, entry: &str) -> Result<Value> {
    let errors: Vec<String> = output["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["severity"] == "error")
        .map(|e| e["formattedMessage"].as_str().unwrap_or("").trim().to_string())
        .collect();
    if !errors.is_empty() {
        bail!("solc failed to compile {entry}:\n{}", errors.join("\n\n"));
    }
    let pre_08 = pragmas_rule_out_08(&output);
    let output = normalize_builtins(output);
    Ok(if pre_08 { unchecked_bodies(output) } else { output })
}

/// Before 0.8, Solidity's arithmetic wraps instead of reverting. The model reads every function and modifier body as
/// `unchecked { … }`, which is what such code means.
pub fn unchecked_bodies(mut output: Value) -> Value {
    fn walk(n: &mut Value) {
        match n {
            Value::Object(m) => {
                if matches!(m.get("nodeType").and_then(Value::as_str), Some("FunctionDefinition" | "ModifierDefinition")) {
                    if let Some(body) = m.get_mut("body").filter(|b| b["nodeType"] == "Block") {
                        body["nodeType"] = json!("UncheckedBlock");
                    }
                }
                m.values_mut().for_each(walk);
            }
            Value::Array(a) => a.iter_mut().for_each(walk),
            _ => {}
        }
    }
    walk(&mut output["sources"]);
    output
}

/// Whether some file's `pragma solidity` admits no 0.8 or later compiler, so the code was compiled before 0.8.
fn pragmas_rule_out_08(output: &Value) -> bool {
    let mut pragmas = vec![];
    for source in output["sources"].as_object().into_iter().flatten().map(|(_, s)| s) {
        for n in source["ast"]["nodes"].as_array().into_iter().flatten() {
            let lits: Vec<&str> = n["literals"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            if n["nodeType"] == "PragmaDirective" && lits.first() == Some(&"solidity") {
                pragmas.push(lits[1..].concat());
            }
        }
    }
    let modern = (0..=50).map(|p| [0, 8, p]).chain([[0, 9, 0], [1, 0, 0]]);
    pragmas.iter().any(|p| !p.contains("||") && !modern.clone().any(|v| admits(p, v)))
}

/// Whether a `pragma solidity` range (its literals joined, as `>=0.4.22<0.6` or `^0.5.16`) admits version `v`.
fn admits(range: &str, v: [u32; 3]) -> bool {
    let mut rest = range.trim();
    while !rest.is_empty() {
        let op_len = ["^", "~", ">=", "<=", ">", "<", "="].iter().find(|o| rest.starts_with(**o)).map_or(0, |o| o.len());
        let op = &rest[..op_len];
        rest = rest[op_len..].trim_start();
        let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(rest.len());
        let parts: Vec<u32> = rest[..end].split('.').filter_map(|p| p.parse().ok()).collect();
        rest = rest[end..].trim_start();
        if parts.is_empty() {
            return true; // something this doesn't read: don't rule anything out
        }
        let b = [parts[0], *parts.get(1).unwrap_or(&0), *parts.get(2).unwrap_or(&0)];
        let ok = match op {
            "^" | "~" => {
                let upper = if op == "~" || b[0] == 0 { [b[0], b[1] + 1, 0] } else { [b[0] + 1, 0, 0] };
                v >= b && v < upper
            }
            ">=" => v >= b,
            "<=" => v <= b,
            ">" => v > b,
            "<" => v < b,
            _ => v == b,
        };
        if !ok {
            return false;
        }
    }
    true
}

/// Before 0.6, solc's AST points `msg`, `require`, `this` and the other built-ins at positive ids of declarations that
/// aren't in the tree; from 0.6 they are negative. Gives them the ids solc 0.8 uses, so the graph and the Lean model
/// read old code the same way.
fn normalize_builtins(mut output: Value) -> Value {
    fn ids(n: &Value, out: &mut std::collections::HashSet<i64>) {
        match n {
            Value::Object(m) => {
                if let Some(id) = m.get("id").and_then(Value::as_i64) {
                    out.insert(id);
                }
                m.values().for_each(|v| ids(v, out));
            }
            Value::Array(a) => a.iter().for_each(|v| ids(v, out)),
            _ => {}
        }
    }
    fn fix(n: &mut Value, known: &std::collections::HashSet<i64>) {
        match n {
            Value::Object(m) => {
                let builtin = m.get("nodeType").and_then(Value::as_str) == Some("Identifier")
                    && m.get("referencedDeclaration").and_then(Value::as_i64).is_some_and(|r| r >= 0 && !known.contains(&r));
                if builtin {
                    let id = match m.get("name").and_then(Value::as_str).unwrap_or("") {
                        "abi" => -1,
                        "addmod" => -2,
                        "assert" => -3,
                        "block" => -4,
                        "blockhash" => -5,
                        "ecrecover" => -6,
                        "gasleft" => -7,
                        "keccak256" | "sha3" => -8,
                        "msg" => -15,
                        "mulmod" => -16,
                        "require" => -18,
                        "revert" => -19,
                        "sha256" => -22,
                        "tx" => -26,
                        "this" => -28,
                        _ => -99,
                    };
                    m.insert("referencedDeclaration".into(), json!(id));
                }
                m.values_mut().for_each(|v| fix(v, known));
            }
            Value::Array(a) => a.iter_mut().for_each(|v| fix(v, known)),
            _ => {}
        }
    }
    let mut known = std::collections::HashSet::new();
    ids(&output["sources"], &mut known);
    fix(&mut output["sources"], &known);
    output
}

/// Whether this solc takes `--base-path` (0.6.9 and later); None is whatever `solc` is installed, taken as recent.
#[cfg(not(target_arch = "wasm32"))]
fn takes_base_path(version: Option<&str>) -> bool {
    let Some(v) = version else { return true };
    let n: Vec<u32> = v.split('.').filter_map(|p| p.parse().ok()).collect();
    n.as_slice() >= [0, 6, 9].as_slice()
}

/// Compiles the entry file (and whatever it imports) and returns solc's output: `sources.<path>.{id, ast}` and
/// `contracts.<path>.<name>.storageLayout`.
#[cfg(not(target_arch = "wasm32"))]
pub fn compile(project: &Project, entry: &str) -> Result<Value> {
    use std::process::{Command, Stdio};
    let (input, version) = input(project, entry)?;
    let solc = solc_binary(version.as_deref())?;
    let args: &[&str] = if takes_base_path(version.as_deref()) { &["--standard-json", "--base-path", ".", "--allow-paths", "."] } else { &["--standard-json", "--allow-paths", "."] };
    let mut child = Command::new(&solc)
        .args(args)
        .current_dir(&project.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("can't run {}", solc.display()))?;
    {
        use std::io::Write;
        child.stdin.take().unwrap().write_all(input.to_string().as_bytes())?;
    }
    let out = child.wait_with_output()?;
    let output: Value = serde_json::from_slice(&out.stdout)
        .with_context(|| format!("solc printed no JSON: {}", String::from_utf8_lossy(&out.stderr)))?;
    let output = check(output, entry)?;
    let pre_08 = version.as_deref().is_some_and(|v| v.split('.').filter_map(|p| p.parse::<u32>().ok()).collect::<Vec<_>>() < vec![0, 8, 0]);
    Ok(if pre_08 { unchecked_bodies(output) } else { output })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pragma_versions() {
        assert_eq!(pragma_version("pragma solidity 0.8.30;"), Some("0.8.30".into()));
        assert_eq!(pragma_version("pragma solidity =0.8.26;"), Some("0.8.26".into()));
        assert_eq!(pragma_version("pragma solidity ^0.8.0;"), None);
    }

    #[test]
    fn pragma_ranges() {
        assert!(admits(">=0.4.22<0.6", [0, 5, 17]));
        assert!(!admits(">=0.4.22<0.6", [0, 8, 0]));
        assert!(admits("^0.8.20", [0, 8, 30]));
        assert!(!admits("^0.8.20", [0, 8, 19]));
        assert!(!admits("^0.7.6", [0, 8, 0]));
        assert!(admits("0.5.16", [0, 5, 16]));
        assert!(admits(">=0.5.0", [0, 8, 30]));
    }

    #[test]
    fn old_code_is_unchecked() {
        let ast = |pragma: &[&str]| {
            let mut lits = vec!["solidity"];
            lits.extend(pragma);
            json!({ "sources": { "a.sol": { "id": 0, "ast": { "nodeType": "SourceUnit", "nodes": [
                { "nodeType": "PragmaDirective", "literals": lits },
                { "nodeType": "FunctionDefinition", "id": 1, "body": { "nodeType": "Block", "statements": [] } }
            ] } } } })
        };
        let body = |o: Value| o["sources"]["a.sol"]["ast"]["nodes"][1]["body"]["nodeType"].clone();
        assert_eq!(body(check(ast(&[">=", "0.4", ".22", "<", "0.6"]), "a.sol").unwrap()), "UncheckedBlock");
        assert_eq!(body(check(ast(&["^", "0.8", ".20"]), "a.sol").unwrap()), "Block");
    }

    #[test]
    fn old_builtins_get_negative_ids() {
        let out = json!({ "sources": { "a.sol": { "id": 0, "ast": { "nodeType": "SourceUnit", "id": 5, "nodes": [
            { "nodeType": "Identifier", "id": 6, "name": "msg", "referencedDeclaration": 260 },
            { "nodeType": "Identifier", "id": 7, "name": "x", "referencedDeclaration": 5 }
        ] } } } });
        let out = normalize_builtins(out);
        assert_eq!(out["sources"]["a.sol"]["ast"]["nodes"][0]["referencedDeclaration"], -15);
        assert_eq!(out["sources"]["a.sol"]["ast"]["nodes"][1]["referencedDeclaration"], 5);
    }

    #[test]
    fn remappings_get_trailing_slashes() {
        assert_eq!(normalize_remapping("v4-core/=dependencies/v4-core/src"), "v4-core/=dependencies/v4-core/src/");
        assert_eq!(normalize_remapping("dep/=lib/dep/"), "dep/=lib/dep/");
        assert_eq!(normalize_remapping("src:a/=lib/a"), "src:a/=lib/a/");
        assert_eq!(normalize_remapping("forge-std=lib/forge-std/src/Test.sol"), "forge-std=lib/forge-std/src/Test.sol");
    }
}
