//! Publishing a folder's verification to GitHub, done by the app, never by the agents (their `run` tool stays limited
//! to lake and forge). Only for a folder with Report to GitHub on: after each approval the app commits the folder's
//! work with formalmind[bot] as co-author and pushes it to the formalmind organization's copy of the project, forking
//! the project there (or creating it) the first time. Nothing is pushed anywhere else.

use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

pub const ORG: &str = "formalmind";
pub const BOT: &str = "Co-Authored-By: formalmind[bot] <213248595+formalmind[bot]@users.noreply.github.com>";
/// The remote the app pushes to.
const REMOTE: &str = "formalmind";

/// One publish at a time: approvals can land together.
static LOCK: Mutex<()> = Mutex::new(());

fn cmd(root: &Path, prog: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(crate::platform::find_tool(prog))
        .args(args)
        .current_dir(root)
        .env("PATH", crate::platform::tool_path(None))
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("{prog}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!("{prog} {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// `owner/name` of a GitHub remote URL.
pub fn repo_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://github.com/").or_else(|| url.strip_prefix("git@github.com:"))?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let (owner, name) = rest.split_once('/')?;
    (!owner.is_empty() && !name.is_empty() && !name.contains('/')).then(|| format!("{owner}/{name}"))
}

/// The formalmind copy's name for a folder: the origin's name, else the folder's.
pub fn copy_name(origin: Option<&str>, folder: &Path) -> String {
    let name = origin.and_then(|o| o.split_once('/')).map(|(_, n)| n.to_string());
    let name = name.unwrap_or_else(|| folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' }).collect()
}

/// The commit message: what was proved, then the co-author.
pub fn message(what: &str) -> String {
    let what = what.lines().next().unwrap_or("").trim();
    let what = if what.is_empty() { "verification progress" } else { what };
    format!("Formal Mind: {}\n\n{BOT}\n", what.chars().take(120).collect::<String>())
}

/// Makes sure the `formalmind` remote exists: the origin itself when it's already formalmind's, else a fork of it,
/// else (no GitHub origin) a new public repository.
fn ensure_remote(root: &Path) -> Result<(), String> {
    if cmd(root, "git", &["remote", "get-url", REMOTE]).is_ok() {
        return Ok(());
    }
    let origin = cmd(root, "git", &["remote", "get-url", "origin"]).ok().and_then(|u| repo_of(&u));
    let name = copy_name(origin.as_deref(), root);
    let target = format!("{ORG}/{name}");
    match origin.as_deref() {
        Some(o) if o.split('/').next() == Some(ORG) => {
            cmd(root, "git", &["remote", "add", REMOTE, &format!("https://github.com/{o}.git")])?;
            return Ok(());
        }
        Some(o) => {
            if cmd(root, "gh", &["repo", "view", &target, "--json", "name"]).is_err() {
                cmd(root, "gh", &["repo", "fork", o, "--org", ORG, "--clone=false", "--fork-name", &name])?;
            }
        }
        None => {
            if cmd(root, "gh", &["repo", "view", &target, "--json", "name"]).is_err() {
                cmd(root, "gh", &["repo", "create", &target, "--public", "--description", "Formally verified by Formal Mind"])?;
            }
        }
    }
    cmd(root, "git", &["remote", "add", REMOTE, &format!("https://github.com/{target}.git")])?;
    Ok(())
}

/// Commits everything the folder's .gitignore allows and pushes it to the formalmind copy. Returns the commit, or
/// None when nothing changed.
pub fn publish(root: &Path, what: &str) -> Result<Option<String>, String> {
    let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if cmd(root, "git", &["rev-parse", "--is-inside-work-tree"]).is_err() {
        cmd(root, "git", &["init", "-q", "-b", "main"])?;
    }
    // The lock says which app runs here; it means nothing anywhere else.
    let ignore = root.join(".gitignore");
    let have = std::fs::read_to_string(&ignore).unwrap_or_default();
    if !have.lines().any(|l| l.trim() == ".formal/run.lock") {
        let sep = if have.is_empty() || have.ends_with('\n') { "" } else { "\n" };
        std::fs::write(&ignore, format!("{have}{sep}.formal/run.lock\n")).map_err(|e| e.to_string())?;
        let _ = cmd(root, "git", &["rm", "-q", "--cached", "--ignore-unmatch", ".formal/run.lock"]);
    }
    cmd(root, "git", &["add", "-A"])?;
    let commit = if cmd(root, "git", &["diff", "--cached", "--quiet"]).is_err() {
        cmd(root, "git", &["commit", "-q", "-m", &message(what)])?;
        Some(cmd(root, "git", &["rev-parse", "--short", "HEAD"])?)
    } else {
        None
    };
    if cmd(root, "git", &["rev-parse", "HEAD"]).is_err() {
        return Ok(None);
    }
    ensure_remote(root)?;
    let branch = cmd(root, "git", &["branch", "--show-current"]).ok().filter(|b| !b.is_empty()).unwrap_or_else(|| "main".into());
    cmd(root, "git", &["push", "-q", REMOTE, &format!("HEAD:refs/heads/{branch}")])?;
    Ok(commit)
}

/// A branch name for a ref: a commit gets `verify-<short sha>`, a branch or tag keeps its name.
pub fn branch_for(git_ref: &str) -> String {
    let r = git_ref.trim().trim_start_matches("refs/heads/").trim_start_matches("refs/tags/");
    if r.len() >= 7 && r.len() <= 40 && r.chars().all(|c| c.is_ascii_hexdigit()) {
        format!("verify-{}", &r[..7])
    } else {
        r.chars().map(|c| if c.is_ascii_alphanumeric() || "-_./".contains(c) { c } else { '-' }).collect()
    }
}

/// Starts a project from any GitHub repository: forks it into formalmind (unless it's formalmind's already), clones
/// it with its submodules into `dir`, and checks out `git_ref` (a branch, tag or commit; the default branch when
/// empty) on its own branch, so what the swarm proves is pushed to the fork at exactly that code.
pub fn checkout(repo: &str, git_ref: &str, dir: &Path) -> Result<String, String> {
    let repo = repo_of(repo).or_else(|| repo_of(&format!("https://github.com/{}", repo.trim()))).ok_or("repo must be owner/name or a GitHub URL")?;
    let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let parent = dir.parent().ok_or("no parent folder")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if !dir.join(".git").exists() {
        cmd(parent, "git", &["clone", "-q", &format!("https://github.com/{repo}.git"), &dir.to_string_lossy()])?;
    }
    let git_ref = git_ref.trim();
    let branch = if git_ref.is_empty() {
        cmd(dir, "git", &["branch", "--show-current"])?
    } else {
        cmd(dir, "git", &["fetch", "-q", "origin", git_ref])?;
        let b = branch_for(git_ref);
        cmd(dir, "git", &["checkout", "-q", "-B", &b, "FETCH_HEAD"])?;
        b
    };
    cmd(dir, "git", &["submodule", "update", "-q", "--init", "--recursive"])?;
    ensure_remote(dir)?;
    Ok(branch)
}

/// After an approval: publish in the background when the folder reports to GitHub; failures go to the log.
pub fn after_approval(root: &Path, what: &str) {
    let folder = root.to_string_lossy().into_owned();
    if !crate::local::read().map(|c| c.settings.github(&folder)).unwrap_or(false) {
        return;
    }
    let (root, what) = (root.to_path_buf(), what.to_string());
    std::thread::spawn(move || match publish(&root, &what) {
        Ok(Some(c)) => eprintln!("publish: {c} pushed to {ORG}"),
        Ok(None) => {}
        Err(e) => eprintln!("publish: {e}"),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_messages() {
        assert_eq!(repo_of("https://github.com/morpho-org/morpho-blue.git").as_deref(), Some("morpho-org/morpho-blue"));
        assert_eq!(repo_of("git@github.com:formalmind/weth9.git").as_deref(), Some("formalmind/weth9"));
        assert_eq!(repo_of("https://gitlab.com/a/b"), None);
        assert_eq!(copy_name(Some("morpho-org/morpho-blue"), Path::new("/x/y")), "morpho-blue");
        assert_eq!(copy_name(None, Path::new("/x/my folder")), "my-folder");
        let m = message("- [ ] `WETH9.deposit` — WETH9 (src/WETH9.sol:34)");
        assert_eq!(branch_for("4e1f7c2a9b0d"), "verify-4e1f7c2");
        assert_eq!(branch_for("refs/heads/release/v2"), "release/v2");
        assert_eq!(branch_for("v1.0 rc"), "v1.0-rc");
        assert!(m.starts_with("Formal Mind: - [ ] `WETH9.deposit`") && m.ends_with(&format!("{BOT}\n")));
    }

    /// Commits with the co-author and pushes to an existing formalmind remote (a local bare repo here, so no network).
    #[test]
    fn commits_and_pushes_to_the_formalmind_remote() {
        let base = std::env::temp_dir().join(format!("fm-publish-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (work, bare) = (base.join("work"), base.join("copy.git"));
        std::fs::create_dir_all(work.join(".formal")).unwrap();
        cmd(&base, "git", &["init", "-q", "--bare", bare.to_str().unwrap()]).unwrap();
        cmd(&work, "git", &["init", "-q", "-b", "main"]).unwrap();
        cmd(&work, "git", &["config", "user.email", "t@example.com"]).unwrap();
        cmd(&work, "git", &["config", "user.name", "t"]).unwrap();
        cmd(&work, "git", &["remote", "add", REMOTE, bare.to_str().unwrap()]).unwrap();
        std::fs::write(work.join("A.lean"), "theorem a : True := trivial\n").unwrap();
        std::fs::write(work.join(".formal/run.lock"), "123").unwrap();
        let c = publish(&work, "`X.f` proved").unwrap();
        assert!(c.is_some());
        let log = cmd(&bare, "git", &["log", "-1", "--format=%B", "main"]).unwrap();
        assert!(log.contains("`X.f` proved") && log.contains(BOT), "{log}");
        let files = cmd(&bare, "git", &["ls-tree", "-r", "--name-only", "main"]).unwrap();
        assert!(files.contains("A.lean") && !files.contains("run.lock"), "{files}");
        // Nothing new: no commit, nothing fails.
        assert_eq!(publish(&work, "again").unwrap(), None);
        let _ = std::fs::remove_dir_all(&base);
    }
}
