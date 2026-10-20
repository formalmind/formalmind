//! A debugging session: one compile, an in-memory chain (revm over a CacheDB), contracts deployed into it, and
//! transactions run with the [`Recorder`]. Each recorded step is then placed in the Solidity source through the
//! contract's source map and AST.

use crate::layout::Layout;
use crate::solc::{self, Artifact, CodeMap};
use crate::source::Sources;
use crate::srcmap::{Jump, SrcEntry};
use crate::trace::{CodeRef, Recorder, StorageAccess, Trace};
use alloy_dyn_abi::{DynSolType, DynSolValue};
use anyhow::{anyhow, bail, Context as _, Result};
use formal_ast::solc::Project;
use revm::bytecode::{opcode::OpCode, Bytecode};
use revm::context::result::{ExecutionResult, Output};
use revm::context::{Context, ContextTr, TxEnv};
use revm::database::{CacheDB, EmptyDB};
use revm::handler::{MainBuilder, MainContext, MainnetContext, MainnetEvm};
use revm::primitives::{hex, keccak256, Address, Bytes, TxKind, U256};
use revm::state::AccountInfo;
use revm::{DatabaseRef, InspectCommitEvm};
use std::collections::HashMap;
use std::path::Path;

pub type Evm = MainnetEvm<MainnetContext<CacheDB<EmptyDB>>, Recorder>;

/// The default sender: an EOA with plenty of ether.
pub const SENDER: Address = Address::new([0x5e; 20]);

pub struct Session {
    pub project: Project,
    pub sources: Sources,
    pub artifacts: Vec<Artifact>,
    /// Deployed address → artifact index.
    pub deployed: HashMap<Address, usize>,
    pub evm: Evm,
}

/// Where a step is in the Solidity source.
#[derive(Debug, Clone)]
pub struct Located {
    pub entry: SrcEntry,
    pub file: String,
    pub line: usize,
    /// The innermost AST node whose `src` covers the instruction's.
    pub node: Option<usize>,
    pub node_type: String,
    /// `Vault.deposit`, `Vault._credit`.
    pub scope: String,
}

/// The outcome of one transaction.
pub struct Run {
    pub trace: Trace,
    pub success: bool,
    pub output: Bytes,
    pub created: Option<Address>,
    pub gas_used: u64,
    /// For a deploy: the artifact whose init code ran.
    pub creating: Option<usize>,
}

impl Session {
    /// Compiles `entry` under `root` and loads every contract that has bytecode.
    pub fn compile(root: &Path, entry: &str) -> Result<Self> {
        let project = Project::load(root)?;
        let output = solc::compile(&project, entry)?;
        let sources = Sources::load(&output, &project.root, &project.remappings);
        let mut artifacts = Vec::new();
        for (file, contracts) in output["contracts"].as_object().into_iter().flatten() {
            for (name, c) in contracts.as_object().into_iter().flatten() {
                if c["evm"]["bytecode"]["object"].as_str().is_some_and(|s| !s.is_empty()) {
                    artifacts.push(Artifact::load(&output, &sources, file, name)?);
                }
            }
        }
        let ctx = Context::mainnet().with_db(CacheDB::new(EmptyDB::default())).modify_cfg_chained(|cfg| {
            cfg.disable_nonce_check = true;
        });
        let mut evm = ctx.build_mainnet_with_inspector(Recorder::default());
        evm.ctx.db_mut().insert_account_info(SENDER, AccountInfo { balance: U256::from(10).pow(U256::from(24)), ..Default::default() });
        Ok(Session { project, sources, artifacts, deployed: HashMap::new(), evm })
    }

