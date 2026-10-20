//! The contract graph: one pass over solc's AST, kept as small tables.
//!
//! The raw AST (megabytes of JSON) is read once and dropped. What stays is, per function: the state it reads and
//! writes (including through storage pointers and storage parameters), its calls by kind, its guards, its arithmetic
//! sites and its inline assembly, each with the `src` it came from.

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub type Id = i64;

/// A place in storage that code reads or writes: a state variable, or a function's `storage` parameter (resolved to
/// the caller's state variable when units are built).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Ref {
    State(Id),
    Param(usize),
}

/// A `src` string, `start:length:file`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct Src {
    pub start: usize,
    pub len: usize,
    pub file: Id,
}

impl Src {
    pub fn parse(s: &str) -> Option<Src> {
        let mut it = s.split(':');
        Some(Src { start: it.next()?.parse().ok()?, len: it.next()?.parse().ok()?, file: it.next()?.parse().ok()? })
    }
    fn of(node: &Value) -> Src {
        node["src"].as_str().and_then(Src::parse).unwrap_or(Src { start: 0, len: 0, file: -1 })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct File {
    pub id: Id,
    pub path: String,
    /// Paths this file imports, as solc resolved them.
    pub imports: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Contract {
    pub id: Id,
    pub name: String,
    /// contract, interface, library, abstract
    pub kind: String,
    pub file: Id,
    /// Most derived first (solc's linearization).
    pub bases: Vec<Id>,
    pub state_vars: Vec<Id>,
    pub functions: Vec<Id>,
    pub src: Src,
}

#[derive(Debug, Clone, Serialize)]
pub struct StateVar {
    pub id: Id,
    pub name: String,
    pub contract: Id,
    #[serde(rename = "type")]
    pub type_string: String,
    pub constant: bool,
    pub immutable: bool,
    pub visibility: String,
    pub slot: Option<String>,
    pub offset: Option<u64>,
    pub src: Src,
}

impl CallKind {
    /// Code that runs in this contract's own context: internal calls, and public library functions (a delegatecall
    /// runs the library's code on our storage, with our `msg.sender`).
    pub fn runs_here(self) -> bool {
        matches!(self, CallKind::Internal | CallKind::ExternalLibrary)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CallKind {
    /// A function or modifier in this contract or its bases, or an internal library function (inlined).
    Internal,
    /// A call into another contract (or `this`), including `new`.
    External,
    /// A public/external library function: a delegatecall.
    ExternalLibrary,
    /// `call`, `delegatecall`, `staticcall`, `transfer`, `send`, or Yul `call`.
    LowLevel,
}

#[derive(Debug, Clone, Serialize)]
pub struct Call {
    pub kind: CallKind,
    pub target: Option<Id>,
    /// What the code calls it, e.g. `safeTransferFrom` or `call`.
    pub name: String,
    pub src: Src,
    /// For internal calls: the storage each argument points at, to map the callee's storage parameters.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<Option<Ref>>,
    /// An external or low-level call followed by a state write later in the same function (source order, not paths).
    pub before_write: bool,
    /// `super.f()` or `Base.f()`: runs exactly the target, with no virtual dispatch.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub direct: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Guard {
    /// require, assert, if-revert
    pub kind: String,
    /// The condition (for if-revert: the condition that reverts).
    pub cond: Src,
}

#[derive(Debug, Clone, Serialize)]
pub struct Arith {
    /// + - * / % ** << >> ++ -- or mulDiv
    pub op: String,
    #[serde(rename = "type")]
    pub type_string: String,
    /// False inside `unchecked { }`.
    pub checked: bool,
    /// For mulDiv: floor or ceil.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rounding: Option<String>,
    pub src: Src,
}

#[derive(Debug, Clone, Serialize)]
pub struct Asm {
    pub src: Src,
    /// Outside variables the block uses, with `.slot` / `.offset` access marked.
    pub refs: Vec<AsmRef>,
    /// Yul builtins it calls (sload, sstore, call, mstore, …).
    pub ops: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AsmRef {
    pub decl: Id,
    pub name: String,
    pub slot: bool,
    pub offset: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Function {
    pub id: Id,
    pub name: String,
    pub contract: Id,
    /// function, constructor, receive, fallback, modifier
    pub kind: String,
    pub visibility: String,
    pub mutability: String,
    pub virtual_: bool,
    /// False for declarations without a body (interfaces, abstract functions).
    pub implemented: bool,
    /// name(type,type) for matching overrides.
    pub signature: String,
    /// Modifier definitions, in order.
    pub modifiers: Vec<Id>,
    /// Indexes of `storage` parameters.
    pub storage_params: Vec<usize>,
    pub reads: BTreeSet<Ref>,
    pub writes: BTreeSet<Ref>,
    pub calls: Vec<Call>,
    pub guards: Vec<Guard>,
    pub arith: Vec<Arith>,
    pub asm: Vec<Asm>,
    pub emits: Vec<String>,
    /// Every declaration the body refers to (for scope and unused-import checks).
    #[serde(skip)]
    pub uses: BTreeSet<Id>,
    /// State writes by source offset, for ordering calls and writes across a unit.
    #[serde(skip)]
    pub write_at: Vec<(usize, Ref)>,
    pub src: Src,
}

#[derive(Debug, Clone, Serialize)]
pub struct Graph {
    pub files: BTreeMap<Id, File>,
    pub contracts: BTreeMap<Id, Contract>,
    pub state_vars: BTreeMap<Id, StateVar>,
    pub functions: BTreeMap<Id, Function>,
    /// Every declaration's file, for declarations the graph doesn't keep a table for (structs, errors, events…).
    #[serde(skip)]
    pub decl_file: HashMap<Id, Id>,
    /// Files under the project's library folders (foundry.toml `libs`): trusted dependencies, summarized in slices.
    pub dependency_files: BTreeSet<Id>,
}

/// What a declaration is, from the first pass.
#[derive(Debug, Clone)]
enum Decl {
    StateVar,
    /// A local variable or parameter; `storage` ones can alias state.
    Local { storage: bool, name: String },
    Function { contract: Id, visibility: String },
    Contract { library: bool },
    Other,
}

const ARITH_OPS: [&str; 8] = ["+", "-", "*", "/", "%", "**", "<<", ">>"];

fn walk_nodes<'a>(node: &'a Value, f: &mut impl FnMut(&'a Value)) {
    match node {
        Value::Object(map) => {
            if map.contains_key("nodeType") {
                f(node);
            }
            for v in map.values() {
                walk_nodes(v, f);
            }
        }
        Value::Array(items) => items.iter().for_each(|v| walk_nodes(v, f)),
        _ => {}
    }
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn type_of(node: &Value) -> String {
    s(&node["typeDescriptions"]["typeString"])
}

impl Graph {
    /// Builds the graph from solc's standard-json output.
    pub fn build(output: &Value) -> Graph {
        let mut g = Graph { files: BTreeMap::new(), contracts: BTreeMap::new(), state_vars: BTreeMap::new(), functions: BTreeMap::new(), decl_file: HashMap::new(), dependency_files: BTreeSet::new() };
        let mut decls: HashMap<Id, Decl> = HashMap::new();
        let sources = output["sources"].as_object().cloned().unwrap_or_default();

        // Pass 1: files, contracts, state variables, function shells, and what every declaration is.
        for (path, source) in &sources {
            let ast = &source["ast"];
            let file = source["id"].as_i64().unwrap_or(-1);
            let mut imports = vec![];
            walk_nodes(ast, &mut |n| {
                let id = n["id"].as_i64().unwrap_or(0);
                if n.get("name").is_some() || n["nodeType"] == "ContractDefinition" {
                    g.decl_file.insert(id, file);
                }
                match n["nodeType"].as_str().unwrap_or("") {
                    "ImportDirective" => imports.push(s(&n["absolutePath"])),
                    "ContractDefinition" => {
                        decls.insert(id, Decl::Contract { library: n["contractKind"] == "library" });
                        let kind = if n["abstract"] == true { "abstract".into() } else { s(&n["contractKind"]) };
                        let mut c = Contract {
                            id,
                            name: s(&n["name"]),
                            kind,
                            file,
                            bases: n["linearizedBaseContracts"].as_array().into_iter().flatten().filter_map(Value::as_i64).collect(),
                            state_vars: vec![],
                            functions: vec![],
                            src: Src::of(n),
                        };
                        for member in n["nodes"].as_array().into_iter().flatten() {
                            let mid = member["id"].as_i64().unwrap_or(0);
                            match member["nodeType"].as_str().unwrap_or("") {
                                "VariableDeclaration" => {
                                    c.state_vars.push(mid);
                                    g.state_vars.insert(mid, StateVar {
                                        id: mid,
                                        name: s(&member["name"]),
                                        contract: id,
                                        type_string: type_of(member),
                                        constant: member["constant"] == true,
                                        immutable: member["mutability"] == "immutable",
                                        visibility: s(&member["visibility"]),
                                        slot: None,
                                        offset: None,
                                        src: Src::of(member),
                                    });
                                }
                                "FunctionDefinition" | "ModifierDefinition" => c.functions.push(mid),
                                _ => {}
                            }
                        }
                        g.contracts.insert(id, c);
                    }
                    "VariableDeclaration" => {
                        let d = if n["stateVariable"] == true { Decl::StateVar } else { Decl::Local { storage: n["storageLocation"] == "storage", name: s(&n["name"]) } };
                        decls.insert(id, d);
                    }
                    "FunctionDefinition" | "ModifierDefinition" => {
                        decls.insert(id, Decl::Function { contract: n["scope"].as_i64().unwrap_or(0), visibility: s(&n["visibility"]) });
                    }
                    _ => {
                        decls.entry(id).or_insert(Decl::Other);
                    }
                }
            });
            g.files.insert(file, File { id: file, path: path.clone(), imports });
        }

        // Storage slots, by state variable id.
        for contracts in output["contracts"].as_object().into_iter().flat_map(|m| m.values()) {
            for contract in contracts.as_object().into_iter().flat_map(|m| m.values()) {
                for slot in contract["storageLayout"]["storage"].as_array().into_iter().flatten() {
                    if let Some(var) = slot["astId"].as_i64().and_then(|id| g.state_vars.get_mut(&id)) {
                        var.slot = Some(s(&slot["slot"]));
                        var.offset = slot["offset"].as_u64();
                    }
                }
            }
        }

        // Pass 2: each function and modifier body.
        for source in sources.values() {
            walk_nodes(&source["ast"], &mut |n| {
                let ty = n["nodeType"].as_str().unwrap_or("");
                if ty == "FunctionDefinition" || ty == "ModifierDefinition" {
                    let f = FnVisitor::run(n, ty, &decls, &g.state_vars);
                    g.functions.insert(f.id, f);
                }
            });
        }
        // The owning contract from the AST's nesting (modifiers carry no `scope`).
        for c in g.contracts.values() {
            for f in &c.functions {
                if let Some(func) = g.functions.get_mut(f) {
                    func.contract = c.id;
                }
            }
        }
        g
    }

    /// Marks files under these folders as dependencies.
    pub fn mark_dependencies(&mut self, libs: &[String]) {
        for f in self.files.values() {
            if libs.iter().any(|l| f.path.starts_with(&format!("{}/", l.trim_end_matches('/')))) || f.path.contains("node_modules/") {
                self.dependency_files.insert(f.id);
            }
        }
    }

    /// Whether a function lives in a dependency.
    pub fn is_dependency(&self, f: Id) -> bool {
        self.functions.get(&f).is_some_and(|f| self.dependency_files.contains(&f.src.file))
    }

    pub fn contract_by_name(&self, name: &str) -> Option<&Contract> {
        self.contracts.values().find(|c| c.name == name)
    }

    pub fn file_of(&self, decl: Id) -> Option<Id> {
        self.decl_file.get(&decl).copied()
    }

    /// `Contract.name` for a function or state variable, for messages.
    pub fn qualified(&self, id: Id) -> String {
        let (name, contract) = match (self.functions.get(&id), self.state_vars.get(&id)) {
            (Some(f), _) => (f.name.clone(), f.contract),
            (_, Some(v)) => (v.name.clone(), v.contract),
            _ => return format!("#{id}"),
        };
        let c = self.contracts.get(&contract).map(|c| c.name.as_str()).unwrap_or("?");
        let name = if name.is_empty() { self.functions.get(&id).map(|f| f.kind.clone()).unwrap_or_default() } else { name };
        format!("{c}.{name}")
    }
}

/// Walks one function or modifier body.
struct FnVisitor<'a> {
    decls: &'a HashMap<Id, Decl>,
    state: &'a BTreeMap<Id, StateVar>,
    f: Function,
    /// Storage pointers declared in the body: local id → what it points at.
    alias: HashMap<Id, Ref>,
    /// Parameter id → index, for `storage` parameters.
    params: HashMap<Id, usize>,
    /// Identifier node ids that are only the target of a plain `=`, so not reads.
    assign_only: BTreeSet<Id>,
    unchecked: usize,
    /// (source offset, index into calls) for external/low-level calls, and offsets of writes, for `before_write`.
    ext_at: Vec<(usize, usize)>,
    write_at: Vec<(usize, Ref)>,
}

impl<'a> FnVisitor<'a> {
    fn run(n: &Value, ty: &str, decls: &'a HashMap<Id, Decl>, state: &'a BTreeMap<Id, StateVar>) -> Function {
        let params: Vec<&Value> = n["parameters"]["parameters"].as_array().into_iter().flatten().collect();
        let types: Vec<String> = params.iter().map(|p| type_of(p)).collect();
        let kind = if ty == "ModifierDefinition" { "modifier".to_string() } else { s(&n["kind"]) };
        let mut v = FnVisitor {
            decls,
            state,
            f: Function {
                id: n["id"].as_i64().unwrap_or(0),
                name: s(&n["name"]),
                contract: n["scope"].as_i64().unwrap_or(0),
                kind,
                visibility: s(&n["visibility"]),
                mutability: s(&n["stateMutability"]),
                virtual_: n["virtual"] == true,
                implemented: n["implemented"] != false,
                signature: format!("{}({})", s(&n["name"]), types.join(",")),
                modifiers: n["modifiers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|m| m["kind"] != "baseConstructorSpecifier")
                    .filter_map(|m| m["modifierName"]["referencedDeclaration"].as_i64())
                    .collect(),
                storage_params: vec![],
                reads: BTreeSet::new(),
                writes: BTreeSet::new(),
                calls: vec![],
                guards: vec![],
                arith: vec![],
                asm: vec![],
                emits: vec![],
                uses: BTreeSet::new(),
                write_at: vec![],
                src: Src::of(n),
            },
            alias: HashMap::new(),
            params: HashMap::new(),
            assign_only: BTreeSet::new(),
            unchecked: 0,
            ext_at: vec![],
            write_at: vec![],
        };
        for (i, p) in params.iter().enumerate() {
            if p["storageLocation"] == "storage" {
                v.f.storage_params.push(i);
                v.params.insert(p["id"].as_i64().unwrap_or(0), i);
            }
        }
        // Modifier invocations' arguments are evaluated in the function too.
        for m in n["modifiers"].as_array().into_iter().flatten() {
            v.visit(&m["arguments"]);
        }
        v.visit(&n["body"]);
        for (at, call) in &v.ext_at {
            v.f.calls[*call].before_write = v.write_at.iter().any(|(w, _)| w > at);
        }
        v.f.write_at = std::mem::take(&mut v.write_at);
        v.f
    }

    /// The storage an expression refers to: `x`, `x[i]`, `x.field`, `x[i].field[j]`, a storage pointer, or a
    /// storage parameter.
    fn base(&self, e: &Value) -> Option<Ref> {
        match e["nodeType"].as_str()? {
            "Identifier" => self.ident_ref(e["referencedDeclaration"].as_i64()?),
            "IndexAccess" => self.base(&e["baseExpression"]),
            "MemberAccess" => {
                // `a.b` where `a` is a contract or address is a call or a balance, not storage.
                let t = type_of(&e["expression"]);
                if t.starts_with("contract ") || t.starts_with("address") || t.starts_with("type(") {
                    None
                } else {
                    self.base(&e["expression"])
                }
            }
            "TupleExpression" => {
                let parts = e["components"].as_array()?;
                if parts.len() == 1 { self.base(&parts[0]) } else { None }
            }
            _ => None,
        }
    }

    fn ident_ref(&self, decl: Id) -> Option<Ref> {
        match self.decls.get(&decl) {
            Some(Decl::StateVar) => {
                // Constants and immutables aren't storage.
                let var = self.state.get(&decl)?;
                (!var.constant && !var.immutable).then_some(Ref::State(decl))
            }
            Some(Decl::Local { .. }) => self.alias.get(&decl).copied().or_else(|| self.params.get(&decl).map(|i| Ref::Param(*i))),
            _ => None,
        }
    }

    fn write(&mut self, target: &Value) {
        if let Some(r) = self.base(target) {
            self.f.writes.insert(r);
            self.write_at.push((Src::of(target).start, r));
        }
    }

    fn visit(&mut self, n: &Value) {
        match n {
            Value::Array(items) => {
                for item in items {
                    self.visit(item);
                }
                return;
            }
            Value::Object(_) => {}
            _ => return,
        }
        let ty = n["nodeType"].as_str().unwrap_or("");
        if let Some(d) = n["referencedDeclaration"].as_i64() {
            self.f.uses.insert(d);
        }
        match ty {
            "Identifier" => {
                if let Some(r) = n["referencedDeclaration"].as_i64().and_then(|d| self.ident_ref(d)) {
                    if !self.assign_only.contains(&n["id"].as_i64().unwrap_or(0)) {
                        self.f.reads.insert(r);
                    }
                }
                return;
            }
            "UncheckedBlock" => {
                self.unchecked += 1;
                self.visit(&n["statements"]);
                self.unchecked -= 1;
                return;
            }
            "VariableDeclarationStatement" => {
                // `Loan storage loan = loans[id];` makes `loan` an alias of `loans`.
                let decls: Vec<&Value> = n["declarations"].as_array().into_iter().flatten().collect();
                if decls.len() == 1 && decls[0]["storageLocation"] == "storage" {
                    if let Some(r) = self.base(&n["initialValue"]) {
                        self.alias.insert(decls[0]["id"].as_i64().unwrap_or(0), r);
                    }
                }
                self.visit(&n["initialValue"]);
                return;
            }
            "Assignment" => {
                let lhs = &n["leftHandSide"];
                let op = s(&n["operator"]);
                // Re-pointing a storage pointer (`loan = loans[other]`) moves the alias; it writes nothing.
                if lhs["nodeType"] == "Identifier" {
                    if let Some(Decl::Local { storage: true, .. }) = lhs["referencedDeclaration"].as_i64().and_then(|d| self.decls.get(&d)) {
                        if let Some(r) = self.base(&n["rightHandSide"]) {
                            self.alias.insert(lhs["referencedDeclaration"].as_i64().unwrap_or(0), r);
                        }
                        self.visit(&n["rightHandSide"]);
                        return;
                    }
                }
                let targets: Vec<&Value> = if lhs["nodeType"] == "TupleExpression" {
                    lhs["components"].as_array().into_iter().flatten().filter(|c| !c.is_null()).collect()
                } else {
                    vec![lhs]
                };
                for t in &targets {
                    if op == "=" && t["nodeType"] == "Identifier" {
                        self.assign_only.insert(t["id"].as_i64().unwrap_or(0));
                    }
                }
                if op != "=" {
                    self.arith_site(op.trim_end_matches('='), &type_of(lhs), n, None);
                }
                self.visit(&n["rightHandSide"]);
                self.visit(lhs);
                for t in targets {
                    self.write(t);
                }
                return;
            }
            "UnaryOperation" => {
                let op = s(&n["operator"]);
                if op == "++" || op == "--" || op == "delete" {
                    if op != "delete" {
                        self.arith_site(&op, &type_of(&n["subExpression"]), n, None);
                    }
                    self.visit(&n["subExpression"]);
                    self.write(&n["subExpression"]);
                    return;
                }
            }
            "BinaryOperation" => {
                let op = s(&n["operator"]);
                let t = s(&n["commonType"]["typeString"]);
                if ARITH_OPS.contains(&op.as_str()) && (t.starts_with("uint") || t.starts_with("int")) {
                    self.arith_site(&op, &t, n, None);
                }
            }
            "EmitStatement" => {
                self.f.emits.push(s(&n["eventCall"]["expression"]["name"]));
                self.visit(&n["eventCall"]["arguments"]);
                return;
            }
            "IfStatement" => {
                if reverts(&n["trueBody"]) {
                    self.f.guards.push(Guard { kind: "if-revert".into(), cond: Src::of(&n["condition"]) });
                }
            }
            "FunctionCall" => {
                self.call(n);
            }
            "InlineAssembly" => {
                self.assembly(n);
                return;
            }
            _ => {}
        }
        if let Value::Object(map) = n {
            for (k, v) in map {
                if k != "typeDescriptions" && k != "documentation" {
                    self.visit(v);
                }
            }
        }
    }

    fn arith_site(&mut self, op: &str, t: &str, n: &Value, rounding: Option<String>) {
        if t.starts_with("int_const") || t.starts_with("rational_const") {
            return;
        }
        self.f.arith.push(Arith { op: op.into(), type_string: t.into(), checked: self.unchecked == 0, rounding, src: Src::of(n) });
    }

    fn push_call(&mut self, kind: CallKind, target: Option<Id>, name: String, n: &Value, args: Vec<Option<Ref>>) {
        let at = Src::of(n).start;
        if matches!(kind, CallKind::External | CallKind::ExternalLibrary | CallKind::LowLevel) {
            self.ext_at.push((at, self.f.calls.len()));
        }
        self.f.calls.push(Call { kind, target, name, src: Src::of(n), args, before_write: false, direct: false });
    }

    fn call(&mut self, n: &Value) {
        let kind = s(&n["kind"]);
        if kind == "typeConversion" || kind == "structConstructorCall" {
            return;
        }
        let mut callee = &n["expression"];
        if callee["nodeType"] == "FunctionCallOptions" {
            callee = &callee["expression"];
        }
        let target = callee["referencedDeclaration"].as_i64();
        let name = s(if callee["nodeType"] == "MemberAccess" { &callee["memberName"] } else { &callee["name"] });
        let args: Vec<&Value> = n["arguments"].as_array().into_iter().flatten().collect();

        // mulDiv and friends, wherever they come from: an arithmetic site with its rounding.
        let lower = name.to_lowercase();
        if lower.starts_with("muldiv") {
            let text = n.to_string();
            let ceil = lower.contains("up") || lower.contains("ceil") || text.contains("\"Ceil\"") || text.contains("\"Up\"");
            self.arith_site("mulDiv", &type_of(n), n, Some(if ceil { "ceil" } else { "floor" }.into()));
        }

        if callee["nodeType"] == "NewExpression" {
            self.push_call(CallKind::External, None, format!("new {}", type_of(&callee["typeName"])), n, vec![]);
            return;
        }
        if target.is_none() || target.is_some_and(|t| t < 0) {
            // Builtins: require/assert are guards; push/pop write storage; address.call & co are low-level calls.
            match name.as_str() {
                "require" | "assert" => {
                    if let Some(cond) = args.first() {
                        self.f.guards.push(Guard { kind: name.clone(), cond: Src::of(cond) });
                    }
                }
                "push" | "pop" => self.write(&callee["expression"]),
                "call" | "delegatecall" | "staticcall" | "transfer" | "send" if type_of(&callee["expression"]).starts_with("address") => {
                    self.push_call(CallKind::LowLevel, None, name.clone(), n, vec![]);
                }
                _ => {}
            }
            return;
        }
        let target = target.unwrap();
        let Some(Decl::Function { contract, visibility }) = self.decls.get(&target) else {
            return; // events, errors, struct or function-type values
        };
        let library = matches!(self.decls.get(contract), Some(Decl::Contract { library: true }));
        let base_type = if callee["nodeType"] == "MemberAccess" { type_of(&callee["expression"]) } else { String::new() };
        let call_kind = if library {
            // Library functions (directly or via `using for`): internal ones are inlined, the rest are delegatecalls.
            if visibility == "internal" || visibility == "private" { CallKind::Internal } else { CallKind::ExternalLibrary }
        } else if callee["nodeType"] == "Identifier" || base_type.starts_with("type(contract ") {
            // f(), super.f(), Base.f()
            CallKind::Internal
        } else if base_type.starts_with("contract ") || base_type.starts_with("address") {
            // other.f(), this.f()
            CallKind::External
        } else {
            CallKind::Internal
        };
        let mapped: Vec<Option<Ref>> = if call_kind == CallKind::Internal {
            // `using for` passes the receiver as the first argument.
            let mut all: Vec<&Value> = vec![];
            if callee["nodeType"] == "MemberAccess" && !base_type.starts_with("type(") {
                all.push(&callee["expression"]);
            }
            all.extend(args.iter().copied());
            all.iter().map(|a| self.base(a)).collect()
        } else {
            vec![]
        };
        self.push_call(call_kind, Some(target), name, n, mapped);
        if base_type.starts_with("type(contract ") {
            self.f.calls.last_mut().unwrap().direct = true;
        }
    }

    fn assembly(&mut self, n: &Value) {
        let mut refs = vec![];
        for r in n["externalReferences"].as_array().into_iter().flatten() {
            let decl = r["declaration"].as_i64().unwrap_or(0);
            let name = match (self.state.get(&decl), self.decls.get(&decl)) {
                (Some(v), _) => v.name.clone(),
                (_, Some(Decl::Local { name, .. })) => name.clone(),
                _ => String::new(),
            };
            refs.push(AsmRef { decl, name, slot: r["isSlot"] == true, offset: r["isOffset"] == true });
        }
        let mut ops = BTreeSet::new();
        walk_nodes(&n["AST"], &mut |y| {
            if y["nodeType"] == "YulFunctionCall" {
                ops.insert(s(&y["functionName"]["name"]));
            }
        });
        // A state variable's `.slot` used with sload/sstore is a read/write of that variable.
        for r in &refs {
            if let Some(var) = self.ident_ref(r.decl) {
                if ops.contains("sstore") || ops.contains("tstore") {
                    self.f.writes.insert(var);
                    self.write_at.push((Src::of(n).start, var));
                }
                if ops.contains("sload") || ops.contains("tload") || !r.slot {
                    self.f.reads.insert(var);
                }
            }
            self.f.uses.insert(r.decl);
        }
        for op in ["call", "delegatecall", "staticcall", "callcode", "create", "create2"] {
            if ops.contains(op) {
                self.push_call(CallKind::LowLevel, None, format!("assembly {op}"), n, vec![]);
            }
        }
        self.f.asm.push(Asm { src: Src::of(n), refs, ops });
    }
}

/// Whether a statement always reverts: `revert ...`, `revert(...)`, or a block that starts with one.
fn reverts(body: &Value) -> bool {
    match body["nodeType"].as_str().unwrap_or("") {
        "RevertStatement" => true,
        "Block" => body["statements"].as_array().and_then(|s| s.first()).is_some_and(reverts),
        "ExpressionStatement" => {
            let e = &body["expression"];
            e["nodeType"] == "FunctionCall" && e["expression"]["name"] == "revert"
        }
        _ => false,
    }
}
