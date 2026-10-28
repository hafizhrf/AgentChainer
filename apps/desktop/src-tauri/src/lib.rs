mod settings;
mod shell_env;
mod sidecar;
mod terminal;

use serde::Serialize;
use settings::Settings;
use sidecar::Sidecar;
use tauri::{AppHandle, Manager, RunEvent, State};

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

/// Restarts the sidecar now, e.g. when the UI's health ping times out or the Claude CLI path changed (M1-01).
#[tauri::command]
fn sidecar_restart(sidecar: State<'_, Sidecar>) {
    sidecar.restart();
}

#[tauri::command]
fn settings_get(app: AppHandle) -> Settings {
    settings::load(&app)
}

/// Saves and returns the normalized settings.
#[tauri::command]
fn settings_set(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    settings::save(&app, settings)
}

/// Opens the user's terminal, for the sign-in steps of the onboarding tutorial (M1-05).
#[tauri::command]
fn open_terminal(dir: Option<String>) -> Result<(), String> {
    terminal::open(dir)
}

/// Dev-only self-test (spike S2): `AGENTCHAINER_SELFTEST` holds JSON `{cwd, model, prompt}`. When set, the UI runs
/// one turn on its own, reports latency through `debug.log`, and quits via `quit_app`.
#[tauri::command]
fn selftest_config() -> Option<String> {
    std::env::var("AGENTCHAINER_SELFTEST").ok()
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let sidecar = Sidecar::start(app.handle());
            app.manage(sidecar);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            sidecar_send,
            sidecar_restart,
            settings_get,
            settings_set,
            open_terminal,
            selftest_config,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // Stop supervising first, so the sidecar isn't restarted while the app shuts down.
        if let RunEvent::Exit = event {
            handle.state::<Sidecar>().stop();
        }
    });
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
