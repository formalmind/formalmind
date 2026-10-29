//! The loop (B14–B22): one job at a time, and what each job's turn means for the queue, the plan and the reports.

use super::world::{expected_proof, Coverage};
use super::{Engine, Session, ELSEWHERE, MAX_ATTEMPTS, NO_SCOPE, PAUSED, QUEUED_DONE};
use crate::swarm2::events::Kind;
use crate::swarm2::executor::{self, BoxFuture, Ended, ToolHost, Turn, TurnError, TurnEvents};
use crate::swarm2::plan::{self, Mark};
use crate::swarm2::queue::{Job, Kind as JobKind, NewJob, Queue, State};
use crate::swarm2::tools::{self, Effect, Hooks};
use crate::swarm2::{audit, fsguard, lake, ledger};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

/// What a turn decided, from its tools (and, for a verdict, the queue: R8).
#[derive(Default)]
struct Decided {
    verdict: Option<(bool, String)>,
    /// The prover's `record_property`, or an approving reviewer's verdict input.
    property: Option<Value>,
    bug: Option<String>,
    formalized: Option<crate::statements::Formalized>,
}

/// A turn's outcome as the loop applies it.
#[derive(Default)]
struct Out {
    summary: String,
    stopped: bool,
    d: Decided,
}

/// The loop's side of a turn: events stamped with the session, role and item; spend; the tools' effects.
struct Side {
    engine: Arc<Engine>,
    s: Arc<Session>,
    role: String,
    item: String,
    job: u64,
    decided: Mutex<Decided>,
    health: Mutex<Option<crate::health::Turn>>,
}

impl TurnEvents for Side {
    fn event(&self, kind: Kind, text: String) {
        if kind == Kind::Say {
            if let Some(h) = self.health.lock().unwrap().as_mut() {
                h.said(&text);
            }
        }
        self.engine.emit(&self.s, kind, &self.role, &self.item, text);
    }

    fn spend(&self, dollars: f64) {
        let total = {
            let mut spent = self.s.spent.lock().unwrap();
            *spent += dollars;
            *spent
        };
        let _ = Queue::update(&self.s.queue, |q| q.spent = total);
    }
}

impl Hooks for Side {
    fn event(&self, kind: Kind, role: &str, item: &str, text: String) {
        self.engine.emit(&self.s, kind, role, item, text);
    }

    fn effect(&self, effect: Effect) {
        let mut d = self.decided.lock().unwrap();
        match effect {
            Effect::Verdict { approve, notes, property } => {
                d.verdict = Some((approve, notes));
                if property.is_some() {
                    d.property = property;
                }
            }
            Effect::Property(p) => d.property = Some(p),
            Effect::Bug(b) => d.bug = Some(b),
            Effect::Formalized(f) => d.formalized = Some(f),
        }
    }

    fn work(&self) -> bool {
        self.s.work.swap(true, Ordering::SeqCst)
    }

    fn ast(&self) -> Option<Arc<crate::swarm_ctx::Context>> {
        self.s.ast.lock().unwrap().clone()
    }
}

/// The turn's tools: the world's handlers on the folder, for this job.
struct Host(Arc<Side>);

impl ToolHost for Host {
    fn call<'a>(&'a self, name: &'a str, input: &'a Value) -> BoxFuture<'a, String> {
        Box::pin(async move {
            let side = &*self.0;
            let ctx = tools::Ctx { root: &side.s.root, session: &side.s.run, job: Some(side.job), item: &side.item, hooks: side };
            let answer = side.engine.world.tool(&ctx, &side.role, name, input).await;
            if let Some(h) = side.health.lock().unwrap().as_mut() {
                h.tool(name, input, &answer);
            }
            answer
        })
    }
}

/// B9's paused outcome after a turn error (B41: the job stays running).
fn paused_by(e: &TurnError) -> String {
    format!("paused: {e}")
}

