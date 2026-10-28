//! "Open terminal" for the onboarding tutorial (checklist M1-05). The user installs and signs in to Claude Code
//! themselves (ADR-0002); this only opens their terminal in a useful folder.

use std::path::PathBuf;
use std::process::Command;

pub fn open(dir: Option<String>) -> Result<(), String> {
    let dir = dir
        .map(PathBuf::from)
        .filter(|d| d.is_dir())
        .or_else(std::env::home_dir)
        .ok_or("no folder to open the terminal in")?;

    #[cfg(target_os = "macos")]
    let attempts: Vec<Command> = {
        let mut cmd = Command::new("open");
        cmd.args(["-a", "Terminal"]).arg(&dir);
        vec![cmd]
    };

    #[cfg(windows)]
    let attempts: Vec<Command> = {
        // `start` needs cmd; prefer Windows Terminal, fall back to a plain console.
        let mut wt = Command::new("cmd");
        wt.args(["/C", "start", "", "wt", "-d"]).arg(&dir);
        let mut console = Command::new("cmd");
        console
            .args(["/C", "start", "", "cmd", "/K"])
            .current_dir(&dir);
        vec![wt, console]
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let attempts: Vec<Command> = [
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "xterm",
    ]
    .iter()
    .map(|term| {
        let mut cmd = Command::new(term);
        cmd.current_dir(&dir);
        cmd
    })
    .collect();

    for mut cmd in attempts {
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }
    Err("couldn't find a terminal app to open".into())
}
