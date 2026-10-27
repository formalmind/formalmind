//! Where things are on this computer, macOS, Windows or Linux: the home folder, the folders developer tools install
//! into (an app opened from the Dock or the Start menu doesn't get the shell's PATH), executable names and the log
//! folder.

use std::path::PathBuf;

/// The home folder: HOME, or USERPROFILE on Windows.
pub fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

/// A program's file name here: `nvim` → `nvim.exe` on Windows.
pub fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// Where Lean (elan), Foundry, cargo and the package managers put their programs, most specific first.
pub fn tool_dirs() -> Vec<PathBuf> {
    let home = home();
    // ~/.local/bin: Claude Code's installer puts `claude` there.
    let mut dirs = vec![home.join(".elan/bin"), home.join(".foundry/bin"), home.join(".cargo/bin"), home.join(".local/bin")];
    if cfg!(target_os = "macos") {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    } else if cfg!(windows) {
        // Scoop and Chocolatey.
        dirs.push(home.join("scoop/shims"));
        dirs.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin"));
    } else {
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs
}

/// PATH with `first` (if any) and the tool folders ahead of the current one, joined the way this OS joins it.
pub fn tool_path(first: Option<PathBuf>) -> std::ffi::OsString {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let all = first.into_iter().chain(tool_dirs()).chain(std::env::split_paths(&current));
    std::env::join_paths(all).unwrap_or(current)
}

/// The first of the tool folders that has `name`, else the bare name (found on PATH, if anywhere).
pub fn find_tool(name: &str) -> PathBuf {
    let file = exe(name);
    tool_dirs().into_iter().map(|d| d.join(&file)).find(|p| p.exists()).unwrap_or_else(|| PathBuf::from(file))
}

/// Where the app's own logs go: ~/Library/Logs/Formal Mind on macOS, ~/.formalmind/logs elsewhere.
pub fn log_dir() -> PathBuf {
    if cfg!(target_os = "macos") { home().join("Library/Logs/Formal Mind") } else { home().join(".formalmind/logs") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tool_path_starts_with_the_tool_folders() {
        let path = tool_path(Some(PathBuf::from("/first")));
        let parts: Vec<PathBuf> = std::env::split_paths(&path).collect();
        assert_eq!(parts[0], PathBuf::from("/first"));
        // Another test points HOME elsewhere while tests run in parallel, so only the folder's shape is checked.
        assert!(parts[1].ends_with(".elan/bin"));
        assert_eq!(exe("nvim"), if cfg!(windows) { "nvim.exe" } else { "nvim" });
    }
}
