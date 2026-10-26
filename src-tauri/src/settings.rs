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
use crate::styles::Styles;

pub const CURRENT_VERSION: u32 = 2;
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
    /// How the markup tools behave (Vandal's editor settings).
    pub markup: Markup,
    /// The markup tools' pickers: palettes, sizes, fonts (styles.rs, Vandal's).
    pub styles: Styles,
    /// How exports come out (export.rs).
    pub export: Export,
    /// Screen recording (recording.rs, PLAN 5b).
    pub recording: Recording,
    /// The preview's sound (PLAN 5a), as the timeline bar's speaker and slider left it.
    pub playback: Playback,
    /// Settings › About › Debugging.
    pub debugging: Debugging,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            appearance: Appearance::default(),
            proxies: Proxies::default(),
            timeline: Timeline::default(),
            editing: Editing::default(),
            markup: Markup::default(),
            styles: Styles::default(),
            export: Export::default(),
            recording: Recording::default(),
            playback: Playback::default(),
            debugging: Debugging::default(),
        }
    }
}

/// How loud the preview plays (PLAN 5a), not the export: set in the timeline bar, kept here so
/// it's as it was next time; not in the Settings window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Playback {
    /// The slider, 0 to 1 (full by default).
    pub volume: f64,
    /// Muted by the speaker (off by default).
    pub muted: bool,
}

/// Settings › Recording (PLAN 5b).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Recording {
    /// Where recordings go, `%VARS%` allowed; empty: the Videos folder's Razorcat\Recordings.
    pub folder: String,
    /// A recording's file name, without the extension (PLAN 5b.7): Export's tags (names.rs) but
    /// `{name}` and `{c}`, which a recording hasn't got.
    pub file_name: String,
    /// The first recording has asked whether to save to `folder` (it asks once, ever).
    pub asked_folder: bool,
    /// While an area records, its corners are marked (PLAN 5b.3d), in `corner_color`.
    pub corners: bool,
    pub corner_color: String,
    /// While an area records, the rest of its monitor is dimmed, `dim_opacity` dark.
    pub dim: bool,
    pub dim_opacity: f64,
    /// The microphone is recorded (PLAN 5b.4b; the Record bar's toggle too), the one with this
    /// Windows id, or empty: the default one.
    pub microphone: bool,
    pub microphone_device: String,
    /// What the computer plays is recorded too, mixed with the microphone (PLAN 5b.4c).
    pub system_sound: bool,
    /// The pointer is in the recording (PLAN 5b.5a).
    pub cursor: bool,
    /// Frames per second, one of [`RECORD_RATES`].
    pub fps: u32,
    /// Seconds counted down before recording starts, one of [`COUNTDOWNS`] (0: none; 5b.5b).
    pub countdown: u32,
    /// Clicks noted while recording, to become markup (PLAN 5b.6); off until chosen.
    pub clicks: bool,
    /// While clicks are noted, each shows on the screen as it's made, as it'll look (PLAN
    /// 5b.6f): left out of the recording. Off until chosen (Richard, 2026-10-26).
    pub live_clicks: bool,
    /// How a recording's clicks look (PLAN 5b.6d): the look; the left, right and middle buttons'
    /// colours; the size (px across); how long each shows and fades in and out over (s); and a
    /// double-click's second ring.
    pub click_look: ClickLook,
    pub click_color: String,
    pub click_color_right: String,
    pub click_color_middle: String,
    pub click_size: f64,
    pub click_seconds: f64,
    pub click_fade_in: f64,
    pub click_fade_out: f64,
    pub click_double: bool,
    /// Clicks placed by hand in the editor look and last as recorded ones (Richard, 2026-10-26):
    /// the click tool's look, colour (the left button's) and size follow these, and its options
    /// bar's are locked.
    pub placed_clicks_follow: bool,
}

/// How a click mark looks (the markup's `ClickLook`): a ring round a dot, a soft glow, crosshair
/// ticks round a ring, or rings spreading out.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClickLook {
    Ring,
    Halo,
    Target,
    /// The default (Richard, 2026-10-26): it draws the eye to where the click was.
    #[default]
    Ripple,
}

