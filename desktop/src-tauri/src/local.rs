//! The machine side the website can't have: ~/.formalmind/ for settings, and folders on disk to work on.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Config {
    /// Folders added from the sidebar, as absolute paths.
    #[serde(default)]
    pub folders: Vec<String>,
    /// Where each imported GitHub repository lives on this machine ("owner/name" -> absolute path): a clone under
    /// ~/.formalmind/repos, or a folder you already had that is that repository.
    #[serde(default)]
    pub repos: std::collections::BTreeMap<String, String>,
}

impl Config {
    /// Whether the app may read this folder: one you added, or the folder an imported repository is cloned (mapped) to.
    pub fn allows(&self, path: &str) -> bool {
        self.folders.iter().any(|f| f == path) || self.repos.values().any(|f| f == path)
    }
}

/// ~/.formalmind (or %USERPROFILE%\.formalmind on Windows).
pub fn home() -> Result<PathBuf, String> {
    let base = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).ok_or("No home folder")?;
    Ok(PathBuf::from(base).join(".formalmind"))
}

fn config_path() -> Result<PathBuf, String> {
    Ok(home()?.join("config.json"))
}

pub fn read() -> Result<Config, String> {
    match fs::read_to_string(config_path()?) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("~/.formalmind/config.json: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn write(config: &Config) -> Result<(), String> {
    fs::create_dir_all(home()?).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(config_path()?, text + "\n").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn config_get() -> Result<Config, String> {
    read()
}

#[tauri::command]
pub fn folder_add(path: String) -> Result<Config, String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("{path} isn't a folder"));
    }
    let mut config = read()?;
    if !config.folders.contains(&path) {
        config.folders.push(path);
        write(&config)?;
    }
    Ok(config)
}

#[tauri::command]
pub fn folder_remove(path: String) -> Result<Config, String> {
    let mut config = read()?;
    config.folders.retain(|f| f != &path);
    write(&config)?;
    Ok(config)
}

#[derive(Serialize)]
pub struct Scan {
    /// Solidity sources, relative to the folder.
    pub solidity: Vec<String>,
    /// Lean files, relative to the folder.
    pub lean: Vec<String>,
    /// True when the walk stopped at the limit.
    pub truncated: bool,
    /// True when the folder is a git repository.
    pub git: bool,
}

const SKIP: [&str; 9] = [".git", "node_modules", "lib", "dependencies", "out", "cache", "target", ".lake", "dist"];
const LIMIT: usize = 5000;

/// Whether a folder has been added or an imported repository maps to it (only those may be read).
pub fn is_added(path: &str) -> Result<bool, String> {
    Ok(read()?.allows(path))
}

/// The Solidity and Lean files in a folder that's been added (only those may be read).
#[tauri::command(async)]
pub fn folder_scan(path: String) -> Result<Scan, String> {
    if !read()?.allows(&path) {
        return Err("Add the folder first".into());
    }
    let root = PathBuf::from(&path);
    let mut scan = Scan { solidity: vec![], lean: vec![], truncated: false, git: root.join(".git").exists() };
    let mut stack = vec![root.clone()];
    let mut seen = 0;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > LIMIT {
                scan.truncated = true;
                break;
            }
            let p = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if !SKIP.contains(&name.as_str()) {
                    stack.push(p);
                }
            } else if let Ok(rel) = p.strip_prefix(&root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                if name.ends_with(".sol") {
                    scan.solidity.push(rel);
                } else if name.ends_with(".lean") {
                    scan.lean.push(rel);
                }
            }
        }
    }
    scan.solidity.sort();
    scan.lean.sort();
    Ok(scan)
}

#[derive(Serialize)]
pub struct Tree {
    /// Every file, relative to the folder, sorted.
    pub files: Vec<String>,
    pub truncated: bool,
}

/// Folders the tree leaves out: version control, dependencies, build output.
const TREE_SKIP: [&str; 12] = [".git", "node_modules", "lib", "dependencies", "out", "cache", "target", ".lake", "dist", "broadcast", ".formal", ".next"];

