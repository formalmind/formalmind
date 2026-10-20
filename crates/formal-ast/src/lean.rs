//! The Lean 4 model, generated from solc's AST.
//!
//! Every reachable function becomes a `do` block in `M State α` (see prelude.lean). Statements map almost one to one:
//! locals are `let mut`, storage writes are `modify`, `require`/`revert` throw, checked arithmetic reverts where
//! Solidity panics. What can't be translated soundly (loops, assembly, storage parameters, mutated memory-struct
//! parameters, bytes and strings, low-level calls…) becomes a named field of `Ext`, so every theorem holds for every
//! behaviour of it, and the report says why.

use crate::graph::{CallKind, Graph, Id, Src};
use crate::scope::Scope;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;

pub const PRELUDE: &str = include_str!("prelude.lean");

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    /// Functions and modifiers translated in full.
    pub translated: Vec<String>,
    /// Functions left opaque in `Ext`, and why.
    pub opaque: Vec<(String, String)>,
    /// Every `Ext` field: immutables, external calls, opaque functions.
    pub ext: Vec<String>,
}

pub struct Model {
    pub text: String,
    pub report: Report,
}

type R<T> = Result<T, String>;

fn bail<T>(why: impl Into<String>) -> R<T> {
    Err(why.into())
}

const KEYWORDS: &[&str] = &[
    "at", "by", "do", "else", "end", "fun", "have", "if", "in", "let", "match", "mut", "then", "with", "where", "from",
    "show", "open", "import", "def", "theorem", "structure", "class", "instance", "return", "for", "unless", "namespace",
    "section", "variable", "universe", "macro", "syntax", "local", "private", "protected", "partial", "example", "abbrev",
    "inductive", "axiom", "opaque", "calc", "suffices", "try", "catch", "finally", "break", "continue", "repeat", "while",
    "mutual", "export", "attribute", "notation", "set_option", "deriving", "extends", "Type", "Prop", "Sort", "this",
    "true", "false", "fun", "lemma", "omit", "include", "nomatch", "nofun", "termination_by", "decreasing_by", "using",
];
/// Names the generated code itself uses; locals with these names get a prime.
const RESERVED: &[&str] = &[
    "upd", "view", "require", "pop", "idx", "setAt", "addc", "subc", "mulc", "divc", "modc", "powc", "addw", "subw", "mulw",
    "divw", "shlw", "mulDivFloor", "mulDivCeil", "mulDivRnd", "panic", "get", "set", "read", "modify", "pure", "throw",
    "default", "ext", "s", "M", "Env", "State", "Ext", "Revert", "k", "env", "decide", "List", "Nat", "Bool", "Unit",
];

/// A Lean identifier: `«…»` when the Solidity name isn't a plain Lean identifier.
pub fn ident(name: &str) -> String {
    let plain = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if plain && !KEYWORDS.contains(&name) { name.to_string() } else { format!("«{name}»") }
}

fn local_ident(name: &str) -> String {
    if RESERVED.contains(&name) { format!("{name}'") } else { ident(name) }
}

fn bits_of(t: &str) -> Option<u32> {
    let t = t.split_whitespace().next().unwrap_or("");
    if let Some(n) = t.strip_prefix("uint") {
        return if n.is_empty() { Some(256) } else { n.parse().ok() };
    }
    if t == "address" || t.starts_with("contract") {
        return Some(160);
    }
    if let Some(n) = t.strip_prefix("bytes") {
        return n.parse::<u32>().ok().map(|b| b * 8);
    }
    None
}

/// `x.1`, `x.2.1`, … for the i-th of n in a right-nested product.
fn proj(t: &str, i: usize, n: usize) -> String {
    if n == 1 {
        return t.to_string();
    }
    let mut s = t.to_string();
    for _ in 0..i {
        s.push_str(".2");
    }
    if i < n - 1 {
        s.push_str(".1");
    }
    s
}

fn product(types: &[String]) -> String {
    match types.len() {
        0 => "Unit".into(),
        1 => types[0].clone(),
        _ => format!("({})", types.join(" × ")),
    }
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}
fn id_of(v: &Value) -> Id {
    v["id"].as_i64().unwrap_or(0)
}
fn tstr(v: &Value) -> String {
    s(&v["typeDescriptions"]["typeString"])
}

#[derive(Clone, Debug)]
enum Base {
    State(String),
    Local(String),
    /// A storage parameter: `n_get` / `n_set` for the location the caller passed.
    Lens(String),
}
#[derive(Clone, Debug)]
enum Step {
    Map(String),
    Arr(String),
    Field(String),
}
#[derive(Clone, Debug)]
struct Path {
    base: Base,
    steps: Vec<Step>,
}

pub struct Gen<'a> {
    g: &'a Graph,
    scope: &'a Scope,
    nodes: HashMap<Id, &'a Value>,
    enum_index: HashMap<Id, usize>,
    struct_by_canon: HashMap<String, Id>,
    state_field: HashMap<Id, String>,
    fn_name: HashMap<Id, String>,
    /// Ok(definition) or Err(reason), per function id, in generation order.
    done: Vec<(Id, R<String>)>,
    status: HashMap<Id, bool>,
    in_progress: HashSet<Id>,
    structs: BTreeSet<Id>,
    /// Constant definitions in dependency order.
    consts: Vec<(Id, String)>,
    ext: BTreeMap<String, String>,
    /// Calls by src, to reuse the graph's classification.
    calls: HashMap<Src, (CallKind, Option<Id>, bool)>,
}

