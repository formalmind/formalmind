//! Formal Mind for iPhone: a webview over the shared React app (mobile/src), plus the sign-in token in the keychain and
//! the formalmind:// link the browser hands it back with. Nothing runs here but the app: projects are read in the
//! webview (the website's browser-side git and Proofs), and the swarm runs on your Mac, steered through formal.team.

use keyring::Entry;

const SERVICE: &str = "team.formal.mobile";
const ACCOUNT: &str = "session";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

/// The session token from the keychain, if signed in.
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

/// WebKit's form bar (previous / next / done) over the keyboard, which a chat composer doesn't want: the webview's
/// content view gets a subclass whose `inputAccessoryView` is nil, the usual way to remove it.
#[cfg(target_os = "ios")]
fn hide_input_accessory(webview: *mut std::ffi::c_void) {
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{msg_send, sel};
    extern "C" {
        fn object_setClass(obj: *mut AnyObject, cls: *const AnyClass) -> *const AnyClass;
    }
    extern "C" fn none(_: &AnyObject, _: Sel) -> *mut AnyObject {
        std::ptr::null_mut()
    }
    unsafe {
        let webview = webview as *mut AnyObject;
        let scroll: *mut AnyObject = msg_send![&*webview, scrollView];
        let subviews: *mut AnyObject = msg_send![&*scroll, subviews];
        let count: usize = msg_send![&*subviews, count];
        for i in 0..count {
            let view: *mut AnyObject = msg_send![&*subviews, objectAtIndex: i];
            let class = (*view).class();
            if !class.name().to_string_lossy().starts_with("WKContent") {
                continue;
            }
            let name = c"FMContentViewWithoutAccessory";
            let subclass = AnyClass::get(name).or_else(|| {
                let mut builder = ClassBuilder::new(name, class)?;
                builder.add_method(sel!(inputAccessoryView), none as extern "C" fn(_, _) -> _);
                Some(builder.register())
            });
            if let Some(subclass) = subclass {
                object_setClass(view, subclass);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.with_webview(|w| hide_input_accessory(w.inner()));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![token_get, token_set, token_clear])
        .run(tauri::generate_context!())
        .expect("error while running Formal Mind");
}
