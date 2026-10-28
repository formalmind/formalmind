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
    /// What the agents run with, kept here so the backend decides it whatever started the work (the folder page, the
    /// an agent through the MCP, a schedule). The Settings page and the folder page write it.
    #[serde(default)]
    pub settings: Settings,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Settings {
    /// formal.team, or another server set on the sign-in screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_base: Option<String>,
    /// "claude-code" (your Claude plan, the default), "codex" (your ChatGPT plan), "formal" (credits), "anthropic" or "openai" (your key).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Claude Code's thinking effort for the agents' turns (`--effort`: low, medium, high); unset leaves its default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Each folder's spending cap in USD, by path.
    #[serde(default)]
    pub budgets: std::collections::BTreeMap<String, f64>,
    /// Each folder's "Report to GitHub", by path: off (the default) keeps everything local; on lets Formal Mind's GitHub
    /// App comment on that repository's pull requests with what the ledger says changed.
    #[serde(default)]
    pub github: std::collections::BTreeMap<String, bool>,
    /// Settings → Questions: who answers the swarm's questions. "mcp" (the default): you, in the chat, or an MCP client
    /// acting for you; "agent": the answerer agent (answerer.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<String>,
    /// Settings → Remote control (MCP): the relay through formal.team. On unless turned off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<bool>,
}

impl Settings {
    pub const DEFAULT_API: &'static str = "https://formal.team";

    pub fn api_base(&self) -> String {
        self.api_base.clone().filter(|b| !b.is_empty()).unwrap_or_else(|| Self::DEFAULT_API.into())
    }

    /// Claude Code (your Claude plan) unless credits or a key were picked, as the Settings and folder pages default.
    pub fn provider(&self) -> String {
        self.provider.clone().filter(|p| ["claude-code", "codex", "formal", "anthropic", "openai"].contains(&p.as_str())).unwrap_or_else(|| "claude-code".into())
    }

    pub fn budget(&self, folder: &str) -> f64 {
        self.budgets.get(folder).copied().filter(|b| *b > 0.0).unwrap_or(5.0)
    }

    /// The effort to pass to Claude Code, when one was picked.
    pub fn effort(&self) -> Option<String> {
        self.effort.clone().filter(|e| ["low", "medium", "high", "xhigh", "max"].contains(&e.as_str()))
    }

    pub fn answers(&self) -> String {
        self.answers.clone().filter(|a| a == "agent").unwrap_or_else(|| "mcp".into())
    }

    /// Whether this folder reports to GitHub (off unless turned on).
    pub fn github(&self, folder: &str) -> bool {
        self.github.get(folder).copied().unwrap_or(false)
    }

    pub fn relay(&self) -> bool {
        self.relay.unwrap_or(true)
    }
}

impl Config {
    /// Whether the app may read this folder: one you added, or the folder an imported repository is cloned (mapped) to.
    pub fn allows(&self, path: &str) -> bool {
        self.folders.iter().any(|f| f == path) || self.repos.values().any(|f| f == path)
    }
}