impl<'a> Gen<'a> {
    pub fn new(output: &'a Value, g: &'a Graph, scope: &'a Scope) -> Gen<'a> {
        let mut nodes = HashMap::new();
        let mut enum_index = HashMap::new();
        let mut struct_by_canon = HashMap::new();
        fn walk<'v>(n: &'v Value, f: &mut impl FnMut(&'v Value)) {
            match n {
                Value::Object(m) => {
                    if m.contains_key("nodeType") {
                        f(n);
                    }
                    m.values().for_each(|v| walk(v, f));
                }
                Value::Array(a) => a.iter().for_each(|v| walk(v, f)),
                _ => {}
            }
        }
        for src in output["sources"].as_object().into_iter().flat_map(|m| m.values()) {
            walk(&src["ast"], &mut |n| {
                if let Some(id) = n["id"].as_i64() {
                    nodes.insert(id, n);
                }
                match n["nodeType"].as_str().unwrap_or("") {
                    "EnumDefinition" => {
                        for (i, m) in n["members"].as_array().into_iter().flatten().enumerate() {
                            enum_index.insert(id_of(m), i);
                        }
                    }
                    "StructDefinition" => {
                        struct_by_canon.insert(s(&n["canonicalName"]), id_of(n));
                    }
                    _ => {}
                }
            });
        }
        // State fields: every mutable state variable of the entry contract and its bases.
        let mut state_field = HashMap::new();
        let mut used: HashMap<String, usize> = HashMap::new();
        for c in scope.contracts.iter().rev() {
            for v in &g.contracts[c].state_vars {
                let var = &g.state_vars[v];
                if var.constant || var.immutable {
                    continue;
                }
                *used.entry(var.name.clone()).or_default() += 1;
            }
        }
        for c in scope.contracts.iter().rev() {
            for v in &g.contracts[c].state_vars {
                let var = &g.state_vars[v];
                if var.constant || var.immutable {
                    continue;
                }
                let name = if used[&var.name] > 1 { format!("{}_{}", g.contracts[c].name, var.name) } else { var.name.clone() };
                state_field.insert(*v, ident(&name));
            }
        }
        let mut calls = HashMap::new();
        for f in g.functions.values() {
            for c in &f.calls {
                calls.insert(c.src, (c.kind, c.target, c.direct));
            }
        }
        Gen {
            g,
            scope,
            nodes,
            enum_index,
            struct_by_canon,
            state_field,
            fn_name: HashMap::new(),
            done: vec![],
            status: HashMap::new(),
            in_progress: HashSet::new(),
            structs: BTreeSet::new(),
            consts: vec![],
            ext: BTreeMap::new(),
            calls,
        }
    }

    fn lean_fn_name(&mut self, f: Id) -> String {
        if let Some(n) = self.fn_name.get(&f) {
            return n.clone();
        }
        let func = &self.g.functions[&f];
        let c = self.g.contracts.get(&func.contract).map(|c| c.name.as_str()).unwrap_or("Free");
        let base = format!("{}.{}", ident(c), ident(&func.name));
        let taken = self.fn_name.values().any(|n| n == &base);
        let name = if taken { format!("{}.{}", ident(c), ident(&format!("{}_{}", func.name, f))) } else { base };
        self.fn_name.insert(f, name.clone());
        name
    }

    fn ext_fn_field(&self, f: Id) -> String {
        let func = &self.g.functions[&f];
        let c = self.g.contracts.get(&func.contract).map(|c| c.name.as_str()).unwrap_or("Free");
        format!("fn_{c}_{}_{f}", func.name.trim_start_matches('_'))
    }

    // ---------- types ----------

    fn ty(&mut self, t: &Value) -> R<String> {
        match t["nodeType"].as_str().unwrap_or("") {
            "ElementaryTypeName" => {
                let n = s(&t["name"]);
                if n == "bool" {
                    Ok("Bool".into())
                } else if n == "bytes" {
                    // Passed through as a value; encoding or hashing it stays opaque.
                    Ok("(List Nat)".into())
                } else if n == "string" {
                    Ok("String".into())
                } else if n.starts_with("uint") || n.starts_with("address") || (n.starts_with("bytes") && n != "bytes") {
                    Ok("Nat".into())
                } else {
                    bail(format!("type {n}"))
                }
            }
            "UserDefinedTypeName" => {
                let r = t["referencedDeclaration"].as_i64().unwrap_or(0);
                let Some(d) = self.nodes.get(&r).copied() else { return bail("unknown type") };
                match d["nodeType"].as_str().unwrap_or("") {
                    "StructDefinition" => {
                        self.need_struct(r)?;
                        Ok(self.struct_name(r))
                    }
                    "EnumDefinition" | "ContractDefinition" => Ok("Nat".into()),
                    "UserDefinedValueTypeDefinition" => self.ty(&d["underlyingType"]),
                    other => bail(format!("type {other}")),
                }
            }
            "Mapping" => {
                let k = self.ty(&t["keyType"])?;
                if k != "Nat" {
                    return bail("mapping key that isn't a word");
                }
                Ok(format!("(Nat → {})", self.ty(&t["valueType"])?))
            }
            "ArrayTypeName" => Ok(format!("(List {})", self.ty(&t["baseType"])?)),
            other => bail(format!("type {other}")),
        }
    }

    /// From a typeString, for temporaries.
    fn ty_str(&mut self, t: &str) -> R<String> {
        let t = t.trim();
        if t == "bool" {
            return Ok("Bool".into());
        }
        if t == "bytes" {
            return Ok("(List Nat)".into());
        }
        if t == "string" {
            return Ok("String".into());
        }
        if let Some(rest) = t.strip_suffix(" memory").or_else(|| t.strip_suffix(" storage ref")).or_else(|| t.strip_suffix(" storage pointer")).or_else(|| t.strip_suffix(" calldata")) {
            return self.ty_str(rest);
        }
        if let Some(inner) = t.strip_suffix("[]") {
            return Ok(format!("(List {})", self.ty_str(inner)?));
        }
        if let Some(name) = t.strip_prefix("struct ") {
            let id = *self.struct_by_canon.get(name).ok_or_else(|| format!("struct {name}"))?;
            self.need_struct(id)?;
            return Ok(self.struct_name(id));
        }
        if bits_of(t).is_some() || t.starts_with("enum ") || t.starts_with("contract ") || t.starts_with("address") || t.starts_with("int_const") {
            return Ok("Nat".into());
        }
        // User-defined value types (`Currency`) are words.
        if t.chars().next().is_some_and(|c| c.is_ascii_uppercase()) && !t.contains(' ') {
            return Ok("Nat".into());
        }
        bail(format!("type {t}"))
    }

    fn struct_name(&self, id: Id) -> String {
        self.nodes[&id]["canonicalName"].as_str().unwrap_or("S").split('.').map(ident).collect::<Vec<_>>().join(".")
    }

    fn need_struct(&mut self, id: Id) -> R<()> {
        if self.structs.contains(&id) {
            return Ok(());
        }
        self.structs.insert(id);
        let d = self.nodes[&id];
        for m in d["members"].as_array().into_iter().flatten() {
            if let Err(e) = self.ty(&m["typeName"]) {
                self.structs.remove(&id);
                return Err(e);
            }
        }
        Ok(())
    }

    // ---------- constants ----------

    fn constant(&mut self, id: Id) -> R<String> {
        let d = self.nodes.get(&id).copied().ok_or("constant")?;
        let contract = self.g.contracts.values().find(|c| c.state_vars.contains(&id)).map(|c| c.name.clone());
        let name = match &contract {
            Some(c) => format!("{}.{}", ident(c), ident(&s(&d["name"]))),
            None => ident(&s(&d["name"])),
        };
        if !self.consts.iter().any(|(c, _)| *c == id) {
            let value = self.const_expr(&d["value"])?;
            let ty = self.ty(&d["typeName"])?;
            if !self.consts.iter().any(|(c, _)| *c == id) {
                self.consts.push((id, format!("def {name} : {ty} := {value}")));
            }
        }
        Ok(name)
    }

    /// A compile-time expression: plain Nat arithmetic.
    fn const_expr(&mut self, e: &Value) -> R<String> {
        match e["nodeType"].as_str().unwrap_or("") {
            "Literal" => literal(e),
            "Identifier" => {
                let r = e["referencedDeclaration"].as_i64().unwrap_or(0);
                match self.g.state_vars.get(&r) {
                    Some(v) if v.constant => self.constant(r),
                    _ => match self.nodes.get(&r) {
                        Some(n) if n["constant"] == true => self.constant(r),
                        _ => bail("constant refers to a non-constant"),
                    },
                }
            }
            "MemberAccess" => {
                if let Some(t) = type_max(e) {
                    return Ok(t);
                }
                let r = e["referencedDeclaration"].as_i64().unwrap_or(0);
                if let Some(i) = self.enum_index.get(&r) {
                    return Ok(i.to_string());
                }
                self.constant(r)
            }
            "BinaryOperation" => {
                let op = s(&e["operator"]);
                let (a, b) = (self.const_expr(&e["leftExpression"])?, self.const_expr(&e["rightExpression"])?);
                let lop = match op.as_str() {
                    "+" | "-" | "*" | "/" | "%" => op.clone(),
                    "**" => "^".into(),
                    "<<" => "<<<".into(),
                    ">>" => ">>>".into(),
                    _ => return bail(format!("constant operator {op}")),
                };
                Ok(format!("({a} {lop} {b})"))
            }
            "TupleExpression" => {
                let c = e["components"].as_array().ok_or("tuple")?;
                if c.len() == 1 { self.const_expr(&c[0]) } else { bail("constant tuple") }
            }
            "FunctionCall" if e["kind"] == "typeConversion" => {
                let a = self.const_expr(&e["arguments"][0])?;
                Ok(a)
            }
            other => bail(format!("constant {other}")),
        }
    }

    // ---------- functions ----------

    /// Translates `f` and everything it calls, callees first.
    fn function(&mut self, f: Id) {
        if self.status.contains_key(&f) || self.in_progress.contains(&f) {
            return;
        }
        self.in_progress.insert(f);
        let func = &self.g.functions[&f];
        let mut callees: Vec<Id> = func.modifiers.iter().map(|m| self.scope.resolve(self.g, *m)).collect();
        for c in &func.calls {
            if c.kind == CallKind::Internal {
                if let Some(t) = c.target {
                    callees.push(if c.direct { t } else { self.scope.resolve(self.g, t) });
                }
            }
        }
        for c in callees {
            self.function(c);
        }
        self.lean_fn_name(f);
        let result = self.translate(f);
        self.in_progress.remove(&f);
        self.status.insert(f, result.is_ok());
        self.done.push((f, result));
    }

    fn translate(&mut self, f: Id) -> R<String> {
        let node = self.nodes.get(&f).copied().ok_or("no node")?;
        if node["body"].is_null() {
            return bail("no body");
        }
        let modifier = node["nodeType"] == "ModifierDefinition";
        let name = self.lean_fn_name(f);
        let mut params = vec![];
        let mut assigned = HashSet::new();
        collect_assigned(&node["body"], &mut assigned);
        let mut fx = Fx::new(self, f);
        let mut mut_params = vec![];
        for p in node["parameters"]["parameters"].as_array().into_iter().flatten() {
            let ty = fx.g.ty(&p["typeName"])?;
            let n = local_ident(&s(&p["name"]));
            let n = if n.is_empty() || n == "«»" { format!("arg{}", params.len()) } else { n };
            if p["storageLocation"] == "storage" {
                // A storage reference: the callee reads and writes the caller's location through a lens.
                let base = n.trim_matches(|c| c == '«' || c == '»').to_string();
                fx.lens.insert(id_of(p), base.clone());
                params.push(format!("({base}_get : M State {ty}) ({base}_set : {ty} → M State Unit)"));
                continue;
            }
            fx.locals.insert(id_of(p), n.clone());
            if assigned.contains(&id_of(p)) {
                if p["storageLocation"] == "memory" && ty != "Nat" && ty != "Bool" {
                    return bail("writes to a memory parameter (shared with the caller)");
                }
                mut_params.push(n.clone());
            }
            params.push(format!("({n} : {ty})"));
        }
        let mut ret_types = vec![];
        let mut named = vec![];
        for r in node["returnParameters"]["parameters"].as_array().into_iter().flatten() {
            let ty = fx.g.ty(&r["typeName"])?;
            ret_types.push(ty.clone());
            let n = s(&r["name"]);
            if !n.is_empty() {
                let n = local_ident(&n);
                fx.locals.insert(id_of(r), n.clone());
                named.push((n, ty));
            }
        }
        fx.named = named.iter().map(|(n, _)| n.clone()).collect();
        if !fx.named.is_empty() && fx.named.len() != ret_types.len() {
            return bail("partly named returns");
        }
        fx.indent = 1;
        for m in &mut_params {
            fx.line(format!("let mut {m} := {m}"));
        }
        for (n, ty) in &named {
            fx.line(format!("let mut {n} : {ty} := default"));
        }
        fx.modifier = modifier;
        fx.block(&node["body"])?;
        if modifier {
            if !fx.placeholder {
                return bail("modifier without `_`");
            }
            fx.line("return __r".into());
        } else if fx.out.last().is_some_and(|l| l.starts_with("  return ")) {
            // The body already ends in a return.
        } else if !named.is_empty() {
            fx.line(format!("return {}", tuple(&fx.named)));
        } else if ret_types.is_empty() {
            fx.line("return ()".into());
        } else {
            fx.line("return default".into());
        }
        let body = fx.out.join("\n");

        let mut out = String::new();
        let func = &self.g.functions[&f];
        let _ = writeln!(out, "/-- {} ({}) -/", self.g.qualified(f), func.kind);
        if modifier {
            let _ = writeln!(out, "def {name} {{α : Type}} (ext : Ext) {} (k : M State α) : M State α := do\n{body}", params.join(" "));
            return Ok(out);
        }
        let ret = product(&ret_types);
        // Modifiers wrap the body, outermost first.
        let mut head = String::new();
        let mut tail = String::new();
        for m in node["modifiers"].as_array().into_iter().flatten() {
            if m["kind"] == "baseConstructorSpecifier" {
                continue;
            }
            let mid = m["modifierName"]["referencedDeclaration"].as_i64().unwrap_or(0);
            let mid = self.scope.resolve(self.g, mid);
            if self.status.get(&mid) != Some(&true) {
                return bail(format!("modifier {} is opaque", self.g.qualified(mid)));
            }
            let mut fx = Fx::new(self, f);
            fx.locals = HashMap::new();
            for p in node["parameters"]["parameters"].as_array().into_iter().flatten() {
                fx.locals.insert(id_of(p), local_ident(&s(&p["name"])));
            }
            let mut args = vec![];
            for a in m["arguments"].as_array().into_iter().flatten() {
                args.push(fx.expr(a)?);
            }
            if !fx.out.is_empty() {
                return bail("modifier arguments with effects");
            }
            let mname = self.lean_fn_name(mid);
            let _ = write!(head, "{mname} ext {}(", args.iter().map(|a| format!("{a} ")).collect::<String>());
            tail.push(')');
        }
        if head.is_empty() {
            let _ = writeln!(out, "def {name} (ext : Ext) {} : M State {ret} := do\n{body}", params.join(" "));
        } else {
            let _ = writeln!(out, "def {name} (ext : Ext) {} : M State {ret} :=\n  {head}do\n{body}{tail}", params.join(" "));
        }
        Ok(out)
    }

    /// Generates the model for the scope's surface.
    pub fn generate(mut self, namespace: &str) -> Model {
        for f in self.scope.surface.clone() {
            self.function(f);
        }
        // Immutables are parameters of the model.
        for c in self.scope.contracts.clone() {
            for v in self.g.contracts[&c].state_vars.clone() {
                let var = &self.g.state_vars[&v];
                if var.immutable {
                    let node = self.nodes.get(&v).copied();
                    let ty = node.and_then(|d| self.clone_ty(&d["typeName"])).unwrap_or_else(|| "Nat".into());
                    self.ext.insert(format!("{} : {ty}", ident(&var.name)), format!("immutable {}", self.g.qualified(v)));
                }
            }
        }
        let mut report = Report { translated: vec![], opaque: vec![], ext: vec![] };
        let done = std::mem::take(&mut self.done);
        let mut defs = vec![];
        for (f, r) in &done {
            match r {
                Ok(text) => {
                    report.translated.push(self.g.qualified(*f));
                    defs.push(text.clone());
                }
                Err(why) => {
                    report.opaque.push((self.g.qualified(*f), why.clone()));
                    let sig = self.opaque_sig(*f);
                    self.ext.insert(format!("{} : {sig}", self.ext_fn_field(*f)), format!("opaque {}: {why}", self.g.qualified(*f)));
                }
            }
        }

        let mut out = String::new();
        let _ = writeln!(out, "/-\n  Generated by formal-ast from solc's AST. Don't edit: regenerate.\n  Entry: {}\n  Translated: {} functions. Opaque (in `Ext`): {}.\n-/", self.g.qualified(self.scope.entry), report.translated.len(), report.opaque.len());
        out.push_str(PRELUDE);
        let _ = writeln!(out, "\nnamespace {namespace}\nopen FormalAst\nset_option linter.unusedVariables false\nset_option maxHeartbeats 400000\n");

        // State field types first: they can pull in structs that no function uses.
        let mut fields: Vec<(Id, String)> = self.state_field.iter().map(|(k, v)| (*k, v.clone())).collect();
        fields.sort_by_key(|(id, _)| self.g.state_vars[id].slot.as_ref().and_then(|s| s.parse::<u64>().ok()).unwrap_or(u64::MAX) * 64 + self.g.state_vars[id].offset.unwrap_or(0));
        let mut field_types = vec![];
        for (id, _) in &fields {
            let node = self.nodes.get(id).copied();
            field_types.push(node.and_then(|d| self.clone_ty(&d["typeName"])).unwrap_or_else(|| "Nat".into()));
        }

        // Structs, dependencies first.
        let mut emitted = BTreeSet::new();
        let ids: Vec<Id> = self.structs.iter().copied().collect();
        for id in ids {
            self.emit_struct(id, &mut emitted, &mut out);
        }

        let _ = writeln!(out, "/-- Storage of {} and its bases. -/\nstructure State where", self.g.contracts[&self.scope.entry].name);
        for ((id, name), ty) in fields.iter().zip(&field_types) {
            let slot = self.g.state_vars[id].slot.clone().unwrap_or_default();
            let _ = writeln!(out, "  {name} : {ty} -- slot {slot}");
        }
        let _ = writeln!(out, "deriving Inhabited\n");

        let _ = writeln!(out, "/-- Everything the model leaves open: immutables, external calls and functions it couldn't translate. -/\nstructure Ext where");
        if self.ext.is_empty() {
            let _ = writeln!(out, "  unit : Unit := ()");
        }
        for (field, why) in &self.ext {
            let _ = writeln!(out, "  /-- {why} -/\n  {field}");
            report.ext.push(field.clone());
        }
        out.push('\n');
        for (_, c) in &self.consts {
            let _ = writeln!(out, "{c}");
        }
        out.push('\n');
        for d in defs {
            let _ = writeln!(out, "{d}");
        }
        let _ = writeln!(out, "end {namespace}");
        Model { text: out, report }
    }

    fn clone_ty(&mut self, t: &Value) -> Option<String> {
        self.ty(t).ok()
    }

    fn emit_struct(&mut self, id: Id, emitted: &mut BTreeSet<Id>, out: &mut String) {
        if !emitted.insert(id) {
            return;
        }
        let d = self.nodes[&id];
        for m in d["members"].as_array().into_iter().flatten() {
            if let Some(r) = struct_ref(&m["typeName"]) {
                if self.nodes.get(&r).is_some_and(|n| n["nodeType"] == "StructDefinition") {
                    self.emit_struct(r, emitted, out);
                }
            }
        }
        let _ = writeln!(out, "structure {} where", self.struct_name(id));
        for m in d["members"].as_array().into_iter().flatten() {
            let ty = self.clone_ty(&m["typeName"]).unwrap_or_else(|| "Nat".into());
            let _ = writeln!(out, "  {} : {ty}", ident(&s(&m["name"])));
        }
        let _ = writeln!(out, "deriving Inhabited\n");
    }

    fn opaque_sig(&mut self, f: Id) -> String {
        let node = self.nodes[&f];
        let mut parts = vec![];
        for p in node["parameters"]["parameters"].as_array().into_iter().flatten() {
            let ty = self.clone_ty(&p["typeName"]).unwrap_or_else(|| "Nat".into());
            if p["storageLocation"] == "storage" {
                parts.push(format!("M State {ty}"));
                parts.push(format!("({ty} → M State Unit)"));
            } else {
                parts.push(ty);
            }
        }
        let rets: Vec<String> = node["returnParameters"]["parameters"].as_array().into_iter().flatten().map(|r| self.clone_ty(&r["typeName"]).unwrap_or_else(|| "Nat".into())).collect();
        parts.push(format!("M State {}", product(&rets)));
        parts.join(" → ")
    }
}

fn struct_ref(t: &Value) -> Option<Id> {
    match t["nodeType"].as_str()? {
        "UserDefinedTypeName" => t["referencedDeclaration"].as_i64(),
        "Mapping" => struct_ref(&t["valueType"]),
        "ArrayTypeName" => struct_ref(&t["baseType"]),
        _ => None,
    }
}

fn tuple(items: &[String]) -> String {
    match items.len() {
        0 => "()".into(),
        1 => items[0].clone(),
        _ => format!("({})", items.join(", ")),
    }
}

fn type_max(e: &Value) -> Option<String> {
    let inner = &e["expression"];
    if inner["nodeType"] != "FunctionCall" || inner["expression"]["name"] != "type" {
        return None;
    }
    let t = tstr(inner);
    let t = t.trim_start_matches("type(").trim_end_matches(')');
    let bits = bits_of(t)?;
    match s(&e["memberName"]).as_str() {
        "max" => Some(format!("(2 ^ {bits} - 1)")),
        "min" => Some("0".into()),
        _ => None,
    }
}

fn literal(e: &Value) -> R<String> {
    match s(&e["kind"]).as_str() {
        "bool" => Ok(s(&e["value"])),
        "number" => {
            let raw = s(&e["value"]).replace('_', "");
            if let Some(hex) = raw.strip_prefix("0x") {
                // Lean reads hex literals natively.
                return Ok(scale(format!("0x{hex}"), e));
            }
            if let Some((m, x)) = raw.split_once(['e', 'E']) {
                let x: u32 = x.parse().map_err(|_| "exponent")?;
                return Ok(scale(format!("({m} * 10 ^ {x})"), e));
            }
            if raw.contains('.') {
                return bail("fractional literal");
            }
            Ok(scale(raw, e))
        }
        "string" => Ok(format!("{:?}", s(&e["value"]))),
        k => bail(format!("{k} literal")),
    }
}

fn scale(n: String, e: &Value) -> String {
    let unit: u64 = match e["subdenomination"].as_str().unwrap_or("") {
        "seconds" | "wei" | "" => 1,
        "minutes" => 60,
        "hours" => 3600,
        "days" => 86400,
        "weeks" => 604800,
        "gwei" => 1_000_000_000,
        "ether" => 1_000_000_000_000_000_000,
        _ => 1,
    };
    if unit == 1 { n } else { format!("({n} * {unit})") }
}

fn collect_assigned(n: &Value, out: &mut HashSet<Id>) {
    match n {
        Value::Object(m) => {
            if n["nodeType"] == "Assignment" {
                lhs_ids(&n["leftHandSide"], out);
            }
            if n["nodeType"] == "UnaryOperation" && matches!(n["operator"].as_str(), Some("++" | "--" | "delete")) {
                lhs_ids(&n["subExpression"], out);
            }
            m.values().for_each(|v| collect_assigned(v, out));
        }
        Value::Array(a) => a.iter().for_each(|v| collect_assigned(v, out)),
        _ => {}
    }
}

fn lhs_ids(e: &Value, out: &mut HashSet<Id>) {
    match e["nodeType"].as_str().unwrap_or("") {
        "Identifier" => {
            if let Some(r) = e["referencedDeclaration"].as_i64() {
                out.insert(r);
            }
        }
        "IndexAccess" => lhs_ids(&e["baseExpression"], out),
        "MemberAccess" => lhs_ids(&e["expression"], out),
        "TupleExpression" => e["components"].as_array().into_iter().flatten().for_each(|c| lhs_ids(c, out)),
        _ => {}
    }
}

/// One function body being translated.
struct Fx<'g, 'a> {
    g: &'g mut Gen<'a>,
    out: Vec<String>,
    indent: usize,
    tmp: usize,
    unchecked: usize,
    locals: HashMap<Id, String>,
    alias: HashMap<Id, Path>,
    named: Vec<String>,
    /// Storage parameters: id → lens name.
    lens: HashMap<Id, String>,
    modifier: bool,
    placeholder: bool,
}

impl<'g, 'a> Fx<'g, 'a> {
    fn new(g: &'g mut Gen<'a>, _f: Id) -> Self {
        Fx { g, out: vec![], indent: 0, tmp: 0, unchecked: 0, locals: HashMap::new(), alias: HashMap::new(), named: vec![], lens: HashMap::new(), modifier: false, placeholder: false }
    }

