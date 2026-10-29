//! App log (checklist M1-35): one JSON object per line (`ts`, `level`, `source`, `msg`) in `agentchainer.log` in the
//! app log dir, rotated to `.1` at 5 MB. The core logs supervisor events; the sidecar's stderr is logged line by
//! line. A small hand-rolled logger instead of `tracing`: one file, no extra dependencies.

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