impl Engine {
    /// formal-ast's reading, cached on the session; `fresh` reads again (theorems change as provers write).
    async fn ast(&self, s: &Session, fresh: bool) -> Option<Arc<crate::swarm_ctx::Context>> {
        if !fresh {
            if let Some(c) = s.ast.lock().unwrap().clone() {
                return Some(c);
            }
        }
        let c = self.world.ast(&s.root).await;
        if c.is_some() {
            *s.ast.lock().unwrap() = c.clone();
        }
        c
    }

    /// One agent turn on the job, with B40's retries and the health line (B43).
    async fn agent(self: &Arc<Self>, s: &Arc<Session>, job: u64, role: &str, item: &str, task: Value) -> Result<Out, TurnError> {
        if s.ast.lock().unwrap().is_none() {
            self.ast(s, false).await;
        }
        let side = Arc::new(Side {
            engine: self.clone(),
            s: s.clone(),
            role: role.into(),
            item: item.into(),
            job,
            decided: Mutex::new(Decided::default()),
            health: Mutex::new(self.world.health(&s.folder, &s.run, job, role, item, &s.req)),
        });
        let turn = Turn {
            folder: s.root.clone(),
            run: s.run.clone(),
            job,
            role: role.into(),
            item: item.into(),
            system: self.world.system(role, &s.folder, s.req.goal.as_deref().unwrap_or("")),
            tools: self.world.tools(role),
            task,
            events: side.clone(),
            compact_now: s.compact_now.clone(),
        };
        let host = Host(side.clone());
        let result = executor::turn_retrying(&*s.agent, &turn, &host, &s.stop, self.backoff).await;
        if let Some(h) = side.health.lock().unwrap().take() {
            let (ended, error) = match &result {
                Ok(o) if o.ended == Ended::Stopped || s.stopped() => ("paused", None),
                Ok(_) => ("done", None),
                Err(e) => ("error", Some(e.to_string())),
            };
            for a in h.finish(ended, error.as_deref()) {
                self.emit(s, Kind::Error, role, item, format!("health: the {role}'s turn on item {item}: {a}"));
            }
        }
        let o = result?;
        let d = std::mem::take(&mut *side.decided.lock().unwrap());
        Ok(Out { summary: o.summary, stopped: o.ended == Ended::Stopped || s.stopped(), d })
    }

    /// B15/B33: the planner's turn without a model. Returns how many items were added or reopened.
    async fn sync_plan(&self, s: &Session) -> usize {
        let root = &s.root;
        self.emit(s, Kind::Status, "planner", "plan", "planner is working");
        self.emit(s, Kind::Status, "planner", "plan", "reading the contracts' AST (formal-ast)");
        let text = std::fs::read_to_string(plan::path(root)).unwrap_or_default();
        let scan = self.world.scan(root, &text).await;
        if scan.ast.is_some() {
            *s.ast.lock().unwrap() = scan.ast.clone();
        }
        if let Err(e) = plan::append(root, &scan.missing) {
            self.emit(s, Kind::Error, "planner", "plan", format!(".formal/plan.md: {e}"));
        }
        self.emit(s, Kind::Tool, "planner", "plan", scan.in_scope.clone());
        for p in &scan.problems {
            self.emit(s, Kind::Result, "planner", "plan", format!("couldn't read {p}"));
        }
        for r in &scan.regenerated {
            self.emit(s, Kind::Result, "planner", "plan", r.clone());
        }
        for d in fsguard::strays(root) {
            self.emit(s, Kind::Result, "planner", "plan", format!("{d}: a copy outside the Lake sources that Lake never builds; the agents can't read or check it, and it can go"));
        }
        let reopened = match self.world.ledger(root).await.and_then(|l| ledger::reopen_lapsed(root, &l).map_err(|e| e.to_string())) {
            Ok(gone) => {
                for l in &gone {
                    self.emit(s, Kind::Result, "planner", &l.index.to_string(), l.message());
                }
                gone.len()
            }
            Err(e) => {
                self.emit(s, Kind::Result, "planner", "plan", format!("couldn't check the proofs against the current code ({e}); checked items stay as they are"));
                0
            }
        };
        let added = scan.missing.len();
        self.emit(
            s,
            Kind::Plan,
            "planner",
            "plan",
            match (added, reopened) {
                (0, 0) => "the plan has every function in scope".to_string(),
                (m, 0) => format!("{m} items from the AST"),
                (0, r) => format!("{r} proved items reopened: their code changed or Lean no longer checks them"),
                (m, r) => format!("{m} items from the AST; {r} proved items reopened"),
            },
        );
        added + reopened
    }

