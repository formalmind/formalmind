//! Slices: what an agent gets for one unit. A few KB of Markdown cut from the source by `src`, never the AST.

use crate::graph::{CallKind, Graph, Id, Src};
use crate::scope::{Scope, Unit};
use std::collections::HashMap;
use std::fmt::Write;
use std::path::{Path, PathBuf};

/// Source text by solc file id, read on demand.
pub struct Sources {
    root: PathBuf,
    paths: HashMap<Id, String>,
    text: HashMap<Id, String>,
}

impl Sources {
    pub fn new(root: &Path, g: &Graph) -> Sources {
        Sources { root: root.to_path_buf(), paths: g.files.values().map(|f| (f.id, f.path.clone())).collect(), text: HashMap::new() }
    }

    fn file(&mut self, id: Id) -> &str {
        if !self.text.contains_key(&id) {
            let text = self.paths.get(&id).and_then(|p| std::fs::read_to_string(self.root.join(p)).ok()).unwrap_or_default();
            self.text.insert(id, text);
        }
        &self.text[&id]
    }

    /// The code at `src` (byte offsets, so slicing is on bytes).
    pub fn text(&mut self, src: Src) -> String {
        let file = self.file(src.file).as_bytes();
        let end = (src.start + src.len).min(file.len());
        String::from_utf8_lossy(&file[src.start.min(end)..end]).into_owned()
    }

    /// `File.sol:line`, short, for lists.
    pub fn short(&mut self, src: Src) -> String {
        let path = self.paths.get(&src.file).cloned().unwrap_or_default();
        let name = path.rsplit('/').next().unwrap_or("").to_string();
        format!("{name}:{}", self.line(src))
    }

    /// `path:line`, 1-based.
    pub fn at(&mut self, src: Src) -> String {
        let path = self.paths.get(&src.file).cloned().unwrap_or_default();
        let file = self.file(src.file).as_bytes();
        let line = file[..src.start.min(file.len())].iter().filter(|b| **b == b'\n').count() + 1;
        format!("{path}:{line}")
    }

    pub fn line(&mut self, src: Src) -> usize {
        let file = self.file(src.file).as_bytes();
        file[..src.start.min(file.len())].iter().filter(|b| **b == b'\n').count() + 1
    }
}

fn one_line(s: &str) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 140 { format!("{}…", flat.chars().take(140).collect::<String>()) } else { flat }
}

fn names(g: &Graph, ids: impl IntoIterator<Item = Id>) -> String {
    let list: Vec<String> = ids.into_iter().map(|v| g.state_vars.get(&v).map(|s| s.name.clone()).unwrap_or_else(|| format!("#{v}"))).collect();
    if list.is_empty() { "nothing".into() } else { list.join(", ") }
}

