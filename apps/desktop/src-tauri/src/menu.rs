//! The app menu (UX-07). On macOS it's the native menu bar; on Windows and Linux the UI draws it in its own title bar
//! (UX-15) and sends the picked item here with `menu_select`. Either way, help links open in the browser from here,
//! and every other item reaches the UI as a `menu` event carrying the item id, for the matching action
//! (`src/useMenuCommands.ts`).

#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::applog;
use crate::i18n;

const REPO: &str = "https://github.com/hafizhrf/AgentChainer";

/// Item ids the UI handles. Keep in sync with `MENU_COMMANDS` in `src/useMenuCommands.ts` (a UI test checks this).
pub const UI_COMMANDS: &[&str] = &[
    "new-session",
    "new-task",
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
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    let builder = MenuItemBuilder::with_id(id, i18n::tr(&format!("menu.{id}"), &[]));
    match accelerator {
        Some(keys) => builder.accelerator(keys),
        None => builder,
    }
    .build(app)
}

/// Builds the native menu bar in the UI's language, used on macOS only (UX-15). There's no predefined "Close Window"
/// item: ⌘W closes the session instead. A new language takes effect when the app restarts.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let name = app.package_info().name.clone();
    let l = |key: &str| i18n::tr(key, &[("app", &name)]);
    let settings = item(app, "settings", Some("CmdOrCtrl+Comma"))?;
    let new_session = item(app, "new-session", Some("CmdOrCtrl+N"))?;
    // Only acts when the Tasks preview is on (Settings); the UI ignores it otherwise.
    let new_task = item(app, "new-task", Some("CmdOrCtrl+Shift+N"))?;
    let open_folder = item(app, "open-folder", Some("CmdOrCtrl+O"))?;
    let close_session = item(app, "close-session", Some("CmdOrCtrl+W"))?;

    let file = SubmenuBuilder::new(app, l("menu.file"))
        .item(&new_session)
        .item(&new_task)
        .item(&open_folder)
        .separator()
        .item(&close_session);
    #[cfg(not(target_os = "macos"))]
    let file = file
        .separator()
        .item(&settings)
        .separator()
        .quit_with_text(l("menu.exit"));
    let file = file.build()?;

    let edit = SubmenuBuilder::new(app, l("menu.edit"))
        .undo_with_text(l("menu.undo"))
        .redo_with_text(l("menu.redo"))
        .separator()
        .cut_with_text(l("menu.cut"))
        .copy_with_text(l("menu.copy"))
        .paste_with_text(l("menu.paste"))
        .select_all_with_text(l("menu.select-all"))
        .build()?;

    let view = SubmenuBuilder::new(app, l("menu.view"))
        .item(&item(app, "command-palette", Some("CmdOrCtrl+Shift+P"))?)
        .separator()
        .item(&item(app, "toggle-sidebar", Some("CmdOrCtrl+Backslash"))?)
        .item(&item(app, "toggle-right-panel", Some("CmdOrCtrl+B"))?)
        .item(&item(app, "toggle-terminal", Some("CmdOrCtrl+J"))?);
    #[cfg(target_os = "macos")]
    let view = view.separator().fullscreen_with_text(l("menu.fullscreen"));
    let view = view.build()?;

    let help = SubmenuBuilder::new(app, l("menu.help"))
        .item(&item(app, "help-getting-started", None)?)
        .item(&item(app, "help-report-issue", None)?)
        .separator()
        .item(&item(app, "export-diagnostics", None)?)
        .item(&item(app, "check-updates", None)?)
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
            .about_with_text(l("menu.about"), Some(about))
            .separator()
            .item(&settings)
            .separator()
            .services_with_text(l("menu.services"))
            .separator()
            .hide_with_text(l("menu.hide"))
            .hide_others_with_text(l("menu.hide-others"))
            .show_all_with_text(l("menu.show-all"))
            .separator()
            .quit_with_text(l("menu.quit"))
            .build()?;
        let window = SubmenuBuilder::new(app, l("menu.window"))
            .minimize_with_text(l("menu.minimize"))
            .maximize_with_text(l("menu.zoom"))
            .build()?;
        menu.items(&[&app_menu, &file, &edit, &view, &window, &help])
    };
    #[cfg(not(target_os = "macos"))]
    let menu = menu.items(&[&file, &edit, &view, &help]);
    menu.build()
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    select(app, event.id().as_ref());
}

/// Runs a menu item by id, from the native menu or the UI's title bar; ids outside the menu are ignored.
pub fn select<R: Runtime>(app: &AppHandle<R>, id: &str) {
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
    fn every_item_has_a_label_in_each_language() {
        let ids = UI_COMMANDS
            .iter()
            .chain(&["help-getting-started", "help-report-issue"]);
        for id in ids {
            for language in ["en", "id"] {
                let key = format!("menu.{id}");
                assert_ne!(i18n::tr_in(language, &key, &[]), key, "{language} {key}");
            }
        }
    }

    #[test]
    fn ui_command_ids_are_unique() {
        let mut ids = UI_COMMANDS.to_vec();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), UI_COMMANDS.len());
    }
}