    /// B17: the swarm's own check of a prover's work. Ok(the theorems that prove it).
    async fn check_proof(&self, s: &Session, id: &str, text: &str, files: &[String]) -> Result<Vec<String>, String> {
        let root = &s.root;
        let lean: Vec<&str> = files.iter().map(String::as_str).filter(|f| f.ends_with(".lean")).collect();
        if lean.is_empty() {
            return Err("No Lean file was written for this item; write the proof with write_file.".into());
        }
        for f in &lean {
            let body = fsguard::inside(root, f).and_then(|p| std::fs::read_to_string(p).map_err(|e| e.to_string())).unwrap_or_default();
            if let Some(w) = crate::swarm_ctx::cheats(&body) {
                return Err(format!("{f} uses `{w}`; proofs here can't."));
            }
        }
        if lake::lake_dir(root).is_none() {
            return Ok(vec![]);
        }
        // R12: only the modules this item wrote.
        let command = lake::build_command(root, &lean);
        self.emit(s, Kind::Status, "prover", id, format!("checking: {command}"));
        let build = self.world.run(root, &command).await;
        self.emit(s, Kind::Result, "prover", id, build.lines().filter(|l| l.starts_with("exit") || l.contains("error")).take(12).collect::<Vec<_>>().join("\n"));
        if !build.starts_with("exit 0") {
            let errors: Vec<&str> = build.lines().filter(|l| l.contains("error")).take(40).collect();
            return Err(format!("`lake build` failed:\n{}", if errors.is_empty() { lake::clip(build.clone()) } else { errors.join("\n") }));
        }
        let ast = self.ast(s, true).await;
        match self.world.coverage(ast.as_deref(), text) {
            Coverage::NoTarget => Ok(vec![]),
            Coverage::Proved { lean, theorems } => {
                self.emit(s, Kind::Status, "prover", id, format!("checking: the Proofs page's coverage of {lean}"));
                self.emit(s, Kind::Result, "prover", id, format!("{lean} is proved on the Proofs page: {}", theorems.join("; ")));
                Ok(theorems)
            }
            Coverage::NotProved { lean, name } => {
                self.emit(s, Kind::Status, "prover", id, format!("checking: the Proofs page's coverage of {lean}"));
                Err(format!("`lake build` passes, but no theorem without sorry names `{lean}`, so the Proofs page still shows {name} as not proved. State the theorem about `{lean}` itself, spelled fully qualified."))
            }
        }
    }

