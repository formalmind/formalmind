//! The swarm roles' tools (SPEC.md B23, B27–B30, "Tools and the folder sandbox"): each role's schemas, word for word
//! as the role prompts and models know them, and the handlers that answer them on the folder through `fsguard`,
//! `lake`, `plan` and `queue`. What a tool decides for the loop (a verdict, a bug, reopened work) goes out through
//! [`Hooks::effect`]; the queue writes that must survive a quit (B29's files, R8's verdict) happen here at once.

use super::events::Kind;
use super::{fsguard, lake, plan, queue};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

/// read_file returns files up to this size whole (B28).
const WHOLE_FILE: usize = 12_000;
/// read_file's longest slice (B28).
const SLICE_LINES: usize = 300;
/// A write's diff in the chat is cut here (B29).
const DIFF_LIMIT: usize = 20_000;
/// `find` returns at most this many files (B27).
const FIND_LIMIT: usize = 30;
/// Tool and result events show this much of a call's input or answer.
const SHOWN: usize = 500;

// ---- schemas ----

/// `report_bug`'s schema (also served to Claude Code).
pub fn report_bug_schema() -> Value {
    let s = |props: Value, req: Vec<&str>| json!({ "type": "object", "properties": props, "required": req, "additionalProperties": false });
    json!({ "name": "report_bug", "description": "Report a real bug in the contracts, with its Foundry PoC (already written and passing). The swarm runs the PoC, files the finding in audit/README.md (status Open), audit/formal-mind-swarm.md and Formal Mind's audit file (audit/formal-mind.audit.json, which its report is generated from), and moves on to the next item. Write the title, scenario, impact and recommendation as an audit report states a finding: third person, no process talk.", "input_schema": s(json!({
            "title": { "type": "string" }, "severity": { "type": "string", "enum": ["critical", "high", "medium", "low"] },
            "location": { "type": "string", "description": "file:line" }, "scenario": { "type": "string", "description": "What's wrong and the concrete steps that exploit it, as an audit report describes a finding" },
            "impact": { "type": "string", "description": "What an attacker gains or users lose, as a report states it" },
            "recommendation": { "type": "string", "description": "How to fix it" },
            "poc": { "type": "string", "description": "The PoC test file under test/, e.g. test/formal/RouterMatchBook.t.sol" },
            "evidence": { "type": "string", "description": "Anything else: the Lean counterexample, the property it breaks" } }), vec!["title", "severity", "location", "scenario", "poc"]) })
}

fn start_work_schema() -> Value {
    json!({ "name": "start_work", "description": "Only when the maintainer asks the swarm to do work (prove the plan or the functions left, review, carry on): after your answer, the session goes on with the plan instead of stopping. Not for a question, an explanation or an audit you do yourself in the chat.", "input_schema": { "type": "object", "properties": {}, "required": [] } })
}

fn reopen_schema() -> Value {
    json!({ "name": "reopen", "description": "When the maintainer asks to prove functions again (their code changed, a proof is wrong or too weak): reopens those plan items in .formal/plan.md, proved or blocked, so the prover takes them in turn, and the session goes on with the plan after your answer. Name each function by its Lean def as the plan lists it (e.g. `AsyncSwap.useNonce`).", "input_schema": { "type": "object", "properties": { "defs": { "type": "array", "items": { "type": "string" } } }, "required": ["defs"] } })
}

