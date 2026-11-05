mod applog;
mod diagnostics;
mod editor;
mod history;
mod menu;
mod pty;
mod redact;
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
    // The CLI path is run as the user's `claude` (X-02): a new one must be an existing file at an absolute path. One
    // saved earlier stays even if it's gone since, so other settings can still be saved.
    let wanted = settings
        .claude_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty());
    if let Some(path) = wanted
        && settings::load(&app).claude_path.as_deref() != Some(path)
        && let Some(problem) = settings::claude_path_problem(path)
    {
        return Err(problem);
    }
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
        None => match editor::check_openable(&file)? {
            editor::Opening::Default => app
                .opener()
                .open_path(&file, None::<&str>)
                .map_err(|e| e.to_string()),
            editor::Opening::AsText => editor::text_command(&file)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("couldn't open it as text: {e}")),
        },
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

/// Writes the redacted diagnostics bundle (M1-35) to a path the user picked. Only a `.json` file in an existing
/// folder: the webview can't use this to write anything else.
#[tauri::command]
fn diagnostics_export(app: AppHandle, path: String, ui: serde_json::Value) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    let is_json = target
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("json"));
    if !is_json || !target.parent().is_some_and(|d| d.is_dir()) {
        return Err("Choose a .json file in an existing folder.".into());
    }
    diagnostics::export(&app, target, ui)
}

/// Whether this build can check for updates (R1-04): release builds carry the update key's public half.
#[tauri::command]
fn updater_ready(app: AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.trim().is_empty())
}

/// Ends the agent runtime and the terminals before an update installs (R1-04): Windows can't replace a running
/// executable, and nothing should be writing to a workspace while the app restarts.
#[tauri::command]
fn update_prepare(sidecar: State<'_, Sidecar>, ptys: State<'_, Ptys>) {
    sidecar.stop();
    ptys.close_all();
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
/// one turn on its own, reports latency through `debug.log`, and quits via `quit_app`. Release builds ignore it (X-02):
/// an environment variable must not make an installed app run turns by itself.
#[tauri::command]
fn selftest_config() -> Option<String> {
    dev_only(
        std::env::var("AGENTCHAINER_SELFTEST").ok(),
        cfg!(debug_assertions),
    )
}

/// What wry passes to WebView2 when an app sets no arguments of its own.
const WRY_DEFAULT_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// The app's context. A debug build hands `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` on to its windows (X-06): WebView2
/// ignores the variable once an app sets arguments of its own, which wry always does, so WebDriver could never open
/// the WebView's debugging port for the end-to-end tests on Windows. Release builds never do (X-02).
fn context() -> tauri::Context<tauri::Wry> {
    let mut context = tauri::generate_context!();
    if let Some(extra) = dev_only(
        std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok(),
        cfg!(debug_assertions),
    ) {
        for window in &mut context.config_mut().app.windows {
            window.additional_browser_args = Some(format!("{WRY_DEFAULT_BROWSER_ARGS} {extra}"));
        }
    }
    context
}

/// A developer switch's value in a debug build, and nothing in a release build (X-02).
pub(crate) fn dev_only<T>(value: Option<T>, debug_build: bool) -> Option<T> {
    value.filter(|_| debug_build)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// A menu item picked in the UI's own title bar (UX-15, Windows and Linux): the same as the native menu's.
#[tauri::command]
fn menu_select(app: AppHandle, id: String) {
    menu::select(&app, &id);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // A scheduled run that needs the person, or ended (M8-05).
        .plugin(tauri_plugin_notification::init())
        // Edit → Paste in the title bar's menu (UX-15) reads the clipboard's text; nothing else uses it.
        .plugin(tauri_plugin_clipboard_manager::init());
    // The native menu bar on macOS only; Windows and Linux get the UI's title bar with its menus (UX-15).
    #[cfg(target_os = "macos")]
    let app = app.menu(menu::build).on_menu_event(menu::on_event);
    let app = app
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
            menu_select,
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
            diagnostics_export,
            updater_ready,
            update_prepare
        ])
        .build(context())
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
    fn developer_switches_do_nothing_in_a_release_build() {
        assert_eq!(super::dev_only(Some("x"), true), Some("x"));
        assert_eq!(super::dev_only(Some("x"), false), None);
    }

    #[test]
    fn app_info_reports_the_package_version() {
        let info = app_info();
        assert_eq!(info.name, "AgentChainer");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }
}
