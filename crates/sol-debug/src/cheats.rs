//! Foundry's cheatcodes, enough of them to run a project's own tests (`setUp()` then `test_…`) in the debugger:
//! calls to the `vm` address are answered here instead of running code.
//!
//! Supported: prank / startPrank / stopPrank, deal, etch, getCode (served from this session's compile, libraries
//! linked), warp, roll, addr, sign, label, assume, expectRevert, and the assert* family. expectEmit, recordLogs and
//! console.log calls are accepted and ignored. Anything else reverts with "sol-debug: unsupported cheatcode …", so
//! a missing one shows up in the trace at the step that needed it.

use alloy_dyn_abi::{DynSolType, DynSolValue};
use revm::bytecode::Bytecode;
use revm::context::JournalTr;
use revm::context_interface::journaled_state::account::JournaledAccountTr;
use crate::fork::Backend;
use revm::database::CacheDB;
use revm::handler::MainnetContext;
use revm::interpreter::{CallInputs, CallOutcome, Gas, InstructionResult, InterpreterResult};
use revm::primitives::{address, keccak256, Address, Bytes, B256, U256};
use std::collections::HashMap;

pub type Ctx = MainnetContext<CacheDB<Backend>>;

/// forge-std's `vm`.
pub const HEVM: Address = address!("7109709ECfa91a80626fF3989D68f67F5b1DD12D");
/// forge-std's console.log target.
pub const CONSOLE: Address = address!("000000000000000000636F6e736F6c652e6c6f67");

#[derive(Debug, Clone)]
struct Prank {
    sender: Address,
    origin: Option<Address>,
    /// Only calls made by this address, at this depth, are pranked.
    caller: Address,
    depth: usize,
    single: bool,
}

#[derive(Debug, Clone)]
struct ExpectRevert {
    data: Option<Bytes>,
    caller: Address,
    depth: usize,
}

/// Slots read and written, as `vm.accesses` returns them.
type Accesses = (Vec<B256>, Vec<B256>);

#[derive(Debug, Clone)]
struct Mock {
    target: Address,
    value: Option<U256>,
    data: Vec<u8>,
    returns: Vec<Vec<u8>>,
    revert: bool,
}

#[derive(Default, Clone)]
pub struct Cheats {
    prank: Option<Prank>,
    expect_revert: Option<ExpectRevert>,
    /// `vm.label` names, shown in the trace.
    pub labels: HashMap<Address, String>,
    /// Creation code by every name `getCode` might be given (`AsyncSwap.sol`, `AsyncSwap.sol:AsyncSwap`, the path).
    pub code: std::sync::Arc<HashMap<String, Vec<u8>>>,
    /// Unsupported cheatcodes that were called (for the summary).
    pub missing: Vec<String>,
    /// What `console.log` printed, in order (setUp's and the run's).
    pub console: Vec<String>,
    /// console.log signatures by selector (forge-std's: up to four of string/uint256/address/bool, and singles).
    console_sigs: HashMap<[u8; 4], String>,
    /// Programs `vm.ffi` / `vm.tryFfi` may run (by name: `hnc`), and the folder they run in. Empty: ffi refuses.
    pub ffi_allow: Vec<String>,
    pub ffi_dir: std::path::PathBuf,
    /// `vm.serialize*` objects being built, by object key.
    json: HashMap<String, Vec<(String, String)>>,
    /// The project's `.env` (Foundry loads it for scripts), read once.
    dotenv: Option<HashMap<String, String>>,
    /// ffi results by argv, so a compiler runs once per distinct call.
    ffi_cache: HashMap<Vec<String>, (i32, Vec<u8>, Vec<u8>)>,
    /// Bytecode a compiler printed through ffi, by the source file it named (`src/AsyncSwap.huff`): lets the session
    /// name code that solc didn't build.
    pub compiled: Vec<(String, Vec<u8>)>,
    /// Runtime code by the names `getCode` takes, for `getDeployedCode`.
    pub deployed: std::sync::Arc<HashMap<String, Vec<u8>>>,
    /// `mockCall`s, newest last: a call to `target` whose calldata starts with `data` (and whose value matches, when
    /// given) is answered with the next of `returns` (the last one repeats), as a return or a revert.
    mocks: Vec<Mock>,
    /// `record()`: slots read and written per address, until `accesses` is asked.
    recording: Option<HashMap<Address, Accesses>>,
    /// `snapshotState()`: the accounts, transient storage and the block, by id.
    states: Vec<Option<(revm::state::EvmState, revm::state::TransientStorage, revm::context::BlockEnv)>>,
    /// The test contract being run (forge's rules for its own calls apply to it), and per open frame whether it is
    /// one of the test contract's top-level calls.
    pub test_contract: Option<Address>,
    top_calls: Vec<bool>,
    /// `recordLogs()`: the logs emitted since, until `getRecordedLogs` takes them.
    logs: Option<Vec<revm::primitives::Log>>,
    /// `expectCall`s accepted but not checked (the runner doesn't verify them yet).
    pub unchecked_expect_calls: usize,
    /// One entry per open call or create: whether a pending expectRevert is aimed at it.
    armed: Vec<bool>,
    signatures: HashMap<[u8; 4], &'static str>,
}