/// B23: the tools a role gets, in the order the old `swarm.rs::tools` gave them (schemas byte-for-byte the same).
/// `tag`, `run_in_background`, `background_results`, `add_statement`, `formalize_result` and `confirm_statement`
/// come from `analysis` and `statements`, which own them.
pub fn schemas(role: &str) -> Value {
    let s = |props: Value, req: Vec<&str>| json!({ "type": "object", "properties": props, "required": req, "additionalProperties": false });
    let mut t = vec![
        json!({ "name": "functions", "description": "Every function in scope, from formal-ast (solc's AST): the contracts the Foundry scripts deploy or call and their bases, each function with its Lean def, place, footprint and status on the Proofs page.", "input_schema": s(json!({}), vec![]) }),
        json!({ "name": "function", "description": "One function's slice from formal-ast: its guards, the storage it reads and writes, the state declarations it touches, its code and its callees' code. By name (`Contract.fn`) or Lean def.", "input_schema": s(json!({ "name": { "type": "string" } }), vec!["name"]) }),
        json!({ "name": "read_file", "description": "Read a text file in the folder (Lean files, the generated model, the test setup a PoC needs). Long files come back in numbered slices: pass start_line and end_line (up to 300 lines at a time).", "input_schema": s(json!({ "path": { "type": "string" }, "start_line": { "type": "integer" }, "end_line": { "type": "integer" } }), vec!["path"]) }),
        json!({ "name": "search", "description": "Find lines matching a regex in the Lean project's .lean files (path:line: text), e.g. simp lemmas about the monad.", "input_schema": s(json!({ "pattern": { "type": "string" } }), vec!["pattern"]) }),
        json!({ "name": "find", "description": "Find files by name or path, fuzzy (typos and gaps are fine, e.g. `refinement conservation` or `WP.lean`), best match first. Skips dependencies, build output and .lake.", "input_schema": s(json!({ "query": { "type": "string" } }), vec!["query"]) }),
        json!({ "name": "run", "description": "Run `lake build`, `lake env lean <file>`, `lake exe cache get`, `lake init|new <Name>`, `forge build` or `forge test [args]` in the folder. Returns exit code and output.", "input_schema": s(json!({ "command": { "type": "string" } }), vec!["command"]) }),
    ];
    if role == "auditor" {
        t.push(json!({ "name": "record_report", "description": "Record the report's own facts in its standard audit file (formalmind.audit/v1, next to the report). Call once, first.", "input_schema": s(json!({
            "title": { "type": "string" }, "auditor": { "type": "string", "description": "The auditing firm or person" },
            "authors": { "type": "array", "items": { "type": "string" } }, "date": { "type": "string", "description": "YYYY-MM-DD" },
            "commit": { "type": "string" }, "repository": { "type": "string" },
            "scope": { "type": "array", "items": { "type": "string" }, "description": "Files in scope, as repository paths" },
            "summary": { "type": "string" } }), vec!["title"]) }));
        t.push(json!({ "name": "record_finding", "description": "Record one of the report's findings in its standard audit file, with its status in the current code. Calling it again with the same id replaces that finding.", "input_schema": s(json!({
            "id": { "type": "string", "description": "The report's own ID, e.g. H-01" },
            "title": { "type": "string" },
            "severity": { "type": "string", "enum": ["critical", "high", "medium", "low", "informational", "gas"] },
            "status": { "type": "string", "enum": ["fixed", "works as expected", "acknowledged", "open"], "description": "Where it stands in the current code" },
            "reportStatus": { "type": "string", "description": "The status the report itself gave, e.g. Fixed in PR #123, Acknowledged" },
            "locations": { "type": "array", "items": { "type": "object", "properties": { "file": { "type": "string" }, "line": { "type": "integer" } }, "required": ["file"], "additionalProperties": false } },
            "description": { "type": "string" }, "impact": { "type": "string" }, "recommendation": { "type": "string" },
            "response": { "type": "string", "description": "The team's response in the report" },
            "evidence": { "type": "string", "description": "Why this status: what changed (file:line) and the test that covers it, or why it is intended" },
            "tests": { "type": "array", "items": { "type": "string" } },
            "page": { "type": "integer" } }), vec!["id", "title", "severity", "status", "description"]) }));
    }
    if role != "reviewer" && role != "auditor" {
        t.push(report_bug_schema());
        t.push(json!({ "name": "write_file", "description": "Create or overwrite a file in the folder.", "input_schema": s(json!({ "path": { "type": "string" }, "content": { "type": "string" } }), vec!["path", "content"]) }));
    }
    if role != "auditor" {
        t.extend(crate::analysis::tools());
    }
    if role == "assistant" {
        t.push(crate::statements::formalize_tool());
        t.push(crate::statements::confirm_tool());
        t.push(start_work_schema());
        t.push(reopen_schema());
    }
    if role == "prover" {
        t.push(json!({ "name": "record_property", "description": "Once your proof checks, write the notes that go into Formal Mind's report for this property (audit/formal-mind.audit.json). The reviewer checks them against the Solidity and your proof before they count. Call it again to replace them.", "input_schema": s(json!({
            "statement": { "type": "string", "description": "What the proof establishes about the function, as an audit report states a verified property: third person, present tense, what holds (e.g. \"`Router.swap` reverts unless the caller owns the order; on success it writes only …\"). Markdown; a bulleted list of what each theorem says is fine. No first person, no build, plan or next-step talk, and never a statement of what wasn't found." },
            "assumptions": { "type": "string", "description": "What the proof takes as given (e.g. black-box helpers that don't change storage), stated plainly; empty if none" },
            "theorems": { "type": "array", "items": { "type": "string" }, "description": "The names of the theorems that prove it" } }), vec!["statement", "theorems"]) }));
    }
    if role == "reviewer" {
        t.push(json!({ "name": "verdict", "description": "Your decision on the plan item. Approving records the prover's property notes in Formal Mind's audit file (audit/formal-mind.audit.json), which its report is generated from. Pass statement, assumptions or theorems only to correct them (or to write them if the prover gave none).", "input_schema": s(json!({
            "decision": { "type": "string", "enum": ["approve", "changes"] },
            "notes": { "type": "string" },
            "statement": { "type": "string", "description": "Approve only, to correct or supply the prover's notes: what the proof establishes about the function, as a report states a verified property: third person, present tense, what holds (e.g. \"`Router.swap` reverts unless the caller owns the order; on success it writes only …\"). Markdown; a bulleted list of the theorems' meanings is fine. No first person, no build or plan talk, and never a statement of what wasn't found." },
            "assumptions": { "type": "string", "description": "Approve only: what the proof takes as given (e.g. black-box helpers that don't change storage), stated plainly; empty if none" },
            "theorems": { "type": "array", "items": { "type": "string" }, "description": "Approve only: the names of the theorems that prove it" } }), vec!["decision"]) }));
    }
    Value::Array(t)
}

/// The tool names a role may call: its schemas, plus `list_files` (the executor's, not advertised to the swarm).
pub fn names(role: &str) -> Vec<String> {
    let mut n: Vec<String> = schemas(role).as_array().into_iter().flatten().filter_map(|t| t["name"].as_str().map(String::from)).collect();
    n.push("list_files".into());
    n
}

// ---- the host ----

/// What a tool call decided for the loop, applied by it (the outcome of the turn).
pub enum Effect {
    /// The reviewer's `verdict` (already stored on the job, R8); `property` is the input when it approves.
    Verdict { approve: bool, notes: String, property: Option<Value> },
    /// The prover's `record_property` input.
    Property(Value),
    /// A filed bug: `FM-NN title`.
    Bug(String),
    /// A formalize job's checked answer.
    Formalized(crate::statements::Formalized),
}

