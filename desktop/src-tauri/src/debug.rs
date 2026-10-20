//! Debug mode: the sol-debug engine (crates/sol-debug) behind Tauri commands. A session compiles one file of a local
//! folder, lists its `test_…` functions and runs one with the recorder on. The session, the trace and the navigator
//! stay here, keyed by an id; the webview gets a small view of one step at a time (the source place, a window of
//! opcodes, the stack, memory rebuilt from the frame's writes, the latest storage accesses), never the trace.
//! The panes are the terminal UI's (crates/sol-debug/src/tui.rs). See desktop/DEBUGGER.md section 8.

use revm::bytecode::opcode::OpCode;
use serde::Serialize;
use sol_debug::nav::{Dir, Navigator};
use sol_debug::session::{short_word, Run, Session};
use sol_debug::srcmap::Jump;
use sol_debug::trace::StorageAccess;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};

/// Open debug sessions by id. A [`Session`] holds revm's EVM, which isn't `Send`, so each debug session lives on a
/// thread of its own and the commands hand it jobs.
#[derive(Default)]
pub struct Debuggers {
    next: AtomicU32,
    open: Mutex<HashMap<u32, mpsc::Sender<Job>>>,
}

type Job = Box<dyn FnOnce(&mut Debugger) + Send>;

pub struct Debugger {
    root: PathBuf,
    file: String,
    /// A compile no test has run in yet: the first run uses it, later runs compile again for a clean chain.
    fresh: Option<Session>,
    loaded: Option<Loaded>,
}

struct Loaded {
    s: Session,
    run: Run,
    nav: Navigator,
    cur: usize,
}

#[derive(Serialize, Clone)]
pub struct TestFn {
    /// `test/AsyncSwap.t.sol:AsyncSwapTest`, what `run_test` takes.
    contract: String,
    /// `AsyncSwapTest`.
    name: String,
    /// `test_swap_createsOrderWithPrice`.
    test: String,
}

#[derive(Serialize)]
pub struct Opened {
    id: u32,
    tests: Vec<TestFn>,
}

#[derive(Serialize)]
pub struct Call {
    depth: usize,
    kind: &'static str,
    /// `Router → PoolManager`, or `AsyncSwap ⇒ OrderLib` for a DELEGATECALL.
    who: String,
    /// `swap(…)` decoded with the ABI of the code it runs.
    call: String,
    ok: Option<bool>,
    first_step: usize,
}

#[derive(Serialize)]
pub struct RunView {
    title: String,
    success: bool,
    /// `ok` or `reverted: …`.
    verdict: String,
    gas: u64,
    calls: Vec<Call>,
    /// Cheatcodes the test called that the session doesn't answer.
    missing: Vec<String>,
    view: StepView,
}

#[derive(Serialize)]
pub struct Place {
    /// Source id: the key for `debug_file`.
    file: i64,
    name: String,
    line: usize,
    scope: String,
    node_type: String,
    /// The current node's `src` on its first line, in UTF-16 units of the line (what JS strings index).
    from: usize,
    to: usize,
    /// False when the step has no source and this is the last place before it.
    exact: bool,
}

#[derive(Serialize)]
pub struct Op {
    pc: usize,
    name: String,
    /// The PUSH immediate, as hex.
    imm: String,
    /// `in` / `out` for a JUMP into or out of a function.
    jump: &'static str,
    current: bool,
    /// From the same AST node as the current instruction.
    node: bool,
}

#[derive(Serialize)]
pub struct Word {
    short: String,
    full: String,
}

#[derive(Serialize)]
pub struct MemWord {
    offset: usize,
    hex: String,
    /// Written by the frame's last step before this one.
    fresh: bool,
}

#[derive(Serialize)]
pub struct Access {
    step: usize,
    write: bool,
    who: String,
    /// `write priceBooks[0x3e76cc…a14c].asks.nodes[1].price: 0 → 79228…`, long hex shortened.
    text: String,
    full: String,
}

#[derive(Serialize)]
pub struct StepView {
    step: usize,
    total: usize,
    depth: usize,
    pc: usize,
    op: String,
    gas: u64,
    place: Option<Place>,
    frame: usize,
    /// The current frame and its callers.
    open: Vec<usize>,
    ops: Vec<Op>,
    stack: Vec<Word>,
    result: Option<Word>,
    memory_size: usize,
    memory: Vec<MemWord>,
    /// Storage accesses up to this step, newest first.
    storage: Vec<Access>,
    breakpoints: Vec<(i64, usize)>,
    watches: Vec<String>,
    status: String,
}

