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
            recent_workspaces: (0..12)
                .map(|i| format!("/p/{}", i % 10))
                .chain([" ".into()])
                .collect(),
        }
        .normalized();
        assert_eq!(s.claude_path, None);
        assert_eq!(s.default_model.as_deref(), Some("haiku"));
        assert_eq!(s.recent_workspaces.len(), MAX_RECENT_WORKSPACES);
        assert_eq!(s.recent_workspaces[0], "/p/0");
    }

    #[test]
    fn reads_partial_json_with_defaults() {
        let s: Settings = serde_json::from_str(r#"{"defaultModel":"opus"}"#).unwrap();
        assert_eq!(s.default_model.as_deref(), Some("opus"));
        assert!(s.recent_workspaces.is_empty());
    }
}