    fn line(&mut self, l: String) {
        self.out.push(format!("{}{l}", "  ".repeat(self.indent)));
    }

    fn fresh(&mut self, p: &str) -> String {
        self.tmp += 1;
        format!("{p}{}", self.tmp)
    }

    /// A term that can go under a binder: plain names and numbers stay, anything else is bound first.
    fn atom(&mut self, term: String) -> String {
        if term.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '\'') || term.starts_with('«') && !term.contains(' ') {
            return term;
        }
        let a = self.fresh("a");
        self.line(format!("let {a} := {term}"));
        a
    }

    // ---------- statements ----------

    fn block(&mut self, b: &Value) -> R<()> {
        let before = self.out.len();
        let stmts = b["statements"].as_array().cloned().unwrap_or_default();
        let unchecked = b["nodeType"] == "UncheckedBlock";
        if unchecked {
            self.unchecked += 1;
        }
        for st in &stmts {
            self.stmt(st)?;
        }
        if unchecked {
            self.unchecked -= 1;
        }
        if self.out[before..].iter().all(|l| l.trim_start().starts_with("--")) {
            self.line("pure ()".into());
        }
        Ok(())
    }

    fn body(&mut self, st: &Value) -> R<()> {
        self.indent += 1;
        let r = if st["nodeType"] == "Block" || st["nodeType"] == "UncheckedBlock" {
            self.block(st)
        } else {
            let before = self.out.len();
            let r = self.stmt(st);
            if self.out.len() == before {
                self.line("pure ()".into());
            }
            r
        };
        self.indent -= 1;
        r
    }