const SIGNATURES: &[&str] = &[
    "prank(address)",
    "prank(address,address)",
    "startPrank(address)",
    "startPrank(address,address)",
    "stopPrank()",
    "deal(address,uint256)",
    "etch(address,bytes)",
    "getCode(string)",
    "warp(uint256)",
    "store(address,bytes32,bytes32)",
    "load(address,bytes32)",
    "record()",
    "accesses(address)",
    "mockCall(address,bytes,bytes)",
    "mockCall(address,uint256,bytes,bytes)",
    "mockCallRevert(address,bytes,bytes)",
    "mockCallRevert(address,uint256,bytes,bytes)",
    "mockCalls(address,bytes,bytes[])",
    "clearMockedCalls()",
    "chainId(uint256)",
    "snapshotState()",
    "revertToState(uint256)",
    "revertToStateAndDelete(uint256)",
    "deleteStateSnapshot(uint256)",
    "expectCall(address,bytes)",
    "expectCall(address,uint256,bytes)",
    "expectCall(address,bytes,uint64)",
    "expectCall(address,uint256,bytes,uint64)",
    "getDeployedCode(string)",
    "getNonce(address)",
    "computeCreateAddress(address,uint256)",
    "cool(address)",
    "coolSlot(address,bytes32)",
    "dumpState(string)",
    "createFork(string,uint256)",
    "createFork(string)",
    "selectFork(uint256)",
    "roll(uint256)",
    "addr(uint256)",
    "sign(uint256,bytes32)",
    "label(address,string)",
    "assume(bool)",
    "expectRevert()",
    "expectRevert(bytes)",
    "expectRevert(bytes4)",
    "expectEmit()",
    "expectEmit(bool,bool,bool,bool)",
    "expectEmit(bool,bool,bool,bool,address)",
    "expectEmit(address)",
    "recordLogs()",
    "ffi(string[])",
    "tryFfi(string[])",
    // Scripts (script/*.s.sol): environment, broadcasting (a prank), files and JSON. Writes are skipped while debugging.
    "envOr(string,address)",
    "envOr(string,uint256)",
    "envOr(string,int256)",
    "envOr(string,bool)",
    "envOr(string,bytes32)",
    "envOr(string,string)",
    "envOr(string,bytes)",
    "envAddress(string)",
    "envUint(string)",
    "envInt(string)",
    "envBool(string)",
    "envBytes32(string)",
    "envString(string)",
    "envBytes(string)",
    "envExists(string)",
    "startBroadcast()",
    "startBroadcast(address)",
    "startBroadcast(uint256)",
    "broadcast()",
    "broadcast(address)",
    "broadcast(uint256)",
    "stopBroadcast()",
    "toString(address)",
    "toString(uint256)",
    "toString(int256)",
    "toString(bool)",
    "toString(bytes32)",
    "toString(bytes)",
    "projectRoot()",
    "readFile(string)",
    "writeFile(string,string)",
    "createDir(string,bool)",
    "writeJson(string,string)",
    "writeJson(string,string,string)",
    "serializeUint(string,string,uint256)",
    "serializeInt(string,string,int256)",
    "serializeAddress(string,string,address)",
    "serializeBool(string,string,bool)",
    "serializeBytes(string,string,bytes)",
    "serializeBytes32(string,string,bytes32)",
    "serializeString(string,string,string)",
    "getRecordedLogs()",
    "parseJsonAddress(string,string)",
    "parseJsonUint(string,string)",
    "parseJsonInt(string,string)",
    "parseJsonBool(string,string)",
    "parseJsonBytes32(string,string)",
    "parseJsonString(string,string)",
    "parseJsonBytes(string,string)",
    "keyExistsJson(string,string)",
    "keyExists(string,string)",
    "assertTrue(bool)",
    "assertTrue(bool,string)",
    "assertFalse(bool)",
    "assertFalse(bool,string)",
    "assertEq(bool,bool)",
    "assertEq(bool,bool,string)",
    "assertEq(uint256,uint256)",
    "assertEq(uint256,uint256,string)",
    "assertEq(int256,int256)",
    "assertEq(int256,int256,string)",
    "assertEq(address,address)",
    "assertEq(address,address,string)",
    "assertEq(bytes32,bytes32)",
    "assertEq(bytes32,bytes32,string)",
    "assertEq(string,string)",
    "assertEq(string,string,string)",
    "assertEq(bytes,bytes)",
    "assertEq(bytes,bytes,string)",
    "assertNotEq(uint256,uint256)",
    "assertNotEq(uint256,uint256,string)",
    "assertNotEq(address,address)",
    "assertNotEq(address,address,string)",
    "assertNotEq(bytes32,bytes32)",
    "assertNotEq(bytes32,bytes32,string)",
    "assertGt(uint256,uint256)",
    "assertGt(uint256,uint256,string)",
    "assertGe(uint256,uint256)",
    "assertGe(uint256,uint256,string)",
    "assertLt(uint256,uint256)",
    "assertLt(uint256,uint256,string)",
    "assertLe(uint256,uint256)",
    "assertLe(uint256,uint256,string)",
    "assertGt(int256,int256)",
    "assertGt(int256,int256,string)",
    "assertLt(int256,int256)",
    "assertLt(int256,int256,string)",
    "assertApproxEqAbs(uint256,uint256,uint256)",
    "assertApproxEqAbs(uint256,uint256,uint256,string)",
    "assertApproxEqRel(uint256,uint256,uint256)",
    "assertApproxEqRel(uint256,uint256,uint256,string)",
];

enum Answer {
    Ok(Vec<u8>),
    Revert(String),
}

impl Cheats {
    pub fn new() -> Self {
        let signatures = SIGNATURES.iter().map(|s| (keccak256(s.as_bytes())[..4].try_into().unwrap(), *s)).collect();
        Cheats { signatures, ..Default::default() }
    }

