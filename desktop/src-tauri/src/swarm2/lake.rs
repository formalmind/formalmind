//! The folder's Lake project (SPEC.md §2.4, R1): where it is, where Lake reads sources, how they're laid out, a
//! scaffold for folders without one, the build command for an item's own files (R12), and the `run` tool's
//! allowlist (only lake and forge) with the guard against Lean that runs code (B26).

use super::fsguard;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The folder's settings file; `[lean] project` and `[lean] sources` say where the proofs live.
pub const CONFIG: &str = "formalmind.toml";
/// The toolchain new projects pin and `run` defaults `ELAN_TOOLCHAIN` to.
pub const TOOLCHAIN: &str = "leanprover/lean4:v4.35.0";
/// `run`'s refusal for anything off the allowlist.
pub const ALLOWLIST_ERROR: &str = "Only `lake build`, `lake env lean <file>`, `lake exe cache get`, `lake init|new <Name>`, `forge build` and `forge test` may run.";
const OUTPUT_LIMIT: usize = 12_000;
const TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Folders the nested-project search never enters (§2.4.1).
const DISCOVERY_SKIP: [&str; 12] = [".git", ".lake", ".formal", ".claude", "node_modules", "lib", "dependencies", "out", "cache", "broadcast", "target", "dist"];
/// Lean that can run code on this machine at build time (B26).
const RISKY_LEAN: [&str; 6] = ["#eval", "IO.Process", "IO.FS", "System.FilePath", "run_cmd", "initialize "];

/// A folder's Lake project as the swarm uses it. Paths are absolute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    /// The folder with the lakefile, where `lake` runs.
    pub dir: PathBuf,
    /// Where Lake reads the sources; module names are relative to it.
    pub src: PathBuf,
    /// The models' library folder: `Specs`, or `Generated` in the older layout.
    pub specs: &'static str,
    /// The proofs' library folder: `Proofs`, or `Refinement`.
    pub proofs: &'static str,
    /// The folder under the proofs with one file per function: `Functions`, or `Swarm`.
    pub functions: &'static str,
}

/// A folder-relative `[lean]` path from formalmind.toml (no `..`, not absolute).
fn configured(root: &Path, key: &str) -> Option<PathBuf> {
    let table: toml::Table = std::fs::read_to_string(root.join(CONFIG)).ok()?.parse().ok()?;
    let rel = table.get("lean")?.get(key)?.as_str()?.trim().trim_matches('/');
    if rel.split('/').any(|p| p == "..") || Path::new(rel).is_absolute() {
        return None;
    }
    Some(if rel.is_empty() || rel == "." { root.to_path_buf() } else { root.join(rel) })
}

/// Both lakefiles' text in a folder (empty when there's none).
fn lakefile_text(dir: &Path) -> String {
    ["lakefile.toml", "lakefile.lean"].iter().filter_map(|f| std::fs::read_to_string(dir.join(f)).ok()).collect()
}

fn has_lakefile(dir: &Path) -> bool {
    dir.join("lakefile.toml").is_file() || dir.join("lakefile.lean").is_file()
}

/// Whether a lakefile declares a library by this name (toml `"Name"` or lean `lean_lib Name`).
fn declares(lakefile: &str, lib: &str) -> bool {
    lakefile.contains(&format!("\"{lib}\"")) || lakefile.contains(&format!("lean_lib {lib}"))
}

/// §2.4.1: the Lake project: `lean.project` if it has a lakefile; else the folder; else `formal/`; else the
/// shallowest directory at most three levels down whose lakefile declares `Generated` or `Specs` (R1).
pub fn lake_dir(root: &Path) -> Option<PathBuf> {
    configured(root, "project")
        .filter(|d| has_lakefile(d))
        .or_else(|| [root.to_path_buf(), root.join("formal")].into_iter().find(|d| has_lakefile(d)))
        .or_else(|| nested_lake(root))
}

/// R1: a Lake project deeper in the folder (`validation/lean/`), breadth-first, sorted within each level.
fn nested_lake(root: &Path) -> Option<PathBuf> {
    let mut level = vec![root.to_path_buf()];
    for _ in 0..3 {
        let mut next = vec![];
        for d in &level {
            let Ok(entries) = std::fs::read_dir(d) else { continue };
            let mut dirs: Vec<PathBuf> = entries
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .filter(|e| !DISCOVERY_SKIP.contains(&e.file_name().to_string_lossy().as_ref()))
                .map(|e| e.path())
                .collect();
            dirs.sort();
            next.extend(dirs);
        }
        let mut found = next.iter().filter(|d| {
            let text = lakefile_text(d);
            declares(&text, "Generated") || declares(&text, "Specs")
        });
        if let Some(d) = found.next() {
            return Some(d.clone());
        }
        level = next;
    }
    None
}

