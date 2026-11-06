//! App settings (checklist M1-07), as `settings.json` in the app config dir. They hold no secrets; auth stays in
//! the user's own CLI (ADR-0002). Session history and cost history move to SQLite later (M1-21, M1-33).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const MAX_RECENT_WORKSPACES: usize = 8;
/// Named multi-folder workspaces kept (M8-01); far more than anyone keeps.
pub const MAX_WORKSPACES: usize = 32;
/// Multi-folder sessions whose folders are remembered (M8-07), most recent first.
pub const MAX_SESSION_FOLDERS: usize = 200;

/// A named set of folders (M8-01): sessions run in `primary` and also reach `folders`. Absolute paths on this computer,
/// so it lives here rather than in a repository.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceDef {
    pub id: String,
    pub name: String,
    pub primary: String,
    pub folders: Vec<String>,
}

/// The other folders a multi-folder session reached (M8-07), so resuming or forking it reaches them again. Its session
/// id from the SDK, and absolute paths on this computer.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionFolders {
    pub session_id: String,
    pub folders: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Overrides `claude` discovery; passed to the sidecar as `AGENTCHAINER_CLAUDE_PATH`.
    pub claude_path: Option<String>,
    /// Model alias for new sessions (`haiku`, `sonnet`, `opus`), or `None` for the CLI's default.
    pub default_model: Option<String>,
    /// Permission mode for new sessions.
    pub default_mode: Option<String>,
    /// External editor for "Open in editor" (M1-28): `system`, `vscode`, `cursor`, `zed` or `idea`.
    pub editor: Option<String>,
    /// Effort for new sessions (`low` … `max`), or `None` for the model's default (M1-15).
    pub default_effort: Option<String>,
    /// Spend cap per session in USD (`maxBudgetUsd`, M1-32). Required for the Autonomous profile.
    pub budget_usd: Option<f64>,
    /// Stream summaries of Claude's thinking (M1-10). `None` means on.
    pub show_thinking: Option<bool>,
    /// `light`, `dark` or `system` (UX-02). `None` follows the OS.
    pub theme: Option<String>,
    /// The UI's language (X-13): `id` for Bahasa Indonesia. `None` is English.
    pub language: Option<String>,
    /// Apply safe setup (first-party and official items, low-risk fixes) before each new session (M2-18). Off unless set.
    pub auto_apply: Option<bool>,
    /// Show "New task" (M3, contract and triage) before tasks can run. Off unless set.
    pub tasks_preview: Option<bool>,
    /// Most recent first.
    pub recent_workspaces: Vec<String>,
    /// Named multi-folder workspaces (M8-01), as the New workspace dialog saved them.
    pub workspaces: Vec<WorkspaceDef>,
    /// Multi-folder sessions' other folders (M8-07), most recent first.
    pub session_folders: Vec<SessionFolders>,
}

impl Settings {
    /// Trims empty strings to `None` and caps the recent list, so the file stays tidy whatever the UI sends.
    pub fn normalized(mut self) -> Self {
        let clean = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        self.claude_path = clean(self.claude_path);
        self.default_model = clean(self.default_model);
        self.default_mode = clean(self.default_mode);
        self.editor = clean(self.editor);
        self.default_effort = clean(self.default_effort);
        self.theme = clean(self.theme).filter(|t| t == "light" || t == "dark");
        self.language = clean(self.language).filter(|l| l == "id");
        self.budget_usd = self.budget_usd.filter(|b| b.is_finite() && *b > 0.0);
        let mut seen: Vec<String> = Vec::new();
        for dir in self.recent_workspaces {
            let dir = dir.trim().to_string();
            let key = dir_key(&dir, cfg!(windows));
            if !dir.is_empty() && !seen.iter().any(|s| dir_key(s, cfg!(windows)) == key) {
                seen.push(dir);
            }
        }
        seen.truncate(MAX_RECENT_WORKSPACES);
        self.recent_workspaces = seen;
        let mut ids: Vec<String> = Vec::new();
        self.workspaces = std::mem::take(&mut self.workspaces)
            .into_iter()
            .filter_map(|w| {
                let id = w.id.trim().to_string();
                let name = w.name.trim().to_string();
                let primary = w.primary.trim().to_string();
                if id.is_empty() || name.is_empty() || primary.is_empty() || ids.contains(&id) {
                    return None;
                }
                ids.push(id.clone());
                let mut folders: Vec<String> = Vec::new();
                for dir in w.folders {
                    let dir = dir.trim().to_string();
                    let key = dir_key(&dir, cfg!(windows));
                    if !dir.is_empty()
                        && key != dir_key(&primary, cfg!(windows))
                        && !folders.iter().any(|f| dir_key(f, cfg!(windows)) == key)
                    {
                        folders.push(dir);
                    }
                }
                Some(WorkspaceDef {
                    id,
                    name,
                    primary,
                    folders,
                })
            })
            .collect();
        self.workspaces.truncate(MAX_WORKSPACES);
        let mut sessions: Vec<String> = Vec::new();
        self.session_folders = std::mem::take(&mut self.session_folders)
            .into_iter()
            .filter_map(|s| {
                let session_id = s.session_id.trim().to_string();
                let folders: Vec<String> = s
                    .folders
                    .into_iter()
                    .map(|f| f.trim().to_string())
                    .filter(|f| !f.is_empty())
                    .collect();
                if session_id.is_empty() || folders.is_empty() || sessions.contains(&session_id) {
                    return None;
                }
                sessions.push(session_id.clone());
                Some(SessionFolders {
                    session_id,
                    folders,
                })
            })
            .collect();
        self.session_folders.truncate(MAX_SESSION_FOLDERS);
        self
    }
}