/// The Markdown an agent reads for one unit.
pub fn render(g: &Graph, scope: &Scope, unit: &Unit, src: &mut Sources) -> String {
    let mut out = String::new();
    let f = &g.functions[&unit.function];
    let _ = writeln!(out, "# {}", unit.name);
    let mods: Vec<String> = f.modifiers.iter().map(|m| g.functions.get(m).map(|m| m.name.clone()).unwrap_or_default()).collect();
    let _ = writeln!(
        out,
        "{} {}{} · {}\n",
        f.visibility,
        f.mutability,
        if mods.is_empty() { String::new() } else { format!(" · modifiers: {}", mods.join(", ")) },
        src.at(f.src)
    );

    let _ = writeln!(out, "## Footprint\n- reads: {}\n- writes: {}\n", names(g, unit.reads.iter().copied()), names(g, unit.writes.iter().copied()));

    if !unit.external_calls.is_empty() {
        let _ = writeln!(out, "## External calls");
        for e in &unit.external_calls {
            let c = &g.functions[&e.function].calls[e.call];
            let view = c.target.and_then(|t| g.functions.get(&t)).is_some_and(|t| t.mutability == "view" || t.mutability == "pure");
            let kind = match c.kind {
                CallKind::External if view => "external view (staticcall, can't change state)",
                CallKind::External => "external",
                CallKind::ExternalLibrary => "library (delegatecall)",
                CallKind::LowLevel => "low-level",
                CallKind::Internal => "internal",
            };
            let after = if e.written_after.is_empty() { String::new() } else { format!("; then writes **{}**", names(g, e.written_after.iter().copied())) };
            let _ = writeln!(out, "- {} `{}` — {kind}{after}", src.short(c.src), one_line(&src.text(c.src)));
        }
        out.push('\n');
    }

    let guards: Vec<(Id, usize)> = unit.closure.iter().flat_map(|fid| (0..g.functions[fid].guards.len()).map(move |i| (*fid, i))).collect();
    if !guards.is_empty() {
        let _ = writeln!(out, "## Guards");
        for (fid, i) in guards {
            let gd = &g.functions[&fid].guards[i];
            let _ = writeln!(out, "- {} {}: `{}`", src.short(gd.cond), gd.kind, one_line(&src.text(gd.cond)));
        }
        out.push('\n');
    }

    let arith: Vec<(Id, usize)> = unit.closure.iter().flat_map(|fid| (0..g.functions[fid].arith.len()).map(move |i| (*fid, i))).collect();
    if !arith.is_empty() {
        let _ = writeln!(out, "## Arithmetic");
        for (fid, i) in arith {
            let a = &g.functions[&fid].arith[i];
            let _ = writeln!(
                out,
                "- {} `{}` — {} {}{}{}",
                src.short(a.src),
                one_line(&src.text(a.src)),
                a.op,
                a.type_string,
                if a.checked { "" } else { ", unchecked" },
                a.rounding.as_ref().map(|r| format!(", rounds {r}")).unwrap_or_default()
            );
        }
        out.push('\n');
    }

    let asm: Vec<Id> = unit.closure.iter().copied().filter(|fid| !g.functions[fid].asm.is_empty()).collect();
    if !asm.is_empty() {
        let _ = writeln!(out, "## Assembly — read this code directly");
        for fid in asm {
            for a in &g.functions[&fid].asm {
                let refs: Vec<String> = a.refs.iter().map(|r| format!("{}{}", if r.name.is_empty() { format!("#{}", r.decl) } else { r.name.clone() }, if r.slot { ".slot" } else if r.offset { ".offset" } else { "" })).collect();
                let _ = writeln!(out, "- {} — uses {}; ops: {}", src.at(a.src), if refs.is_empty() { "no outside variables".into() } else { refs.join(", ") }, a.ops.iter().cloned().collect::<Vec<_>>().join(", "));
            }
        }
        out.push('\n');
    }

    let mut vars: Vec<Id> = unit.reads.union(&unit.writes).copied().collect();
    vars.sort_by_key(|v| g.state_vars.get(v).map(|s| s.src));
    if !vars.is_empty() {
        let _ = writeln!(out, "## State\n```solidity");
        for v in vars {
            if let Some(var) = g.state_vars.get(&v) {
                let slot = var.slot.as_ref().map(|s| format!(" // slot {s}{}", var.offset.filter(|o| *o > 0).map(|o| format!("+{o}")).unwrap_or_default())).unwrap_or_default();
                let _ = writeln!(out, "{};{slot}", one_line(&src.text(var.src)));
            }
        }
        let _ = writeln!(out, "```\n");
    }

    if !unit.dependencies.is_empty() {
        let _ = writeln!(out, "## Dependencies (library code it runs, not shown)");
        for fid in &unit.dependencies {
            let _ = writeln!(out, "- {} — {}", g.qualified(*fid), src.at(g.functions[fid].src));
        }
        out.push('\n');
    }

    let _ = writeln!(out, "## Code");
    for fid in &unit.closure {
        let func = &g.functions[fid];
        let _ = writeln!(out, "\n### {} — {}\n```solidity\n{}\n```", g.qualified(*fid), src.at(func.src), src.text(func.src));
    }
    let _ = scope;
    out
}
