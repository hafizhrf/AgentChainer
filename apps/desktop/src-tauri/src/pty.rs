//! Integrated terminal (checklist M1-29): the user's own shell in a pseudo-terminal, started in the workspace folder.
//! Output goes to the UI as `pty://data` events (`{id, data}`), and `pty://exit` (`{id}`) when the shell ends.
//! This is the user's terminal, not the agent's: nothing typed here passes through the agent or its guard.

use crate::shell_env;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys {
    next: AtomicU32,
    open: Mutex<HashMap<u32, Pty>>,
}

/// Output of a terminal: the core forwards these as `pty://data` and `pty://exit` events.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PtyEvent {
    Data { id: u32, data: String },
    Exit { id: u32 },
}

impl Ptys {
    pub fn open(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        sink: impl Fn(PtyEvent) + Send + 'static,
    ) -> Result<u32, String> {
        if !std::path::Path::new(cwd).is_dir() {
            return Err(format!("not a folder: {cwd}"));
        }
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(|e| e.to_string())?;
        let mut cmd = shell_command();
        cmd.cwd(cwd);
        for (key, value) in shell_env::cached() {
            cmd.env(key, value);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                pending.extend_from_slice(&buf[..n]);
                let data = take_utf8(&mut pending);
                if !data.is_empty() {
                    sink(PtyEvent::Data { id, data });
                }
            }
            sink(PtyEvent::Exit { id });
        });

        self.open.lock().map_err(|e| e.to_string())?.insert(
            id,
            Pty {
                master: pair.master,
                writer,
                child,
            },
        );
        Ok(id)
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut open = self.open.lock().map_err(|e| e.to_string())?;
        let pty = open.get_mut(&id).ok_or("terminal closed")?;
        pty.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        pty.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let open = self.open.lock().map_err(|e| e.to_string())?;
        let pty = open.get(&id).ok_or("terminal closed")?;
        pty.master
            .resize(size(cols, rows))
            .map_err(|e| e.to_string())
    }

    pub fn close(&self, id: u32) {
        if let Ok(mut open) = self.open.lock()
            && let Some(mut pty) = open.remove(&id)
        {
            let _ = pty.child.kill();
        }
    }

    pub fn close_all(&self) {
        if let Ok(mut open) = self.open.lock() {
            for (_, mut pty) in open.drain() {
                let _ = pty.child.kill();
            }
        }
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(2),
        cols: cols.max(10),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// The user's login shell on macOS/Linux; PowerShell on Windows.
fn shell_command() -> CommandBuilder {
    if cfg!(windows) {
        CommandBuilder::new("powershell.exe")
    } else {
        let shell = shell_env::cached()
            .get("SHELL")
            .cloned()
            .or_else(|| std::env::var("SHELL").ok())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if cfg!(target_os = "macos") {
                    "/bin/zsh".into()
                } else {
                    "/bin/bash".into()
                }
            });
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-l");
        cmd
    }
}

/// Takes the longest valid UTF-8 prefix out of `pending`, keeping an incomplete trailing character for the next
/// read. Invalid bytes are replaced, so a binary blob can't stall the stream.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_owned();
            pending.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out
        }
        Err(_) => {
            let out = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PtyEvent, Ptys, take_utf8};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// A real shell round trip: type a command, read its output, close.
    #[cfg(unix)]
    #[test]
    fn runs_a_shell_in_the_workspace() {
        let dir = std::env::temp_dir().canonicalize().unwrap();
        let ptys = Ptys::default();
        let (tx, rx) = mpsc::channel();
        let id = ptys
            .open(dir.to_str().unwrap(), 80, 24, move |e| {
                let _ = tx.send(e);
            })
            .unwrap();
        ptys.write(id, "echo AC_$((40+2)); pwd\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut out = String::new();
        while !(out.contains("AC_42") && out.contains(dir.to_str().unwrap())) {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(PtyEvent::Data { data, .. }) => out.push_str(&data),
                Ok(PtyEvent::Exit { .. }) | Err(_) => {
                    panic!("no output before exit/timeout: {out:?}")
                }
            }
        }
        ptys.resize(id, 100, 30).unwrap();
        ptys.close(id);
        assert!(
            ptys.write(id, "x").is_err(),
            "a closed terminal takes no input"
        );
    }

    #[test]
    fn keeps_a_split_character_for_the_next_read() {
        let euro = "€".as_bytes(); // 3 bytes
        let mut pending = [b"a".as_slice(), &euro[..2]].concat();
        assert_eq!(take_utf8(&mut pending), "a");
        assert_eq!(pending, &euro[..2]);
        pending.extend_from_slice(&euro[2..]);
        assert_eq!(take_utf8(&mut pending), "€");
        assert!(pending.is_empty());
    }

    #[test]
    fn replaces_invalid_bytes_instead_of_stalling() {
        let mut pending = vec![b'x', 0xff, b'y'];
        assert_eq!(take_utf8(&mut pending), "x\u{fffd}y");
        assert!(pending.is_empty());
    }
}
