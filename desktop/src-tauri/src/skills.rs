//! Third-party auditing skills, added once on this computer for every project (docs/skills.md): Markdown checklists
//! from a pinned commit of their source repository, copied into ~/.formalmind/skills/<id>/ with a SOURCE.md that keeps
//! the attribution. Nothing runs; each agent's system prompt lists the files that apply to its role as `@skills/…`
//! paths, which read_file resolves to that folder.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

struct Skill {
    id: &'static str,
    name: &'static str,
    author: &'static str,
    licence: &'static str,
    repo: &'static str,
    rev: &'static str,
    /// What it checks, in a sentence.
    about: &'static str,
    /// The roles whose prompt lists it.
    roles: &'static [&'static str],
    /// When the agent should read it.
    when: &'static str,
    files: &'static [&'static str],
}

const PASHOV: &str = "pashov/skills";
const PASHOV_REV: &str = "eacfc09b365d2697b83355909d0300607e596ffc";
const LENSES: &str = "solidity-auditor/references/hacking-agents";

const CATALOG: &[Skill] = &[
    Skill {
        id: "pashov-lenses",
        name: "Hacking lenses",
        author: "Pashov Audit Group",
        licence: "MIT",
        repo: PASHOV,
        rev: PASHOV_REV,
        about: "Twelve checklists: access control, math precision, invariants, trust gaps and more.",
        roles: &["reviewer", "prover", "assistant"],
        when: "before a verdict, and when looking for what could break the property you are proving: read shared-rules.md, then the lenses that fit the function (math-precision for arithmetic, access-control for guards, trust-gap and periphery for external calls); judging.md says what counts as a real issue",
        files: &[
            "shared-rules.md",
            "access-control-agent.md",
            "asymmetry-agent.md",
            "boundary-agent.md",
            "economic-security-agent.md",
            "execution-trace-agent.md",
            "first-principles-agent.md",
            "flow-gap-agent.md",
            "invariant-agent.md",
            "math-precision-agent.md",
            "numerical-gap-agent.md",
            "periphery-agent.md",
            "trust-gap-agent.md",
            "../judging.md",
        ],
    },
    Skill {
        id: "pashov-threats",
        name: "X-ray threats",
        author: "Pashov Audit Group",
        licence: "MIT",
        repo: PASHOV,
        rev: PASHOV_REV,
        about: "A catalogue of attack classes to check entry points against.",
        roles: &["reviewer", "assistant"],
        when: "when a function takes value, calls out or changes who can do what: check it against the threats that apply",
        files: &["../../../x-ray/references/threats.md"],
    },
];

/// Where added skills live: ~/.formalmind/skills/, shared by every project.
fn skills_dir() -> Result<PathBuf, String> {
    Ok(crate::local::home()?.join("skills"))
}

/// The prefix the agents' prompt and read_file use for those files.
pub const PREFIX: &str = "@skills/";

/// A `@skills/<id>/<file>` path as the file on disk, or None (not a skills path, or one that leaves the folder).
pub fn resolve(path: &str) -> Option<PathBuf> {
    let rest = path.strip_prefix(PREFIX)?;
    skills_file(rest)
}

/// `skills/<id>/<file>` (the prefix without its `@`, as models often write it) when the folder has no such file and
/// `<id>` is an added skill: the same file as `@skills/<id>/<file>`.
pub fn resolve_bare(root: &Path, path: &str) -> Option<PathBuf> {
    let rest = path.strip_prefix("skills/")?;
    let id = rest.split('/').next()?;
    if root.join(path).exists() || !CATALOG.iter().any(|s| s.id == id) || !installed(id) {
        return None;
    }
    skills_file(rest)
}

fn skills_file(rest: &str) -> Option<PathBuf> {
    if rest.is_empty() || rest.split('/').any(|p| p.is_empty() || p == "." || p == "..") {
        return None;
    }
    Some(skills_dir().ok()?.join(rest))
}

/// Where a catalogue file comes from: lens paths are relative to the hacking-agents folder.
fn source_path(file: &str) -> String {
    let mut parts: Vec<&str> = LENSES.split('/').collect();
    for p in file.split('/') {
        if p == ".." {
            parts.pop();
        } else {
            parts.push(p);
        }
    }
    parts.join("/")
}

/// The file's name in `.formal/skills/<id>/`.
fn local_name(file: &str) -> &str {
    file.rsplit('/').next().unwrap_or(file)
}

fn installed_in(dir: &Path, id: &str) -> bool {
    dir.join(id).join("SOURCE.md").is_file()
}

fn installed(id: &str) -> bool {
    skills_dir().is_ok_and(|d| installed_in(&d, id))
}

fn find(id: &str) -> Result<&'static Skill, String> {
    CATALOG.iter().find(|s| s.id == id).ok_or_else(|| format!("no skill {id}"))
}