/// How big a recorded click can be (px across).
pub const CLICK_SIZE_RANGE: std::ops::RangeInclusive<f64> = 16.0..=160.0;
/// How long a recorded click can show, and fade over (s).
pub const CLICK_SECONDS_RANGE: std::ops::RangeInclusive<f64> = 0.2..=5.0;
pub const CLICK_FADE_RANGE: std::ops::RangeInclusive<f64> = 0.0..=2.0;

/// The colours clicks are picked from: their custom palette (Settings › Markup › Clicks), or,
/// with that off, the ones they come with (not the shared palette: Richard, 2026-10-26).
pub fn click_palette(s: &Settings) -> Vec<String> {
    s.styles
        .tools
        .get("click")
        .and_then(|t| t.palette.clone())
        .unwrap_or_else(|| crate::styles::CLICK_PALETTE.map(String::from).to_vec())
}

/// A colour of the clicks' palette changed (Settings › Markup): each button's colour that was it
/// becomes the new one, and so every click with that button (PLAN 5b.6d). Not when the button's
/// colour was itself being changed.
pub fn follow_click_palette(old: &Settings, new: &mut Settings) {
    let (before, after) = (click_palette(old), click_palette(new));
    if before == after {
        return;
    }
    let r = &mut new.recording;
    let was = &old.recording;
    for (colour, then) in [
        (&mut r.click_color, &was.click_color),
        (&mut r.click_color_right, &was.click_color_right),
        (&mut r.click_color_middle, &was.click_color_middle),
    ] {
        if colour != then {
            continue;
        }
        let at = before.iter().position(|c| c.eq_ignore_ascii_case(colour));
        if let Some(c) = at.and_then(|i| after.get(i)) {
            colour.clone_from(c);
        }
    }
}

/// The frame rates a recording can have.
pub const RECORD_RATES: [u32; 2] = [30, 60];
/// The countdowns a recording can start with (s).
pub const COUNTDOWNS: [u32; 4] = [0, 3, 5, 10];

/// How dark the dimming can be, either way.
pub const DIM_RANGE: std::ops::RangeInclusive<f64> = 0.05..=0.9;

impl Default for Recording {
    fn default() -> Self {
        Self {
            folder: String::new(),
            file_name: RECORDING_NAME.into(),
            asked_folder: false,
            corners: true,
            corner_color: "#00ff27".into(),
            dim: true,
            dim_opacity: 0.3,
            microphone: true,
            microphone_device: String::new(),
            system_sound: false,
            cursor: true,
            fps: 60,
            countdown: 3,
            clicks: false,
            live_clicks: false,
            click_look: ClickLook::Ripple,
            click_color: "#ffd60a".into(),
            click_color_right: "#ff4fd8".into(),
            click_color_middle: "#4c9aff".into(),
            click_size: 44.0,
            click_seconds: 0.8,
            click_fade_in: 0.0,
            click_fade_out: 0.3,
            click_double: true,
            placed_clicks_follow: true,
        }
    }
}

/// Settings › About › Debugging.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Debugging {
    /// The log file and crash reports (log.rs, crash.rs); off, nothing is written (on by
    /// default).
    pub logging: bool,
}

impl Default for Debugging {
    fn default() -> Self {
        Self { logging: true }
    }
}

