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
use revm::database::{CacheDB, EmptyDB};
use revm::handler::MainnetContext;
use revm::interpreter::{CallInputs, CallOutcome, Gas, InstructionResult, InterpreterResult};
use revm::primitives::{address, keccak256, Address, Bytes, B256, U256};
use std::collections::HashMap;

pub type Ctx = MainnetContext<CacheDB<EmptyDB>>;

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

#[derive(Default)]
pub struct Cheats {
    prank: Option<Prank>,
    expect_revert: Option<ExpectRevert>,
    /// `vm.label` names, shown in the trace.
    pub labels: HashMap<Address, String>,
    /// Creation code by every name `getCode` might be given (`AsyncSwap.sol`, `AsyncSwap.sol:AsyncSwap`, the path).
    pub code: HashMap<String, Vec<u8>>,
    /// Unsupported cheatcodes that were called (for the summary).
    pub missing: Vec<String>,
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
        self.armed.push(aimed);
        if inputs.target_address == CONSOLE {
            return Some(outcome(inputs, InstructionResult::Return, Bytes::new()));
        }
        if inputs.target_address != HEVM {
            if let Some(p) = &self.prank {
                if p.depth == depth && inputs.caller == p.caller {
                    inputs.caller = p.sender;
                    if let Some(o) = p.origin {
                        ctx.tx.caller = o;
                    }
                    if p.single {
                        self.prank = None;
                    }
                }
            }
            return None;
        }
        let answer = self.answer(ctx, inputs.caller, input, depth);
        Some(match answer {
            Answer::Ok(out) => outcome(inputs, InstructionResult::Return, out.into()),
            Answer::Revert(msg) => outcome(inputs, InstructionResult::Revert, error_string(&msg)),
        })
    }

    /// Before a create: prank the deployer.
    pub fn create(&mut self, inputs: &mut revm::interpreter::CreateInputs, depth: usize) {
        let aimed = self.expect_revert.as_ref().is_some_and(|e| e.depth == depth && e.caller == inputs.caller());
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
    pub fn frame_end(&mut self, result: &mut InterpreterResult) {
        if !self.armed.pop().unwrap_or(false) {
            return;
        }
        let Some(e) = self.expect_revert.take() else { return };
        let reverted = !result.result.is_ok();
        let data_ok = e.data.as_ref().is_none_or(|d| result.output.starts_with(d));
        if reverted && data_ok {
            result.result = InstructionResult::Return;
            result.output = Bytes::new();
        } else {
            result.result = InstructionResult::Revert;
            result.output = error_string(if reverted {
                "sol-debug: call reverted with different data than expectRevert wanted"
            } else {
                "sol-debug: call did not revert as expected"
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
        match name {
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
            "expectEmit" | "recordLogs" => Answer::Ok(vec![]),
            n if n.starts_with("assert") => assert(n, &args),
            _ => Answer::Revert(format!("sol-debug: unsupported cheatcode {sig}")),
        }
    }
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
