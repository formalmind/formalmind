//! Anvil forks for Debug: scripts run against a fork of the chain they target. A fork keeps its state in
//! ~/.formalmind/anvil/<name>.json (loaded when it starts again, written as it runs), keeps running across debug
//! sessions and app restarts, and is listed so it can be reused; cleaning it stops it and deletes that state.
//!
//! The RPC URL behind a fork comes from the chain's variable (`rpcUrlEnv` in script/config/chains.json, e.g.
//! RPC_URL_ARC), read from the environment or the folder's .env / .env.deploy. It never leaves this file: the app
//! only sees the variable's name and the fork's local URL.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Serialize, Deserialize, Clone)]
pub struct Fork {
    /// `<folder name>-<chain id>`: also the state file's name.
    pub name: String,
    pub folder: String,
    pub chain_id: u64,
    pub port: u16,
    pub pid: u32,
    /// The variable the fork URL came from (never the URL).
    pub rpc_env: String,
    /// Whether it answers now (filled in when listed).
    #[serde(default)]
    pub alive: bool,
}

fn dir() -> Result<PathBuf, String> {
    let d = crate::local::home()?.join("anvil");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn registry() -> Result<PathBuf, String> {
    Ok(dir()?.join("forks.json"))
}

fn load() -> Vec<Fork> {
    registry().ok().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(forks: &[Fork]) -> Result<(), String> {
    std::fs::write(registry()?, serde_json::to_string_pretty(forks).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// The chain id a node at `port` answers with, if it answers.
fn chain_at(port: u16) -> Option<u64> {
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": [] }).to_string();
    let out = Command::new("curl")
        .args(["-s", "-m", "2", "-X", "POST", "-H", "content-type: application/json", "--data", &body, &format!("http://127.0.0.1:{port}")])
        .output()
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    u64::from_str_radix(v["result"].as_str()?.trim_start_matches("0x"), 16).ok()
}

/// A variable from the environment, else the folder's .env.deploy or .env (later files don't override earlier).
fn env_var(folder: &Path, key: &str) -> Option<String> {
    if let Ok(v) = std::env::var(key) {
        return Some(v);
    }
    for file in [".env.deploy", ".env"] {
        let Ok(text) = std::fs::read_to_string(folder.join(file)) else { continue };
        let vars: HashMap<String, String> = text
            .lines()
            .filter_map(|l| {
                let l = l.trim();
                let l = l.strip_prefix("export ").unwrap_or(l);
                if l.starts_with('#') {
                    return None;
                }
                let (k, v) = l.split_once('=')?;
                Some((k.trim().to_string(), v.trim().trim_matches('"').trim_matches('\'').to_string()))
            })
            .collect();
        if let Some(v) = vars.get(key).filter(|v| !v.is_empty()) {
            return Some(v.clone());
        }
    }
    None
}

fn anvil() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    [format!("{home}/.foundry/bin/anvil"), "/opt/homebrew/bin/anvil".into(), "/usr/local/bin/anvil".into()]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
        .unwrap_or_else(|| "anvil".into())
}

/// Stops the process only if it's still anvil (a pid can be reused after a restart).
fn kill_anvil(pid: u32) {
    let out = Command::new("ps").args(["-p", &pid.to_string(), "-o", "comm="]).output();
    if out.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains("anvil")) {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

/// The forks Formal Mind knows (any folder), with whether each still answers.
#[tauri::command]
pub fn anvil_list() -> Vec<Fork> {
    load().into_iter().map(|f| Fork { alive: chain_at(f.port) == Some(f.chain_id), ..f }).collect()
}

/// Whether the folder has a value for a chain's RPC variable (never the value).
#[tauri::command]
pub fn anvil_rpc_known(folder: String, rpc_env: String) -> Result<bool, String> {
    if !crate::local::is_added(&folder)? {
        return Err("Add the folder first".into());
    }
    Ok(env_var(Path::new(&folder), &rpc_env).is_some())
}

/// Starts (or restarts) the fork of a chain for a folder, from its saved state when there is one.
#[tauri::command]
pub fn anvil_start(folder: String, chain_id: u64, rpc_env: String) -> Result<Fork, String> {
    if !crate::local::is_added(&folder)? {
        return Err("Add the folder first".into());
    }
    let url = env_var(Path::new(&folder), &rpc_env).ok_or_else(|| format!("{rpc_env} isn't set (add it to the folder's .env.deploy or .env)"))?;
    let base = Path::new(&folder).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "folder".into());
    let name = format!("{base}-{chain_id}");
    let mut forks = load();
    // Already running: reuse it.
    if let Some(f) = forks.iter().find(|f| f.name == name && f.folder == folder) {
        if chain_at(f.port) == Some(chain_id) {
            return Ok(Fork { alive: true, ..f.clone() });
        }
    }
    let port = free_port()?;
    let state = dir()?.join(format!("{name}.json"));
    let child = Command::new(anvil())
        .args(["--fork-url", &url, "--port", &port.to_string(), "--chain-id", &chain_id.to_string(), "--silent", "--state-interval", "30"])
        .arg("--state")
        .arg(&state)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't start anvil: {e} (install Foundry)"))?;
    let fork = Fork { name: name.clone(), folder, chain_id, port, pid: child.id(), rpc_env, alive: false };
    // Wait for it to answer (forking fetches the head block first).
    let mut alive = false;
    for _ in 0..60 {
        if chain_at(port) == Some(chain_id) {
            alive = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    if !alive {
        kill_anvil(fork.pid);
        return Err(format!("anvil didn't answer on port {port} (check {})", fork.rpc_env));
    }
    forks.retain(|f| f.name != name);
    forks.push(fork.clone());
    save(&forks)?;
    Ok(Fork { alive: true, ..fork })
}

/// Stops a fork; with `clean`, deletes its saved state too (the next start forks fresh).
#[tauri::command]
pub fn anvil_stop(name: String, clean: bool) -> Result<(), String> {
    let mut forks = load();
    if let Some(f) = forks.iter().find(|f| f.name == name) {
        // SIGTERM lets anvil write its state before it exits.
        kill_anvil(f.pid);
    }
    if clean {
        let _ = std::fs::remove_file(dir()?.join(format!("{name}.json")));
        forks.retain(|f| f.name != name);
    }
    save(&forks)
}