/// What makes two folder paths the same: on Windows case and separators don't matter, so `D:\a` and `d:/A/` are one
/// recent workspace (the first, most recent spelling is kept).
fn dir_key(dir: &str, windows: bool) -> String {
    if windows {
        dir.replace('/', "\\").trim_end_matches('\\').to_lowercase()
    } else {
        dir.trim_end_matches('/').to_string()
    }
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    // The end-to-end tests (X-06) keep their settings apart: on Windows the config folder comes from the system, not
    // from an environment variable a test could set. Debug builds only (X-02).
    if let Some(dir) = crate::dev_only(
        std::env::var_os("AGENTCHAINER_CONFIG_DIR"),
        cfg!(debug_assertions),
    ) {
        return Ok(PathBuf::from(dir).join("settings.json"));
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| crate::i18n::tr("native.noConfigDir", &[("error", &e.to_string())]))?;
    Ok(dir.join("settings.json"))
}

/// Missing or unreadable settings fall back to defaults rather than blocking the app.
pub fn load(app: &AppHandle) -> Settings {
    path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default()
        .normalized()
}

/// Writes atomically (temp file + rename), so a crash never leaves a half-written file.
/// Why `path` can't be the Claude CLI, or `None`: it must be an absolute path to an existing file (X-02).
pub fn claude_path_problem(path: &str) -> Option<String> {
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        Some(crate::i18n::tr(
            "native.claudePathAbsolute",
            &[("path", path)],
        ))
    } else if !p.is_file() {
        Some(crate::i18n::tr(
            "native.claudePathMissing",
            &[("path", path)],
        ))
    } else {
        None
    }
}

