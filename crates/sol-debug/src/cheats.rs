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
    /// `prank(…, true)`: the prank applies to a DELEGATECALL the caller makes.
    delegate: bool,
    /// tx.origin before the prank changed it, restored when the prank ends.
    prior_origin: Option<Address>,
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
    /// The open frame that called expectRevert (an index into the frame stack): if it reverts itself, that is the
    /// expected revert too.
    frame: usize,
}

impl ExpectRevert {
    /// As in forge: the data matches as bytes, or a reason string given as bytes matches an Error(string).
    fn matches(&self, output: &[u8]) -> bool {
        self.data.as_ref().is_none_or(|d| output.starts_with(d) || error_message(output).is_some_and(|m| m.as_bytes() == &d[..]))
    }
}

/// What the inspector does when a frame ends, for the cheatcodes.
pub struct FrameEnd {
    /// The frame was one of the test contract's own top-level calls (forge clears transient storage after each).
    pub clear_transient: bool,
    /// A single prank set tx.origin for this call: put it back.
    pub restore_origin: Option<Address>,
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
    origin_restore: Vec<Option<Address>>,
    /// Folders a test may write to (foundry.toml's read-write `fs_permissions`, absolute). Empty: writes are
    /// skipped.
    pub writable: Vec<std::path::PathBuf>,
    /// `recordLogs()`: the logs emitted since, until `getRecordedLogs` takes them.
    logs: Option<Vec<revm::primitives::Log>>,
    /// `setEnv`: variables set by the test, read before the process's.
    env_set: HashMap<String, String>,
    /// `_expectCheatcodeRevert`: the next cheatcode call must revert (with these bytes, when given).
    expect_cheat_revert: Option<Option<Vec<u8>>>,
    /// The `random*` cheatcodes' generator (`setSeed` resets it).
    rng: Option<u64>,
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
    "assertApproxEqAbs(int256,int256,uint256)",
    "assertApproxEqAbs(int256,int256,uint256,string)",
    "assertApproxEqAbsDecimal(int256,int256,uint256,uint256)",
    "assertApproxEqAbsDecimal(int256,int256,uint256,uint256,string)",
    "assertApproxEqAbsDecimal(uint256,uint256,uint256,uint256)",
    "assertApproxEqAbsDecimal(uint256,uint256,uint256,uint256,string)",
    "assertApproxEqRel(int256,int256,uint256)",
    "assertApproxEqRel(int256,int256,uint256,string)",
    "assertApproxEqRelDecimal(int256,int256,uint256,uint256)",
    "assertApproxEqRelDecimal(int256,int256,uint256,uint256,string)",
    "assertApproxEqRelDecimal(uint256,uint256,uint256,uint256)",
    "assertApproxEqRelDecimal(uint256,uint256,uint256,uint256,string)",
    "assertEq(address[],address[])",
    "assertEq(address[],address[],string)",
    "assertEq(bool[],bool[])",
    "assertEq(bool[],bool[],string)",
    "assertEq(bytes32[],bytes32[])",
    "assertEq(bytes32[],bytes32[],string)",
    "assertEq(bytes[],bytes[])",
    "assertEq(bytes[],bytes[],string)",
    "assertEq(int256[],int256[])",
    "assertEq(int256[],int256[],string)",
    "assertEq(string[],string[])",
    "assertEq(string[],string[],string)",
    "assertEq(uint256[],uint256[])",
    "assertEq(uint256[],uint256[],string)",
    "assertEqDecimal(int256,int256,uint256)",
    "assertEqDecimal(int256,int256,uint256,string)",
    "assertEqDecimal(uint256,uint256,uint256)",
    "assertEqDecimal(uint256,uint256,uint256,string)",
    "assertGe(int256,int256)",
    "assertGe(int256,int256,string)",
    "assertGeDecimal(int256,int256,uint256)",
    "assertGeDecimal(int256,int256,uint256,string)",
    "assertGeDecimal(uint256,uint256,uint256)",
    "assertGeDecimal(uint256,uint256,uint256,string)",
    "assertGtDecimal(int256,int256,uint256)",
    "assertGtDecimal(int256,int256,uint256,string)",
    "assertGtDecimal(uint256,uint256,uint256)",
    "assertGtDecimal(uint256,uint256,uint256,string)",
    "assertLe(int256,int256)",
    "assertLe(int256,int256,string)",
    "assertLeDecimal(int256,int256,uint256)",
    "assertLeDecimal(int256,int256,uint256,string)",
    "assertLeDecimal(uint256,uint256,uint256)",
    "assertLeDecimal(uint256,uint256,uint256,string)",
    "assertLtDecimal(int256,int256,uint256)",
    "assertLtDecimal(int256,int256,uint256,string)",
    "assertLtDecimal(uint256,uint256,uint256)",
    "assertLtDecimal(uint256,uint256,uint256,string)",
    "assertNotEq(address[],address[])",
    "assertNotEq(address[],address[],string)",
    "assertNotEq(bool,bool)",
    "assertNotEq(bool,bool,string)",
    "assertNotEq(bool[],bool[])",
    "assertNotEq(bool[],bool[],string)",
    "assertNotEq(bytes,bytes)",
    "assertNotEq(bytes,bytes,string)",
    "assertNotEq(bytes32[],bytes32[])",
    "assertNotEq(bytes32[],bytes32[],string)",
    "assertNotEq(bytes[],bytes[])",
    "assertNotEq(bytes[],bytes[],string)",
    "assertNotEq(int256,int256)",
    "assertNotEq(int256,int256,string)",
    "assertNotEq(int256[],int256[])",
    "assertNotEq(int256[],int256[],string)",
    "assertNotEq(string,string)",
    "assertNotEq(string,string,string)",
    "assertNotEq(string[],string[])",
    "assertNotEq(string[],string[],string)",
    "assertNotEq(uint256[],uint256[])",
    "assertNotEq(uint256[],uint256[],string)",
    "assertNotEqDecimal(int256,int256,uint256)",
    "assertNotEqDecimal(int256,int256,uint256,string)",
    "assertNotEqDecimal(uint256,uint256,uint256)",
    "assertNotEqDecimal(uint256,uint256,uint256,string)",
    "setEnv(string,string)",
    "_expectCheatcodeRevert()",
    "_expectCheatcodeRevert(bytes)",
    "_expectCheatcodeRevert(bytes4)",
    "expectSafeMemory(uint64,uint64)",
    "expectSafeMemoryCall(uint64,uint64)",
    "stopExpectSafeMemory()",
    "skip(bool)",
    "skip(bool,string)",
    "fee(uint256)",
    "txGasPrice(uint256)",
    "prevrandao(uint256)",
    "prevrandao(bytes32)",
    "difficulty(uint256)",
    "coinbase(address)",
    "getBlockTimestamp()",
    "getBlockNumber()",
    "readCallers()",
    "setNonce(address,uint64)",
    "setNonceUnsafe(address,uint64)",
    "resetNonce(address)",
    "createWallet(uint256)",
    "createWallet(string)",
    "createWallet(uint256,string)",
    "setSeed(uint256)",
    "randomUint()",
    "randomUint(uint256)",
    "randomUint(uint256,uint256)",
    "randomInt()",
    "randomInt(uint256)",
    "randomAddress()",
    "randomBool()",
    "randomBytes(uint256)",
    "randomBytes4()",
    "randomBytes8()",
    "snapshot()",
    "revertTo(uint256)",
    "revertToAndDelete(uint256)",
    "deleteSnapshot(uint256)",
    "deleteSnapshots()",
    "deleteStateSnapshots()",
    "getLabel(address)",
    "pauseGasMetering()",
    "resumeGasMetering()",
    "resetGasMetering()",
    "computeCreate2Address(bytes32,bytes32,address)",
    "computeCreate2Address(bytes32,bytes32)",
    "parseUint(string)",
    "parseInt(string)",
    "parseBool(string)",
    "parseAddress(string)",
    "parseBytes32(string)",
    "parseBytes(string)",
    "prank(address,bool)",
    "prank(address,address,bool)",
    "startPrank(address,bool)",
    "startPrank(address,address,bool)",
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
        self.origin_restore.push(None);
        self.armed.push(aimed);
        if inputs.target_address == CONSOLE {
            let line = self.console_line(input);
            self.console.push(line);
            return Some(outcome(inputs, InstructionResult::Return, Bytes::new()));
        }
        if inputs.target_address != HEVM {
            if let Some(p) = &mut self.prank {
                let delegated = p.delegate && inputs.scheme == revm::interpreter::CallScheme::DelegateCall && inputs.target_address == p.caller;
                if p.depth == depth && (inputs.caller == p.caller || delegated) {
                    inputs.caller = p.sender;
                    // revm moves a call's value from its caller, which it loaded before this hook ran: load the
                    // pranked sender too, or a pranked call with value finds no account to debit.
                    let _ = revm::context::ContextTr::journal_mut(ctx).load_account(p.sender);
                    if let Some(o) = p.origin {
                        p.prior_origin.get_or_insert(ctx.tx.caller);
                        ctx.tx.caller = o;
                    }
                    if p.single {
                        // tx.origin comes back when this call ends.
                        if let Some(prior) = self.prank.take().and_then(|p| p.prior_origin) {
                            if let Some(last) = self.origin_restore.last_mut() {
                                *last = Some(prior);
                            }
                        }
                    }
                }
            }
            return self.mocked(inputs, input);
        }
        let expecting = self.expect_cheat_revert.take();
        let pending = self.expect_revert.as_ref().is_some_and(|e| e.depth == depth && e.caller == inputs.caller);
        let mut answer = self.answer(ctx, inputs.caller, input, depth);
        if pending && expecting.is_none() {
            if let Answer::Revert(msg) = &answer {
                let e = self.expect_revert.take().unwrap();
                answer = if e.matches(&error_string(msg)) { Answer::Ok(vec![]) } else { Answer::Revert(format!("Error != expected error: {msg}")) };
            }
        }
        if let Some(want) = expecting {
            // `_expectCheatcodeRevert` itself arms it again; any other cheatcode settles it.
            if self.expect_cheat_revert.is_none() {
                answer = match answer {
                    Answer::Revert(msg) => {
                        let data = error_string(&msg);
                        let ok = want.as_ref().is_none_or(|w| data.starts_with(w) || msg.as_bytes() == &w[..] || error_message(w).is_some_and(|m| m == msg));
                        if ok {
                            Answer::Ok(vec![])
                        } else {
                            Answer::Revert(format!("Error != expected error: {msg} != {}", want.as_ref().and_then(|w| error_message(w).or_else(|| String::from_utf8(w.clone()).ok())).unwrap_or_default()))
                        }
                    }
                    Answer::Ok(_) => Answer::Revert("next call did not revert as expected".into()),
                };
            } else {
                self.expect_cheat_revert = Some(want);
            }
        }
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
        self.origin_restore.push(None);
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
    pub fn frame_end(&mut self, result: &mut InterpreterResult) -> FrameEnd {
        let top = self.top_calls.pop().unwrap_or(false);
        let origin = self.origin_restore.pop().flatten();
        self.settle_expect_revert(result);
        FrameEnd { clear_transient: top, restore_origin: origin }
    }

