//! The core's own text (X-13, ADR-0011): the macOS menu's labels and the errors commands return to the UI. They come
//! from the UI's catalogs (`menu.json`, `native.json`), in the language the settings name at startup; a change of
//! language restarts the app, so it's read once.

use std::collections::HashMap;
use std::sync::OnceLock;

static LANGUAGE: OnceLock<&'static str> = OnceLock::new();

/// Takes the language from the settings, once: `id` for Bahasa Indonesia, anything else English.
pub fn init(language: Option<&str>) {
    let _ = LANGUAGE.set(if language == Some("id") { "id" } else { "en" });
}

fn messages(language: &str) -> &'static HashMap<String, String> {
    static EN: OnceLock<HashMap<String, String>> = OnceLock::new();
    static ID: OnceLock<HashMap<String, String>> = OnceLock::new();
    let parse = |menu: &str, native: &str| {
        let mut all: HashMap<String, String> = serde_json::from_str(menu).expect("valid menu.json");
        all.extend(
            serde_json::from_str::<HashMap<String, String>>(native).expect("valid native.json"),
        );
        all
    };
    match language {
        "id" => ID.get_or_init(|| {
            parse(
                include_str!("../../src/i18n/locales/id/menu.json"),
                include_str!("../../src/i18n/locales/id/native.json"),
            )
        }),
        _ => EN.get_or_init(|| {
            parse(
                include_str!("../../src/i18n/locales/en/menu.json"),
                include_str!("../../src/i18n/locales/en/native.json"),
            )
        }),
    }
}

/// `key`'s message in `language`, English where it has none, with each `{{name}}` filled in from `params`.
pub fn tr_in(language: &str, key: &str, params: &[(&str, &str)]) -> String {
    let text = messages(language)
        .get(key)
        .or_else(|| messages("en").get(key))
        .map_or(key, String::as_str);
    params.iter().fold(text.to_string(), |text, (name, value)| {
        text.replace(&format!("{{{{{name}}}}}"), value)
    })
}

/// `key`'s message in the app's language.
pub fn tr(key: &str, params: &[(&str, &str)]) -> String {
    tr_in(LANGUAGE.get().copied().unwrap_or("en"), key, params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_message_has_its_indonesian_and_values_fill_in() {
        for key in messages("en").keys() {
            assert!(messages("id").contains_key(key), "id is missing {key}");
        }
        assert_eq!(
            tr_in("en", "native.notAFolder", &[("path", "/x")]),
            "not a folder: /x"
        );
        assert_eq!(
            tr_in("id", "native.notAFolder", &[("path", "/x")]),
            "bukan folder: /x"
        );
        assert_eq!(
            tr_in("id", "menu.quit", &[("app", "AgentChainer")]),
            "Keluar dari AgentChainer"
        );
        assert_eq!(tr_in("id", "no.such.key", &[]), "no.such.key");
    }
}
