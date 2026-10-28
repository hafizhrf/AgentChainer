use serde::Serialize;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
