//! Terminals for the Code tab: a pseudo-terminal running Neovim (Vim mode) in a folder. Output streams to the webview
//! (xterm.js) as `term:data`; keys and resizes come back as commands; `term:exit` when it ends.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Lean 4 syntax for the machine's Neovim when the user's own runtime has none. Embedded so development and the
/// bundle carry the same file; `lean_runtime` writes it to a temp runtime the terminal appends after the user's.
const LEAN_SYNTAX: &str = include_str!("../nvim-lean/syntax/lean.vim");

/// Runs in Neovim before the user's config: Lean highlighting (a fallback, after the user's runtime) and, for a Lean
/// file, a `term:lean` snapshot of the buffer and cursor for the Infoview.
const LEAN_SETUP: &str = r#"
local group = vim.api.nvim_create_augroup("formalmind_lean", { clear = true })
local rtp = vim.env.FORMAL_MIND_NVIM_RTP

-- Lean 4 syntax, appended after the user's runtime so their own syntax (or lean.nvim's) wins when present.
if rtp and rtp ~= "" then
  vim.api.nvim_create_autocmd("Syntax", {
    group = group,
    pattern = "lean",
    callback = function()
      if not vim.o.runtimepath:find(rtp, 1, true) then vim.opt.runtimepath:append(rtp) end
    end,
  })
end

-- Neovim knows .lean; older versions may not.
vim.api.nvim_create_autocmd({ "BufRead", "BufNewFile" }, {
  group = group,
  pattern = "*.lean",
  callback = function()
    if vim.bo.filetype == "" then vim.bo.filetype = "lean" end
  end,
})

local state = vim.env.FORMAL_MIND_LEAN_STATE
if not state or state == "" then return end

local uv = vim.uv or vim.loop
local function snapshot()
  local buf = vim.api.nvim_get_current_buf()
  if not vim.api.nvim_buf_is_valid(buf) then return end
  local name = vim.api.nvim_buf_get_name(buf)
  if name == "" then return end
  local pos = vim.api.nvim_win_get_cursor(0)
  local line = vim.api.nvim_buf_get_lines(buf, pos[1] - 1, pos[1], false)[1] or ""
  local _, utf16 = vim.str_utfindex(line, pos[2])
  local data = {
    path = name,
    line = pos[1] - 1,
    character = utf16,
    byte = pos[2],
    tick = vim.api.nvim_buf_get_changedtick(buf),
    modified = vim.api.nvim_get_option_value("modified", { buf = buf }),
  }
  data.text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n")
  local tmp = state .. ".tmp"
  local f = io.open(tmp, "w")
  if not f then return end
  f:write(vim.json.encode(data))
  f:close()
  if uv then uv.fs_rename(tmp, state) else os.rename(tmp, state) end
end

local timer = nil
local function schedule()
  if timer then return end
  timer = vim.defer_fn(function()
    timer = nil
    pcall(snapshot)
  end, 60)
end

vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI", "TextChanged", "TextChangedI", "BufEnter", "BufWritePost" }, {
  group = group,
  callback = schedule,
})
vim.api.nvim_create_autocmd("VimEnter", {
  group = group,
  callback = function() vim.defer_fn(function() pcall(snapshot) end, 100) end,
})
"#;

/// A runtime directory holding the app's Lean syntax; written once, on first use.
fn lean_runtime() -> Option<&'static Path> {
    static RTP: OnceLock<Option<PathBuf>> = OnceLock::new();
    RTP.get_or_init(|| {
        let dir = std::env::temp_dir().join("formalmind-nvim-lean");
        let syntax = dir.join("syntax");
        std::fs::create_dir_all(&syntax).ok()?;
        std::fs::write(syntax.join("lean.vim"), LEAN_SYNTAX).ok()?;
        Some(dir)
    })
    .as_deref()
}

fn lean_state_file(id: u32) -> PathBuf {
    std::env::temp_dir().join(format!("formalmind-nvim-{}-{id}.json", std::process::id()))
}

