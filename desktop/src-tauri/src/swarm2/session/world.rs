//! What the loop needs from outside itself: the folder guard and credentials (B1), formal-ast (plan lines, briefs,
//! coverage), Lean (the ledger, `lake build`, a statement's theorem), the side effects of an approval (ledger, publish),
//! the tools, health lines and the app's exit. [`Live`] is the app's; the tests drive the loop with a fake.

use super::super::executor::{api, claude_code::ClaudeCodeAgent, codex::CodexAgent, Agent, BoxFuture};
use super::super::{lake, ledger, tools};
use super::SwarmRequest;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// formal-ast's reading of the folder at a plan sync.
#[derive(Default)]
pub struct Scan {
    /// The `tool` line: `functions: N in scope across A, B`.
    pub in_scope: String,
    /// Plan lines for units the plan doesn't have yet (already-proved ones come checked).
    pub missing: Vec<String>,
    /// Files formal-ast couldn't read.
    pub problems: Vec<String>,
    /// Models rewritten (B34).
    pub regenerated: Vec<String>,
    /// The reading itself, kept for the tools (`functions`, `function`, `formalize_result`).
    pub ast: Option<Arc<crate::swarm_ctx::Context>>,
}

/// The Proofs page's view of an item's def after its build passed (B17's last step).
#[derive(Debug, Clone, PartialEq)]
pub enum Coverage {
    /// The item names no def formal-ast knows: nothing more to check.
    NoTarget,
    /// Proved by these sorry-free theorems.
    Proved { lean: String, theorems: Vec<String> },
    /// The build passed but no sorry-free theorem names the def.
    NotProved { lean: String, name: String },
}

pub trait World: Send + Sync {
    /// The folder guard (`"Add the folder first"`).
    fn allowed(&self, folder: &str) -> Result<(), String>;
    /// B1: the route's agent, or the credential error the UI shows.
    fn agent(&self, req: &SwarmRequest) -> Result<Arc<dyn Agent>, String>;
    /// The role's system prompt (verbatim `swarm.rs::system`).
    fn system(&self, role: &str, folder: &str, goal: &str) -> String {
        super::prompts::system(role, folder, goal)
    }
    /// The role's tool schemas (B23).
    fn tools(&self, role: &str) -> Vec<Value> {
        tools::schemas(role).as_array().cloned().unwrap_or_default()
    }
    /// Once per session start: `formalmind.toml` where a Lake project exists.
    fn prepare(&self, _root: &Path) {}
    /// formal-ast's reading of the folder (solc runs here); None when it can't be read.
    fn ast<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Option<Arc<crate::swarm_ctx::Context>>>;
    /// B15: formal-ast's side of a plan sync (models written as needed). `plan` is the plan's text now.
    fn scan<'a>(&'a self, root: &'a Path, plan: &'a str) -> BoxFuture<'a, Scan>;
    /// B31: the ledger, Lean rerun only when the sources changed.
    fn ledger<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Result<Value, String>>;
    /// The prover's and reviewer's brief for a plan item or obligation line.
    fn brief(&self, root: &Path, ast: Option<&crate::swarm_ctx::Context>, text: &str) -> String;
    /// A `run` command (`lake build <modules>` for the check).
    fn run<'a>(&'a self, root: &'a Path, command: &'a str) -> BoxFuture<'a, String>;
    /// B17's last step, on a fresh reading.
    fn coverage(&self, ast: Option<&crate::swarm_ctx::Context>, text: &str) -> Coverage;
    /// B17 for an obligation: the named theorem exists, has no sorryAx and names the def. Ok(its type).
    fn check_theorem<'a>(&'a self, root: &'a Path, statement: &'a str, lean: &'a str) -> BoxFuture<'a, Result<String, String>>;
    /// B18/B32/B58: a plan item approved: the ledger's approval and publishing.
    fn approved(&self, root: &Path, item_text: &str, notes: &str);
    /// B52/B58: a statement proved.
    fn statement_proved(&self, root: &Path, id: &str);
    /// B50: with Settings `answers: agent`, the answerer confirms or corrects in the background.
    fn asked(&self, _folder: &str, _statement: &str) {}
    /// One tool call (B23–B30).
    fn tool<'a>(&'a self, ctx: &'a tools::Ctx<'a>, role: &'a str, name: &'a str, args: &'a Value) -> BoxFuture<'a, String> {
        Box::pin(tools::call(ctx, role, name, args))
    }
    /// B7: the folder's background forge tasks.
    fn cancel_tasks(&self, _folder: &str) {}
    /// B43: a health record for a turn, or None (tests).
    fn health(&self, _folder: &str, _run: &str, _job: u64, _role: &str, _item: &str, _req: &SwarmRequest) -> Option<crate::health::Turn> {
        None
    }
    /// B8/B11: ⌘Q was pressed and the last session ended.
    fn exit(&self) {}
}

