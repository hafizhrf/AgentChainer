//! App log (checklist M1-35): one JSON object per line (`ts`, `level`, `source`, `msg`) in `agentchainer.log` in the
//! app log dir, rotated to `.1` at 5 MB. The core logs supervisor events; the sidecar's stderr is logged line by
//! line. Every line is masked first (`redact::for_log`): secrets, and the home folder as `~`. A small hand-rolled
//! logger instead of `tracing`: one file, no extra dependencies.

use crate::redact;
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 5 * 1024 * 1024;

static LOG: OnceLock<Mutex<PathBuf>> = OnceLock::new();

#[derive(Serialize)]
struct Line<'a> {
    ts: u128,
    level: &'a str,
    source: &'a str,
    msg: &'a str,
}

/// Points the log at `dir/agentchainer.log`. Until then (and if the dir can't be created), lines go to stderr only.
pub fn init(dir: &Path) {
    if std::fs::create_dir_all(dir).is_ok() {
        let _ = LOG.set(Mutex::new(dir.join("agentchainer.log")));
    }
}

pub fn path() -> Option<PathBuf> {
    LOG.get()?.lock().ok().map(|p| p.clone())
}

pub fn write(level: &str, source: &str, msg: &str) {
    // Masked before anything is printed or stored (X-03): the sidecar's stderr carries the CLI's and gh's own output.
    let msg = &redact::for_log(msg, redact::home());
    eprintln!("[{source}] {msg}");
    let Some(lock) = LOG.get() else { return };
    let Ok(path) = lock.lock() else { return };
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let Ok(json) = serde_json::to_string(&Line {
        ts,
        level,
        source,
        msg,
    }) else {
        return;
    };
    if std::fs::metadata(&*path).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
        let _ = std::fs::rename(&*path, path.with_extension("log.1"));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&*path) {
        let _ = writeln!(file, "{json}");
    }
}

pub fn info(source: &str, msg: &str) {
    write("info", source, msg);
}

pub fn warn(source: &str, msg: &str) {
    write("warn", source, msg);
}

/// The last `n` lines of the log, including the rotated file when the current one is short.
pub fn tail(n: usize) -> Vec<String> {
    let Some(path) = path() else {
        return Vec::new();
    };
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    let mut lines: Vec<String> = read(&path.with_extension("log.1"))
        .lines()
        .chain(read(&path).lines())
        .map(str::to_owned)
        .collect();
    let skip = lines.len().saturating_sub(n);
    lines.drain(..skip);
    lines
}

#[cfg(test)]
mod tests {
    #[test]
    fn masks_a_line_before_it_is_written() {
        let dir = std::env::temp_dir().join(format!("ac-applog-{}", std::process::id()));
        super::init(&dir);
        super::info(
            "sidecar",
            "claude: export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop",
        );
        let text = std::fs::read_to_string(dir.join("agentchainer.log")).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(text.contains("ANTHROPIC_API_KEY=[redacted key]"), "{text}");
        assert!(!text.contains("sk-ant-api03"), "{text}");
    }
}
