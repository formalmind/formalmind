//! formal-ast in the browser (the website's Proofs tab). The website has no solc binary and no disk: the files come
//! from the browser's git copy as `{ paths, text }` (every path the project has; the text of those read so far) and
//! solc's output from solc-js, run on the input [`input`] builds. Everything goes in and out as JSON text, and an
//! error is thrown as a string, as the Mac app's commands return them.

use formal_ast::fs::Memory;
use formal_ast::solc::{self, Project};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct Files {
    paths: Vec<String>,
    text: BTreeMap<String, String>,
}

fn err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn project(files: &str) -> Result<Project, JsValue> {
    let f: Files = serde_json::from_str(files).map_err(err)?;
    Project::from_files(PathBuf::new(), Arc::new(Memory::new(f.paths, f.text))).map_err(|e| err(format!("{e:#}")))
}

fn output(text: &str, entry: &str) -> Result<Value, JsValue> {
    let mut v: Value = serde_json::from_str(text).map_err(err)?;
    signed_declarations(&mut v);
    solc::check(v, entry).map_err(|e| err(format!("{e:#}")))
}

/// soljson is 32-bit and prints the ids of built-ins (`msg` is -15) unsigned: 4294967281. Native solc prints them
/// signed, and formal-ast reads a negative `referencedDeclaration` as a built-in.
fn signed_declarations(v: &mut Value) {
    const WRAP: u64 = 1 << 32;
    let fix = |n: &mut Value| {
        if let Some(u) = n.as_u64().filter(|u| *u >= WRAP / 2 && *u < WRAP) {
            *n = json!(u as i64 - WRAP as i64);
        }
    };
    match v {
        Value::Object(map) => {
            for (k, x) in map.iter_mut() {
                if k.ends_with("eclaration") || k.ends_with("eclarations") {
                    match x {
                        Value::Array(items) => items.iter_mut().for_each(fix),
                        n => fix(n),
                    }
                } else {
                    signed_declarations(x);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(signed_declarations),
        _ => {}
    }
}

/// solc's standard JSON input for the entry file and the version to compile it with: `{ input, version }`.
#[wasm_bindgen]
pub fn input(files: &str, entry: &str) -> Result<String, JsValue> {
    let p = project(files)?;
    let (input, version) = solc::input(&p, entry).map_err(|e| err(format!("{e:#}")))?;
    Ok(json!({ "input": input, "version": version }).to_string())
}

/// `ast_units`, with every unit's slice (`slices`, by unit name) for `ast_slice`.
#[wasm_bindgen]
pub fn units(files: &str, entry: &str, solc_output: &str) -> Result<String, JsValue> {
    let a = formal_ast::analyze_output(project(files)?, entry, None, &output(solc_output, entry)?).map_err(|e| err(format!("{e:#}")))?;
    let mut v = formal_ast::audit_json(&a, 0);
    v["slices"] = json!(formal_ast::all_slices(&a));
    Ok(v.to_string())
}

/// `ast_formal`: the Lean model's coverage of the entry contract.
#[wasm_bindgen]
pub fn formal(files: &str, entry: &str, solc_output: &str) -> Result<String, JsValue> {
    let out = output(solc_output, entry)?;
    let a = formal_ast::analyze_output(project(files)?, entry, None, &out).map_err(|e| err(format!("{e:#}")))?;
    Ok(formal_ast::formal_json(&a, &out, 0).to_string())
}

/// The scripts `ast_scripts` compiles, each on its own.
#[wasm_bindgen]
pub fn script_files(files: &str) -> Result<String, JsValue> {
    Ok(json!(formal_ast::script_files(&*project(files)?.files)).to_string())
}

/// `ast_scripts`, given solc's outputs (`outputs`, a JSON array: several scripts can share one) and, by script path,
/// the index of its output or why it didn't compile (`by_script`: `{ "script/A.s.sol": 0, "script/B.s.sol": "…" }`).
#[wasm_bindgen]
pub fn scripts(files: &str, outputs: &str, by_script: &str) -> Result<String, JsValue> {
    let p = project(files)?;
    let texts: Vec<String> = serde_json::from_str(outputs).map_err(err)?;
    let mut parsed: Vec<Option<Rc<Value>>> = vec![None; texts.len()];
    let by_script: BTreeMap<String, Value> = serde_json::from_str(by_script).map_err(err)?;
    let v = formal_ast::script_entries_with(&p, |script| {
        match by_script.get(script) {
            Some(Value::Number(n)) => {
                let i = n.as_u64().unwrap_or(u64::MAX) as usize;
                let text = texts.get(i).ok_or_else(|| anyhow::anyhow!("{script} wasn't compiled"))?;
                if parsed[i].is_none() {
                    let mut out: Value = serde_json::from_str(text)?;
                    signed_declarations(&mut out);
                    parsed[i] = Some(Rc::new(solc::check(out, script)?));
                }
                Ok(parsed[i].clone().unwrap())
            }
            Some(Value::String(e)) => anyhow::bail!("{e}"),
            _ => anyhow::bail!("{script} wasn't compiled"),
        }
    })
    .map_err(|e| err(format!("{e:#}")))?;
    Ok(v.to_string())
}