/// The loop's side of a tool call.
pub trait Hooks: Send + Sync {
    /// A `tool`, `result`, `status` or `bug` event in the session's chat.
    fn event(&self, kind: Kind, role: &str, item: &str, text: String);
    /// An outcome for the loop to apply.
    fn effect(&self, effect: Effect);
    /// Turns the session's plan work on (B19); returns whether it already was.
    fn work(&self) -> bool;
    /// formal-ast's reading of the folder (the loop builds and caches it), for `functions`, `function` and
    /// `formalize_result`; `None` when it hasn't been read.
    fn ast(&self) -> Option<Arc<crate::swarm_ctx::Context>>;
}

/// One call's context: the folder, the session and job it runs for, the plan item it shows under, and the hooks.
pub struct Ctx<'a> {
    pub root: &'a Path,
    pub session: &'a str,
    pub job: Option<u64>,
    pub item: &'a str,
    pub hooks: &'a dyn Hooks,
}

impl Ctx<'_> {
    fn emit(&self, kind: Kind, role: &str, text: String) {
        self.hooks.event(kind, role, self.item, text);
    }

    fn queue(&self) -> std::path::PathBuf {
        queue::queue_path(self.root, self.session)
    }

    /// The job's text (a triage job's report path).
    fn job_text(&self) -> String {
        self.job.and_then(|id| queue::Queue::load(&self.queue()).job(id).map(|j| j.text.clone())).unwrap_or_default()
    }
}

fn err(e: String) -> String {
    if e.starts_with("error: ") { e } else { format!("error: {e}") }
}

fn short(s: &str) -> String {
    s.chars().take(SHOWN).collect()
}

