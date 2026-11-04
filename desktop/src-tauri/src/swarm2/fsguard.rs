//! The folder sandbox (SPEC.md §2.4.5, B24, B25, B27, R2, R5): every path an agent names stays inside the folder,
//! never reaches a stray copy of the models or proofs that Lake doesn't build, and never writes the swarm's `.formal/`.

use super::lake;
use std::path::{Component, Path, PathBuf};

/// The swarm's own state folder; agents may read it but not write it (B25).
pub const FORMAL_DIR: &str = ".formal";

/// B25's refusal, word for word.
pub const FORMAL_WRITE_ERROR: &str = "error: .formal/ is the swarm's; it ticks a plan item once its proof checks and the reviewer approves it (reopen puts items back in the plan)";

/// A path as the agent gave it, made folder-relative: an absolute path echoing the folder (or its resolved form) is
/// accepted, a leading `./` dropped, and an empty path is the folder itself.
fn relative(root: &Path, rel: &str) -> PathBuf {
    let p = Path::new(rel);
    let real = root.canonicalize().ok();
    let p = p.strip_prefix(root).ok().or_else(|| real.as_deref().and_then(|r| p.strip_prefix(r).ok())).unwrap_or(p);
    let p: PathBuf = p.components().filter(|c| !matches!(c, Component::CurDir)).collect();
    if p.as_os_str().is_empty() { PathBuf::from(".") } else { p }
}

/// `/`-separated folder-relative text for messages.
pub(crate) fn show(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// B24: the absolute path for `rel` inside the folder, or an error. Relative (or echoing the folder), no `..`, and
/// the nearest existing ancestor must resolve inside the folder, so a symlink can't lead out.
pub fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = relative(root, rel);
    let outside = || format!("{} is outside the folder", rel.display());
    if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir)) {
        return Err(outside());
    }
    let path = root.join(&rel);
    let root_real = root.canonicalize().map_err(|e| e.to_string())?;
    let existing = path.ancestors().find(|p| p.symlink_metadata().is_ok()).unwrap_or(root);
    // A dangling symlink can't be resolved; treat it as leading out.
    let real = existing.canonicalize().map_err(|_| outside())?;
    if real.starts_with(&root_real) { Ok(path) } else { Err(outside()) }
}

/// §2.4.5: why `rel` is a stray copy (a models or proofs folder outside the Lake sources, under the Lake project or
/// the folder root), naming the file Lake does build; `None` when it isn't one or the folder has no Lake project.
pub fn stray(root: &Path, rel: &str) -> Option<String> {
    let project = lake::discover(root)?;
    let path = root.join(relative(root, rel));
    if path.starts_with(&project.src) {
        return None;
    }
    let under = [project.dir.as_path(), root].into_iter().find_map(|base| {
        let r = path.strip_prefix(base).ok()?;
        let top = r.components().next()?.as_os_str().to_string_lossy().to_string();
        (top == project.specs || top == project.proofs).then(|| r.to_path_buf())
    })?;
    let right = project.src.join(under);
    Some(format!(
        "{} is outside the Lake sources ({}/), so Lake never builds it: use {}",
        show(root, &path),
        show(root, &project.src),
        show(root, &right)
    ))
}

/// The stray models/proofs folders in the folder, folder-relative and sorted, for the planner to report (R2).
pub fn strays(root: &Path) -> Vec<String> {
    let Some(project) = lake::discover(root) else { return vec![] };
    let mut out: Vec<String> = [root, project.dir.as_path()]
        .iter()
        .flat_map(|b| [b.join(project.specs), b.join(project.proofs)])
        .filter(|d| d.is_dir())
        .map(|d| show(root, &d))
        .filter(|rel| stray(root, rel).is_some())
        .collect();
    out.sort();
    out.dedup();
    out
}

/// B27: a path an agent may read or check (`read_file`, `lake env lean`): inside the folder and not a stray copy.
pub fn readable(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let path = inside(root, rel)?;
    match stray(root, rel) {
        Some(why) => Err(why),
        None => Ok(path),
    }
}

/// B25/B27/R5: a path an agent may write: readable, and not under `.formal/`.
pub fn writable(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let path = readable(root, rel)?;
    if relative(root, rel).components().next().is_some_and(|c| c.as_os_str() == FORMAL_DIR) {
        return Err(FORMAL_WRITE_ERROR.into());
    }
    Ok(path)
}

