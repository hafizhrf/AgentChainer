//! One redaction for the app log, crash logs and the diagnostics bundle (X-03). The patterns are the UI's and the
//! sidecar's too: they're read from `packages/protocol/src/redact-patterns.json`, and the tests below run the shared
//! `test/redact-vectors.json`, as `redact.test.ts` does.

use regex::Regex;
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct Spec {
    patterns: Vec<Pattern>,
}

#[derive(Deserialize)]
struct Pattern {
    pattern: String,
    #[serde(default)]
    flags: String,
    replace: String,
}

fn patterns() -> &'static [(Regex, String)] {
    static P: OnceLock<Vec<(Regex, String)>> = OnceLock::new();
    P.get_or_init(|| {
        let spec: Spec = serde_json::from_str(include_str!(
            "../../../../packages/protocol/src/redact-patterns.json"
        ))
        .expect("valid redact-patterns.json");
        spec.patterns
            .into_iter()
            .map(|p| {
                let source = if p.flags.contains('i') {
                    format!("(?i){}", p.pattern)
                } else {
                    p.pattern
                };
                (Regex::new(&source).expect("valid pattern"), p.replace)
            })
            .collect()
    })
}

/// Keys, tokens, passwords, private keys, credentials in URLs and email addresses, masked.
pub fn secrets(text: &str) -> String {
    let mut out = text.to_owned();
    for (re, with) in patterns() {
        out = re.replace_all(&out, with.as_str()).into_owned();
    }
    out
}

/// Secrets masked and `home` (if known) as `~`, also where it appears JSON-escaped: a Windows path in a JSON log line
/// has its backslashes doubled, and doubled again when that line is quoted in the diagnostics bundle.
pub fn for_log(text: &str, home: Option<&str>) -> String {
    let mut out = text.to_owned();
    if let Some(h) = home.filter(|h| h.len() > 1) {
        let once = h.replace('\\', "\\\\");
        let twice = once.replace('\\', "\\\\");
        for form in [twice.as_str(), once.as_str(), h] {
            out = out.replace(form, "~");
        }
    }
    secrets(&out)
}

/// The user's home folder, for `for_log`.
pub fn home() -> Option<&'static str> {
    static HOME: OnceLock<Option<String>> = OnceLock::new();
    HOME.get_or_init(|| std::env::home_dir().map(|h| h.to_string_lossy().into_owned()))
        .as_deref()
}

#[cfg(test)]
mod tests {
    use super::{for_log, secrets};
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vectors {
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        #[serde(rename = "in")]
        input: String,
        home: Option<String>,
        out: String,
    }

    #[test]
    fn runs_the_shared_vectors() {
        let v: Vectors = serde_json::from_str(include_str!(
            "../../../../packages/protocol/test/redact-vectors.json"
        ))
        .expect("valid redact-vectors.json");
        for c in v.cases {
            let out = match c.home.as_deref() {
                Some(h) => for_log(&c.input, Some(h)),
                None => secrets(&c.input),
            };
            assert_eq!(out, c.out, "{}", c.name);
            assert_eq!(secrets(&c.out), c.out, "{} isn't stable", c.name);
        }
    }
}