    pub fn artifact(&self, name: &str) -> Result<usize> {
        let found: Vec<usize> = self.artifacts.iter().enumerate().filter(|(_, a)| a.name == name).map(|(i, _)| i).collect();
        match found.as_slice() {
            [one] => Ok(*one),
            [] => bail!("no deployable contract {name} (have: {})", self.artifacts.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")),
            _ => bail!("{name} is defined in more than one file"),
        }
    }

    /// Deploys a contract with ABI-encoded constructor arguments; the run's trace covers the init code.
    pub fn deploy(&mut self, contract: usize, ctor_args: &[u8]) -> Result<(Address, Run)> {
        let mut data = self.artifacts[contract].init.code.clone();
        data.extend_from_slice(ctor_args);
        let mut run = self.transact(SENDER, TxKind::Create, data.into(), U256::ZERO)?;
        run.creating = Some(contract);
        let addr = run.created.ok_or_else(|| anyhow!("deploying {} failed: 0x{}", self.artifacts[contract].name, hex::encode(&run.output)))?;
        // The runtime map follows the code actually on chain (immutables filled in; same layout as solc's).
        let code = self.evm.ctx.db().basic_ref(addr)?.and_then(|a| a.code).map(|c| c.original_bytes().to_vec()).unwrap_or_default();
        let a = &mut self.artifacts[contract];
        if !code.is_empty() && code.len() == a.runtime.code.len() {
            a.runtime.code = code;
        }
        self.deployed.insert(addr, contract);
        Ok((addr, run))
    }

    /// Runs one transaction with the recorder on, and commits it.
    pub fn transact(&mut self, from: Address, kind: TxKind, data: Bytes, value: U256) -> Result<Run> {
        let tx = TxEnv::builder().caller(from).kind(kind).data(data).value(value).gas_limit(16_000_000).build_fill();
        let result = self.evm.inspect_tx_commit(tx).map_err(|e| anyhow!("transaction failed to run: {e:?}"))?;
        let trace = self.evm.inspector.take();
        Ok(match result {
            ExecutionResult::Success { output, gas, .. } => {
                let (created, output) = match output {
                    Output::Create(out, addr) => (addr, out),
                    Output::Call(out) => (None, out),
                };
                Run { trace, success: true, output, created, gas_used: gas.tx_gas_used(), creating: None }
            }
            ExecutionResult::Revert { output, gas, .. } => Run { trace, success: false, output, created: None, gas_used: gas.tx_gas_used(), creating: None },
            ExecutionResult::Halt { gas, .. } => Run { trace, success: false, output: Bytes::new(), created: None, gas_used: gas.tx_gas_used(), creating: None },
        })
    }

    /// Calls `sig` (`deposit` or `deposit(uint256)`) on a deployed contract with arguments written as Solidity
    /// literals.
    pub fn call(&mut self, to: Address, sig: &str, args: &[String], from: Address, value: U256) -> Result<Run> {
        let contract = *self.deployed.get(&to).ok_or_else(|| anyhow!("nothing deployed at {to}"))?;
        let sig = self.artifacts[contract].signature(sig)?;
        let data = encode_call(&sig, args)?;
        self.transact(from, TxKind::Call(to), data.into(), value)
    }

    /// Writes a root state variable directly (setup a constructor or setter doesn't offer).
    pub fn set_var(&mut self, at: Address, name: &str, value: &str) -> Result<()> {
        let contract = *self.deployed.get(&at).ok_or_else(|| anyhow!("nothing deployed at {at}"))?;
        let layout = Layout::new(&self.artifacts[contract].storage_layout);
        let (slot, offset, ty) = layout.var(name).ok_or_else(|| anyhow!("no state variable {name}"))?;
        let label = layout.label(&ty);
        let sol_ty = if label.starts_with("contract ") || label.starts_with("enum ") { "address".to_string() } else { label };
        let parsed = DynSolType::parse(&sol_ty)?.coerce_str(value).with_context(|| format!("{value} isn't a {sol_ty}"))?;
        let mut word = U256::from_be_slice(&parsed.abi_encode());
        let width = layout.size(&ty).min(32);
        if sol_ty.starts_with("bytes") {
            // bytesN is left-aligned in an ABI word, right-aligned in storage.
            word >>= (32 - width) * 8;
        }
        let mask = if width == 32 { U256::MAX } else { (U256::from(1) << (width * 8)) - U256::from(1) };
        let db = self.evm.ctx.db_mut();
        let old = db.storage_ref(at, slot).unwrap_or_default();
        // Keep whatever else is packed in the slot.
        let new = (old & !(mask << (offset * 8))) | ((word & mask) << (offset * 8));
        db.insert_account_storage(at, slot, new)?;
        Ok(())
    }

    /// Installs code at an address that returns the same 32-byte word to every call: a stand-in for an oracle or
    /// any view the contract calls out to.
    pub fn stub_returning(&mut self, at: Address, word: U256) {
        let mut code = vec![0x7f];
        code.extend_from_slice(&word.to_be_bytes::<32>());
        code.extend_from_slice(&[0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3]);
        self.evm.ctx.db_mut().insert_account_info(at, AccountInfo::default().with_code(Bytecode::new_raw(code.into())));
    }

    /// The code map a step ran (None for code the session didn't compile).
    pub fn code_map(&self, code: CodeRef) -> Option<(&Artifact, &CodeMap)> {
        match code {
            CodeRef::Runtime(a) => self.deployed.get(&a).map(|&i| (&self.artifacts[i], &self.artifacts[i].runtime)),
            CodeRef::Init(_) => None,
        }
    }

    /// Bytecode → Solidity for one instruction. Init code is placed with the contract being created.
    pub fn locate(&self, code: CodeRef, pc: usize, creating: Option<usize>) -> Option<Located> {
        let map = match (code, creating) {
            (CodeRef::Init(_), Some(i)) => &self.artifacts[i].init,
            _ => self.code_map(code)?.1,
        };
        let (entry, node) = map.at_pc(pc);
        let entry = entry?;
        if !entry.has_source() {
            return None;
        }
        let file = self.sources.files.get(&entry.file)?;
        Some(Located {
            entry,
            file: file.short_name().to_string(),
            line: file.line(entry.start as usize),
            node,
            node_type: node.map(|n| self.sources.nodes[n].node_type.clone()).unwrap_or_default(),
            scope: node.map(|n| self.sources.scope_name(n)).unwrap_or_default(),
        })
    }

    /// Storage accesses named by the storage layout of the contract that owns the storage.
    pub fn describe_storage(&self, address: Address, access: &StorageAccess, trace: &Trace) -> String {
        let layout = self.deployed.get(&address).map(|&i| Layout::new(&self.artifacts[i].storage_layout));
        let (slot, kind) = match access {
            StorageAccess::Read { slot, .. } => (*slot, "read"),
            StorageAccess::Write { slot, .. } => (*slot, "write"),
        };
        let places = layout.as_ref().map(|l| l.places(slot, &trace.preimages)).unwrap_or_default();
        if places.is_empty() {
            let v = match access {
                StorageAccess::Read { value, .. } => format!("{value:#x}"),
                StorageAccess::Write { old, new, .. } => format!("{} → {new:#x}", old.map(|o| format!("{o:#x}")).unwrap_or("?".into())),
            };
            return format!("{kind} slot {slot:#x}: {v}");
        }
        let l = layout.unwrap();
        places
            .iter()
            .map(|p| match access {
                StorageAccess::Read { value, .. } => format!("{kind} {} = {}", p.path, l.decode(p, *value)),
                StorageAccess::Write { old, new, .. } => {
                    let before = old.map(|o| l.decode(p, o)).unwrap_or("?".into());
                    format!("{kind} {}: {before} → {}", p.path, l.decode(p, *new))
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The storage writes of a run, named: `(contract file:line, "accounts[0x…].shares", old, new)`.
    pub fn storage_writes(&self, run: &Run) -> Vec<StorageWrite> {
        let mut out = Vec::new();
        for (i, s) in run.trace.steps.iter().enumerate() {
            let Some(StorageAccess::Write { slot, old, new }) = &s.storage else { continue };
            let loc = self.locate(s.code, s.pc, run.creating);
            let layout = self.deployed.get(&s.address).map(|&i| Layout::new(&self.artifacts[i].storage_layout));
            let places = layout.as_ref().map(|l| l.places(*slot, &run.trace.preimages)).unwrap_or_default();
            for p in &places {
                let l = layout.as_ref().unwrap();
                out.push(StorageWrite {
                    step: i,
                    line: loc.as_ref().map(|l| l.line),
                    path: p.path.clone(),
                    old: old.map(|o| l.decode(p, o)),
                    new: l.decode(p, *new),
                });
            }
            if places.is_empty() {
                out.push(StorageWrite { step: i, line: loc.as_ref().map(|l| l.line), path: format!("{slot:#x}"), old: old.map(|o| format!("{o:#x}")), new: format!("{new:#x}") });
            }
        }
        out
    }

    /// Prints the trace: one line per opcode, or (with `lines_only`) one per change of Solidity line.
    pub fn print_trace(&self, run: &Run, lines_only: bool, out: &mut impl std::io::Write) -> std::io::Result<()> {
        let mut last: Option<(usize, CodeRef, String, usize)> = None;
        for (i, s) in run.trace.steps.iter().enumerate() {
            let loc = self.locate(s.code, s.pc, run.creating);
            let key = (s.depth, s.code, loc.as_ref().map(|l| l.file.clone()).unwrap_or_default(), loc.as_ref().map(|l| l.line).unwrap_or(0));
            let storage = s.storage.as_ref().map(|a| self.describe_storage(s.address, a, &run.trace));
            if lines_only && last.as_ref() == Some(&key) && storage.is_none() {
                continue;
            }
            last = Some(key);
            if let Some(f) = run.trace.frames.get(s.frame).filter(|f| f.first_step == i) {
                writeln!(out, "{}── {} {} → {} {}", "  ".repeat(s.depth), f.kind, short(f.caller), short(f.target), self.describe_call(f.target, &f.input))?;
            }
            let op = OpCode::new(s.op).map(|o| o.as_str()).unwrap_or("INVALID");
            let top: Vec<String> = s.stack.iter().rev().take(3).map(|v| short_word(*v)).collect();
            let place = match &loc {
                Some(l) => format!("{}:{}", l.file, l.line),
                None => "<no source>".into(),
            };
            let text = loc
                .as_ref()
                .and_then(|l| self.sources.files.get(&l.entry.file).map(|f| f.line_text(l.line).trim().to_string()))
                .unwrap_or_default();
            let jump = match loc.as_ref().map(|l| l.entry.jump) {
                Some(Jump::In) => " ↘",
                Some(Jump::Out) => " ↗",
                _ => "",
            };
            write!(out, "{i:>6} {}{place:<16} {:<14} pc={:<5} {op:<12}{jump:<2} [{}]", "  ".repeat(s.depth), loc.as_ref().map(|l| l.scope.as_str()).unwrap_or(""), s.pc, top.join(", "))?;
            if lines_only {
                write!(out, "  │ {text}")?;
            }
            if let Some(st) = storage {
                write!(out, "  ⟶ {st}")?;
            }
            writeln!(out)?;
        }
        Ok(())
    }

    /// `deposit(100)` for calldata the session can decode, else the selector.
    pub fn describe_call(&self, to: Address, input: &[u8]) -> String {
        if input.len() < 4 {
            return format!("0x{}", hex::encode(input));
        }
        let selector = hex::encode(&input[..4]);
        let Some(sig) = self.deployed.get(&to).and_then(|&i| self.artifacts[i].methods.get(&selector)) else {
            return format!("0x{selector}…");
        };
        let params = sig.split_once('(').map(|(_, p)| format!("({}", p)).unwrap_or_default();
        let decoded = DynSolType::parse(&params).ok().and_then(|t| t.abi_decode_params(&input[4..]).ok());
        match decoded {
            Some(DynSolValue::Tuple(vals)) => {
                let name = sig.split('(').next().unwrap_or("");
                format!("{name}({})", vals.iter().map(show_value).collect::<Vec<_>>().join(", "))
            }
            _ => sig.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageWrite {
    pub step: usize,
    pub line: Option<usize>,
    pub path: String,
    pub old: Option<String>,
    pub new: String,
}

/// ABI-encodes a call from a signature and arguments written as text.
pub fn encode_call(sig: &str, args: &[String]) -> Result<Vec<u8>> {
    let params = sig.split_once('(').map(|(_, p)| format!("({p}")).ok_or_else(|| anyhow!("bad signature {sig}"))?;
    let DynSolType::Tuple(types) = DynSolType::parse(&params)? else { bail!("bad signature {sig}") };
    if types.len() != args.len() {
        bail!("{sig} takes {} arguments, got {}", types.len(), args.len());
    }
    let values = types.iter().zip(args).map(|(t, a)| t.coerce_str(a).with_context(|| format!("{a} isn't a {t}"))).collect::<Result<Vec<_>>>()?;
    let mut data = keccak256(sig.as_bytes())[..4].to_vec();
    data.extend(DynSolValue::Tuple(values).abi_encode_params());
    Ok(data)
}

fn show_value(v: &DynSolValue) -> String {
    match v {
        DynSolValue::Uint(u, _) => u.to_string(),
        DynSolValue::Int(i, _) => i.to_string(),
        DynSolValue::Address(a) => a.to_checksum(None),
        DynSolValue::Bool(b) => b.to_string(),
        other => format!("{other:?}"),
    }
}

fn short(a: Address) -> String {
    let s = a.to_checksum(None);
    format!("{}…{}", &s[..6], &s[s.len() - 4..])
}

/// A stack word, short: small numbers in decimal, the rest in hex (long ones elided in the middle).
pub fn short_word(v: U256) -> String {
    if v < U256::from(1_000_000u64) {
        return v.to_string();
    }
    let h = format!("{v:x}");
    if h.len() <= 16 {
        format!("0x{h}")
    } else {
        format!("0x{}…{}", &h[..6], &h[h.len() - 4..])
    }
}