    fn stmt(&mut self, st: &Value) -> R<()> {
        match st["nodeType"].as_str().unwrap_or("") {
            "Block" | "UncheckedBlock" => {
                // A nested block: its locals end with it, which Lean's scoping gives us inside `do`.
                let unchecked = st["nodeType"] == "UncheckedBlock";
                if unchecked {
                    self.unchecked += 1;
                }
                for s in st["statements"].as_array().cloned().unwrap_or_default() {
                    self.stmt(&s)?;
                }
                if unchecked {
                    self.unchecked -= 1;
                }
                Ok(())
            }
            "VariableDeclarationStatement" => self.declare(st),
            "ExpressionStatement" => self.expr_stmt(&st["expression"]),
            "IfStatement" => {
                let c = self.expr(&st["condition"])?;
                self.line(format!("if {c} then"));
                self.body(&st["trueBody"])?;
                if !st["falseBody"].is_null() {
                    self.line("else".into());
                    self.body(&st["falseBody"])?;
                }
                Ok(())
            }
            "Return" => {
                if self.modifier {
                    return bail("return in a modifier");
                }
                if st["expression"].is_null() {
                    let t = tuple(&self.named.clone());
                    self.line(format!("return {t}"));
                } else {
                    let t = self.expr(&st["expression"])?;
                    self.line(format!("return {t}"));
                }
                Ok(())
            }
            "RevertStatement" => {
                let name = s(&st["errorCall"]["expression"]["name"]);
                for a in st["errorCall"]["arguments"].as_array().cloned().unwrap_or_default() {
                    self.expr(&a)?;
                }
                self.line(format!("throw ⟨{name:?}⟩"));
                Ok(())
            }
            "EmitStatement" => {
                let ev = s(&st["eventCall"]["expression"]["name"]);
                self.line(format!("-- emit {ev}"));
                Ok(())
            }
            "PlaceholderStatement" => {
                if self.indent != 1 || self.placeholder {
                    return bail("`_` not once at the top of the modifier");
                }
                self.placeholder = true;
                self.line("let __r ← k".into());
                Ok(())
            }
            other => bail(format!("{other} statement")),
        }
    }

