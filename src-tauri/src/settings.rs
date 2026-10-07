//! User settings: versioned JSON in `tauri-plugin-store`, with Rust as the source of truth.
//! Every struct is `#[serde(default)]` so files written by older versions (missing fields) load
//! with defaults filled in.
//!
//! Adding a field needs no version bump: `#[serde(default)]` fills it in. Bump
//! [`CURRENT_VERSION`] and add a step to [`migrate`] only when renaming, moving or
//! reinterpreting existing fields.
//!
//! Changes go through [`update`], which validates, saves, applies them live and broadcasts
//! [`SettingsChanged`].

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::StoreExt;
use tauri_specta::Event;

use crate::state::AppState;

pub const CURRENT_VERSION: u32 = 1;
const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "settings";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    /// How the app looks.
    pub appearance: Appearance,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            appearance: Appearance::default(),
        }
    }
}

/// Light, dark, or following Windows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Appearance {
    pub theme: ThemeMode,
    /// `"windows"` (the Windows accent color) or a `#rrggbb`.
    pub accent: String,
}

/// Follow the Windows accent color.
pub const WINDOWS_ACCENT: &str = "windows";

impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: ThemeMode::System,
            accent: WINDOWS_ACCENT.into(),
        }
    }
}

/// Rust → all windows: settings changed (from any source), here's the new state.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SettingsChanged(pub Settings);

/// `#rgb` or `#rrggbb` as lowercase `#rrggbb`; `None` if it isn't one.
pub fn normalize_color(c: &str) -> Option<String> {
    let hex = c.trim().strip_prefix('#')?;
    if !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        6 => Some(format!("#{}", hex.to_ascii_lowercase())),
        3 => Some(
            hex.chars()
                .flat_map(|ch| [ch, ch])
                .fold(String::from("#"), |mut s, ch| {
                    s.push(ch.to_ascii_lowercase());
                    s
                }),
        ),
        _ => None,
    }
}

/// Normalize values and reject ones that can't work. Returns the settings as they will be
/// stored.
pub fn validate(mut s: Settings) -> Result<Settings, String> {
    s.version = CURRENT_VERSION;
    s.appearance.accent =
        normalize_color(&s.appearance.accent).unwrap_or_else(|| WINDOWS_ACCENT.into());
    Ok(s)
}

/// Validate, persist, apply live and broadcast. Returns the stored settings.
pub fn update(app: &AppHandle<Wry>, new: Settings) -> Result<Settings, String> {
    let new = validate(new)?;
    let state = app.state::<AppState>();
    let old = {
        let mut current = state.settings.write().unwrap();
        if *current == new {
            return Ok(new);
        }
        std::mem::replace(&mut *current, new.clone())
    };
    save(app, &new)?;

    if old.appearance.theme != new.appearance.theme {
        crate::appearance::apply(app, new.appearance.theme);
    }

    let _ = SettingsChanged(new.clone()).emit(app);
    Ok(new)
}

/// Bring stored JSON up to [`CURRENT_VERSION`]. Returns the settings and whether anything
/// changed (so the caller knows to write them back).
///
/// Add one step per version bump, e.g. `if version < 2 { rename a field }`.
pub fn migrate(stored: Option<Value>) -> (Settings, bool) {
    let Some(value) = stored.filter(Value::is_object) else {
        return (Settings::default(), true);
    };
    let version = value.get("version").and_then(Value::as_u64).unwrap_or(0);
    match serde_json::from_value::<Settings>(value) {
        Ok(settings) => {
            // Hand edits can leave values that can't work.
            let mut checked = validate(settings.clone()).unwrap_or_default();
            let changed = version != u64::from(CURRENT_VERSION) || checked != settings;
            checked.version = CURRENT_VERSION;
            (checked, changed)
        }
        Err(e) => {
            eprintln!("[settings] unreadable settings ({e}); using defaults");
            (Settings::default(), true)
        }
    }
}

/// What to do with the raw settings file before the store parses it.
#[derive(Debug, PartialEq)]
enum Repair {
    None,
    /// Rewrite without the UTF-8 BOM (Notepad and PowerShell add one; JSON parsers reject it).
    StripBom(Vec<u8>),
    /// Unparseable: keep a copy before defaults overwrite it.
    Quarantine,
}

fn check_raw(bytes: &[u8]) -> Repair {
    let (body, had_bom) = match bytes.strip_prefix(b"\xEF\xBB\xBF") {
        Some(rest) => (rest, true),
        None => (bytes, false),
    };
    if serde_json::from_slice::<Value>(body).is_err() {
        Repair::Quarantine
    } else if had_bom {
        Repair::StripBom(body.to_vec())
    } else {
        Repair::None
    }
}