/// Runs `name` for `role` and returns what the agent reads back. Tools the role doesn't have are refused (B23).
pub async fn call(ctx: &Ctx<'_>, role: &str, name: &str, args: &Value) -> String {
    let str_arg = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let shown = args.as_object().map(|o| o.values().filter_map(Value::as_str).map(|v| v.chars().take(90).collect::<String>()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
    if !names(role).iter().any(|n| n == name) {
        return format!("error: No tool called {name} for the {role}");
    }
    let root = ctx.root;
    match name {
        "write_file" => write_file(ctx, role, &str_arg("path"), &str_arg("content")),
        "verdict" => {
            let approve = args["decision"].as_str() == Some("approve");
            if let Some(id) = ctx.job {
                // R8: on the job now, so a quit before the turn ends keeps it.
                let _ = queue::Queue::update(&ctx.queue(), |q| q.record_verdict(id, args.clone()));
            }
            ctx.emit(Kind::Tool, role, format!("verdict {}", if approve { "approve" } else { "changes" }));
            ctx.hooks.effect(Effect::Verdict { approve, notes: str_arg("notes"), property: approve.then(|| args.clone()) });
            "recorded".into()
        }
        "record_property" => {
            if str_arg("statement").trim().is_empty() {
                return "error: statement is required: what the proof establishes, as the report states it".into();
            }
            ctx.emit(Kind::Tool, role, "record_property".into());
            ctx.hooks.effect(Effect::Property(args.clone()));
            "recorded; the reviewer checks it against the Solidity and your proof".into()
        }
        "start_work" => {
            ctx.emit(Kind::Tool, role, "start_work".into());
            let r = if ctx.hooks.work() { "the swarm is already working on the plan" } else { "after your answer, the swarm works on the plan (the prover first), as the maintainer asked" };
            ctx.emit(Kind::Result, role, r.into());
            r.into()
        }
        "reopen" => {
            let defs: Vec<String> = args["defs"].as_array().into_iter().flatten().filter_map(|d| d.as_str().map(String::from)).collect();
            ctx.emit(Kind::Tool, role, format!("reopen {}", defs.join(", ")));
            let r = match plan::reopen(root, &defs) {
                Ok((done, unknown)) => {
                    if !done.is_empty() {
                        ctx.hooks.work();
                    }
                    let mut r = if done.is_empty() { "nothing reopened".to_string() } else { format!("reopened {}; after your answer, the swarm proves them", done.join(", ")) };
                    if !unknown.is_empty() {
                        r.push_str(&format!("; not in the plan: {}", unknown.join(", ")));
                    }
                    r
                }
                Err(e) => err(e.to_string()),
            };
            ctx.emit(Kind::Result, role, r.clone());
            r
        }
        "report_bug" => {
            ctx.emit(Kind::Tool, role, format!("report_bug {shown}"));
            let r = match report_bug(ctx, role, args).await {
                Ok((id, file)) => {
                    ctx.hooks.effect(Effect::Bug(format!("{id} {}", args["title"].as_str().unwrap_or("bug"))));
                    format!("filed as {id} in audit/README.md (open) and {file}; the swarm marks this item and moves on")
                }
                Err(e) => err(e),
            };
            ctx.emit(Kind::Result, role, r.clone());
            r
        }
        "formalize_result" => {
            let Some(ast) = ctx.hooks.ast() else { return err(no_ast()) };
            match crate::statements::derive(&ast, args) {
                Ok(f) => {
                    ctx.emit(Kind::Tool, role, format!("formalize_result {} · {} functions", f.kind, f.obligations.len()));
                    let r = if f.asks() { format!("recorded: {} functions; the maintainer is asked whether it means what they meant", f.obligations.len()) } else { format!("recorded as {}; the swarm doesn't prove those yet", f.kind) };
                    ctx.hooks.effect(Effect::Formalized(f));
                    r
                }
                Err(e) => err(e),
            }
        }
        "confirm_statement" => {
            ctx.emit(Kind::Tool, role, format!("confirm_statement {shown}"));
            crate::statements::confirm_tool_call(&root.to_string_lossy(), args)
        }
        "record_report" => {
            ctx.emit(Kind::Tool, role, format!("record_report {}", str_arg("title")));
            crate::swarm_ctx::record_report(root, &ctx.job_text(), args).map(|p| format!("recorded in {p}")).unwrap_or_else(err)
        }
        "record_finding" => {
            ctx.emit(Kind::Tool, role, format!("record_finding {} {} · {}", str_arg("id"), str_arg("title"), str_arg("status")));
            crate::swarm_ctx::record_finding_json(root, &ctx.job_text(), args).map(|p| format!("recorded in {p}")).unwrap_or_else(err)
        }
        _ => {
            ctx.emit(Kind::Tool, role, format!("{name} {shown}"));
            let r = match name {
                "functions" => ctx.hooks.ast().map(|a| a.functions()).unwrap_or_else(|| err(no_ast())),
                "function" => {
                    let n = str_arg("name");
                    match ctx.hooks.ast() {
                        Some(a) => a.slice(&n).unwrap_or_else(|| format!("error: no function {n} in scope; `functions` lists them")),
                        None => err(no_ast()),
                    }
                }
                "read_file" => read_file(root, &str_arg("path"), line_arg(args, "start_line"), line_arg(args, "end_line")).unwrap_or_else(err),
                "list_files" => list_files(root, &str_arg("dir")).unwrap_or_else(err),
                "search" => search(root, &str_arg("pattern")).unwrap_or_else(err),
                "find" => find(root, &str_arg("query")).unwrap_or_else(err),
                "run" => lake::run(root, &str_arg("command")).await.unwrap_or_else(err),
                n if crate::analysis::is_tool(n) => crate::analysis::call(&root.to_string_lossy(), role, n, args).await,
                _ => format!("error: No tool called {name}"),
            };
            ctx.emit(Kind::Result, role, short(&r));
            r
        }
    }
}

fn no_ast() -> String {
    "formal-ast hasn't read the folder yet; try again in a moment".into()
}

fn line_arg(args: &Value, k: &str) -> Option<usize> {
    args.get(k).and_then(Value::as_u64).map(|v| v as usize)
}

// ---- files ----

/// B28: where `read_file` reads `path`: `@skills/…` (and bare `skills/<id>/…` for an added skill the folder lacks) in
/// `~/.formalmind/skills`, anything else inside the folder and not a stray copy (B24, B27).
pub fn read_path(root: &Path, path: &str) -> Result<std::path::PathBuf, String> {
    match crate::skills::resolve(path).or_else(|| crate::skills::resolve_bare(root, path)) {
        Some(p) => Ok(p),
        None => fsguard::readable(root, path),
    }
}

/// B28: whole up to 12 000 bytes; otherwise (or with a range) a numbered slice of at most 300 lines, `lines a-b of N`.
pub fn read_file(root: &Path, path: &str, start: Option<usize>, end: Option<usize>) -> Result<String, String> {
    let text = std::fs::read_to_string(read_path(root, path)?).map_err(|e| e.to_string())?;
    if start.is_none() && end.is_none() && text.len() <= WHOLE_FILE {
        return Ok(text);
    }
    let total = text.lines().count();
    let from = start.unwrap_or(1).max(1);
    let to = end.unwrap_or(from + SLICE_LINES - 1).min(total).min(from + SLICE_LINES - 1);
    let body: String = text.lines().enumerate().skip(from - 1).take((to + 1).saturating_sub(from)).map(|(i, l)| format!("{:>5}  {l}\n", i + 1)).collect();
    let note = if start.is_none() && end.is_none() { "File is long; showing the start. Pass start_line/end_line for more.\n" } else { "" };
    Ok(lake::clip(format!("{note}lines {from}-{to} of {total}\n{body}")))
}

/// B24/B25/B27/B29: writes the file, records it on the job at once, and shows the write as a diff in the chat.
fn write_file(ctx: &Ctx<'_>, role: &str, path: &str, content: &str) -> String {
    let abs = match fsguard::writable(ctx.root, path) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let rel = fsguard::show(ctx.root, &abs);
    ctx.emit(Kind::Tool, role, format!("write_file {rel}"));
    let before = std::fs::read_to_string(&abs).unwrap_or_default();
    let written = abs.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| std::fs::write(&abs, content));
    if let Err(e) = written {
        let r = err(e.to_string());
        ctx.emit(Kind::Result, role, r.clone());
        return r;
    }
    if let Some(id) = ctx.job {
        // Recorded now, so a quit mid-turn still knows what was written.
        let _ = queue::Queue::update(&ctx.queue(), |q| q.record_file(id, &rel));
    }
    let r = format!("wrote {path}");
    ctx.emit(Kind::Result, role, with_diff(&r, &rel, &before, content));
    r
}

/// The write's result with a unified diff (3 lines of context, at most 20 000 chars), or alone when nothing changed.
pub fn with_diff(result: &str, rel: &str, before: &str, after: &str) -> String {
    let diff = similar::TextDiff::from_lines(before, after).unified_diff().context_radius(3).header(&format!("a/{rel}"), &format!("b/{rel}")).to_string();
    if diff.is_empty() {
        return result.to_string();
    }
    let shown: String = diff.chars().take(DIFF_LIMIT).collect();
    format!("{result}\n```diff\n{shown}```")
}

/// The executor's `list_files`: the folder's files (dependencies and build output skipped), stray copies left out.
pub fn list_files(root: &Path, dir: &str) -> Result<String, String> {
    let all = crate::executor::list_files(root, dir)?;
    Ok(all.lines().filter(|f| fsguard::visible(root, f)).collect::<Vec<_>>().join("\n"))
}

/// Drops hits (`path:line: text` or bare paths) in stray copies (B27).
fn visible_lines(root: &Path, hits: &str, none: &str) -> String {
    let kept: Vec<&str> = hits.lines().filter(|l| fsguard::visible(root, l.split(':').next().unwrap_or(l))).collect();
    if kept.is_empty() { none.to_string() } else { kept.join("\n") }
}

/// B27: regex over the Lake project's `.lean` files, `path:line: text`, at most 200 hits, strays left out.
pub fn search(root: &Path, pattern: &str) -> Result<String, String> {
    let dir = lake::lake_dir(root).map(|d| fsguard::show(root, &d)).unwrap_or_default();
    let hits = crate::executor::search_in(root, pattern, &dir, &[".lean"])?;
    Ok(visible_lines(root, &hits, "no matches"))
}

/// B27: fuzzy file paths, best first, at most 30, strays left out.
pub fn find(root: &Path, query: &str) -> Result<String, String> {
    let hits = crate::file_search::find(root, query, FIND_LIMIT)?;
    Ok(visible_lines(root, &hits, "no files match"))
}

// ---- report_bug ----

/// B30: where the finding shows in `.formal/findings.sarif`.
pub fn sarif_level(severity: &str) -> &'static str {
    match severity {
        "critical" | "high" => "error",
        "medium" => "warning",
        _ => "note",
    }
}