#[derive(Serialize)]
pub struct File {
    name: String,
    text: String,
}

/// Runs `f` on the session's thread and waits for its answer.
async fn ask<T: Send + 'static>(state: &Debuggers, id: u32, f: impl FnOnce(&mut Debugger) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let tx = state.open.lock().unwrap().get(&id).cloned().ok_or("That debug session is closed; open the test again")?;
    let (rtx, rrx) = mpsc::channel();
    tx.send(Box::new(move |d| {
        let _ = rtx.send(f(d));
    }))
    .map_err(|_| "The debug session stopped")?;
    tauri::async_runtime::spawn_blocking(move || rrx.recv()).await.map_err(err)?.map_err(|_| "The debug session stopped".to_string())?
}

/// The loaded run, for the commands that need one.
fn loaded(d: &mut Debugger) -> Result<&mut Loaded, String> {
    d.loaded.as_mut().ok_or_else(|| "Run a test first".into())
}

fn err(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

/// The `test…()` functions of the contracts defined in `file`.
fn tests_in(s: &Session, file: &str) -> Vec<TestFn> {
    let mut out = Vec::new();
    for a in s.artifacts.iter().filter(|a| a.file == file || a.file.ends_with(&format!("/{file}"))) {
        for sig in a.methods.values() {
            // Fuzz tests take arguments; only the ones that run as they are.
            if let Some(test) = sig.strip_suffix("()").filter(|t| t.starts_with("test")) {
                out.push(TestFn { contract: format!("{}:{}", a.file, a.name), name: a.name.clone(), test: test.to_string() });
            }
        }
    }
    out
}

/// Compiles `file` (relative to `folder`, an added local folder) on a new session thread and lists its tests.
#[tauri::command]
pub async fn debug_open(state: tauri::State<'_, Debuggers>, folder: String, file: String) -> Result<Opened, String> {
    open(&state, folder, file).await
}

pub async fn open(state: &Debuggers, folder: String, file: String) -> Result<Opened, String> {
    if !crate::local::read()?.folders.contains(&folder) {
        return Err("Add the folder first".into());
    }
    let (tx, jobs) = mpsc::channel::<Job>();
    let (ready, opened) = mpsc::channel();
    std::thread::Builder::new()
        .name("sol-debug".into())
        .spawn(move || {
            let root = PathBuf::from(folder);
            let mut d = match Session::compile(&root, &file) {
                Ok(s) => {
                    let _ = ready.send(Ok(tests_in(&s, &file)));
                    Debugger { root, file, fresh: Some(s), loaded: None }
                }
                Err(e) => return drop(ready.send(Err(err(e)))),
            };
            // Until the session is closed (its sender dropped).
            for job in jobs {
                job(&mut d);
            }
        })
        .map_err(err)?;
    let tests = tauri::async_runtime::spawn_blocking(move || opened.recv()).await.map_err(err)?.map_err(|_| "The compile stopped".to_string())??;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state.open.lock().unwrap().insert(id, tx);
    Ok(Opened { id, tests })
}

#[tauri::command]
pub fn debug_close(state: tauri::State<'_, Debuggers>, id: u32) {
    close(&state, id)
}

pub fn close(state: &Debuggers, id: u32) {
    state.open.lock().unwrap().remove(&id);
}

/// Runs one test (setUp untraced, then the test recorded) and opens on its first statement.
#[tauri::command]
pub async fn debug_run(state: tauri::State<'_, Debuggers>, id: u32, contract: String, test: String) -> Result<RunView, String> {
    run_test(&state, id, contract, test).await
}

pub async fn run_test(state: &Debuggers, id: u32, contract: String, test: String) -> Result<RunView, String> {
    ask(state, id, move |d| {
        let mut s = match d.fresh.take() {
            Some(s) => s,
            None => Session::compile(&d.root, &d.file).map_err(err)?,
        };
        let run = s.run_test(&contract, &test, false).map_err(err)?.test;
        let mut nav = Navigator::new(&s, &run);
        // Breakpoints and watches carry over to the next test of the same file.
        if let Some(old) = d.loaded.take() {
            nav.breakpoints = old.nav.breakpoints;
            nav.watches = old.nav.watches;
        }
        // Open on the first statement inside a function (past the dispatcher and the function header), as the TUI.
        let in_body = |i: usize| {
            nav.locs[i].as_ref().is_some_and(|l| l.scope.contains('.') && !matches!(l.node_type.as_str(), "FunctionDefinition" | "ContractDefinition"))
        };
        let cur = (0..nav.len()).find(|&i| in_body(i)).or_else(|| (0..nav.len()).find(|&i| nav.locs[i].is_some())).unwrap_or(0);
        let l = Loaded { s, run, nav, cur };
        if l.nav.is_empty() {
            return Err("The run recorded no steps".into());
        }
        let verdict = if l.run.success { "ok".to_string() } else { format!("reverted: {}", l.run.revert_reason().unwrap_or_default()) };
        let calls = l
            .run
            .trace
            .frames
            .iter()
            .map(|fr| Call {
                depth: fr.depth,
                kind: fr.kind,
                who: if fr.kind == "DELEGATECALL" {
                    format!("{} ⇒ {}", l.s.name_of(fr.target), l.s.name_of(fr.code_address))
                } else {
                    format!("{} → {}", l.s.name_of(fr.caller), l.s.name_of(fr.target))
                },
                call: compact_hex(&l.s.describe_call(fr.code_address, &fr.input)),
                ok: fr.success,
                first_step: fr.first_step,
            })
            .collect();
        let name = contract.rsplit(':').next().unwrap_or(&contract).to_string();
        let out = RunView {
            title: format!("{name}::{test}"),
            success: l.run.success,
            verdict: verdict.clone(),
            gas: l.run.gas_used,
            calls,
            missing: l.s.evm.inspector.cheats.missing.clone(),
            view: view(&l, verdict),
        };
        d.loaded = Some(l);
        Ok(out)
    })
    .await
}

/// Moves through the run: `op`, `into`, `over`, `out`, `continue`, `search` (with `arg`), each forward or `back`;
/// `first`, `last`, `step` and `pc` (with `arg`).
#[tauri::command]
pub async fn debug_nav(state: tauri::State<'_, Debuggers>, id: u32, to: String, back: bool, arg: Option<String>) -> Result<StepView, String> {
    step(&state, id, to, back, arg).await
}

pub async fn step(state: &Debuggers, id: u32, to: String, back: bool, arg: Option<String>) -> Result<StepView, String> {
    ask(state, id, move |d| move_to(loaded(d)?, &to, back, arg.unwrap_or_default())).await
}

fn move_to(l: &mut Loaded, to: &str, back: bool, arg: String) -> Result<StepView, String> {
    let dir = if back { Dir::Back } else { Dir::Forward };
    let last = l.nav.len() - 1;
    let steps = &l.run.trace.steps;
    let (found, miss) = match to {
        "op" => (Some(if back { l.cur.saturating_sub(1) } else { (l.cur + 1).min(last) }), String::new()),
        "into" => (l.nav.step_into(l.cur, dir), String::new()),
        "over" => (l.nav.step_over(l.cur, dir), String::new()),
        "out" => (l.nav.step_out(l.cur, dir), String::new()),
        "continue" => (l.nav.continue_to(l.cur, dir, steps), "no breakpoint, watched write or revert that way".into()),
        "first" => (Some(0), String::new()),
        "last" => (Some(last), String::new()),
        "search" => (l.nav.search(&l.s, l.cur, dir, &arg), format!("no {} line contains {arg:?}", if back { "earlier" } else { "later" })),
        "step" => (arg.parse::<usize>().ok().filter(|&i| i <= last), format!("steps go from 0 to {last}")),
        "pc" => {
            let frame = steps[l.cur].frame;
            let pc = match arg.strip_prefix("0x") {
                Some(h) => usize::from_str_radix(h, 16).ok(),
                None => arg.parse().ok(),
            };
            (pc.and_then(|pc| (0..steps.len()).find(|&i| steps[i].frame == frame && steps[i].pc == pc)), format!("pc {arg} doesn't run in this frame"))
        }
        other => return Err(format!("unknown move {other:?}")),
    };
    let status = match found {
        Some(i) => {
            l.cur = i;
            String::new()
        }
        None if miss.is_empty() => "no further step that way".into(),
        None => miss,
    };
    Ok(view(l, status))
}

/// Toggles a line breakpoint: in source `file` (an id), in the file named `name` (`AsyncSwap.sol`), or else in the
/// current step's file.
#[tauri::command]
pub async fn debug_break(state: tauri::State<'_, Debuggers>, id: u32, line: usize, file: Option<i64>, name: Option<String>) -> Result<StepView, String> {
    toggle_break(&state, id, line, file, name).await
}

pub async fn toggle_break(state: &Debuggers, id: u32, line: usize, file: Option<i64>, name: Option<String>) -> Result<StepView, String> {
    ask(state, id, move |d| {
    let l = loaded(d)?;
    let file = match (file, name) {
        (Some(f), _) => Some(f),
        (None, Some(n)) => l.s.sources.files.values().find(|x| x.name.ends_with(n.as_str())).map(|x| x.id),
        (None, None) => (0..=l.cur).rev().find_map(|i| l.nav.locs[i].as_ref().map(|x| x.entry.file)),
    };
    let Some(f) = file else { return Ok(view(l, "no such file in this compile".into())) };
    let status = if let Some(p) = l.nav.breakpoints.iter().position(|b| *b == (f, line)) {
        l.nav.breakpoints.remove(p);
        format!("breakpoint at line {line} removed")
    } else {
        l.nav.breakpoints.push((f, line));
        format!("breakpoint at line {line}; c continues to it")
    };
    Ok(view(l, status))
    })
    .await
}

/// Adds (or, with `on: false`, removes) a storage watch: `continue` stops on writes whose name contains `text`.
#[tauri::command]
pub async fn debug_watch(state: tauri::State<'_, Debuggers>, id: u32, text: String, on: bool) -> Result<StepView, String> {
    watch(&state, id, text, on).await
}

pub async fn watch(state: &Debuggers, id: u32, text: String, on: bool) -> Result<StepView, String> {
    ask(state, id, move |d| {
    let l = loaded(d)?;
    l.nav.watches.retain(|w| w != &text);
    let status = if on {
        l.nav.watches.push(text.clone());
        format!("watching writes to {text}; c continues to the next one")
    } else {
        format!("stopped watching {text}")
    };
    Ok(view(l, status))
    })
    .await
}

/// A source file of the compile, whole (the webview highlights it once and keeps it).
#[tauri::command]
pub async fn debug_file(state: tauri::State<'_, Debuggers>, id: u32, file: i64) -> Result<File, String> {
    source_file(&state, id, file).await
}

pub async fn source_file(state: &Debuggers, id: u32, file: i64) -> Result<File, String> {
    ask(state, id, move |d| {
        let s = d.loaded.as_ref().map(|l| &l.s).or(d.fresh.as_ref()).ok_or("Run a test first")?;
        let f = s.sources.files.get(&file).ok_or("no such file in this compile")?;
        Ok(File { name: f.name.clone(), text: f.text.clone() })
    })
    .await
}

/// The view of the current step.
fn view(l: &Loaded, status: String) -> StepView {
    let (s, nav, trace, cur) = (&l.s, &l.nav, &l.run.trace, l.cur);
    let st = &trace.steps[cur];

    let exact = nav.locs[cur].is_some();
    let place = nav.locs[cur].as_ref().or_else(|| (0..cur).rev().find_map(|i| nav.locs[i].as_ref())).and_then(|loc| {
        let file = s.sources.files.get(&loc.entry.file)?;
        let text = file.line_text(loc.line);
        let line_start = file.text[..(loc.entry.start as usize).min(file.text.len())].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let utf16 = |byte: usize| text.get(..byte.min(text.len())).map(|t| t.encode_utf16().count()).unwrap_or(0);
        let a = (loc.entry.start as usize).saturating_sub(line_start);
        let b = ((loc.entry.start + loc.entry.length) as usize).saturating_sub(line_start).max(a);
        Some(Place {
            file: file.id,
            name: file.name.clone(),
            line: loc.line,
            scope: loc.scope.clone(),
            node_type: loc.node_type.clone(),
            from: utf16(a),
            to: utf16(b),
            exact,
        })
    });

    // The frames open at this step: the current one and its callers (each the last earlier frame one level up).
    let frames = &trace.frames;
    let mut open = vec![st.frame];
    while let Some(&f0) = open.last() {
        let Some(d) = frames.get(f0).map(|f| f.depth) else { break };
        match (0..f0).rev().find(|&i| frames[i].depth + 1 == d) {
            Some(p) if d > 0 => open.push(p),
            _ => break,
        }
    }

    // A window of instructions around the pc.
    let mut ops = Vec::new();
    if let Some((_, map)) = s.code_of(trace, st) {
        let ix = map.pc_to_ix.get(st.pc).copied().unwrap_or(0);
        let node = map.ix_to_node.get(ix).copied().flatten();
        let from = ix.saturating_sub(30);
        for i in from..(from + 61).min(map.ix_to_pc.len()) {
            let pc = map.ix_to_pc[i];
            let op = map.code[pc];
            let imm = if (0x60..=0x7f).contains(&op) {
                let n = (op - 0x5f) as usize;
                format!("0x{}", revm::primitives::hex::encode(map.code.get(pc + 1..pc + 1 + n).unwrap_or(&[])))
            } else {
                String::new()
            };
            let jump = match map.entries.get(i).map(|e| e.jump) {
                Some(Jump::In) if op == 0x56 => "in",
                Some(Jump::Out) if op == 0x56 => "out",
                _ => "",
            };
            ops.push(Op {
                pc,
                name: OpCode::new(op).map(|o| o.as_str()).unwrap_or("?").to_string(),
                imm,
                jump,
                current: pc == st.pc,
                node: node.is_some() && map.ix_to_node.get(i).copied().flatten() == node,
            });
        }
    }

    // Memory before this step: the frame starts empty; replay its writes.
    let steps = &trace.steps;
    let first = frames.get(st.frame).map(|fr| fr.first_step).unwrap_or(0);
    let mut mem = vec![0u8; st.memory_size];
    let mut fresh = vec![];
    let mut last_in_frame = None;
    for (i, x) in steps.iter().enumerate().take(cur).skip(first) {
        if x.frame == st.frame {
            last_in_frame = Some(i);
        }
    }
    for (i, x) in steps.iter().enumerate().take(cur).skip(first) {
        if x.frame != st.frame {
            continue;
        }
        for (off, bytes) in &x.memory_writes {
            if mem.len() < off + bytes.len() {
                mem.resize(off + bytes.len(), 0);
            }
            mem[*off..off + bytes.len()].copy_from_slice(bytes);
            if Some(i) == last_in_frame {
                fresh.push(*off);
            }
        }
    }
    let memory = mem
        .chunks(32)
        .enumerate()
        .take(4096)
        .map(|(row, chunk)| MemWord { offset: row * 32, hex: revm::primitives::hex::encode(chunk), fresh: fresh.contains(&(row * 32)) })
        .collect();

    let mut storage = Vec::new();
    for i in (0..=cur).rev() {
        let (Some(text), Some(access)) = (&nav.storage[i], &steps[i].storage) else { continue };
        storage.push(Access {
            step: i,
            write: matches!(access, StorageAccess::Write { .. }),
            who: s.name_of(steps[i].address),
            text: compact_hex(text),
            full: text.clone(),
        });
        if storage.len() >= 100 {
            break;
        }
    }

    let word = |v: &revm::primitives::U256| Word { short: short_word(*v), full: format!("{v:#x}") };
    StepView {
        step: cur,
        total: nav.len(),
        depth: st.depth,
        pc: st.pc,
        op: OpCode::new(st.op).map(|o| o.as_str()).unwrap_or("INVALID").to_string(),
        gas: st.gas_left,
        place,
        frame: st.frame,
        open,
        ops,
        stack: st.stack.iter().rev().map(word).collect(),
        result: st.result.as_ref().map(word),
        memory_size: st.memory_size,
        memory,
        storage,
        breakpoints: nav.breakpoints.clone(),
        watches: nav.watches.clone(),
        status,
    }
}

/// Long hex runs (mapping keys, pool ids, addresses) as `0x3e76cc…a14c`, so a storage path stays readable.
fn compact_hex(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("0x") {
        out.push_str(&rest[..i]);
        let hex_len = rest[i + 2..].chars().take_while(|c| c.is_ascii_hexdigit()).count();
        let run = &rest[i..i + 2 + hex_len];
        if hex_len > 16 {
            out.push_str(&format!("{}…{}", &run[..8], &run[run.len() - 4..]));
        } else {
            out.push_str(run);
        }
        rest = &rest[i + 2 + hex_len..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Async Swap test from DEBUGGER.md, when that repository is checked out next to this one.
    #[test]
    #[ignore]
    fn async_swap_swap_names_storage() {
        let root = PathBuf::from(std::env::var("HOME").unwrap()).join("developer/asyncswap/contracts");
        let mut s = Session::compile(&root, "test/AsyncSwap.t.sol").unwrap();
        let tests = tests_in(&s, "test/AsyncSwap.t.sol");
        let t = tests.iter().find(|t| t.test == "test_swap_createsOrderWithPrice").expect("test listed");
        let run = s.run_test(&t.contract, &t.test, false).unwrap().test;
        assert!(run.success);
        let nav = Navigator::new(&s, &run);
        let l = Loaded { s, run, nav, cur: 0 };
        let last = view(&Loaded { cur: l.nav.len() - 1, ..l }, String::new());
        assert!(last.storage.iter().any(|a| a.write && a.full.contains(".asks.nodes[1].price")), "named writes: {:?}", last.storage.iter().map(|a| &a.full).collect::<Vec<_>>());
    }
}
