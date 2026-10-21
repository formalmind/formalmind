//! The Formal Mind desktop shell: a webview over the shared React app, plus the bits only a native app can do.
//! Today that's the sign-in token in the OS keychain, the formalmind:// deep link, and local folders
//! with settings in ~/.formalmind (local.rs), the local executor that runs agent turns here (executor.rs), and debug
//! mode over the sol-debug engine (debug.rs).

mod anvil;
mod ast;
mod debug;
mod executor;
mod swarm;
mod swarm_ctx;
mod local;
mod lsp;
mod report;
mod term;

use keyring::Entry;
use tauri::Manager;
#[cfg(any(windows, target_os = "linux"))]
use tauri_plugin_deep_link::DeepLinkExt;

const SERVICE: &str = "team.formal.desktop";
const ACCOUNT: &str = "session";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

/// The desktop session token from the keychain, if signed in.
#[tauri::command]
fn token_get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn token_set(token: String) -> Result<(), String> {
    entry()?.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn token_clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Opening the app again (or a deep link on Windows and Linux) hands off to the running copy: show its window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(swarm::Swarms::default())
        .manage(debug::Debuggers::default())
        .setup(|app| {
            // Installed builds register formalmind:// from tauri.conf.json; this covers `tauri dev` on Windows/Linux.
            #[cfg(any(windows, target_os = "linux"))]
            app.deep_link().register_all()?;
            // Dev builds only: FM_SWARM_AUTOSTART=<added folder> starts the folder's swarm at launch, the same way the
            // Swarm page's Start does (FM_SWARM_BUDGET, FM_SWARM_MODEL, FM_SWARM_PROVIDER, FM_SWARM_GOAL), so a run
            // can be driven without clicking.
            #[cfg(debug_assertions)]
            if let Ok(folder) = std::env::var("FM_SWARM_AUTOSTART") {
                let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
                let request = swarm::SwarmRequest {
                    folder,
                    goal: env("FM_SWARM_GOAL"),
                    budget_usd: env("FM_SWARM_BUDGET").and_then(|v| v.parse().ok()).unwrap_or(10.0),
                    api_base: env("FM_API_BASE").unwrap_or_else(|| "https://formal.team".into()),
                    provider: env("FM_SWARM_PROVIDER"),
                    model: env("FM_SWARM_MODEL"),
                    session: None,
                    only_queued: env("FM_SWARM_ONLY_QUEUED").map(|v| v == "1"),
                };
                if let Err(e) = swarm::swarm_start(app.handle().clone(), app.state::<swarm::Swarms>(), request) {
                    eprintln!("FM_SWARM_AUTOSTART: {e}");
                }
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            token_get,
            token_set,
            token_clear,
            local::config_get,
            local::folder_add,
            local::folder_remove,
            local::folder_scan,
            local::folder_tree,
            local::repo_local,
            ast::ast_units,
            ast::ast_slice,
            ast::ast_formal,
            ast::ast_scripts,
            report::report_generate,
            report::report_quote,
            lsp::lsp_definition,
            lsp::lsp_hover,
            local::log_error,
            anvil::anvil_list,
            anvil::anvil_rpc_known,
            anvil::anvil_start,
            anvil::anvil_stop,
            term::term_start,
            term::term_write,
            term::term_resize,
            term::term_kill,
            swarm::swarm_start,
            swarm::swarm_stop,
            swarm::swarm_say,
            swarm::swarm_triage,
            swarm::swarm_running,
            swarm::swarm_suggest,
            swarm::swarm_plan,
            swarm::swarm_bugs,
            swarm::anthropic_key_set,
            swarm::anthropic_key_status,
            swarm::swarm_sessions,
            swarm::swarm_history,
            swarm::swarm_proofs,
            swarm::folder_read,
            swarm::folder_image,
            swarm::swarm_set_budget,
            swarm::swarm_compact,
            swarm::swarm_queue,
            debug::debug_open,
            debug::debug_close,
            debug::debug_run,
            debug::debug_nav,
            debug::debug_break,
            debug::debug_watch,
            debug::debug_file,
            debug::debug_compare,
            debug::debug_sync
        ])
        // Closing the window hides it: a running swarm keeps working, and the Dock icon brings the window back.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Formal Mind desktop app")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            // Quitting (⌘Q) pauses any swarm cleanly; its plan and session stay in the folder for Resume.
            tauri::RunEvent::ExitRequested { .. } => swarm::pause_all(app),
            _ => {}
        });
}