/// The app's world: the keychain, `~/.formalmind`, formal-ast, Lake and publish.
pub struct Live<R: tauri::Runtime> {
    pub app: tauri::AppHandle<R>,
}

/// The model a request runs on (swarm.rs::model_of).
pub fn model_of(req: &SwarmRequest) -> String {
    match req.provider.as_deref() {
        Some("codex") => req.model.as_deref().filter(|m| crate::codex::MODELS.contains(m)).unwrap_or(crate::codex::MODELS[0]).to_string(),
        Some("openai") => req.model.as_deref().filter(|m| crate::openai::MODELS.contains(m)).unwrap_or(crate::openai::MODELS[0]).to_string(),
        _ => match req.model.as_deref() {
            Some(m @ ("claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-5-5")) => m.to_string(),
            _ => api::DEFAULT_MODEL.to_string(),
        },
    }
}

fn keychain(account: &str) -> Option<String> {
    keyring::Entry::new("team.formal.desktop", account).ok()?.get_password().ok()
}

fn rel(root: &Path, p: PathBuf) -> String {
    p.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default()
}

impl<R: tauri::Runtime> World for Live<R> {
    fn allowed(&self, folder: &str) -> Result<(), String> {
        if crate::local::read()?.allows(folder) { Ok(()) } else { Err("Add the folder first".into()) }
    }

    fn agent(&self, req: &SwarmRequest) -> Result<Arc<dyn Agent>, String> {
        let model = model_of(req);
        let effort = crate::local::read().ok().and_then(|c| c.settings.effort());
        let home = || crate::local::home();
        Ok(match req.provider.as_deref() {
            Some("anthropic") => {
                let key = keychain("anthropic").ok_or("Add your Anthropic key first")?;
                Arc::new(api::ApiAgent::new(api::Wire::Messages, api::Access::Key { key, base: "https://api.anthropic.com".into() }, Some(&model)))
            }
            Some("openai") => {
                let key = keychain("openai").ok_or("Add your OpenAI key first")?;
                Arc::new(api::ApiAgent::new(api::Wire::ChatCompletions, api::Access::Key { key, base: "https://api.openai.com".into() }, Some(&model)))
            }
            Some("claude-code") => {
                crate::claude_code::signed_in()?;
                Arc::new(ClaudeCodeAgent::new(home()?, &model, effort))
            }
            Some("codex") => {
                crate::codex::signed_in()?;
                Arc::new(CodexAgent::new(home()?, Some(&model), effort))
            }
            _ => {
                let token = crate::swarm::token()?;
                Arc::new(api::ApiAgent::new(api::Wire::Messages, api::Access::Session { api: req.api_base.clone(), token }, Some(&model)))
            }
        })
    }

    fn prepare(&self, root: &Path) {
        crate::swarm_ctx::ensure_config(root);
    }

    fn ast<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Option<Arc<crate::swarm_ctx::Context>>> {
        let root = root.to_path_buf();
        Box::pin(async move { tauri::async_runtime::spawn_blocking(move || crate::swarm_ctx::context(&root)).await.ok().map(Arc::new) })
    }