/// B30: the PoC as given, if it is a Foundry test under `test/` that exists in the folder.
pub fn poc_path(root: &Path, poc: &str) -> Result<String, String> {
    let poc = poc.trim().trim_start_matches("./").to_string();
    if !poc.starts_with("test/") || !poc.ends_with(".sol") {
        return Err("poc must be a Foundry test file under test/ (e.g. test/formal/X.t.sol); write it first".into());
    }
    if !fsguard::inside(root, &poc)?.exists() {
        return Err(format!("{poc} doesn't exist; write the PoC test first"));
    }
    Ok(poc)
}

/// B30: runs the PoC, refuses one that doesn't compile, files the finding (report index and report, audit file) and
/// its line in `findings.sarif`, and emits `bug`. Returns (FM id, report file).
async fn report_bug(ctx: &Ctx<'_>, role: &str, input: &Value) -> Result<(String, String), String> {
    let root = ctx.root;
    let poc = poc_path(root, input["poc"].as_str().unwrap_or(""))?;
    ctx.emit(Kind::Status, role, format!("running the PoC {poc}"));
    let forge = lake::run(root, &format!("forge test --match-path {poc}")).await.unwrap_or_else(|e| e);
    if forge.starts_with("exit ") && !forge.starts_with("exit 0") && forge.contains("Compiler run failed") {
        return Err(format!("the PoC doesn't compile:\n{}", lake::clip(forge)));
    }
    let tail: String = {
        let l: Vec<&str> = forge.lines().collect();
        l[l.len().saturating_sub(40)..].join("\n")
    };
    let (id, file) = crate::swarm_ctx::file_finding(root, input, &poc, &tail)?;
    let title = input["title"].as_str().unwrap_or("bug");
    if let Some((src, line)) = crate::analysis::location(input["location"].as_str().unwrap_or("")) {
        let severity = input["severity"].as_str().unwrap_or("medium");
        let props = json!({ "id": id, "severity": severity, "poc": poc, "by": role, "scenario": input["scenario"], "impact": input["impact"], "recommendation": input["recommendation"] });
        if let Err(e) = crate::analysis::sarif_add(root, "formal-mind/finding", sarif_level(severity), &src, line, format!("{id} ({severity}): {title}. PoC: {poc}"), props) {
            eprintln!("findings.sarif: {e}");
        }
    }
    ctx.emit(Kind::Bug, role, format!("{id} {title} — {poc}"));
    Ok((id, file))
}

#[cfg(test)]
mod tests {
    use super::super::fsguard::tests::{nested_with_stray, TempDir};
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Rec {
        events: Mutex<Vec<(Kind, String)>>,
        effects: Mutex<Vec<String>>,
        working: AtomicBool,
    }
    impl Hooks for Rec {
        fn event(&self, kind: Kind, _role: &str, _item: &str, text: String) {
            self.events.lock().unwrap().push((kind, text));
        }
        fn effect(&self, e: Effect) {
            let s = match e {
                Effect::Verdict { approve, notes, property } => format!("verdict {approve} {notes} {}", property.is_some()),
                Effect::Property(v) => format!("property {}", v["statement"].as_str().unwrap_or("")),
                Effect::Bug(b) => format!("bug {b}"),
                Effect::Formalized(f) => format!("formalized {}", f.kind),
            };
            self.effects.lock().unwrap().push(s);
        }
        fn work(&self) -> bool {
            self.working.swap(true, Ordering::SeqCst)
        }
        fn ast(&self) -> Option<Arc<crate::swarm_ctx::Context>> {
            None
        }
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    fn call_on(root: &Path, job: Option<u64>, hooks: &Rec, role: &str, name: &str, args: Value) -> String {
        let ctx = Ctx { root, session: queue::DEFAULT_SESSION, job, item: "1", hooks };
        run(call(&ctx, role, name, &args))
    }

