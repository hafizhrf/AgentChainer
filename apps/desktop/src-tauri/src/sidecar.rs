//! Supervises the Node sidecar and relays NDJSON frames between it and the UI (ADR-0003, checklist M1-01).
//!
//! Which sidecar runs (spike S1):
//! - **Release builds:** the single-executable sidecar Tauri ships next to the app binary (`bundle.externalBin`). It
//!   gets `AGENTCHAINER_DATA_DIR`, where it downloads and verifies the pinned Agent SDK on first use.
//! - **Debug builds:** `node packages/sidecar/src/main.ts` from the source tree, using the SDK in node_modules.
//! - `AGENTCHAINER_SIDECAR_BIN=<path>` overrides both, e.g. to try a packaged sidecar in a debug build.
//!
//! Supervision:
//! - If the process exits, it is restarted with exponential backoff (0.5 s → 30 s, reset after a minute of uptime).
//! - The last stderr lines of a crash are written to the app log dir.
//! - The UI hears `sidecar://exit` and `sidecar://ready`, and can force a restart (health ping).
//! - Every spawn uses the user's login-shell environment (M1-03) and the "Claude CLI path" setting (M1-07).

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{applog, settings, shell_env};

const SIDECAR_ENTRY: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/sidecar/src/main.ts"
);
const STDERR_TAIL_LINES: usize = 200;
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const STABLE_UPTIME: Duration = Duration::from_secs(60);

#[derive(Clone, Serialize)]
struct ExitEvent {
    status: String,
    restarting: bool,
}

pub struct Sidecar {
    inner: Arc<Inner>,
}

struct Inner {
    app: AppHandle,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    last_error: Mutex<Option<String>>,
    stopping: AtomicBool,
    restart_requested: AtomicBool,
}

impl Sidecar {
    /// Starts supervising in the background, so the window opens while the login shell and sidecar start.
    pub fn start(app: &AppHandle) -> Self {
        let inner = Arc::new(Inner {
            app: app.clone(),
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            last_error: Mutex::new(None),
            stopping: AtomicBool::new(false),
            restart_requested: AtomicBool::new(false),
        });
        let worker = Arc::clone(&inner);
        std::thread::spawn(move || supervise(&worker));
        Self { inner }
    }

    pub fn send(&self, frame: &str) -> Result<(), String> {
        let mut guard = self
            .inner
            .stdin
            .lock()
            .map_err(|_| "sidecar lock poisoned")?;
        let Some(stdin) = guard.as_mut() else {
            let reason = self.inner.last_error.lock().ok().and_then(|e| e.clone());
            return Err(reason.unwrap_or_else(|| "The agent runtime is starting…".into()));
        };
        writeln!(stdin, "{frame}")
            .and_then(|()| stdin.flush())
            .map_err(|e| format!("sidecar write failed: {e}"))
    }

    /// Kills the current process; the supervisor starts a fresh one immediately (UI health ping, settings change).
    pub fn restart(&self) {
        self.inner.restart_requested.store(true, Ordering::SeqCst);
        kill_child(&self.inner);
    }

    /// Stops supervising and kills the process (app exit).
    pub fn stop(&self) {
        self.inner.stopping.store(true, Ordering::SeqCst);
        kill_child(&self.inner);
    }
}

fn kill_child(inner: &Inner) {
    if let Ok(mut child) = inner.child.lock()
        && let Some(child) = child.as_mut()
    {
        let _ = child.kill();
    }
}

