//! Compiling with solc, and nothing else: `solc --standard-json`, AST and storage layout only.
//!
//! Follows the language server's approach (asyncswap/solidity-language-server `src/solc.rs`): the version comes from
//! foundry.toml or the pragma, remappings from the project's files, and the output selection asks for no bytecode,
//! so a large protocol compiles in a fraction of a second. There is no forge fallback: a solc error is returned as
//! is, and nothing is built from a partial AST.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// What foundry.toml says about compiling, read directly (no `forge` call).
#[derive(Debug, Default, Clone)]
pub struct Project {
    pub root: PathBuf,
    pub solc_version: Option<String>,
    pub evm_version: Option<String>,
    pub remappings: Vec<String>,
    /// Library folders (foundry.toml `libs`, default `lib`): code there is a trusted dependency.
    pub libs: Vec<String>,
}

impl Project {
    pub fn load(root: &Path) -> Result<Self> {
        let root = root.canonicalize().with_context(|| format!("no such folder: {}", root.display()))?;
        let mut project = Project { root: root.clone(), ..Default::default() };
        if let Ok(text) = std::fs::read_to_string(root.join("foundry.toml")) {
            let doc: toml::Value = toml::from_str(&text).context("foundry.toml doesn't parse")?;
            let profile = doc.get("profile").and_then(|p| p.get("default"));
            let get = |k: &str| profile.and_then(|p| p.get(k)).and_then(|v| v.as_str()).map(str::to_string);
            project.solc_version = get("solc_version").or_else(|| get("solc"));
            project.evm_version = get("evm_version");
            if let Some(list) = profile.and_then(|p| p.get("libs")).and_then(|v| v.as_array()) {
                project.libs.extend(list.iter().filter_map(|v| v.as_str()).map(str::to_string));
            }
            if let Some(list) = profile.and_then(|p| p.get("remappings")).and_then(|v| v.as_array()) {
                project.remappings.extend(list.iter().filter_map(|v| v.as_str()).map(str::to_string));
            }
        }
        if let Ok(text) = std::fs::read_to_string(root.join("remappings.txt")) {
            for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
                // foundry.toml wins when both name the same prefix.
                let prefix = line.split('=').next().unwrap_or("");
                if !project.remappings.iter().any(|r| r.split('=').next() == Some(prefix)) {
                    project.remappings.push(line.to_string());
                }
            }
        }
        if project.libs.is_empty() {
            project.libs.push("lib".into());
        }
        // Each dependency resolves its own imports with its own remappings (solc context remappings, as forge does).
        for lib in project.libs.clone() {
            let Ok(entries) = std::fs::read_dir(root.join(&lib)) else { continue };
            for dep in entries.flatten() {
                let Ok(text) = std::fs::read_to_string(dep.path().join("remappings.txt")) else { continue };
                let dir = format!("{}/{}", lib.trim_end_matches('/'), dep.file_name().to_string_lossy());
                for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#') && !l.contains(':')) {
                    if let Some((prefix, target)) = line.split_once('=') {
                        project.remappings.push(format!("{dir}/:{prefix}={dir}/{target}"));
                    }
                }
            }
        }
        // As forge does: a prefix ending in `/` maps to a target ending in `/`.
        for r in &mut project.remappings {
            if let Some((prefix, target)) = r.split_once('=') {
                let prefix = prefix.rsplit(':').next().unwrap_or(prefix);
                if prefix.ends_with('/') && !target.ends_with('/') {
                    *r = format!("{prefix}={target}/");
                }
            }
        }
        Ok(project)
    }
}

/// The solc binary for a version: svm's install folder, then `solc` on PATH if its version matches (or none was asked).
pub fn solc_binary(version: Option<&str>) -> Result<PathBuf> {
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

/// Compiles the entry file (and whatever it imports) and returns solc's output: `sources.<path>.{id, ast}` and
/// `contracts.<path>.<name>.storageLayout`.
pub fn compile(project: &Project, entry: &str) -> Result<Value> {
    let entry_source = std::fs::read_to_string(project.root.join(entry)).with_context(|| format!("can't read {entry}"))?;
    let version = project.solc_version.clone().or_else(|| pragma_version(&entry_source));
    let solc = solc_binary(version.as_deref())?;
    let mut settings = json!({
        "remappings": project.remappings,
        "outputSelection": { "*": { "*": ["storageLayout"], "": ["ast"] } },
    });
    if let Some(evm) = &project.evm_version {
        settings["evmVersion"] = json!(evm);
    }
    let input = json!({ "language": "Solidity", "sources": { entry: { "urls": [entry] } }, "settings": settings });

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pragma_versions() {
        assert_eq!(pragma_version("pragma solidity 0.8.30;"), Some("0.8.30".into()));
        assert_eq!(pragma_version("pragma solidity =0.8.26;"), Some("0.8.26".into()));
        assert_eq!(pragma_version("pragma solidity ^0.8.0;"), None);
    }
}
