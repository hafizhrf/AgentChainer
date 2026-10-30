//! The native app menu (UX-07). Help links open in the browser from here; every other item reaches the UI as a
//! `menu` event carrying the item id, and the UI runs the matching action (`src/useMenuCommands.ts`).

#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::applog;

const REPO: &str = "https://github.com/hafizhrf/AgentChainer";

/// Item ids the UI handles. Keep in sync with `MENU_COMMANDS` in `src/useMenuCommands.ts` (a UI test checks this).
pub const UI_COMMANDS: &[&str] = &[
    "new-session",
    "open-folder",
    "close-session",
    "settings",
    "toggle-sidebar",
    "toggle-right-panel",
    "toggle-terminal",
    "export-diagnostics",
    "check-updates",
    "command-palette",
];

/// Help items that open a page instead of reaching the UI.
fn help_url(id: &str) -> Option<String> {
    match id {
        "help-getting-started" => Some(format!("{REPO}/blob/main/docs/guides/AUTH_SETUP.md")),
        "help-report-issue" => Some(format!("{REPO}/issues/new")),
        _ => None,
    }
}

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    let builder = MenuItemBuilder::with_id(id, text);
    match accelerator {
        Some(keys) => builder.accelerator(keys),
        None => builder,
    }
    .build(app)
}

/// Builds the menu bar. On macOS, Settings and Quit live in the app menu; elsewhere they go in File. There's no
/// predefined "Close Window" item: ⌘W closes the session instead.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let settings = item(app, "settings", "Settings…", Some("CmdOrCtrl+Comma"))?;
    let new_session = item(app, "new-session", "New Session", Some("CmdOrCtrl+N"))?;
    let open_folder = item(app, "open-folder", "Open Folder…", Some("CmdOrCtrl+O"))?;
    let close_session = item(app, "close-session", "Close Session", Some("CmdOrCtrl+W"))?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&new_session)
        .item(&open_folder)
        .separator()
        .item(&close_session);
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().item(&settings).separator().quit();
    let file = file.build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item(
            app,
            "command-palette",
            "Command Palette…",
            Some("CmdOrCtrl+Shift+P"),
        )?)
        .separator()
        .item(&item(
            app,
            "toggle-sidebar",
            "Toggle Sidebar",
            Some("CmdOrCtrl+Backslash"),
        )?)
        .item(&item(
            app,
            "toggle-right-panel",
            "Toggle Workspace Panel",
            Some("CmdOrCtrl+B"),
        )?)
        .item(&item(
            app,
            "toggle-terminal",
            "Toggle Terminal",
            Some("CmdOrCtrl+J"),
        )?);
    #[cfg(target_os = "macos")]
    let view = view.separator().fullscreen();
    let view = view.build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&item(app, "help-getting-started", "Getting Started", None)?)
        .item(&item(app, "help-report-issue", "Report an Issue", None)?)
        .separator()
        .item(&item(
            app,
            "export-diagnostics",
            "Export Diagnostics…",
            None,
        )?)
        .item(&item(app, "check-updates", "Check for Updates…", None)?)
        .build()?;

    let menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let menu = {
        let pkg = app.package_info();
        let about = AboutMetadata {
            name: Some(pkg.name.clone()),
            version: Some(pkg.version.to_string()),
            license: Some("Apache-2.0".into()),
            website: Some(REPO.into()),
            ..Default::default()
        };
        let app_menu = SubmenuBuilder::new(app, &pkg.name)
            .about(Some(about))
            .separator()
            .item(&settings)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .build()?;
        menu.items(&[&app_menu, &file, &edit, &view, &window, &help])
    };
    #[cfg(not(target_os = "macos"))]
    let menu = menu.items(&[&file, &edit, &view, &help]);
    menu.build()
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if let Some(url) = help_url(id) {
        if let Err(e) = app.opener().open_url(&url, None::<&str>) {
            applog::warn("menu", &format!("couldn't open {url}: {e}"));
        }
    } else if UI_COMMANDS.contains(&id) {
        let _ = app.emit("menu", id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_items_open_pages_and_never_reach_the_ui() {
        for id in ["help-getting-started", "help-report-issue"] {
            let url = help_url(id).expect("a help url");
            assert!(url.starts_with(REPO), "{url}");
            assert!(!UI_COMMANDS.contains(&id));
        }
        assert_eq!(help_url("new-session"), None);
    }

    #[test]
    fn ui_command_ids_are_unique() {
        let mut ids = UI_COMMANDS.to_vec();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), UI_COMMANDS.len());
    }
}
