//! Spawns the Node sidecar and relays NDJSON frames between it and the UI (ADR-0003).
//!
//! Which sidecar runs (spike S1, checklist M0-15):
//! - **Release builds:** the single-executable sidecar Tauri ships next to the app binary (`bundle.externalBin`). It
//!   gets `AGENTCHAINER_DATA_DIR`, where it downloads and verifies the pinned Agent SDK on first use.
//! - **Debug builds:** `node packages/sidecar/src/main.ts` from the source tree, using the SDK in node_modules.
//! - `AGENTCHAINER_SIDECAR_BIN=<path>` overrides both, e.g. to try a packaged sidecar in a debug build.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

const SIDECAR_ENTRY: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/sidecar/src/main.ts"
);

pub struct Sidecar {
    stdin: Mutex<Result<ChildStdin, String>>,
}

impl Sidecar {
    /// Starts the sidecar. A failure is kept and reported on every `send`, so the app still opens.
    pub fn spawn(app: &AppHandle) -> Self {
        let stdin = sidecar_command(app)
            .and_then(|(cmd, label)| start(app, cmd).map_err(|e| format!("{label}: {e}")))
            .map_err(|e| format!("Failed to start the sidecar ({e})"));
        if let Err(e) = &stdin {
            eprintln!("[sidecar] {e}");
        }
        Self {
            stdin: Mutex::new(stdin),
        }
    }

    pub fn send(&self, frame: &str) -> Result<(), String> {
        let mut guard = self.stdin.lock().map_err(|_| "sidecar lock poisoned")?;
        let stdin = guard.as_mut().map_err(|e| e.clone())?;
        writeln!(stdin, "{frame}")
            .and_then(|()| stdin.flush())
            .map_err(|e| format!("sidecar write failed: {e}"))
    }
}

/// Builds the command for the sidecar this build should run, plus a label for error messages.
fn sidecar_command(app: &AppHandle) -> Result<(Command, String), String> {
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

fn start(app: &AppHandle, mut cmd: Command) -> std::io::Result<ChildStdin> {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let stdin = child.stdin.take().expect("stdin is piped");

    let app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            // Forward only well-formed JSON; the UI checks the frame shape.
            if serde_json::from_str::<serde_json::Value>(&line).is_ok() {
                let _ = app.emit("sidecar://frame", line);
            } else {
                eprintln!("[sidecar] dropped a non-JSON stdout line");
            }
        }
        let status = child
            .wait()
            .map(|s| s.to_string())
            .unwrap_or_else(|e| e.to_string());
        let _ = app.emit("sidecar://exit", status);
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[sidecar] {line}");
        }
    });
    Ok(stdin)
}