    fn declare(&mut self, st: &Value) -> R<()> {
        let decls: Vec<Value> = st["declarations"].as_array().cloned().unwrap_or_default();
        let init = &st["initialValue"];
        if decls.len() == 1 && !decls[0].is_null() {
            let d = &decls[0];
            if d["storageLocation"] == "storage" {
                let p = self.lpath(init)?;
                self.alias.insert(id_of(d), p);
                return Ok(());
            }
            let ty = self.g.ty(&d["typeName"])?;
            let v = if init.is_null() { "default".to_string() } else { self.expr(init)? };
            let n = local_ident(&s(&d["name"]));
            self.locals.insert(id_of(d), n.clone());
            self.line(format!("let mut {n} : {ty} := {v}"));
            return Ok(());
        }
        let t = self.expr(init)?;
        let t = self.atom(t);
        let n = decls.len();
        for (i, d) in decls.iter().enumerate() {
            if d.is_null() {
                continue;
            }
            if d["storageLocation"] == "storage" {
                return bail("storage pointer from a tuple");
            }
            let ty = self.g.ty(&d["typeName"])?;
            let name = local_ident(&s(&d["name"]));
            self.locals.insert(id_of(d), name.clone());
            self.line(format!("let mut {name} : {ty} := {}", proj(&t, i, n)));
        }
        Ok(())
    }

    fn expr_stmt(&mut self, e: &Value) -> R<()> {
        match e["nodeType"].as_str().unwrap_or("") {
            "Assignment" => self.assign(e),
            "UnaryOperation" => {
                let op = s(&e["operator"]);
                let sub = &e["subExpression"];
                match op.as_str() {
                    "++" | "--" => {
                        let cur = self.expr(sub)?;
                        let bits = bits_of(&tstr(sub)).ok_or("increment of a non-word")?;
                        let v = self.arith(if op == "++" { "+" } else { "-" }, bits, cur, "1".into())?;
                        let v = self.atom(v);
                        let p = self.lpath(sub)?;
                        self.write(&p, |_| v.clone())
                    }
                    "delete" => {
                        let p = self.lpath(sub)?;
                        self.write(&p, |_| "default".into())
                    }
                    _ => {
                        self.expr(e)?;
                        Ok(())
                    }
                }
            }
            "FunctionCall" => {
                let callee = &e["expression"];
                let name = s(&callee["name"]);
                let member = s(&callee["memberName"]);
                let builtin = callee["referencedDeclaration"].as_i64().is_none_or(|r| r < 0);
                if builtin && callee["nodeType"] == "Identifier" && (name == "require" || name == "assert") {
                    let args = e["arguments"].as_array().cloned().unwrap_or_default();
                    let c = self.expr(&args[0])?;
                    let reason = if name == "assert" {
                        "panic 0x01".to_string()
                    } else {
                        match args.get(1) {
                            Some(a) if a["nodeType"] == "Literal" => s(&a["value"]),
                            Some(a) if a["nodeType"] == "FunctionCall" => s(&a["expression"]["name"]),
                            _ => "require".into(),
                        }
                    };
                    self.line(format!("if !{} then throw ⟨{reason:?}⟩", paren(&c)));
                    return Ok(());
                }
                if builtin && callee["nodeType"] == "Identifier" && name == "revert" {
                    let reason = e["arguments"].get(0).map(|a| s(&a["value"])).unwrap_or_else(|| "revert".into());
                    self.line(format!("throw ⟨{reason:?}⟩"));
                    return Ok(());
                }
                if builtin && callee["nodeType"] == "MemberAccess" && (member == "push" || member == "pop") {
                    let p = self.lpath(&callee["expression"])?;
                    if member == "push" {
                        let v = match e["arguments"].get(0) {
                            Some(a) => self.expr(a)?,
                            None => "default".into(),
                        };
                        let v = self.atom(v);
                        return self.write(&p, |cur| format!("({cur}) ++ [{v}]"));
                    }
                    let cur = self.read(&p)?;
                    self.line(format!("if ({cur}).isEmpty then throw (panic \"0x31\")"));
                    return self.write(&p, |cur| format!("({cur}).dropLast"));
                }
                // A call's effects are already on their own lines; a pure result is dropped.
                self.expr(e)?;
                Ok(())
            }
            _ => {
                self.expr(e)?;
                Ok(())
            }
        }
    }

    fn assign(&mut self, e: &Value) -> R<()> {
        let op = s(&e["operator"]);
        let lhs = &e["leftHandSide"];
        if lhs["nodeType"] == "TupleExpression" {
            if op != "=" {
                return bail("compound tuple assignment");
            }
            let t = self.expr(&e["rightHandSide"])?;
            let t = self.atom(t);
            let comps = lhs["components"].as_array().cloned().unwrap_or_default();
            let n = comps.len();
            for (i, c) in comps.iter().enumerate() {
                if c.is_null() {
                    continue;
                }
                let p = self.lpath(c)?;
                let v = proj(&t, i, n);
                let v = self.atom(v);
                self.write(&p, |_| v.clone())?;
            }
            return Ok(());
        }
        // Re-pointing a storage pointer.
        if let Some(r) = lhs["referencedDeclaration"].as_i64() {
            if self.alias.contains_key(&r) {
                let p = self.lpath(&e["rightHandSide"])?;
                self.alias.insert(r, p);
                return Ok(());
            }
        }
        let rhs = self.expr(&e["rightHandSide"])?;
        let v = if op == "=" {
            rhs
        } else {
            let cur = self.expr(lhs)?;
            let bits = bits_of(&tstr(lhs)).ok_or("compound assignment on a non-word")?;
            self.arith(op.trim_end_matches('='), bits, cur, rhs)?
        };
        let v = self.atom(v);
        let p = self.lpath(lhs)?;
        self.write(&p, |_| v.clone())
    }

    // ---------- storage paths ----------

