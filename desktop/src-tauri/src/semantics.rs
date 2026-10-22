//! An isolated, measured experiment; never contributes to contract proof coverage.
use serde::Serialize;
use serde_json::Value;
use std::{path::PathBuf, sync::Mutex};
use tauri::Manager;

const RUNNER: &str = include_str!("../../../spikes/solidcore-setexecutor/run.py");
const FIXTURE: &str = include_str!("../../../spikes/solidcore-setexecutor/SetExecutor.sol");

#[derive(Default, Clone, Serialize)]
pub struct Status {
    running: bool,
    directory: Option<PathBuf>,
    error: Option<String>,
}
static STATUS: Mutex<Status> = Mutex::new(Status { running: false, directory: None, error: None });

#[tauri::command]
pub fn semantics_status() -> Result<Value, String> {
    let status = STATUS.lock().map_err(|e| e.to_string())?.clone();
    let report = status.directory.as_ref().and_then(|d| std::fs::read(d.join("report.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    Ok(serde_json::json!({ "running": status.running, "directory": status.directory, "error": status.error, "report": report }))
}

#[tauri::command]
pub async fn semantics_run(app: tauri::AppHandle, solidcore: String, solc: String) -> Result<Value, String> {
    let solidcore = PathBuf::from(solidcore).canonicalize().map_err(|e| format!("SolidCore checkout: {e}"))?;
    if !solidcore.join("scripts/solc_ast_to_lean_source.py").is_file() || !solidcore.join("lean-toolchain").is_file() {
        return Err("Choose a built solidity-lean checkout containing the solc AST importer.".into());
    }
    let solc = PathBuf::from(solc).canonicalize().map_err(|e| format!("solc executable: {e}"))?;
    if !solc.is_file() { return Err("Choose the solc executable.".into()); }
    let base = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("semantics");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let directory = base.join(stamp.to_string());
    {
        let mut status = STATUS.lock().map_err(|e| e.to_string())?;
        if status.running { return Err("A semantics experiment is already running.".into()); }
        std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
        *status = Status { running: true, directory: Some(directory.clone()), error: None };
    }
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        std::fs::write(directory.join("run.py"), RUNNER).map_err(|e| e.to_string())?;
        std::fs::write(directory.join("SetExecutor.sol"), FIXTURE).map_err(|e| e.to_string())?;
        let output = std::process::Command::new(crate::platform::find_tool("python3"))
            .arg(directory.join("run.py"))
            .arg("--solidcore").arg(solidcore)
            .arg("--solc").arg(solc)
            .arg("--output").arg(&directory)
            .env("PATH", crate::platform::tool_path(None))
            .output().map_err(|e| format!("Could not start Python 3: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).chars().take(8000).collect());
        }
        Ok(())
    }).await.map_err(|e| e.to_string()).and_then(|r| r);
    {
        let mut status = STATUS.lock().map_err(|e| e.to_string())?;
        status.running = false;
        status.error = result.err();
    }
    semantics_status()
}
