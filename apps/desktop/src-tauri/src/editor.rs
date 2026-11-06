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
        other => {
            return Err(crate::i18n::tr(
                "native.unknownEditor",
                &[("editor", other)],
            ));
        }
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
    // A network or device path (`\\server\share`, `\\?\…`) would reach out just by being checked.
    if file.starts_with("\\\\") || file.starts_with("//") {
        return Err(crate::i18n::tr("native.notLocalFile", &[("file", file)]));
    }
    let path = Path::new(file);
    if !path.is_absolute() || !path.exists() {
        return Err(crate::i18n::tr("native.fileNotFound", &[("file", file)]));
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
    // Shortcuts and installers that never hold text (security review, 2026-11-04).
    "application",
    "appref-ms",
    "chm",
    "fileloc",
    "inetloc",
    "msp",
    "msu",
    "pif",
    "scf",
];

/// Kinds of file every OS default app shows rather than runs: documents, data and images. On macOS and Windows,
/// "system" opens anything else in the plain text editor, since a default app can run a script (Python Launcher runs
/// `.py`, and so does Windows' `py` association).
const SHOWN: &[&str] = &[
    "bmp", "cfg", "conf", "csv", "gif", "heic", "ico", "ini", "jpeg", "jpg", "json", "jsonc",
    "log", "markdown", "md", "pdf", "png", "rst", "text", "tif", "tiff", "toml", "tsv", "txt",
    "webp", "yaml", "yml",
];

/// Scripts some systems associate with their interpreter. Linux has no single text editor to fall back on, so there
/// "system" refuses them.
const SCRIPTS: &[&str] = &["php", "pl", "py", "pyc", "pyw", "pyz", "rb"];

/// How "system" opens a file that `check_openable` allows.
#[derive(Debug, PartialEq, Eq)]
pub enum Opening {
    /// With the OS default app.
    Default,
    /// In the plain text editor (macOS and Windows).
    AsText,
}

/// The plain text editor's command for `file`: TextEdit's `open -t` on macOS, Notepad on Windows.
pub fn text_command(file: &str) -> Command {
    let mut cmd = if cfg!(windows) {
        Command::new("notepad.exe")
    } else {
        let mut c = Command::new("open");
        c.arg("-t");
        c
    };
    cmd.arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd
}

/// "system" opens a file with whatever the OS associates with it. Workspace files and paths in a transcript can come
/// from an untrusted repo, so it refuses anything the OS would run rather than show, and opens anything not known to be
/// shown as plain text where the OS has a text editor to use.
pub fn check_openable(file: &str) -> Result<Opening, String> {
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
    let as_text = cfg!(any(target_os = "macos", windows));
    if RUNNABLE.contains(&ext.as_str())
        || executable
        || (!as_text && SCRIPTS.contains(&ext.as_str()))
    {
        return Err(crate::i18n::tr("native.wouldRun", &[]));
    }
    Ok(if SHOWN.contains(&ext.as_str()) || !as_text {
        Opening::Default
    } else {
        Opening::AsText
    })
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
        use super::Opening;
        let as_text = cfg!(any(target_os = "macos", windows));
        let code = if as_text {
            Opening::AsText
        } else {
            Opening::Default
        };
        assert_eq!(super::check_openable(&file("main.ts")), Ok(code));
        assert_eq!(
            super::check_openable(&file("README.md")),
            Ok(Opening::Default)
        );
        assert_eq!(
            super::check_openable(&file("shot.PNG")),
            Ok(Opening::Default)
        );
        // A default app could run these: as text where there's a text editor, refused otherwise.
        for script in ["setup.py", "tool.pyw", "x.rb"] {
            let got = super::check_openable(&file(script));
            if as_text {
                assert_eq!(got, Ok(Opening::AsText), "{script}");
            } else {
                assert!(got.is_err(), "{script}");
            }
        }
        for runnable in [
            "run.command",
            "setup.EXE",
            "x.ps1",
            "Evil.app",
            "a.js",
            "build.sh",
            "x.pif",
            "deploy.application",
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

    #[test]
    fn network_and_device_paths_are_refused() {
        assert!(super::check_file("\\\\attacker\\share\\x.txt").is_err());
        assert!(super::check_file("//attacker/share/x.txt").is_err());
        assert!(super::check_file("\\\\?\\C:\\x.txt").is_err());
    }
}