fn repair_file(app: &AppHandle<Wry>) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let path = dir.join(STORE_FILE);
    let Ok(bytes) = std::fs::read(&path) else {
        return; // first run
    };
    match check_raw(&bytes) {
        Repair::None => {}
        Repair::StripBom(body) => {
            eprintln!("[settings] stripping UTF-8 BOM from {}", path.display());
            let _ = std::fs::write(&path, body);
        }
        Repair::Quarantine => {
            let backup = dir.join("settings.corrupt.json");
            eprintln!(
                "[settings] {} is not valid JSON; moved to {} and using defaults",
                path.display(),
                backup.display()
            );
            let _ = std::fs::rename(&path, &backup);
        }
    }
}

pub fn load(app: &AppHandle<Wry>) -> Settings {
    repair_file(app);
    let store = match app.store(STORE_FILE) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[settings] cannot open store: {e}; using defaults");
            return Settings::default();
        }
    };
    let (settings, changed) = migrate(store.get(STORE_KEY));
    if changed {
        if let Err(e) = save(app, &settings) {
            eprintln!("[settings] cannot save: {e}");
        }
    }
    settings
}

pub fn save(app: &AppHandle<Wry>, settings: &Settings) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(
        STORE_KEY,
        serde_json::to_value(settings).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_store_gives_defaults_and_saves() {
        assert_eq!(migrate(None), (Settings::default(), true));
    }

    #[test]
    fn non_object_gives_defaults() {
        assert_eq!(migrate(Some(json!("garbage"))), (Settings::default(), true));
        assert_eq!(migrate(Some(json!([1, 2]))), (Settings::default(), true));
    }

    #[test]
    fn current_version_round_trips_unchanged() {
        let mut s = Settings::default();
        s.appearance.theme = ThemeMode::Dark;
        s.appearance.accent = "#107c10".into();
        let (loaded, changed) = migrate(Some(serde_json::to_value(&s).unwrap()));
        assert_eq!(loaded, s);
        assert!(!changed);
    }

    #[test]
    fn partial_file_fills_defaults() {
        let (s, changed) = migrate(Some(json!({
            "version": 1,
            "appearance": { "theme": "light" },
        })));
        assert!(!changed);
        assert_eq!(s.appearance.theme, ThemeMode::Light);
        assert_eq!(
            s.appearance.accent, WINDOWS_ACCENT,
            "missing field defaults"
        );
    }

    #[test]
    fn unversioned_file_is_upgraded() {
        let (s, changed) = migrate(Some(json!({ "appearance": { "theme": "dark" } })));
        assert!(changed);
        assert_eq!(s.version, CURRENT_VERSION);
        assert_eq!(s.appearance.theme, ThemeMode::Dark);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let (s, _) = migrate(Some(json!({ "version": 1, "fromTheFuture": true })));
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn wrong_types_fall_back_to_defaults() {
        let (s, changed) = migrate(Some(json!({ "version": 1, "appearance": { "theme": 7 } })));
        assert!(changed);
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn hand_edited_values_are_repaired_on_load() {
        let (s, changed) = migrate(Some(
            json!({ "version": 1, "appearance": { "accent": "#ABC" } }),
        ));
        assert!(changed);
        assert_eq!(s.appearance.accent, "#aabbcc");
    }

    #[test]
    fn raw_file_checks() {
        assert_eq!(check_raw(br#"{"settings":{}}"#), Repair::None);
        assert_eq!(
            check_raw(b"\xEF\xBB\xBF{\"a\":1}"),
            Repair::StripBom(b"{\"a\":1}".to_vec())
        );
        assert_eq!(check_raw(b"{not json"), Repair::Quarantine);
        assert_eq!(check_raw(b"\xEF\xBB\xBF{not json"), Repair::Quarantine);
    }

    #[test]
    fn colors_normalize() {
        assert_eq!(normalize_color("#ABC").as_deref(), Some("#aabbcc"));
        assert_eq!(normalize_color(" #1E88E5 ").as_deref(), Some("#1e88e5"));
        assert_eq!(normalize_color("red"), None);
        assert_eq!(normalize_color("#12345"), None);
    }

    #[test]
    fn accent_is_windows_or_a_color() {
        let mut s = Settings::default();
        assert_eq!(s.appearance.accent, WINDOWS_ACCENT);
        s.appearance.accent = "#ABC".into();
        assert_eq!(validate(s.clone()).unwrap().appearance.accent, "#aabbcc");
        s.appearance.accent = "blue".into();
        assert_eq!(validate(s).unwrap().appearance.accent, WINDOWS_ACCENT);
    }

    #[test]
    fn default_shape() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["appearance"]["theme"], "system");
        assert_eq!(v["appearance"]["accent"], "windows");
    }
}
