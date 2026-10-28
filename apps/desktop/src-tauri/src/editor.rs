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

#[cfg(test)]
mod tests {
    use super::command;

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