/// The lakefile's `srcDir` (toml `srcDir = "…"`, lean `srcDir := "…"`), unless empty, `.` or with `..`.
fn src_dir(lake: &Path) -> Option<String> {
    let toml = std::fs::read_to_string(lake.join("lakefile.toml")).ok().and_then(|t| {
        t.lines().map(str::trim).find_map(|l| {
            let rest = l.strip_prefix("srcDir")?.trim_start().strip_prefix('=')?;
            Some(rest.trim().trim_matches('"').to_string())
        })
    });
    let lean = || {
        std::fs::read_to_string(lake.join("lakefile.lean"))
            .ok()
            .and_then(|t| t.split("srcDir").nth(1).and_then(|r| r.trim_start().strip_prefix(":=")).and_then(|r| r.split('"').nth(1)).map(String::from))
    };
    toml.or_else(lean).map(|s| s.trim_matches('/').to_string()).filter(|s| !s.is_empty() && s != "." && !s.split('/').any(|p| p == ".."))
}

/// §2.4.2: where Lake reads sources: `lean.sources` if inside the Lake project; else the lakefile's `srcDir`; else
/// the Lake project itself.
pub fn lean_src(root: &Path) -> Option<PathBuf> {
    let lake = lake_dir(root)?;
    if let Some(d) = configured(root, "sources").filter(|d| d.starts_with(&lake)) {
        return Some(d);
    }
    Some(src_dir(&lake).map(|s| lake.join(s)).unwrap_or(lake))
}

/// §2.4.1–3: the project, its sources and layout, or `None` when the folder has no Lake project.
pub fn discover(root: &Path) -> Option<Project> {
    let dir = lake_dir(root)?;
    let src = lean_src(root)?;
    let text = lakefile_text(&dir);
    let legacy = declares(&text, "Generated") || declares(&text, "Refinement") || src.join("Generated").is_dir() || src.join("Refinement").is_dir();
    let (specs, proofs) = if legacy { ("Generated", "Refinement") } else { ("Specs", "Proofs") };
    let has = |d: &str| src.join(proofs).join(d).is_dir();
    let functions = if proofs == "Refinement" || (has("Swarm") && !has("Functions")) { "Swarm" } else { "Functions" };
    Some(Project { dir, src, specs, proofs, functions })
}

/// §2.4.4: a Lake project for a folder with none: `formal/` with `Specs/` and `Proofs/`, the toolchain, a lakefile
/// declaring both libraries, and `.lake/` ignored.
pub fn scaffold(root: &Path) -> Result<Project, String> {
    let dir = root.join("formal");
    let io = |e: std::io::Error| e.to_string();
    std::fs::create_dir_all(dir.join("Specs")).map_err(io)?;
    std::fs::create_dir_all(dir.join("Proofs")).map_err(io)?;
    std::fs::write(dir.join("lean-toolchain"), format!("{TOOLCHAIN}\n")).map_err(io)?;
    std::fs::write(
        dir.join("lakefile.toml"),
        "name = \"formal\"\ndefaultTargets = [\"Specs\", \"Proofs\"]\n\n[[lean_lib]]\nname = \"Specs\"\nglobs = [\"Specs.+\"]\n\n[[lean_lib]]\nname = \"Proofs\"\nglobs = [\"Proofs.+\"]\n",
    )
    .map_err(io)?;
    std::fs::write(dir.join(".gitignore"), ".lake/\n").map_err(io)?;
    discover(root).ok_or_else(|| "the scaffolded project wasn't found".into())
}

/// A function name as a file-name part: letters, digits and `_`, capitalized; `«»` (or nothing) is `Fallback`.
fn file_part(name: &str) -> String {
    let p: String = name.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect();
    let p = p.trim_start_matches('_');
    let mut c = p.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => "Fallback".into(),
    }
}

/// §2.4.6: a plan item's proof file, folder-relative: `<src>/<proofs>/<functions>/<Contract><Fn>.lean`. Without a
/// Lake project it is where the scaffold will put it (`formal/Proofs/Functions/`).
pub fn proof_file(root: &Path, contract: &str, function: &str) -> String {
    let (src, proofs, functions) = match discover(root) {
        Some(p) => (p.src, p.proofs, p.functions),
        None => (root.join("formal"), "Proofs", "Functions"),
    };
    let file = src.join(proofs).join(functions).join(format!("{contract}{}.lean", file_part(function.rsplit('.').next().unwrap_or(""))));
    fsguard::show(root, &file)
}

