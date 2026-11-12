//! The tabs open when the app last closed (checklist CP-09), as `open-tabs.json` beside the settings, so a restart or
//! a crash reopens them. Session and task ids, folders and titles on this computer; no transcript text beyond a
//! chat's title. The UI writes it as its tabs change; the file is the only copy.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Chats and tasks kept each; more than anyone keeps open.
pub const MAX_TABS: usize = 50;
/// Characters of a tab's title kept.
pub const MAX_TITLE: usize = 200;
/// A multi-folder chat's other folders kept (M8-01).
pub const MAX_FOLDERS: usize = 20;
const MAX_ID: usize = 200;
const MAX_NAME: usize = 100;
const MAX_PATH: usize = 4096;
const FILE: &str = "open-tabs.json";

/// A chat's tab: what resuming it needs (M1-22), and whether its turn was still running.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenChat {
    pub session_id: String,
    pub cwd: String,
    pub title: String,
    /// `codex` or `agy` (M9-09); absent is Claude.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folders: Vec<String>,
    /// The agent profile it runs as (M8-04).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// The model alias picked in the UI; empty is the CLI's default.
    #[serde(default)]
    pub model_alias: String,
    /// `task` when its composer makes tasks (UX-13).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// A turn or background work was still going when this was written: the app closed or crashed mid-reply.
    #[serde(default)]
    pub was_running: bool,
}

/// A task's tab (UX-13).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenTask {
    pub id: String,
    pub cwd: String,
    pub title: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct OpenTabs {
    pub version: u32,
    /// The UI's `active` key: a session id, `task:<id>`, or another page's key; absent is Home.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
    pub chats: Vec<OpenChat>,
    pub tasks: Vec<OpenTask>,
}

fn title(text: String) -> String {
    text.trim().chars().take(MAX_TITLE).collect()
}

fn id(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= MAX_ID
}

fn folder(text: &str) -> bool {
    text.len() <= MAX_PATH && Path::new(text).is_absolute()
}

fn name(text: Option<String>) -> Option<String> {
    text.map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && v.len() <= MAX_NAME)
}

impl OpenTabs {
    /// Keeps what a resume can use: ids, absolute folders, known agents and kinds, each tab once, and every list
    /// within its cap. Whatever doesn't fit is left out, never refused, so a hand-edited file still opens.
    pub fn normalized(self) -> Self {
        let mut chats: Vec<OpenChat> = Vec::new();
        for c in self.chats {
            if !id(&c.session_id)
                || !folder(&c.cwd)
                || chats.iter().any(|x| x.session_id == c.session_id)
            {
                continue;
            }
            chats.push(OpenChat {
                session_id: c.session_id,
                cwd: c.cwd,
                title: title(c.title),
                agent: c.agent.filter(|a| a == "codex" || a == "agy"),
                folders: c
                    .folders
                    .into_iter()
                    .filter(|f| folder(f))
                    .take(MAX_FOLDERS)
                    .collect(),
                profile: name(c.profile),
                model_alias: name(Some(c.model_alias)).unwrap_or_default(),
                kind: c.kind.filter(|k| k == "chat" || k == "task"),
                was_running: c.was_running,
            });
        }
        chats.truncate(MAX_TABS);
        let mut tasks: Vec<OpenTask> = Vec::new();
        for t in self.tasks {
            if !id(&t.id) || !folder(&t.cwd) || tasks.iter().any(|x| x.id == t.id) {
                continue;
            }
            tasks.push(OpenTask {
                id: t.id,
                cwd: t.cwd,
                title: title(t.title),
                model: name(Some(t.model)).unwrap_or_default(),
            });
        }
        tasks.truncate(MAX_TABS);
        OpenTabs {
            version: 1,
            active: self.active.filter(|a| id(a)),
            chats,
            tasks,
        }
    }
}

/// Missing, unreadable or unknown content reads as no tabs: the app starts on Home rather than not at all.
pub fn read(path: &Path) -> OpenTabs {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<OpenTabs>(&text).ok())
        .unwrap_or_default()
        .normalized()
}

pub fn write(path: &Path, tabs: OpenTabs) -> Result<(), String> {
    let text = serde_json::to_string(&tabs.normalized()).map_err(|e| e.to_string())?;
    crate::settings::write_atomic(path, &text)
}