fn supervise(inner: &Arc<Inner>) {
    let login_env = shell_env::login_shell_env().unwrap_or_default();
    let mut failures: u32 = 0;
    while !inner.stopping.load(Ordering::SeqCst) {
        let started = Instant::now();
        let outcome = run_once(inner, &login_env);
        if inner.stopping.load(Ordering::SeqCst) {
            return;
        }
        let requested = inner.restart_requested.swap(false, Ordering::SeqCst);
        let status = match outcome {
            Ok((status, success, tail)) => {
                if !success && !requested {
                    write_crash_log(&inner.app, &status, &tail);
                }
                status
            }
            Err(e) => {
                if let Ok(mut last) = inner.last_error.lock() {
                    *last = Some(e.clone());
                }
                e
            }
        };
        applog::warn("core", &format!("sidecar stopped: {status}"));
        let _ = inner.app.emit(
            "sidecar://exit",
            ExitEvent {
                status,
                restarting: true,
            },
        );

        if requested || started.elapsed() >= STABLE_UPTIME {
            failures = 0;
        }
        if !requested {
            failures = failures.saturating_add(1);
            let delay = backoff(failures);
            let until = Instant::now() + delay;
            while Instant::now() < until && !inner.stopping.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

/// 0.5 s, 1 s, 2 s, … capped at 30 s.
fn backoff(failures: u32) -> Duration {
    let ms = 500u64.saturating_mul(1u64 << failures.saturating_sub(1).min(16));
    Duration::from_millis(ms).min(MAX_BACKOFF)
}

/// Spawns one sidecar process and blocks until it exits. Returns (status, success, last stderr lines).
fn run_once(
    inner: &Arc<Inner>,
    login_env: &HashMap<String, String>,
) -> Result<(String, bool, Vec<String>), String> {
    let (mut cmd, label) = command(&inner.app)?;
    cmd.envs(login_env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = settings::load(&inner.app).claude_path {
        cmd.env("AGENTCHAINER_CLAUDE_PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("{label}: {e}"))?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    *inner.stdin.lock().map_err(|_| "sidecar lock poisoned")? = child.stdin.take();
    *inner.child.lock().map_err(|_| "sidecar lock poisoned")? = Some(child);
    if let Ok(mut last) = inner.last_error.lock() {
        *last = None;
    }

    let app = inner.app.clone();
    let relay = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            // Forward only well-formed JSON; the UI validates the frame against the protocol schemas.
            if serde_json::from_str::<serde_json::Value>(&line).is_ok() {
                let _ = app.emit("sidecar://frame", line);
            } else {
                applog::warn("core", "dropped a non-JSON sidecar stdout line");
            }
        }
    });
    let tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
    let tail_writer = Arc::clone(&tail);
    let logger = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            applog::info("sidecar", &line);
            if let Ok(mut tail) = tail_writer.lock() {
                if tail.len() == STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        }
    });
    let _ = inner.app.emit("sidecar://ready", ());

    // Poll instead of a blocking wait, so `restart`/`stop` can take the child lock and kill it.
    let status = loop {
        let polled = inner
            .child
            .lock()
            .map_err(|_| "sidecar lock poisoned")?
            .as_mut()
            .map(Child::try_wait);
        match polled {
            Some(Ok(Some(status))) => break status,
            Some(Ok(None)) => std::thread::sleep(Duration::from_millis(200)),
            Some(Err(e)) => return Err(format!("waiting for the sidecar failed: {e}")),
            None => return Err("sidecar handle lost".into()),
        }
    };
    *inner.stdin.lock().map_err(|_| "sidecar lock poisoned")? = None;
    *inner.child.lock().map_err(|_| "sidecar lock poisoned")? = None;
    let _ = relay.join();
    let _ = logger.join();
    let tail = tail
        .lock()
        .map(|t| t.iter().cloned().collect())
        .unwrap_or_default();
    Ok((status.to_string(), status.success(), tail))
}

/// The command for the sidecar this build should run, plus a label for error messages.
fn command(app: &AppHandle) -> Result<(Command, String), String> {
    let packaged = std::env::var_os("AGENTCHAINER_SIDECAR_BIN")
        .map(PathBuf::from)
        .or_else(|| {
            (!cfg!(debug_assertions))
                .then(bundled_sidecar_path)
                .flatten()
        });

    let Some(bin) = packaged else {
        let mut cmd = Command::new("node");
        cmd.arg(SIDECAR_ENTRY);
        return Ok((cmd, format!("node {SIDECAR_ENTRY}")));
    };

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    let mut cmd = Command::new(&bin);
    cmd.env("AGENTCHAINER_DATA_DIR", data_dir)
        // Let the SDK download honour HTTP(S)_PROXY / NO_PROXY like other tools on the machine.
        .env("NODE_USE_ENV_PROXY", "1");
    Ok((cmd, bin.display().to_string()))
}

/// Tauri copies `externalBin` next to the app's main executable, without the target-triple suffix.
fn bundled_sidecar_path() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "agentchainer-sidecar.exe"
    } else {
        "agentchainer-sidecar"
    };
    Some(std::env::current_exe().ok()?.parent()?.join(name))
}

fn write_crash_log(app: &AppHandle, status: &str, tail: &[String]) {
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file = dir.join(format!("sidecar-crash-{stamp}.log"));
    let text = format!(
        "sidecar exited: {status}\n--- last stderr lines ---\n{}\n",
        tail.join("\n")
    );
    if std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&file, text).is_ok() {
        applog::warn("core", &format!("crash log written to {}", file.display()));
    }
}

#[cfg(test)]
mod tests {
    use super::backoff;
    use std::time::Duration;

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff(1), Duration::from_millis(500));
        assert_eq!(backoff(2), Duration::from_secs(1));
        assert_eq!(backoff(4), Duration::from_secs(4));
        assert_eq!(backoff(10), Duration::from_secs(30));
        assert_eq!(backoff(u32::MAX), Duration::from_secs(30));
    }
}
