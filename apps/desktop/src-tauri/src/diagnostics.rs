//! "Export diagnostics" (checklist M1-35): one JSON file with versions, OS, settings, the UI's readiness check, the
//! recent app log and crash logs. Everything passes through `redact::for_log` first: the home folder becomes `~`, and
//! keys, tokens, passwords and email addresses are masked. Auth state is only what `env.check` reports (no identity).

use crate::{applog, redact, settings};
use serde_json::{Value, json};
use std::path::Path;
use tauri::{AppHandle, Manager};

const LOG_LINES: usize = 500;
const CRASH_LOGS: usize = 5;

/// Writes the bundle to `dest`. `ui` is what the UI adds: the handshake and the readiness check.
pub fn export(app: &AppHandle, dest: &Path, ui: Value) -> Result<(), String> {
    let crash_logs: Vec<Value> = app
        .path()
        .app_log_dir()
        .ok()
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .map(|entries| {
            let mut files: Vec<_> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .is_some_and(|n| n.to_string_lossy().starts_with("sidecar-crash-"))
                })
                .collect();
            files.sort();
            files
                .iter()
                .rev()
                .take(CRASH_LOGS)
                .map(|p| {
                    json!({
                        "file": p.file_name().map(|n| n.to_string_lossy().into_owned()),
                        "text": std::fs::read_to_string(p).unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let bundle = json!({
        "generatedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        "app": { "name": "AgentChainer", "version": env!("CARGO_PKG_VERSION") },
        "os": { "family": std::env::consts::OS, "arch": std::env::consts::ARCH },
        "settings": settings::load(app),
        "ui": ui,
        "log": applog::tail(LOG_LINES),
        "crashLogs": crash_logs,
    });
    let text = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
    // The log and crash logs are masked as they're written; this catches settings and the UI's report, and older lines.
    std::fs::write(dest, redact::for_log(&text, redact::home())).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use crate::redact::for_log;

    #[test]
    fn masks_keys_tokens_passwords_emails_and_the_home_folder() {
        let text = concat!(
            "key sk-ant-api03-abcdefghijklmnop and ghp_0123456789abcdefghijABCD\n",
            "ANTHROPIC_API_KEY=sk-live-1234 \"password\": \"hunter2\" Authorization: Bearer abc.def\n",
            "AKIAABCDEFGHIJKLMNOP me@example.com /Users/me/projects/app"
        );
        let out = for_log(text, Some("/Users/me"));
        for secret in [
            "sk-ant-api03",
            "ghp_0123",
            "sk-live-1234",
            "hunter2",
            "abc.def",
            "AKIAABCD",
            "me@example.com",
            "/Users/me",
        ] {
            assert!(!out.contains(secret), "{secret} survived: {out}");
        }
        assert!(out.contains("ANTHROPIC_API_KEY=[redacted]"));
        assert!(out.contains("~/projects/app"));
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        let text = "sidecar ready (protocol v2, node v24.18.0); tokens=1200 in";
        assert_eq!(
            for_log(text, None),
            text,
            "numbers next to secret-sounding words stay"
        );
    }
}