#[cfg(test)]
thread_local! {
    /// A test's own ~/.formalmind, so tests never read or write the real one (per thread: tests run in parallel).
    pub static TEST_HOME: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// ~/.formalmind (or %USERPROFILE%\.formalmind on Windows).
pub fn home() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(h) = TEST_HOME.with(|h| h.borrow().clone()) {
        return Ok(h);
    }
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

/// The backend's settings.
#[tauri::command]
pub fn settings_get() -> Result<Settings, String> {
    Ok(read()?.settings)
}

/// Sets some of the backend's settings: each key given replaces its value (`budgets` merges by folder); `null` clears it.
#[tauri::command]
pub fn settings_set(patch: serde_json::Value) -> Result<Settings, String> {
    let mut config = read()?;
    let mut current = serde_json::to_value(&config.settings).map_err(|e| e.to_string())?;
    for (k, v) in patch.as_object().into_iter().flatten() {
        if k == "budgets" || k == "github" {
            for (folder, value) in v.as_object().into_iter().flatten() {
                current[k.as_str()][folder] = value.clone();
            }
        } else if v.is_null() {
            current.as_object_mut().map(|o| o.remove(k));
        } else {
            current[k] = v.clone();
        }
    }
    config.settings = serde_json::from_value(current).map_err(|e| format!("settings: {e}"))?;
    write(&config)?;
    Ok(config.settings)
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

/// Appends an error the app showed to errors.log in the app's log folder (~/Library/Logs/Formal Mind on macOS), so it
/// can be read back later.
#[tauri::command(async)]
pub fn log_error(source: String, message: String) -> Result<(), String> {
    use std::io::Write;
    let dir = crate::platform::log_dir();
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

/// One commit in a folder's history, for the canvas's git tree.
#[derive(Serialize)]
pub struct Commit {
    id: String,
    parents: Vec<String>,
    /// Branch and tag names pointing at it (`HEAD -> main`, `origin/main`, `tag: v1.0.0`).
    refs: Vec<String>,
    subject: String,
    time: i64,
}

#[derive(Serialize)]
pub struct GitGraph {
    commits: Vec<Commit>,
    head: Option<String>,
    branch: Option<String>,
    /// Files changed and not committed: the work in progress on top of HEAD.
    dirty: usize,
}

/// The latest commits on every branch of an added folder, newest first, read with git (nothing is written).
#[tauri::command(async)]
pub fn folder_git_graph(path: String) -> Result<GitGraph, String> {
    if !read()?.allows(&path) {
        return Err("Add the folder first".into());
    }
    let dir = Path::new(&path);
    let format = "--format=%H%x1f%P%x1f%D%x1f%s%x1f%ct";
    // The newest commits on every branch, and always HEAD's own line, however old (a release checked out to prove).
    let all = git(&["log", "--all", "--date-order", "-n", "80", format], Some(dir))?;
    let mine = git(&["log", "--date-order", "-n", "20", format, "HEAD"], Some(dir)).unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut lines: Vec<&str> = all.lines().chain(mine.lines()).filter(|l| seen.insert(l.split('\u{1f}').next().unwrap_or_default().to_string())).collect();
    // Newest first, so the lanes read top to bottom.
    lines.sort_by_key(|l| std::cmp::Reverse(l.rsplit('\u{1f}').next().and_then(|t| t.parse::<i64>().ok()).unwrap_or(0)));
    let commits = lines
        .into_iter()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\u{1f}').collect();
            (f.len() == 5).then(|| Commit {
                id: f[0].into(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                refs: f[2].split(", ").filter(|r| !r.is_empty()).map(String::from).collect(),
                subject: f[3].into(),
                time: f[4].parse().unwrap_or(0),
            })
        })
        .collect();
    let dirty = git(&["status", "--porcelain"], Some(dir)).map(|s| s.lines().count()).unwrap_or(0);
    Ok(GitGraph { commits, head: git(&["rev-parse", "HEAD"], Some(dir)).ok(), branch: git(&["rev-parse", "--abbrev-ref", "HEAD"], Some(dir)).ok(), dirty })
}

/// Whether a folder's origin is this GitHub repository (https or ssh, with or without .git).
fn is_repo(folder: &Path, repo: &str) -> bool {
    git(&["remote", "get-url", "origin"], Some(folder)).is_ok_and(|url| {
        let url = url.trim_end_matches('/').trim_end_matches(".git").to_ascii_lowercase();
        url.ends_with(&format!("github.com/{}", repo.to_ascii_lowercase())) || url.ends_with(&format!("github.com:{}", repo.to_ascii_lowercase()))
    })
}

/// The GitHub repository ("owner/name") an added folder's origin points at, if it is one.
#[tauri::command(async)]
pub fn folder_repo(path: String) -> Result<Option<String>, String> {
    if !read()?.allows(&path) {
        return Err("Add the folder first".into());
    }
    Ok(git(&["remote", "get-url", "origin"], Some(Path::new(&path))).ok().and_then(|url| github_repo(&url)))
}

/// This computer's name as its owner set it (macOS: Sharing → Computer Name), else its host name; mac_swarm shows it.
#[tauri::command(async)]
pub fn machine_name() -> Option<String> {
    let run = |cmd: &str, args: &[&str]| {
        std::process::Command::new(cmd).args(args).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty())
    };
    #[cfg(target_os = "macos")]
    if let Some(name) = run("scutil", &["--get", "ComputerName"]) {
        return Some(name);
    }
    std::env::var("COMPUTERNAME").ok().filter(|s| !s.is_empty()).or_else(|| run("hostname", &[]))
}

/// "owner/name" from a GitHub remote URL (https or ssh, with or without .git).
fn github_repo(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let rest = url.split_once("github.com/").or_else(|| url.split_once("github.com:"))?.1;
    let mut parts = rest.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    (parts.next().is_none() && !owner.is_empty() && !name.is_empty()).then(|| format!("{owner}/{name}"))
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
    use super::{github_repo, valid_repo};

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

    #[test]
    fn github_repos_from_remotes() {
        assert_eq!(github_repo("https://github.com/asyncswap/contracts.git").as_deref(), Some("asyncswap/contracts"));
        assert_eq!(github_repo("git@github.com:a/b").as_deref(), Some("a/b"));
        assert_eq!(github_repo("https://gitlab.com/a/b"), None);
    }
}

#[cfg(test)]
mod settings_tests {
    #[test]
    fn the_claude_plan_is_the_default_route() {
        assert_eq!(super::Settings::default().provider(), "claude-code");
        let credits = super::Settings { provider: Some("formal".into()), ..Default::default() };
        assert_eq!(credits.provider(), "formal");
    }
}
