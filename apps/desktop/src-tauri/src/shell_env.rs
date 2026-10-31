//! Login-shell environment for GUI launches (checklist M1-03).
//!
//! An app started from Finder or a desktop launcher gets a minimal PATH and none of the variables users set in
//! `~/.zshrc` / `~/.bashrc` (e.g. `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`). Like VS Code, ask the user's login
//! shell once and pass that environment to the sidecar (and through it to `claude`). Values are never logged.

use std::collections::HashMap;
use std::sync::OnceLock;

// Used by the Unix resolver (and the tests on every OS); Windows has no login shell to ask.
#[cfg_attr(windows, allow(dead_code))]
const MARKER: &str = "__AGENTCHAINER_ENV__";

/// The login-shell environment, resolved once per app run, for the integrated terminal and editor launches. Empty when
/// it can't be resolved. The sidecar resolves its own on every (re)start instead, so it sees changes after a restart.
pub fn cached() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| login_shell_env().unwrap_or_default())
}

/// Returns the login shell's environment, or `None` on Windows, on timeout, or on any failure (the sidecar then
/// runs with the app's own environment).
pub fn login_shell_env() -> Option<HashMap<String, String>> {
    #[cfg(windows)]
    {
        None
    }
    #[cfg(not(windows))]
    {
        unix::resolve()
    }
}

/// Parses `printf MARKER; env -0` output. Anything an interactive shell prints before the marker (banners,
/// prompts) is ignored.
#[cfg_attr(windows, allow(dead_code))]
pub fn parse_env_output(output: &[u8]) -> Option<HashMap<String, String>> {
    let text = String::from_utf8_lossy(output);
    let (_, after) = text.split_once(MARKER)?;
    let vars: HashMap<String, String> = after
        .split('\0')
        .filter_map(|entry| entry.split_once('='))
        .filter(|(key, _)| !key.is_empty() && !key.contains('\n'))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    (!vars.is_empty()).then_some(vars)
}

#[cfg(not(windows))]
mod unix {
    use super::{MARKER, parse_env_output};
    use std::collections::HashMap;
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const TIMEOUT: Duration = Duration::from_secs(5);

    pub fn resolve() -> Option<HashMap<String, String>> {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if cfg!(target_os = "macos") {
                    "/bin/zsh".into()
                } else {
                    "/bin/bash".into()
                }
            });
        // -i loads ~/.zshrc / ~/.bashrc, -l loads the login profile; both are where users set PATH and API keys.
        let mut child = Command::new(&shell)
            .args(["-ilc", &format!("printf '{MARKER}'; env -0")])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        // Read on a thread so a large environment can't fill the pipe and block the shell from exiting.
        let mut stdout = child.stdout.take()?;
        let reader = std::thread::spawn(move || {
            let mut out = Vec::new();
            stdout.read_to_end(&mut out).ok().map(|_| out)
        });
        let deadline = Instant::now() + TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                _ => {
                    let _ = child.kill();
                    eprintln!(
                        "[shell-env] login shell didn't answer within {TIMEOUT:?}; using the app's environment"
                    );
                    return None;
                }
            }
        }
        parse_env_output(&reader.join().ok()??)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_shell_noise_before_the_marker() {
        let out = b"Welcome to zsh!\n__AGENTCHAINER_ENV__PATH=/usr/local/bin:/usr/bin\0ANTHROPIC_API_KEY=sk-test\0EMPTY=\0";
        let env = parse_env_output(out).expect("parsed");
        assert_eq!(env["PATH"], "/usr/local/bin:/usr/bin");
        assert_eq!(env["ANTHROPIC_API_KEY"], "sk-test");
        assert_eq!(env["EMPTY"], "");
    }

    #[test]
    fn keeps_values_that_contain_equals_and_newlines() {
        let env = parse_env_output(b"__AGENTCHAINER_ENV__A=x=y\0B=line1\nline2\0").expect("parsed");
        assert_eq!(env["A"], "x=y");
        assert_eq!(env["B"], "line1\nline2");
    }

    #[test]
    fn returns_none_without_the_marker() {
        assert!(parse_env_output(b"PATH=/usr/bin\0").is_none());
    }
}