    /// A queue with one job, returning its id.
    fn with_job(root: &Path, kind: queue::Kind, text: &str) -> u64 {
        let mut n = queue::NewJob::new(kind);
        n.text = text.into();
        queue::Queue::update(&queue::queue_path(root, queue::DEFAULT_SESSION), |q| q.enqueue(n)).unwrap()
    }

    const ROLES: [&str; 5] = ["prover", "reviewer", "assistant", "auditor", "planner"];

    fn names_of(v: &Value) -> Vec<String> {
        v.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
    }

    /// Every key and string in a schema, as it would be spelled in Rust source (`"` escaped).
    fn strings(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => out.push(s.replace('\\', "\\\\").replace('"', "\\\"")),
            Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
            Value::Object(o) => o.iter().for_each(|(k, x)| {
                out.push(k.clone());
                strings(x, out)
            }),
            _ => {}
        }
    }

    // B23: each role's tools, in order. `swarm.rs::tools` is private to swarm.rs, so the snapshot compares against
    // what is reachable: report_bug_tool exactly, analysis/statements by construction, and every name, key and
    // description of the copied schemas against the text of swarm.rs's `fn tools`.
    #[test]
    fn b23_schema_snapshot_per_role() {
        let base = ["functions", "function", "read_file", "search", "find", "run"];
        let analysis = ["tag", "run_in_background", "background_results", "add_statement"];
        let expect = |extra: &[&str]| base.iter().chain(extra).map(|s| s.to_string()).collect::<Vec<_>>();
        let writer: Vec<&str> = ["report_bug", "write_file"].iter().chain(&analysis).copied().collect();
        assert_eq!(names_of(&schemas("prover")), expect(&[writer.as_slice(), &["record_property"]].concat()));
        assert_eq!(names_of(&schemas("planner")), expect(&writer));
        assert_eq!(names_of(&schemas("assistant")), expect(&[writer.as_slice(), &["formalize_result", "confirm_statement", "start_work", "reopen"]].concat()));
        assert_eq!(names_of(&schemas("reviewer")), expect(&[analysis.as_slice(), &["verdict"]].concat()));
        assert_eq!(names_of(&schemas("auditor")), expect(&["record_report", "record_finding"]));

        assert_eq!(report_bug_schema(), crate::swarm::report_bug_tool());
        let src = include_str!("../swarm.rs");
        let start = src.find("fn reopen_tool()").unwrap();
        let end = src[start..].find("/// What a turn ended with").unwrap() + start;
        let old = &src[start..end];
        for role in ROLES {
            for t in schemas(role).as_array().unwrap() {
                let name = t["name"].as_str().unwrap();
                if crate::analysis::is_tool(name) || ["formalize_result", "confirm_statement", "report_bug"].contains(&name) {
                    continue;
                }
                let mut all = vec![];
                strings(t, &mut all);
                for s in all {
                    assert!(old.contains(&format!("\"{s}\"")), "{role}.{name}: {s:?} isn't in swarm.rs::tools");
                }
            }
        }
        // Stable across calls (the bridge advertises them per turn).
        for role in ROLES {
            assert_eq!(serde_json::to_string(&schemas(role)).unwrap(), serde_json::to_string(&schemas(role)).unwrap());
        }
    }

    #[test]
    fn b23_tools_outside_the_role_are_refused() {
        let t = TempDir::new("b23");
        let h = Rec::default();
        let r = call_on(&t.0, None, &h, "reviewer", "write_file", json!({ "path": "a.lean", "content": "x" }));
        assert!(r.starts_with("error: No tool called write_file"), "{r}");
        assert!(!t.0.join("a.lean").exists());
        assert!(call_on(&t.0, None, &h, "auditor", "tag", json!({})).starts_with("error: No tool called tag"));
        assert!(call_on(&t.0, None, &h, "prover", "verdict", json!({ "decision": "approve" })).starts_with("error:"));
        assert!(h.effects.lock().unwrap().is_empty());
    }

    #[test]
    fn b24_paths_outside_the_folder_are_refused() {
        let t = TempDir::new("b24t");
        let h = Rec::default();
        assert!(call_on(&t.0, None, &h, "prover", "read_file", json!({ "path": "/etc/hosts" })).contains("outside the folder"));
        assert!(call_on(&t.0, None, &h, "prover", "write_file", json!({ "path": "../x.lean", "content": "" })).contains("outside the folder"));
    }

    #[test]
    fn r5_b25_formal_is_not_writable_by_any_agent() {
        let t = TempDir::new("r5");
        t.file(".formal/plan.md", "# Plan\n\n- [ ] `A.f` — A\n");
        let h = Rec::default();
        for role in ["assistant", "prover", "planner"] {
            let r = call_on(&t.0, None, &h, role, "write_file", json!({ "path": ".formal/plan.md", "content": "- [x] `A.f`\n" }));
            assert_eq!(r, fsguard::FORMAL_WRITE_ERROR);
            let r = call_on(&t.0, None, &h, role, "write_file", json!({ "path": "./.formal/new.md", "content": "x" }));
            assert_eq!(r, fsguard::FORMAL_WRITE_ERROR);
        }
        assert_eq!(std::fs::read_to_string(t.0.join(".formal/plan.md")).unwrap(), "# Plan\n\n- [ ] `A.f` — A\n");
        // Reading it is fine.
        assert!(call_on(&t.0, None, &h, "assistant", "read_file", json!({ "path": ".formal/plan.md" })).contains("`A.f`"));
    }

