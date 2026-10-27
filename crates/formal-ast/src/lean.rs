//! The Lean 4 model, generated from solc's AST.
//!
//! Every reachable function becomes a `do` block in `M σ α` over a world `σ` holding this contract's `State` (see
//! prelude.lean; `Ext.get`/`Ext.set` are the lens). Statements map almost one to one:
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
    /// Every function the model reached, in order: its Lean definition, or why it was left opaque.
    pub functions: Vec<FnModel>,
}

/// One Solidity function in the model.
#[derive(Debug, Clone, Serialize)]
pub struct FnModel {
    #[serde(skip)]
    pub id: Id,
    /// `Contract.name`.
    pub name: String,
    /// The Lean name (`Contract.name`), or the `Ext` field standing in for it.
    pub lean: String,
    /// The generated definition, when translated.
    pub def: Option<String>,
    /// Why it was left opaque.
    pub why: Option<String>,
}

pub struct Model {
    pub text: String,
    pub report: Report,
}

/// An external-call field of `Ext`: `call_IPoolManager_swap` and what it calls, for binding.
#[derive(Debug, Clone)]
pub struct ExtCall {
    pub field: String,
    pub iface: String,
    pub function: String,
    pub params: Vec<String>,
    pub ret: String,
    pub view: bool,
}

/// A public entry point of the model.
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub params: Vec<String>,
    /// Its Lean name inside the model's namespace; None when it's opaque.
    pub lean: Option<String>,
}