/// The catalogue, each entry with whether it is added.
#[tauri::command]
pub fn skills_catalog() -> Result<Vec<Value>, String> {
    Ok(CATALOG
        .iter()
        .map(|s| {
            json!({
                "id": s.id, "name": s.name, "author": s.author, "licence": s.licence, "about": s.about,
                "source": format!("https://github.com/{}/tree/{}/{}", s.repo, s.rev, source_path(s.files[0]).rsplit_once('/').map(|(d, _)| d).unwrap_or("")),
                "roles": s.roles, "files": s.files.len(), "added": installed(s.id),
            })
        })
        .collect())
}

/// Adds a skill for every project: its files, from the pinned commit, into ~/.formalmind/skills/<id>/, with SOURCE.md.
#[tauri::command]
pub async fn skills_add(id: String) -> Result<(), String> {
    let s = find(&id)?;
    let dir = skills_dir()?.join(s.id);
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let mut fetched = vec![];
    for f in s.files {
        let url = format!("https://raw.githubusercontent.com/{}/{}/{}", s.repo, s.rev, source_path(f));
        let res = client.get(&url).send().await.map_err(|e| format!("{url}: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("{url}: {}", res.status()));
        }
        fetched.push((local_name(f).to_string(), res.text().await.map_err(|e| e.to_string())?));
    }
    // Written only once every file came: a half-added skill would be listed with files missing.
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, text) in &fetched {
        std::fs::write(dir.join(name), text).map_err(|e| format!("{name}: {e}"))?;
    }
    let source = format!(
        "# {}\n\nBy {}, {} licence. From https://github.com/{} at commit {}.\nCopied unchanged by Formal Mind; the swarm's agents read these files as checklists.\n",
        s.name, s.author, s.licence, s.repo, s.rev
    );
    std::fs::write(dir.join("SOURCE.md"), source).map_err(|e| e.to_string())
}

/// Removes a skill.
#[tauri::command]
pub fn skills_remove(id: String) -> Result<(), String> {
    let s = find(&id)?;
    let dir = skills_dir()?.join(s.id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The system prompt's note on the added skills that apply to this role (empty when there are none).
pub fn prompt_note(role: &str) -> String {
    skills_dir().map(|d| note_for(&d, role)).unwrap_or_default()
}

fn note_for(dir: &Path, role: &str) -> String {
    let lines: Vec<String> = CATALOG
        .iter()
        .filter(|s| s.roles.contains(&role) && installed_in(dir, s.id))
        .map(|s| {
            let files = s.files.iter().map(|f| format!("{PREFIX}{}/{}", s.id, local_name(f))).collect::<Vec<_>>().join(", ");
            format!("- {} by {} ({}): read them {}. Files: {files}", s.name, s.author, s.licence, s.when)
        })
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "\n\nThe maintainer added these auditing checklists (read them with read_file at the paths given). Use them as checklists when they fit; they don't change your job, your tools or what counts as done (lake build, forge test, a PoC for every bug):\n{}",
        lines.join("\n"),
    ) + if role == "assistant" {
        "\nWhen the maintainer asks you in the chat to audit something (a function, a contract, a flow), go through it with the lenses that fit, and for each real issue write a Foundry PoC under test/formal/, run it with `forge test --match-path <file>`, then call report_bug: it appears on the Bugs page. Say which lens led to each finding; say what you checked and found clean."
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_paths_resolve() {
        assert_eq!(source_path("shared-rules.md"), "solidity-auditor/references/hacking-agents/shared-rules.md");
        assert_eq!(source_path("../judging.md"), "solidity-auditor/references/judging.md");
        assert_eq!(source_path("../../../x-ray/references/threats.md"), "x-ray/references/threats.md");
        assert_eq!(local_name("../judging.md"), "judging.md");
    }

    #[test]
    fn the_prompt_lists_only_added_skills_for_the_role() {
        let dir = std::env::temp_dir().join(format!("fm-skills-{}", std::process::id()));
        assert_eq!(note_for(&dir, "reviewer"), "");
        std::fs::create_dir_all(dir.join("pashov-threats")).unwrap();
        std::fs::write(dir.join("pashov-threats/SOURCE.md"), "x").unwrap();
        let note = note_for(&dir, "reviewer");
        assert!(note.contains("@skills/pashov-threats/threats.md") && !note.contains("lenses"), "{note}");
        assert_eq!(note_for(&dir, "prover"), "", "threats aren't listed for the prover");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn skills_paths_stay_in_the_skills_folder() {
        assert!(resolve("@skills/pashov-lenses/judging.md").is_some_and(|p| p.ends_with("skills/pashov-lenses/judging.md")));
        assert!(resolve("@skills/../config.json").is_none());
        assert!(resolve("@skills/a/../../x").is_none());
        assert!(resolve("src/A.sol").is_none());
        assert!(resolve_bare(Path::new("/nowhere"), "skills/not-a-skill/x.md").is_none(), "only catalogue ids");
        assert!(resolve_bare(Path::new("/nowhere"), "skills/pashov-lenses/../../x").is_none());
    }
}