    #[test]
    fn b27_stray_copies_cant_be_read_written_or_checked() {
        let t = nested_with_stray();
        let h = Rec::default();
        let r = call_on(&t.0, None, &h, "prover", "read_file", json!({ "path": "Generated/AsyncSwap.lean" }));
        assert!(r.contains("validation/lean/Generated/AsyncSwap.lean"), "{r}");
        assert!(r.starts_with("error: "));
        let r = call_on(&t.0, None, &h, "prover", "write_file", json!({ "path": "Generated/AsyncSwap.lean", "content": "def x := 2\n" }));
        assert!(r.contains("Lake never builds it"), "{r}");
        assert_eq!(std::fs::read_to_string(t.0.join("Generated/AsyncSwap.lean")).unwrap(), "def x := 0\n");
        let r = call_on(&t.0, None, &h, "prover", "run", json!({ "command": "lake env lean Generated/AsyncSwap.lean" }));
        assert!(r.contains("Lake never builds it"), "{r}");
        // The right file reads.
        assert_eq!(call_on(&t.0, None, &h, "prover", "read_file", json!({ "path": "validation/lean/Generated/AsyncSwap.lean" })), "def x := 1\n");
    }

    #[test]
    fn b27_search_and_find_drop_stray_hits() {
        let t = nested_with_stray();
        t.file("Generated/AsyncSwap.lean", "def x := 0\n").file("validation/lean/Generated/AsyncSwap.lean", "def x := 1\n");
        let s = search(&t.0, r"def x").unwrap();
        assert!(s.contains("validation/lean/Generated/AsyncSwap.lean:1:"), "{s}");
        assert!(!s.lines().any(|l| l.starts_with("Generated/")), "{s}");
        assert_eq!(search(&t.0, "nothing_here_at_all").unwrap(), "no matches");
        assert!(search(&t.0, "(").unwrap_err().starts_with("bad pattern"));
        if let Ok(f) = find(&t.0, "AsyncSwap.lean") {
            assert!(!f.lines().any(|l| l.starts_with("Generated/")), "{f}");
        }
        assert!(!list_files(&t.0, "").unwrap().lines().any(|l| l.starts_with("Generated/")));
    }

    #[test]
    fn b26_run_refuses_commands_off_the_allowlist() {
        let t = TempDir::new("b26t");
        let h = Rec::default();
        assert_eq!(call_on(&t.0, None, &h, "prover", "run", json!({ "command": "rm -rf /" })), format!("error: {}", lake::ALLOWLIST_ERROR));
    }

    #[test]
    fn b28_read_file_whole_or_in_numbered_slices() {
        let t = TempDir::new("b28");
        t.file("small.lean", "a\nb\n");
        let long: String = (1..=1000).map(|i| format!("line number {i} with some padding text\n")).collect();
        t.file("long.lean", &long);
        assert_eq!(read_file(&t.0, "small.lean", None, None).unwrap(), "a\nb\n");
        let r = read_file(&t.0, "long.lean", None, None).unwrap();
        assert!(r.starts_with("File is long; showing the start. Pass start_line/end_line for more.\nlines 1-300 of 1000\n"), "{}", &r[..120]);
        assert!(r.contains("  300  line number 300 ") && !r.contains("line number 301 "));
        let r = read_file(&t.0, "long.lean", Some(10), Some(12)).unwrap();
        assert_eq!(r, "lines 10-12 of 1000\n   10  line number 10 with some padding text\n   11  line number 11 with some padding text\n   12  line number 12 with some padding text\n");
        // A range on a small file is a slice too; ranges are capped at 300 lines.
        assert!(read_file(&t.0, "small.lean", Some(2), None).unwrap().starts_with("lines 2-2 of 2\n"));
        assert!(read_file(&t.0, "long.lean", Some(1), Some(900)).unwrap().starts_with("lines 1-300 of 1000\n"));
        // Through the tool, the range arguments are read.
        let h = Rec::default();
        assert!(call_on(&t.0, None, &h, "reviewer", "read_file", json!({ "path": "long.lean", "start_line": 5, "end_line": 5 })).starts_with("lines 5-5 of 1000\n"));
    }

    #[test]
    fn b28_skills_paths_resolve_outside_the_folder() {
        let t = TempDir::new("b28s");
        t.file("@skills/x/SKILL.md", "folder copy");
        let p = read_path(&t.0, "@skills/x/SKILL.md").unwrap();
        assert!(!p.starts_with(&t.0) && p.ends_with("skills/x/SKILL.md"), "{}", p.display());
        assert!(read_path(&t.0, "@skills/../secret").is_err());
    }

    #[test]
    fn b29_writes_are_recorded_on_the_job_at_once_with_a_diff() {
        let t = TempDir::new("b29");
        t.file("formal/Proofs/A.lean", "theorem a : True := trivial\n");
        let job = with_job(&t.0, queue::Kind::Prove, "item");
        let h = Rec::default();
        let r = call_on(&t.0, Some(job), &h, "prover", "write_file", json!({ "path": "./formal/Proofs/A.lean", "content": "theorem a : True := by trivial\n" }));
        assert_eq!(r, "wrote ./formal/Proofs/A.lean");
        call_on(&t.0, Some(job), &h, "prover", "write_file", json!({ "path": "formal/Proofs/A.lean", "content": "theorem a : True := by trivial\n" }));
        call_on(&t.0, Some(job), &h, "prover", "write_file", json!({ "path": t.0.join("test/P.t.sol").to_str().unwrap(), "content": "contract P {}\n" }));
        let q = queue::Queue::load(&queue::queue_path(&t.0, queue::DEFAULT_SESSION));
        assert_eq!(q.job(job).unwrap().files, vec!["formal/Proofs/A.lean".to_string(), "test/P.t.sol".to_string()]);
        let ev = h.events.lock().unwrap();
        let diff = &ev.iter().find(|(k, s)| *k == Kind::Result && s.contains("```diff")).unwrap().1;
        assert!(diff.contains("--- a/formal/Proofs/A.lean\n+++ b/formal/Proofs/A.lean\n") && diff.contains("-theorem a : True := trivial\n+theorem a : True := by trivial\n"), "{diff}");
        // The rewrite with the same text has no diff: its result is the bare answer.
        assert!(ev.iter().any(|(k, s)| *k == Kind::Result && s == "wrote formal/Proofs/A.lean"));
        assert!(with_diff("r", "x", "", &"y\n".repeat(30_000)).chars().count() < DIFF_LIMIT + 40);
    }