/// All files in a folder that's been added, for the sidebar's file tree.
#[tauri::command(async)]
pub fn folder_tree(path: String) -> Result<Tree, String> {
    if !read()?.allows(&path) {
        return Err("Add the folder first".into());
    }
    let root = PathBuf::from(&path);
    let mut tree = Tree { files: vec![], truncated: false };
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if tree.files.len() >= LIMIT {
                tree.truncated = true;
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if !TREE_SKIP.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
            } else if name != ".DS_Store" {
                if let Ok(rel) = entry.path().strip_prefix(&root) {
                    tree.files.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    tree.files.sort();
    Ok(tree)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_scan_remove() {
        let tmp = std::env::temp_dir().join(format!("fm-test-{}", std::process::id()));
        let project = tmp.join("project");
        fs::create_dir_all(project.join("src")).unwrap();
        fs::create_dir_all(project.join("node_modules/x")).unwrap();
        fs::write(project.join("src/Pool.sol"), "").unwrap();
        fs::write(project.join("Proofs.lean"), "").unwrap();
        fs::write(project.join("node_modules/x/Skip.sol"), "").unwrap();
        std::env::set_var("HOME", &tmp);

        let path = project.to_string_lossy().to_string();
        assert!(folder_scan(path.clone()).is_err(), "only added folders may be read");
        assert_eq!(folder_add(path.clone()).unwrap().folders, vec![path.clone()]);
        let scan = folder_scan(path.clone()).unwrap();
        assert_eq!(scan.solidity, vec!["src/Pool.sol"]);
        assert_eq!(scan.lean, vec!["Proofs.lean"]);
        let tree = folder_tree(path.clone()).unwrap();
        assert_eq!(tree.files, vec!["Proofs.lean", "src/Pool.sol"], "node_modules is left out");
        assert!(folder_remove(path).unwrap().folders.is_empty());
        fs::remove_dir_all(tmp).unwrap();
    }
}

/// Appends an error the app showed to ~/Library/Logs/Formal Mind/errors.log, so it can be read back later.
#[tauri::command(async)]
pub fn log_error(source: String, message: String) -> Result<(), String> {
    use std::io::Write;
    let dir = std::path::PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?).join("Library/Logs/Formal Mind");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("errors.log")).map_err(|e| e.to_string())?;
    writeln!(f, "[{secs}] v{} {source}: {}", env!("CARGO_PKG_VERSION"), message.replace('\n', "\n    ")).map_err(|e| e.to_string())
}

/// "owner/name" with GitHub's characters only, so it is safe in a path and a URL.
fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let ok = |p: Option<&str>| p.is_some_and(|p| !p.is_empty() && p != "." && p != ".." && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)));
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

fn git(args: &[&str], dir: Option<&Path>) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    // Never wait on a password prompt: your keychain or SSH credentials answer, or it fails.
    let out = cmd.args(args).env("GIT_TERMINAL_PROMPT", "0").output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Whether a folder's origin is this GitHub repository (https or ssh, with or without .git).
fn is_repo(folder: &Path, repo: &str) -> bool {
    git(&["remote", "get-url", "origin"], Some(folder)).is_ok_and(|url| {
        let url = url.trim_end_matches('/').trim_end_matches(".git").to_ascii_lowercase();
        url.ends_with(&format!("github.com/{}", repo.to_ascii_lowercase())) || url.ends_with(&format!("github.com:{}", repo.to_ascii_lowercase()))
    })
}

/// An imported repository on this machine: the folder it is mapped to, else one of your folders that is that
/// repository, else a shallow clone into ~/.formalmind/repos/<owner>/<name> (with your own git credentials). The
/// mapping is kept in ~/.formalmind/config.json; our clones fetch the newest commit each time they are opened.
#[tauri::command(async)]
pub fn repo_local(repo: String) -> Result<String, String> {
    if !valid_repo(&repo) {
        return Err(format!("{repo} isn't a GitHub repository name"));
    }
    let mut config = read()?;
    let ours = home()?.join("repos");
    if let Some(path) = config.repos.get(&repo).cloned() {
        let p = Path::new(&path);
        if p.join(".git").exists() {
            if p.starts_with(&ours) {
                // Updated in the background: the copy we have opens at once (offline too), the newest commit follows.
                let dir = p.to_path_buf();
                std::thread::spawn(move || {
                    let _ = git(&["pull", "--ff-only", "--quiet", "--depth", "1"], Some(&dir));
                });
            }
            return Ok(path);
        }
    }
    let found = config.folders.iter().find(|f| is_repo(Path::new(f), &repo)).cloned();
    let path = match found {
        Some(f) => f,
        None => {
            let dest = ours.join(&repo);
            if !dest.join(".git").exists() {
                fs::create_dir_all(dest.parent().ok_or("bad path")?).map_err(|e| e.to_string())?;
                let url = format!("https://github.com/{repo}.git");
                git(&["clone", "--depth", "1", "--quiet", &url, &dest.to_string_lossy()], None)
                    .map_err(|e| format!("Couldn't clone {repo}: {e}"))?;
            }
            dest.to_string_lossy().into_owned()
        }
    };
    config.repos.insert(repo, path.clone());
    write(&config)?;
    Ok(path)
}

#[cfg(test)]
mod repo_tests {
    use super::valid_repo;

    #[test]
    fn repo_names_stay_in_their_folder() {
        assert!(valid_repo("asyncswap/contracts"));
        assert!(valid_repo("a.b/c-d_e"));
        assert!(!valid_repo("../etc"));
        assert!(!valid_repo("a/.."));
        assert!(!valid_repo("a/b/c"));
        assert!(!valid_repo("a"));
        assert!(!valid_repo("a/b c"));
    }
}