    /// A console.log call as the line it prints (values joined by spaces, as forge shows them).
    fn console_line(&mut self, input: &Bytes) -> String {
        if self.console_sigs.is_empty() {
            self.console_sigs = console_signatures();
        }
        let Some(sel) = input.get(..4).and_then(|s| <[u8; 4]>::try_from(s).ok()) else { return String::new() };
        let Some(sig) = self.console_sigs.get(&sel) else { return format!("(console.log 0x{})", revm::primitives::hex::encode(sel)) };
        let params = &sig[sig.find('(').unwrap()..];
        let Ok(DynSolValue::Tuple(args)) = DynSolType::parse(&params.replace("uint)", "uint256)").replace("uint,", "uint256,").replace("int)", "int256)").replace("int,", "int256,")).and_then(|t| t.abi_decode_params(&input[4..])) else {
            return format!("(console.log {sig}: can't decode)");
        };
        args.iter()
            .map(|v| match v {
                DynSolValue::String(s) => s.clone(),
                DynSolValue::Uint(u, _) => u.to_string(),
                DynSolValue::Int(i, _) => i.to_string(),
                DynSolValue::Address(a) => a.to_checksum(None),
                DynSolValue::Bool(b) => b.to_string(),
                other => format!("0x{}", revm::primitives::hex::encode(other.abi_encode_packed())),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// The cheatcode signature for a selector (`prank(address)`).
    pub fn signature(&self, selector: &[u8]) -> Option<&'static str> {
        self.signatures.get(selector.get(..4)?).copied()
    }

    /// A name for an address: its `vm.label`, else nothing.
    pub fn label(&self, a: &Address) -> Option<&str> {
        self.labels.get(a).map(String::as_str)
    }

    /// Before a call: answer a cheatcode, or rewrite the caller for a prank. `depth` is the calling frame's.
    pub fn call(&mut self, ctx: &mut Ctx, inputs: &mut CallInputs, input: &Bytes, depth: usize) -> Option<CallOutcome> {
        let aimed = inputs.target_address != HEVM
            && self.expect_revert.as_ref().is_some_and(|e| e.depth == depth && e.caller == inputs.caller);
        self.top_calls.push(self.armed.len() == 1 && self.test_contract == Some(inputs.caller) && inputs.target_address != HEVM);
        self.armed.push(aimed);
        if inputs.target_address == CONSOLE {
            let line = self.console_line(input);
            self.console.push(line);
            return Some(outcome(inputs, InstructionResult::Return, Bytes::new()));
        }
        if inputs.target_address != HEVM {
            if let Some(p) = &self.prank {
                if p.depth == depth && inputs.caller == p.caller {
                    inputs.caller = p.sender;
                    // revm moves a call's value from its caller, which it loaded before this hook ran: load the
                    // pranked sender too, or a pranked call with value finds no account to debit.
                    let _ = revm::context::ContextTr::journal_mut(ctx).load_account(p.sender);
                    if let Some(o) = p.origin {
                        ctx.tx.caller = o;
                    }
                    if p.single {
                        self.prank = None;
                    }
                }
            }
            return self.mocked(inputs, input);
        }
        let answer = self.answer(ctx, inputs.caller, input, depth);
        Some(match answer {
            Answer::Ok(out) => outcome(inputs, InstructionResult::Return, out.into()),
            Answer::Revert(msg) => outcome(inputs, InstructionResult::Revert, error_string(&msg)),
        })
    }

    /// A mocked answer for this call, if a `mockCall` covers it: the longest matching calldata wins, as in forge.
    fn mocked(&mut self, inputs: &CallInputs, input: &Bytes) -> Option<CallOutcome> {
        let value = inputs.value.get();
        let m = self
            .mocks
            .iter_mut()
            .filter(|m| m.target == inputs.target_address && input.starts_with(&m.data) && m.value.is_none_or(|v| v == value))
            .max_by_key(|m| m.data.len())?;
        let out = if m.returns.len() > 1 { m.returns.remove(0) } else { m.returns[0].clone() };
        let result = if m.revert { InstructionResult::Revert } else { InstructionResult::Return };
        Some(outcome(inputs, result, out.into()))
    }

    /// A log, kept while `recordLogs()` is on.
    pub fn on_log(&mut self, log: &revm::primitives::Log) {
        if let Some(l) = &mut self.logs {
            l.push(log.clone());
        }
    }

    /// `record()`: a storage access by the code running at `address` (SSTORE counts as a read too, as in forge).
    pub fn storage_access(&mut self, address: Address, slot: U256, write: bool) {
        if let Some(r) = &mut self.recording {
            let e = r.entry(address).or_default();
            let slot = B256::from(slot);
            e.0.push(slot);
            if write {
                e.1.push(slot);
            }
        }
    }

    /// Before a create: prank the deployer.
    pub fn create(&mut self, inputs: &mut revm::interpreter::CreateInputs, depth: usize) {
        let aimed = self.expect_revert.as_ref().is_some_and(|e| e.depth == depth && e.caller == inputs.caller());
        self.top_calls.push(self.armed.len() == 1 && self.test_contract == Some(inputs.caller()));
        self.armed.push(aimed);
        if let Some(p) = &self.prank {
            if p.depth == depth && inputs.caller() == p.caller {
                inputs.set_call(p.sender);
                if p.single {
                    self.prank = None;
                }
            }
        }
    }

    /// After a call or create: settle an expectRevert aimed at it.
    /// Returns whether the frame was one of the test contract's own top-level calls: forge runs each of those as
    /// its own transaction, so transient storage is cleared after it (and kept within it).
    pub fn frame_end(&mut self, result: &mut InterpreterResult) -> bool {
        let top = self.top_calls.pop().unwrap_or(false);
        self.settle_expect_revert(result);
        top
    }

    fn settle_expect_revert(&mut self, result: &mut InterpreterResult) {
        if !self.armed.pop().unwrap_or(false) {
            return;
        }
        let Some(e) = self.expect_revert.take() else { return };
        let reverted = !result.result.is_ok();
        // As in forge: the data matches as bytes, or a reason string given as bytes matches an Error(string).
        let data_ok = e.data.as_ref().is_none_or(|d| result.output.starts_with(d) || error_message(&result.output).is_some_and(|m| m.as_bytes() == &d[..]));
        if reverted && data_ok {
            // forge answers a matched expectRevert with 8192 zero bytes, so the caller's ABI decoder finds a value
            // of any return type (an empty output would make `manager.initialize(...)`'s int24 fail to decode).
            result.result = InstructionResult::Return;
            result.output = Bytes::from(vec![0u8; 8192]);
        } else {
            result.result = InstructionResult::Revert;
            let hexs = |b: &[u8]| format!("0x{}", revm::primitives::hex::encode(&b[..b.len().min(100)]));
            result.output = error_string(&if reverted {
                format!(
                    "sol-debug: call reverted with different data than expectRevert wanted (got {}, wanted {})",
                    hexs(&result.output),
                    e.data.as_deref().map(|d| hexs(d)).unwrap_or_default()
                )
            } else {
                "sol-debug: call did not revert as expected".to_string()
            });
        }
    }

    fn answer(&mut self, ctx: &mut Ctx, caller: Address, input: &Bytes, depth: usize) -> Answer {
        if input.len() < 4 {
            return Answer::Revert("sol-debug: empty cheatcode call".into());
        }
        let sel: [u8; 4] = input[..4].try_into().unwrap();
        let Some(&sig) = self.signatures.get(&sel) else {
            let s = format!("0x{}", revm::primitives::hex::encode(sel));
            self.missing.push(s.clone());
            return Answer::Revert(format!("sol-debug: unsupported cheatcode {s}"));
        };
        let params = &sig[sig.find('(').unwrap()..];
        let args = match DynSolType::parse(params).and_then(|t| t.abi_decode_params(&input[4..])) {
            Ok(DynSolValue::Tuple(v)) => v,
            _ => return Answer::Revert(format!("sol-debug: can't decode {sig}")),
        };
        let name = &sig[..sig.find('(').unwrap()];
        let addr = |i: usize| args[i].as_address().unwrap_or_default();
        let uint = |i: usize| args[i].as_uint().map(|(u, _)| u).unwrap_or_default();
        let text = |i: usize| args[i].as_str().unwrap_or_default().to_string();
        let word = |v: &DynSolValue| match v {
            DynSolValue::FixedBytes(b, _) => U256::from_be_bytes(b.0),
            DynSolValue::Uint(u, _) => *u,
            _ => U256::ZERO,
        };
        match name {
            n if n.starts_with("env") => {
                let key = text(0);
                let value = self.env(&key);
                if n == "envExists" {
                    return Answer::Ok(DynSolValue::Bool(value.is_some()).abi_encode());
                }
                let ty = match n {
                    "envOr" => sig[sig.find(',').unwrap() + 1..sig.len() - 1].to_string(),
                    "envAddress" => "address".into(),
                    "envUint" => "uint256".into(),
                    "envInt" => "int256".into(),
                    "envBool" => "bool".into(),
                    "envBytes32" => "bytes32".into(),
                    "envString" => "string".into(),
                    _ => "bytes".into(),
                };
                match value {
                    Some(v) => match parse_env(&ty, &v) {
                        Some(val) => Answer::Ok(val.abi_encode_params()),
                        None => Answer::Revert(format!("sol-debug: environment variable {key:?} isn't a valid {ty}")),
                    },
                    None if n == "envOr" => Answer::Ok(args[1].abi_encode_params()),
                    None => Answer::Revert(format!("sol-debug: environment variable {key:?} not found (set it in the project's .env)")),
                }
            }
            // Broadcasting is a prank: calls (and creates) from the script come from the key's address.
            "startBroadcast" | "broadcast" => {
                let sender = match args.first() {
                    Some(DynSolValue::Address(a)) => *a,
                    Some(DynSolValue::Uint(pk, _)) => match signing_key(*pk) {
                        Some(k) => key_address(&k),
                        None => return Answer::Revert("sol-debug: broadcast: bad private key".into()),
                    },
                    _ => DEFAULT_SENDER,
                };
                self.prank = Some(Prank { sender, origin: Some(sender), caller, depth, single: name == "broadcast" });
                Answer::Ok(vec![])
            }
            "stopBroadcast" => {
                self.prank = None;
                Answer::Ok(vec![])
            }
            "toString" => {
                let out = match &args[0] {
                    DynSolValue::Address(a) => a.to_checksum(None),
                    DynSolValue::Uint(u, _) => u.to_string(),
                    DynSolValue::Int(i, _) => i.to_string(),
                    DynSolValue::Bool(b) => b.to_string(),
                    other => format!("0x{}", revm::primitives::hex::encode(other.abi_encode_packed())),
                };
                Answer::Ok(DynSolValue::String(out).abi_encode_params())
            }
            "projectRoot" => Answer::Ok(DynSolValue::String(self.ffi_dir.display().to_string()).abi_encode_params()),
            "readFile" => {
                let path = text(0);
                let full = if path.starts_with('/') { std::path::PathBuf::from(&path) } else { self.ffi_dir.join(&path) };
                match std::fs::read_to_string(&full) {
                    Ok(t) => Answer::Ok(DynSolValue::String(t).abi_encode_params()),
                    Err(e) => Answer::Revert(format!("sol-debug: readFile {path}: {e}")),
                }
            }
            // Debugging never writes to the project.
            "writeFile" | "writeJson" | "createDir" => Answer::Ok(vec![]),
            n if n.starts_with("serialize") => {
                let (obj, key) = (text(0), text(1));
                let value = match &args[2] {
                    DynSolValue::String(s) => format!("{s:?}"),
                    DynSolValue::Bool(b) => b.to_string(),
                    DynSolValue::Uint(u, _) => u.to_string(),
                    DynSolValue::Int(i, _) => i.to_string(),
                    DynSolValue::Address(a) => format!("\"{}\"", a.to_checksum(None)),
                    other => format!("\"0x{}\"", revm::primitives::hex::encode(other.abi_encode_packed())),
                };
                let fields = self.json.entry(obj).or_default();
                fields.retain(|(k, _)| *k != key);
                fields.push((key, value));
                let out = format!("{{{}}}", fields.iter().map(|(k, v)| format!("{k:?}:{v}")).collect::<Vec<_>>().join(","));
                Answer::Ok(DynSolValue::String(out).abi_encode_params())
            }
            // A value at a key path (`.contracts.AsyncSwap.address`) in a JSON string, read as the type asked for.
            n if n.starts_with("parseJson") || n.starts_with("keyExists") => {
                let (json, key) = (text(0), text(1));
                let found = serde_json::from_str::<serde_json::Value>(&json).ok().and_then(|v| json_at(&v, &key).cloned());
                if n.starts_with("keyExists") {
                    return Answer::Ok(DynSolValue::Bool(found.is_some()).abi_encode());
                }
                let Some(v) = found else { return Answer::Revert(format!("sol-debug: {n}: no key {key:?}")) };
                let raw = match &v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                let ty = match n {
                    "parseJsonAddress" => "address",
                    "parseJsonUint" => "uint256",
                    "parseJsonInt" => "int256",
                    "parseJsonBool" => "bool",
                    "parseJsonBytes32" => "bytes32",
                    "parseJsonString" => "string",
                    _ => "bytes",
                };
                match parse_env(ty, &raw) {
                    Some(val) => Answer::Ok(val.abi_encode_params()),
                    None => Answer::Revert(format!("sol-debug: {n}: {key:?} isn't a valid {ty}")),
                }
            }
            // Logs aren't kept: an empty list.
            // Vm.Log[]: (bytes32[] topics, bytes data, address emitter), and the recording starts over.
            "getRecordedLogs" => {
                let logs = self.logs.as_mut().map(std::mem::take).unwrap_or_default();
                let list = logs
                    .into_iter()
                    .map(|l| {
                        DynSolValue::Tuple(vec![
                            DynSolValue::Array(l.topics().iter().map(|t| DynSolValue::FixedBytes(*t, 32)).collect()),
                            DynSolValue::Bytes(l.data.data.to_vec()),
                            DynSolValue::Address(l.address),
                        ])
                    })
                    .collect();
                Answer::Ok(DynSolValue::Tuple(vec![DynSolValue::Array(list)]).abi_encode_params())
            }
            "recordLogs" => {
                self.logs = Some(vec![]);
                Answer::Ok(vec![])
            }
            "prank" | "startPrank" => {
                self.prank = Some(Prank {
                    sender: addr(0),
                    origin: (args.len() > 1).then(|| addr(1)),
                    caller,
                    depth,
                    single: name == "prank",
                });
                Answer::Ok(vec![])
            }
            "stopPrank" => {
                self.prank = None;
                Answer::Ok(vec![])
            }
            "deal" => {
                let Ok(mut acc) = ctx.journaled_state.load_account_mut(addr(0));
                acc.set_balance(uint(1));
                Answer::Ok(vec![])
            }
            "etch" => {
                let code = args[1].as_bytes().unwrap_or_default().to_vec();
                let _ = ctx.journaled_state.load_account(addr(0));
                ctx.journaled_state.set_code(addr(0), Bytecode::new_raw(code.into()));
                Answer::Ok(vec![])
            }
            "getCode" => {
                let what = args[0].as_str().unwrap_or("");
                match self.code.get(what) {
                    Some(code) => Answer::Ok(DynSolValue::Bytes(code.clone()).abi_encode()),
                    None => Answer::Revert(format!("sol-debug: getCode: no compiled contract {what:?} (compile the file that imports it)")),
                }
            }
            "store" => {
                let (a, slot, v) = (addr(0), word(&args[1]), word(&args[2]));
                let _ = ctx.journaled_state.load_account(a);
                let _ = ctx.journaled_state.sstore(a, slot, v);
                Answer::Ok(vec![])
            }
            "load" => {
                let a = addr(0);
                let _ = ctx.journaled_state.load_account(a);
                let v = ctx.journaled_state.sload(a, word(&args[1])).map(|l| l.data).unwrap_or_default();
                Answer::Ok(DynSolValue::FixedBytes(B256::from(v), 32).abi_encode())
            }
            "record" => {
                self.recording = Some(HashMap::new());
                Answer::Ok(vec![])
            }
            "accesses" => {
                let (reads, writes) = self.recording.as_ref().and_then(|r| r.get(&addr(0)).cloned()).unwrap_or_default();
                let list = |v: Vec<B256>| DynSolValue::Array(v.into_iter().map(|b| DynSolValue::FixedBytes(b, 32)).collect());
                Answer::Ok(DynSolValue::Tuple(vec![list(reads), list(writes)]).abi_encode_params())
            }
            "mockCall" | "mockCallRevert" | "mockCalls" => {
                let with_value = matches!(args.len(), 4);
                let at = |i: usize| if with_value { i + 1 } else { i };
                let data = args[at(1)].as_bytes().unwrap_or_default().to_vec();
                let returns = match &args[at(2)] {
                    DynSolValue::Array(v) => v.iter().map(|b| b.as_bytes().unwrap_or_default().to_vec()).collect(),
                    b => vec![b.as_bytes().unwrap_or_default().to_vec()],
                };
                let value = with_value.then(|| uint(1));
                let m = Mock { target: addr(0), value, data, returns, revert: name == "mockCallRevert" };
                // A newer mock of the same call replaces the older one.
                self.mocks.retain(|o| !(o.target == m.target && o.data == m.data && o.value == m.value));
                self.mocks.push(m);
                Answer::Ok(vec![])
            }
            "clearMockedCalls" => {
                self.mocks.clear();
                Answer::Ok(vec![])
            }
            "chainId" => {
                ctx.cfg.chain_id = uint(0).saturating_to();
                Answer::Ok(vec![])
            }
            "snapshotState" => {
                let j = &ctx.journaled_state.inner;
                self.states.push(Some((j.state.clone(), j.transient_storage.clone(), ctx.block.clone())));
                Answer::Ok(DynSolValue::Uint(U256::from(self.states.len() - 1), 256).abi_encode())
            }
            "revertToState" | "revertToStateAndDelete" | "deleteStateSnapshot" => {
                let id = uint(0).saturating_to::<usize>();
                let Some(Some((state, transient, block))) = self.states.get(id).cloned() else {
                    return Answer::Ok(DynSolValue::Bool(false).abi_encode());
                };
                if name != "deleteStateSnapshot" {
                    restore_state(ctx, state);
                    ctx.journaled_state.inner.transient_storage = transient;
                    ctx.block = block;
                }
                if name != "revertToState" {
                    self.states[id] = None;
                }
                Answer::Ok(DynSolValue::Bool(true).abi_encode())
            }
            "expectCall" => {
                self.unchecked_expect_calls += 1;
                Answer::Ok(vec![])
            }
            "getDeployedCode" => match self.deployed.get(args[0].as_str().unwrap_or("")) {
                Some(code) => Answer::Ok(DynSolValue::Bytes(code.clone()).abi_encode()),
                None => Answer::Revert(format!("sol-debug: getDeployedCode: no contract {}", text(0))),
            },
            "getNonce" => {
                let nonce = ctx.journaled_state.load_account(addr(0)).map(|a| a.data.info.nonce).unwrap_or(0);
                Answer::Ok(DynSolValue::Uint(U256::from(nonce), 64).abi_encode())
            }
            "computeCreateAddress" => Answer::Ok(DynSolValue::Address(addr(0).create(uint(1).saturating_to())).abi_encode()),
            // Gas and dumps only.
            "cool" | "coolSlot" | "dumpState" => Answer::Ok(vec![]),
            "createFork" | "selectFork" => Answer::Revert("sol-debug: createFork inside a test isn't supported (run on a fork)".into()),
            "warp" => {
                ctx.block.timestamp = uint(0);
                Answer::Ok(vec![])
            }
            "roll" => {
                ctx.block.number = uint(0);
                Answer::Ok(vec![])
            }
            "addr" => match signing_key(uint(0)) {
                Some(k) => Answer::Ok(DynSolValue::Address(key_address(&k)).abi_encode()),
                None => Answer::Revert("sol-debug: addr: bad private key".into()),
            },
            "sign" => {
                let (Some(k), Some(digest)) = (signing_key(uint(0)), args[1].as_fixed_bytes().map(|(b, _)| B256::from_slice(b))) else {
                    return Answer::Revert("sol-debug: sign: bad private key".into());
                };
                match k.sign_prehash_recoverable(digest.as_slice()) {
                    Ok((sig, rec)) => {
                        let bytes = sig.to_bytes();
                        Answer::Ok(
                            DynSolValue::Tuple(vec![
                                DynSolValue::Uint(U256::from(27 + rec.to_byte()), 8),
                                DynSolValue::FixedBytes(B256::from_slice(&bytes[..32]), 32),
                                DynSolValue::FixedBytes(B256::from_slice(&bytes[32..]), 32),
                            ])
                            .abi_encode_params(),
                        )
                    }
                    Err(e) => Answer::Revert(format!("sol-debug: sign: {e}")),
                }
            }
            "label" => {
                self.labels.insert(addr(0), args[1].as_str().unwrap_or("").to_string());
                Answer::Ok(vec![])
            }
            "assume" => {
                if args[0].as_bool() == Some(true) {
                    Answer::Ok(vec![])
                } else {
                    Answer::Revert("sol-debug: vm.assume rejected the inputs".into())
                }
            }
            "expectRevert" => {
                let data = args.first().map(|v| match v {
                    DynSolValue::FixedBytes(b, n) => Bytes::copy_from_slice(&b[..*n]),
                    other => Bytes::from(other.as_bytes().unwrap_or_default().to_vec()),
                });
                self.expect_revert = Some(ExpectRevert { data, caller, depth });
                Answer::Ok(vec![])
            }
            "expectEmit" => Answer::Ok(vec![]),
            "ffi" | "tryFfi" => {
                let argv: Vec<String> = args[0].as_array().unwrap_or_default().iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
                match self.ffi(&argv) {
                    Err(e) => Answer::Revert(e),
                    Ok((code, out, err)) if name == "ffi" => {
                        if code != 0 {
                            Answer::Revert(format!("ffi: {} exited with {code}: {}", argv[0], String::from_utf8_lossy(&err)))
                        } else {
                            Answer::Ok(DynSolValue::Bytes(out).abi_encode())
                        }
                    }
                    Ok((code, out, err)) => Answer::Ok(
                        DynSolValue::Tuple(vec![DynSolValue::Tuple(vec![
                            DynSolValue::Int(revm::primitives::I256::try_from(code).unwrap_or_default(), 32),
                            DynSolValue::Bytes(out),
                            DynSolValue::Bytes(err),
                        ])])
                        .abi_encode_params(),
                    ),
                }
            }
            n if n.starts_with("assert") => assert(n, &args),
            _ => Answer::Revert(format!("sol-debug: unsupported cheatcode {sig}")),
        }
    }
}

impl Cheats {
    /// Runs an allowed program like forge's ffi: stdout that is hex (with or without 0x) comes back decoded.
    fn ffi(&mut self, argv: &[String]) -> Result<(i32, Vec<u8>, Vec<u8>), String> {
        let Some(program) = argv.first() else { return Err("ffi: empty command".into()) };
        if !self.ffi_allow.iter().any(|p| p == program) {
            return Err(format!("sol-debug: ffi refused {program:?}; allowed: {:?}", self.ffi_allow));
        }
        if let Some(hit) = self.ffi_cache.get(argv) {
            return Ok(hit.clone());
        }
        let out = std::process::Command::new(find_program(program))
            .args(&argv[1..])
            .current_dir(&self.ffi_dir)
            .output()
            .map_err(|e| format!("ffi: can't run {program}: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let hex = text.strip_prefix("0x").unwrap_or(&text);
        let stdout = if !hex.is_empty() && hex.len().is_multiple_of(2) && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            revm::primitives::hex::decode(hex).unwrap_or_default()
        } else {
            out.stdout.clone()
        };
        if out.status.success() {
            if let Some(file) = argv.iter().skip(1).find(|a| !a.starts_with('-')) {
                self.compiled.push((file.clone(), stdout.clone()));
            }
        }
        let result = (out.status.code().unwrap_or(-1), stdout, out.stderr);
        self.ffi_cache.insert(argv.to_vec(), result.clone());
        Ok(result)
    }
}

/// A program on PATH, or in the usual per-user install folders (`~/.huff-neo/bin` for hnc).
fn find_program(name: &str) -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for d in [".huff-neo/bin", ".huff/bin", ".cargo/bin", ".foundry/bin"] {
        dirs.push(std::path::Path::new(&home).join(d));
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file()).unwrap_or_else(|| name.into())
}

fn assert(name: &str, args: &[DynSolValue]) -> Answer {
    let operands = match name {
        "assertTrue" | "assertFalse" => 1,
        "assertApproxEqAbs" | "assertApproxEqRel" => 3,
        _ => 2,
    };
    let msg = args.get(operands).and_then(|m| m.as_str()).map(|m| format!("{m}: ")).unwrap_or_default();
    let show = |v: &DynSolValue| match v {
        DynSolValue::Uint(u, _) => u.to_string(),
        DynSolValue::Int(i, _) => i.to_string(),
        DynSolValue::Address(a) => a.to_checksum(None),
        DynSolValue::Bool(b) => b.to_string(),
        DynSolValue::String(s) => format!("{s:?}"),
        other => format!("0x{}", revm::primitives::hex::encode(other.abi_encode_packed())),
    };
    let ord = |a: &DynSolValue, b: &DynSolValue| match (a, b) {
        (DynSolValue::Uint(x, _), DynSolValue::Uint(y, _)) => x.cmp(y),
        (DynSolValue::Int(x, _), DynSolValue::Int(y, _)) => x.cmp(y),
        _ => std::cmp::Ordering::Equal,
    };
    let (ok, why) = match name {
        "assertTrue" => (args[0].as_bool() == Some(true), "expected true".to_string()),
        "assertFalse" => (args[0].as_bool() == Some(false), "expected false".to_string()),
        "assertEq" => (args[0] == args[1], format!("{} != {}", show(&args[0]), show(&args[1]))),
        "assertNotEq" => (args[0] != args[1], format!("both {}", show(&args[0]))),
        "assertGt" => (ord(&args[0], &args[1]).is_gt(), format!("{} <= {}", show(&args[0]), show(&args[1]))),
        "assertGe" => (ord(&args[0], &args[1]).is_ge(), format!("{} < {}", show(&args[0]), show(&args[1]))),
        "assertLt" => (ord(&args[0], &args[1]).is_lt(), format!("{} >= {}", show(&args[0]), show(&args[1]))),
        "assertLe" => (ord(&args[0], &args[1]).is_le(), format!("{} > {}", show(&args[0]), show(&args[1]))),
        "assertApproxEqAbs" | "assertApproxEqRel" => {
            let (a, b, max) = (args[0].as_uint().unwrap().0, args[1].as_uint().unwrap().0, args[2].as_uint().unwrap().0);
            let delta = if a > b { a - b } else { b - a };
            let within = if name == "assertApproxEqAbs" {
                delta <= max
            } else {
                b.is_zero() && a.is_zero() || !b.is_zero() && delta * U256::from(10).pow(U256::from(18)) / b <= max
            };
            (within, format!("{a} vs {b}, off by {delta} (max {max})"))
        }
        _ => (true, String::new()),
    };
    if ok {
        Answer::Ok(vec![])
    } else {
        Answer::Revert(format!("{msg}assertion failed: {why}"))
    }
}

fn outcome(inputs: &CallInputs, result: InstructionResult, output: Bytes) -> CallOutcome {
    CallOutcome::new(InterpreterResult::new(result, output, Gas::new(inputs.gas_limit)), inputs.return_memory_offset.clone())
}

/// `revertToState` inside a transaction. revm still holds undo entries for the frames that are open, and they name
/// accounts and slots loaded after the snapshot, so the state map isn't swapped: every account and slot stays, with
/// the value it had at the snapshot. One loaded after it had the committed value then (its original value, or the
/// database's account).
fn restore_state(ctx: &mut Ctx, snap: revm::state::EvmState) {
    use revm::DatabaseRef;
    let db = &ctx.journaled_state.database;
    for (addr, acc) in ctx.journaled_state.inner.state.iter_mut() {
        match snap.get(addr) {
            Some(then) => {
                acc.info = then.info.clone();
                for (key, slot) in acc.storage.iter_mut() {
                    slot.present_value = then.storage.get(key).map_or(slot.original_value, |s| s.present_value);
                }
            }
            None => {
                // An account the database doesn't have is the empty account.
                acc.info = db.basic_ref(*addr).ok().flatten().unwrap_or_default();
                for slot in acc.storage.values_mut() {
                    slot.present_value = slot.original_value;
                }
            }
        }
    }
    for (addr, then) in snap {
        let state = &mut ctx.journaled_state.inner.state;
        let acc = state.entry(addr).or_insert_with(|| then.clone());
        for (key, slot) in then.storage {
            acc.storage.entry(key).or_insert(slot);
        }
    }
}

/// The message of `Error(string)` revert data.
fn error_message(data: &[u8]) -> Option<String> {
    if data.len() < 4 || data[..4] != keccak256("Error(string)".as_bytes())[..4] {
        return None;
    }
    match DynSolType::Tuple(vec![DynSolType::String]).abi_decode_params(&data[4..]).ok()? {
        DynSolValue::Tuple(v) => v.first()?.as_str().map(str::to_string),
        _ => None,
    }
}

/// `Error(string)` revert data.
pub fn error_string(msg: &str) -> Bytes {
    let mut out = keccak256("Error(string)".as_bytes())[..4].to_vec();
    out.extend(DynSolValue::Tuple(vec![DynSolValue::String(msg.to_string())]).abi_encode_params());
    out.into()
}

fn signing_key(pk: U256) -> Option<k256::ecdsa::SigningKey> {
    k256::ecdsa::SigningKey::from_slice(&pk.to_be_bytes::<32>()).ok()
}

fn key_address(k: &k256::ecdsa::SigningKey) -> Address {
    let point = k.verifying_key().to_encoded_point(false);
    Address::from_slice(&keccak256(&point.as_bytes()[1..])[12..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addr_matches_foundry() {
        // makeAddr("alice") in forge-std: the key is keccak256("alice").
        let pk = U256::from_be_bytes(keccak256("alice".as_bytes()).0);
        assert_eq!(key_address(&signing_key(pk).unwrap()), address!("328809Bc894f92807417D2dAD6b7C998c1aFdac6"));
    }
}

/// Foundry's default sender: who a script runs as, and who broadcasts without a key.
const DEFAULT_SENDER: Address = address!("1804c8AB1F12E6bbf3894d4083f33e07309d1f38");

impl Cheats {
    /// An environment variable: the process's, else the project's `.env` (as Foundry loads it).
    fn env(&mut self, key: &str) -> Option<String> {
        if let Ok(v) = std::env::var(key) {
            return Some(v);
        }
        let root = self.ffi_dir.clone();
        let file = self.dotenv.get_or_insert_with(|| {
            let text = std::fs::read_to_string(root.join(".env")).unwrap_or_default();
            text.lines()
                .filter_map(|l| {
                    let l = l.trim();
                    let l = l.strip_prefix("export ").unwrap_or(l);
                    if l.starts_with('#') {
                        return None;
                    }
                    let (k, v) = l.split_once('=')?;
                    let v = v.trim();
                    let v = v.strip_prefix('"').and_then(|v| v.strip_suffix('"')).or_else(|| v.strip_prefix('\'').and_then(|v| v.strip_suffix('\''))).unwrap_or(v);
                    Some((k.trim().to_string(), v.to_string()))
                })
                .collect()
        });
        file.get(key).cloned()
    }
}

/// An environment value read as a Solidity type, the way Foundry parses it.
fn parse_env(ty: &str, v: &str) -> Option<DynSolValue> {
    let v = v.trim();
    let hex = |s: &str| revm::primitives::hex::decode(s.trim_start_matches("0x")).ok();
    Some(match ty {
        "address" => DynSolValue::Address(v.parse().ok()?),
        "uint256" => DynSolValue::Uint(if let Some(h) = v.strip_prefix("0x") { U256::from_str_radix(h, 16).ok()? } else { v.parse().ok()? }, 256),
        "int256" => DynSolValue::Int(v.parse().ok()?, 256),
        "bool" => DynSolValue::Bool(match v.to_ascii_lowercase().as_str() {
            "true" | "1" => true,
            "false" | "0" => false,
            _ => return None,
        }),
        "bytes32" => {
            let b = hex(v)?;
            if b.len() > 32 {
                return None;
            }
            let mut w = [0u8; 32];
            w[..b.len()].copy_from_slice(&b);
            DynSolValue::FixedBytes(B256::from(w), 32)
        }
        "string" => DynSolValue::String(v.to_string()),
        _ => DynSolValue::Bytes(hex(v)?),
    })
}

/// The value at a jq-style key path: `.a.b`, `$.a.b`, `.list[0]`, `.` for the whole document.
fn json_at<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    let path = key.trim_start_matches('$');
    let mut at = v;
    for part in path.split('.').filter(|p| !p.is_empty()) {
        let (name, rest) = part.split_once('[').map_or((part, ""), |(n, r)| (n, r));
        if !name.is_empty() {
            at = at.get(name)?;
        }
        for idx in rest.split('[').filter(|s| !s.is_empty()) {
            at = at.get(idx.trim_end_matches(']').parse::<usize>().ok()?)?;
        }
    }
    Some(at)
}

/// forge-std's console.log signatures (and hardhat's older `uint`/`int` spellings), by selector.
fn console_signatures() -> HashMap<[u8; 4], String> {
    let mut sigs = vec!["log()".to_string()];
    for t in ["string", "uint256", "int256", "address", "bool", "bytes32", "bytes", "uint", "int"] {
        sigs.push(format!("log({t})"));
    }
    for (name, t) in [("logString", "string"), ("logUint", "uint256"), ("logInt", "int256"), ("logAddress", "address"), ("logBool", "bool"), ("logBytes", "bytes"), ("logBytes32", "bytes32")] {
        sigs.push(format!("{name}({t})"));
    }
    for uint in ["uint256", "uint"] {
        let base = ["string", uint, "address", "bool"];
        for a in base {
            for b in base {
                sigs.push(format!("log({a},{b})"));
                for c in base {
                    sigs.push(format!("log({a},{b},{c})"));
                    for d in base {
                        sigs.push(format!("log({a},{b},{c},{d})"));
                    }
                }
            }
        }
    }
    sigs.into_iter().map(|s| (keccak256(s.as_bytes())[..4].try_into().unwrap(), s)).collect()
}