    fn settle_expect_revert(&mut self, result: &mut InterpreterResult) {
        // The frame that called expectRevert reverting is the expected revert too (`vm.expectRevert(…); revert(…);`).
        let this = self.armed.len().saturating_sub(1);
        let own = self.expect_revert.as_ref().is_some_and(|e| e.frame == this) && !result.result.is_ok();
        if !self.armed.pop().unwrap_or(false) && !own {
            return;
        }
        let Some(e) = self.expect_revert.take() else { return };
        let reverted = !result.result.is_ok();
        // A halt matches as forge names it: `EvmError: OutOfGas`.
        let output = if reverted && !result.result.is_revert() {
            Bytes::from(format!("EvmError: {:?}", result.result).into_bytes())
        } else {
            result.output.clone()
        };
        let data_ok = e.matches(&output);
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
                self.prank = Some(Prank { sender, origin: Some(sender), delegate: false, prior_origin: None, caller, depth, single: name == "broadcast" });
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
            "writeFile" | "writeJson" | "createDir" => {
                if self.writable.is_empty() {
                    return Answer::Ok(vec![]);
                }
                // writeFile(path, data), writeJson(json, path), createDir(path, recursive).
                let (path, data) = match name {
                    "writeJson" => (text(1), text(0)),
                    "createDir" => (text(0), String::new()),
                    _ => (text(0), text(1)),
                };
                let full = self.ffi_dir.join(&path);
                let parent = full.parent().map(|p| p.to_path_buf()).unwrap_or_default();
                let inside = |p: &std::path::Path| {
                    let p = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
                    self.writable.iter().any(|w| p.starts_with(w))
                };
                if name == "createDir" {
                    if !inside(&full) && !inside(&parent) {
                        return Answer::Revert(format!("the path {path} is not allowed to be accessed for write operations"));
                    }
                    let _ = std::fs::create_dir_all(&full);
                    return Answer::Ok(vec![]);
                }
                if !inside(&parent) {
                    return Answer::Revert(format!("the path {path} is not allowed to be accessed for write operations"));
                }
                match std::fs::write(&full, data) {
                    Ok(()) => Answer::Ok(vec![]),
                    Err(e) => Answer::Revert(format!("sol-debug: {name} {path}: {e}")),
                }
            }
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
                    origin: args.get(1).and_then(|v| v.as_address()),
                    delegate: args.last().and_then(|v| v.as_bool()).unwrap_or(false),
                    prior_origin: None,
                    caller,
                    depth,
                    single: name == "prank",
                });
                Answer::Ok(vec![])
            }
            "stopPrank" => {
                if let Some(o) = self.prank.take().and_then(|p| p.prior_origin) {
                    ctx.tx.caller = o;
                }
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
                let what = artifact_name(args[0].as_str().unwrap_or(""));
                if what.ends_with(".json") {
                    return match artifact_file(&self.ffi_dir, &what, false) {
                        Some(code) => Answer::Ok(DynSolValue::Bytes(code).abi_encode()),
                        None => Answer::Revert(format!("sol-debug: getCode: no bytecode in {what}")),
                    };
                }
                match self.code.get(&what) {
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
            "snapshotState" | "snapshot" => {
                let j = &ctx.journaled_state.inner;
                self.states.push(Some((j.state.clone(), j.transient_storage.clone(), ctx.block.clone())));
                Answer::Ok(DynSolValue::Uint(U256::from(self.states.len() - 1), 256).abi_encode())
            }
            "deleteStateSnapshots" | "deleteSnapshots" => {
                self.states.iter_mut().for_each(|s| *s = None);
                Answer::Ok(vec![])
            }
            "revertToState" | "revertToStateAndDelete" | "deleteStateSnapshot" | "revertTo" | "revertToAndDelete" | "deleteSnapshot" => {
                let name = match name {
                    "revertTo" => "revertToState",
                    "revertToAndDelete" => "revertToStateAndDelete",
                    "deleteSnapshot" => "deleteStateSnapshot",
                    n => n,
                };
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
            "getDeployedCode" if artifact_name(args[0].as_str().unwrap_or("")).ends_with(".json") => {
                match artifact_file(&self.ffi_dir, &artifact_name(args[0].as_str().unwrap_or("")), true) {
                    Some(code) => Answer::Ok(DynSolValue::Bytes(code).abi_encode()),
                    None => Answer::Revert(format!("sol-debug: getDeployedCode: no bytecode in {}", text(0))),
                }
            }
            "getDeployedCode" => match self.deployed.get(&artifact_name(args[0].as_str().unwrap_or(""))) {
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
            "setEnv" => {
                self.env_set.insert(text(0), text(1));
                Answer::Ok(vec![])
            }
            "_expectCheatcodeRevert" => {
                self.expect_cheat_revert = Some(args.first().and_then(|a| match a {
                    DynSolValue::Bytes(b) => Some(b.clone()),
                    DynSolValue::FixedBytes(b, n) => Some(b[..*n].to_vec()),
                    _ => None,
                }));
                Answer::Ok(vec![])
            }
            // Memory-safety and gas-metering checks don't change what a test computes.
            "expectSafeMemory" | "expectSafeMemoryCall" | "stopExpectSafeMemory" | "pauseGasMetering" | "resumeGasMetering" | "resetGasMetering" => {
                Answer::Ok(vec![])
            }
            "skip" => {
                if args[0].as_bool() == Some(true) {
                    let why = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
                    Answer::Revert(format!("sol-debug: skip {why}"))
                } else {
                    Answer::Ok(vec![])
                }
            }
            "fee" => {
                ctx.block.basefee = uint(0).saturating_to();
                Answer::Ok(vec![])
            }
            "txGasPrice" => {
                ctx.tx.gas_price = uint(0).saturating_to();
                Answer::Ok(vec![])
            }
            "prevrandao" => {
                ctx.block.prevrandao = Some(B256::from(word(&args[0])));
                Answer::Ok(vec![])
            }
            "difficulty" => {
                ctx.block.difficulty = uint(0);
                Answer::Ok(vec![])
            }
            "coinbase" => {
                ctx.block.beneficiary = addr(0);
                Answer::Ok(vec![])
            }
            "getBlockTimestamp" => Answer::Ok(DynSolValue::Uint(ctx.block.timestamp, 256).abi_encode()),
            "getBlockNumber" => Answer::Ok(DynSolValue::Uint(ctx.block.number, 256).abi_encode()),
            // (CallerMode, msg.sender, tx.origin): None 0, Broadcast 1, RecurrentBroadcast 2, Prank 3, RecurrentPrank 4.
            "readCallers" => {
                let (mode, sender, origin) = match &self.prank {
                    Some(p) => (if p.single { 3u8 } else { 4 }, p.sender, p.origin.unwrap_or(ctx.tx.caller)),
                    None => (0, DEFAULT_SENDER, ctx.tx.caller),
                };
                Answer::Ok(DynSolValue::Tuple(vec![DynSolValue::Uint(U256::from(mode), 8), DynSolValue::Address(sender), DynSolValue::Address(origin)]).abi_encode_params())
            }
            "setNonce" | "setNonceUnsafe" | "resetNonce" => {
                let a = addr(0);
                let Ok(mut acc) = ctx.journaled_state.load_account_mut(a);
                let current = acc.nonce();
                let new = if name == "resetNonce" { 0 } else { uint(1).saturating_to::<u64>() };
                if name == "setNonce" && new < current {
                    return Answer::Revert(format!("vm.setNonce: new nonce ({new}) must be strictly equal to or higher than the account's current nonce ({current})"));
                }
                acc.set_nonce(new);
                Answer::Ok(vec![])
            }
            "createWallet" => {
                let pk = match &args[0] {
                    DynSolValue::String(name) => U256::from_be_bytes(keccak256(name.as_bytes()).0),
                    v => word(v),
                };
                let Some(k) = signing_key(pk) else { return Answer::Revert("vm.createWallet: bad private key".into()) };
                let a = key_address(&k);
                if let Some(label) = args.iter().find_map(|v| v.as_str()) {
                    self.labels.insert(a, label.to_string());
                }
                let point = k.verifying_key().to_encoded_point(false);
                let (x, y) = (U256::from_be_slice(point.x().unwrap()), U256::from_be_slice(point.y().unwrap()));
                Answer::Ok(
                    DynSolValue::Tuple(vec![DynSolValue::Address(a), DynSolValue::Uint(x, 256), DynSolValue::Uint(y, 256), DynSolValue::Uint(pk, 256)])
                        .abi_encode_params(),
                )
            }
            "setSeed" => {
                self.rng = Some(uint(0).as_limbs()[0] | 1);
                Answer::Ok(vec![])
            }
            n if n.starts_with("random") => {
                let mut word_ = || -> U256 {
                    let r = self.rng.get_or_insert(0x5eed_cafe_f00d_u64);
                    let mut next = || {
                        *r ^= *r << 13;
                        *r ^= *r >> 7;
                        *r ^= *r << 17;
                        *r
                    };
                    U256::from_limbs([next(), next(), next(), next()])
                };
                let w = word_();
                match (n, args.len()) {
                    ("randomUint", 0) => Answer::Ok(DynSolValue::Uint(w, 256).abi_encode()),
                    ("randomUint", 1) => {
                        let bits = uint(0).saturating_to::<usize>().min(256);
                        let v = if bits == 256 { w } else { w & ((U256::from(1) << bits) - U256::from(1)) };
                        Answer::Ok(DynSolValue::Uint(v, 256).abi_encode())
                    }
                    ("randomUint", _) => {
                        let (lo, hi) = (uint(0), uint(1));
                        if lo > hi {
                            return Answer::Revert("vm.randomUint: min must be less than or equal to max".to_string());
                        }
                        let span = hi - lo;
                        let v = if span == U256::MAX { w } else { lo + w % (span + U256::from(1)) };
                        Answer::Ok(DynSolValue::Uint(v, 256).abi_encode())
                    }
                    ("randomInt", 0) => Answer::Ok(DynSolValue::Int(revm::primitives::I256::from_raw(w), 256).abi_encode()),
                    ("randomInt", _) => {
                        let bits = uint(0).saturating_to::<usize>().clamp(1, 256);
                        let v = revm::primitives::I256::from_raw(w << (256 - bits)).asr(256 - bits);
                        Answer::Ok(DynSolValue::Int(v, 256).abi_encode())
                    }
                    ("randomAddress", _) => Answer::Ok(DynSolValue::Address(Address::from_slice(&w.to_be_bytes::<32>()[12..])).abi_encode()),
                    ("randomBool", _) => Answer::Ok(DynSolValue::Bool(w.bit(0)).abi_encode()),
                    ("randomBytes", _) => {
                        let len = uint(0).saturating_to::<usize>().min(1 << 20);
                        let mut out = vec![];
                        while out.len() < len {
                            out.extend_from_slice(&word_().to_be_bytes::<32>());
                        }
                        out.truncate(len);
                        Answer::Ok(DynSolValue::Bytes(out).abi_encode_params())
                    }
                    ("randomBytes4", _) => Answer::Ok(DynSolValue::FixedBytes(B256::from(w & (U256::MAX << 224)), 4).abi_encode()),
                    ("randomBytes8", _) => Answer::Ok(DynSolValue::FixedBytes(B256::from(w & (U256::MAX << 192)), 8).abi_encode()),
                    _ => Answer::Revert(format!("sol-debug: unsupported cheatcode {n}")),
                }
            }
            "getLabel" => {
                let a = addr(0);
                let l = self.labels.get(&a).cloned().unwrap_or_else(|| format!("unlabeled:{}", a.to_checksum(None)));
                Answer::Ok(DynSolValue::String(l).abi_encode_params())
            }
            "computeCreate2Address" => {
                let deployer = if args.len() > 2 { addr(2) } else { address!("4e59b44847b379578588920cA78FbF26c0B4956C") };
                Answer::Ok(DynSolValue::Address(deployer.create2(B256::from(word(&args[0])), B256::from(word(&args[1])))).abi_encode())
            }
            "parseUint" | "parseInt" | "parseBool" | "parseAddress" | "parseBytes32" | "parseBytes" => {
                let ty = match name {
                    "parseUint" => "uint256",
                    "parseInt" => "int256",
                    "parseBool" => "bool",
                    "parseAddress" => "address",
                    "parseBytes32" => "bytes32",
                    _ => "bytes",
                };
                match parse_env(ty, &text(0)) {
                    Some(v) => Answer::Ok(v.abi_encode_params()),
                    None => Answer::Revert(format!("failed parsing {:?} as type `{ty}`", text(0))),
                }
            }
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
                self.expect_revert = Some(ExpectRevert { data, caller, depth, frame: self.armed.len().saturating_sub(2) });
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
        if !self.ffi_allow.iter().any(|p| p == program || p == "*") {
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

/// `vm.assert*`, with forge's messages: `assertion failed: a != b`, or `msg: a != b` with a message; `assertion
/// failed` (or the message) for assertTrue/assertFalse. The `Decimal` variants print values with their decimals,
/// and assertApproxEqRel prints its deltas as percentages (1e18 is 100%).
fn assert(name: &str, args: &[DynSolValue]) -> Answer {
    let decimal = name.ends_with("Decimal");
    let base = name.trim_end_matches("Decimal");
    let values = match base {
        "assertTrue" | "assertFalse" => 1,
        "assertApproxEqAbs" | "assertApproxEqRel" => 3,
        _ => 2,
    };
    let decimals = decimal.then(|| args.get(values).and_then(|d| d.as_uint()).map(|(u, _)| u.saturating_to::<usize>()).unwrap_or(0));
    let msg = args.get(values + decimal as usize).and_then(|m| m.as_str());
    let fmt = |v: &DynSolValue| -> String {
        if let Some(d) = decimals {
            match v {
                DynSolValue::Uint(u, _) => return with_decimals(*u, d, false),
                DynSolValue::Int(i, _) => return with_decimals(i.unsigned_abs(), d, i.is_negative()),
                _ => {}
            }
        }
        to_string(v)
    };
    let ord = |a: &DynSolValue, b: &DynSolValue| match (a, b) {
        (DynSolValue::Uint(x, _), DynSolValue::Uint(y, _)) => x.cmp(y),
        (DynSolValue::Int(x, _), DynSolValue::Int(y, _)) => x.cmp(y),
        _ => std::cmp::Ordering::Equal,
    };
    let fail = |why: String| Answer::Revert(match msg {
        Some(m) => format!("{m}: {why}"),
        None => format!("assertion failed: {why}"),
    });
    let (a, b) = (&args[0], args.get(1).unwrap_or(&args[0]));
    match base {
        "assertTrue" | "assertFalse" => {
            if a.as_bool() == Some(base == "assertTrue") {
                Answer::Ok(vec![])
            } else {
                Answer::Revert(msg.unwrap_or("assertion failed").to_string())
            }
        }
        "assertEq" if a != b => fail(format!("{} != {}", fmt(a), fmt(b))),
        "assertNotEq" if a == b => fail(format!("{} == {}", fmt(a), fmt(b))),
        "assertGt" if !ord(a, b).is_gt() => fail(format!("{} <= {}", fmt(a), fmt(b))),
        "assertGe" if !ord(a, b).is_ge() => fail(format!("{} < {}", fmt(a), fmt(b))),
        "assertLt" if !ord(a, b).is_lt() => fail(format!("{} >= {}", fmt(a), fmt(b))),
        "assertLe" if !ord(a, b).is_le() => fail(format!("{} > {}", fmt(a), fmt(b))),
        "assertApproxEqAbs" | "assertApproxEqRel" => {
            // |a - b| for uint or int operands.
            let (delta, bmag) = match (a, b) {
                (DynSolValue::Int(x, _), DynSolValue::Int(y, _)) => {
                    let d = if x > y { x.wrapping_sub(*y) } else { y.wrapping_sub(*x) };
                    (d.unsigned_abs(), y.unsigned_abs())
                }
                _ => {
                    let (x, y) = (a.as_uint().map(|v| v.0).unwrap_or_default(), b.as_uint().map(|v| v.0).unwrap_or_default());
                    (if x > y { x - y } else { y - x }, y)
                }
            };
            let max = args[2].as_uint().map(|v| v.0).unwrap_or_default();
            if base == "assertApproxEqAbs" {
                if delta <= max {
                    return Answer::Ok(vec![]);
                }
                return fail(format!("{} !~= {} (max delta: {}, real delta: {})", fmt(a), fmt(b), fmt(&DynSolValue::Uint(max, 256)), fmt(&DynSolValue::Uint(delta, 256))));
            }
            if bmag.is_zero() {
                if delta.is_zero() {
                    return Answer::Ok(vec![]);
                }
                return fail(format!("{} !~= {} (right is 0)", fmt(a), fmt(b)));
            }
            let rel = delta * U256::from(10).pow(U256::from(18)) / bmag;
            if rel <= max {
                return Answer::Ok(vec![]);
            }
            let pct = |x: U256| format!("{}%", with_decimals(x, 16, false));
            fail(format!("{} !~= {} (max delta: {}, real delta: {})", fmt(a), fmt(b), pct(max), pct(rel)))
        }
        _ => Answer::Ok(vec![]),
    }
}

/// A value as `vm.toString` prints it.
fn to_string(v: &DynSolValue) -> String {
    match v {
        DynSolValue::Uint(u, _) => u.to_string(),
        DynSolValue::Int(i, _) => i.to_string(),
        DynSolValue::Address(a) => a.to_checksum(None),
        DynSolValue::Bool(b) => b.to_string(),
        DynSolValue::String(s) => s.clone(),
        DynSolValue::FixedBytes(b, n) => format!("0x{}", revm::primitives::hex::encode(&b[..*n])),
        DynSolValue::Bytes(b) => format!("0x{}", revm::primitives::hex::encode(b)),
        DynSolValue::Array(v) | DynSolValue::FixedArray(v) => format!("[{}]", v.iter().map(to_string).collect::<Vec<_>>().join(", ")),
        other => format!("0x{}", revm::primitives::hex::encode(other.abi_encode_packed())),
    }
}

/// `value` with `decimals` decimal places, zero-padded (`1.000500`).
fn with_decimals(value: U256, decimals: usize, negative: bool) -> String {
    let s = value.to_string();
    let out = if decimals == 0 {
        s
    } else if s.len() > decimals {
        format!("{}.{}", &s[..s.len() - decimals], &s[s.len() - decimals..])
    } else {
        format!("0.{}{s}", "0".repeat(decimals - s.len()))
    };
    if negative { format!("-{out}") } else { out }
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

/// An artifact name as forge takes it, without a compiler version suffix (`File.sol:Contract:0.8.18`).
fn artifact_name(what: &str) -> String {
    match what.rsplit_once(':') {
        Some((head, v)) if v.split('.').count() == 3 && v.split('.').all(|p| p.chars().all(|c| c.is_ascii_digit())) => head.to_string(),
        _ => what.to_string(),
    }
}

/// Creation or runtime code from an artifact JSON file: forge's (`bytecode.object`) or Hardhat's (`bytecode`).
fn artifact_file(root: &std::path::Path, path: &str, deployed: bool) -> Option<Vec<u8>> {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join(path)).ok()?).ok()?;
    let key = if deployed { "deployedBytecode" } else { "bytecode" };
    let hex = v[key]["object"].as_str().or_else(|| v[key].as_str())?;
    revm::primitives::hex::decode(hex.trim_start_matches("0x")).ok()
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
        if let Some(v) = self.env_set.get(key) {
            return Some(v.clone());
        }
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