/// One contract's model in pieces, for a standalone file or a linked world.
pub struct Parts {
    pub contract: String,
    /// Linearized bases' names (to match interfaces).
    pub bases: Vec<String>,
    /// Struct definitions, dependencies first: (Lean name, definition).
    pub structs: Vec<(String, String)>,
    /// State, Ext, constants and functions.
    pub body: String,
    /// Ext fields: (name, type, why).
    pub ext: Vec<(String, String, String)>,
    pub calls: Vec<ExtCall>,
    pub entries: Vec<Entry>,
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

/// The model's own type names; user structs with these names get a trailing `_`.
const MODEL_NAMES: &[&str] = &["State", "Ext", "Env", "Revert", "M", "World"];

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

/// `bytesN` with N < 32 (left-aligned in a word).
fn bytes_n(t: &str) -> Option<u32> {
    let n: u32 = t.split_whitespace().next()?.strip_prefix("bytes")?.parse().ok()?;
    (n < 32).then_some(n)
}

/// The width of a signed type (`int24` → 24).
fn int_bits(t: &str) -> Option<u32> {
    let t = t.split_whitespace().next().unwrap_or("");
    let n = t.strip_prefix("int")?;
    if n.is_empty() { Some(256) } else { n.parse().ok() }
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
    /// User-defined value types (`BalanceDelta`) → their underlying typeString (`int256`).
    udvt: HashMap<String, String>,
    /// Enums by canonical name → how many members.
    enum_size: HashMap<String, usize>,
    /// Struct storage layouts (from solc's storageLayout): canonical name → (field, slot, byte offset, bytes, type label).
    struct_layout: HashMap<String, Vec<(String, u64, u64, u64, String)>>,
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
    /// Assembly uses `tload`/`tstore`: State gets a transient word map.
    transient: bool,
    ext_calls: BTreeMap<String, ExtCall>,
    /// Functions given a hand-written summary instead of a translation.
    summaries: Vec<String>,
}

impl<'a> Gen<'a> {
    pub fn new(output: &'a Value, g: &'a Graph, scope: &'a Scope) -> Gen<'a> {
        let mut nodes = HashMap::new();
        let mut enum_index = HashMap::new();
        let mut struct_by_canon = HashMap::new();
        let mut udvt = HashMap::new();
        let mut enum_size = HashMap::new();
        let mut struct_layout = HashMap::new();
        for contracts in output["contracts"].as_object().into_iter().flat_map(|m| m.values()) {
            for c in contracts.as_object().into_iter().flat_map(|m| m.values()) {
                let types = &c["storageLayout"]["types"];
                for t in types.as_object().into_iter().flat_map(|m| m.values()) {
                    let Some(members) = t["members"].as_array() else { continue };
                    let label = s(&t["label"]).trim_start_matches("struct ").to_string();
                    let fields = members
                        .iter()
                        .map(|m| {
                            let ty = &types[m["type"].as_str().unwrap_or("")];
                            (
                                s(&m["label"]),
                                s(&m["slot"]).parse().unwrap_or(0),
                                m["offset"].as_u64().unwrap_or(0),
                                s(&ty["numberOfBytes"]).parse().unwrap_or(32),
                                s(&ty["label"]),
                            )
                        })
                        .collect::<Vec<_>>();
                    struct_layout.insert(label, fields);
                }
            }
        }
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
                        enum_size.insert(s(&n["canonicalName"]), n["members"].as_array().map(|m| m.len()).unwrap_or(0));
                    }
                    "StructDefinition" => {
                        struct_by_canon.insert(s(&n["canonicalName"]), id_of(n));
                    }
                    "UserDefinedValueTypeDefinition" => {
                        let under = tstr(&n["underlyingType"]);
                        udvt.insert(s(&n["name"]), under.clone());
                        udvt.insert(s(&n["canonicalName"]), under);
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
            udvt,
            enum_size,
            struct_layout,
            state_field,
            fn_name: HashMap::new(),
            done: vec![],
            status: HashMap::new(),
            in_progress: HashSet::new(),
            structs: BTreeSet::new(),
            consts: vec![],
            ext: BTreeMap::new(),
            calls,
            transient: false,
            ext_calls: BTreeMap::new(),
            summaries: vec![],
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
                } else if int_bits(&n).is_some() {
                    Ok("Int".into())
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
                if k != "Nat" && k != "Int" {
                    return bail("mapping key that isn't a word");
                }
                Ok(format!("({k} → {})", self.ty(&t["valueType"])?))
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
        if let Some(under) = self.udvt.get(t).cloned() {
            return self.ty_str(&under);
        }
        if int_bits(t).is_some() || t.starts_with("int_const -") {
            return Ok("Int".into());
        }
        if let Some(rest) = t.strip_suffix(" memory").or_else(|| t.strip_suffix(" storage ref")).or_else(|| t.strip_suffix(" storage pointer")).or_else(|| t.strip_suffix(" calldata")) {
            return self.ty_str(rest);
        }
        if let Some(inner) = t.strip_prefix("tuple(").and_then(|t| t.strip_suffix(')')) {
            // Split at top-level commas.
            let (mut parts, mut depth, mut cur) = (vec![], 0, String::new());
            for c in inner.chars() {
                match c {
                    '(' | '[' => depth += 1,
                    ')' | ']' => depth -= 1,
                    ',' if depth == 0 => {
                        parts.push(std::mem::take(&mut cur));
                        continue;
                    }
                    _ => {}
                }
                cur.push(c);
            }
            if !cur.is_empty() {
                parts.push(cur);
            }
            let mut tys = vec![];
            for p in parts {
                tys.push(self.ty_str(&p)?);
            }
            return Ok(product(&tys));
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

    /// A typeString with user-defined value types replaced by what they wrap.
    fn norm(&self, t: &str) -> String {
        let t = t.trim();
        self.udvt.get(t).cloned().unwrap_or_else(|| t.to_string())
    }

    fn struct_name(&self, id: Id) -> String {
        // A struct named like the model's own types (`AsyncFiller.State`) would shadow them inside its namespace.
        let canon = self.nodes[&id]["canonicalName"].as_str().unwrap_or("S");
        let parts: Vec<String> = canon.split('.').map(|p| if MODEL_NAMES.contains(&p) { format!("{p}_") } else { p.to_string() }).collect();
        parts.iter().map(|p| ident(p)).collect::<Vec<_>>().join(".")
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
                if let Some(sel) = selector(e, &self.nodes) {
                    return Ok(sel);
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
            "UnaryOperation" if e["operator"] == "-" => Ok(format!("(-{})", self.const_expr(&e["subExpression"])?)),
            "FunctionCall" if e["kind"] == "typeConversion" => {
                let a = self.const_expr(&e["arguments"][0])?;
                Ok(a)
            }
            "FunctionCall" if matches!(e["expression"]["memberName"].as_str(), Some("wrap" | "unwrap")) => self.const_expr(&e["arguments"][0]),
            "FunctionCall" if e["expression"]["name"] == "keccak256" => {
                // keccak256 of a literal: computed here, exactly.
                let bytes = literal_bytes(&e["arguments"][0]).ok_or("keccak256 of a non-literal constant")?;
                Ok(keccak_hex(&bytes))
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
            if c.kind.runs_here() {
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
        if let Some(text) = self.summary(f) {
            return Ok(text);
        }
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
                params.push(format!("({base}_get : M σ {ty}) ({base}_set : {ty} → M σ Unit)"));
                continue;
            }
            fx.locals.insert(id_of(p), n.clone());
            fx.params.push((n.clone(), tstr(p), s(&p["storageLocation"])));
            if assigned.contains(&id_of(p)) {
                if p["storageLocation"] == "memory" && ty != "Nat" && ty != "Bool" {
                    return bail("writes to a memory parameter (shared with the caller)");
                }
                mut_params.push(n.clone());
            }
            params.push(format!("({n} : {ty})"));
        }
        fx.rets = node["returnParameters"]["parameters"].as_array().cloned().unwrap_or_default();
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
        if modifier {
            fx.line("let mut __r : α := default".into());
        }
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
            let _ = writeln!(out, "def {name} {{σ α : Type}} [Inhabited α] (ext : Ext σ) {} (k : M σ α) : M σ α := do\n{body}", params.join(" "));
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
            let _ = writeln!(out, "def {name} {{σ : Type}} (ext : Ext σ) {} : M σ {ret} := do\n{body}", params.join(" "));
        } else {
            let _ = writeln!(out, "def {name} {{σ : Type}} (ext : Ext σ) {} : M σ {ret} :=\n  {head}do\n{body}{tail}", params.join(" "));
        }
        Ok(out)
    }

    /// The contract's ABI entry point: the selector picks a public function, its arguments are decoded, its results
    /// encoded, as the compiled dispatcher does. Selectors the model doesn't translate go to `Ext.dispatch_other`.
    fn dispatch(&mut self) -> String {
        let mut cases = vec![];
        for f in self.scope.surface.clone() {
            let node = self.nodes[&f];
            let Some(sel) = node["functionSelector"].as_str().map(|s| s.to_string()) else { continue };
            if self.status.get(&f) != Some(&true) {
                continue;
            }
            let name = self.lean_fn_name(f);
            let types: Vec<String> = node["parameters"]["parameters"].as_array().into_iter().flatten().map(tstr).collect();
            let rets: Vec<String> = node["returnParameters"]["parameters"].as_array().into_iter().flatten().map(tstr).collect();
            let mut fx = Fx::new(self, f);
            fx.indent = 1;
            let case = (|| -> R<Vec<String>> {
                let args = fx.abi_decode_tuple(&types, "args", "0")?;
                let call = format!("{name} ext {}", args.iter().map(|a| paren(a)).collect::<Vec<_>>().join(" "));
                if rets.is_empty() {
                    fx.line(call);
                    fx.line("return []".into());
                } else {
                    fx.line(format!("let r ← {call}"));
                    let items: Vec<(String, String)> = rets.iter().enumerate().map(|(i, t)| (t.clone(), proj("r", i, rets.len()))).collect();
                    let enc = fx.abi_encode(&items)?;
                    fx.line(format!("return {enc}"));
                }
                Ok(std::mem::take(&mut fx.out))
            })();
            if let Ok(lines) = case {
                cases.push((sel, lines));
            }
        }
        // One small definition per selector keeps each `do` block simple; the dispatcher is a plain if/else chain.
        let mut out = String::new();
        for (sel, lines) in &cases {
            let _ = writeln!(out, "def dispatch_{sel} {{σ : Type}} (ext : Ext σ) (args : (List Nat)) : M σ (List Nat) := do\n{}\n", lines.join("\n"));
        }
        let mut chain = "ext.dispatch_other data".to_string();
        for (sel, _) in cases.iter().rev() {
            chain = format!("if sel == 0x{sel} then dispatch_{sel} ext args\n  else {chain}");
        }
        let _ = writeln!(
            out,
            "/-- The ABI entry point: selector → decoded arguments → the function → encoded results. -/\ndef dispatch {{σ : Type}} (ext : Ext σ) (data : (List Nat)) : M σ (List Nat) :=\n  let sel := bytesWordAt data 0 / 2 ^ 224\n  let args := data.drop 4\n  {chain}\n"
        );
        out
    }

    /// Hand-written definitions for library functions whose code is plumbing the generator doesn't translate.
    /// Each follows the code line by line; the report lists them as summaries.
    fn summary(&mut self, f: Id) -> Option<String> {
        let func = &self.g.functions[&f];
        let contract = self.g.contracts.get(&func.contract)?.name.clone();
        if !self.g.is_dependency(f) {
            return None;
        }
        match (contract.as_str(), func.name.as_str(), func.signature.as_str()) {
            // v4-core Hooks.callHook: a raw call to the hook with `data`; a failed call reverts (bubbled); the
            // returned data must hold at least a word whose selector matches the one called.
            ("Hooks", "callHook", _) => {
                let name = self.lean_fn_name(f);
                self.ext.insert("rawCall : Nat → Nat → List Nat → M σ (List Nat)".into(), "a low-level call (address, value, calldata) → returndata; reverts when the callee reverts".into());
                self.summaries.push(self.g.qualified(f));
                Some(
                    [
                        "/-- Hooks.callHook (summary of its code: the raw call, the returned data, the selector check) -/".to_string(),
                        format!("def {name} {{σ : Type}} (ext : Ext σ) (self : Nat) (data : (List Nat)) : M σ (List Nat) := do"),
                        "  let result ← ext.rawCall self 0 data".into(),
                        "  if decide (result.length < 32) || bytesWordAt result 0 / 2 ^ 224 != bytesWordAt data 0 / 2 ^ 224 then".into(),
                        "    throw ⟨\"InvalidHookResponse\"⟩".into(),
                        "  return result\n".into(),
                    ]
                    .join("\n"),
                )
            }
            _ => None,
        }
    }

    /// A standalone model: the prelude, then everything in `namespace`.
    pub fn generate(self, namespace: &str) -> Model {
        let p = self.parts();
        let mut out = String::new();
        let _ = writeln!(out, "/-\n  Generated by formal-ast from solc's AST. Don't edit: regenerate.\n  Entry: {}\n  Translated: {} functions. Opaque (in `Ext`): {}.\n-/", p.contract, p.report.translated.len(), p.report.opaque.len());
        out.push_str(PRELUDE);
        let _ = writeln!(out, "\nnamespace {namespace}\nopen FormalAst\nset_option linter.unusedVariables false\nset_option maxHeartbeats 400000\n");
        for (_, text) in &p.structs {
            out.push_str(text);
        }
        out.push_str(&p.body);
        let _ = writeln!(out, "end {namespace}");
        Model { text: out, report: p.report }
    }

    /// The model for the scope's surface, in pieces.
    pub fn parts(mut self) -> Parts {
        self.ext.insert("dispatch_other : List Nat → M σ (List Nat)".into(), "calls to selectors the model doesn't dispatch (and fallback/receive)".into());
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
        let mut report = Report { translated: vec![], opaque: vec![], ext: vec![], functions: vec![] };
        let done = std::mem::take(&mut self.done);
        let mut defs = vec![];
        for (f, r) in &done {
            match r {
                Ok(text) => {
                    report.translated.push(self.g.qualified(*f));
                    let lean = self.fn_name.get(f).cloned().unwrap_or_default();
                    report.functions.push(FnModel { id: *f, name: self.g.qualified(*f), lean, def: Some(text.clone()), why: None });
                    defs.push(text.clone());
                }
                Err(why) => {
                    report.opaque.push((self.g.qualified(*f), why.clone()));
                    report.functions.push(FnModel { id: *f, name: self.g.qualified(*f), lean: self.ext_fn_field(*f), def: None, why: Some(why.clone()) });
                    let sig = self.opaque_sig(*f);
                    self.ext.insert(format!("{} : {sig}", self.ext_fn_field(*f)), format!("opaque {}: {why}", self.g.qualified(*f)));
                }
            }
        }

        let mut out = String::new();

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
        let mut structs = vec![];
        let ids: Vec<Id> = self.structs.iter().copied().collect();
        for id in ids {
            self.emit_struct(id, &mut emitted, &mut structs);
        }

        let _ = writeln!(out, "/-- Storage of {} and its bases. -/\nstructure State where", self.g.contracts[&self.scope.entry].name);
        for ((id, name), ty) in fields.iter().zip(&field_types) {
            let slot = self.g.state_vars[id].slot.clone().unwrap_or_default();
            let _ = writeln!(out, "  {name} : {ty} -- slot {slot}");
        }
        if self.transient {
            let _ = writeln!(out, "  /-- EIP-1153 transient storage, by slot (cleared after each transaction). -/\n  «transient» : Nat → Nat");
        }
        let _ = writeln!(out, "deriving Inhabited\n");

        let _ = writeln!(out, "/-- Everything the model leaves open: immutables, external calls and functions it couldn't translate. -/\nstructure Ext (σ : Type) where\n  /-- This contract's storage within the world `σ`. -/\n  get : σ → State\n  set : σ → State → σ");
        let mut ext = vec![];
        for (field, why) in &self.ext {
            let _ = writeln!(out, "  /-- {why} -/\n  {field}");
            report.ext.push(field.clone());
            if let Some((name, ty)) = field.split_once(" : ") {
                ext.push((name.to_string(), ty.to_string(), why.clone()));
            }
        }
        out.push('\n');
        for (_, c) in &self.consts {
            let _ = writeln!(out, "{c}");
        }
        out.push('\n');
        for d in defs {
            let _ = writeln!(out, "{d}");
        }
        let dispatch = self.dispatch();
        out.push_str(&dispatch);
        let entries = self
            .scope
            .surface
            .iter()
            .map(|f| {
                let node = self.nodes[f];
                Entry {
                    name: s(&node["name"]),
                    params: node["parameters"]["parameters"].as_array().into_iter().flatten().map(|p| self.clone_ty(&p["typeName"]).unwrap_or_default()).collect(),
                    lean: (self.status.get(f) == Some(&true)).then(|| self.fn_name[f].clone()),
                }
            })
            .collect();
        let entry = &self.g.contracts[&self.scope.entry];
        Parts {
            contract: entry.name.clone(),
            bases: entry.bases.iter().map(|b| self.g.contracts[b].name.clone()).collect(),
            structs,
            body: out,
            ext,
            calls: self.ext_calls.values().cloned().collect(),
            entries,
            report,
        }
    }

    fn clone_ty(&mut self, t: &Value) -> Option<String> {
        self.ty(t).ok()
    }

    fn emit_struct(&mut self, id: Id, emitted: &mut BTreeSet<Id>, list: &mut Vec<(String, String)>) {
        if !emitted.insert(id) {
            return;
        }
        let mut out = String::new();
        let out = &mut out;
        let d = self.nodes[&id];
        for m in d["members"].as_array().into_iter().flatten() {
            if let Some(r) = struct_ref(&m["typeName"]) {
                if self.nodes.get(&r).is_some_and(|n| n["nodeType"] == "StructDefinition") {
                    self.emit_struct(r, emitted, list);
                }
            }
        }
        let _ = writeln!(out, "structure {} where", self.struct_name(id));
        for m in d["members"].as_array().into_iter().flatten() {
            let ty = self.clone_ty(&m["typeName"]).unwrap_or_else(|| "Nat".into());
            let _ = writeln!(out, "  {} : {ty}", ident(&s(&m["name"])));
        }
        let _ = writeln!(out, "deriving Inhabited\n");
        list.push((self.struct_name(id), out.clone()));
    }

    fn opaque_sig(&mut self, f: Id) -> String {
        let node = self.nodes[&f];
        let mut parts = vec![];
        for p in node["parameters"]["parameters"].as_array().into_iter().flatten() {
            let ty = self.clone_ty(&p["typeName"]).unwrap_or_else(|| "Nat".into());
            if p["storageLocation"] == "storage" {
                parts.push(format!("M σ {ty}"));
                parts.push(format!("({ty} → M σ Unit)"));
            } else {
                parts.push(ty);
            }
        }
        let rets: Vec<String> = node["returnParameters"]["parameters"].as_array().into_iter().flatten().map(|r| self.clone_ty(&r["typeName"]).unwrap_or_else(|| "Nat".into())).collect();
        parts.push(format!("M σ {}", product(&rets)));
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
    if let Some(b) = int_bits(t) {
        return match s(&e["memberName"]).as_str() {
            "max" => Some(format!("((2 ^ {} : Nat) - 1 : Int)", b - 1)),
            "min" => Some(format!("(-((2 ^ {} : Nat) : Int))", b - 1)),
            _ => None,
        };
    }
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
            if raw.contains(['e', 'E', '.']) {
                return decimal(&raw, e);
            }
            Ok(scale(raw, e))
        }
        "string" => Ok(format!("{:?}", s(&e["value"]))),
        k => bail(format!("{k} literal")),
    }
}

/// A decimal or scientific literal (`0.25e18`, `1.5 ether`, `2e3`) as the exact `Nat` solc computes: the mantissa's
/// digits times a power of ten, times the unit. Solidity rejects a literal whose value isn't an integer, so the only
/// bail is for one too large to check in u128.
fn decimal(raw: &str, e: &Value) -> R<String> {
    let (m, x) = raw.split_once(['e', 'E']).unwrap_or((raw, "0"));
    let x: i64 = x.parse().map_err(|_| "exponent")?;
    let (int, frac) = m.split_once('.').unwrap_or((m, ""));
    let mut digits = format!("{int}{frac}").trim_start_matches('0').to_string();
    let mut k = x - frac.len() as i64;
    while k < 0 && digits.ends_with('0') {
        digits.pop();
        k += 1;
    }
    if digits.is_empty() {
        return Ok("0".into());
    }
    if k >= 0 {
        return Ok(scale(if k == 0 { digits } else { format!("({digits} * 10 ^ {k})") }, e));
    }
    let d: u128 = digits.parse().map_err(|_| "literal too large")?;
    let v = d.checked_mul(unit(e) as u128).ok_or("literal too large")?;
    let p = 10u128.checked_pow((-k) as u32).ok_or("literal too large")?;
    if v % p != 0 {
        return bail("fractional literal");
    }
    Ok((v / p).to_string())
}

fn unit(e: &Value) -> u64 {
    match e["subdenomination"].as_str().unwrap_or("") {
        "minutes" => 60,
        "hours" => 3600,
        "days" => 86400,
        "weeks" => 604800,
        "gwei" => 1_000_000_000,
        "ether" => 1_000_000_000_000_000_000,
        _ => 1,
    }
}

fn scale(n: String, e: &Value) -> String {
    let unit = unit(e);
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
            if n["nodeType"] == "InlineAssembly" {
                // Outside variables assigned inside the assembly.
                let mut targets = HashSet::new();
                fn yul_targets(v: &Value, t: &mut HashSet<String>) {
                    match v {
                        Value::Object(m) => {
                            if v["nodeType"] == "YulAssignment" {
                                for n in v["variableNames"].as_array().into_iter().flatten() {
                                    t.insert(s(&n["src"]));
                                }
                            }
                            m.values().for_each(|x| yul_targets(x, t));
                        }
                        Value::Array(a) => a.iter().for_each(|x| yul_targets(x, t)),
                        _ => {}
                    }
                }
                yul_targets(&n["AST"], &mut targets);
                for r in n["externalReferences"].as_array().into_iter().flatten() {
                    if targets.contains(&s(&r["src"])) {
                        out.extend(r["declaration"].as_i64());
                    }
                }
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
    /// The "finished normally" flag of each enclosing loop.
    loops: Vec<String>,
    /// The function's parameters: (Lean name, typeString, data location).
    params: Vec<(String, String, String)>,
    /// The return parameters' declarations, for typing returned literals.
    rets: Vec<Value>,
    /// Storage parameters: id → lens name.
    lens: HashMap<Id, String>,
    modifier: bool,
    placeholder: bool,
}

impl<'g, 'a> Fx<'g, 'a> {
    fn new(g: &'g mut Gen<'a>, _f: Id) -> Self {
        Fx { g, out: vec![], indent: 0, tmp: 0, unchecked: 0, locals: HashMap::new(), alias: HashMap::new(), named: vec![], loops: vec![], params: vec![], rets: vec![], lens: HashMap::new(), modifier: false, placeholder: false }
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
                    let e = &st["expression"];
                    let rets = self.rets.clone();
                    let t = if e["nodeType"] == "TupleExpression" && rets.len() > 1 {
                        let mut items = vec![];
                        for (i, c) in e["components"].as_array().cloned().unwrap_or_default().iter().enumerate() {
                            items.push(self.expr_for(c, &rets, i)?);
                        }
                        tuple(&items)
                    } else {
                        self.expr_for(e, &rets, 0)?
                    };
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
            "InlineAssembly" => self.assembly(st),
            "WhileStatement" | "ForStatement" | "DoWhileStatement" => self.loop_stmt(st),
            "Break" => {
                let done = self.loops.last().cloned().ok_or("break outside a loop")?;
                self.line(format!("{done} := true"));
                self.line("break".into());
                Ok(())
            }
            "Continue" => {
                if self.loops.is_empty() {
                    return bail("continue outside a loop");
                }
                self.line("continue".into());
                Ok(())
            }
            "TryStatement" => self.try_stmt(st),
            "PlaceholderStatement" => {
                if self.placeholder {
                    return bail("`_` more than once in a modifier");
                }
                // When the modifier skips `_`, the function returns its defaults.
                self.placeholder = true;
                self.line("__r ← k".into());
                Ok(())
            }
            other => bail(format!("{other} statement")),
        }
    }

    // ---------- loops and try ----------

    /// A loop runs at most `loopBound` times (gas bounds it on chain); running out reverts, so every path that
    /// doesn't revert is a real one.
    fn loop_stmt(&mut self, st: &Value) -> R<()> {
        let kind = st["nodeType"].as_str().unwrap_or("");
        let post = &st["loopExpression"];
        let has_continue = st["body"].to_string().contains("\"nodeType\":\"Continue\"");
        if has_continue && (kind == "DoWhileStatement" || (kind == "ForStatement" && !post.is_null())) {
            return bail("continue in a loop with a step");
        }
        if kind == "ForStatement" && !st["initializationExpression"].is_null() {
            self.stmt(&st["initializationExpression"])?;
        }
        let done = self.fresh("__done");
        self.line(format!("let mut {done} := false"));
        self.line("for _ in [0:loopBound] do".into());
        self.indent += 1;
        self.loops.push(done.clone());
        let check = |fx: &mut Self| -> R<()> {
            if st["condition"].is_null() {
                return Ok(());
            }
            let c = fx.expr(&st["condition"])?;
            fx.line(format!("if !{} then", paren(&c)));
            fx.indent += 1;
            fx.line(format!("{done} := true"));
            fx.line("break".into());
            fx.indent -= 1;
            Ok(())
        };
        if kind != "DoWhileStatement" {
            check(self)?;
        }
        if st["body"]["nodeType"] == "Block" {
            for b in st["body"]["statements"].as_array().cloned().unwrap_or_default() {
                self.stmt(&b)?;
            }
        } else {
            self.stmt(&st["body"])?;
        }
        if !post.is_null() {
            self.stmt(post)?;
        }
        if kind == "DoWhileStatement" {
            check(self)?;
        }
        self.loops.pop();
        self.indent -= 1;
        self.line(format!("if !{done} then throw ⟨\"loop bound\"⟩"));
        Ok(())
    }

    /// `try ext.f() returns (…) { … } catch { … }`: a failed call's effects are rolled back (StateT's `tryCatch`),
    /// exactly like the EVM's call frame.
    fn try_stmt(&mut self, st: &Value) -> R<()> {
        let clauses: Vec<Value> = st["clauses"].as_array().cloned().unwrap_or_default();
        if clauses.len() != 2 {
            return bail("try with several catch clauses");
        }
        let (lines, v) = self.branch(&st["externalCall"])?;
        let ok = self.fresh("__try");
        self.line(format!("let {ok} ← tryCatch (do"));
        self.indent += 2;
        for l in lines {
            self.line(l);
        }
        self.line(format!("pure (Sum.inl {}))", paren(&v)));
        self.indent -= 2;
        self.line("  (fun e => pure (Sum.inr e))".into());
        self.line(format!("match {ok} with"));
        let rv = self.fresh("__v");
        self.line(format!("| .inl {rv} =>"));
        self.indent += 1;
        let params: Vec<Value> = clauses[0]["parameters"]["parameters"].as_array().cloned().unwrap_or_default();
        for (i, p) in params.iter().enumerate() {
            let ty = self.g.ty(&p["typeName"])?;
            let n = local_ident(&s(&p["name"]));
            self.locals.insert(id_of(p), n.clone());
            self.line(format!("let mut {n} : {ty} := {}", proj(&rv, i, params.len())));
        }
        self.block(&clauses[0]["block"])?;
        self.indent -= 1;
        let ev = self.fresh("__e");
        self.line(format!("| .inr {ev} =>"));
        self.indent += 1;
        let catch = &clauses[1];
        match s(&catch["errorName"]).as_str() {
            "" => {
                // `catch (bytes memory data)`: the revert data isn't modelled.
                for p in catch["parameters"]["parameters"].as_array().cloned().unwrap_or_default() {
                    let n = local_ident(&s(&p["name"]));
                    self.locals.insert(id_of(&p), n.clone());
                    self.line(format!("let mut {n} : List Nat := []"));
                }
            }
            "Error" => {
                for p in catch["parameters"]["parameters"].as_array().cloned().unwrap_or_default() {
                    let n = local_ident(&s(&p["name"]));
                    self.locals.insert(id_of(&p), n.clone());
                    self.line(format!("let mut {n} : String := {ev}.reason"));
                }
            }
            other => return bail(format!("catch {other}")),
        }
        self.block(&catch["block"])?;
        self.indent -= 1;
        Ok(())
    }

    // ---------- inline assembly (Yul) ----------

    fn assembly(&mut self, n: &Value) -> R<()> {
        let mut refs = HashMap::new();
        for r in n["externalReferences"].as_array().into_iter().flatten() {
            refs.insert(s(&r["src"]), (r["declaration"].as_i64().unwrap_or(0), r["isSlot"] == true, r["isOffset"] == true));
        }
        let mut y = Yul { refs, vars: vec![HashMap::new()], mem: HashMap::new(), slots: HashMap::new() };
        self.line("-- assembly".into());
        self.yul_block(&n["AST"], &mut y)
    }

    fn yul_block(&mut self, b: &Value, y: &mut Yul) -> R<()> {
        let stmts = b["statements"].as_array().cloned().unwrap_or_default();
        // A block that ends in `revert(…)` and changes nothing on the way is just a revert: the data is unmodelled.
        if let Some(last) = stmts.last() {
            if yul_call_name(last) == Some("revert") && !stmts.iter().any(yul_has_effects) {
                self.line("throw ⟨\"revert\"⟩".into());
                return Ok(());
            }
        }
        y.vars.push(HashMap::new());
        let before = self.out.len();
        for st in &stmts {
            self.yul_stmt(st, y)?;
        }
        if self.out[before..].iter().all(|l| l.trim_start().starts_with("--")) {
            self.line("pure ()".into());
        }
        y.vars.pop();
        Ok(())
    }

    fn yul_body(&mut self, b: &Value, y: &mut Yul) -> R<()> {
        self.indent += 1;
        // Memory written inside a branch is unknown after it.
        let saved = y.mem.clone();
        let r = self.yul_block(b, y);
        let changed: Vec<u64> = y.mem.keys().filter(|k| saved.get(k) != y.mem.get(k)).copied().collect();
        for k in changed {
            y.mem.remove(&k);
        }
        self.indent -= 1;
        r
    }

    fn yul_stmt(&mut self, st: &Value, y: &mut Yul) -> R<()> {
        match st["nodeType"].as_str().unwrap_or("") {
            "YulVariableDeclaration" => {
                let vars: Vec<String> = st["variables"].as_array().into_iter().flatten().map(|v| s(&v["name"])).collect();
                if vars.len() != 1 {
                    return bail("Yul multi-variable declaration");
                }
                let v = if st["value"].is_null() { "0".to_string() } else { self.yul_expr(&st["value"], y)? };
                if y.slots.contains_key(&v) {
                    // A storage location, not a number: the name just refers to it.
                    y.vars.last_mut().unwrap().insert(vars[0].clone(), v);
                    return Ok(());
                }
                let name = format!("{}_{}", yul_var(&vars[0]).trim_matches(|c| c == '«' || c == '»'), self.fresh(""));
                let name = ident(&name);
                y.vars.last_mut().unwrap().insert(vars[0].clone(), name.clone());
                self.line(format!("let mut {name} : Nat := {v}"));
                Ok(())
            }
            "YulAssignment" => {
                let names: Vec<&Value> = st["variableNames"].as_array().into_iter().flatten().collect();
                if names.len() != 1 {
                    return bail("Yul multi-assignment");
                }
                let v = self.yul_expr(&st["value"], y)?;
                self.yul_assign(names[0], v, y)
            }
            "YulExpressionStatement" => {
                let e = &st["expression"];
                let name = yul_call_name(st).unwrap_or("");
                let args: Vec<Value> = e["arguments"].as_array().cloned().unwrap_or_default();
                match name {
                    "sstore" if self.yul_slot(&args[0], y)?.is_some() => {
                        let r = self.yul_slot(&args[0], y)?.unwrap();
                        let v = self.yul_expr(&args[1], y)?;
                        let v = self.atom(v);
                        self.slot_write(&r, &v)
                    }
                    "sstore" => {
                        let (field, ty) = self.yul_state_slot(&args[0], y)?;
                        let v = self.yul_expr(&args[1], y)?;
                        let v = self.atom(word_to(&ty, &v));
                        self.line(format!("modify fun w => ext.set w (let s := ext.get w; {{ s with {field} := {v} }})"));
                        Ok(())
                    }
                    "tstore" => {
                        self.g.transient = true;
                        let k = self.yul_expr(&args[0], y)?;
                        let k = self.atom(k);
                        let v = self.yul_expr(&args[1], y)?;
                        let v = self.atom(v);
                        self.line(format!("modify fun w => ext.set w (let s := ext.get w; {{ s with «transient» := upd s.«transient» {k} {v} }})"));
                        Ok(())
                    }
                    "mstore" => {
                        let off = yul_const(&args[0]).ok_or("mstore at a computed offset")?;
                        let v = self.yul_expr(&args[1], y)?;
                        if y.slots.contains_key(&v) {
                            y.mem.insert(off, v);
                            return Ok(());
                        }
                        let m = self.fresh("m");
                        self.line(format!("let {m} := {v}"));
                        y.mem.insert(off, m);
                        Ok(())
                    }
                    "revert" => {
                        self.line("throw ⟨\"revert\"⟩".into());
                        Ok(())
                    }
                    "invalid" => {
                        self.line("throw (panic \"invalid\")".into());
                        Ok(())
                    }
                    "pop" => {
                        self.yul_expr(&args[0], y)?;
                        Ok(())
                    }
                    n if n.starts_with("log") => Ok(()),
                    other => bail(format!("Yul {other}")),
                }
            }
            "YulIf" => {
                let c = self.yul_expr(&st["condition"], y)?;
                self.line(format!("if {} != 0 then", paren(&c)));
                self.yul_body(&st["body"], y)
            }
            "YulSwitch" => {
                let e = self.yul_expr(&st["expression"], y)?;
                let e = self.atom(e);
                let cases: Vec<Value> = st["cases"].as_array().cloned().unwrap_or_default();
                let mut first = true;
                let mut default = None;
                for c in &cases {
                    if c["value"] == "default" {
                        default = Some(c.clone());
                        continue;
                    }
                    let v = yul_literal(&c["value"])?;
                    self.line(format!("{}if {e} == {v} then", if first { "" } else { "else " }));
                    self.yul_body(&c["body"], y)?;
                    first = false;
                }
                if let Some(d) = default {
                    if first {
                        return self.yul_block(&d["body"], y);
                    }
                    self.line("else".into());
                    self.yul_body(&d["body"], y)?;
                }
                Ok(())
            }
            "YulBlock" => self.yul_block(st, y),
            other => bail(format!("{other} in assembly")),
        }
    }

    /// Assigns a Yul value to a Yul variable or an outside Solidity variable (converted to its type).
    fn yul_assign(&mut self, target: &Value, v: String, y: &mut Yul) -> R<()> {
        let name = s(&target["name"]);
        if let Some(lean) = y.var(&name) {
            self.line(format!("{lean} := {v}"));
            return Ok(());
        }
        let (decl, slot, offset) = *y.refs.get(&s(&target["src"])).ok_or_else(|| format!("assignment to {name} in assembly"))?;
        if slot || offset {
            return bail("assignment to .slot/.offset");
        }
        let ty = self.g.nodes.get(&decl).map(|d| tstr(d)).unwrap_or_default();
        let n = self.locals.get(&decl).cloned().ok_or_else(|| format!("assembly writes {name}"))?;
        let v = word_to(&self.g.norm(&ty), &v);
        self.line(format!("{n} := {v}"));
        Ok(())
    }

    /// The storage location a Yul slot expression names: a placeholder, a variable holding one, or `add(p, k)`.
    fn yul_slot(&mut self, e: &Value, y: &mut Yul) -> R<Option<SlotRef>> {
        match e["nodeType"].as_str().unwrap_or("") {
            "YulIdentifier" => {
                let name = s(&e["name"]);
                if let Some(v) = y.var(&name) {
                    return Ok(y.slots.get(&v).cloned());
                }
                let (_, slot, _) = y.refs.get(&s(&e["src"])).copied().unwrap_or((0, false, false));
                if !slot {
                    return Ok(None);
                }
                let t = self.yul_expr(e, y)?;
                Ok(y.slots.get(&t).cloned())
            }
            "YulFunctionCall" if yul_call_name(e) == Some("add") => {
                let args = e["arguments"].as_array().cloned().unwrap_or_default();
                for (a, b) in [(0, 1), (1, 0)] {
                    if let (Some(r), Some(k)) = (self.yul_slot(&args[a], y)?, yul_const(&args[b])) {
                        return Ok(Some(SlotRef { extra: r.extra + k, ..r }));
                    }
                }
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    /// The fields of a struct stored in slot `k` of it: (field, byte offset, bytes, type).
    fn packed(&self, r: &SlotRef) -> R<Vec<(String, u64, u64, String)>> {
        let name = r.ty.trim_start_matches("struct ");
        let layout = self.g.struct_layout.get(name).ok_or_else(|| format!("no storage layout for {name}"))?;
        let fields: Vec<_> = layout.iter().filter(|f| f.1 == r.extra).map(|f| (f.0.clone(), f.2, f.3, f.4.clone())).collect();
        if fields.is_empty() || fields.iter().any(|f| f.3.starts_with("mapping") || f.3.starts_with("struct") || f.3.contains('[')) {
            return bail("sload/sstore of a struct slot that isn't plain values");
        }
        Ok(fields)
    }

    /// `sstore` to a named location: a value slot is that value; a struct slot unpacks into the fields it holds.
    fn slot_write(&mut self, r: &SlotRef, v: &str) -> R<()> {
        if r.ty.starts_with("struct ") {
            for (f, off, nb, ty) in self.packed(r)? {
                let part = format!("(({v} >>> {}) % 2 ^ {})", 8 * off, 8 * nb);
                let val = word_to(&self.g.norm(&ty), &part);
                let val = self.atom(val);
                let mut p = r.path.clone();
                p.steps.push(Step::Field(ident(&f)));
                self.write(&p, |_| val.clone())?;
            }
            return Ok(());
        }
        if r.extra != 0 || r.ty.starts_with("mapping") || r.ty.contains('[') {
            return bail("sstore into an aggregate slot");
        }
        let val = word_to(&self.g.norm(&r.ty), v);
        let val = self.atom(val);
        self.write(&r.path, |_| val.clone())
    }

    /// `sload` from a named location: a value, or a struct slot packed from its fields.
    fn slot_read(&mut self, r: &SlotRef) -> R<String> {
        if r.ty.starts_with("struct ") {
            let mut parts = vec![];
            for (f, off, nb, ty) in self.packed(r)? {
                let mut p = r.path.clone();
                p.steps.push(Step::Field(ident(&f)));
                let cur = self.read(&p)?;
                let w = to_word(&self.g.norm(&ty), &cur);
                parts.push(format!("(({w} % 2 ^ {}) * 2 ^ {})", 8 * nb, 8 * off));
            }
            return Ok(format!("({})", parts.join(" + ")));
        }
        if r.extra != 0 || r.ty.starts_with("mapping") || r.ty.contains('[') {
            return bail("sload of an aggregate slot");
        }
        let cur = self.read(&r.path)?;
        Ok(to_word(&self.g.norm(&r.ty), &cur))
    }

    /// A Yul identifier naming an outside `bytes memory` value: its Lean name.
    fn yul_bytes_ref(&self, e: &Value, y: &Yul) -> Option<String> {
        if e["nodeType"] != "YulIdentifier" || y.var(&s(&e["name"])).is_some() {
            return None;
        }
        let (decl, slot, offset) = *y.refs.get(&s(&e["src"]))?;
        if slot || offset {
            return None;
        }
        let ty = tstr(self.g.nodes.get(&decl)?);
        (strip_location(&ty) == "bytes").then(|| self.locals.get(&decl).cloned()).flatten()
    }

    /// `x.slot` of a value-type state variable at offset 0: its field and Solidity type.
    fn yul_state_slot(&mut self, e: &Value, y: &Yul) -> R<(String, String)> {
        if e["nodeType"] != "YulIdentifier" {
            return bail("sload/sstore on a computed slot");
        }
        let (decl, slot, _) = *y.refs.get(&s(&e["src"])).ok_or("sload/sstore on a computed slot")?;
        let field = self.g.state_field.get(&decl).cloned().ok_or("sload/sstore of a non-state slot")?;
        let var = &self.g.g.state_vars[&decl];
        if !slot || var.offset.unwrap_or(0) != 0 || var.type_string.starts_with("mapping") || var.type_string.contains('[') || var.type_string.starts_with("struct") {
            return bail("sload/sstore of a packed or non-value slot");
        }
        Ok((field, self.g.norm(&var.type_string)))
    }

    fn yul_expr(&mut self, e: &Value, y: &mut Yul) -> R<String> {
        match e["nodeType"].as_str().unwrap_or("") {
            "YulLiteral" => yul_literal(e),
            "YulIdentifier" => {
                let name = s(&e["name"]);
                if let Some(lean) = y.var(&name) {
                    return Ok(lean);
                }
                let (decl, slot, offset) = *y.refs.get(&s(&e["src"])).ok_or_else(|| format!("Yul name {name}"))?;
                if slot {
                    let ty = self.g.nodes.get(&decl).map(|d| tstr(d)).unwrap_or_default();
                    let plain_state = self.g.g.state_vars.get(&decl).is_some_and(|v| !v.type_string.starts_with("mapping") && !v.type_string.starts_with("struct") && !v.type_string.contains('['));
                    if plain_state {
                        let var = &self.g.g.state_vars[&decl];
                        return var.slot.clone().ok_or_else(|| "no storage slot".into());
                    }
                    // A storage pointer, storage parameter, or aggregate state variable: a named location.
                    let path = if let Some(p) = self.alias.get(&decl) {
                        p.clone()
                    } else if let Some(l) = self.lens.get(&decl) {
                        Path { base: Base::Lens(l.clone()), steps: vec![] }
                    } else if let Some(f) = self.g.state_field.get(&decl) {
                        Path { base: Base::State(f.clone()), steps: vec![] }
                    } else {
                        return bail("`.slot` of an unknown location");
                    };
                    let ph = self.fresh("__slot");
                    y.slots.insert(ph.clone(), SlotRef { path, ty: strip_location(&ty).to_string(), extra: 0 });
                    return Ok(ph);
                }
                if offset {
                    let var = self.g.g.state_vars.get(&decl).ok_or("`.offset` of a storage pointer")?;
                    return Ok(var.offset.unwrap_or(0).to_string());
                }
                let ty = self.g.nodes.get(&decl).map(|d| tstr(d)).unwrap_or_default();
                let ty = self.g.norm(&ty);
                let v = if self.g.g.state_vars.get(&decl).is_some_and(|v| v.constant) {
                    self.g.constant(decl)?
                } else {
                    self.locals.get(&decl).cloned().ok_or_else(|| format!("assembly reads {name}"))?
                };
                Ok(to_word(&ty, &v))
            }
            "YulFunctionCall" => {
                let name = s(&e["functionName"]["name"]);
                let args: Vec<Value> = e["arguments"].as_array().cloned().unwrap_or_default();
                match name.as_str() {
                    "sload" if self.yul_slot(&args[0], y)?.is_some() => {
                        let r = self.yul_slot(&args[0], y)?.unwrap();
                        return self.slot_read(&r);
                    }
                    "sload" => {
                        let (field, ty) = self.yul_state_slot(&args[0], y)?;
                        return Ok(to_word(&ty, &format!("(ext.get (← get)).{field}")));
                    }
                    "tload" => {
                        self.g.transient = true;
                        let k = self.yul_expr(&args[0], y)?;
                        return Ok(format!("((ext.get (← get)).«transient» {})", paren(&k)));
                    }
                    "mload" if self.yul_bytes_ref(&args[0], y).is_some() => {
                        // `mload(b)` of a `bytes` value is its length.
                        let b = self.yul_bytes_ref(&args[0], y).unwrap();
                        return Ok(format!("({b}).length"));
                    }
                    "mload" if yul_call_name(&args[0]) == Some("add") && args[0]["arguments"].as_array().is_some_and(|a| a.iter().any(|x| self.yul_bytes_ref(x, y).is_some())) => {
                        // `mload(add(b, off))`: the word at byte `off - 32` of the data.
                        let parts = args[0]["arguments"].as_array().cloned().unwrap_or_default();
                        let (bi, oi) = if self.yul_bytes_ref(&parts[0], y).is_some() { (0, 1) } else { (1, 0) };
                        let b = self.yul_bytes_ref(&parts[bi], y).unwrap();
                        let off = self.yul_expr(&parts[oi], y)?;
                        return Ok(format!("(bytesWordAt {b} ({} - 32))", paren(&off)));
                    }
                    "mload" => {
                        let off = yul_const(&args[0]).ok_or("mload at a computed offset")?;
                        return y.mem.get(&off).cloned().ok_or_else(|| "mload of memory the model didn't see written".into());
                    }
                    "keccak256" if args[0]["nodeType"] == "YulIdentifier" && y.var(&s(&args[0]["name"])).is_none() => {
                        // keccak256(structInMemory, size): the struct's fields, one word each.
                        let (decl, _, _) = *y.refs.get(&s(&args[0]["src"])).ok_or("keccak256 of an unknown pointer")?;
                        let local = self.locals.get(&decl).cloned().ok_or("keccak256 of a non-local")?;
                        let t = tstr(self.g.nodes.get(&decl).copied().ok_or("decl")?);
                        let canon = t.trim_start_matches("struct ").trim_end_matches(" memory").to_string();
                        let sid = *self.g.struct_by_canon.get(&canon).ok_or("keccak256 of a non-struct pointer")?;
                        let members: Vec<(String, String)> = self.g.nodes[&sid]["members"].as_array().into_iter().flatten().map(|m| (s(&m["name"]), tstr(m))).collect();
                        let len = yul_const(&args[1]).ok_or("keccak256 of a computed length")?;
                        if len != 32 * members.len() as u64 {
                            return bail("keccak256 over part of a struct");
                        }
                        let words: Vec<String> = members.iter().map(|(n, t)| to_word(&self.g.norm(t), &format!("({local}).{}", ident(n)))).collect();
                        self.g.ext.insert("keccak : List Nat → Nat".into(), "keccak256 over words (any function: no collision assumptions)".into());
                        return Ok(format!("(ext.keccak [{}])", words.join(", ")));
                    }
                    "keccak256" if yul_const(&args[0]) == Some(0) && yul_const(&args[1]) == Some(64) && y.mem.get(&32).is_some_and(|v| y.slots.contains_key(v)) => {
                        // keccak256(key . mapping.slot): the slot of mapping[key].
                        let base = y.slots[&y.mem[&32]].clone();
                        let key_word = y.mem.get(&0).cloned().ok_or("mapping slot without a key")?;
                        if base.extra != 0 || !base.ty.starts_with("mapping(") {
                            return bail("keccak256 over a non-mapping slot");
                        }
                        let (key_ty, value_ty) = mapping_types(&base.ty).ok_or("mapping type")?;
                        let key = word_to(&self.g.norm(&key_ty), &key_word);
                        let key = if int_bits(&self.g.norm(&key_ty)).is_some() { format!("(toSigned 256 {})", paren(&key_word)) } else { key };
                        let k = self.atom(key);
                        let mut path = base.path.clone();
                        path.steps.push(Step::Map(k));
                        let ph = self.fresh("__slot");
                        y.slots.insert(ph.clone(), SlotRef { path, ty: value_ty, extra: 0 });
                        return Ok(ph);
                    }
                    "keccak256" => {
                        let (off, len) = (yul_const(&args[0]).ok_or("keccak256 of computed memory")?, yul_const(&args[1]).ok_or("keccak256 of a computed length")?);
                        if len % 32 != 0 {
                            return bail("keccak256 of a partial word");
                        }
                        let mut words = vec![];
                        for i in 0..len / 32 {
                            words.push(y.mem.get(&(off + 32 * i)).cloned().ok_or("keccak256 of memory the model didn't see written")?);
                        }
                        self.g.ext.insert("keccak : List Nat → Nat".into(), "keccak256 over words (any function: no collision assumptions)".into());
                        return Ok(format!("(ext.keccak [{}])", words.join(", ")));
                    }
                    "calldataload" => {
                        // A callback taking one `bytes calldata`, called with the standard ABI encoding (selector,
                        // offset, length, data): word k of the data is at 0x44 + 32k.
                        let c = yul_const(&args[0]).ok_or("calldataload at a computed offset")?;
                        match self.params.as_slice() {
                            [(name, ty, loc)] if ty == "bytes" && loc == "calldata" && c >= 0x44 && (c - 0x44) % 32 == 0 => {
                                return Ok(format!("(abiWordOr0 {name} {})", (c - 0x44) / 32));
                            }
                            _ => return bail("calldataload outside a single-bytes callback"),
                        }
                    }
                    "caller" => return Ok("(← read).sender".into()),
                    "address" => return Ok("(← read).self".into()),
                    "callvalue" => return Ok("(← read).value".into()),
                    "timestamp" => return Ok("(← read).timestamp".into()),
                    "number" => return Ok("(← read).number".into()),
                    "chainid" => return Ok("(← read).chainid".into()),
                    "origin" => return Ok("(← read).origin".into()),
                    "selfbalance" => return Ok("(← read).balance".into()),
                    _ => {}
                }
                let f = match name.as_str() {
                    "add" => "yadd", "sub" => "ysub", "mul" => "ymul", "div" => "ydiv", "sdiv" => "ysdiv", "mod" => "ymod",
                    "smod" => "ysmod", "exp" => "yexp", "not" => "ynot", "lt" => "ylt", "gt" => "ygt", "slt" => "yslt",
                    "sgt" => "ysgt", "eq" => "yeq", "iszero" => "yiszero", "and" => "yand", "or" => "yor", "xor" => "yxor",
                    "byte" => "ybyte", "shl" => "yshl", "shr" => "yshr", "sar" => "ysar", "addmod" => "yaddmod",
                    "mulmod" => "ymulmod", "signextend" => "ysignextend",
                    other => return bail(format!("Yul {other}")),
                };
                let mut a = vec![];
                for x in &args {
                    let v = self.yul_expr(x, y)?;
                    a.push(paren(&v));
                }
                Ok(format!("({f} {})", a.join(" ")))
            }
            other => bail(format!("{other} in assembly")),
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
            let v = if init.is_null() { "default".to_string() } else { self.expr_for(init, std::slice::from_ref(d), 0)? };
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
                        let v = self.arith_on(&tstr(sub), if op == "++" { "+" } else { "-" }, cur, "1".into())?;
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
            self.arith_on(&tstr(lhs), op.trim_end_matches('='), cur, rhs)?
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
            "FunctionCall" => self.storage_return(e),
            // `c ? book.bids : book.asks`: a location chosen once, here, as a getter and setter that pick the branch.
            "Conditional" => {
                let c = self.expr(&e["condition"])?;
                let c = self.atom(c);
                let a = self.lpath(&e["trueExpression"])?;
                let b = self.lpath(&e["falseExpression"])?;
                // An array index checks its bounds when the location is made, which only the chosen branch may do.
                if [&a, &b].iter().any(|p| p.steps.iter().any(|st| matches!(st, Step::Arr(_)))) {
                    return bail("conditional storage reference into an array");
                }
                let (ga, sa) = self.lens_args(&a)?;
                let (gb, sb) = self.lens_args(&b)?;
                let l = self.fresh("__ref");
                self.line(format!("let {l}_get := if {c} then {ga} else {gb}"));
                self.line(format!("let {l}_set := if {c} then {sa} else {sb}"));
                Ok(Path { base: Base::Lens(l), steps: vec![] })
            }
            other => bail(format!("can't write through {other}")),
        }
    }

    /// `_getPool(id)` where the callee only returns a storage path (`return _pools[id];`): that path, with the
    /// arguments in place of the parameters.
    fn storage_return(&mut self, e: &Value) -> R<Path> {
        let callee = &e["expression"];
        let target = callee["referencedDeclaration"].as_i64().ok_or("storage pointer from a call")?;
        let target = self.g.scope.resolve(self.g.g, target);
        let f = self.g.nodes.get(&target).copied().ok_or("storage pointer from a call")?;
        let stmts = f["body"]["statements"].as_array().cloned().unwrap_or_default();
        let rets = f["returnParameters"]["parameters"].as_array().cloned().unwrap_or_default();
        // The callee may compute locals first (`bytes32 key = …;`); those run here, then its returned path is ours.
        // The path is `return <path>;` or `<named return> = <path>;`.
        let ret_id = rets.first().map(id_of);
        let returned = stmts.last().and_then(|l| match l["nodeType"].as_str() {
            Some("Return") => Some(l["expression"].clone()),
            Some("ExpressionStatement") if l["expression"]["nodeType"] == "Assignment" && l["expression"]["operator"] == "=" && l["expression"]["leftHandSide"]["referencedDeclaration"].as_i64() == ret_id => Some(l["expression"]["rightHandSide"].clone()),
            _ => None,
        });
        let ok = rets.len() == 1
            && rets[0]["storageLocation"] == "storage"
            && returned.is_some()
            && stmts[..stmts.len() - 1].iter().all(|st| st["nodeType"] == "VariableDeclarationStatement");
        if !ok {
            return bail("storage pointer from a call that does more than return a path");
        }
        let params = f["parameters"]["parameters"].as_array().cloned().unwrap_or_default();
        let mut args: Vec<Value> = vec![];
        if callee["nodeType"] == "MemberAccess" && !tstr(&callee["expression"]).starts_with("type(") {
            args.push(callee["expression"].clone());
        }
        args.extend(e["arguments"].as_array().cloned().unwrap_or_default());
        let mut saved = vec![];
        for (p, a) in params.iter().zip(&args) {
            let pid = id_of(p);
            if p["storageLocation"] == "storage" {
                let path = self.lpath(a)?;
                saved.push((pid, self.locals.get(&pid).cloned(), self.alias.insert(pid, path)));
            } else {
                let v = self.expr(a)?;
                let v = self.atom(v);
                saved.push((pid, self.locals.insert(pid, v), None));
            }
        }
        let mut path = Ok(Path { base: Base::Local(String::new()), steps: vec![] });
        for st in &stmts[..stmts.len() - 1] {
            if let Err(e) = self.declare(st) {
                path = Err(e);
                break;
            }
        }
        if path.is_ok() {
            path = self.lpath(returned.as_ref().unwrap());
        }
        for (pid, local, alias) in saved {
            match local {
                Some(l) => self.locals.insert(pid, l),
                None => self.locals.remove(&pid),
            };
            match alias {
                Some(a) => self.alias.insert(pid, a),
                None => self.alias.remove(&pid),
            };
        }
        path
    }

    fn read(&mut self, p: &Path) -> R<String> {
        let mut cur = match &p.base {
            Base::State(f) => format!("(ext.get (← get)).{f}"),
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
                self.line(format!("modify fun w => ext.set w (let s := ext.get w; {{ s with {f} := {v} }})"));
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
                format!("(do return {})", pure_read(format!("(ext.get (← get)).{f}"))),
                format!("(fun x => modify fun w => ext.set w (let s := ext.get w; {{ s with {f} := {} }}))", set(format!("s.{f}"), &p.steps, &|_: &str| "x".to_string())),
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

    /// Signed arithmetic on `intN`: checked ops revert out of range, unchecked ones wrap.
    fn arith_signed(&mut self, op: &str, bits: u32, a: String, b: String) -> R<String> {
        let checked = self.unchecked == 0;
        let (a, b) = (paren(&a), paren(&b));
        let call = match op {
            "+" if checked => format!("addcI {bits} {a} {b}"),
            "-" if checked => format!("subcI {bits} {a} {b}"),
            "*" if checked => format!("mulcI {bits} {a} {b}"),
            "/" => format!("divcI {bits} {checked} {a} {b}"),
            "%" => format!("modcI {a} {b}"),
            "+" => return Ok(format!("(wrapI {bits} ({a} + {b}))")),
            "-" => return Ok(format!("(wrapI {bits} ({a} - {b}))")),
            "*" => return Ok(format!("(wrapI {bits} ({a} * {b}))")),
            // Arithmetic shift right is floor division by a power of two; `/` on Int floors for positive divisors.
            ">>" => return Ok(format!("({a} / ((2 ^ {b} : Nat) : Int))")),
            "<<" => return Ok(format!("(wrapI {bits} ({a} * ((2 ^ {b} : Nat) : Int)))")),
            _ => return bail(format!("signed operator {op}")),
        };
        let v = self.fresh("__t");
        self.line(format!("let {v} ← {call}"));
        Ok(v)
    }

    /// Arithmetic on a typeString: unsigned or signed.
    fn arith_on(&mut self, t: &str, op: &str, a: String, b: String) -> R<String> {
        let t = self.g.norm(t);
        if let Some(bits) = int_bits(&t) {
            return self.arith_signed(op, bits, a, b);
        }
        let bits = bits_of(&t).ok_or_else(|| format!("arithmetic on {t}"))?;
        self.arith(op, bits, a, b)
    }

    /// The ABI words a static value encodes to (structs field by field).
    fn abi_words(&mut self, t: &str, term: &str) -> R<Vec<String>> {
        let t = strip_location(&self.g.norm(strip_location(t))).to_string();
        if t == "bool" {
            return Ok(vec![format!("(ybool {})", paren(term))]);
        }
        if int_bits(&t).is_some() {
            return Ok(vec![format!("(toUnsigned 256 {})", paren(term))]);
        }
        if bytes_n(&t).is_some() {
            return Ok(vec![to_word(&t, term)]);
        }
        if t.starts_with("uint") || t.starts_with("address") || t.starts_with("contract ") || t.starts_with("enum ") || t == "bytes32" {
            return Ok(vec![term.to_string()]);
        }
        if let Some(name) = t.strip_prefix("struct ") {
            let sid = *self.g.struct_by_canon.get(name).ok_or_else(|| format!("struct {name}"))?;
            let members: Vec<(String, String)> = self.g.nodes[&sid]["members"].as_array().into_iter().flatten().map(|m| (s(&m["name"]), tstr(m))).collect();
            let mut out = vec![];
            for (n, mt) in members {
                out.extend(self.abi_words(&mt, &format!("({term}).{}", ident(&n)))?);
            }
            return Ok(out);
        }
        bail(format!("ABI encoding of {t} (dynamic types aren't modelled yet)"))
    }

    /// Whether a type is dynamic in the ABI (encoded at an offset): bytes, string, or a struct holding one.
    fn abi_dynamic(&self, t: &str) -> R<bool> {
        let t = strip_location(&self.g.norm(strip_location(t))).to_string();
        if t == "bytes" || t == "string" {
            return Ok(true);
        }
        if t.ends_with("[]") {
            return bail("ABI arrays aren't modelled yet");
        }
        if let Some(name) = t.strip_prefix("struct ") {
            let sid = *self.g.struct_by_canon.get(name).ok_or_else(|| format!("struct {name}"))?;
            for m in self.g.nodes[&sid]["members"].as_array().cloned().unwrap_or_default() {
                if self.abi_dynamic(&tstr(&m))? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    fn struct_members(&self, t: &str) -> R<Vec<(String, String)>> {
        let name = strip_location(t).strip_prefix("struct ").ok_or("not a struct")?;
        let sid = *self.g.struct_by_canon.get(name).ok_or_else(|| format!("struct {name}"))?;
        Ok(self.g.nodes[&sid]["members"].as_array().into_iter().flatten().map(|m| (s(&m["name"]), tstr(m))).collect())
    }

    /// `abi.encode(items…)`: static values in the head, dynamic ones as offsets into the tails that follow.
    fn abi_encode(&mut self, items: &[(String, String)]) -> R<String> {
        let mut head_words: Vec<Option<String>> = vec![]; // None = an offset to fill in
        let mut tails = vec![];
        for (t, v) in items {
            if self.abi_dynamic(t)? {
                let tail = self.abi_tail(t, v)?;
                let tail = self.atom(tail);
                tails.push(tail);
                head_words.push(None);
            } else {
                for w in self.abi_words(t, v)? {
                    head_words.push(Some(w));
                }
            }
        }
        let head_bytes = 32 * head_words.len();
        let mut words = vec![];
        let mut k = 0;
        for w in head_words {
            match w {
                Some(w) => words.push(w),
                None => {
                    let before: Vec<String> = tails[..k].iter().map(|t| format!("{t}.length")).collect();
                    words.push(if before.is_empty() { head_bytes.to_string() } else { format!("({head_bytes} + {})", before.join(" + ")) });
                    k += 1;
                }
            }
        }
        let mut out = format!("abiEncode [{}]", words.join(", "));
        for t in &tails {
            out = format!("{out} ++ {t}");
        }
        Ok(format!("({out})"))
    }

    /// The tail of a dynamic value: bytes/string with their length, a struct as its own tuple encoding.
    fn abi_tail(&mut self, t: &str, v: &str) -> R<String> {
        let tt = strip_location(&self.g.norm(strip_location(t))).to_string();
        match tt.as_str() {
            "bytes" => Ok(format!("(abiBytes {v})")),
            "string" => Ok(format!("(abiBytes ({v}.toUTF8.toList.map (·.toNat)))")),
            _ => {
                let members = self.struct_members(&tt)?;
                let items: Vec<(String, String)> = members.into_iter().map(|(n, mt)| (mt, format!("({v}).{}", ident(&n)))).collect();
                self.abi_encode(&items)
            }
        }
    }

    /// Decodes a tuple of values whose encoding starts at byte `base` of `data`.
    fn abi_decode_tuple(&mut self, types: &[String], data: &str, base: &str) -> R<Vec<String>> {
        let mut slot = 0usize;
        let mut vals = vec![];
        for t in types {
            vals.push(self.abi_decode_at(t, data, base, &mut slot)?);
        }
        Ok(vals)
    }

    fn abi_decode_at(&mut self, t: &str, data: &str, base: &str, slot: &mut usize) -> R<String> {
        let tt = strip_location(&self.g.norm(strip_location(t))).to_string();
        let at = |slot: usize| if base == "0" { format!("{}", 32 * slot) } else { format!("({base} + {})", 32 * slot) };
        if self.abi_dynamic(&tt)? {
            // The head holds an offset (from `base`) to where the value is.
            let o = self.fresh("__o");
            self.line(format!("let {o} ← abiWordAt {data} {}", at(*slot)));
            *slot += 1;
            let pos = if base == "0" { o } else { format!("({base} + {o})") };
            let pos = self.atom(pos);
            return match tt.as_str() {
                "bytes" => {
                    let v = self.fresh("__d");
                    self.line(format!("let {v} ← abiBytesAt {data} {pos}"));
                    Ok(v)
                }
                "string" => bail("abi.decode of a string"),
                _ => {
                    let members = self.struct_members(&tt)?;
                    let types: Vec<String> = members.iter().map(|(_, mt)| mt.clone()).collect();
                    let vals = self.abi_decode_tuple(&types, data, &pos)?;
                    let ty = self.g.ty_str(&tt)?;
                    let fields: Vec<String> = members.iter().zip(&vals).map(|((n, _), v)| format!("{} := {v}", ident(n))).collect();
                    let v = self.fresh("__d");
                    self.line(format!("let {v} : {ty} := {{ {} }}", fields.join(", ")));
                    Ok(v)
                }
            };
        }
        // Static: in place, word by word (structs inline).
        if tt.starts_with("struct ") {
            let members = self.struct_members(&tt)?;
            let mut fields = vec![];
            for (n, mt) in &members {
                let v = self.abi_decode_at(mt, data, base, slot)?;
                fields.push(format!("{} := {v}", ident(n)));
            }
            let ty = self.g.ty_str(&tt)?;
            let v = self.fresh("__d");
            self.line(format!("let {v} : {ty} := {{ {} }}", fields.join(", ")));
            return Ok(v);
        }
        let w = self.fresh("__w");
        self.line(format!("let {w} ← abiWordAt {data} {}", at(*slot)));
        *slot += 1;
        let check = if tt == "bool" {
            Some("abiBool".to_string())
        } else if let Some(b) = int_bits(&tt) {
            Some(format!("abiInt {b}"))
        } else if let Some(name) = tt.strip_prefix("enum ") {
            Some(format!("abiEnum {}", self.g.enum_size.get(name).ok_or_else(|| format!("enum {name}"))?))
        } else if tt == "bytes32" {
            None
        } else if let Some(n) = bytes_n(&tt) {
            Some(format!("abiBytesN {n}"))
        } else if tt.starts_with("uint") || tt.starts_with("address") || tt.starts_with("contract ") {
            bits_of(&tt).filter(|b| *b < 256).map(|b| format!("abiUint {b}"))
        } else {
            return bail(format!("ABI decoding of {tt}"));
        };
        Ok(match check {
            Some(c) => {
                let v = self.fresh("__d");
                self.line(format!("let {v} ← {c} {w}"));
                v
            }
            None => w,
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
                    "++" | "--" => {
                        // `x++` is the old value, `++x` the new; either way x changes.
                        let sub = &e["subExpression"];
                        let cur = self.expr(sub)?;
                        let old = self.atom(cur.clone());
                        let new = self.arith_on(&tstr(sub), if op == "++" { "+" } else { "-" }, old.clone(), "1".into())?;
                        let new = self.atom(new);
                        let p = self.lpath(sub)?;
                        self.write(&p, |_| new.clone())?;
                        Ok(if e["prefix"] == true { new } else { old })
                    }
                    "-" => {
                        let a = self.expr(&e["subExpression"])?;
                        let t = self.g.norm(&tstr(e));
                        let bits = int_bits(&t).ok_or("negation of a non-signed value")?;
                        if self.unchecked > 0 {
                            return Ok(format!("(wrapI {bits} (-{}))", paren(&a)));
                        }
                        let v = self.fresh("__t");
                        self.line(format!("let {v} ← negcI {bits} {}", paren(&a)));
                        Ok(v)
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

    /// An argument for the i-th parameter: a string literal passed as `bytes` is its byte list.
    fn expr_for(&mut self, e: &Value, params: &[Value], i: usize) -> R<String> {
        let bytes_param = params.get(i).is_some_and(|p| p["typeName"]["name"] == "bytes");
        if bytes_param && e["nodeType"] == "Literal" {
            let bytes = literal_bytes(e).ok_or("bytes literal")?;
            return Ok(format!("[{}]", bytes.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(", ")));
        }
        self.expr(e)
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
        if let Some(sel) = selector(e, &self.g.nodes) {
            return Ok(sel);
        }
        if m == "length" && base["nodeType"] == "MemberAccess" && base["memberName"] == "code" {
            let a = self.expr(&base["expression"])?;
            let a = self.atom(a);
            self.g.ext.insert("codeLength : Nat → Nat".into(), "the code size at an address".into());
            return Ok(format!("(ext.codeLength {a})"));
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
                self.arith_on(&common, &op, a, b)
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
            let to = self.g.norm(&tstr(e));
            let from = self.g.norm(&tstr(&args[0]));
            let literal = from.starts_with("int_const") || from.starts_with("rational");
            if strip_location(&from) == "bytes" {
                if let Some(n) = bytes_n(&to).or((to == "bytes32").then_some(32)) {
                    return Ok(format!("(bytesWord (({} ++ List.replicate {n} 0).take {n}))", paren(&a)));
                }
            }
            return Ok(match (int_bits(&to), int_bits(&from), bits_of(&to), bits_of(&from)) {
                // intM → intN: narrowing wraps, widening keeps the value.
                (Some(tb), Some(fb), _, _) if tb < fb => format!("(wrapI {tb} {})", paren(&a)),
                (Some(_), Some(_), _, _) => a,
                // uintN ↔ intN: the same bits, reinterpreted.
                (Some(tb), None, _, Some(_)) => format!("(toSigned {tb} {})", paren(&a)),
                (None, Some(fb), Some(_), _) if to.starts_with("uint") || to.starts_with("bytes") => format!("(toUnsigned {fb} {})", paren(&a)),
                (Some(_), None, _, None) if literal => a,
                (Some(_), None, _, None) => return bail(format!("conversion from {from} to {to}")),
                (None, None, Some(tb), Some(fb)) if to.starts_with("uint") && tb < fb => format!("({} % 2 ^ {tb})", paren(&a)),
                _ => a,
            });
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
        // Call options: `{value: v}` is passed on; `{gas: g}` is not modelled (the call under any gas).
        let (callee, call_value) = if callee["nodeType"] == "FunctionCallOptions" {
            let names: Vec<String> = callee["names"].as_array().into_iter().flatten().map(s).collect();
            let opts: Vec<Value> = callee["options"].as_array().cloned().unwrap_or_default();
            let mut value = None;
            for (n, o) in names.iter().zip(&opts) {
                match n.as_str() {
                    "value" => value = Some(self.expr(o)?),
                    "gas" => {}
                    other => return bail(format!("call option {other}")),
                }
            }
            (&callee["expression"], value)
        } else {
            (callee, None)
        };
        // `addr.call(data)`, with or without options: a low-level call → (success, returndata).
        if callee["nodeType"] == "MemberAccess" && callee["memberName"] == "call" && tstr(&callee["expression"]).starts_with("address") {
            let addr = self.expr(&callee["expression"])?;
            let addr = self.atom(addr);
            let value = self.atom(call_value.unwrap_or_else(|| "0".into()));
            let data = match args.first() {
                Some(a) if a["nodeType"] == "Literal" => {
                    let bytes = literal_bytes(a).ok_or("bytes literal")?;
                    format!("[{}]", bytes.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(", "))
                }
                Some(a) => self.expr(a)?,
                None => return bail("call without data"),
            };
            let data = self.atom(data);
            self.g.ext.insert(
                "lowCall : Nat → Nat → List Nat → M σ (Bool × List Nat)".into(),
                "a low-level call (address, value, calldata) → (success, returndata); a failed call returns false and doesn't revert".into(),
            );
            let t = self.fresh("__t");
            self.line(format!("let {t} ← ext.lowCall {addr} {value} {data}"));
            return Ok(t);
        }
        if callee["nodeType"] == "MemberAccess" && matches!(callee["memberName"].as_str(), Some("wrap" | "unwrap")) && tstr(&callee["expression"]).starts_with("type(") {
            return self.expr(&args[0]);
        }
        let builtin = callee["referencedDeclaration"].as_i64().is_some_and(|r| r < 0);
        let abi = callee["nodeType"] == "MemberAccess" && callee["expression"]["name"] == "abi" && callee["expression"]["referencedDeclaration"].as_i64().is_some_and(|r| r < 0);
        if abi && callee["memberName"] == "encode" {
            let mut items = vec![];
            for a in &args {
                let v = self.expr(a)?;
                let v = self.atom(v);
                items.push((tstr(a), v));
            }
            return self.abi_encode(&items);
        }
        if abi && (callee["memberName"] == "encodeCall" || callee["memberName"] == "encodeWithSelector") {
            // Calldata: the 4-byte selector, then the arguments' ABI encoding.
            let sel = if callee["memberName"] == "encodeCall" {
                let f = &args[0];
                let r = f["referencedDeclaration"].as_i64().ok_or("encodeCall of an unknown function")?;
                let d = self.g.nodes.get(&r).copied().ok_or("encodeCall target")?;
                format!("0x{}", d["functionSelector"].as_str().ok_or("encodeCall of a function without a selector")?)
            } else {
                let v = self.expr(&args[0])?;
                self.atom(v)
            };
            let rest: Vec<Value> = if callee["memberName"] == "encodeCall" {
                match args.get(1) {
                    Some(t) if t["nodeType"] == "TupleExpression" && t["isInlineArray"] != true => t["components"].as_array().cloned().unwrap_or_default(),
                    Some(t) => vec![t.clone()],
                    None => vec![],
                }
            } else {
                args[1..].to_vec()
            };
            let mut items = vec![];
            for a in &rest {
                let v = self.expr(a)?;
                let v = self.atom(v);
                items.push((tstr(a), v));
            }
            let enc = self.abi_encode(&items)?;
            return Ok(format!("((wordBytes ({sel} * 2 ^ 224)).take 4 ++ {enc})"));
        }
        if abi && callee["memberName"] == "decode" {
            let data = self.expr(&args[0])?;
            let data = self.atom(data);
            let t = tstr(e);
            let types = if t.starts_with("tuple(") { split_tuple(&t) } else { vec![t] };
            let vals = self.abi_decode_tuple(&types, &data, "0")?;
            return Ok(tuple(&vals));
        }
        if builtin && callee["nodeType"] == "Identifier" && callee["name"] == "keccak256" {
            let arg = &args[0];
            if let Some(bytes) = literal_bytes(arg) {
                return Ok(keccak_hex(&bytes));
            }
            // keccak256(abi.encode(words…)): an arbitrary function of the words (the same one Yul scratch hashing uses).
            if arg["nodeType"] == "FunctionCall" && arg["expression"]["memberName"] == "encode" && arg["expression"]["expression"]["name"] == "abi" {
                let mut words = vec![];
                for a in arg["arguments"].as_array().cloned().unwrap_or_default() {
                    let t = self.g.norm(&tstr(&a));
                    if !(t == "bool" || bits_of(&t).is_some() || int_bits(&t).is_some() || t.starts_with("enum ") || t.starts_with("contract ")) {
                        return bail(format!("keccak256(abi.encode(…)) of a {t}"));
                    }
                    let v = self.expr(&a)?;
                    let v = to_word(&t, &v);
                    words.push(self.atom(v));
                }
                self.g.ext.insert("keccak : List Nat → Nat".into(), "keccak256 over words (any function: no collision assumptions)".into());
                return Ok(format!("(ext.keccak [{}])", words.join(", ")));
            }
            return bail("keccak256 of bytes the model doesn't build");
        }
        if builtin && callee["nodeType"] == "Identifier" && callee["name"] == "ecrecover" {
            let mut a = vec![];
            for x in &args {
                let v = self.expr(x)?;
                a.push(self.atom(v));
            }
            self.g.ext.insert("ecrecover : Nat → Nat → Nat → Nat → Nat".into(), "ecrecover (any function of its inputs)".into());
            return Ok(format!("(ext.ecrecover {})", a.join(" ")));
        }
        // Solidity's addmod/mulmod: exact, and a zero modulus panics.
        if callee["nodeType"] == "Identifier" && matches!(callee["name"].as_str(), Some("addmod" | "mulmod")) && callee["referencedDeclaration"].as_i64().is_some_and(|r| r < 0) {
            let mut a = vec![];
            for x in &args {
                let v = self.expr(x)?;
                a.push(self.atom(v));
            }
            self.line(format!("if {} = 0 then throw (panic \"0x12\")", a[2]));
            let f = if callee["name"] == "addmod" { "yaddmod" } else { "ymulmod" };
            return Ok(format!("({f} {} {} {})", a[0], a[1], a[2]));
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
        let pnodes: Vec<Value> = tnode["parameters"]["parameters"].as_array().cloned().unwrap_or_default();
        let unit = rets.is_empty();
        match ck {
            // A public library function runs on our storage too (delegatecall): the same as an internal call.
            CallKind::Internal | CallKind::ExternalLibrary if call_value.is_some() => bail("internal call with {value}"),
            CallKind::Internal | CallKind::ExternalLibrary => {
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
                    let v = self.expr_for(x, &pnodes, i)?;
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
                for (i, x) in ordered.iter().enumerate() {
                    let v = self.expr_for(x, &pnodes, i)?;
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
                    let ty = format!("Env → σ → Nat → {}Except Revert {}", ptys.iter().map(|p| format!("{p} → ")).collect::<String>(), product(&rtys));
                    self.g.ext.insert(format!("{field} : {ty}"), format!("view call {iface}.{tname}: reads, can't write our storage"));
                    self.g.ext_calls.insert(field.clone(), ExtCall { field: field.clone(), iface: iface.clone(), function: tname.clone(), params: ptys.clone(), ret: product(&rtys), view: true });
                    self.line(format!("let {t} ← view (fun env s => ext.{field} env s {addr} {})", a.join(" ")));
                } else if let Some(value) = call_value {
                    // `{value: v}`: the same call, sending `v` wei along (a field of its own, taking the value after the address).
                    let value = self.atom(value);
                    let field = format!("callV_{iface}_{tname}");
                    let ty = format!("Nat → Nat → {}M σ {}", ptys.iter().map(|p| format!("{p} → ")).collect::<String>(), product(&rtys));
                    self.g.ext.insert(format!("{field} : {ty}"), format!("external call {iface}.{tname} with value (address, value, args…): may re-enter and change our storage"));
                    self.line(format!("let {t} ← ext.{field} {addr} {value} {}", a.join(" ")));
                } else {
                    let field = format!("call_{iface}_{tname}");
                    let ty = format!("Nat → {}M σ {}", ptys.iter().map(|p| format!("{p} → ")).collect::<String>(), product(&rtys));
                    self.g.ext.insert(format!("{field} : {ty}"), format!("external call {iface}.{tname}: may re-enter and change our storage"));
                    self.g.ext_calls.insert(field.clone(), ExtCall { field: field.clone(), iface: iface.clone(), function: tname.clone(), params: ptys.clone(), ret: product(&rtys), view: false });
                    self.line(format!("let {t} ← ext.{field} {addr} {}", a.join(" ")));
                }
                Ok(if unit { "()".into() } else { t })
            }
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

/// What a Yul block can see: outside references by src, its own variables by scope, and scratch memory written at
/// constant offsets (each word bound to a name when stored).
struct Yul {
    refs: HashMap<String, (Id, bool, bool)>,
    /// Yul variables in scope: Yul name → its Lean name (unique, since Lean won't shadow a `let mut`).
    vars: Vec<HashMap<String, String>>,
    mem: HashMap<u64, String>,
    /// Storage locations named in Yul (`self.slot`, `keccak256(key, self.slot)`, `add(p, k)`): placeholder → where.
    slots: HashMap<String, SlotRef>,
}

/// A storage location reached in assembly: a path, the Solidity type stored there, and a slot offset into it.
#[derive(Clone, Debug)]
struct SlotRef {
    path: Path,
    ty: String,
    extra: u64,
}

impl Yul {
    fn var(&self, name: &str) -> Option<String> {
        self.vars.iter().rev().find_map(|scope| scope.get(name).cloned())
    }
}

fn yul_var(name: &str) -> String {
    ident(&format!("y_{}", name.replace('$', "_")))
}

fn yul_call_name(st: &Value) -> Option<&str> {
    let e = if st["nodeType"] == "YulExpressionStatement" { &st["expression"] } else { st };
    (e["nodeType"] == "YulFunctionCall").then(|| e["functionName"]["name"].as_str()).flatten()
}

/// Whether a Yul statement changes anything a revert wouldn't undo anyway (only calls out do).
fn yul_has_effects(st: &Value) -> bool {
    let text = st.to_string();
    ["\"call\"", "\"staticcall\"", "\"delegatecall\"", "\"create\"", "\"create2\""].iter().any(|op| text.contains(&format!("\"name\":{op}")))
}

fn yul_const(e: &Value) -> Option<u64> {
    if e["nodeType"] != "YulLiteral" || e["kind"] != "number" {
        return None;
    }
    let v = s(&e["value"]);
    match v.strip_prefix("0x") {
        Some(h) => u64::from_str_radix(h, 16).ok(),
        None => v.parse().ok(),
    }
}

fn yul_literal(e: &Value) -> R<String> {
    match s(&e["kind"]).as_str() {
        "number" => Ok(s(&e["value"])),
        "bool" => Ok(if e["value"] == "true" { "1".into() } else { "0".into() }),
        "string" => {
            // A short string literal is its bytes, left-aligned in the word.
            let bytes = s(&e["value"]).into_bytes();
            if bytes.len() > 32 {
                return bail("long Yul string");
            }
            let mut hex = String::from("0x");
            for b in &bytes {
                let _ = write!(hex, "{b:02x}");
            }
            for _ in bytes.len()..32 {
                hex.push_str("00");
            }
            Ok(hex)
        }
        k => bail(format!("Yul {k} literal")),
    }
}

/// A Solidity value as the word Yul sees.
fn to_word(ty: &str, v: &str) -> String {
    if let Some(n) = bytes_n(ty) {
        format!("({} * 2 ^ {})", paren(v), 256 - 8 * n)
    } else if ty == "bool" {
        format!("(ybool {})", paren(v))
    } else if int_bits(ty).is_some() {
        format!("(toUnsigned 256 {})", paren(v))
    } else {
        v.to_string()
    }
}

/// A Yul word assigned to a Solidity variable of type `ty` (cleaned to the type, as Solidity reads it).
fn word_to(ty: &str, v: &str) -> String {
    if ty == "bool" {
        format!("({} != 0)", paren(v))
    } else if let Some(b) = int_bits(ty) {
        format!("(toSigned {b} {})", paren(v))
    } else if let Some(n) = bytes_n(ty) {
        format!("({} / 2 ^ {})", paren(v), 256 - 8 * n)
    } else if let Some(b) = bits_of(ty).filter(|b| *b < 256) {
        if ty.starts_with("bytes") {
            v.to_string()
        } else {
            format!("({} % 2 ^ {b})", paren(v))
        }
    } else {
        v.to_string()
    }
}

/// `mapping(K => V)` → (K, V).
fn mapping_types(t: &str) -> Option<(String, String)> {
    let inner = t.strip_prefix("mapping(")?.strip_suffix(')')?;
    let (k, v) = inner.split_once(" => ")?;
    let k = k.split_whitespace().next()?.to_string();
    Some((k, v.trim().to_string()))
}

fn strip_location(t: &str) -> &str {
    let t = t.trim();
    for suffix in [" memory", " calldata", " storage ref", " storage pointer"] {
        if let Some(rest) = t.strip_suffix(suffix) {
            return rest;
        }
    }
    t
}

/// The parts of `tuple(a,b,…)`, split at top-level commas.
fn split_tuple(t: &str) -> Vec<String> {
    let inner = t.trim().strip_prefix("tuple(").and_then(|x| x.strip_suffix(')')).unwrap_or(t);
    let (mut parts, mut depth, mut cur) = (vec![], 0, String::new());
    for c in inner.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(std::mem::take(&mut cur));
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    parts
}

fn keccak_hex(bytes: &[u8]) -> String {
    use tiny_keccak::{Hasher, Keccak};
    let mut k = Keccak::v256();
    k.update(bytes);
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    format!("0x{}", out.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// The bytes of a string or hex literal.
fn literal_bytes(e: &Value) -> Option<Vec<u8>> {
    if e["nodeType"] != "Literal" {
        return None;
    }
    let hex = s(&e["hexValue"]);
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok()).collect()
}

/// `X.selector` of an error, function or event: solc already computed it.
fn selector(e: &Value, nodes: &HashMap<Id, &Value>) -> Option<String> {
    if s(&e["memberName"]) != "selector" {
        return None;
    }
    let r = e["expression"]["referencedDeclaration"].as_i64()?;
    let d = nodes.get(&r)?;
    let sel = d["errorSelector"].as_str().or(d["functionSelector"].as_str()).or(d["eventSelector"].as_str())?;
    Some(format!("0x{sel}"))
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
