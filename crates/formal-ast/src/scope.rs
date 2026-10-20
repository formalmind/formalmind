//! From one entry contract to the work: what's reachable, the units (one entry point and everything it runs), and
//! clusters of units that write the same state.

use crate::graph::{CallKind, Graph, Id, Ref};
use anyhow::{bail, Result};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Debug, Clone, Serialize)]
pub struct Scope {
    pub entry: Id,
    /// The entry contract and its bases, most derived first.
    pub contracts: Vec<Id>,
    /// Public and external functions after overrides (the most derived wins), plus constructor/receive/fallback.
    pub surface: Vec<Id>,
    /// Every function and modifier the surface can run.
    pub reachable: BTreeSet<Id>,
    /// Files with code or declarations the reachable code uses.
    pub files: BTreeSet<Id>,
    /// Files the entry file imports directly that nothing reachable uses.
    pub unused_imports: Vec<String>,
    /// Compiled files outside the scope.
    pub out_of_scope: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Unit {
    /// The entry point.
    pub function: Id,
    pub name: String,
    pub mutability: String,
    /// The functions and modifiers it runs, in discovery order (the entry point first).
    pub closure: Vec<Id>,
    pub reads: BTreeSet<Id>,
    pub writes: BTreeSet<Id>,
    /// External, external-library and low-level calls anywhere in the closure, in execution order.
    pub external_calls: Vec<ExtCall>,
    /// Dependency functions it runs (library code, summarized rather than shown).
    pub dependencies: Vec<Id>,
    pub guards: usize,
    pub arith: usize,
    pub unchecked: usize,
    pub asm: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExtCall {
    pub function: Id,
    pub call: usize,
    /// State variables written later in the unit's execution (source order through internal calls, not paths): what
    /// a reentrant call could see half-updated.
    pub written_after: BTreeSet<Id>,
}

/// One step of a unit's execution, flattened through internal calls.
enum Step {
    Ext(Id, usize),
    Write(Id),
}

#[derive(Debug, Clone, Serialize)]
pub struct Cluster {
    pub units: Vec<Id>,
    /// State variables written by more than one unit in the cluster: invariant candidates.
    pub shared: BTreeSet<Id>,
}

impl Scope {
    /// The entry contract: the one named, or the last non-abstract contract defined in the entry file.
    pub fn new(g: &Graph, entry_file: &str, contract: Option<&str>) -> Result<Scope> {
        let file = g.files.values().find(|f| f.path == entry_file).map(|f| f.id);
        let entry = match contract {
            Some(name) => g.contract_by_name(name).map(|c| c.id),
            None => g.contracts.values().filter(|c| Some(c.file) == file && c.kind == "contract").max_by_key(|c| c.src.start).map(|c| c.id),
        };
        let Some(entry) = entry else {
            bail!("no contract {} in {entry_file}", contract.unwrap_or("(deployable)"));
        };
        let contracts = g.contracts[&entry].bases.clone();

        // The surface: walk most-derived first; a signature seen once is overridden further down.
        let mut seen = BTreeSet::new();
        let mut surface = vec![];
        for c in &contracts {
            for f in &g.contracts[c].functions {
                let func = &g.functions[f];
                if func.kind == "modifier" || !func.implemented {
                    continue;
                }
                let key = if func.kind == "function" { func.signature.clone() } else { func.kind.clone() };
                if func.kind == "constructor" && *c != entry {
                    continue;
                }
                if seen.insert(key) && (func.visibility == "public" || func.visibility == "external" || func.kind != "function") {
                    surface.push(*f);
                }
            }
        }

        let mut s = Scope { entry, contracts, surface, reachable: BTreeSet::new(), files: BTreeSet::new(), unused_imports: vec![], out_of_scope: vec![] };
        let mut stack: Vec<Id> = s.surface.clone();
        while let Some(f) = stack.pop() {
            if !s.reachable.insert(f) {
                continue;
            }
            let func = &g.functions[&f];
            for m in &func.modifiers {
                stack.push(s.resolve(g, *m));
            }
            for c in &func.calls {
                if c.kind == CallKind::Internal {
                    if let Some(t) = c.target {
                        stack.push(if c.direct { t } else { s.resolve(g, t) });
                    }
                }
            }
        }

        for f in &s.reachable {
            let func = &g.functions[f];
            s.files.extend(g.file_of(*f));
            s.files.extend(func.uses.iter().filter_map(|d| g.file_of(*d)));
        }
        for c in &s.contracts {
            s.files.insert(g.contracts[c].file);
            for v in &g.contracts[c].state_vars {
                s.files.extend(g.file_of(*v));
            }
        }
        if let Some(entry_file) = file.and_then(|f| g.files.get(&f)) {
            for import in &entry_file.imports {
                let used = g.files.values().find(|f| &f.path == import).is_some_and(|f| s.files.contains(&f.id));
                if !used {
                    s.unused_imports.push(import.clone());
                }
            }
        }
        s.out_of_scope = g.files.values().filter(|f| !s.files.contains(&f.id)).map(|f| f.path.clone()).collect();
        Ok(s)
    }

    /// A call to a virtual function runs the most derived override in the entry contract's linearization.
    pub fn resolve(&self, g: &Graph, target: Id) -> Id {
        let Some(f) = g.functions.get(&target) else { return target };
        if !f.virtual_ {
            return target;
        }
        for c in &self.contracts {
            for candidate in &g.contracts[c].functions {
                let other = &g.functions[candidate];
                if other.kind == f.kind && other.signature == f.signature {
                    return *candidate;
                }
            }
        }
        target
    }

    /// One unit per surface function. Storage parameters are mapped to the caller's state variables, so a write
    /// through `Loan storage loan` in a helper counts as a write of `loans` in the unit.
    pub fn units(&self, g: &Graph) -> Vec<Unit> {
        self.surface.iter().map(|f| self.unit(g, *f)).collect()
    }

    fn unit(&self, g: &Graph, entry: Id) -> Unit {
        let func = &g.functions[&entry];
        let mut u = Unit {
            function: entry,
            name: g.qualified(entry),
            mutability: func.mutability.clone(),
            closure: vec![],
            reads: BTreeSet::new(),
            writes: BTreeSet::new(),
            external_calls: vec![],
            dependencies: vec![],
            guards: 0,
            arith: 0,
            unchecked: 0,
            asm: 0,
        };
        let mut visiting = BTreeSet::new();
        self.collect(g, entry, &[], &mut u, &mut visiting);
        let mut steps = vec![];
        self.sequence(g, entry, &[], &mut BTreeSet::new(), &mut steps);
        for (i, step) in steps.iter().enumerate() {
            if let Step::Ext(function, call) = step {
                let after: BTreeSet<Id> = steps[i + 1..].iter().filter_map(|s| if let Step::Write(v) = s { Some(*v) } else { None }).collect();
                // The same call reached twice (a helper used in two places) is one entry; what follows is merged.
                match u.external_calls.iter_mut().find(|e| e.function == *function && e.call == *call) {
                    Some(e) => e.written_after.extend(after),
                    None => u.external_calls.push(ExtCall { function: *function, call: *call, written_after: after }),
                }
            }
        }
        u
    }

    /// The unit's calls and writes in execution order: modifiers first, then the body in source order, expanding
    /// internal calls where they happen.
    fn sequence(&self, g: &Graph, f: Id, params: &[Option<Id>], visiting: &mut BTreeSet<Id>, out: &mut Vec<Step>) {
        if !visiting.insert(f) {
            return;
        }
        let func = &g.functions[&f];
        for m in &func.modifiers {
            self.sequence(g, self.resolve(g, *m), &[], visiting, out);
        }
        let map = |r: &Ref| match r {
            Ref::State(id) => Some(*id),
            Ref::Param(i) => params.get(*i).copied().flatten(),
        };
        // (offset, write, call), sorted by where they are in the source.
        let mut events: Vec<(usize, Option<Id>, Option<usize>)> = func.write_at.iter().map(|(at, r)| (*at, map(r), None)).collect();
        events.extend(func.calls.iter().enumerate().map(|(i, c)| (c.src.start, None, Some(i))));
        events.sort();
        for (_, write, call) in events {
            match call {
                None => out.extend(write.map(Step::Write)),
                Some(i) => {
                    let c = &func.calls[i];
                    if c.kind == CallKind::Internal {
                        if let Some(t) = c.target {
                            let args: Vec<Option<Id>> = c.args.iter().map(|a| a.as_ref().and_then(map)).collect();
                            self.sequence(g, if c.direct { t } else { self.resolve(g, t) }, &args, visiting, out);
                        }
                    } else {
                        out.push(Step::Ext(f, i));
                    }
                }
            }
        }
        visiting.remove(&f);
    }

    fn collect(&self, g: &Graph, f: Id, params: &[Option<Id>], u: &mut Unit, visiting: &mut BTreeSet<Id>) {
        if !visiting.insert(f) {
            return;
        }
        if g.is_dependency(f) {
            if !u.dependencies.contains(&f) {
                u.dependencies.push(f);
            }
        } else if !u.closure.contains(&f) {
            u.closure.push(f);
            let func = &g.functions[&f];
            u.guards += func.guards.len();
            u.arith += func.arith.len();
            u.unchecked += func.arith.iter().filter(|a| !a.checked).count();
            u.asm += func.asm.len();
        }
        let func = &g.functions[&f];
        let map = |r: &Ref| match r {
            Ref::State(id) => Some(*id),
            Ref::Param(i) => params.get(*i).copied().flatten(),
        };
        u.reads.extend(func.reads.iter().filter_map(map));
        u.writes.extend(func.writes.iter().filter_map(map));
        for m in &func.modifiers {
            self.collect(g, self.resolve(g, *m), &[], u, visiting);
        }
        for c in &func.calls {
            if c.kind == CallKind::Internal {
                if let Some(t) = c.target {
                    let args: Vec<Option<Id>> = c.args.iter().map(|a| a.as_ref().and_then(map)).collect();
                    self.collect(g, if c.direct { t } else { self.resolve(g, t) }, &args, u, visiting);
                }
            }
        }
        visiting.remove(&f);
    }
}

/// Units that write the same state variable belong together; views join the cluster of what they read.
pub fn clusters(units: &[Unit]) -> Vec<Cluster> {
    let mut parent: Vec<usize> = (0..units.len()).collect();
    fn find(p: &mut [usize], i: usize) -> usize {
        if p[i] != i {
            let r = find(p, p[i]);
            p[i] = r;
        }
        p[i]
    }
    let mut writer: HashMap<Id, usize> = HashMap::new();
    for (i, u) in units.iter().enumerate() {
        for w in &u.writes {
            match writer.get(w) {
                Some(&j) => {
                    let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                    parent[a] = b;
                }
                None => {
                    writer.insert(*w, i);
                }
            }
        }
    }
    for (i, u) in units.iter().enumerate() {
        if u.writes.is_empty() {
            if let Some(&j) = u.reads.iter().find_map(|r| writer.get(r)) {
                let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                parent[a] = b;
            }
        }
    }
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for i in 0..units.len() {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    let mut out: Vec<Cluster> = groups
        .into_values()
        .map(|members| {
            let mut count: BTreeMap<Id, usize> = BTreeMap::new();
            for i in &members {
                for w in &units[*i].writes {
                    *count.entry(*w).or_default() += 1;
                }
            }
            Cluster { units: members.iter().map(|i| units[*i].function).collect(), shared: count.into_iter().filter(|(_, n)| *n > 1).map(|(v, _)| v).collect() }
        })
        .collect();
    out.sort_by_key(|c| std::cmp::Reverse(c.units.len()));
    out
}
