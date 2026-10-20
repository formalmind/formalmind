//! Neovim in the Code tab: `nvim --embed`, attached as a UI over msgpack-RPC (the line-grid protocol), the way
//! Neovide and VS Code Neovim drive it. Redraw batches go to the webview as `nvim:redraw` events; keys, mouse and
//! resizes come back as commands.
//!
//! The app bundles the official macOS build (binary and runtime) under Resources/nvim; without it (development) it
//! uses the nvim on the machine.

use rmpv::Value as Mp;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

struct Nvim {
    child: Mutex<Child>,
    stdin: Mutex<BufWriter<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u32, Sender<Result<Mp, String>>>>>,
    next: AtomicU32,
}

fn current() -> &'static Mutex<Option<Arc<Nvim>>> {
    static N: OnceLock<Mutex<Option<Arc<Nvim>>>> = OnceLock::new();
    N.get_or_init(Default::default)
}

/// msgpack → JSON for the webview. Buffer/window/tabpage handles (ext types) become their numbers.
fn to_json(v: &Mp) -> Value {
    match v {
        Mp::Nil => Value::Null,
        Mp::Boolean(b) => json!(b),
        Mp::Integer(i) => i.as_i64().map(|n| json!(n)).or_else(|| i.as_u64().map(|n| json!(n))).unwrap_or(Value::Null),
        Mp::F32(f) => json!(f),
        Mp::F64(f) => json!(f),
        Mp::String(s) => json!(s.as_str().map(String::from).unwrap_or_else(|| String::from_utf8_lossy(s.as_bytes()).into_owned())),
        Mp::Binary(b) => json!(String::from_utf8_lossy(b)),
        Mp::Array(a) => Value::Array(a.iter().map(to_json).collect()),
        Mp::Map(m) => Value::Object(m.iter().map(|(k, v)| (k.as_str().map(String::from).unwrap_or_else(|| k.to_string()), to_json(v))).collect()),
        Mp::Ext(_, data) => json!(data.iter().fold(0i64, |n, b| (n << 8) | *b as i64)),
    }
}

/// The bundled nvim and its runtime, or one installed on the machine.
fn binary(app: &AppHandle) -> (PathBuf, Option<PathBuf>) {
    if let Ok(res) = app.path().resource_dir() {
        let bin = res.join("nvim/bin/nvim");
        if bin.exists() {
            return (bin, Some(res.join("nvim/share/nvim/runtime")));
        }
    }
    let found = ["/opt/homebrew/bin/nvim", "/usr/local/bin/nvim"].into_iter().map(PathBuf::from).find(|p| p.exists());
    (found.unwrap_or_else(|| "nvim".into()), None)
}

impl Nvim {
    fn start(app: &AppHandle, folder: &str) -> Result<Arc<Nvim>, String> {
        let (bin, runtime) = binary(app);
        let mut cmd = Command::new(&bin);
        cmd.arg("--embed").current_dir(folder).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(rt) = runtime {
            cmd.env("VIMRUNTIME", rt);
        }
        // Apps opened from Finder don't get the shell's PATH; language servers and git live in these.
        let home = std::env::var("HOME").unwrap_or_default();
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{home}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:{path}"));
        let mut child = cmd.spawn().map_err(|e| format!("Couldn't start Neovim ({}): {e}", bin.display()))?;
        let stdin = BufWriter::new(child.stdin.take().ok_or("no stdin")?);
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let pending: Arc<Mutex<HashMap<u32, Sender<Result<Mp, String>>>>> = Arc::default();
        let nvim = Arc::new(Nvim { child: Mutex::new(child), stdin: Mutex::new(stdin), pending: pending.clone(), next: AtomicU32::new(1) });

        let app = app.clone();
        let weak = Arc::downgrade(&nvim);
        std::thread::spawn(move || {
            let mut r = BufReader::new(stdout);
            while let Ok(msg) = rmpv::decode::read_value(&mut r) {
                let Some(parts) = msg.as_array() else { continue };
                match parts.first().and_then(Mp::as_u64) {
                    // [1, id, error, result]
                    Some(1) => {
                        let id = parts.get(1).and_then(Mp::as_u64).unwrap_or(0) as u32;
                        let err = parts.get(2).filter(|e| !e.is_nil()).map(|e| to_json(e).to_string());
                        if let Some(tx) = pending.lock().ok().and_then(|mut p| p.remove(&id)) {
                            let _ = tx.send(match err {
                                Some(e) => Err(e),
                                None => Ok(parts.get(3).cloned().unwrap_or(Mp::Nil)),
                            });
                        }
                    }
                    // [2, method, params]
                    Some(2) => {
                        let method = parts.get(1).and_then(Mp::as_str).unwrap_or("");
                        let params = parts.get(2).map(to_json).unwrap_or(Value::Null);
                        match method {
                            "redraw" => {
                                let _ = app.emit("nvim:redraw", params);
                            }
                            // Our own notifications (see SETUP): the file in the current window.
                            "fm_buf" => {
                                let _ = app.emit("nvim:buffer", params);
                            }
                            _ => {}
                        }
                    }
                    // A request from nvim (rpcrequest): answer so it never waits.
                    Some(0) => {
                        if let Some(n) = weak.upgrade() {
                            let id = parts.get(1).cloned().unwrap_or(Mp::Nil);
                            let _ = n.write(&Mp::Array(vec![Mp::from(1), id, Mp::Nil, Mp::Nil]));
                        }
                    }
                    _ => {}
                }
            }
            let _ = app.emit("nvim:exit", ());
            if let Ok(mut c) = current().lock() {
                *c = None;
            }
        });
        Ok(nvim)
    }