    fn scan<'a>(&'a self, root: &'a Path, plan: &'a str) -> BoxFuture<'a, Scan> {
        Box::pin(async move {
            let Some(ctx) = self.ast(root).await else { return Scan::default() };
            Scan {
                in_scope: format!("functions: {} in scope across {}", ctx.units().len(), ctx.contracts.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ")),
                missing: ctx.missing_items(plan),
                problems: ctx.problems.clone(),
                regenerated: ctx.regenerated.clone(),
                ast: Some(ctx),
            }
        })
    }

    fn ledger<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Result<Value, String>> {
        let r = root.to_path_buf();
        Box::pin(ledger::build(root, true, false, move |cmd: String| {
            let r = r.clone();
            async move { lake::run(&r, &cmd).await.unwrap_or_else(|e| e) }
        }))
    }

    fn brief(&self, root: &Path, ast: Option<&crate::swarm_ctx::Context>, text: &str) -> String {
        ast.map(|c| c.brief(text, lake::lake_dir(root).as_deref(), root)).unwrap_or_default()
    }

    fn run<'a>(&'a self, root: &'a Path, command: &'a str) -> BoxFuture<'a, String> {
        Box::pin(async move { lake::run(root, command).await.unwrap_or_else(|e| format!("error: {e}")) })
    }

    fn coverage(&self, ast: Option<&crate::swarm_ctx::Context>, text: &str) -> Coverage {
        let Some(u) = ast.and_then(|c| c.target(text)) else { return Coverage::NoTarget };
        let lean = u.lean().to_string();
        match u.func {
            Some(f) if f.proved => Coverage::Proved { lean, theorems: f.theorems.clone() },
            _ => Coverage::NotProved { lean, name: u.name().to_string() },
        }
    }

    fn check_theorem<'a>(&'a self, root: &'a Path, statement: &'a str, lean: &'a str) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(crate::statements::check_theorem(root, statement, lean))
    }

    fn approved(&self, root: &Path, item_text: &str, notes: &str) {
        if let Err(e) = ledger::approve_item(root, item_text, notes) {
            eprintln!("ledger: {e}");
        }
        crate::publish::after_approval(root, &format!("proved {item_text}"));
    }

    fn statement_proved(&self, root: &Path, id: &str) {
        crate::publish::after_approval(root, &format!("statement {id} proved"));
    }

    fn asked(&self, folder: &str, statement: &str) {
        if crate::answerer::on() {
            let (folder, sid) = (folder.to_string(), statement.to_string());
            tauri::async_runtime::spawn(async move {
                match crate::answerer::answer(&folder, &sid).await {
                    Ok(what) => eprintln!("answerer: {what}"),
                    Err(e) => eprintln!("answerer: {e}"),
                }
            });
        }
    }

    fn cancel_tasks(&self, folder: &str) {
        crate::analysis::cancel_tasks(folder);
    }

    fn health(&self, folder: &str, run: &str, job: u64, role: &str, item: &str, req: &SwarmRequest) -> Option<crate::health::Turn> {
        Some(crate::health::Turn::new(folder, run, job, role, item, req.provider.as_deref().unwrap_or("formal"), &model_of(req)))
    }

    fn exit(&self) {
        self.app.exit(0);
    }
}

/// Where an item's proof belongs, folder-relative, when a file is there: a statement's obligation in
/// `Proofs/InformalSpecs/<id>/`, a plan item in `Proofs/Functions/` (swarm.rs::expected_proof).
pub fn expected_proof(root: &Path, statement: Option<&str>, text: &str) -> Option<String> {
    let lean = crate::statements::def_of(text)?;
    let path = match statement {
        Some(id) => lake::lean_src(root)?.join(crate::statements::proof_file(id, lean, &crate::swarm_ctx::informal_dir(root))),
        None => {
            let (contract, function) = lean.split_once('.')?;
            root.join(lake::proof_file(root, contract, function))
        }
    };
    path.is_file().then(|| rel(root, path))
}