impl Default for Playback {
    fn default() -> Self {
        Self {
            volume: 1.0,
            muted: false,
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
    /// Where, `%VARS%` allowed; empty: the Videos folder's Razorcat folder.
    pub folder: String,
    /// The first export has asked whether to save to a default folder (it asks once, ever).
    pub asked_folder: bool,
    /// The whole timeline's file name, without the extension (names.rs): `{name}` the video's
    /// name, `{yyyy} {MM} {dd} {HH} {mm} {ss}` the date and time, `{n}` a number counting up in
    /// the folder (`{nn}` 01...), as Vandal's.
    pub timeline_name: String,
    /// A clip's file name: as the timeline's, and `{c}` the clip's number (`{cc}` at least two
    /// digits, `{ccc}` three...).
    pub clip_name: String,
    /// Frames per second, one of [`GIF_RATES`].
    pub gif_fps: u32,
    /// The longer side in pixels, one of [`GIF_SIZES`] (0: the video's size).
    pub gif_size: u32,
}

pub const TIMELINE_NAME: &str = "{name}-edit-{nn}";
pub const RECORDING_NAME: &str = "Recording {yyyy}-{MM}-{dd} {HH}-{mm}-{ss}";
pub const CLIP_NAME: &str = "{name}-clip-{cc}";

impl Default for Export {
    fn default() -> Self {
        // Spike 0.3: gifski at 20 fps and 480-640 px kept motion GIFs to a few MB a second.
        Self {
            save_to_folder: false,
            folder: String::new(),
            asked_folder: false,
            timeline_name: TIMELINE_NAME.into(),
            clip_name: CLIP_NAME.into(),
            gif_fps: 20,
            gif_size: 640,
        }
    }
}

/// Whether `template` has a tag of `letter`s (`{c}`, `{cc}`...).
fn has_tag(template: &str, letter: char) -> bool {
    template.split('{').skip(1).any(|rest| {
        rest.split_once('}')
            .is_some_and(|(tag, _)| !tag.is_empty() && tag.chars().all(|c| c == letter))
    })
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
    /// Ranges and markup stay on their video as clips are trimmed, deleted or moved (on by
    /// default); off, they stay at their place on the timeline.
    pub ranges_follow_video: bool,
    /// Deleting a clip deletes the ranges and markup on it (on by default); off, they're kept,
    /// hidden.
    pub delete_ranges_with_clip: bool,
    /// Splitting a clip (or cutting ranges out) splits the markup over the cut (on by default);
    /// off, it stays whole, on the clip under its start.
    pub split_markup: bool,
    /// Markup split at a cut fades there, each part as the whole did at that end (off by
    /// default: the cut is clean).
    pub fade_split_markup: bool,
    /// The fade Apply Default Fades gives markup, in frames (15 by default; kept to
    /// `DEFAULT_FADE_RANGE`).
    pub default_markup_fade: u32,
    /// Markup and clips duplicated, Alt-dragged or pasted keep the original's fades (on by
    /// default; Richard, 2026-10-23). Off: copies start without.
    pub copies_keep_fades: bool,
    /// The fade Apply Default Fades gives clips (PLAN 4.7a), in frames (15 by default; kept to
    /// `DEFAULT_FADE_RANGE`).
    pub default_clip_fade: u32,
    /// A clip split fades at the cut, each part as the whole did at that end (off by default:
    /// the cut is clean).
    pub fade_split_clips: bool,
    /// Changing a clip's speed scales the markup on it, its length and fades, with the video
    /// (on by default; Richard, 2026-10-24). Off, markup keeps its length. Only while ranges and
    /// markup follow their video.
    pub markup_stretches_with_speed: bool,
    /// A clip at another speed keeps its sound's pitch (on by default); off, it's tape-style,
    /// higher when faster.
    pub keep_pitch: bool,
}

/// The default markup fade's range, in frames.
pub const DEFAULT_FADE_RANGE: std::ops::RangeInclusive<u32> = 1..=300;

impl Default for Timeline {
    fn default() -> Self {
        Self {
            thumbnails: true,
            waveform: true,
            ranges_follow_video: true,
            delete_ranges_with_clip: true,
            split_markup: true,
            fade_split_markup: false,
            default_markup_fade: 15,
            copies_keep_fades: true,
            default_clip_fade: 15,
            fade_split_clips: false,
            markup_stretches_with_speed: true,
            keep_pitch: true,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Editing {
    /// Dragging a number field (crop, grow).
    pub number_drag_speed: DragSpeed,
    /// The grow tool's presets, in the order its options bar shows them.
    pub grow_presets: Vec<GrowPreset>,
}

impl Default for Editing {
    fn default() -> Self {
        Self {
            number_drag_speed: DragSpeed::default(),
            grow_presets: default_grow_presets(),
        }
    }
}

/// How the markup tools behave (Vandal's editor settings, the markup's part).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Markup {
    /// Tools on the global palette share one current color; off = each tool remembers its own.
    pub share_color: bool,
    /// Slot-number badges and shortcut tooltips on the style pickers.
    pub show_shortcut_hints: bool,
    /// Number buttons in the options bar show their unit ("50%", "10px"). Off by default: it
    /// adds clutter (Richard's call, in Vandal).
    pub show_button_units: bool,
    /// With a drawing tool, pressing on an object selects it (off: drawing tools always draw).
    /// Ctrl flips this for one press.
    pub drawing_tools_select: bool,
    /// The tools start with their styles as last used (colors, sizes, fonts...), also after a
    /// restart. Off: they start from the defaults.
    pub remember_tool_styles: bool,
}

impl Default for Markup {
    fn default() -> Self {
        Self {
            share_color: false,
            show_shortcut_hints: true,
            show_button_units: false,
            drawing_tools_select: true,
            remember_tool_styles: true,
        }
    }
}

/// A grown side in a preset: pixels, or a percentage of the cropped picture's height (top,
/// bottom) or width (left, right), so it fits any video.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GrowUnit {
    Px,
    Percent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GrowAmount {
    pub value: u32,
    pub unit: GrowUnit,
}

impl GrowAmount {
    const NONE: Self = Self {
        value: 0,
        unit: GrowUnit::Px,
    };

    const fn percent(value: u32) -> Self {
        Self {
            value,
            unit: GrowUnit::Percent,
        }
    }
}

/// A grow preset: a named grow, each side in px or %, in one colour.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GrowPreset {
    pub name: String,
    pub top: GrowAmount,
    pub bottom: GrowAmount,
    pub left: GrowAmount,
    pub right: GrowAmount,
    /// `#rrggbb`.
    pub colour: String,
}

/// The most presets the options bar shows.
pub const MAX_GROW_PRESETS: usize = 12;
/// The longest a preset's name may be, in characters.
const MAX_PRESET_NAME: usize = 40;
/// A grown side's most, in px (frame.ts's `MAX_GROW`) and in %.
const MAX_GROW_PX: u32 = 4000;
const MAX_GROW_PERCENT: u32 = 200;

/// The mockup's: meme captions above, below, or both, 15 % of the picture, black.
pub fn default_grow_presets() -> Vec<GrowPreset> {
    let preset = |name: &str, top: u32, bottom: u32| GrowPreset {
        name: name.into(),
        top: GrowAmount::percent(top),
        bottom: GrowAmount::percent(bottom),
        left: GrowAmount::NONE,
        right: GrowAmount::NONE,
        colour: "#000000".into(),
    };
    vec![
        preset("Meme top", 15, 0),
        preset("Meme bottom", 0, 15),
        preset("Meme top + bottom", 15, 15),
    ]
}

/// The grow presets, checked: named (no two alike), sizes kept to what makes sense, colours as
/// `#rrggbb`, at most [`MAX_GROW_PRESETS`].
fn grow_presets(presets: Vec<GrowPreset>) -> Result<Vec<GrowPreset>, String> {
    if presets.len() > MAX_GROW_PRESETS {
        return Err(format!(
            "There can be {MAX_GROW_PRESETS} grow presets at most: delete one first."
        ));
    }
    let mut names: Vec<String> = Vec::new();
    presets
        .into_iter()
        .map(|mut p| {
            p.name = p.name.trim().to_string();
            if p.name.is_empty() {
                return Err("A grow preset needs a name.".to_string());
            }
            if p.name.chars().count() > MAX_PRESET_NAME {
                return Err(format!(
                    "A grow preset's name can be {MAX_PRESET_NAME} characters at most."
                ));
            }
            let key = p.name.to_lowercase();
            if names.contains(&key) {
                return Err(format!(
                    "There's already a grow preset called \"{}\".",
                    p.name
                ));
            }
            names.push(key);
            for side in [&mut p.top, &mut p.bottom, &mut p.left, &mut p.right] {
                let most = match side.unit {
                    GrowUnit::Px => MAX_GROW_PX,
                    GrowUnit::Percent => MAX_GROW_PERCENT,
                };
                side.value = side.value.min(most);
            }
            p.colour = normalize_color(&p.colour).unwrap_or_else(|| "#000000".into());
            Ok(p)
        })
        .collect()
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
    /// A status-bar hint too long to fit glides to show the rest when the pointer rests.
    pub scroll_hints: bool,
}

/// Follow the Windows accent color.
pub const WINDOWS_ACCENT: &str = "windows";

impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: ThemeMode::System,
            accent: WINDOWS_ACCENT.into(),
            scroll_hints: true,
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

/// `s` with its styles as installed (Settings › About › Reset all styles, Richard 2026-10-26):
/// Settings › Markup's pickers (not its Behavior), and how Settings › Recording's clicks look
/// and last (not whether they're noted, shown live or locked). The rest is left as it is.
pub fn styles_reset(s: &Settings) -> Settings {
    let d = Settings::default();
    let r = d.recording;
    Settings {
        styles: d.styles,
        recording: Recording {
            click_look: r.click_look,
            click_color: r.click_color,
            click_color_right: r.click_color_right,
            click_color_middle: r.click_color_middle,
            click_size: r.click_size,
            click_seconds: r.click_seconds,
            click_fade_in: r.click_fade_in,
            click_fade_out: r.click_fade_out,
            click_double: r.click_double,
            ..s.recording.clone()
        },
        ..s.clone()
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
    s.timeline.default_markup_fade = s
        .timeline
        .default_markup_fade
        .clamp(*DEFAULT_FADE_RANGE.start(), *DEFAULT_FADE_RANGE.end());
    s.timeline.default_clip_fade = s
        .timeline
        .default_clip_fade
        .clamp(*DEFAULT_FADE_RANGE.start(), *DEFAULT_FADE_RANGE.end());
    s.editing.grow_presets = grow_presets(s.editing.grow_presets)?;
    s.playback.volume = if s.playback.volume.is_finite() {
        s.playback.volume.clamp(0.0, 1.0)
    } else {
        1.0
    };
    s.styles = s.styles.normalized();
    s.recording.corner_color = normalize_color(&s.recording.corner_color)
        .unwrap_or_else(|| Recording::default().corner_color);
    if !RECORD_RATES.contains(&s.recording.fps) {
        s.recording.fps = Recording::default().fps;
    }
    if !COUNTDOWNS.contains(&s.recording.countdown) {
        s.recording.countdown = Recording::default().countdown;
    }
    let d = Recording::default();
    s.recording.click_color =
        normalize_color(&s.recording.click_color).unwrap_or_else(|| d.click_color.clone());
    s.recording.click_color_right = normalize_color(&s.recording.click_color_right)
        .unwrap_or_else(|| d.click_color_right.clone());
    s.recording.click_color_middle = normalize_color(&s.recording.click_color_middle)
        .unwrap_or_else(|| d.click_color_middle.clone());
    let within = |v: f64, range: &std::ops::RangeInclusive<f64>, default: f64| {
        if v.is_finite() {
            v.clamp(*range.start(), *range.end())
        } else {
            default
        }
    };
    s.recording.click_size = within(s.recording.click_size, &CLICK_SIZE_RANGE, d.click_size);
    // One of the sizes the click tool offers (Settings › Markup), as its options bar has them.
    s.recording.click_size = s.styles.click_size.nearest(s.recording.click_size);
    s.recording.click_seconds = within(
        s.recording.click_seconds,
        &CLICK_SECONDS_RANGE,
        d.click_seconds,
    );
    s.recording.click_fade_in = within(
        s.recording.click_fade_in,
        &CLICK_FADE_RANGE,
        d.click_fade_in,
    );
    s.recording.click_fade_out = within(
        s.recording.click_fade_out,
        &CLICK_FADE_RANGE,
        d.click_fade_out,
    );
    s.recording.dim_opacity = if s.recording.dim_opacity.is_finite() {
        s.recording
            .dim_opacity
            .clamp(*DIM_RANGE.start(), *DIM_RANGE.end())
    } else {
        Recording::default().dim_opacity
    };
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
    s.recording.file_name = file_template(
        &s.recording.file_name,
        RECORDING_NAME,
        "recordings' file name",
    )?;
    if s.recording.file_name.contains("{name}") || has_tag(&s.recording.file_name, 'c') {
        return Err(
            "A recording has no video name or clips yet: its file name can't use {name} or {c}."
                .into(),
        );
    }
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
    let mut new = validate(new)?;
    let state = app.state::<AppState>();
    let old = {
        let mut current = state.settings.write().unwrap();
        follow_click_palette(&current, &mut new);
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
    if new.debugging.logging != old.debugging.logging {
        crate::log::set_enabled(&crate::product_name(app), new.debugging.logging);
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
    let mut value = value;
    // 2: `{n}` is the auto number in every template (Vandal's); a clip's number is `{c}`.
    if version < 2 {
        if let Some(clip) = value.pointer_mut("/export/clipName") {
            if let Some(t) = clip.as_str() {
                *clip = Value::String(crate::names::clip_tags_from_v1(t));
            }
        }
    }
    match serde_json::from_value::<Settings>(value) {
        Ok(settings) => {
            // Hand edits can leave values that can't work: repaired, or (a folder) reset.
            let mut checked = validate(settings.clone())
                .or_else(|_| {
                    // A bad folder or preset goes back to the default, not everything else.
                    validate(Settings {
                        proxies: Proxies::default(),
                        editing: Editing {
                            grow_presets: default_grow_presets(),
                            ..settings.editing.clone()
                        },
                        ..settings.clone()
                    })
                })
                .unwrap_or_default();
            let changed = version != u64::from(CURRENT_VERSION) || checked != settings;
            checked.version = CURRENT_VERSION;
            (checked, changed)
        }
        Err(e) => {
            logln!("[settings] unreadable settings ({e}); using defaults");
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
            logln!("[settings] stripping UTF-8 BOM from {}", path.display());
            let _ = std::fs::write(&path, body);
        }
        Repair::Quarantine => {
            let backup = dir.join("settings.corrupt.json");
            logln!(
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
            logln!("[settings] cannot open store: {e}; using defaults");
            return Settings::default();
        }
    };
    let (settings, changed) = migrate(store.get(STORE_KEY));
    if changed {
        if let Err(e) = save(app, &settings) {
            logln!("[settings] cannot save: {e}");
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
    fn version_1_clip_names_take_c_for_the_clip() {
        let stored = json!({ "version": 1, "export": { "clipName": "{name}-clip{nn}" } });
        let (s, changed) = migrate(Some(stored));
        assert!(changed);
        assert_eq!(s.export.clip_name, "{name}-clip{cc}");
        // Once: a version 2 `{n}` is the auto number.
        let stored = json!({ "version": 2, "export": { "clipName": "{name} {n}" } });
        assert_eq!(migrate(Some(stored)).0.export.clip_name, "{name} {n}");
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
    fn a_click_palette_colour_changed_changes_the_buttons_that_were_it() {
        let old = Settings::default();
        let mut new = old.clone();
        let palette = new
            .styles
            .tools
            .get_mut("click")
            .and_then(|t| t.palette.as_mut())
            .unwrap();
        // The left button's yellow and the right's pink, both changed.
        palette[0] = "#111111".into();
        palette[3] = "#222222".into();
        new.recording.click_color_right = "#ffffff".into();
        follow_click_palette(&old, &mut new);
        assert_eq!(new.recording.click_color, "#111111");
        // The right button's was being set itself: kept.
        assert_eq!(new.recording.click_color_right, "#ffffff");
        assert_eq!(new.recording.click_color_middle, "#4c9aff");
    }

    #[test]
    fn custom_click_colours_turned_off_bring_back_the_ones_clicks_come_with() {
        let mut old = Settings::default();
        let custom = old.styles.tools.get_mut("click").unwrap();
        custom.palette = Some(vec!["#111111".into(), "#222222".into()]);
        old.recording.click_color = "#222222".into();
        let mut new = old.clone();
        new.styles.tools.get_mut("click").unwrap().palette = None;
        follow_click_palette(&old, &mut new);
        // The second colour then is the second they come with: orange.
        assert_eq!(new.recording.click_color, "#ff8a00");
    }

    #[test]
    fn a_recorded_click_is_a_size_the_click_tool_offers() {
        let mut s = Settings::default();
        s.recording.click_size = 50.0;
        assert_eq!(validate(s.clone()).unwrap().recording.click_size, 44.0);
        s.styles.click_size = crate::styles::NumberPicker::Slider {
            min: 20.0,
            max: 40.0,
        };
        assert_eq!(validate(s).unwrap().recording.click_size, 40.0);
    }

    #[test]
    fn recorded_clicks_last_and_fade_within_reason() {
        let mut s = Settings::default();
        s.recording.click_seconds = 60.0;
        s.recording.click_fade_in = -1.0;
        s.recording.click_fade_out = f64::NAN;
        s.recording.click_color = "nope".into();
        s.recording.click_size = 2.0;
        let v = validate(s).unwrap().recording;
        // Kept to the range, then one of the click tool's sizes (its smallest).
        assert_eq!(v.click_size, 24.0);
        assert_eq!(
            (v.click_seconds, v.click_fade_in, v.click_fade_out),
            (5.0, 0.0, 0.3)
        );
        assert_eq!(v.click_color, "#ffd60a");
    }

    #[test]
    fn recording_rates_and_countdowns_are_ones_offered() {
        let mut s = Settings::default();
        s.recording.fps = 24;
        s.recording.countdown = 7;
        let v = validate(s.clone()).unwrap();
        assert_eq!((v.recording.fps, v.recording.countdown), (60, 3));
        s.recording.fps = 30;
        s.recording.countdown = 0;
        let v = validate(s).unwrap();
        assert_eq!((v.recording.fps, v.recording.countdown), (30, 0));
    }

    #[test]
    fn recording_marks_are_a_color_and_a_dimming_that_can_work() {
        let mut s = Settings::default();
        s.recording.corner_color = "#ABC".into();
        s.recording.dim_opacity = 2.0;
        let v = validate(s.clone()).unwrap();
        assert_eq!(v.recording.corner_color, "#aabbcc");
        assert_eq!(v.recording.dim_opacity, 0.9);
        s.recording.corner_color = "red".into();
        s.recording.dim_opacity = f64::NAN;
        let v = validate(s).unwrap();
        assert_eq!(v.recording.corner_color, "#00ff27");
        assert_eq!(v.recording.dim_opacity, 0.3);
    }

    #[test]
    fn playback_volume_is_kept_from_nothing_to_full() {
        let mut s = Settings::default();
        assert_eq!((s.playback.volume, s.playback.muted), (1.0, false));
        s.playback.volume = 1.7;
        assert_eq!(validate(s.clone()).unwrap().playback.volume, 1.0);
        s.playback.volume = -0.2;
        assert_eq!(validate(s.clone()).unwrap().playback.volume, 0.0);
        s.playback.volume = f64::NAN;
        assert_eq!(validate(s).unwrap().playback.volume, 1.0);
    }

    #[test]
    fn partial_file_fills_defaults() {
        let (s, changed) = migrate(Some(json!({
            "version": CURRENT_VERSION,
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
    fn the_default_fade_is_kept_in_range() {
        let mut s = Settings::default();
        assert_eq!(s.timeline.default_markup_fade, 15);
        s.timeline.default_markup_fade = 0;
        assert_eq!(validate(s.clone()).unwrap().timeline.default_markup_fade, 1);
        s.timeline.default_markup_fade = 1000;
        s.timeline.default_clip_fade = 0;
        let kept = validate(s).unwrap().timeline;
        assert_eq!((kept.default_markup_fade, kept.default_clip_fade), (300, 1));
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
        assert_eq!(v["version"], CURRENT_VERSION);
        assert_eq!(v["appearance"]["theme"], "system");
        assert_eq!(v["appearance"]["accent"], "windows");
        assert_eq!(v["timeline"]["thumbnails"], true);
        assert_eq!(v["timeline"]["waveform"], true);
        assert_eq!(v["timeline"]["rangesFollowVideo"], true);
        assert_eq!(v["timeline"]["deleteRangesWithClip"], true);
        assert_eq!(v["timeline"]["splitMarkup"], true);
        assert_eq!(v["timeline"]["fadeSplitMarkup"], false);
        assert_eq!(v["timeline"]["markupStretchesWithSpeed"], true);
        assert_eq!(v["timeline"]["keepPitch"], true);
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
        assert_eq!(ok.export.timeline_name, TIMELINE_NAME);
        assert_eq!(ok.export.clip_name, "{name} part {n}");
        s.export.clip_name = "{name}/{n}".into();
        assert!(validate(s).unwrap_err().contains("can't contain /"));
    }

    #[test]
    fn resetting_the_styles_leaves_the_rest() {
        let mut s = Settings::default();
        s.styles.palette = vec!["#123456".into()];
        s.recording.click_size = 60.0;
        // Behavior, not style: kept.
        s.markup.remember_tool_styles = !s.markup.remember_tool_styles;
        s.recording.clicks = !s.recording.clicks;
        s.recording.live_clicks = !s.recording.live_clicks;
        s.recording.placed_clicks_follow = !s.recording.placed_clicks_follow;
        s.recording.folder = r"D:\Takes".into();
        s.export.timeline_name = "{name}".into();
        let r = styles_reset(&s);
        let d = Settings::default();
        assert_eq!(r.styles, d.styles);
        assert_eq!(r.recording.click_size, d.recording.click_size);
        assert_eq!(r.markup, s.markup);
        assert_eq!(r.export, s.export);
        let kept = |x: &Settings| {
            let r = &x.recording;
            (
                r.clicks,
                r.live_clicks,
                r.placed_clicks_follow,
                r.folder.clone(),
            )
        };
        assert_eq!(kept(&r), kept(&s));
    }

    #[test]
    fn recording_file_names_have_no_video_name_or_clips() {
        let mut s = Settings::default();
        s.recording.file_name = " ".into();
        assert_eq!(
            validate(s.clone()).unwrap().recording.file_name,
            RECORDING_NAME
        );
        s.recording.file_name = "Take {nn} {yyyy}".into();
        assert_eq!(
            validate(s.clone()).unwrap().recording.file_name,
            "Take {nn} {yyyy}"
        );
        for bad in ["{name} take", "Take {c}", "Take {ccc}"] {
            s.recording.file_name = bad.into();
            assert!(
                validate(s.clone()).unwrap_err().contains("{name} or {c}"),
                "{bad}"
            );
        }
        // Braces that aren't a tag are kept.
        s.recording.file_name = "Take {cat} {}".into();
        assert!(validate(s).is_ok());
    }

    #[test]
    fn grow_presets_are_checked() {
        let s = Settings::default();
        assert_eq!(s.editing.grow_presets.len(), 3);
        assert_eq!(s.editing.grow_presets[2].bottom, GrowAmount::percent(15));

        let mut s = Settings::default();
        let p = &mut s.editing.grow_presets[0];
        p.name = "  Caption  ".into();
        p.colour = "#FFF".into();
        p.left = GrowAmount {
            value: 9999,
            unit: GrowUnit::Px,
        };
        p.top = GrowAmount::percent(500);
        let ok = validate(s.clone()).unwrap();
        let p = &ok.editing.grow_presets[0];
        assert_eq!(p.name, "Caption");
        assert_eq!(p.colour, "#ffffff");
        assert_eq!(p.left.value, 4000);
        assert_eq!(p.top.value, 200);

        s.editing.grow_presets[1].name = "caption".into();
        assert!(validate(s.clone()).unwrap_err().contains("already"));
        s.editing.grow_presets[1].name = " ".into();
        assert!(validate(s.clone()).unwrap_err().contains("needs a name"));
        s.editing.grow_presets = vec![default_grow_presets()[0].clone(); 13];
        assert!(validate(s).unwrap_err().contains("at most"));
    }

    #[test]
    fn deleting_every_grow_preset_keeps_none() {
        let mut s = Settings::default();
        s.editing.grow_presets.clear();
        let (loaded, _) = migrate(Some(serde_json::to_value(&s).unwrap()));
        assert!(loaded.editing.grow_presets.is_empty());
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