    fn lpath(&mut self, e: &Value) -> R<Path> {
        match e["nodeType"].as_str().unwrap_or("") {
            "Identifier" => {
                let r = e["referencedDeclaration"].as_i64().unwrap_or(0);
                if let Some(p) = self.alias.get(&r) {
                    return Ok(p.clone());
                }
                if let Some(l) = self.lens.get(&r) {
                    return Ok(Path { base: Base::Lens(l.clone()), steps: vec![] });
                }
                if let Some(f) = self.g.state_field.get(&r) {
                    return Ok(Path { base: Base::State(f.clone()), steps: vec![] });
                }
                if let Some(n) = self.locals.get(&r) {
                    return Ok(Path { base: Base::Local(n.clone()), steps: vec![] });
                }
                bail(format!("can't write {}", s(&e["name"])))
            }
            "IndexAccess" => {
                let mut p = self.lpath(&e["baseExpression"])?;
                let k = self.expr(&e["indexExpression"])?;
                let k = self.atom(k);
                if tstr(&e["baseExpression"]).starts_with("mapping(") {
                    p.steps.push(Step::Map(k));
                } else {
                    p.steps.push(Step::Arr(k));
                }
                Ok(p)
            }
            "MemberAccess" => {
                let t = tstr(&e["expression"]);
                if !t.starts_with("struct ") {
                    return bail(format!("member .{} isn't a struct field", s(&e["memberName"])));
                }
                let mut p = self.lpath(&e["expression"])?;
                p.steps.push(Step::Field(ident(&s(&e["memberName"]))));
                Ok(p)
            }
            "TupleExpression" => {
                let c = e["components"].as_array().ok_or("tuple")?;
                if c.len() == 1 { self.lpath(&c[0]) } else { bail("tuple path") }
            }
            other => bail(format!("can't write through {other}")),
        }
    }

    fn read(&mut self, p: &Path) -> R<String> {
        let mut cur = match &p.base {
            Base::State(f) => format!("(← get).{f}"),
            Base::Local(n) => n.clone(),
            Base::Lens(l) => {
                let t = self.fresh("__t");
                self.line(format!("let {t} ← {l}_get"));
                t
            }
        };
        for st in &p.steps {
            cur = match st {
                Step::Map(k) => format!("({cur} {k})"),
                Step::Field(f) => format!("({cur}).{f}"),
                Step::Arr(k) => {
                    let t = self.fresh("__t");
                    self.line(format!("let {t} ← idx ({cur}) {k}"));
                    t
                }
            };
        }
        Ok(cur)
    }

    /// Writes the leaf at `p`; `leaf` gets the current leaf value.
    fn write(&mut self, p: &Path, leaf: impl Fn(&str) -> String) -> R<()> {
        // Array writes revert out of bounds: check against the array before the write.
        for (i, st) in p.steps.iter().enumerate() {
            if let Step::Arr(k) = st {
                let arr = self.read(&Path { base: p.base.clone(), steps: p.steps[..i].to_vec() })?;
                self.line(format!("if !decide ({k} < ({arr}).length) then throw (panic \"0x32\")"));
            }
        }
        match &p.base {
            Base::State(f) => {
                let v = set(format!("s.{f}"), &p.steps, &leaf);
                self.line(format!("modify fun s => {{ s with {f} := {v} }}"));
            }
            Base::Local(n) => {
                let v = set(n.clone(), &p.steps, &leaf);
                self.line(format!("{n} := {v}"));
            }
            Base::Lens(l) => {
                let c = self.fresh("__t");
                self.line(format!("let {c} ← {l}_get"));
                let v = set(c, &p.steps, &leaf);
                self.line(format!("{l}_set ({v})"));
            }
        }
        Ok(())
    }

    /// The getter and setter a callee's storage parameter gets for the location `p`.
    fn lens_args(&mut self, p: &Path) -> R<(String, String)> {
        for (i, st) in p.steps.iter().enumerate() {
            if let Step::Arr(k) = st {
                let arr = self.read(&Path { base: p.base.clone(), steps: p.steps[..i].to_vec() })?;
                self.line(format!("if !decide ({k} < ({arr}).length) then throw (panic \"0x32\")"));
            }
        }
        let pure_read = |root: String| {
            let mut cur = root;
            for st in &p.steps {
                cur = match st {
                    Step::Map(k) => format!("({cur} {k})"),
                    Step::Field(f) => format!("({cur}).{f}"),
                    Step::Arr(k) => format!("(({cur}).getD {k} default)"),
                };
            }
            cur
        };
        Ok(match &p.base {
            Base::State(f) => (
                format!("(do return {})", pure_read(format!("(← get).{f}"))),
                format!("(fun x => modify fun s => {{ s with {f} := {} }})", set(format!("s.{f}"), &p.steps, &|_: &str| "x".to_string())),
            ),
            Base::Lens(l) => (
                format!("(do return {})", pure_read(format!("(← {l}_get)"))),
                format!("(fun x => do {l}_set ({}))", set(format!("(← {l}_get)"), &p.steps, &|_: &str| "x".to_string())),
            ),
            Base::Local(_) => return bail("storage reference to a local"),
        })
    }

    // ---------- expressions ----------

    fn arith(&mut self, op: &str, bits: u32, a: String, b: String) -> R<String> {
        let checked = self.unchecked == 0;
        let t = match (op, checked) {
            ("+", true) => Some(format!("addc {bits} {} {}", paren(&a), paren(&b))),
            ("-", true) => Some(format!("subc {} {}", paren(&a), paren(&b))),
            ("*", true) => Some(format!("mulc {bits} {} {}", paren(&a), paren(&b))),
            ("/", _) if checked => Some(format!("divc {} {}", paren(&a), paren(&b))),
            ("%", _) if checked => Some(format!("modc {} {}", paren(&a), paren(&b))),
            ("**", true) => Some(format!("powc {bits} {} {}", paren(&a), paren(&b))),
            _ => None,
        };
        if let Some(t) = t {
            let v = self.fresh("__t");
            self.line(format!("let {v} ← {t}"));
            return Ok(v);
        }
        Ok(match op {
            "+" => format!("(addw {bits} {} {})", paren(&a), paren(&b)),
            "-" => format!("(subw {bits} {} {})", paren(&a), paren(&b)),
            "*" => format!("(mulw {bits} {} {})", paren(&a), paren(&b)),
            "/" => {
                // Division by zero panics even in unchecked blocks.
                let v = self.fresh("__t");
                self.line(format!("let {v} ← divc {} {}", paren(&a), paren(&b)));
                v
            }
            "%" => {
                let v = self.fresh("__t");
                self.line(format!("let {v} ← modc {} {}", paren(&a), paren(&b)));
                v
            }
            "**" => format!("(({} ^ {}) % 2 ^ {bits})", paren(&a), paren(&b)),
            "<<" => format!("(shlw {bits} {} {})", paren(&a), paren(&b)),
            ">>" => format!("({} >>> {})", paren(&a), paren(&b)),
            "&" => format!("({} &&& {})", paren(&a), paren(&b)),
            "|" => format!("({} ||| {})", paren(&a), paren(&b)),
            "^" => format!("({} ^^^ {})", paren(&a), paren(&b)),
            _ => return bail(format!("operator {op}")),
        })
    }

    /// Translates a sub-expression into its own lines, for branches that must not run eagerly.
    fn branch(&mut self, e: &Value) -> R<(Vec<String>, String)> {
        let saved = std::mem::take(&mut self.out);
        let indent = self.indent;
        self.indent = 0;
        let r = self.expr(e);
        let lines = std::mem::replace(&mut self.out, saved);
        self.indent = indent;
        Ok((lines, r?))
    }

    fn emit_branch(&mut self, lines: Vec<String>, assign: String) {
        self.indent += 1;
        for l in lines {
            self.line(l);
        }
        self.line(assign);
        self.indent -= 1;
    }

