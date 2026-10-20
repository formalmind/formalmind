use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use formal_ast::graph::Graph;
use formal_ast::{analyze_full, lean, scope, slice};
use serde_json::json;
use std::path::PathBuf;
use std::time::Instant;

/// Reads a Solidity protocol through solc's AST (never forge): its graph, scope, units of work and slices.
#[derive(Parser)]
#[command(name = "formal-ast")]
struct Cli {
    /// The project folder (with foundry.toml / remappings.txt).
    #[arg(long, default_value = ".")]
    root: PathBuf,
    /// The entry file, relative to the root: the main protocol contract.
    entry: String,
    /// The entry contract, when the file defines several.
    #[arg(long)]
    contract: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// A summary: scope, units and clusters.
    Summary,
    /// The units, one line each.
    Units,
    /// The slice an agent gets for one unit (by function name or `Contract.name`).
    Slice { function: String },
    /// The whole graph, scope, units and clusters as JSON (writes .formal/ast/graph.json under the root).
    Json,
    /// Audit mode's data as JSON: units, clusters and every unit's slice.
    Audit,
    /// Production's entry points: what each script under script/ deploys and calls (the entry argument is ignored).
    Scripts,
    /// The Audit page's coverage as JSON: each function's Lean model (or why it is opaque) and the theorems naming it.
    Formal,
    /// A world of linked models: the entry plus `--with file[:Contract]` members, interface calls bound to the
    /// members that implement them.
    Link {
        out: PathBuf,
        #[arg(long = "with")]
        with: Vec<String>,
    },
    /// The Lean 4 model: writes it to `out` (relative to the root) and prints what was left opaque.
    Lean {
        out: PathBuf,
        /// The Lean namespace.
        #[arg(long, default_value = "Model")]
        namespace: String,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if matches!(cli.command, Command::Scripts) {
        println!("{}", formal_ast::script_entries(&cli.root)?);
        return Ok(());
    }
    let started = Instant::now();
    let (a, output) = analyze_full(&cli.root, &cli.entry, cli.contract.as_deref())?;
    let g = &a.graph;
    let took = started.elapsed();
    match cli.command {
        Command::Summary => summary(&a, took),
        Command::Units => {
            for u in &a.units {
                println!("{}", unit_line(g, u));
            }
        }
        Command::Slice { function } => {
            let unit = a.units.iter().find(|u| u.name == function || g.functions[&u.function].name == function);
            let Some(unit) = unit else {
                bail!("no unit {function}; `units` lists them");
            };
            let mut sources = slice::Sources::new(&a.project.root, g);
            print!("{}", slice::render(g, &a.scope, unit, &mut sources));
        }
        Command::Lean { out, namespace } => {
            let model = lean::Gen::new(&output, g, &a.scope).generate(&namespace);
            let path = a.project.root.join(&out);
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&path, &model.text)?;
            println!("{} — {} lines, {} functions translated, {} opaque", path.display(), model.text.lines().count(), model.report.translated.len(), model.report.opaque.len());
            for (f, why) in &model.report.opaque {
                println!("  opaque {f}: {why}");
            }
        }
        Command::Scripts => unreachable!(),
        Command::Formal => {
            println!("{}", formal_ast::formal_json(&a, &output, took.as_millis() as u64));
        }
        Command::Audit => {
            let mut v = formal_ast::audit_json(&a, took.as_millis() as u64);
            v["slices"] = serde_json::to_value(formal_ast::all_slices(&a))?;
            println!("{v}");
        }
        Command::Link { out, with } => {
            let mut parts = vec![lean::Gen::new(&output, g, &a.scope).parts()];
            let mut keep = vec![];
            for w in &with {
                let (file, contract) = match w.split_once(':') {
                    Some((f, c)) => (f.to_string(), Some(c.to_string())),
                    None => (w.clone(), None),
                };
                keep.push(analyze_full(&cli.root, &file, contract.as_deref())?);
            }
            for (b, out) in &keep {
                parts.push(lean::Gen::new(out, &b.graph, &b.scope).parts());
            }
            let linked = formal_ast::link::link(&parts);
            let path = a.project.root.join(&out);
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&path, &linked.text)?;
            println!("{} — {} lines", path.display(), linked.text.lines().count());
            for p in &parts {
                println!("  {}: {} translated, {} opaque", p.contract, p.report.translated.len(), p.report.opaque.len());
            }
            println!("bound calls ({}):", linked.bound.len());
            for (from, field, to) in &linked.bound {
                println!("  {from}.{field} → {to}");
            }
        }
        Command::Json => {
            let clusters = scope::clusters(&a.units);
            let out = json!({ "entry": a.entry_file, "graph": g, "scope": a.scope, "units": a.units, "clusters": clusters });
            let dir = a.project.root.join(".formal").join("ast");
            std::fs::create_dir_all(&dir)?;
            let path = dir.join("graph.json");
            std::fs::write(&path, serde_json::to_string(&out)?)?;
            println!("{}", path.display());
        }
    }
    Ok(())
}

fn unit_line(g: &Graph, u: &scope::Unit) -> String {
    let names = |ids: &std::collections::BTreeSet<i64>| ids.iter().map(|v| g.state_vars.get(v).map(|s| s.name.clone()).unwrap_or_default()).collect::<Vec<_>>().join(",");
    format!(
        "{:<44} {:<10} fns {:>2}  ext {:>2}  guards {:>2}  arith {:>3} (unchecked {})  asm {}  writes [{}]",
        u.name,
        u.mutability,
        u.closure.len(),
        u.external_calls.len(),
        u.guards,
        u.arith,
        u.unchecked,
        u.asm,
        names(&u.writes)
    )
}

fn summary(a: &formal_ast::Analysis, took: std::time::Duration) {
    let g = &a.graph;
    let s = &a.scope;
    println!("{} — {} in {:.2}s", a.entry_file, g.contracts[&s.entry].name, took.as_secs_f64());
    println!(
        "compiled {} files; in scope {} (out of scope {}); contracts {} (entry + bases); surface {} functions; reachable {} functions and modifiers",
        g.files.len(),
        s.files.len(),
        s.out_of_scope.len(),
        s.contracts.len(),
        s.surface.len(),
        s.reachable.len()
    );
    if !s.unused_imports.is_empty() {
        println!("unused imports in the entry file: {}", s.unused_imports.join(", "));
    }
    let state: usize = s.contracts.iter().map(|c| g.contracts[c].state_vars.iter().filter(|v| { let v = &g.state_vars[v]; !v.constant && !v.immutable }).count()).sum();
    println!("storage variables: {state}");
    println!("\nunits ({}):", a.units.len());
    for u in &a.units {
        println!("  {}", unit_line(g, u));
    }
    let clusters = scope::clusters(&a.units);
    println!("\nclusters ({}), units that write the same state:", clusters.len());
    for c in &clusters {
        let units: Vec<String> = c.units.iter().map(|u| g.functions[u].name.clone()).collect();
        let shared: Vec<String> = c.shared.iter().map(|v| g.state_vars[v].name.clone()).collect();
        println!("  [{}] shared writes: {}", units.join(", "), if shared.is_empty() { "-".into() } else { shared.join(", ") });
    }
}