    fn write(&self, msg: &Mp) -> Result<(), String> {
        let mut w = self.stdin.lock().map_err(|e| e.to_string())?;
        rmpv::encode::write_value(&mut *w, msg).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| format!("Neovim stopped: {e}"))
    }

    fn call(&self, method: &str, args: Vec<Mp>) -> Result<Mp, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();
        self.pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
        self.write(&Mp::Array(vec![Mp::from(0), Mp::from(id), Mp::from(method), Mp::Array(args)]))?;
        rx.recv_timeout(Duration::from_secs(10)).map_err(|_| format!("Neovim didn't answer {method}"))?
    }

    /// Fire-and-forget, for input: a notification never blocks on nvim.
    fn notify(&self, method: &str, args: Vec<Mp>) -> Result<(), String> {
        self.write(&Mp::Array(vec![Mp::from(2), Mp::from(method), Mp::Array(args)]))
    }
}

/// Runs once per instance: report the current file to the app, and give Solidity files a language server when the
/// user's own config doesn't.
const SETUP: &str = r#"
local folder = ...
vim.api.nvim_create_autocmd({ "BufEnter" }, {
  callback = function()
    local name = vim.api.nvim_buf_get_name(0)
    if name ~= "" then vim.rpcnotify(0, "fm_buf", name, vim.fn.line(".")) end
  end,
})
vim.filetype.add({ extension = { sol = "solidity" } })
vim.api.nvim_create_autocmd("FileType", {
  pattern = "solidity",
  callback = function(ev)
    vim.defer_fn(function()
      if #vim.lsp.get_clients({ bufnr = ev.buf }) > 0 then return end
      if vim.fn.executable("solidity-language-server") == 0 then return end
      vim.lsp.start({ name = "solidity-language-server", cmd = { "solidity-language-server", "--stdio" }, root_dir = folder }, { bufnr = ev.buf })
    end, 300)
  end,
})
vim.keymap.set("n", "gd", function() vim.lsp.buf.definition() end, { desc = "Go to definition" })
"#;

fn instance(app: &AppHandle, folder: &str) -> Result<Arc<Nvim>, String> {
    if !crate::local::is_added(folder)? {
        return Err("Add the folder first".into());
    }
    let mut cur = current().lock().map_err(|e| e.to_string())?;
    if let Some(n) = cur.as_ref() {
        if n.child.lock().ok().is_some_and(|mut c| matches!(c.try_wait(), Ok(None))) {
            return Ok(n.clone());
        }
    }
    let n = Nvim::start(app, folder)?;
    n.call("nvim_exec_lua", vec![Mp::from(SETUP), Mp::Array(vec![Mp::from(folder)])])?;
    *cur = Some(n.clone());
    Ok(n)
}

fn get() -> Result<Arc<Nvim>, String> {
    current().lock().map_err(|e| e.to_string())?.clone().ok_or_else(|| "Neovim isn't running".into())
}

/// Starts Neovim for a folder (or reuses it, moving it to the folder) and attaches the app as its UI.
#[tauri::command]
pub async fn nvim_attach(app: AppHandle, folder: String, cols: u32, rows: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // One attach at a time: a view mounting twice must not race itself.
        static ATTACH: Mutex<()> = Mutex::new(());
        let _one = ATTACH.lock().map_err(|e| e.to_string())?;
        let n = instance(&app, &folder)?;
        n.call("nvim_set_current_dir", vec![Mp::from(folder.as_str())])?;
        let opts = Mp::Map(vec![(Mp::from("ext_linegrid"), Mp::from(true)), (Mp::from("rgb"), Mp::from(true))]);
        match n.call("nvim_ui_attach", vec![Mp::from(cols.max(10)), Mp::from(rows.max(3)), opts]) {
            Ok(_) => Ok(()),
            // Already attached (the view came back): take its size and send the whole screen again.
            Err(e) if e.contains("already attached") => {
                n.call("nvim_ui_try_resize", vec![Mp::from(cols.max(10)), Mp::from(rows.max(3))])?;
                n.call("nvim_command", vec![Mp::from("redraw!")])?;
                Ok(())
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn nvim_detach() -> Result<(), String> {
    get()?.notify("nvim_ui_detach", vec![])
}

/// Opens a file (relative to the folder) at a line.
#[tauri::command]
pub async fn nvim_open(path: String, line: Option<u32>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let n = get()?;
        let lua = "local p, l = ...; if vim.fn.fnamemodify(p, ':p') ~= vim.api.nvim_buf_get_name(0) then vim.cmd.edit(vim.fn.fnameescape(p)) end; if l then pcall(vim.api.nvim_win_set_cursor, 0, { l, 0 }); vim.cmd('normal! zz') end";
        n.call("nvim_exec_lua", vec![Mp::from(lua), Mp::Array(vec![Mp::from(path.as_str()), line.map(Mp::from).unwrap_or(Mp::Nil)])])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Keys in Neovim's notation (`<C-d>`, `<CR>`, `j`).
#[tauri::command]
pub fn nvim_input(keys: String) -> Result<(), String> {
    get()?.notify("nvim_input", vec![Mp::from(keys)])
}

#[tauri::command]
pub fn nvim_mouse(button: String, action: String, modifier: String, row: u32, col: u32) -> Result<(), String> {
    get()?.notify("nvim_input_mouse", vec![Mp::from(button), Mp::from(action), Mp::from(modifier), Mp::from(0), Mp::from(row), Mp::from(col)])
}

#[tauri::command]
pub fn nvim_resize(cols: u32, rows: u32) -> Result<(), String> {
    get()?.notify("nvim_ui_try_resize", vec![Mp::from(cols.max(10)), Mp::from(rows.max(3))])
}
