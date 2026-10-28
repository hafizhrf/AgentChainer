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

/// Dev-only self-test (spike S2): `AGENTCHAINER_SELFTEST` holds JSON `{cwd, model, prompt}`. When set, the UI runs
/// one turn on its own, reports latency through `debug.log`, and quits via `quit_app`.
#[tauri::command]
fn selftest_config() -> Option<String> {
    std::env::var("AGENTCHAINER_SELFTEST").ok()
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
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
        .invoke_handler(tauri::generate_handler![
            app_info,
            sidecar_send,
            selftest_config,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_reports_the_package_version() {
        let info = app_info();
        assert_eq!(info.name, "AgentChainer");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }
}
