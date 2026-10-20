//! Recording a run: a revm [`Inspector`] that keeps every step (pc, op, stack, memory writes, storage reads and
//! writes), every call frame with its calldata, every log, and every KECCAK256 input (to name mapping slots later).
//! Mapping steps back to Solidity happens afterwards, in [`crate::session`]: the recorder knows only the EVM.

use crate::layout::Preimages;
use revm::bytecode::opcode;
use revm::context::{ContextTr, JournalTr};
use revm::interpreter::interpreter_types::{InputsTr, Jumps, MemoryTr};
use revm::interpreter::{CallInputs, CallOutcome, CreateInputs, CreateOutcome, Interpreter};
use revm::primitives::{keccak256, Address, Bytes, Log, U256};
use revm::{Database, Inspector};
use std::collections::HashMap;

/// Which code a step runs: a deployed contract's runtime code, or the init code that is creating one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CodeRef {
    Runtime(Address),
    Init(Address),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageAccess {
    Read { slot: U256, value: U256 },
    Write { slot: U256, old: Option<U256>, new: U256 },
}

#[derive(Debug, Clone)]
pub struct Step {
    /// Index into [`Trace::frames`]: the call this step runs in.
    pub frame: usize,
    pub depth: usize,
    pub code: CodeRef,
    /// The storage this step touches belongs to this address (the frame's target, which differs from the code's
    /// address under DELEGATECALL).
    pub address: Address,
    pub pc: usize,
    pub op: u8,
    /// The stack before the op runs, bottom first.
    pub stack: Vec<U256>,
    /// The stack top after the op ran (for SLOAD, KECCAK256, arithmetic: the result).
    pub result: Option<U256>,
    pub gas_left: u64,
    pub memory_size: usize,
    /// 32-byte words of memory this op changed, as (offset, new bytes). Filled when the frame's next step starts,
    /// so a CALL's return data lands on the CALL.
    pub memory_writes: Vec<(usize, Vec<u8>)>,
    pub storage: Option<StorageAccess>,
}

#[derive(Debug, Clone)]
pub struct Frame {
    pub depth: usize,
    pub kind: &'static str,
    pub caller: Address,
    /// Whose storage the frame uses.
    pub target: Address,
    /// Whose code it runs (differs from `target` for DELEGATECALL); for a create, the new contract's address.
    pub code_address: Address,
    pub value: U256,
    pub input: Bytes,
    /// First step of the frame.
    pub first_step: usize,
    pub success: Option<bool>,
    pub output: Bytes,
}

#[derive(Debug, Clone)]
pub struct TraceLog {
    pub step: usize,
    pub log: Log,
}

#[derive(Default)]
pub struct Trace {
    pub steps: Vec<Step>,
    pub frames: Vec<Frame>,
    pub logs: Vec<TraceLog>,
    pub preimages: Preimages,
}

/// The inspector. Clear it with [`Recorder::take`] between transactions.
#[derive(Default)]
pub struct Recorder {
    pub trace: Trace,
    /// Open frames, innermost last.
    open: Vec<usize>,
    /// Per depth: the memory as the frame's previous step left it, and that step's index.
    memory: HashMap<usize, (Vec<u8>, usize)>,
    /// Storage values seen so far in this transaction, to show a write's old value.
    seen: HashMap<(Address, U256), U256>,
}

impl Recorder {
    pub fn take(&mut self) -> Trace {
        let t = std::mem::take(&mut self.trace);
        *self = Recorder::default();
        t
    }
}

