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
    /// The proxies made for stepping and scrubbing (proxy.rs).
    pub proxies: Proxies,
    pub timeline: Timeline,
    /// Editing on the picture: the options bar's number fields.
    pub editing: Editing,
    /// How exports come out (export.rs).
    pub export: Export,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            appearance: Appearance::default(),
            proxies: Proxies::default(),
            timeline: Timeline::default(),
            editing: Editing::default(),
            export: Export::default(),
        }
    }
}

/// The GIF frame rates: GIF frames last whole hundredths of a second, so these play exactly.
pub const GIF_RATES: [u32; 4] = [10, 20, 25, 50];
/// The GIF sizes, as the longer side in pixels; 0 keeps the video's.
pub const GIF_SIZES: [u32; 5] = [320, 480, 640, 800, 0];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Export {
    /// The export menu's "Save to default folder": no Save dialog; files go to `folder`, named
    /// from the templates.
    pub save_to_folder: bool,
    /// Where, `%VARS%` allowed; empty: the Videos folder's Driveby folder.
    pub folder: String,
    /// The whole timeline's file name, without the extension: `{name}` is the video's name.
    pub timeline_name: String,
    /// A clip's file name: `{name}` as above, `{n}` the clip's number (`{nn}` at least two
    /// digits, `{nnn}` three...).
    pub clip_name: String,
    /// Frames per second, one of [`GIF_RATES`].
    pub gif_fps: u32,
    /// The longer side in pixels, one of [`GIF_SIZES`] (0: the video's size).
    pub gif_size: u32,
}

pub const TIMELINE_NAME: &str = "{name}-edit";
pub const CLIP_NAME: &str = "{name}-clip{nn}";

impl Default for Export {
    fn default() -> Self {
        // Spike 0.3: gifski at 20 fps and 480-640 px kept motion GIFs to a few MB a second.
        Self {
            save_to_folder: false,
            folder: String::new(),
            timeline_name: TIMELINE_NAME.into(),
            clip_name: CLIP_NAME.into(),
            gif_fps: 20,
            gif_size: 640,
        }
    }
}