    #[test]
    fn b30_report_bug_needs_an_existing_poc_under_test() {
        let t = TempDir::new("b30");
        let h = Rec::default();
        let bug = |poc: &str| json!({ "title": "t", "severity": "high", "location": "src/A.sol:1", "scenario": "s", "poc": poc });
        let r = call_on(&t.0, None, &h, "prover", "report_bug", bug("src/A.sol"));
        assert_eq!(r, "error: poc must be a Foundry test file under test/ (e.g. test/formal/X.t.sol); write it first");
        let r = call_on(&t.0, None, &h, "prover", "report_bug", bug("test/X.t.sol"));
        assert_eq!(r, "error: test/X.t.sol doesn't exist; write the PoC test first");
        assert!(call_on(&t.0, None, &h, "reviewer", "report_bug", bug("test/X.t.sol")).starts_with("error: No tool called report_bug"));
        assert!(h.effects.lock().unwrap().is_empty());
        t.file("test/X.t.sol", "");
        assert_eq!(poc_path(&t.0, "./test/X.t.sol").unwrap(), "test/X.t.sol");
        assert_eq!((sarif_level("critical"), sarif_level("high"), sarif_level("medium"), sarif_level("low")), ("error", "error", "warning", "note"));
    }

    #[test]
    fn r8_verdict_is_stored_on_the_job_and_handed_to_the_loop() {
        let t = TempDir::new("r8");
        let job = with_job(&t.0, queue::Kind::Review, "item");
        let h = Rec::default();
        let input = json!({ "decision": "approve", "notes": "ok", "statement": "holds" });
        assert_eq!(call_on(&t.0, Some(job), &h, "reviewer", "verdict", input.clone()), "recorded");
        let q = queue::Queue::load(&queue::queue_path(&t.0, queue::DEFAULT_SESSION));
        assert_eq!(q.job(job).unwrap().verdict, Some(input));
        call_on(&t.0, Some(job), &h, "reviewer", "verdict", json!({ "decision": "changes", "notes": "no" }));
        assert_eq!(*h.effects.lock().unwrap(), vec!["verdict true ok true".to_string(), "verdict false no false".to_string()]);
    }

    #[test]
    fn b18_record_property_needs_a_statement() {
        let t = TempDir::new("prop");
        let h = Rec::default();
        assert!(call_on(&t.0, None, &h, "prover", "record_property", json!({ "statement": " ", "theorems": [] })).starts_with("error: statement is required"));
        assert_eq!(call_on(&t.0, None, &h, "prover", "record_property", json!({ "statement": "S", "theorems": ["t"] })), "recorded; the reviewer checks it against the Solidity and your proof");
        assert_eq!(*h.effects.lock().unwrap(), vec!["property S".to_string()]);
    }

    #[test]
    fn b19_reopen_and_start_work() {
        let t = TempDir::new("b19");
        t.file(".formal/plan.md", "# Plan\n\n- [x] `A.f` — A\n- [!] `A.g` — A\n- [ ] `A.h` — A\n");
        let h = Rec::default();
        let r = call_on(&t.0, None, &h, "assistant", "reopen", json!({ "defs": ["A.f", "`A.g`", "B.z"] }));
        assert_eq!(r, "reopened A.f, A.g; after your answer, the swarm proves them; not in the plan: B.z");
        assert_eq!(std::fs::read_to_string(t.0.join(".formal/plan.md")).unwrap(), "# Plan\n\n- [ ] `A.f` — A\n- [ ] `A.g` — A\n- [ ] `A.h` — A\n");
        assert!(h.working.load(Ordering::SeqCst));
        assert_eq!(call_on(&t.0, None, &h, "assistant", "start_work", json!({})), "the swarm is already working on the plan");

        let h = Rec::default();
        assert_eq!(call_on(&t.0, None, &h, "assistant", "reopen", json!({ "defs": ["B.z"] })), "nothing reopened; not in the plan: B.z");
        assert!(!h.working.load(Ordering::SeqCst));
        assert_eq!(call_on(&t.0, None, &h, "assistant", "start_work", json!({})), "after your answer, the swarm works on the plan (the prover first), as the maintainer asked");
        assert!(call_on(&t.0, None, &h, "prover", "reopen", json!({ "defs": ["A.f"] })).starts_with("error: No tool called reopen"));
    }

    #[test]
    fn formal_ast_tools_wait_for_the_reading() {
        let t = TempDir::new("ast");
        let h = Rec::default();
        assert!(call_on(&t.0, None, &h, "prover", "functions", json!({})).starts_with("error: formal-ast hasn't read"));
        assert!(call_on(&t.0, None, &h, "assistant", "formalize_result", json!({ "kind": "function", "means": "m" })).starts_with("error: formal-ast hasn't read"));
    }
}
