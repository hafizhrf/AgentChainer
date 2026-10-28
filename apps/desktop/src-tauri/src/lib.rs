mod sidecar;

use serde::Serialize;
use sidecar::Sidecar;
use tauri::{Manager, State};

#[derive(Serialize)]
struct AppInfo {
    name: &'static str,
    version: &'static str,
}

/// Lets the UI confirm the Rust core is reachable and show the app version.
#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "AgentChainer",
        version: env!("CARGO_PKG_VERSION"),
    }
}

/// Forwards one JSON-RPC frame from the UI to the sidecar. Replies arrive as `sidecar://frame` events.
#[tauri::command]
fn sidecar_send(frame: String, sidecar: State<'_, Sidecar>) -> Result<(), String> {
    sidecar.send(&frame)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let sidecar = Sidecar::spawn(app.handle());
            app.manage(sidecar);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_info, sidecar_send])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
