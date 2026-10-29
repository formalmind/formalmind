//! The local swarm's hands on a folder: its file tools, kept inside the folder, and the commands it may run there
//! (only `lake` and `forge`). The model calls themselves are the swarm's (swarm.rs), through formal.team credits or
//! your own Anthropic key, and nowhere else.

use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

const OUTPUT_LIMIT: usize = 12_000;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// A path inside the folder, or an error: relative, no `..`, and (when it exists) not a symlink out of it.
pub(crate) fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // Models often echo the folder's absolute path back; that's fine as long as it points inside.
    let rel = Path::new(rel).strip_prefix(root).unwrap_or(Path::new(rel));
    let rel = rel.strip_prefix("./").unwrap_or(rel);
    let rel = if rel.as_os_str().is_empty() { Path::new(".") } else { rel };
    if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_))) {
        return Err(format!("{} is outside the folder", rel.display()));
    }
    let path = root.join(rel);
    // The nearest part that exists must resolve inside the folder, so a symlinked directory can't lead out.
    let root_real = root.canonicalize().map_err(|e| e.to_string())?;
    let existing = path.ancestors().find(|p| p.exists()).unwrap_or(root);
    let real = existing.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&root_real) {
        return Err(format!("{} is outside the folder", rel.display()));
    }
    Ok(path)
}

/// A path inside the folder that isn't a stray copy of the models or proofs outside the Lake sources (see
/// `swarm_ctx::stray`): the agents only ever see the model Lake builds.
pub(crate) fn in_sources(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let path = inside(root, rel)?;
    match crate::swarm_ctx::stray(root, rel) {
        Some(why) => Err(why),
        None => Ok(path),
    }
}

pub(crate) fn clip(mut s: String) -> String {
    if s.len() > OUTPUT_LIMIT {
        let mut cut = OUTPUT_LIMIT / 2;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        let tail_start = s.len() - OUTPUT_LIMIT / 2;
        let tail_start = (tail_start..s.len()).find(|&i| s.is_char_boundary(i)).unwrap_or(s.len());
        s = format!("{}\n… [cut] …\n{}", &s[..cut], &s[tail_start..]);
    }
    s
}

/// Where `lake` and `forge` usually live; apps started from the Dock or the Start menu don't get the shell's PATH.
fn tool_path() -> std::ffi::OsString {
    crate::platform::tool_path(None)
}

pub(crate) async fn run_command(root: &Path, command: &str) -> Result<String, String> {
    let argv: Vec<&str> = command.split_whitespace().collect();
    let allowed = match argv.as_slice() {
        ["lake", "build", ..] => true,
        ["lake", "exe", "cache", "get"] => true,
        ["lake", "init" | "new", name, ..] => name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        ["lake", "env", "lean", file] => inside(root, file).is_ok(),
        ["forge", "build" | "test", ..] => true,
        _ => false,
    };
    if let ["lake", "env", "lean", file] = argv.as_slice() {
        in_sources(root, file)?;
    }
    if !allowed {
        return Err("Only `lake build`, `lake env lean <file>`, `lake exe cache get`, `lake init|new <Name>`, `forge build` and `forge test` may run.".into());
    }
    // Lake runs in the folder's Lake project (the folder, or formal/ in it); a file for `lake env lean` is passed
    // as an absolute path so it can be named relative to the folder either way.
    let lake = argv[0] == "lake";
    let cwd = if lake { crate::swarm_ctx::lake_dir(root).or_else(|| Some(root.join("formal")).filter(|d| d.is_dir())).unwrap_or_else(|| root.to_path_buf()) } else { root.to_path_buf() };
    let mut args: Vec<String> = argv[1..].iter().map(|a| a.to_string()).collect();
    if let ["lake", "env", "lean", file] = argv.as_slice() {
        args[2] = inside(root, file)?.to_string_lossy().to_string();
    }
    let child = tokio::process::Command::new(argv[0])
        .args(&args)
        .current_dir(&cwd)
        .env("PATH", tool_path())
        .env("ELAN_TOOLCHAIN", std::env::var("ELAN_TOOLCHAIN").unwrap_or_else(|_| "leanprover/lean4:v4.35.0".into()))
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(COMMAND_TIMEOUT, child).await.map_err(|_| "Timed out after 15 minutes".to_string())?.map_err(|e| e.to_string())?;
    let text = format!(
        "exit {}\n{}{}",
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(clip(text))
}

pub(crate) fn list_files(root: &Path, dir: &str) -> Result<String, String> {
    let start = inside(root, if dir.is_empty() { "." } else { dir })?;
    // Dependencies (lib/ for git submodules, dependencies/ for Soldeer) and build output.
    let skip = [".git", "node_modules", "lib", "dependencies", "out", "cache", "broadcast", "target", ".lake", "dist", ".formal"];
    let mut files = vec![];
    let mut stack = vec![start];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let p = e.path();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if !skip.contains(&name.as_str()) {
                    stack.push(p);
                }
            } else if let Ok(rel) = p.strip_prefix(root) {
                files.push(rel.to_string_lossy().replace('\\', "/"));
            }
            if files.len() >= 2000 {
                break;
            }
        }
    }
    files.sort();
    Ok(clip(files.join("\n")))
}

/// Lines matching a regex in the folder's text files (Solidity, Lean, Markdown, TOML), as path:line: text.
fn search(root: &Path, pattern: &str, dir: &str) -> Result<String, String> {
    // Stray copies of the models or proofs (see `in_sources`) are left out: a hit there is a def Lake never builds.
    search_in(root, pattern, dir, &[".sol", ".lean", ".md", ".toml"]).map(|hits| drop_strays(root, &hits))
}