/// A file-name template, trimmed (empty: `default`); an error for characters Windows doesn't
/// allow in names.
fn file_template(t: &str, default: &str, what: &str) -> Result<String, String> {
    let t = t.trim();
    if t.is_empty() {
        return Ok(default.into());
    }
    if let Some(c) = t
        .chars()
        .find(|c| r#"\/:*?"<>|"#.contains(*c) || c.is_control())
    {
        return Err(format!(
            "The {what} can't contain {c}: Windows doesn't allow it in file names."
        ));
    }
    Ok(t.into())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Timeline {
    /// Thumbnails along the clip (thumbs.rs): on by default. Off, they aren't made either.
    pub thumbnails: bool,
    /// The waveform along the clip (wave.rs): the same.
    pub waveform: bool,
    /// Ranges stay on the video they mark as clips are trimmed, deleted or moved (on by
    /// default); off, they stay at their place on the timeline. (Markup joins them in Phase 4.)
    pub ranges_follow_video: bool,
    /// Deleting a clip deletes the ranges on it (on by default); off, they're kept, hidden.
    pub delete_ranges_with_clip: bool,
}

impl Default for Timeline {
    fn default() -> Self {
        Self {
            thumbnails: true,
            waveform: true,
            ranges_follow_video: true,
            delete_ranges_with_clip: true,
        }
    }
}

/// How fast a number field's value changes as it's dragged: scales the mouse's speed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DragSpeed {
    VerySlow,
    Slow,
    #[default]
    Normal,
    Fast,
    VeryFast,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Editing {
    /// Dragging a number field up or down (crop, grow).
    pub number_drag_speed: DragSpeed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Proxies {
    /// Make and use them (on by default).
    pub enabled: bool,
    /// Where they're kept, with `%VARS%` (paths.rs); empty for the default, in local app data.
    pub folder: String,
    /// The most they may take up, in GB; past it, the least recently used are deleted.
    pub limit_gb: u32,
}

/// The proxy cache's limit, in GB: the default and the range.
pub const PROXY_LIMIT_GB: u32 = 5;
pub const PROXY_LIMIT_RANGE: std::ops::RangeInclusive<u32> = 1..=50;

impl Default for Proxies {
    fn default() -> Self {
        Self {
            enabled: true,
            folder: String::new(),
            limit_gb: PROXY_LIMIT_GB,
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
    s.proxies.limit_gb = s
        .proxies
        .limit_gb
        .clamp(*PROXY_LIMIT_RANGE.start(), *PROXY_LIMIT_RANGE.end());
    if !GIF_RATES.contains(&s.export.gif_fps) {
        s.export.gif_fps = Export::default().gif_fps;
    }
    if !GIF_SIZES.contains(&s.export.gif_size) {
        s.export.gif_size = Export::default().gif_size;
    }
    s.export.timeline_name = file_template(
        &s.export.timeline_name,
        TIMELINE_NAME,
        "timeline's file name",
    )?;
    s.export.clip_name = file_template(&s.export.clip_name, CLIP_NAME, "clips' file names")?;
    s.export.folder = s.export.folder.trim().to_string();
    let folder = &s.export.folder;
    if !folder.is_empty() && !crate::paths::resolve_dir(folder).is_absolute() {
        return Err(format!(
            "\"{folder}\" isn't a full folder path. Pick one with Browse, or type one like \
             D:\\Exports."
        ));
    }
    s.proxies.folder = s.proxies.folder.trim().to_string();
    let folder = &s.proxies.folder;
    if !folder.is_empty() && !crate::paths::resolve_dir(folder).is_absolute() {
        return Err(format!(
            "\"{folder}\" isn't a full folder path. Pick one with Browse, or type one like \
             D:\\Proxies."
        ));
    }
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
    if old.proxies != new.proxies {
        crate::proxy::settings_changed(app, &old.proxies, &new.proxies);
    }
    if new.timeline.thumbnails && !old.timeline.thumbnails {
        crate::thumbs::turned_on(app);
    }
    if new.timeline.waveform && !old.timeline.waveform {
        crate::wave::turned_on(app);
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
            // Hand edits can leave values that can't work: repaired, or (a folder) reset.
            let mut checked = validate(settings.clone())
                .or_else(|_| {
                    validate(Settings {
                        proxies: Proxies::default(),
                        ..settings.clone()
                    })
                })
                .unwrap_or_default();
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
    fn proxy_settings_are_checked() {
        let mut s = Settings::default();
        s.proxies.limit_gb = 0;
        s.proxies.folder = r" D:\Proxies ".into();
        let s = validate(s).unwrap();
        assert_eq!(s.proxies.limit_gb, 1);
        assert_eq!(s.proxies.folder, r"D:\Proxies");

        let mut s = Settings::default();
        s.proxies.folder = "proxies".into();
        assert!(validate(s).is_err());
    }

    #[test]
    fn a_hand_edited_bad_folder_goes_back_to_the_default() {
        let (s, changed) = migrate(Some(json!({
            "version": 1,
            "appearance": { "theme": "dark" },
            "proxies": { "folder": "relative", "limitGb": 9 },
        })));
        assert!(changed);
        assert_eq!(s.appearance.theme, ThemeMode::Dark);
        assert_eq!(s.proxies, Proxies::default());
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
        assert_eq!(v["timeline"]["thumbnails"], true);
        assert_eq!(v["timeline"]["waveform"], true);
        assert_eq!(v["timeline"]["rangesFollowVideo"], true);
        assert_eq!(v["timeline"]["deleteRangesWithClip"], true);
        assert_eq!(v["editing"]["numberDragSpeed"], "normal");
        assert_eq!(v["export"]["gifFps"], 20);
        assert_eq!(v["export"]["gifSize"], 640);
    }

    #[test]
    fn file_name_templates() {
        let mut s = Settings::default();
        s.export.timeline_name = "  ".into();
        s.export.clip_name = " {name} part {n} ".into();
        let ok = validate(s.clone()).unwrap();
        assert_eq!(ok.export.timeline_name, "{name}-edit");
        assert_eq!(ok.export.clip_name, "{name} part {n}");
        s.export.clip_name = "{name}/{n}".into();
        assert!(validate(s).unwrap_err().contains("can't contain /"));
    }

    #[test]
    fn gif_options_are_kept_to_what_plays_exactly() {
        let mut s = Settings::default();
        s.export.gif_fps = 30;
        s.export.gif_size = 777;
        let s = validate(s).unwrap();
        assert_eq!((s.export.gif_fps, s.export.gif_size), (20, 640));
    }
}