    /// Picks the next job (B14) and marks it running. None: what's left of the plan is claimed elsewhere.
    fn next_job(&self, s: &Session) -> Option<(Job, bool)> {
        let root = &s.root;
        let taken = |item: usize| self.claims.taken_by_other(&s.folder, item, &s.key);
        let plan_done = plan::read(root).iter().all(|i| !matches!(i.mark, Mark::Open | Mark::Statement));
        let formalize = crate::statements::awaiting_formalize(root).map(|st| st.id);
        let obligation = crate::statements::next_obligation(root, plan_done);
        Queue::update(&s.queue, |q| {
            let id = match q.pick(taken) {
                Some(j) => j.id,
                None => {
                    if let Some(sid) = formalize {
                        q.enqueue(NewJob { text: sid, attempt: 1, ..NewJob::new(JobKind::Formalize) })
                    } else if let Some((st, n)) = obligation {
                        let tries = q.jobs.iter().filter(|j| j.kind == JobKind::Prove && j.statement == st.id && j.item == n).count();
                        let _ = crate::statements::set_obligation(root, &st.id, n, '~');
                        q.enqueue(NewJob { item: n, text: st.obligations[n - 1].text.clone(), attempt: tries + 1, statement: st.id.clone(), ..NewJob::new(JobKind::Prove) })
                    } else {
                        let items = plan::read(root);
                        match plan::first_open(&items, taken) {
                            Some(item) => {
                                let attempt = q.next_attempt(item.index);
                                q.enqueue(NewJob { item: item.index, text: item.text.clone(), attempt, ..NewJob::new(JobKind::Prove) })
                            }
                            None if items.iter().any(|i| i.mark == Mark::Open) => return None,
                            None => q.enqueue(NewJob { attempt: 1, ..NewJob::new(JobKind::Plan) }),
                        }
                    }
                }
            };
            let j = q.job_mut(id)?;
            let resumed = j.state == State::Running;
            j.state = State::Running;
            Some((j.clone(), resumed))
        })
        .ok()
        .flatten()
    }

    /// The loop for one run: returns its outcome (B9). Works until the budget, Stop, or nothing is left.
    pub(super) async fn run_loop(self: &Arc<Self>, s: &Arc<Session>) -> String {
        let root = s.root.clone();
        let _ = std::fs::create_dir_all(root.join(".formal"));
        let mut planned = false;
        loop {
            if s.stopped() {
                return PAUSED.into();
            }
            let (spent, budget) = (s.spent(), *s.budget.lock().unwrap());
            if spent >= budget && s.req.metered() {
                let cap = if s.req.budget_usd < budget { s.req.budget_usd } else { budget };
                return format!("budget reached (${spent:.2} spent of ${cap:.2}); raise it and resume to carry on");
            }
            let answers = Queue::load(&s.queue).jobs.iter().any(|j| j.kind == JobKind::Answer && j.state != State::Done);
            if !planned && !answers {
                self.sync_plan(s).await;
                planned = true;
            }
            // B12: a run for queued work also takes the statements waiting for the swarm, then stops.
            let plan_done = plan::read(&root).iter().all(|i| !matches!(i.mark, Mark::Open | Mark::Statement));
            let statement_work = crate::statements::awaiting_formalize(&root).is_some() || crate::statements::next_obligation(&root, plan_done).is_some();
            if !s.work.load(Ordering::SeqCst) && !statement_work && Queue::load(&s.queue).open().next().is_none() {
                return QUEUED_DONE.into();
            }
            let Some((job, resumed)) = self.next_job(s) else {
                return ELSEWHERE.into();
            };
            if job.claims_item() {
                self.claims.claim(&s.folder, job.item, &s.key);
            }
            match self.job(s, &job, resumed).await {
                Ok(()) => {}
                Err(outcome) => return outcome,
            }
        }
    }

