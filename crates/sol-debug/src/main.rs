//! sol-debug: compile with solc, deploy into an in-memory revm chain, run one call, print the step trace.
//!
//!   sol-debug crates/formal-ast/tests/fixture src/Vault.sol --contract Vault \
//!     --stub 0x00000000000000000000000000000000000000aa=2000000000000000000 \
//!     --set oracle=0x00000000000000000000000000000000000000aa \
//!     --call deposit --arg 100 --lines
//!
//! `--map-line N` prints the bytecode solc generated for a line (AST → bytecode); `--map-pc N` prints the AST node an
//! instruction came from (bytecode → AST).

use anyhow::{anyhow, Result};
use clap::Parser;
use revm::bytecode::opcode::OpCode;
use revm::primitives::{hex, Address, U256};
use sol_debug::{Session, SENDER};
use std::path::PathBuf;

#[derive(Parser)]
#[command(about = "Step through a Solidity call opcode by opcode, mapped to the source and the storage layout")]
struct Args {
    /// Project root (where foundry.toml / remappings.txt are).
    root: PathBuf,
    /// The file to compile, relative to the root.
    entry: String,
    /// The contract to deploy.
    #[arg(long)]
    contract: String,
    /// Constructor arguments, in order.
    #[arg(long = "ctor-arg")]
    ctor_args: Vec<String>,
    /// Set a state variable after deploying: `name=value` (repeatable).
    #[arg(long = "set")]
    sets: Vec<String>,
    /// Put code at an address that returns one word to any call: `0xADDR=value` (repeatable).
    #[arg(long = "stub")]
    stubs: Vec<String>,
    /// The function to call: a name, or a full signature when overloaded.
    #[arg(long)]
    call: Option<String>,
    /// Call arguments, in order, as Solidity literals.
    #[arg(long = "arg")]
    args: Vec<String>,
    /// Sender address.
    #[arg(long)]
    from: Option<Address>,
    /// Wei sent with the call.
    #[arg(long, default_value = "0")]
    value: U256,
    /// One line per change of Solidity line instead of one per opcode.
    #[arg(long)]
    lines: bool,
    /// Print the runtime bytecode solc generated for a source line of the entry file.
    #[arg(long)]
    map_line: Option<usize>,
    /// Print the source and AST node of a runtime pc.
    #[arg(long)]
    map_pc: Option<usize>,
}

fn main() -> Result<()> {
    let a = Args::parse();
    let mut s = Session::compile(&a.root, &a.entry)?;
    let ci = s.artifact(&a.contract)?;

    if let Some(line) = a.map_line {
        let file = s.sources.files.values().find(|f| f.name == a.entry).ok_or_else(|| anyhow!("{} not compiled", a.entry))?.id;
        let map = &s.artifacts[ci].runtime;
        println!("{}:{line}  {}", a.entry, s.sources.files[&file].line_text(line).trim());
        for pc in map.pcs_for_line(&s.sources, file, line) {
            let (_, node) = map.at_pc(pc);
            let op = OpCode::new(map.code[pc]).map(|o| o.as_str()).unwrap_or("?");
            let n = node.map(|n| &s.sources.nodes[n]);
            println!("  pc={pc:<6} {op:<14} {}", n.map(|n| format!("{} #{}", n.node_type, n.id)).unwrap_or_default());
        }
        return Ok(());
    }
    if let Some(pc) = a.map_pc {
        let map = &s.artifacts[ci].runtime;
        let (entry, node) = map.at_pc(pc);
        let entry = entry.ok_or_else(|| anyhow!("pc {pc} isn't the start of an instruction"))?;
        let op = OpCode::new(map.code[pc]).map(|o| o.as_str()).unwrap_or("?");
        match (node, s.sources.files.get(&entry.file)) {
            (Some(n), Some(f)) => {
                let node = &s.sources.nodes[n];
                let line = f.line(entry.start as usize);
                println!("pc={pc} {op} → {}:{line} {} #{} in {}", f.name, node.node_type, node.id, s.sources.scope_name(n));
                println!("  {}", f.line_text(line).trim());
                println!("  the node compiles to {} instructions", map.pcs_for_node(&s.sources, n).len());
            }
            _ => println!("pc={pc} {op} → no source (compiler-generated)"),
        }
        return Ok(());
    }

    let ctor = if a.ctor_args.is_empty() {
        vec![]
    } else {
        let types: Vec<String> = s.artifacts[ci].abi.as_array().into_iter().flatten()
            .find(|e| e["type"] == "constructor")
            .map(|c| c["inputs"].as_array().into_iter().flatten().map(|i| i["type"].as_str().unwrap_or("").to_string()).collect())
            .unwrap_or_default();
        sol_debug::session::encode_call(&format!("constructor({})", types.join(",")), &a.ctor_args)?[4..].to_vec()
    };
    for stub in &a.stubs {
        let (addr, word) = stub.split_once('=').ok_or_else(|| anyhow!("--stub wants 0xADDR=value"))?;
        s.stub_returning(addr.parse()?, word.parse()?);
    }
    let (addr, deploy) = s.deploy(ci, &ctor)?;
    println!("deployed {} at {addr} ({} steps, {} gas)", a.contract, deploy.trace.steps.len(), deploy.gas_used);
    for set in &a.sets {
        let (name, value) = set.split_once('=').ok_or_else(|| anyhow!("--set wants name=value"))?;
        s.set_var(addr, name, value)?;
    }
    let Some(call) = &a.call else { return Ok(()) };
    let run = s.call(addr, call, &a.args, a.from.unwrap_or(SENDER), a.value)?;
    let mut out = std::io::stdout().lock();
    s.print_trace(&run, a.lines, &mut out)?;
    println!(
        "\n{} {} steps, {} gas, output 0x{}",
        if run.success { "ok:" } else { "reverted:" },
        run.trace.steps.len(),
        run.gas_used,
        hex::encode(&run.output)
    );
    println!("storage writes:");
    for w in s.storage_writes(&run) {
        println!("  {}:{}  {}: {} → {}", a.entry, w.line.map(|l| l.to_string()).unwrap_or("?".into()), w.path, w.old.unwrap_or("?".into()), w.new);
    }
    Ok(())
}
