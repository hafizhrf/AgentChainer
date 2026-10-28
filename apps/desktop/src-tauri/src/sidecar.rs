//! Spawns the Node sidecar and relays NDJSON frames between it and the UI (ADR-0003).
//!
//! Spike version (S2/S3): runs `node <repo>/packages/sidecar/src/main.ts` from the source tree,
//! so it only works in dev builds on a machine with Node on PATH. Packaging the sidecar as a
//! single executable is spike S1 (checklist M0-15).

use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

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
        let stdin =
            start(app).map_err(|e| format!("Failed to start sidecar (node {SIDECAR_ENTRY}): {e}"));
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

fn start(app: &AppHandle) -> std::io::Result<ChildStdin> {
    let mut cmd = Command::new("node");
    cmd.arg(SIDECAR_ENTRY)
        .stdin(Stdio::piped())
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