    /// Runs one job and applies its outcome. Err(outcome) ends the run.
    async fn job(self: &Arc<Self>, s: &Arc<Session>, job: &Job, resumed: bool) -> Result<(), String> {
        let root = s.root.clone();
        let root = root.as_path();
        let id = if job.statement.is_empty() { job.item.to_string() } else { format!("{}.{}", job.statement, job.item) };
        let statement = (!job.statement.is_empty())
            .then(|| crate::statements::load(root).ok()?.into_iter().find(|st| st.id == job.statement && job.item >= 1 && job.item <= st.obligations.len()))
            .flatten();
        let lib = lake::lean_src(root).map(|d| d.strip_prefix(root).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()).filter(|d| !d.is_empty()).unwrap_or_else(|| ".".into());
        let resume_note = if resumed {
            format!(
                "\n\nThis job was interrupted (the app quit) and is being resumed. {}Continue from where it stopped; don't redo work that is already there.",
                if job.files.is_empty() { String::new() } else { format!("Files already written for it: {}. ", job.files.join(", ")) }
            )
        } else {
            String::new()
        };
        let orphan = matches!(job.kind, JobKind::Prove | JobKind::Review) && !job.statement.is_empty() && statement.is_none();

        let outcome: Result<Out, TurnError> = match &job.kind {
            _ if orphan => Ok(Out { summary: format!("{id} isn't in .formal/statements.md any more"), ..Out::default() }),
            JobKind::Answer => self.agent(s, job.id, "assistant", "you", json!(format!("The maintainer says:\n\n{}{}{resume_note}", job.text, crate::statements::waiting_note(root)))).await,
            JobKind::Formalize => match crate::statements::load(root).ok().and_then(|all| all.into_iter().find(|st| st.id == job.text)) {
                Some(st) => {
                    self.emit(s, Kind::Status, "assistant", &job.text, format!("formalizing {}", st.id));
                    self.agent(s, job.id, "assistant", &job.text, json!(format!("{}{resume_note}", crate::statements::formalize_task(&st)))).await
                }
                None => Ok(Out { summary: format!("{} isn't in .formal/statements.md any more", job.text), ..Out::default() }),
            },
            JobKind::Triage => {
                let report = job.text.clone();
                self.emit(s, Kind::Status, "auditor", "report", format!("reading {report}"));
                let task = format!("The audit report {report} is attached. Record it and every finding it lists in the standard format, each with its status in the current code.{resume_note}");
                let content = match fsguard::inside(root, &report).and_then(|p| std::fs::read(&p).map_err(|e| e.to_string())) {
                    Ok(bytes) if report.to_ascii_lowercase().ends_with(".pdf") => json!([
                        { "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": crate::swarm::base64(&bytes) }, "title": report },
                        { "type": "text", "text": task }
                    ]),
                    Ok(bytes) => json!(format!("The audit report {report}:\n\n{}\n\n{task}", String::from_utf8_lossy(&bytes))),
                    Err(e) => json!(format!("The report {report} can't be read ({e}). Say so and stop.")),
                };
                self.agent(s, job.id, "auditor", "report", content).await
            }
            JobKind::Plan => {
                let added = self.sync_plan(s).await;
                let after = plan::read(root);
                // B20: a message that came in meanwhile is answered first: it may ask for more work.
                let waiting = Queue::load(&s.queue).answer_waiting();
                if added == 0 && !waiting && after.iter().all(|i| i.mark != Mark::Open) {
                    let _ = Queue::update(&s.queue, |q| q.finish(job.id, "", ""));
                    return Err(if after.is_empty() { NO_SCOPE.into() } else { format!("done: every function in scope is proved or blocked ({} items)", after.len()) });
                }
                Ok(Out { summary: format!("{added} items from the AST"), ..Out::default() })
            }
            JobKind::Prove => {
                self.emit(s, Kind::Status, "prover", &id, "reading the item's def and slice (formal-ast)");
                let ast = self.ast(s, true).await;
                let brief = self.world.brief(root, ast.as_deref(), &job.text);
                let mut task = match &statement {
                    Some(st) => format!("{}\n\nThe function: {}\n\n{brief}", crate::statements::obligation_task(st, job.item, &lib, &crate::swarm_ctx::informal_dir(root)), job.text),
                    None => format!("Plan item {id}: {}\n\n{brief}", job.text),
                };
                if !job.notes.is_empty() {
                    task.push_str(&format!("\n\nThe last attempt was sent back:\n{}", job.notes));
                }
                self.agent(s, job.id, "prover", &id, json!(format!("{task}{resume_note}"))).await
            }
            JobKind::Review => {
                // R8: a verdict stored before a quit is the outcome; the reviewer isn't asked again.
                match job.verdict.as_ref().filter(|_| resumed) {
                    Some(v) => Ok(Out { d: decided_from(v), ..Out::default() }),
                    None => {
                        let files = if job.files.is_empty() { String::new() } else { format!("\nFiles: {}", job.files.join(", ")) };
                        let ast = self.ast(s, false).await;
                        let brief = self.world.brief(root, ast.as_deref(), &job.text);
                        let notes = match &job.property {
                            Some(p) => format!(
                                "\n\nThe prover's notes for the report (check them; correct them in your verdict if they're wrong):\nStatement: {}\nAssumptions: {}\nTheorems: {}",
                                p["statement"].as_str().unwrap_or(""),
                                p["assumptions"].as_str().filter(|a| !a.is_empty()).unwrap_or("none"),
                                p["theorems"].as_array().map(|t| t.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default()
                            ),
                            None => "\n\nThe prover wrote no notes for the report: if you approve, give statement, assumptions and theorems.".into(),
                        };
                        let head = match &statement {
                            Some(st) => format!("{}\n\nThe function: {}", crate::statements::review_task(st, job.item), job.text),
                            None => format!("Plan item {id}: {}", job.text),
                        };
                        self.agent(s, job.id, "reviewer", &id, json!(format!("{head}\n\nThe prover says:\n{}{notes}{files}\n\n{brief}{resume_note}", job.notes))).await
                    }
                }
            }
            JobKind::Other(k) => Ok(Out { summary: format!("unknown job kind {k}"), ..Out::default() }),
        };
        let mut out = match outcome {
            Ok(o) => o,
            // B41: the job stays running, so the next start resumes it.
            Err(e) => return Err(paused_by(&e)),
        };
        // R8: the verdict stored on the job counts though the turn ended before it said so.
        if job.kind == JobKind::Review && out.d.verdict.is_none() {
            if let Some(v) = Queue::load(&s.queue).job(job.id).and_then(|j| j.verdict.clone()) {
                let restored = decided_from(&v);
                out.d.verdict = restored.verdict;
                out.d.property = out.d.property.or(restored.property);
            }
        }
        // B6/R9: a stopped turn that reached no verdict and no bug isn't finished: it stays running and resumes.
        if (out.stopped || s.stopped()) && out.d.verdict.is_none() && out.d.bug.is_none() {
            return Err(PAUSED.into());
        }
        self.apply(s, job, &id, statement.as_ref(), out).await;
        Ok(())
    }

