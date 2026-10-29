//! "Open in editor" at `file:line` (checklist M1-28). Editors are launched through their command-line launchers, found
//! on the login shell's PATH (M1-03); "system" opens the file with the OS default app.

use crate::shell_env;
use std::path::Path;
use std::process::{Command, Stdio};

/// Builds the launcher command for `editor`, or `None` for the system default.
pub fn command(editor: &str, file: &str, line: u32) -> Result<Option<Command>, String> {
    let at = format!("{file}:{line}");
    let (program, args): (&str, Vec<String>) = match editor {
        "system" => return Ok(None),
        "vscode" => (launcher("code"), vec!["--goto".into(), at]),
        "cursor" => (launcher("cursor"), vec!["--goto".into(), at]),
        "zed" => (launcher("zed"), vec![at]),
        "idea" => (
            launcher("idea"),
            vec!["--line".into(), line.to_string(), file.into()],
        ),
        other => return Err(format!("unknown editor: {other}")),
    };
    let mut cmd = Command::new(program);
    cmd.args(args)
        .envs(shell_env::cached())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(Some(cmd))
}

/// On Windows the launchers are batch files, which `Command` only finds with their extension.
fn launcher(name: &'static str) -> &'static str {
    if cfg!(windows) {
        match name {
            "code" => "code.cmd",
            "cursor" => "cursor.cmd",
            "idea" => "idea.bat",
            other => other,
        }
    } else {
        name
    }
}

pub fn check_file(file: &str) -> Result<(), String> {
    let path = Path::new(file);
    if !path.is_absolute() || !path.exists() {
        return Err(format!("file not found: {file}"));
    }
    Ok(())
}

/// Kinds of file the OS default app runs instead of showing: apps, installers, scripts and shortcuts. On Windows that
/// includes `.js` and `.vbs` (Windows Script Host).
const RUNNABLE: &[&str] = &[
    "app",
    "appimage",
    "applescript",
    "appx",
    "appxbundle",
    "bash",
    "bat",
    "cmd",
    "com",
    "command",
    "cpl",
    "csh",
    "deb",
    "desktop",
    "dmg",
    "exe",
    "fish",
    "hta",
    "inf",
    "jar",
    "js",
    "jse",
    "ksh",
    "lnk",
    "mpkg",
    "msc",
    "msi",
    "msix",
    "pkg",
    "ps1",
    "psm1",
    "reg",
    "rpm",
    "run",
    "scpt",
    "scr",
    "sh",
    "terminal",
    "tool",
    "url",
    "vb",
    "vbe",
    "vbs",
    "webloc",
    "workflow",
    "ws",
    "wsf",
    "wsh",
    "zsh",
];

/// "system" opens a file with whatever the OS associates with it. Workspace files and paths in a transcript can come
/// from an untrusted repo, so it refuses anything the OS would run rather than show; an editor opens those as text.
pub fn check_openable(file: &str) -> Result<(), String> {
    let path = Path::new(file);
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    };
    #[cfg(not(unix))]
    let executable = false;
    if RUNNABLE.contains(&ext.as_str()) || executable {
        return Err(
            "the default app would run it instead of showing it. Choose an editor in Settings to open it as text."
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::command;

    #[test]
    fn the_default_app_never_runs_a_file() {
        let dir = std::env::temp_dir().join(format!("ac-openable-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = |name: &str| {
            let p = dir.join(name);
            std::fs::write(&p, "x").unwrap();
            p.to_string_lossy().into_owned()
        };
        assert!(super::check_openable(&file("main.ts")).is_ok());
        assert!(super::check_openable(&file("README.md")).is_ok());
        for runnable in [
            "run.command",
            "setup.EXE",
            "x.ps1",
            "Evil.app",
            "a.js",
            "build.sh",
        ] {
            assert!(
                super::check_openable(&file(runnable)).is_err(),
                "{runnable}"
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = file("gradlew");
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(
                super::check_openable(&script).is_err(),
                "executable without an extension"
            );
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn builds_goto_arguments_per_editor() {
        let args = |editor: &str| {
            command(editor, "/repo/src/a.ts", 12).unwrap().map(|c| {
                c.get_args()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
            })
        };
        assert_eq!(args("vscode").unwrap(), ["--goto", "/repo/src/a.ts:12"]);
        assert_eq!(args("idea").unwrap(), ["--line", "12", "/repo/src/a.ts"]);
        assert!(args("system").is_none());
        assert!(command("rm", "/x", 1).is_err());
    }
}
