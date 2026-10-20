//! Compiling for the debugger: solc `--standard-json` (never forge), asking for the bytecode, its source maps, the
//! method identifiers, the storage layout and the AST. The project reading (foundry.toml, remappings, which solc) is
//! formal-ast's.

use crate::source::Sources;
use crate::srcmap::{self, SrcEntry};
use anyhow::{bail, Context, Result};
use formal_ast::solc::{pragma_version, solc_binary, Project};
use revm::primitives::hex;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::process::{Command, Stdio};

/// Compiles the entry file (and its imports) with everything the debugger needs.
pub fn compile(project: &Project, entry: &str) -> Result<Value> {
    let entry_source = std::fs::read_to_string(project.root.join(entry)).with_context(|| format!("can't read {entry}"))?;
    let version = project.solc_version.clone().or_else(|| pragma_version(&entry_source));
    let solc = solc_binary(version.as_deref())?;
    let wanted = [
        "abi",
        "evm.bytecode.object",
        "evm.bytecode.sourceMap",
        "evm.deployedBytecode.object",
        "evm.deployedBytecode.sourceMap",
        "evm.deployedBytecode.opcodes",
        "evm.methodIdentifiers",
        "storageLayout",
    ];
    // No optimizer: the source maps are then exact to the statement. (An optimized build maps too, only coarser.)
    let mut settings = json!({
        "remappings": project.remappings,
        "optimizer": { "enabled": false },
        "outputSelection": { "*": { "*": wanted, "": ["ast"] } },
    });
    if let Some(evm) = &project.evm_version {
        settings["evmVersion"] = json!(evm);
    }
    let input = json!({ "language": "Solidity", "sources": { entry: { "urls": [entry] } }, "settings": settings });
    let mut child = Command::new(&solc)
        .args(["--standard-json", "--base-path", ".", "--allow-paths", "."])
        .current_dir(&project.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("can't run {}", solc.display()))?;
    {
        use std::io::Write;
        child.stdin.take().unwrap().write_all(input.to_string().as_bytes())?;
    }
    let out = child.wait_with_output()?;
    let output: Value = serde_json::from_slice(&out.stdout)
        .with_context(|| format!("solc printed no JSON: {}", String::from_utf8_lossy(&out.stderr)))?;
    let errors: Vec<String> = output["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["severity"] == "error")
        .map(|e| e["formattedMessage"].as_str().unwrap_or("").trim().to_string())
        .collect();
    if !errors.is_empty() {
        bail!("solc failed to compile {entry}:\n{}", errors.join("\n\n"));
    }
    Ok(output)
}

/// One piece of bytecode (the init code or the runtime code) and its map to the AST, both ways.
#[derive(Debug, Clone, Default)]
pub struct CodeMap {
    pub code: Vec<u8>,
    /// One per instruction.
    pub entries: Vec<SrcEntry>,
    /// pc → instruction index (`usize::MAX` inside a PUSH immediate).
    pub pc_to_ix: Vec<usize>,
    /// instruction index → pc.
    pub ix_to_pc: Vec<usize>,
    /// instruction index → innermost AST node (an index into [`Sources::nodes`]).
    pub ix_to_node: Vec<Option<usize>>,
    /// AST node → the instructions solc generated for exactly that node (its own `src`, not its children's).
    pub node_to_ix: BTreeMap<usize, Vec<usize>>,
}

impl CodeMap {
    pub fn new(code: Vec<u8>, map: &str, sources: &Sources) -> Self {
        let entries = srcmap::decode(map);
        let pc_to_ix = srcmap::pc_to_index(&code);
        let mut ix_to_pc = Vec::new();
        for (pc, &ix) in pc_to_ix.iter().enumerate().take(code.len()) {
            if ix != usize::MAX {
                ix_to_pc.push(pc);
            }
        }
        let ix_to_node: Vec<Option<usize>> = entries
            .iter()
            .map(|e| e.has_source().then(|| sources.node_at(e.file, e.start as usize, e.length.max(0) as usize)).flatten())
            .collect();
        let mut node_to_ix: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        for (ix, node) in ix_to_node.iter().enumerate() {
            if let Some(n) = node {
                node_to_ix.entry(*n).or_default().push(ix);
            }
        }
        CodeMap { code, entries, pc_to_ix, ix_to_pc, ix_to_node, node_to_ix }
    }

    /// Bytecode → AST: the source entry and AST node for the instruction at `pc`.
    pub fn at_pc(&self, pc: usize) -> (Option<SrcEntry>, Option<usize>) {
        let ix = self.pc_to_ix.get(pc).copied().unwrap_or(usize::MAX);
        (self.entries.get(ix).copied(), self.ix_to_node.get(ix).copied().flatten())
    }

    /// AST → bytecode: every pc solc generated for a node and everything inside it, in code order.
    pub fn pcs_for_node(&self, sources: &Sources, node: usize) -> Vec<usize> {
        let n = &sources.nodes[node];
        let (start, end) = (n.start, n.start + n.length);
        let mut pcs: Vec<usize> = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e.file == n.file && e.start >= 0 && (e.start as usize) >= start && (e.start + e.length) as usize <= end)
            .filter_map(|(ix, _)| self.ix_to_pc.get(ix).copied())
            .collect();
        pcs.sort_unstable();
        pcs
    }

    /// AST → bytecode by line: every pc whose source starts on that line of that file.
    pub fn pcs_for_line(&self, sources: &Sources, file: i64, line: usize) -> Vec<usize> {
        let Some(f) = sources.files.get(&file) else { return vec![] };
        self.entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e.file == file && e.start >= 0 && f.line(e.start as usize) == line)
            .filter_map(|(ix, _)| self.ix_to_pc.get(ix).copied())
            .collect()
    }
}