/// Reads the buffer/cursor Neovim writes for a Lean terminal and sends each change to the webview as `term:lean`.
fn watch_lean(app: AppHandle, id: u32, file: PathBuf, ended: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut last = String::new();
        while !ended.load(Ordering::SeqCst) {
            if let Ok(text) = std::fs::read_to_string(&file) {
                if text != last {
                    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(obj) = value.as_object_mut() {
                            obj.insert("id".into(), json!(id));
                        }
                        let _ = app.emit("term:lean", value);
                        last = text;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = std::fs::remove_file(&file);
    });
}

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

fn terms() -> &'static Mutex<HashMap<u32, Term>> {
    static T: OnceLock<Mutex<HashMap<u32, Term>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

/// Neovim as installed on this machine (Homebrew, /usr/local/bin, or the PATH a shell would have).
fn nvim() -> PathBuf {
    crate::platform::find_tool("nvim")
}

/// Starts Neovim on a file (relative to the folder) in a terminal of this size; returns the terminal's id.
#[tauri::command(async)]
pub fn term_start(app: AppHandle, folder: String, path: Option<String>, line: Option<u32>, cols: u16, rows: u16) -> Result<u32, String> {
    if !crate::local::is_added(&folder)? {
        return Err("Add the folder first".into());
    }
    static NEXT: AtomicU32 = AtomicU32::new(1);
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let pair = native_pty_system().openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let bin = nvim();
    let mut cmd = CommandBuilder::new(&bin);
    // Before the user's config: Lean syntax when they have none, and (for a Lean file) the buffer/cursor snapshots.
    let lean_rtp = lean_runtime();
    if let Some(rtp) = lean_rtp {
        cmd.env("FORMAL_MIND_NVIM_RTP", rtp);
        cmd.env("FORMAL_MIND_NVIM_SETUP", LEAN_SETUP);
        cmd.arg("--cmd");
        cmd.arg("lua local f,e=loadstring(vim.env.FORMAL_MIND_NVIM_SETUP); if not f then error(e) end; f()");
    }
    if let Some(l) = line {
        cmd.arg(format!("+{l}"));
    }
    if let Some(p) = &path {
        cmd.arg(p);
    }
    cmd.cwd(&folder);
    // A real terminal: full colour, and the PATH a shell would have (apps opened from Finder get a short one).
    cmd.env("PATH", crate::platform::tool_path(None));
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LANG", std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()));
    let lean = lean_rtp.is_some() && path.as_deref().is_some_and(|p| p.to_ascii_lowercase().ends_with(".lean"));
    let state = lean.then(|| lean_state_file(id));
    if let Some(file) = &state {
        let _ = std::fs::remove_file(file);
        cmd.env("FORMAL_MIND_LEAN_STATE", file);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        format!("Couldn't start Neovim ({}). Install it with `brew install neovim` (or from neovim.io), then try again: {e}", bin.display())
    })?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let ended = Arc::new(AtomicBool::new(false));
    let ended_reader = ended.clone();
    let watch_app = app.clone();
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
        ended_reader.store(true, Ordering::SeqCst);
        // Take it out first, so waiting on the process never holds the lock.
        let ended = terms().lock().ok().and_then(|mut all| all.remove(&id));
        if let Some(mut t) = ended {
            let _ = t.child.wait();
        }
        let _ = app.emit("term:exit", json!({ "id": id }));
    });

    terms().lock().map_err(|e| e.to_string())?.insert(id, Term { master: pair.master, writer, child });
    if let Some(file) = state {
        watch_lean(watch_app, id, file, ended);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The embedded Lean syntax lands in the runtime directory Neovim is told to append.
    #[test]
    fn the_lean_runtime_has_the_syntax() {
        let dir = lean_runtime().expect("a temp runtime");
        let file = std::fs::read_to_string(dir.join("syntax/lean.vim")).expect("syntax/lean.vim");
        assert!(file.contains("syn keyword leanDeclaration"));
        assert!(file.contains("let b:current_syntax = \"lean\""));
    }

    /// The setup Neovim runs before the user's config: a `.lean` buffer gets the embedded syntax (when the user's
    /// runtime has none) and the buffer/cursor snapshot the Infoview reads. Uses this machine's Neovim.
    #[test]
    fn lean_setup_highlights_the_buffer_and_writes_the_state() {
        let nvim = crate::platform::find_tool("nvim");
        if !nvim.exists() {
            eprintln!("skipping: no nvim");
            return;
        }
        let rtp = lean_runtime().expect("a temp runtime");
        let state = std::env::temp_dir().join(format!("formalmind-test-lean-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&state);
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-fixtures/lean-proofs/Permissions.lean");
        let probe = r#"
            vim.defer_fn(function()
              print("SYNTAX=" .. tostring(vim.b.current_syntax))
              local id = vim.fn.synID(1, 1, 1)
              print("GROUP=" .. vim.fn.synIDattr(id, "name"))
              vim.cmd("qa!")
            end, 900)
        "#;
        let out = std::process::Command::new(&nvim)
            .env("FORMAL_MIND_NVIM_SETUP", LEAN_SETUP)
            .env("FORMAL_MIND_NVIM_RTP", &rtp)
            .env("FORMAL_MIND_LEAN_STATE", &state)
            .args(["--headless", "--cmd", "lua local f,e=loadstring(vim.env.FORMAL_MIND_NVIM_SETUP); if not f then error(e) end; f()", "--cmd", &format!("lua {probe}")])
            .arg(&fixture)
            .output()
            .expect("nvim runs");
        // Headless Neovim prints to stderr.
        let printed = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        assert!(printed.contains("SYNTAX=lean"), "syntax not on: {printed}");
        assert!(!printed.contains("GROUP=\n") && printed.contains("GROUP="), "no Lean highlight group: {printed}");

        let snapshot: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&state).expect("a state snapshot")).expect("valid JSON");
        assert_eq!(snapshot["line"], 0);
        assert_eq!(snapshot["character"], 0);
        let text = snapshot["text"].as_str().expect("the buffer text");
        assert!(text.contains("theorem"), "the buffer text is there");
        assert_eq!(snapshot["modified"], false);
        let _ = std::fs::remove_file(&state);
    }
}
