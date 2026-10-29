//! App settings (checklist M1-07), as `settings.json` in the app config dir. They hold no secrets; auth stays in
//! the user's own CLI (ADR-0002). Session history and cost history move to SQLite later (M1-21, M1-33).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const MAX_RECENT_WORKSPACES: usize = 8;

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
    /// Apply safe setup (first-party and official items, low-risk fixes) before each new session (M2-18). Off unless set.
    pub auto_apply: Option<bool>,
    /// Most recent first.
    pub recent_workspaces: Vec<String>,
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
        self.budget_usd = self.budget_usd.filter(|b| b.is_finite() && *b > 0.0);
        let mut seen = Vec::new();
        for dir in self.recent_workspaces {
            let dir = dir.trim().to_string();
            if !dir.is_empty() && !seen.contains(&dir) {
                seen.push(dir);
            }
        }
        seen.truncate(MAX_RECENT_WORKSPACES);
        self.recent_workspaces = seen;
        self
    }
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?;
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
pub fn save(app: &AppHandle, settings: Settings) -> Result<Settings, String> {
    let settings = settings.normalized();
    let target = path(app)?;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    let tmp = target.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("save {}: {e}", target.display()))?;
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
            auto_apply: None,
            recent_workspaces: (0..12)
                .map(|i| format!("/p/{}", i % 10))
                .chain([" ".into()])
                .collect(),
        }
        .normalized();
        assert_eq!(s.claude_path, None);
        assert_eq!(s.default_model.as_deref(), Some("haiku"));
        assert_eq!(s.editor.as_deref(), Some("vscode"));
        assert_eq!(s.budget_usd, None, "a non-positive budget means no cap");
        assert_eq!(s.theme.as_deref(), Some("dark"));
        assert_eq!(s.recent_workspaces.len(), MAX_RECENT_WORKSPACES);
        assert_eq!(s.recent_workspaces[0], "/p/0");
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
}
