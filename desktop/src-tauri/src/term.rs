//! Terminals for the Code tab: a pseudo-terminal running the bundled Neovim (Vim mode) in a folder. Output streams to
//! the webview (xterm.js) as `term:data`; keys and resizes come back as commands; `term:exit` when it ends.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

fn terms() -> &'static Mutex<HashMap<u32, Term>> {
    static T: OnceLock<Mutex<HashMap<u32, Term>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

/// The bundled nvim and its runtime (Resources/nvim), or one installed on the machine.
fn nvim(app: &AppHandle) -> (PathBuf, Option<PathBuf>) {
    if let Ok(res) = app.path().resource_dir() {
        let bin = res.join("nvim/bin/nvim");
        if bin.exists() {
            return (bin, Some(res.join("nvim/share/nvim/runtime")));
        }
    }
    let found = ["/opt/homebrew/bin/nvim", "/usr/local/bin/nvim"].into_iter().map(PathBuf::from).find(|p| p.exists());
    (found.unwrap_or_else(|| "nvim".into()), None)
}

/// Starts Neovim on a file (relative to the folder) in a terminal of this size; returns the terminal's id.
#[tauri::command]
pub fn term_start(app: AppHandle, folder: String, path: Option<String>, line: Option<u32>, cols: u16, rows: u16) -> Result<u32, String> {
    if !crate::local::is_added(&folder)? {
        return Err("Add the folder first".into());
    }
    static NEXT: AtomicU32 = AtomicU32::new(1);
    let pair = native_pty_system().openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let (bin, runtime) = nvim(&app);
    let mut cmd = CommandBuilder::new(&bin);
    if let Some(l) = line {
        cmd.arg(format!("+{l}"));
    }
    if let Some(p) = &path {
        cmd.arg(p);
    }
    cmd.cwd(&folder);
    // A real terminal: full colour, and the PATH a shell would have (apps opened from Finder get a short one).
    let home = std::env::var("HOME").unwrap_or_default();
    let base = std::env::var("PATH").unwrap_or_default();
    cmd.env("PATH", format!("{home}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:{base}"));
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LANG", std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()));
    if let Some(rt) = runtime {
        cmd.env("VIMRUNTIME", rt);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("Couldn't start Neovim ({}): {e}", bin.display()))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = NEXT.fetch_add(1, Ordering::SeqCst);

    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app.emit("term:data", json!({ "id": id, "data": crate::swarm::base64(&buf[..n]) }));
                }
            }
        }
        // Take it out first, so waiting on the process never holds the lock.
        let ended = terms().lock().ok().and_then(|mut all| all.remove(&id));
        if let Some(mut t) = ended {
            let _ = t.child.wait();
        }
        let _ = app.emit("term:exit", json!({ "id": id }));
    });

    terms().lock().map_err(|e| e.to_string())?.insert(id, Term { master: pair.master, writer, child });
    Ok(id)
}

/// Keys typed into the terminal.
#[tauri::command]
pub fn term_write(id: u32, data: String) -> Result<(), String> {
    let mut all = terms().lock().map_err(|e| e.to_string())?;
    let t = all.get_mut(&id).ok_or("The terminal has ended")?;
    t.writer.write_all(data.as_bytes()).and_then(|_| t.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let all = terms().lock().map_err(|e| e.to_string())?;
    let t = all.get(&id).ok_or("The terminal has ended")?;
    t.master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_kill(id: u32) -> Result<(), String> {
    if let Some(mut t) = terms().lock().map_err(|e| e.to_string())?.remove(&id) {
        let _ = t.child.kill();
    }
    Ok(())
}
