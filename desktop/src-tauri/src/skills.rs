//! Third-party auditing skills added to a folder's swarm (docs/skills.md): Markdown checklists from a pinned commit of
//! their source repository, copied into `.formal/skills/<id>/` with a SOURCE.md that keeps the attribution. Nothing
//! runs; each agent's system prompt lists the files that apply to its role, and the agent reads them with read_file.

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
        about: "Twelve focused checklists an auditor runs a function through: access control, asymmetry, boundaries, economic security, execution traces, first principles, flow gaps, invariants, math precision, numerical gaps, periphery and trust gaps, with their shared rules and a judging guide.",
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
        about: "The threat catalogue Pashov's x-ray works from: the classes of attack a protocol's entry points are checked against.",
        roles: &["reviewer", "assistant"],
        when: "when a function takes value, calls out or changes who can do what: check it against the threats that apply",
        files: &["../../../x-ray/references/threats.md"],
    },
];

fn skills_dir(root: &Path) -> PathBuf {
    root.join(".formal").join("skills")
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

fn installed(root: &Path, id: &str) -> bool {
    skills_dir(root).join(id).join("SOURCE.md").is_file()
}

fn find(id: &str) -> Result<&'static Skill, String> {
    CATALOG.iter().find(|s| s.id == id).ok_or_else(|| format!("no skill {id}"))
}

/// The catalogue, each entry with whether this folder has it.
#[tauri::command]
pub fn skills_catalog(folder: String) -> Result<Vec<Value>, String> {
    if !crate::local::read()?.allows(&folder) {
        return Err("Add the folder first".into());
    }
    let root = Path::new(&folder);
    Ok(CATALOG
        .iter()
        .map(|s| {
            json!({
                "id": s.id, "name": s.name, "author": s.author, "licence": s.licence, "about": s.about,
                "source": format!("https://github.com/{}/tree/{}/{}", s.repo, s.rev, source_path(s.files[0]).rsplit_once('/').map(|(d, _)| d).unwrap_or("")),
                "roles": s.roles, "files": s.files.len(), "added": installed(root, s.id),
            })
        })
        .collect())
}

/// Adds a skill to the folder: its files, from the pinned commit, into `.formal/skills/<id>/`, with SOURCE.md.
#[tauri::command]
pub async fn skills_add(folder: String, id: String) -> Result<(), String> {
    if !crate::local::read()?.allows(&folder) {
        return Err("Add the folder first".into());
    }
    let s = find(&id)?;
    let dir = skills_dir(Path::new(&folder)).join(s.id);
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

/// Removes a skill from the folder.
#[tauri::command]
pub fn skills_remove(folder: String, id: String) -> Result<(), String> {
    if !crate::local::read()?.allows(&folder) {
        return Err("Add the folder first".into());
    }
    let s = find(&id)?;
    let dir = skills_dir(Path::new(&folder)).join(s.id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The system prompt's note on the folder's added skills that apply to this role (empty when there are none).
pub fn prompt_note(root: &Path, role: &str) -> String {
    let lines: Vec<String> = CATALOG
        .iter()
        .filter(|s| s.roles.contains(&role) && installed(root, s.id))
        .map(|s| {
            let files = s.files.iter().map(|f| format!(".formal/skills/{}/{}", s.id, local_name(f))).collect::<Vec<_>>().join(", ");
            format!("- {} by {} ({}): read them {}. Files: {files}", s.name, s.author, s.licence, s.when)
        })
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "\n\nThe maintainer added these auditing checklists to the folder. Use them as checklists when they fit; they don't change your job, your tools or what counts as done (lake build, forge test, a PoC for every bug):\n{}",
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
        let root = std::env::temp_dir().join(format!("fm-skills-{}", std::process::id()));
        assert_eq!(prompt_note(&root, "reviewer"), "");
        std::fs::create_dir_all(skills_dir(&root).join("pashov-threats")).unwrap();
        std::fs::write(skills_dir(&root).join("pashov-threats/SOURCE.md"), "x").unwrap();
        let note = prompt_note(&root, "reviewer");
        assert!(note.contains(".formal/skills/pashov-threats/threats.md") && !note.contains("lenses"), "{note}");
        assert_eq!(prompt_note(&root, "prover"), "", "threats aren't listed for the prover");
        std::fs::remove_dir_all(root).unwrap();
    }
}