/// B27: whether a search or find hit (folder-relative) should be shown: false for stray copies.
pub fn visible(root: &Path, rel: &str) -> bool {
    stray(root, rel).is_none()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A fresh empty folder under the system temp dir, removed on drop.
    pub struct TempDir(pub PathBuf);
    impl TempDir {
        pub fn new(tag: &str) -> Self {
            use std::sync::atomic::{AtomicUsize, Ordering};
            static N: AtomicUsize = AtomicUsize::new(0);
            let d = std::env::temp_dir().join(format!("swarm2-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            TempDir(d)
        }
        pub fn file(&self, rel: &str, text: &str) -> &Self {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
            self
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Async Swap's layout: Lake in `validation/lean/` reading `Generated/` there, a stale copy at the root.
    pub fn nested_with_stray() -> TempDir {
        let t = TempDir::new("nested");
        t.file("validation/lean/lakefile.toml", "name = \"v\"\n\n[[lean_lib]]\nname = \"Generated\"\n")
            .file("validation/lean/Generated/AsyncSwap.lean", "def x := 1\n")
            .file("Generated/AsyncSwap.lean", "def x := 0\n");
        t
    }

    #[test]
    fn b24_relative_paths_inside_are_accepted() {
        let t = TempDir::new("b24a");
        t.file("src/A.sol", "");
        assert_eq!(inside(&t.0, "src/A.sol").unwrap(), t.0.join("src/A.sol"));
        assert_eq!(inside(&t.0, "./src/A.sol").unwrap(), t.0.join("src/A.sol"));
        assert_eq!(inside(&t.0, "new/dir/file.lean").unwrap(), t.0.join("new/dir/file.lean"));
        assert_eq!(inside(&t.0, "").unwrap(), t.0.join("."));
    }

    #[test]
    fn b24_absolute_path_echoing_the_folder_is_accepted() {
        let t = TempDir::new("b24b");
        t.file("src/A.sol", "");
        let abs = t.0.join("src/A.sol");
        assert_eq!(inside(&t.0, abs.to_str().unwrap()).unwrap(), abs);
        let real = t.0.canonicalize().unwrap().join("src/A.sol");
        assert!(inside(&t.0, real.to_str().unwrap()).is_ok());
    }

    #[test]
    fn b24_other_absolute_paths_and_dotdot_are_refused() {
        let t = TempDir::new("b24c");
        assert!(inside(&t.0, "/etc/passwd").is_err());
        assert!(inside(&t.0, "../x").is_err());
        assert!(inside(&t.0, "a/../../x").is_err());
        assert!(inside(&t.0, "a/../b").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn b24_symlink_escape_is_refused() {
        let t = TempDir::new("b24d");
        let out = TempDir::new("b24d-out");
        out.file("secret", "s");
        std::os::unix::fs::symlink(&out.0, t.0.join("link")).unwrap();
        assert!(inside(&t.0, "link/secret").is_err());
        assert!(inside(&t.0, "link/new/file").is_err());
        std::os::unix::fs::symlink(t.0.join("src"), t.0.join("inner")).unwrap();
        t.file("src/A.sol", "");
        assert!(inside(&t.0, "inner/A.sol").is_ok());
    }

    #[test]
    fn b25_writes_into_formal_are_refused() {
        let t = TempDir::new("b25");
        t.file(".formal/plan.md", "");
        assert_eq!(writable(&t.0, ".formal/plan.md").unwrap_err(), FORMAL_WRITE_ERROR);
        assert_eq!(writable(&t.0, "./.formal/new.json").unwrap_err(), FORMAL_WRITE_ERROR);
        assert!(readable(&t.0, ".formal/plan.md").is_ok());
        assert!(writable(&t.0, "formal/Proofs/X.lean").is_ok());
    }

    #[test]
    fn r5_assistant_cannot_mark_the_plan_proved() {
        let t = TempDir::new("r5");
        t.file(".formal/plan.md", "- [ ] P-01\n");
        let abs = t.0.join(".formal/plan.md");
        assert_eq!(writable(&t.0, abs.to_str().unwrap()).unwrap_err(), FORMAL_WRITE_ERROR);
    }

    #[test]
    fn b27_stray_copy_is_refused_naming_the_right_file() {
        let t = nested_with_stray();
        let err = readable(&t.0, "Generated/AsyncSwap.lean").unwrap_err();
        assert_eq!(
            err,
            "Generated/AsyncSwap.lean is outside the Lake sources (validation/lean/), so Lake never builds it: use validation/lean/Generated/AsyncSwap.lean"
        );
        assert_eq!(writable(&t.0, "Generated/AsyncSwap.lean").unwrap_err(), err);
        assert!(readable(&t.0, "validation/lean/Generated/AsyncSwap.lean").is_ok());
        assert!(readable(&t.0, "src/A.sol").is_ok());
    }

    #[test]
    fn b27_search_hits_in_strays_are_hidden() {
        let t = nested_with_stray();
        assert!(!visible(&t.0, "Generated/AsyncSwap.lean"));
        assert!(visible(&t.0, "validation/lean/Generated/AsyncSwap.lean"));
        assert!(visible(&t.0, "README.md"));
    }

    #[test]
    fn r2_stray_copies_under_the_lake_project_with_src_dir() {
        let t = TempDir::new("r2");
        t.file("validation/lean/lakefile.toml", "name = \"v\"\nsrcDir = \"src\"\n\n[[lean_lib]]\nname = \"Generated\"\n")
            .file("validation/lean/src/Generated/A.lean", "")
            .file("validation/lean/Generated/A.lean", "")
            .file("Refinement/B.lean", "");
        let err = readable(&t.0, "validation/lean/Generated/A.lean").unwrap_err();
        assert!(err.ends_with("use validation/lean/src/Generated/A.lean"), "{err}");
        assert!(readable(&t.0, "Refinement/B.lean").unwrap_err().ends_with("use validation/lean/src/Refinement/B.lean"));
        assert_eq!(strays(&t.0), vec!["Refinement", "validation/lean/Generated"]);
    }

    #[test]
    fn no_lake_project_means_no_strays() {
        let t = TempDir::new("nolake");
        t.file("Generated/A.lean", "");
        assert!(stray(&t.0, "Generated/A.lean").is_none());
        assert!(strays(&t.0).is_empty());
    }
}
