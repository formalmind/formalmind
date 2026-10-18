//! The Formal Mind desktop shell: a webview over the shared React app, plus the bits only a native app can do.
//! Today that's the sign-in token in the OS keychain, the formalmind:// deep link, and local folders
//! with settings in ~/.formalmind (local.rs), and the local executor that runs agent turns here (executor.rs).

mod executor;
mod local;

use keyring::Entry;
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
        // On Windows and Linux a deep link starts a second copy of the app; this hands the link to the running one.
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(executor::Runs::default())
        .setup(|app| {
            // Installed builds register formalmind:// from tauri.conf.json; this covers `tauri dev` on Windows/Linux.
            #[cfg(any(windows, target_os = "linux"))]
            app.deep_link().register_all()?;
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
            executor::model_key_set,
            executor::model_key_status,
            executor::turn_start,
            executor::turn_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Formal Mind desktop app");
}