    /// B17–B19, B21, B50, B52: a finished turn's job is done, and what follows from it is queued and marked.
    async fn apply(&self, s: &Session, job: &Job, id: &str, statement: Option<&crate::statements::Statement>, out: Out) {
        let root = s.root.as_path();
        let mut gate: Option<String> = None;
        let mut proved_by: Vec<String> = vec![];
        let mut theorem_type: Option<String> = None;
        let orphan = matches!(job.kind, JobKind::Prove | JobKind::Review) && !job.statement.is_empty() && statement.is_none();
        if job.kind == JobKind::Prove && !orphan && out.d.bug.is_none() && !s.stopped() {
            let mut all = Queue::load(&s.queue).job(job.id).map(|j| j.files.clone()).unwrap_or_default();
            if !all.iter().any(|f| f.ends_with(".lean")) {
                if let Some(p) = expected_proof(root, statement.map(|st| st.id.as_str()), &job.text) {
                    all.push(p);
                }
            }
            match self.check_proof(s, id, &job.text, &all).await {
                Ok(by) => proved_by = by,
                Err(e) => gate = Some(e),
            }
            if let (None, Some(st)) = (&gate, statement) {
                let lean = crate::statements::def_of(&job.text).unwrap_or("").to_string();
                self.emit(s, Kind::Status, "prover", id, format!("checking: the theorem {}", crate::statements::theorem_name(&st.id, &lean)));
                match self.world.check_theorem(root, &st.id, &lean).await {
                    Ok(ty) => {
                        self.emit(s, Kind::Result, "prover", id, ty.chars().take(500).collect::<String>());
                        theorem_type = Some(ty);
                    }
                    Err(e) => gate = Some(e),
                }
            }
        }
        let mark = |m: Mark| {
            if job.statement.is_empty() {
                let _ = plan::set_mark(root, job.item, m);
            } else if let Err(e) = crate::statements::set_obligation(root, &job.statement, job.item, m.as_char()) {
                eprintln!("statements: {e}");
            }
        };
        let approved = job.kind == JobKind::Review && out.d.bug.is_none() && matches!(out.d.verdict, Some((true, _)));
        let mut statement_proved: Option<String> = None;
        let _ = Queue::update(&s.queue, |q| {
            let result = match (&job.kind, &out.d.bug) {
                _ if orphan => "",
                (JobKind::Prove | JobKind::Review, Some(_)) => "bug",
                (JobKind::Prove, None) if gate.is_some() => "changes",
                (JobKind::Review, None) if approved => "approve",
                (JobKind::Review, None) => "changes",
                _ => "",
            };
            q.finish(job.id, result, &out.summary);
            let files = q.job(job.id).map(|j| j.files.clone()).unwrap_or_default();
            let follow = |q: &mut Queue, new: NewJob| q.enqueue(NewJob { statement: job.statement.clone(), ..new });
            match &job.kind {
                _ if orphan => {}
                JobKind::Prove | JobKind::Review if out.d.bug.is_some() => mark(Mark::Blocked),
                JobKind::Prove if gate.is_some() => {
                    if job.attempt >= MAX_ATTEMPTS {
                        mark(Mark::Blocked);
                    } else {
                        let notes = format!("The swarm's check failed:\n{}", gate.clone().unwrap_or_default());
                        follow(q, NewJob { item: job.item, text: job.text.clone(), attempt: job.attempt + 1, notes, files, ..NewJob::new(JobKind::Prove) });
                    }
                }
                JobKind::Prove => {
                    let mut summary = if proved_by.is_empty() { out.summary.clone() } else { format!("{}\n\nChecked by the swarm: `lake build` passes; the Proofs page counts it as proved by {}.", out.summary, proved_by.join("; ")) };
                    if let (Some(ty), Some(st)) = (&theorem_type, statement) {
                        let name = crate::statements::theorem_name(&st.id, crate::statements::def_of(&job.text).unwrap_or(""));
                        summary.push_str(&format!("\n\n`{name}` has no sorry (#print axioms). Its type, as Lean reports it:\n```lean\n{ty}\n```"));
                    }
                    follow(q, NewJob { item: job.item, text: job.text.clone(), attempt: job.attempt, notes: summary, files, property: out.d.property.clone(), ..NewJob::new(JobKind::Review) });
                }
                JobKind::Review if approved && !job.statement.is_empty() => {
                    let name = crate::statements::theorem_name(&job.statement, crate::statements::def_of(&job.text).unwrap_or(""));
                    crate::statements::record_obligation(root, &job.statement, job.item, &name, &files, audit::merge_property(job.property.as_ref(), out.d.property.as_ref()).as_ref());
                    match crate::statements::set_obligation(root, &job.statement, job.item, 'x') {
                        Ok('x') => {
                            if let Err(e) = crate::statements::record_property(root, &job.statement) {
                                eprintln!("record_property: {e}");
                            }
                            statement_proved = Some(job.statement.clone());
                            self.world.statement_proved(root, &job.statement);
                        }
                        Ok(_) => {}
                        Err(e) => eprintln!("statements: {e}"),
                    }
                }
                JobKind::Review if approved => {
                    mark(Mark::Proved);
                    self.world.approved(root, &job.text, &out.summary);
                    if let Some(p) = audit::merge_property(job.property.as_ref(), out.d.property.as_ref()) {
                        if let Err(e) = audit::record_property(root, job.item, &job.text, &files, &p) {
                            eprintln!("record_property: {e}");
                        }
                    }
                    record_proof(root, job.item, &job.text, files, &job.notes);
                }
                JobKind::Review => {
                    if job.attempt >= MAX_ATTEMPTS {
                        mark(Mark::Blocked);
                    } else {
                        let notes = out.d.verdict.as_ref().map(|v| v.1.clone()).unwrap_or_else(|| "The reviewer gave no verdict; make the proof's statement and check obvious.".into());
                        follow(q, NewJob { item: job.item, text: job.text.clone(), attempt: job.attempt + 1, notes, ..NewJob::new(JobKind::Prove) });
                    }
                }
                _ => {}
            }
        });
        if job.kind == JobKind::Formalize {
            let sid = job.text.clone();
            let still = crate::statements::load(root).unwrap_or_default().into_iter().any(|st| st.id == sid);
            match &out.d.formalized {
                _ if !still => {}
                Some(f) => {
                    if let Err(e) = crate::statements::record(root, &sid, f) {
                        eprintln!("statements: {e}");
                    }
                    if f.asks() {
                        self.emit(s, Kind::Ask, "assistant", &sid, crate::statements::ask_text(&sid, f));
                        self.world.asked(&s.folder, &sid);
                    } else {
                        self.emit(s, Kind::Plan, "assistant", &sid, format!("{sid}: a {} statement; the swarm doesn't prove those yet", f.kind));
                    }
                }
                None => {
                    let _ = crate::statements::record_failure(root, &sid, &out.summary);
                    self.emit(s, Kind::Plan, "assistant", &sid, format!("{sid}: couldn't formalize it; reword it or name the function"));
                }
            }
        }
        if let Some(sid) = &statement_proved {
            self.emit(s, Kind::Plan, "reviewer", sid, format!("{sid} proved: every function it is about, in the audit file as P-{}", sid.replace('-', "")));
        }
        if orphan {
            return;
        }
        let text = match (&job.kind, &out.d.bug) {
            (JobKind::Prove, Some(_)) => Some(("prover", format!("item {id}: bug reported, moving on"))),
            (JobKind::Review, Some(_)) => Some(("reviewer", format!("item {id}: bug reported, moving on"))),
            (JobKind::Review, None) if approved => Some(("reviewer", format!("item {id} proven"))),
            (JobKind::Review, None) if job.attempt >= MAX_ATTEMPTS => Some(("reviewer", format!("item {id} blocked after {MAX_ATTEMPTS} attempts"))),
            (JobKind::Prove, None) if gate.is_some() && job.attempt >= MAX_ATTEMPTS => Some(("prover", format!("item {id} blocked: the proof didn't check after {MAX_ATTEMPTS} attempts"))),
            (JobKind::Prove, None) if gate.is_some() => Some(("prover", format!("item {id}: the check failed, back to the prover"))),
            (JobKind::Prove, None) => Some(("prover", format!("item {id} checks; to review"))),
            (JobKind::Triage, _) => Some(("auditor", format!("read {}: its findings are in Bugs", job.text))),
            _ => None,
        };
        if let Some((role, text)) = text {
            let item = if job.kind == JobKind::Triage { "report" } else { id };
            self.emit(s, Kind::Plan, role, item, text);
        }
    }
}

/// A stored `verdict` input as the turn's decision (R8).
fn decided_from(v: &Value) -> Decided {
    let approve = v["decision"].as_str() == Some("approve");
    Decided { verdict: Some((approve, v["notes"].as_str().unwrap_or("").to_string())), property: approve.then(|| v.clone()), ..Decided::default() }
}

/// `.formal/proofs.json`: for each proved plan item, the files that prove it and the prover's summary.
pub fn proofs_path(root: &Path) -> std::path::PathBuf {
    root.join(".formal").join("proofs.json")
}

fn record_proof(root: &Path, index: usize, text: &str, files: Vec<String>, summary: &str) {
    let mut all: Value = std::fs::read_to_string(proofs_path(root)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    all[index.to_string()] = json!({ "item": text, "files": files, "summary": summary, "at": crate::swarm2::events::now_ms().to_string() });
    let _ = std::fs::write(proofs_path(root), serde_json::to_string_pretty(&all).unwrap_or_default());
}