pub fn save(app: &AppHandle, settings: Settings) -> Result<Settings, String> {
    let settings = settings.normalized();
    let target = path(app)?;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| {
            crate::i18n::tr(
                "native.createDir",
                &[
                    ("path", &dir.display().to_string()),
                    ("error", &e.to_string()),
                ],
            )
        })?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    let tmp = target.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| {
        crate::i18n::tr(
            "native.write",
            &[
                ("path", &tmp.display().to_string()),
                ("error", &e.to_string()),
            ],
        )
    })?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        crate::i18n::tr(
            "native.save",
            &[
                ("path", &target.display().to_string()),
                ("error", &e.to_string()),
            ],
        )
    })?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_blank_values_and_recent_workspaces() {
        let s = Settings {
            claude_path: Some("  ".into()),
            default_model: Some(" haiku ".into()),
            default_mode: None,
            editor: Some(" vscode ".into()),
            default_effort: None,
            budget_usd: Some(-1.0),
            show_thinking: None,
            theme: Some(" dark ".into()),
            language: Some(" id ".into()),
            auto_apply: None,
            tasks_preview: None,
            recent_workspaces: (0..12)
                .map(|i| format!("/p/{}", i % 10))
                .chain([" ".into()])
                .collect(),
            workspaces: Vec::new(),
            session_folders: Vec::new(),
        }
        .normalized();
        assert_eq!(s.claude_path, None);
        assert_eq!(s.default_model.as_deref(), Some("haiku"));
        assert_eq!(s.editor.as_deref(), Some("vscode"));
        assert_eq!(s.budget_usd, None, "a non-positive budget means no cap");
        assert_eq!(s.theme.as_deref(), Some("dark"));
        assert_eq!(s.language.as_deref(), Some("id"));
        let unknown = Settings {
            language: Some("fr".into()),
            ..Settings::default()
        };
        assert_eq!(
            unknown.normalized().language,
            None,
            "only a language the UI has"
        );
        assert_eq!(s.recent_workspaces.len(), MAX_RECENT_WORKSPACES);
        assert_eq!(s.recent_workspaces[0], "/p/0");
    }

    #[test]
    fn recent_workspaces_ignore_case_and_separators_on_windows() {
        assert_eq!(
            dir_key(r"C:\Temp\D--App\", true),
            dir_key("c:/temp/d--app", true)
        );
        assert_ne!(
            dir_key("/home/me/App", false),
            dir_key("/home/me/app", false)
        );
        assert_eq!(
            dir_key("/home/me/app/", false),
            dir_key("/home/me/app", false)
        );
    }

    #[test]
    fn reads_partial_json_with_defaults() {
        let s: Settings = serde_json::from_str(r#"{"defaultModel":"opus"}"#).unwrap();
        assert_eq!(s.default_model.as_deref(), Some("opus"));
        assert!(s.recent_workspaces.is_empty());
        assert_eq!(
            s.auto_apply, None,
            "auto-apply is off unless the user turns it on"
        );
        assert_eq!(s.tasks_preview, None, "the tasks preview is off by default");
    }

    #[test]
    fn unknown_themes_follow_the_system() {
        for theme in ["system", "sepia", ""] {
            let s = Settings {
                theme: Some(theme.into()),
                ..Default::default()
            }
            .normalized();
            assert_eq!(s.theme, None, "{theme}");
        }
    }

    #[test]
    fn keeps_named_workspaces_tidy() {
        let ws = |id: &str, name: &str, primary: &str, folders: &[&str]| WorkspaceDef {
            id: id.into(),
            name: name.into(),
            primary: primary.into(),
            folders: folders.iter().map(|f| f.to_string()).collect(),
        };
        let s = Settings {
            workspaces: vec![
                ws(
                    " a ",
                    " Shop ",
                    "/w/app",
                    &["/w/api", " /w/api ", "", "/w/app"],
                ),
                ws("a", "Duplicate id", "/w/x", &[]),
                ws("b", "  ", "/w/y", &[]),
                ws("c", "No primary", " ", &[]),
            ],
            ..Default::default()
        }
        .normalized();
        assert_eq!(s.workspaces, vec![ws("a", "Shop", "/w/app", &["/w/api"])]);
    }

    #[test]
    fn reads_settings_without_workspaces() {
        let s: Settings = serde_json::from_str(r#"{"recentWorkspaces":["/w/app"]}"#).unwrap();
        assert!(s.workspaces.is_empty());
    }

    #[test]
    fn a_claude_path_must_be_an_existing_file_at_an_absolute_path() {
        assert!(claude_path_problem("claude").is_some_and(|p| p.contains("absolute")));
        let dir = std::env::temp_dir();
        assert!(claude_path_problem(&dir.to_string_lossy()).is_some_and(|p| p.contains("No file")));
        let missing = dir.join("ac-no-such-claude");
        assert!(claude_path_problem(&missing.to_string_lossy()).is_some());
        let file = dir.join(format!("ac-claude-{}", std::process::id()));
        std::fs::write(&file, "").expect("temp file");
        assert_eq!(claude_path_problem(&file.to_string_lossy()), None);
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn keeps_each_sessions_folders_once_newest_first_and_drops_empty_ones() {
        let entry = |id: &str, folders: &[&str]| SessionFolders {
            session_id: id.into(),
            folders: folders.iter().map(|f| f.to_string()).collect(),
        };
        let s = Settings {
            session_folders: vec![
                entry(" a ", &[" /api ", ""]),
                entry("a", &["/old"]),
                entry("b", &[" "]),
                entry("", &["/x"]),
            ]
            .into_iter()
            .chain((0..MAX_SESSION_FOLDERS + 5).map(|i| entry(&format!("s{i}"), &["/f"])))
            .collect(),
            ..Settings::default()
        }
        .normalized();
        assert_eq!(
            s.session_folders[0],
            entry("a", &["/api"]),
            "the newest entry wins"
        );
        assert!(
            !s.session_folders
                .iter()
                .any(|e| e.session_id == "b" || e.session_id.is_empty())
        );
        assert_eq!(s.session_folders.len(), MAX_SESSION_FOLDERS);
    }
}