/// R12 (B17): `lake build` of just the modules these folder-relative Lean files are, so another agent's broken
/// proof doesn't fail this item; the whole project when none of them is a module under the sources.
pub fn build_command(root: &Path, files: &[&str]) -> String {
    let Some(src) = lean_src(root) else { return "lake build".into() };
    let modules: Vec<String> = files
        .iter()
        .filter_map(|f| fsguard::inside(root, f).ok())
        .filter_map(|p| p.strip_prefix(&src).ok().map(|m| m.to_string_lossy().replace('\\', "/")))
        .filter_map(|m| m.strip_suffix(".lean").map(|m| m.replace('/', ".")))
        .filter(|m| m.split('.').all(|part| !part.is_empty() && part.chars().all(|c| c.is_alphanumeric() || c == '_')))
        .collect();
    if modules.is_empty() { "lake build".into() } else { format!("lake build {}", modules.join(" ")) }
}

/// A command `run` will execute: the program, its arguments and where it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepared {
    pub program: &'static str,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

/// B26: checks a `run` command against the allowlist (`lake build …`, `lake exe cache get`, `lake init|new <Name>`,
/// `lake env lean <file in sources>`, `forge build|test …`) and, for lake, the Lean guard. `lake` runs in the Lake
/// project (or `formal/`, or the folder), `forge` in the folder; `lake env lean` gets the file's absolute path.
pub fn prepare(root: &Path, command: &str) -> Result<Prepared, String> {
    let argv: Vec<&str> = command.split_whitespace().collect();
    let name_ok = |n: &str| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    let mut args: Vec<String> = argv.iter().skip(1).map(|a| a.to_string()).collect();
    let program = match argv.as_slice() {
        ["lake", "build", ..] | ["lake", "exe", "cache", "get"] => "lake",
        ["lake", "init" | "new", name] if name_ok(name) => "lake",
        ["lake", "env", "lean", file] => {
            // B27: a stray copy is refused with the stray error, naming the right file.
            args[2] = fsguard::readable(root, file)?.to_string_lossy().into_owned();
            "lake"
        }
        ["forge", "build" | "test", ..] => "forge",
        _ => return Err(ALLOWLIST_ERROR.into()),
    };
    let cwd = if program == "lake" {
        lean_guard(root)?;
        lake_dir(root).or_else(|| Some(root.join("formal")).filter(|d| d.is_dir())).unwrap_or_else(|| root.to_path_buf())
    } else {
        root.to_path_buf()
    };
    Ok(Prepared { program, args, cwd })
}

/// B26: refuses when any `.lean` file in the folder (outside dependencies, build output and `.lake/`) contains Lean
/// that can run code on this machine: `#eval`, `IO.Process`, `IO.FS`, `System.FilePath`, `run_cmd`, `initialize `.
pub fn lean_guard(root: &Path) -> Result<(), String> {
    const SKIP: [&str; 11] = [".git", "node_modules", "lib", "dependencies", "out", "cache", "broadcast", "target", ".lake", "dist", ".formal"];
    let mut files = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                if !SKIP.contains(&e.file_name().to_string_lossy().as_ref()) {
                    stack.push(e.path());
                }
            } else if t.is_file() && e.path().extension().is_some_and(|x| x == "lean") {
                files.push(e.path());
            }
        }
    }
    files.sort();
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap_or_default();
        if let Some(bad) = RISKY_LEAN.iter().find(|r| text.contains(*r)) {
            return Err(format!(
                "{} uses `{bad}`, which can run code on this machine; proofs here must be pure Lean. Remove it (use read_file and search to read the contracts).",
                fsguard::show(root, &f)
            ));
        }
    }
    Ok(())
}

/// Output longer than 12 000 bytes keeps its head and tail around `… [cut] …`.
pub fn clip(s: String) -> String {
    if s.len() <= OUTPUT_LIMIT {
        return s;
    }
    let mut head = OUTPUT_LIMIT / 2;
    while !s.is_char_boundary(head) {
        head -= 1;
    }
    let tail = (s.len() - OUTPUT_LIMIT / 2..s.len()).find(|&i| s.is_char_boundary(i)).unwrap_or(s.len());
    format!("{}\n… [cut] …\n{}", &s[..head], &s[tail..])
}

