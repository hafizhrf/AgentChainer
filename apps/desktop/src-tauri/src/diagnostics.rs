//! "Export diagnostics" (checklist M1-35): one JSON file with versions, OS, settings, the UI's readiness check, the
//! recent app log and crash logs. Everything passes through `redact` first: the home folder becomes `~`, and keys,
//! tokens, passwords and email addresses are masked. Auth state is only what `env.check` reports (no identity).

use crate::{applog, settings};
use regex::Regex;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

const LOG_LINES: usize = 500;
const CRASH_LOGS: usize = 5;

fn patterns() -> &'static [(Regex, &'static str)] {
    static P: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    P.get_or_init(|| {
        [
            // Anthropic, OpenAI-style, GitHub, Slack and AWS key formats.
            (r"sk-ant-[A-Za-z0-9_\-]{8,}", "[redacted key]"),
            (r"\bsk-[A-Za-z0-9_\-]{20,}", "[redacted key]"),
            (r"\bgh[pousr]_[A-Za-z0-9]{20,}", "[redacted token]"),
            (r"\bgithub_pat_[A-Za-z0-9_]{20,}", "[redacted token]"),
            (r"\bxox[abposr]-[A-Za-z0-9\-]{10,}", "[redacted token]"),
            (r"\bAKIA[0-9A-Z]{16}\b", "[redacted key]"),
            (r"(?i)\bbearer\s+[A-Za-z0-9._~+/\-]+=*", "Bearer [redacted]"),
            // key=value / "key": "value" for secret-sounding names, unless the value is a plain number.
            (
                r#"(?i)\b([A-Z0-9_]*(?:api[_-]?key|token|secret|password|passwd|credential)[A-Z0-9_]*)(\\?"?\s*[:=]\s*\\?"?)[^\s"',\\]*[^\s"',\\0-9][^\s"',\\]*"#,
                "$1$2[redacted]",
            ),
            (r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+\.[A-Za-z0-9.\-]+", "[email]"),
        ]
        .into_iter()
        .map(|(re, with)| (Regex::new(re).expect("valid pattern"), with))
        .collect()
    })
}

/// Masks secrets and personal details in `text`; `home` (if known) becomes `~`.
pub fn redact(text: &str, home: Option<&str>) -> String {
    let mut out = match home.filter(|h| h.len() > 1) {
        Some(h) => text.replace(h, "~"),
        None => text.to_owned(),
    };
    for (re, with) in patterns() {
        out = re.replace_all(&out, *with).into_owned();
    }
    out
}

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
    let home = std::env::home_dir().map(|h| h.to_string_lossy().into_owned());
    std::fs::write(dest, redact(&text, home.as_deref())).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn masks_keys_tokens_passwords_emails_and_the_home_folder() {
        let text = concat!(
            "key sk-ant-api03-abcdefghijklmnop and ghp_0123456789abcdefghijABCD\n",
            "ANTHROPIC_API_KEY=sk-live-1234 \"password\": \"hunter2\" Authorization: Bearer abc.def\n",
            "AKIAABCDEFGHIJKLMNOP me@example.com /Users/me/projects/app"
        );
        let out = redact(text, Some("/Users/me"));
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
            redact(text, None),
            text,
            "numbers next to secret-sounding words stay"
        );
    }
}
