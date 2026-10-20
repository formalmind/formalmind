//! The machine side the website can't have: ~/.formalmind/ for settings, and folders on disk to work on.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Config {
    /// Folders added from the sidebar, as absolute paths.
    #[serde(default)]
    pub folders: Vec<String>,
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

/// Whether a folder has been added (only those may be read).
pub fn is_added(path: &str) -> Result<bool, String> {
    Ok(read()?.folders.iter().any(|f| f == path))
}

/// The Solidity and Lean files in a folder that's been added (only those may be read).
#[tauri::command]
pub fn folder_scan(path: String) -> Result<Scan, String> {
    if !read()?.folders.contains(&path) {
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
#[tauri::command]
pub fn folder_tree(path: String) -> Result<Tree, String> {
    if !read()?.folders.contains(&path) {
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
#[tauri::command]
pub fn log_error(source: String, message: String) -> Result<(), String> {
    use std::io::Write;
    let dir = std::path::PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?).join("Library/Logs/Formal Mind");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("errors.log")).map_err(|e| e.to_string())?;
    writeln!(f, "[{secs}] v{} {source}: {}", env!("CARGO_PKG_VERSION"), message.replace('\n', "\n    ")).map_err(|e| e.to_string())
}
