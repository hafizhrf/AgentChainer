mod applog;
mod diagnostics;
mod editor;
mod history;
mod menu;
mod pty;
mod settings;
mod shell_env;
mod sidecar;
mod terminal;
mod watcher;

use history::{History, SessionCost, Summary, TurnRecord};
use pty::{PtyEvent, Ptys};
use serde::Serialize;
use settings::Settings;
use sidecar::Sidecar;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_opener::OpenerExt;
use watcher::Watchers;

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

/// Emits `workspace://changed` while files in `cwd` change (M1-25).
#[tauri::command]
fn workspace_watch(
    app: AppHandle,
    cwd: String,
    watchers: State<'_, Watchers>,
) -> Result<(), String> {
    watchers.watch(cwd, move |name| {
        let _ = app.emit("workspace://changed", name);
    })
}

#[tauri::command]
fn workspace_unwatch(cwd: String, watchers: State<'_, Watchers>) {
    watchers.unwatch(&cwd);
}

/// Opens `file` at `line` in the user's editor, or with the system default app (M1-28).
#[tauri::command]
fn open_in_editor(
    app: AppHandle,
    file: String,
    line: Option<u32>,
    editor: Option<String>,
) -> Result<(), String> {
    editor::check_file(&file)?;
    let editor = editor.unwrap_or_else(|| "system".into());
    match editor::command(&editor, &file, line.unwrap_or(1))? {
        Some(mut cmd) => cmd.spawn().map(|_| ()).map_err(|e| {
            format!("couldn't start {editor}: {e}. Is its command-line launcher installed?")
        }),
        None => app
            .opener()
            .open_path(&file, None::<&str>)
            .map_err(|e| e.to_string()),
    }
}

/// Starts the user's shell in `cwd` for the integrated terminal (M1-29) and returns its id.
#[tauri::command]
fn pty_open(
    app: AppHandle,
    cwd: String,
    cols: u16,
    rows: u16,
    ptys: State<'_, Ptys>,
) -> Result<u32, String> {
    ptys.open(&cwd, cols, rows, move |event| {
        let name = match event {
            PtyEvent::Data { .. } => "pty://data",
            PtyEvent::Exit { .. } => "pty://exit",
        };
        let _ = app.emit(name, event);
    })
}

#[tauri::command]
fn pty_write(id: u32, data: String, ptys: State<'_, Ptys>) -> Result<(), String> {
    ptys.write(id, &data)
}

#[tauri::command]
fn pty_resize(id: u32, cols: u16, rows: u16, ptys: State<'_, Ptys>) -> Result<(), String> {
    ptys.resize(id, cols, rows)
}

#[tauri::command]
fn pty_close(id: u32, ptys: State<'_, Ptys>) {
    ptys.close(id);
}

/// Records a completed turn in the local cost history (M1-33).
#[tauri::command]
fn cost_record(turn: TurnRecord, history: State<'_, HistoryState>) -> Result<(), String> {
    history.get()?.record(&turn)
}

/// Each session's latest total in a workspace (shown in the session list, M1-21).
#[tauri::command]
fn cost_sessions(
    cwd: String,
    history: State<'_, HistoryState>,
) -> Result<Vec<SessionCost>, String> {
    history.get()?.sessions(&cwd)
}

#[tauri::command]
fn cost_summary(
    cwd: String,
    now: i64,
    history: State<'_, HistoryState>,
) -> Result<Summary, String> {
    history.get()?.summary(&cwd, now)
}

/// Writes the redacted diagnostics bundle (M1-35) to a path the user picked.
#[tauri::command]
fn diagnostics_export(app: AppHandle, path: String, ui: serde_json::Value) -> Result<(), String> {
    diagnostics::export(&app, std::path::Path::new(&path), ui)
}

/// The cost history, or why it couldn't be opened (the app works without it).
struct HistoryState(Result<History, String>);

impl HistoryState {
    fn get(&self) -> Result<&History, String> {
        self.0
            .as_ref()
            .map_err(|e| format!("cost history unavailable: {e}"))
    }
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
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .setup(|app| {
            if let Ok(dir) = app.path().app_log_dir() {
                applog::init(&dir);
            }
            applog::info(
                "core",
                &format!("AgentChainer {} starting", env!("CARGO_PKG_VERSION")),
            );
            let history = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())
                .and_then(|dir| History::open(&dir.join("agentchainer.db")));
            if let Err(e) = &history {
                applog::warn("core", &format!("cost history unavailable: {e}"));
            }
            app.manage(HistoryState(history));
            let sidecar = Sidecar::start(app.handle());
            app.manage(sidecar);
            app.manage(Watchers::default());
            app.manage(Ptys::default());
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
            quit_app,
            workspace_watch,
            workspace_unwatch,
            open_in_editor,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            cost_record,
            cost_sessions,
            cost_summary,
            diagnostics_export
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // Stop supervising first, so the sidecar isn't restarted while the app shuts down.
        if let RunEvent::Exit = event {
            handle.state::<Sidecar>().stop();
            handle.state::<Ptys>().close_all();
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
