//! Where a project's files come from: the disk (the CLI and the Mac app), or a map of paths to text (the website,
//! whose files are in the browser's git copy). Paths are relative to the project root, `/`-separated.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub trait Files: Send + Sync {
    /// A file's text, or None when there is no such file (or it can't be read).
    fn read(&self, path: &str) -> Option<String>;
    /// A folder's entries as (name, is a folder), or nothing when there is no such folder.
    fn read_dir(&self, path: &str) -> Vec<(String, bool)>;
    /// Whether a file or folder is there.
    fn exists(&self, path: &str) -> bool;
}

/// A folder on disk.
pub struct Disk(pub PathBuf);

impl Files for Disk {
    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.0.join(path)).ok()
    }
    fn read_dir(&self, path: &str) -> Vec<(String, bool)> {
        let Ok(read) = std::fs::read_dir(self.0.join(path)) else { return vec![] };
        read.flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), e.path().is_dir())).collect()
    }
    fn exists(&self, path: &str) -> bool {
        self.0.join(path).exists()
    }
}

/// Files held in memory. `paths` lists every file the project has, `text` the ones read so far: a dependency's file
/// can be known to exist (for remappings) before its text is fetched.
#[derive(Default)]
pub struct Memory {
    pub paths: BTreeSet<String>,
    pub text: BTreeMap<String, String>,
}

impl Memory {
    pub fn new(paths: impl IntoIterator<Item = String>, text: BTreeMap<String, String>) -> Memory {
        let mut paths: BTreeSet<String> = paths.into_iter().collect();
        paths.extend(text.keys().cloned());
        Memory { paths, text }
    }
}

/// `a/./b/../c/` → `a/c`.
fn clean(path: &str) -> String {
    let mut out: Vec<&str> = vec![];
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            p => out.push(p),
        }
    }
    out.join("/")
}

impl Files for Memory {
    fn read(&self, path: &str) -> Option<String> {
        self.text.get(&clean(path)).cloned()
    }
    fn read_dir(&self, path: &str) -> Vec<(String, bool)> {
        let dir = clean(path);
        let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
        let mut seen = BTreeMap::new();
        for p in self.paths.range(prefix.clone()..).take_while(|p| p.starts_with(&prefix)) {
            let rest = &p[prefix.len()..];
            match rest.split_once('/') {
                Some((name, _)) => {
                    seen.insert(name.to_string(), true);
                }
                None => {
                    seen.entry(rest.to_string()).or_insert(false);
                }
            }
        }
        seen.into_iter().collect()
    }
    fn exists(&self, path: &str) -> bool {
        let p = clean(path);
        p.is_empty() || self.paths.contains(&p) || self.paths.range(format!("{p}/")..).next().is_some_and(|q| q.starts_with(&format!("{p}/")))
    }
}

/// `path` relative to `root`, `/`-separated.
pub fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_folders() {
        let m = Memory::new(["lib/a/src/A.sol".to_string(), "lib/b/remappings.txt".into(), "foundry.toml".into()], BTreeMap::new());
        assert_eq!(m.read_dir("lib"), vec![("a".into(), true), ("b".into(), true)]);
        assert_eq!(m.read_dir(""), vec![("foundry.toml".into(), false), ("lib".into(), true)]);
        assert!(m.exists("lib/a/src/") && m.exists("lib/b/./remappings.txt") && !m.exists("lib/c"));
        assert!(!m.exists("lib/a/sr"));
    }
}