/// B26: runs a `run` command: prepared as above, on the tool PATH, `ELAN_TOOLCHAIN` defaulting to the pinned
/// toolchain, killed after 15 minutes. Returns `exit <code>\n<stdout><stderr>`, clipped.
pub async fn run(root: &Path, command: &str) -> Result<String, String> {
    let p = prepare(root, command)?;
    let child = tokio::process::Command::new(p.program)
        .args(&p.args)
        .current_dir(&p.cwd)
        .env("PATH", crate::platform::tool_path(None))
        .env("ELAN_TOOLCHAIN", std::env::var("ELAN_TOOLCHAIN").unwrap_or_else(|_| TOOLCHAIN.into()))
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(TIMEOUT, child).await.map_err(|_| "Timed out after 15 minutes".to_string())?.map_err(|e| e.to_string())?;
    Ok(clip(format!("exit {}\n{}{}", out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::swarm2::fsguard::tests::{nested_with_stray, TempDir};

    #[test]
    fn r1_nested_lake_project_is_found() {
        let t = TempDir::new("r1");
        t.file("validation/lean/lakefile.toml", "name = \"v\"\nsrcDir = \"src\"\n\n[[lean_lib]]\nname = \"Generated\"\n")
            .file("aaa/lakefile.toml", "name = \"other\"\n\n[[lean_lib]]\nname = \"Other\"\n");
        let p = discover(&t.0).unwrap();
        assert_eq!(p.dir, t.0.join("validation/lean"));
        assert_eq!(p.src, t.0.join("validation/lean/src"));
        assert_eq!((p.specs, p.proofs, p.functions), ("Generated", "Refinement", "Swarm"));
    }

    #[test]
    fn lake_dir_prefers_config_then_folder_then_formal() {
        let t = TempDir::new("lakedir");
        t.file("formal/lakefile.toml", "").file("proofs/lakefile.lean", "");
        assert_eq!(lake_dir(&t.0), Some(t.0.join("formal")));
        t.file(CONFIG, "[lean]\nproject = \"proofs\"\n");
        assert_eq!(lake_dir(&t.0), Some(t.0.join("proofs")));
        t.file(CONFIG, "[lean]\nproject = \"missing\"\n").file("lakefile.toml", "");
        assert_eq!(lake_dir(&t.0), Some(t.0.clone()));
    }

    #[test]
    fn nested_search_skips_dependencies_and_stops_at_three_levels() {
        let t = TempDir::new("skip");
        t.file("lib/dep/lakefile.toml", "[[lean_lib]]\nname = \"Specs\"\n").file("a/b/c/d/lakefile.toml", "[[lean_lib]]\nname = \"Specs\"\n");
        assert_eq!(lake_dir(&t.0), None);
        t.file("a/b/c/lakefile.lean", "lean_lib Specs where\n");
        assert_eq!(lake_dir(&t.0), Some(t.0.join("a/b/c")));
    }

    #[test]
    fn lean_src_follows_config_then_src_dir() {
        let t = TempDir::new("src");
        t.file("formal/lakefile.lean", "package formal where\n  srcDir := \"Lean\"\n");
        assert_eq!(lean_src(&t.0), Some(t.0.join("formal/Lean")));
        t.file(CONFIG, "[lean]\nsources = \"formal/Other\"\n");
        assert_eq!(lean_src(&t.0), Some(t.0.join("formal/Other")));
        t.file(CONFIG, "[lean]\nsources = \"outside\"\n");
        assert_eq!(lean_src(&t.0), Some(t.0.join("formal/Lean")));
        t.file("formal/lakefile.lean", "package formal where\n  srcDir := \"../up\"\n");
        assert_eq!(lean_src(&t.0), Some(t.0.join("formal")));
    }

    #[test]
    fn layout_is_specs_proofs_unless_legacy_folders_exist() {
        let t = TempDir::new("layout");
        t.file("formal/lakefile.toml", "").file("formal/Proofs/Swarm/A.lean", "");
        let p = discover(&t.0).unwrap();
        assert_eq!((p.specs, p.proofs, p.functions), ("Specs", "Proofs", "Swarm"));
        t.file("formal/Proofs/Functions/B.lean", "");
        assert_eq!(discover(&t.0).unwrap().functions, "Functions");
        t.file("formal/Generated/M.lean", "");
        assert_eq!(discover(&t.0).unwrap().proofs, "Refinement");
    }

    #[test]
    fn scaffold_makes_a_specs_proofs_project() {
        let t = TempDir::new("scaffold");
        assert!(discover(&t.0).is_none());
        let p = scaffold(&t.0).unwrap();
        assert_eq!(p.dir, t.0.join("formal"));
        assert_eq!((p.specs, p.proofs, p.functions), ("Specs", "Proofs", "Functions"));
        assert_eq!(std::fs::read_to_string(t.0.join("formal/lean-toolchain")).unwrap(), "leanprover/lean4:v4.35.0\n");
        assert_eq!(std::fs::read_to_string(t.0.join("formal/.gitignore")).unwrap(), ".lake/\n");
        assert!(t.0.join("formal/Specs").is_dir() && t.0.join("formal/Proofs").is_dir());
    }

    #[test]
    fn proof_file_names_contract_and_function() {
        let t = TempDir::new("proof");
        assert_eq!(proof_file(&t.0, "WETH9", "deposit"), "formal/Proofs/Functions/WETH9Deposit.lean");
        assert_eq!(proof_file(&t.0, "WETH9", "WETH9.«»"), "formal/Proofs/Functions/WETH9Fallback.lean");
        let n = nested_with_stray();
        assert_eq!(proof_file(&n.0, "Router", "Router.matchBook"), "validation/lean/Refinement/Swarm/RouterMatchBook.lean");
    }

    #[test]
    fn r12_build_only_what_the_item_wrote() {
        let t = TempDir::new("r12");
        scaffold(&t.0).unwrap();
        let files = ["formal/Proofs/Functions/WETH9Deposit.lean", "formal/Proofs/InformalSpecs/S01/WETH9Fallback.lean", "formal/Proofs/InformalSpecs/S01/WETH9«».lean", "README.md"];
        assert_eq!(build_command(&t.0, &files), "lake build Proofs.Functions.WETH9Deposit Proofs.InformalSpecs.S01.WETH9Fallback");
        assert_eq!(build_command(&t.0, &["src/A.sol"]), "lake build");
    }

    #[test]
    fn b26_only_lake_and_forge_run() {
        let t = TempDir::new("b26");
        scaffold(&t.0).unwrap();
        t.file("formal/Proofs/A.lean", "theorem t : True := trivial\n");
        for ok in ["lake build", "lake build Proofs.A", "lake exe cache get", "lake new Foo_1", "lake init Bar", "lake env lean formal/Proofs/A.lean", "forge build", "forge test --mt x"] {
            assert!(prepare(&t.0, ok).is_ok(), "{ok}");
        }
        for bad in ["rm -rf /", "lake exe evil", "lake new ../x", "lake new A B", "lake env lean ../x.lean", "forge script X", "git status", "bash -c lake", ""] {
            let err = prepare(&t.0, bad).unwrap_err();
            assert!(err == ALLOWLIST_ERROR || err.contains("outside the folder"), "{bad}: {err}");
        }
    }

    #[test]
    fn b26_lake_runs_in_the_project_and_forge_in_the_folder() {
        let n = nested_with_stray();
        assert_eq!(prepare(&n.0, "lake build").unwrap().cwd, n.0.join("validation/lean"));
        assert_eq!(prepare(&n.0, "forge test").unwrap().cwd, n.0);
        let p = prepare(&n.0, "lake env lean validation/lean/Generated/AsyncSwap.lean").unwrap();
        assert_eq!(p.args, vec!["env".to_string(), "lean".into(), n.0.join("validation/lean/Generated/AsyncSwap.lean").to_string_lossy().into_owned()]);
        let empty = TempDir::new("b26-empty");
        assert_eq!(prepare(&empty.0, "lake build").unwrap().cwd, empty.0);
    }

    #[test]
    fn b27_lake_env_lean_refuses_a_stray_copy() {
        let n = nested_with_stray();
        let err = prepare(&n.0, "lake env lean Generated/AsyncSwap.lean").unwrap_err();
        assert!(err.ends_with("use validation/lean/Generated/AsyncSwap.lean"), "{err}");
    }

    #[test]
    fn b26_lean_that_runs_code_blocks_lake() {
        let t = TempDir::new("guard");
        scaffold(&t.0).unwrap();
        t.file("formal/.lake/packages/x/Bad.lean", "#eval 1\n");
        assert!(prepare(&t.0, "lake build").is_ok());
        for risky in RISKY_LEAN {
            t.file("formal/Proofs/Bad.lean", &format!("{risky} x\n"));
            let err = prepare(&t.0, "lake build").unwrap_err();
            assert!(err.starts_with(&format!("formal/Proofs/Bad.lean uses `{risky}`")), "{err}");
        }
        assert!(prepare(&t.0, "forge build").is_ok());
    }

    #[test]
    fn b26_long_output_is_clipped_head_and_tail() {
        let s = format!("{}{}", "a".repeat(10_000), "b".repeat(10_000));
        let c = clip(s);
        assert!(c.starts_with("aaa") && c.ends_with("bbb") && c.contains("\n… [cut] …\n"));
        assert_eq!(clip("short".into()), "short");
    }
}