    fn expr(&mut self, e: &Value) -> R<String> {
        if e["isPure"] == true && e["isConstant"] == true && !tstr(e).starts_with("bool") && e["nodeType"] != "Literal" {
            if let Ok(c) = self.g.const_expr(e) {
                return Ok(c);
            }
        }
        match e["nodeType"].as_str().unwrap_or("") {
            "Literal" => literal(e),
            "Identifier" => self.ident_expr(e),
            "MemberAccess" => self.member(e),
            "IndexAccess" => {
                if let Ok(p) = self.lpath(e) {
                    return self.read(&p);
                }
                let base = self.expr(&e["baseExpression"])?;
                let k = self.expr(&e["indexExpression"])?;
                if tstr(&e["baseExpression"]).starts_with("mapping(") {
                    return Ok(format!("({base} {k})"));
                }
                let t = self.fresh("__t");
                self.line(format!("let {t} ← idx ({base}) {k}"));
                Ok(t)
            }
            "BinaryOperation" => self.binary(e),
            "UnaryOperation" => {
                let op = s(&e["operator"]);
                match op.as_str() {
                    "!" => {
                        let a = self.expr(&e["subExpression"])?;
                        Ok(format!("(!{})", paren(&a)))
                    }
                    "~" => {
                        let a = self.expr(&e["subExpression"])?;
                        let bits = bits_of(&tstr(e)).ok_or("~ on a non-word")?;
                        Ok(format!("(2 ^ {bits} - 1 - {})", paren(&a)))
                    }
                    _ => bail(format!("unary {op} in an expression")),
                }
            }
            "Conditional" => {
                let c = self.expr(&e["condition"])?;
                let (la, a) = self.branch(&e["trueExpression"])?;
                let (lb, b) = self.branch(&e["falseExpression"])?;
                // Lean won't lift `(← …)` out of a term-level `if`, so branches that read state take the statement form.
                if la.is_empty() && lb.is_empty() && !a.contains('←') && !b.contains('←') {
                    return Ok(format!("(if {c} then {a} else {b})"));
                }
                let ty = self.g.ty_str(&tstr(e))?;
                let t = self.fresh("__t");
                self.line(format!("let mut {t} : {ty} := default"));
                self.line(format!("if {c} then"));
                self.emit_branch(la, format!("{t} := {a}"));
                self.line("else".into());
                self.emit_branch(lb, format!("{t} := {b}"));
                Ok(t)
            }
            "TupleExpression" => {
                let comps = e["components"].as_array().cloned().unwrap_or_default();
                if e["isInlineArray"] == true {
                    let items: R<Vec<String>> = comps.iter().map(|c| self.expr(c)).collect();
                    return Ok(format!("[{}]", items?.join(", ")));
                }
                if comps.len() == 1 {
                    return self.expr(&comps[0]);
                }
                let mut items = vec![];
                for c in &comps {
                    items.push(self.expr(c)?);
                }
                Ok(tuple(&items))
            }
            "FunctionCall" => self.call(e),
            other => bail(format!("{other} expression")),
        }
    }

    fn ident_expr(&mut self, e: &Value) -> R<String> {
        let r = e["referencedDeclaration"].as_i64().unwrap_or(0);
        let name = s(&e["name"]);
        if r < 0 {
            return match name.as_str() {
                "this" => Ok("(← read).self".into()),
                _ => bail(format!("builtin {name}")),
            };
        }
        if let Some(v) = self.g.g.state_vars.get(&r) {
            if v.constant {
                return self.g.constant(r);
            }
            if v.immutable {
                return Ok(format!("ext.{}", ident(&v.name)));
            }
        }
        if self.alias.contains_key(&r) || self.g.state_field.contains_key(&r) {
            let p = self.lpath(e)?;
            return self.read(&p);
        }
        if let Some(n) = self.locals.get(&r) {
            return Ok(n.clone());
        }
        if self.g.nodes.get(&r).is_some_and(|n| n["constant"] == true) {
            return self.g.constant(r);
        }
        bail(format!("reference to {name}"))
    }

    fn member(&mut self, e: &Value) -> R<String> {
        let m = s(&e["memberName"]);
        let base = &e["expression"];
        let bname = s(&base["name"]);
        if base["nodeType"] == "Identifier" && base["referencedDeclaration"].as_i64().is_some_and(|r| r < 0) {
            let field = match (bname.as_str(), m.as_str()) {
                ("msg", "sender") => "sender",
                ("msg", "value") => "value",
                ("block", "timestamp") => "timestamp",
                ("block", "number") => "number",
                ("block", "chainid") => "chainid",
                ("tx", "origin") => "origin",
                _ => return bail(format!("{bname}.{m}")),
            };
            return Ok(format!("(← read).{field}"));
        }
        if let Some(t) = type_max(e) {
            return Ok(t);
        }
        if m == "balance" && base["nodeType"] == "FunctionCall" && base["arguments"][0]["name"] == "this" {
            return Ok("(← read).balance".into());
        }
        let r = e["referencedDeclaration"].as_i64().unwrap_or(0);
        if let Some(i) = self.g.enum_index.get(&r) {
            return Ok(i.to_string());
        }
        if self.g.g.state_vars.get(&r).is_some_and(|v| v.constant) || self.g.nodes.get(&r).is_some_and(|n| n["constant"] == true && n["nodeType"] == "VariableDeclaration") {
            return self.g.constant(r);
        }
        if m == "length" {
            let b = self.expr(base)?;
            return Ok(format!("({b}).length"));
        }
        if tstr(base).starts_with("struct ") {
            if let Ok(p) = self.lpath(e) {
                return self.read(&p);
            }
            let b = self.expr(base)?;
            return Ok(format!("({b}).{}", ident(&m)));
        }
        bail(format!(".{m}"))
    }

    fn binary(&mut self, e: &Value) -> R<String> {
        let op = s(&e["operator"]);
        if op == "&&" || op == "||" {
            let a = self.expr(&e["leftExpression"])?;
            let (lb, b) = self.branch(&e["rightExpression"])?;
            if lb.is_empty() {
                return Ok(format!("({} {op} {})", paren(&a), paren(&b)));
            }
            // Short-circuit: the right side runs only when it decides.
            let t = self.fresh("__t");
            self.line(format!("let mut {t} : Bool := {a}"));
            self.line(format!("if {}{t} then", if op == "&&" { "" } else { "!" }));
            self.emit_branch(lb, format!("{t} := {b}"));
            return Ok(t);
        }
        let a = self.expr(&e["leftExpression"])?;
        let b = self.expr(&e["rightExpression"])?;
        let common = s(&e["commonType"]["typeString"]);
        match op.as_str() {
            "==" => Ok(format!("({} == {})", paren(&a), paren(&b))),
            "!=" => Ok(format!("({} != {})", paren(&a), paren(&b))),
            "<" | "<=" | ">" | ">=" => Ok(format!("(decide ({} {op} {}))", paren(&a), paren(&b))),
            _ => {
                if common.starts_with("int_const") || common.starts_with("rational") {
                    let lop = match op.as_str() {
                        "**" => "^",
                        "<<" => "<<<",
                        ">>" => ">>>",
                        o => o,
                    };
                    return Ok(format!("({} {lop} {})", paren(&a), paren(&b)));
                }
                if common.starts_with("int") {
                    return bail("signed arithmetic");
                }
                let bits = bits_of(&common).ok_or_else(|| format!("arithmetic on {common}"))?;
                self.arith(&op, bits, a, b)
            }
        }
    }