pub fn load(app: &AppHandle) -> OpenTabs {
    crate::settings::config_file(app, FILE)
        .map(|p| read(&p))
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, tabs: OpenTabs) -> Result<(), String> {
    write(&crate::settings::config_file(app, FILE)?, tabs)
}

/// Forgets them (the setting was turned off).
pub fn clear(app: &AppHandle) {
    if let Ok(path) = crate::settings::config_file(app, FILE) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abs(dir: &str) -> String {
        if cfg!(windows) {
            format!("C:\\{dir}")
        } else {
            format!("/{dir}")
        }
    }

    fn chat(id: &str) -> OpenChat {
        OpenChat {
            session_id: id.into(),
            cwd: abs("w/app"),
            title: "Fix the cart".into(),
            model_alias: "haiku".into(),
            ..OpenChat::default()
        }
    }

    #[test]
    fn writes_and_reads_back_the_open_tabs() {
        let dir = std::env::temp_dir().join(format!("ac-open-tabs-{}", std::process::id()));
        let path = dir.join(FILE);
        let tabs = OpenTabs {
            version: 1,
            active: Some("task:t1".into()),
            chats: vec![OpenChat {
                agent: Some("codex".into()),
                folders: vec![abs("w/api")],
                profile: Some("reviewer".into()),
                kind: Some("task".into()),
                was_running: true,
                ..chat("s1")
            }],
            tasks: vec![OpenTask {
                id: "t1".into(),
                cwd: abs("w/app"),
                title: "Coupons".into(),
                model: "sonnet".into(),
            }],
        };
        write(&path, tabs.clone()).expect("written");
        assert_eq!(read(&path), tabs);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_corrupt_or_unknown_file_reads_as_no_tabs() {
        let dir = std::env::temp_dir().join(format!("ac-open-tabs-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join(FILE);
        let none = OpenTabs::default().normalized();
        assert_eq!(read(&path), none.clone());
        std::fs::write(&path, "{ not json").expect("file");
        assert_eq!(read(&path), none.clone());
        std::fs::write(&path, r#"{"version":1,"chats":[],"tasks":[],"secret":"x"}"#).expect("file");
        assert_eq!(
            read(&path),
            none.clone(),
            "a field it doesn't know is refused"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_valid_tabs_once_and_within_their_caps() {
        let tabs = OpenTabs {
            version: 7,
            active: Some("x".repeat(MAX_ID + 1)),
            chats: [
                chat("a"),
                chat("a"),
                chat(" "),
                OpenChat {
                    cwd: "relative/dir".into(),
                    ..chat("b")
                },
                OpenChat {
                    title: "t".repeat(MAX_TITLE + 50),
                    agent: Some("claude".into()),
                    kind: Some("board".into()),
                    folders: (0..MAX_FOLDERS + 5)
                        .map(|i| abs(&format!("f{i}")))
                        .chain(["rel".into()])
                        .collect(),
                    profile: Some("  ".into()),
                    ..chat("c")
                },
            ]
            .into_iter()
            .chain((0..MAX_TABS + 5).map(|i| chat(&format!("s{i}"))))
            .collect(),
            tasks: vec![
                OpenTask {
                    id: "t".into(),
                    cwd: abs("w"),
                    title: "T".into(),
                    model: String::new(),
                },
                OpenTask {
                    id: "t".into(),
                    cwd: abs("w"),
                    title: "again".into(),
                    model: String::new(),
                },
            ],
        }
        .normalized();
        assert_eq!(tabs.version, 1);
        assert_eq!(tabs.active, None, "an over-long key isn't kept");
        let ids: Vec<&str> = tabs.chats.iter().map(|c| c.session_id.as_str()).collect();
        assert_eq!(
            &ids[..3],
            ["a", "c", "s0"],
            "duplicates, blank ids and relative folders are left out"
        );
        assert_eq!(tabs.chats.len(), MAX_TABS);
        let c = &tabs.chats[1];
        assert_eq!(c.title.chars().count(), MAX_TITLE);
        assert_eq!(c.agent, None, "Claude is the default, not stored");
        assert_eq!(c.kind, None);
        assert_eq!(c.profile, None);
        assert_eq!(c.folders.len(), MAX_FOLDERS);
        assert_eq!(tabs.tasks.len(), 1);
        assert_eq!(tabs.tasks[0].title, "T");
    }
}