/// Search or find results (one `path` or `path:line: text` per line) without the ones in stray copies of the models or
/// proofs (see `in_sources`): a hit there is a def or a proof Lake never builds.
pub(crate) fn drop_strays(root: &Path, hits: &str) -> String {
    hits.lines().filter(|l| l.split(':').next().is_none_or(|f| crate::swarm_ctx::stray(root, f).is_none())).collect::<Vec<_>>().join("\n")
}

/// Lines matching a regex in the files under `dir` with one of `exts`, as path:line: text.
pub(crate) fn search_in(root: &Path, pattern: &str, dir: &str, exts: &[&str]) -> Result<String, String> {
    // fff's index first; the plain walk below if the folder can't be indexed.
    match crate::file_search::grep(root, pattern, dir, exts) {
        Err(e) if !e.starts_with("bad pattern") => walk_search(root, pattern, dir, exts),
        r => r,
    }
}

fn walk_search(root: &Path, pattern: &str, dir: &str, exts: &[&str]) -> Result<String, String> {
    let re = regex::Regex::new(pattern).map_err(|e| format!("bad pattern: {e}"))?;
    let files = list_files(root, if dir.is_empty() { "." } else { dir })?;
    let mut hits = vec![];
    for f in files.lines().filter(|f| exts.iter().any(|x| f.ends_with(x))) {
        let Ok(text) = std::fs::read_to_string(root.join(f)) else { continue };
        for (i, line) in text.lines().enumerate() {
            if re.is_match(line) {
                hits.push(format!("{f}:{}: {}", i + 1, line.trim().chars().take(200).collect::<String>()));
                if hits.len() >= 200 {
                    hits.push("… (200 matches shown)".into());
                    return Ok(hits.join("\n"));
                }
            }
        }
    }
    Ok(if hits.is_empty() { "no matches".into() } else { hits.join("\n") })
}

/// Lean can run code at build time (#eval, IO actions); refuse to build files that could reach the machine.
fn lean_guard(root: &Path) -> Result<(), String> {
    const RISKY: [&str; 6] = ["#eval", "IO.Process", "IO.FS", "System.FilePath", "run_cmd", "initialize "];
    let files = list_files(root, ".")?;
    for f in files.lines().filter(|f| f.ends_with(".lean")) {
        let text = std::fs::read_to_string(root.join(f)).unwrap_or_default();
        if let Some(bad) = RISKY.iter().find(|r| text.contains(*r)) {
            return Err(format!("{f} uses `{bad}`, which can run code on this machine; proofs here must be pure Lean. Remove it (use read_file and search to read the contracts)."));
        }
    }
    Ok(())
}

pub(crate) async fn call_tool(root: &Path, name: &str, args: &Value) -> String {
    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let result = match name {
        "list_files" => list_files(root, &s("dir")),
        // `@skills/…`: the auditing checklists added on this computer (skills.rs), outside the folder.
        "read_file" => crate::skills::resolve(&s("path")).or_else(|| crate::skills::resolve_bare(root, &s("path"))).map(Ok).unwrap_or_else(|| in_sources(root, &s("path"))).and_then(|p| std::fs::read_to_string(p).map_err(|e| e.to_string())).map(|text| {
            let n = |k: &str| args.get(k).and_then(Value::as_u64).map(|v| v as usize);
            match (n("start_line"), n("end_line")) {
                (None, None) if text.len() <= OUTPUT_LIMIT => text,
                (start, end) => {
                    // A slice with line numbers, so long contracts can be read piece by piece.
                    let total = text.lines().count();
                    let from = start.unwrap_or(1).max(1);
                    let to = end.unwrap_or(from + 299).min(total);
                    let body: String = text.lines().enumerate().skip(from - 1).take(to.saturating_sub(from) + 1).map(|(i, l)| format!("{:>5}  {l}\n", i + 1)).collect();
                    clip(format!("{}lines {from}-{to} of {total}\n{body}", if start.is_none() && end.is_none() { "File is long; showing the start. Pass start_line/end_line for more.\n" } else { "" }))
                }
            }
        }),
        "search" => search(root, &s("pattern"), &s("dir")),
        "find" => crate::file_search::find(root, &s("query"), 30).map(|h| drop_strays(root, &h)),
        "write_file" => in_sources(root, &s("path")).and_then(|p| {
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&p, s("content")).map_err(|e| e.to_string()).map(|_| format!("wrote {}", s("path")))
        }),
        "run" => {
            let cmd = s("command");
            if cmd.trim_start().starts_with("lake") {
                if let Err(e) = lean_guard(root) {
                    return format!("error: {e}");
                }
            }
            run_command(root, &cmd).await
        }
        _ => Err(format!("No tool called {name}")),
    };
    result.unwrap_or_else(|e| format!("error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside() {
        let root = std::env::temp_dir();
        assert!(inside(&root, "src/A.sol").is_ok());
        assert!(inside(&root, "../etc/passwd").is_err());
        assert!(inside(&root, "/etc/passwd").is_err());
        assert!(inside(&root, &root.join("x.lean").to_string_lossy()).is_ok());
        assert!(inside(&root, "").is_ok());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn only_lake_and_forge_run() {
        let root = std::env::temp_dir();
        assert!(run_command(&root, "rm -rf /").await.is_err());
        assert!(run_command(&root, "lake env lean ../x.lean").await.is_err());
        assert!(run_command(&root, "forge script X").await.is_err());
    }
}
