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
    Ok(output)
}

/// Compiles the entry file (and whatever it imports) and returns solc's output: `sources.<path>.{id, ast}` and
/// `contracts.<path>.<name>.storageLayout`.
#[cfg(not(target_arch = "wasm32"))]
pub fn compile(project: &Project, entry: &str) -> Result<Value> {
    use std::process::{Command, Stdio};
    let (input, version) = input(project, entry)?;
    let solc = solc_binary(version.as_deref())?;
    let mut child = Command::new(&solc)
        .args(["--standard-json", "--base-path", ".", "--allow-paths", "."])
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
    check(output, entry)
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
    fn remappings_get_trailing_slashes() {
        assert_eq!(normalize_remapping("v4-core/=dependencies/v4-core/src"), "v4-core/=dependencies/v4-core/src/");
        assert_eq!(normalize_remapping("dep/=lib/dep/"), "dep/=lib/dep/");
        assert_eq!(normalize_remapping("src:a/=lib/a"), "src:a/=lib/a/");
        assert_eq!(normalize_remapping("forge-std=lib/forge-std/src/Test.sol"), "forge-std=lib/forge-std/src/Test.sol");
    }
}