/// One compiled contract.
pub struct Artifact {
    pub file: String,
    pub name: String,
    pub abi: Value,
    /// Selector (4 bytes, hex without 0x) → `deposit(uint256)`.
    pub methods: BTreeMap<String, String>,
    pub init: CodeMap,
    pub runtime: CodeMap,
    pub storage_layout: Value,
}

impl Artifact {
    pub fn load(output: &Value, sources: &Sources, file: &str, name: &str) -> Result<Self> {
        let c = &output["contracts"][file][name];
        if c.is_null() {
            bail!("no contract {name} in {file}");
        }
        let code = |v: &Value| -> Result<Vec<u8>> {
            let s = v.as_str().unwrap_or("");
            if s.contains("__$") {
                bail!("{name} needs linked libraries; the prototype doesn't link them yet");
            }
            Ok(hex::decode(s)?)
        };
        let init = code(&c["evm"]["bytecode"]["object"])?;
        if init.is_empty() {
            bail!("{name} has no bytecode (abstract contract or interface?)");
        }
        let runtime = code(&c["evm"]["deployedBytecode"]["object"])?;
        let methods = c["evm"]["methodIdentifiers"]
            .as_object()
            .map(|m| m.iter().map(|(sig, sel)| (sel.as_str().unwrap_or("").to_string(), sig.clone())).collect())
            .unwrap_or_default();
        Ok(Artifact {
            file: file.to_string(),
            name: name.to_string(),
            abi: c["abi"].clone(),
            methods,
            init: CodeMap::new(init, c["evm"]["bytecode"]["sourceMap"].as_str().unwrap_or(""), sources),
            runtime: CodeMap::new(runtime, c["evm"]["deployedBytecode"]["sourceMap"].as_str().unwrap_or(""), sources),
            storage_layout: c["storageLayout"].clone(),
        })
    }

    /// The full signature for a name or a signature: `deposit` → `deposit(uint256)`.
    pub fn signature(&self, name_or_sig: &str) -> Result<String> {
        if name_or_sig.contains('(') {
            return Ok(name_or_sig.replace(' ', ""));
        }
        let found: Vec<&String> = self.methods.values().filter(|s| s.split('(').next() == Some(name_or_sig)).collect();
        match found.as_slice() {
            [one] => Ok((*one).clone()),
            [] => bail!("{} has no function {name_or_sig}", self.name),
            many => bail!("{name_or_sig} is overloaded; pick one of {many:?}"),
        }
    }
}