    fn call(&mut self, e: &Value) -> R<String> {
        let kind = s(&e["kind"]);
        let callee = &e["expression"];
        let args: Vec<Value> = e["arguments"].as_array().cloned().unwrap_or_default();
        if kind == "typeConversion" {
            if args[0]["nodeType"] == "Identifier" && args[0]["name"] == "this" {
                return Ok("(← read).self".into());
            }
            let a = self.expr(&args[0])?;
            let to = tstr(e);
            let from = tstr(&args[0]);
            if let (Some(tb), Some(fb)) = (bits_of(&to), bits_of(&from)) {
                if to.starts_with("uint") && tb < fb {
                    return Ok(format!("({} % 2 ^ {tb})", paren(&a)));
                }
            }
            if to.starts_with("int") {
                return bail("conversion to a signed type");
            }
            return Ok(a);
        }
        if kind == "structConstructorCall" {
            let t = tstr(e);
            let ty = self.g.ty_str(&t)?;
            let sid = *self.g.struct_by_canon.get(t.trim_start_matches("struct ").trim_end_matches(" memory")).ok_or("struct")?;
            let members: Vec<String> = self.g.nodes[&sid]["members"].as_array().into_iter().flatten().map(|m| s(&m["name"])).collect();
            let names: Vec<String> = e["names"].as_array().into_iter().flatten().map(s).collect();
            let mut fields = vec![];
            for (i, a) in args.iter().enumerate() {
                let n = if names.is_empty() { members[i].clone() } else { names[i].clone() };
                let v = self.expr(a)?;
                fields.push(format!("{} := {v}", ident(&n)));
            }
            return Ok(format!("({{ {} }} : {ty})", fields.join(", ")));
        }
        if callee["nodeType"] == "FunctionCallOptions" {
            return bail("call with {value/gas} options");
        }
        if callee["nodeType"] == "MemberAccess" && matches!(callee["memberName"].as_str(), Some("wrap" | "unwrap")) && tstr(&callee["expression"]).starts_with("type(") {
            return self.expr(&args[0]);
        }
        let target = callee["referencedDeclaration"].as_i64();
        let Some(target) = target.filter(|t| *t >= 0) else {
            return bail(format!("builtin {}{}", s(&callee["name"]), s(&callee["memberName"])));
        };
        let Some((ck, _, direct)) = self.g.calls.get(&Src::parse(e["src"].as_str().unwrap_or("")).unwrap_or(Src { start: 0, len: 0, file: -1 })).copied() else {
            return bail("call the graph didn't classify (event, error or function value)");
        };
        // Arguments, with `using for` receivers first and named arguments in parameter order.
        let tnode = self.g.nodes.get(&target).copied().ok_or("call target")?;
        let pnames: Vec<String> = tnode["parameters"]["parameters"].as_array().into_iter().flatten().map(|p| s(&p["name"])).collect();
        let mut ordered: Vec<Value> = vec![];
        let using_for = callee["nodeType"] == "MemberAccess" && !tstr(&callee["expression"]).starts_with("type(") && self.g.g.contracts.get(&self.g.g.functions.get(&target).map(|f| f.contract).unwrap_or(0)).is_some_and(|c| c.kind == "library");
        if using_for {
            ordered.push(callee["expression"].clone());
        }
        let names: Vec<String> = e["names"].as_array().into_iter().flatten().map(s).collect();
        if names.is_empty() {
            ordered.extend(args.iter().cloned());
        } else {
            for p in pnames.iter().skip(ordered.len()) {
                let i = names.iter().position(|n| n == p).ok_or("named argument")?;
                ordered.push(args[i].clone());
            }
        }

        let tname = s(&tnode["name"]);
        // OpenZeppelin's Math.mulDiv: the prelude has its exact semantics (and the lemmas to go with them). Other
        // mulDivs are translated from their own code, since they overflow and round differently.
        let oz_math = self.g.g.functions.get(&target).is_some_and(|f| {
            self.g.g.contracts.get(&f.contract).is_some_and(|c| c.name == "Math") && self.g.g.files.get(&f.src.file).is_some_and(|file| file.path.contains("openzeppelin"))
        });
        if oz_math && tname == "mulDiv" && (ordered.len() == 3 || ordered.len() == 4) {
            let mut a = vec![];
            for x in &ordered {
                let v = self.expr(x)?;
                a.push(paren(&v));
            }
            let t = self.fresh("__t");
            let lower = tname.to_lowercase();
            let call = if a.len() == 4 {
                format!("mulDivRnd {} {} {} {}", a[0], a[1], a[2], a[3])
            } else if lower.contains("up") || lower.contains("ceil") {
                format!("mulDivCeil {} {} {}", a[0], a[1], a[2])
            } else {
                format!("mulDivFloor {} {} {}", a[0], a[1], a[2])
            };
            self.line(format!("let {t} ← {call}"));
            return Ok(t);
        }

        let rets: Vec<Value> = tnode["returnParameters"]["parameters"].as_array().cloned().unwrap_or_default();
        let unit = rets.is_empty();
        match ck {
            CallKind::Internal => {
                let f = if direct { target } else { self.g.scope.resolve(self.g.g, target) };
                let storage: Vec<bool> = self.g.nodes.get(&f).and_then(|n| n["parameters"]["parameters"].as_array()).map(|ps| ps.iter().map(|p| p["storageLocation"] == "storage").collect()).unwrap_or_default();
                let mut a = vec![];
                for (i, x) in ordered.iter().enumerate() {
                    if storage.get(i) == Some(&true) {
                        let p = self.lpath(x)?;
                        let (getter, setter) = self.lens_args(&p)?;
                        a.push(getter);
                        a.push(setter);
                        continue;
                    }
                    let v = self.expr(x)?;
                    a.push(paren(&v));
                }
                let call = if self.g.status.get(&f) == Some(&true) {
                    format!("{} ext {}", self.g.lean_fn_name(f), a.join(" "))
                } else if self.g.in_progress.contains(&f) {
                    return bail(format!("recursion through {}", self.g.g.qualified(f)));
                } else {
                    format!("ext.{} {}", self.g.ext_fn_field(f), a.join(" "))
                };
                if unit {
                    self.line(call);
                    return Ok("()".into());
                }
                let t = self.fresh("__t");
                self.line(format!("let {t} ← {call}"));
                Ok(t)
            }
            CallKind::External => {
                let addr = self.expr(&callee["expression"])?;
                let addr = self.atom(addr);
                let mut a = vec![];
                for x in &ordered {
                    let v = self.expr(x)?;
                    a.push(self.atom(v));
                }
                let iface = self.g.g.functions.get(&target).map(|f| self.g.g.contracts[&f.contract].name.clone()).unwrap_or_default();
                let mut ptys = vec![];
                for p in tnode["parameters"]["parameters"].as_array().cloned().unwrap_or_default() {
                    ptys.push(self.g.ty(&p["typeName"]).map_err(|e| format!("external call argument: {e}"))?);
                }
                let mut rtys = vec![];
                for r in &rets {
                    rtys.push(self.g.ty(&r["typeName"]).map_err(|e| format!("external call result: {e}"))?);
                }
                let view = matches!(tnode["stateMutability"].as_str(), Some("view" | "pure"));
                let t = self.fresh("__t");
                if view {
                    let field = format!("view_{iface}_{tname}");
                    let ty = format!("Env → State → Nat → {}Except Revert {}", ptys.iter().map(|p| format!("{p} → ")).collect::<String>(), product(&rtys));
                    self.g.ext.insert(format!("{field} : {ty}"), format!("view call {iface}.{tname}: reads, can't write our storage"));
                    self.line(format!("let {t} ← view (fun env s => ext.{field} env s {addr} {})", a.join(" ")));
                } else {
                    let field = format!("call_{iface}_{tname}");
                    let ty = format!("Nat → {}M State {}", ptys.iter().map(|p| format!("{p} → ")).collect::<String>(), product(&rtys));
                    self.g.ext.insert(format!("{field} : {ty}"), format!("external call {iface}.{tname}: may re-enter and change our storage"));
                    self.line(format!("let {t} ← ext.{field} {addr} {}", a.join(" ")));
                }
                Ok(if unit { "()".into() } else { t })
            }
            CallKind::ExternalLibrary => bail(format!("external library call {tname}")),
            CallKind::LowLevel => bail("low-level call"),
        }
    }
}

/// The value at `cur` with the leaf under `steps` replaced by `leaf(current leaf)`.
fn set(cur: String, steps: &[Step], leaf: &dyn Fn(&str) -> String) -> String {
    match steps.first() {
        None => leaf(&cur),
        Some(Step::Map(k)) => format!("upd ({cur}) {k} ({})", set(format!("({cur} {k})"), &steps[1..], leaf)),
        Some(Step::Field(f)) => format!("{{ ({cur}) with {f} := {} }}", set(format!("({cur}).{f}"), &steps[1..], leaf)),
        Some(Step::Arr(k)) => format!("setAt ({cur}) {k} ({})", set(format!("(({cur}).getD {k} default)"), &steps[1..], leaf)),
    }
}

fn paren(t: &str) -> String {
    let simple = t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '\'') || (t.starts_with('(') && t.ends_with(')') && balanced(t)) || (t.starts_with('«') && !t.contains(' '));
    if simple { t.to_string() } else { format!("({t})") }
}

/// Whether the outer parentheses of `(…)` enclose the whole term.
fn balanced(t: &str) -> bool {
    let mut depth = 0i32;
    for (i, c) in t.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 && i != t.len() - 1 {
                    return false;
                }
            }
            _ => {}
        }
    }
    true
}