impl<CTX> Inspector<CTX> for Recorder
where
    CTX: ContextTr,
{
    fn initialize_interp(&mut self, interp: &mut Interpreter, _: &mut CTX) {
        self.memory.remove(&interp.input.depth());
    }

    fn step(&mut self, interp: &mut Interpreter, context: &mut CTX) {
        let depth = interp.input.depth();
        let pc = interp.bytecode.pc();
        let op = interp.bytecode.opcode();
        let target = interp.input.target_address();
        let code = match interp.input.bytecode_address() {
            Some(a) => CodeRef::Runtime(*a),
            None => CodeRef::Init(target),
        };
        let stack = interp.stack.data().clone();
        let index = self.trace.steps.len();

        // Memory the previous step of this frame changed (including a sub-call's return data).
        let mem = interp.memory.slice(0..interp.memory.size()).to_vec();
        if let Some((before, prev)) = self.memory.get(&depth) {
            let writes = diff(before, &mem);
            if !writes.is_empty() {
                self.trace.steps[*prev].memory_writes = writes;
            }
        }

        let top = |n: usize| stack.len().checked_sub(n + 1).map(|i| stack[i]);
        let mut storage = None;
        match op {
            opcode::SSTORE => {
                if let (Some(slot), Some(new)) = (top(0), top(1)) {
                    let old = self.seen.get(&(target, slot)).copied().or_else(|| context.db_mut().storage(target, slot).ok());
                    self.seen.insert((target, slot), new);
                    storage = Some(StorageAccess::Write { slot, old, new });
                }
            }
            opcode::KECCAK256 => {
                if let (Some(off), Some(len)) = (top(0), top(1)) {
                    let (off, len) = (off.saturating_to::<usize>(), len.saturating_to::<usize>());
                    if len <= 1 << 16 {
                        // Past the end of memory reads as zeros.
                        let mut input = mem.get(off..(off + len).min(mem.len())).unwrap_or(&[]).to_vec();
                        input.resize(len, 0);
                        self.trace.preimages.insert(keccak256(&input), input);
                    }
                }
            }
            _ => {}
        }

        self.memory.insert(depth, (mem.clone(), index));
        self.trace.steps.push(Step {
            frame: self.open.last().copied().unwrap_or(0),
            depth,
            code,
            address: target,
            pc,
            op,
            stack,
            result: None,
            gas_left: interp.gas.remaining(),
            memory_size: mem.len(),
            memory_writes: vec![],
            storage,
        });
    }

    fn step_end(&mut self, interp: &mut Interpreter, _: &mut CTX) {
        let Some(step) = self.trace.steps.last_mut() else { return };
        let pushes = !matches!(
            step.op,
            opcode::SSTORE | opcode::MSTORE | opcode::MSTORE8 | opcode::POP | opcode::JUMP | opcode::JUMPI | opcode::JUMPDEST
                | opcode::STOP | opcode::RETURN | opcode::REVERT | opcode::CALLDATACOPY | opcode::CODECOPY
                | opcode::RETURNDATACOPY | opcode::MCOPY | opcode::TSTORE
        ) && !(opcode::LOG0..=opcode::LOG4).contains(&step.op);
        if pushes {
            step.result = interp.stack.data().last().copied();
        }
        if step.op == opcode::SLOAD {
            if let (Some(slot), Some(value)) = (step.stack.last().copied(), step.result) {
                self.seen.insert((step.address, slot), value);
                step.storage = Some(StorageAccess::Read { slot, value });
            }
        }
    }

    fn log_full(&mut self, _: &mut Interpreter, _: &mut CTX, log: Log) {
        self.trace.logs.push(TraceLog { step: self.trace.steps.len().saturating_sub(1), log });
    }

    fn call(&mut self, context: &mut CTX, inputs: &mut CallInputs) -> Option<CallOutcome> {
        let depth = context.journal_mut().depth();
        self.trace.frames.push(Frame {
            depth,
            kind: match inputs.scheme {
                revm::interpreter::CallScheme::Call => "CALL",
                revm::interpreter::CallScheme::CallCode => "CALLCODE",
                revm::interpreter::CallScheme::DelegateCall => "DELEGATECALL",
                revm::interpreter::CallScheme::StaticCall => "STATICCALL",
            },
            caller: inputs.caller,
            target: inputs.target_address,
            code_address: inputs.bytecode_address,
            value: inputs.value.get(),
            input: inputs.input.bytes(context),
            first_step: self.trace.steps.len(),
            success: None,
            output: Bytes::new(),
        });
        self.open.push(self.trace.frames.len() - 1);
        None
    }

    fn call_end(&mut self, _: &mut CTX, _: &CallInputs, outcome: &mut CallOutcome) {
        if let Some(i) = self.open.pop() {
            self.trace.frames[i].success = Some(outcome.result.result.is_ok());
            self.trace.frames[i].output = outcome.result.output.clone();
        }
    }

    fn create(&mut self, context: &mut CTX, inputs: &mut CreateInputs) -> Option<CreateOutcome> {
        let depth = context.journal_mut().depth();
        self.trace.frames.push(Frame {
            depth,
            kind: "CREATE",
            caller: inputs.caller(),
            target: Address::ZERO,
            code_address: Address::ZERO,
            value: inputs.value(),
            input: inputs.init_code().clone(),
            first_step: self.trace.steps.len(),
            success: None,
            output: Bytes::new(),
        });
        self.open.push(self.trace.frames.len() - 1);
        None
    }

    fn create_end(&mut self, _: &mut CTX, _: &CreateInputs, outcome: &mut CreateOutcome) {
        if let Some(i) = self.open.pop() {
            let f = &mut self.trace.frames[i];
            f.success = Some(outcome.result.result.is_ok());
            f.output = outcome.result.output.clone();
            if let Some(a) = outcome.address {
                f.target = a;
                f.code_address = a;
            }
        }
    }
}

/// The 32-byte words that differ between two memory snapshots.
fn diff(before: &[u8], after: &[u8]) -> Vec<(usize, Vec<u8>)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < after.len() {
        let end = (at + 32).min(after.len());
        let old = before.get(at..end.min(before.len())).unwrap_or(&[]);
        let new = &after[at..end];
        // Growth alone (zeros appearing past the old size) isn't a write.
        let changed = if old.len() == new.len() { old != new } else { new[old.len()..].iter().any(|b| *b != 0) || old != &new[..old.len()] };
        if changed {
            out.push((at, new.to_vec()));
        }
        at = end;
    }
    out
}
