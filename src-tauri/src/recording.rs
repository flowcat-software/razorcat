//! Screen recording (PLAN 5b): a monitor, or an area of one, picked on the overlays (picker.rs),
//! recorded by the bundled ffmpeg's `gfxcapture` (Windows.Graphics.Capture, on the GPU, an area
//! cropped there; spike 5b.1), into the recordings folder, then opened (or added to the timeline).
//!
//! The editor steps aside (minimized) and a small control (recorder.html: the time and Stop)
//! floats at the top of the monitor, left out of the recording (`WDA_EXCLUDEFROMCAPTURE`).
//! `gfxcapture` sends a frame only when the picture changes, so `fps` repeats them to a steady
//! 60, the first back to 0. The frames come down from the GPU and are converted to BT.709 video
//! here (the encoder given the GPU's BGRA tags it as RGB, which players show wrong), then
//! encoded with the export's encoders, best first. Stop asks ffmpeg to finish (`q`), so the file
//! is whole; till then it's a `.part`.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_specta::Event;

use crate::audio::{self, Capture, Clock};
use crate::editor::LABEL;
use crate::export::{bitrate, encoders, Encoder};
use crate::input::{self, Press};
use crate::sidecar::{self, Tool};
use crate::state::AppState;

/// The control's window.
pub const RECORDER: &str = "recorder";
/// The marks round an area being recorded (PLAN 5b.3c; outline.html): its corners, the rest of
/// its monitor dimmed.
const OUTLINE_LABEL: &str = "recording-outline";
/// The countdown's window (countdown.html).
const COUNTDOWN_LABEL: &str = "recording-countdown";
/// The control's size (logical px) and its gap from the monitor's top: the dot, the time, clicks,
/// Pause and Stop. Wide enough for "Starts in 10" (a 10 s countdown) beside them.
const CONTROL: (f64, f64) = (288.0, 44.0);
/// What a sound's mute button adds to it (a button and a gap): the microphone's, the system
/// sound's.
const CONTROL_MIC: f64 = 40.0;
/// While recording, wherever the keys are: mute and unmute the microphone (PLAN 5b.4d), pause
/// and resume, stop (5b.5c). Settable with 5b.8's shortcuts.
const MUTE_KEY: &str = "Ctrl+Alt+M";
const PAUSE_KEY: &str = "Ctrl+Alt+P";
const STOP_KEY: &str = "Ctrl+Alt+S";
/// Clicks noted or not, while recording (PLAN 5b.6).
const CLICKS_KEY: &str = "Ctrl+Alt+C";
/// Mute and unmute the system's sound, while it's recorded (Richard, 2026-10-26: D, desktop).
const SYSTEM_KEY: &str = "Ctrl+Alt+D";
const CONTROL_TOP: f64 = 8.0;
/// How long ffmpeg must keep running for an encoder to count as working.
const STARTED: Duration = Duration::from_millis(1500);
/// How long a stopped recording may take to finish its file.
const FINISHING: Duration = Duration::from_secs(20);

/// Rust → editor: a recording started, or ended (`message` if it failed: the recording, if any,
/// opens on its own).
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct RecordingChanged {
    pub recording: bool,
    pub message: Option<String>,
}

/// A recording under way: its segments (one per stretch between pauses, each ffmpeg into its own
/// file, joined when it stops), and what a new segment needs.
struct Running {
    /// The segment being recorded; None while paused.
    seg: Option<Segment>,
    /// The segments done and whole, in order, and each one's start and end on the clock (100 ns):
    /// where a press falls in the joined recording.
    parts: Vec<PathBuf>,
    spans: Vec<(i64, i64)>,
    /// When each segment's picture starts (µs since 1970, its frame 0): the camera's fitted to
    /// these (camera.rs).
    starts: Vec<i64>,
    /// The camera's being recorded (PLAN 5d.3), into `{base}.camera.mkv`.
    camera: bool,
    /// Clicks being noted (PLAN 5b.6), once they're on.
    input: Option<input::Watch>,
    clicks: bool,
    /// Where the segments go: `{base}.{n}.part`.
    base: PathBuf,
    target: Target,
    encoder: Encoder,
    sources: Vec<audio::Source>,
    video: Video,
    file: PathBuf,
    /// Added to the timeline when done (else it replaces it).
    add: bool,
    /// What to say when it's done: why the sound isn't as asked.
    warning: Option<String>,
    /// The microphone, and the system's sound, muted (kept across segments).
    muted: bool,
    system_muted: bool,
}

/// A sound being recorded, which the control can mute: the microphone, or the system's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sound {
    Microphone,
    System,
}

impl Sound {
    fn of(c: &Capture) -> Self {
        if c.microphone {
            Sound::Microphone
        } else {
            Sound::System
        }
    }

    fn is(self, s: &audio::Source) -> bool {
        matches!(
            (self, s),
            (Sound::Microphone, audio::Source::Microphone(_))
                | (Sound::System, audio::Source::System)
        )
    }

    /// The control told: its button shows it.
    fn say(self, app: &AppHandle, muted: bool) {
        let _ = match self {
            Sound::Microphone => MicMuted(muted).emit_to(app, RECORDER),
            Sound::System => SystemMuted(muted).emit_to(app, RECORDER),
        };
    }
}

impl Running {
    fn muted(&mut self, sound: Sound) -> &mut bool {
        match sound {
            Sound::Microphone => &mut self.muted,
            Sound::System => &mut self.system_muted,
        }
    }
}

/// A new segment's sound, muted as the control has it.
fn set_mutes(seg: &Segment, mic: bool, system: bool) {
    for c in &seg.sound {
        c.set_muted(match Sound::of(c) {
            Sound::Microphone => mic,
            Sound::System => system,
        });
    }
}

/// One stretch of recording: ffmpeg into `part`, with its sound.
struct Segment {
    /// When it started (its video and sound count from here).
    clock: Clock,
    child: Child,
    stdin: ChildStdin,
    part: PathBuf,
    log: Arc<Mutex<Vec<String>>>,
    /// The sound being taken, into ffmpeg (PLAN 5b.4).
    sound: Vec<Capture>,
}

/// How the picture is taken (Settings › Recording › Video).
#[derive(Debug, Clone, Copy)]
struct Video {
    fps: u32,
    cursor: bool,
}

fn video(app: &AppHandle) -> Video {
    let state = app.state::<AppState>();
    let settings = state.settings.read().unwrap();
    Video {
        fps: settings.recording.fps,
        cursor: settings.recording.cursor,
    }
}

fn segment_path(base: &std::path::Path, n: usize) -> PathBuf {
    let mut name = base.as_os_str().to_owned();
    name.push(format!(".{n}.part"));
    PathBuf::from(name)
}

/// The sound to record, as Settings › Recording has it: the microphone (the one chosen, or the
/// default), and what the computer plays.
fn sound_sources(app: &AppHandle) -> Vec<audio::Source> {
    let r = app
        .state::<AppState>()
        .settings
        .read()
        .unwrap()
        .recording
        .clone();
    let mut sources = Vec::new();
    if r.microphone {
        sources.push(audio::Source::Microphone(
            Some(r.microphone_device).filter(|d| !d.is_empty()),
        ));
    }
    if r.system_sound {
        sources.push(audio::Source::System);
    }
    sources
}

/// Rust → the control: the microphone muted or not (by its button or [`MUTE_KEY`]).
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct MicMuted(pub bool);

/// Rust → the control: the system's sound muted or not (by its button or [`SYSTEM_KEY`]).
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct SystemMuted(pub bool);

/// Rust → the control: the recording paused or going again (its button or [`PAUSE_KEY`]).
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct RecordingPaused(pub bool);

/// Rust → the control: clicks noted or not.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct ClicksNoted(pub bool);

/// Clicks noted or not (the control's button, or [`CLICKS_KEY`]): `Some(on)` as given, `None`
/// the other way. The hook starts when they're first on. Says so to the control.
pub fn note(app: &AppHandle, clicks: Option<bool>) {
    let mut now = NOW.lock().unwrap();
    let Some(r) = now.as_mut() else {
        drop(now);
        let mut early = EARLY.lock().unwrap();
        match early.as_mut() {
            Some(e) => {
                e.clicks = clicks.unwrap_or(!e.clicks);
                let _ = ClicksNoted(e.clicks).emit_to(app, RECORDER);
            }
            // It got going meanwhile: to the recording.
            None if NOW.lock().unwrap().is_some() => {
                drop(early);
                note(app, clicks);
            }
            None => {}
        }
        return;
    };
    r.clicks = clicks.unwrap_or(!r.clicks);
    if r.input.is_none() && r.clicks {
        let window = r.target.window.map(|w| w.0 as isize);
        match input::Watch::start(false, window, LIVE.lock().unwrap().clone()) {
            Ok(w) => r.input = Some(w),
            Err(e) => {
                logln!("[recording] clicks: {e}");
                r.clicks = false;
            }
        }
    }
    if let Some(w) = &r.input {
        w.set_clicks(r.clicks);
    }
    let on = r.clicks;
    drop(now);
    logln!("[recording] clicks {on}");
    let _ = ClicksNoted(on).emit_to(app, RECORDER);
}

/// A click where it lands on the recorded picture, and when (s).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct RecordedClick {
    pub time: f64,
    pub x: f64,
    pub y: f64,
    pub button: input::Button,
    pub double: bool,
}

/// The camera recorded with it (PLAN 5d.3): its file (once fitted to the recording, after it
/// opens), and where the bubble was left: its top-left and across on the picture (px).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct RecordedCamera {
    pub file: String,
    pub x: f64,
    pub y: f64,
    pub size: f64,
}

/// The clicks of a recording, on its picture and its time, and its camera.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Type)]
pub struct RecordedInput {
    pub clicks: Vec<RecordedClick>,
    pub camera: Option<RecordedCamera>,
}

/// Recordings' clicks, by file, until the editor opening it takes them (in memory only).
static NOTED: Mutex<Vec<(PathBuf, RecordedInput)>> = Mutex::new(Vec::new());

/// The clicks noted while `path` was recorded, once: the editor turns them into markup as it
/// opens the file.
pub fn take_input(path: &str) -> Option<RecordedInput> {
    let path = std::path::Path::new(path);
    let mut noted = NOTED.lock().unwrap();
    let same = |p: &PathBuf| {
        p == path
            || (std::fs::canonicalize(p).ok())
                .is_some_and(|a| std::fs::canonicalize(path).is_ok_and(|b| a == b))
    };
    let i = noted.iter().position(|(p, _)| same(p))?;
    Some(noted.remove(i).1)
}

/// Where `qpc` (100 ns) falls in the joined recording (s), given its segments' spans in order;
/// None in a pause.
fn recording_time(spans: &[(i64, i64)], qpc: i64) -> Option<f64> {
    let mut before = 0;
    for &(a, b) in spans {
        if (a..b).contains(&qpc) {
            return Some((before + qpc - a) as f64 / 1e7);
        }
        before += b - a;
    }
    None
}

/// The clicks on the recording: each on its time and its picture (dropped in a pause, or off
/// it).
fn recorded(presses: Vec<Press>, spans: &[(i64, i64)], target: &Target) -> RecordedInput {
    let mut out = RecordedInput::default();
    for p in presses {
        match p {
            Press::Click {
                qpc,
                x,
                y,
                button,
                double,
                window,
            } => {
                let (Some(time), Some((x, y))) =
                    (recording_time(spans, qpc), target.on_picture(x, y, window))
                else {
                    continue;
                };
                out.clicks.push(RecordedClick {
                    time,
                    x,
                    y,
                    button,
                    double,
                });
            }
        }
    }
    out
}

/// Mutes `sound` being recorded (the microphone, or the system's), or unmutes it (`muted` None:
/// the other way). Says so to the control.
pub fn mute(app: &AppHandle, sound: Sound, muted: Option<bool>) {
    let mut now = NOW.lock().unwrap();
    let Some(r) = now.as_mut() else {
        drop(now);
        let mut early = EARLY.lock().unwrap();
        match early.as_mut() {
            Some(e) if e.has(sound) => {
                let m = e.muted(sound);
                *m = muted.unwrap_or(!*m);
                sound.say(app, *m);
            }
            // It got going meanwhile: to the recording.
            None if NOW.lock().unwrap().is_some() => {
                drop(early);
                mute(app, sound, muted);
            }
            _ => {}
        }
        return;
    };
    if !r.sources.iter().any(|s| sound.is(s)) {
        return;
    }
    let m = r.muted(sound);
    let muted = muted.unwrap_or(!*m);
    *m = muted;
    if let Some(c) = r
        .seg
        .as_ref()
        .and_then(|s| s.sound.iter().find(|c| Sound::of(c) == sound))
    {
        c.set_muted(muted);
    }
    drop(now);
    logln!(
        "[recording] {} {}",
        match sound {
            Sound::Microphone => "microphone",
            Sound::System => "system sound",
        },
        if muted { "muted" } else { "on" }
    );
    sound.say(app, muted);
}

/// What a key held while recording does.
type KeyAction = fn(&AppHandle);

/// The keys held while recording ([`MUTE_KEY`] only with the microphone, [`SYSTEM_KEY`] with the
/// system's sound); let go when it's done.
fn hold_keys(app: &AppHandle, on: bool, mic: bool, system: bool) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let keys = app.global_shortcut();
    if !on {
        for key in [MUTE_KEY, PAUSE_KEY, STOP_KEY, CLICKS_KEY, SYSTEM_KEY] {
            let _ = keys.unregister(key);
        }
        return;
    }
    let held: [(&str, KeyAction); 5] = [
        (MUTE_KEY, |app| mute(app, Sound::Microphone, None)),
        (PAUSE_KEY, pause),
        (STOP_KEY, stop),
        (CLICKS_KEY, |app| note(app, None)),
        (SYSTEM_KEY, |app| mute(app, Sound::System, None)),
    ];
    for (key, action) in held {
        if (key == MUTE_KEY && !mic) || (key == SYSTEM_KEY && !system) {
            continue;
        }
        let registered = keys.on_shortcut(key, move |app, _, event| {
            if event.state == ShortcutState::Pressed {
                action(app);
            }
        });
        if let Err(e) = registered {
            // Another app has it: the control's buttons still work.
            logln!("[recording] {key} not available: {e}");
        }
    }
}

/// Why ffmpeg didn't start: source `n` couldn't be had (record without it), or ffmpeg itself
/// (try the next encoder).
enum Failed {
    Sound(usize, String),
    Ffmpeg(String),
}

/// One sound for ffmpeg: its raw format (`-f`), rate, channels, and pipe.
type SoundInput<'a> = (&'a str, u32, u16, &'a str);

/// ffmpeg's arguments for the sound, after the video's input: each source an input, kept on its
/// timestamps (`-copyts`), and with more than one, mixed into one track at full level each
/// (`normalize=0`: else each is halved), as stereo at 48 kHz.
fn sound_args(inputs: &[SoundInput]) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    for (sample, rate, channels, pipe) in inputs {
        a.extend(["-thread_queue_size", "4096", "-f", sample, "-ar"].map(String::from));
        a.extend([rate.to_string(), "-ac".into(), channels.to_string()]);
        a.extend(["-i".to_string(), pipe.to_string()]);
    }
    a.extend(["-copyts", "-map", "0:v"].map(String::from));
    match inputs.len() {
        0 => return vec!["-copyts".into()],
        1 => a.extend(["-map", "1:a"].map(String::from)),
        n => {
            let each: String = (1..=n)
                .map(|i| format!("[{i}:a]aresample=48000,aformat=channel_layouts=stereo[s{i}];"))
                .collect();
            let all: String = (1..=n).map(|i| format!("[s{i}]")).collect();
            a.push("-filter_complex".into());
            a.push(format!(
                "{each}{all}amix=inputs={n}:duration=longest:normalize=0[sound]"
            ));
            a.extend(["-map", "[sound]"].map(String::from));
        }
    }
    a.extend(["-c:a", "aac", "-b:a", "192k"].map(String::from));
    a
}

static NOW: Mutex<Option<Running>> = Mutex::new(None);
/// Set while a recording starts (before it's `NOW`), so a second can't.
static STARTING: Mutex<bool> = Mutex::new(false);
/// Stop was asked for while it started (the control is up before ffmpeg is, and the countdown
/// runs): it's cancelled in the countdown, or stops as soon as it's under way.
static STOP_ASKED: Mutex<bool> = Mutex::new(false);
/// Held while a segment ends or starts (pause, resume, stop), so they happen one at a time: a
/// Stop mid-pause waits for the paused segment's file to be whole.
static SWITCH: Mutex<()> = Mutex::new(());

/// The control's toggles before there's a recording to change (the countdown, and ffmpeg
/// starting): kept here, and the recording starts as they say. Taken under this lock as the
/// recording is made `NOW`, so a toggle lands in one or the other.
#[derive(Debug, Clone, Copy)]
struct Early {
    mic: bool,
    muted: bool,
    /// The system's sound recorded, and muted.
    system: bool,
    system_muted: bool,
    clicks: bool,
}

impl Early {
    fn has(&self, sound: Sound) -> bool {
        match sound {
            Sound::Microphone => self.mic,
            Sound::System => self.system,
        }
    }

    fn muted(&mut self, sound: Sound) -> &mut bool {
        match sound {
            Sound::Microphone => &mut self.muted,
            Sound::System => &mut self.system_muted,
        }
    }
}
static EARLY: Mutex<Option<Early>> = Mutex::new(None);

/// Where recordings go: Settings › Recording › Folder, else the default.
/// Settings › Recording's preview of a name template: the file a recording would get now, `{n}`
/// counted in the recordings folder.
pub fn preview_name(app: &AppHandle, template: &str) -> String {
    format!("{}.mp4", file_name(&folder(app), template))
}

fn folder(app: &AppHandle) -> PathBuf {
    let setting = app
        .state::<AppState>()
        .settings
        .read()
        .unwrap()
        .recording
        .folder
        .clone();
    if !setting.is_empty() {
        return crate::paths::resolve_dir(&setting);
    }
    default_folder(app).unwrap_or_default()
}

/// Where recordings go when Settings › Recording › Folder is empty: Videos\Razorcat\Recordings.
pub fn default_folder(app: &AppHandle) -> Option<PathBuf> {
    crate::export::default_folder(app).map(|d| d.join("Recordings"))
}

/// A monitor, as Windows names it (`HMONITOR`, for `gfxcapture`), and where it is in physical
/// pixels, with its scale.
#[derive(Debug, Clone, PartialEq)]
pub struct Screen {
    pub hmonitor: u64,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

impl Screen {
    /// Whether the physical point (`x`, `y`) is on it.
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x
            && y >= self.y
            && i64::from(x) < i64::from(self.x) + i64::from(self.width)
            && i64::from(y) < i64::from(self.y) + i64::from(self.height)
    }
}

/// The monitors, as Tauri lists them.
pub fn screens(app: &AppHandle) -> Result<Vec<Screen>, String> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONEAREST};
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let screens: Vec<Screen> = monitors
        .iter()
        .map(|m| {
            let (p, s) = (m.position(), m.size());
            let centre = POINT {
                x: p.x + (s.width / 2) as i32,
                y: p.y + (s.height / 2) as i32,
            };
            let h = unsafe { MonitorFromPoint(centre, MONITOR_DEFAULTTONEAREST) };
            Screen {
                hmonitor: h.0 as u64,
                x: p.x,
                y: p.y,
                width: s.width,
                height: s.height,
                scale: m.scale_factor(),
            }
        })
        .collect();
    if screens.is_empty() {
        return Err("No monitor found.".into());
    }
    Ok(screens)
}

/// What to record: a monitor, or an area of it (monitor pixels: x, y, width, height), or a
/// window (its handle, and its size when picked), made even for the encoder (yuv420p halves the
/// colour). `screen` is where the control goes.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub screen: Screen,
    pub area: Option<(u32, u32, u32, u32)>,
    pub window: Option<(u64, u32, u32)>,
    /// A window's top-left when picked (virtual-desktop px).
    pub at: Option<(i32, i32)>,
}

/// The smallest area recorded, either side (px).
const MIN_SIDE: u32 = 16;

impl Target {
    pub fn of(screen: Screen, area: Option<(u32, u32, u32, u32)>) -> Self {
        let area = area.map(|(x, y, w, h)| {
            let x = x.min(screen.width.saturating_sub(MIN_SIDE));
            let y = y.min(screen.height.saturating_sub(MIN_SIDE));
            let w = w.clamp(MIN_SIDE, screen.width - x) & !1;
            let h = h.clamp(MIN_SIDE, screen.height - y) & !1;
            (x, y, w, h)
        });
        Self {
            screen,
            area,
            window: None,
            at: None,
        }
    }

    /// Window `hwnd`, at `x`, `y` (virtual-desktop px) and `width` × `height` when picked, on
    /// `screen` (or mostly).
    pub fn window(screen: Screen, hwnd: u64, (x, y, width, height): (i32, i32, u32, u32)) -> Self {
        Self {
            screen,
            area: None,
            window: Some((hwnd, width.max(MIN_SIDE), height.max(MIN_SIDE))),
            at: Some((x, y)),
        }
    }

    /// Screen point (`x`, `y`; virtual-desktop px) on the recorded picture (px), if it's on it. A
    /// window's picture is its frame as it was when clicked (`window`), fitted to the size it
    /// started at as `gfxcapture` fits it (`scale_aspect`).
    fn on_picture(
        &self,
        x: i32,
        y: i32,
        window: Option<(i32, i32, i32, i32)>,
    ) -> Option<(f64, f64)> {
        let (w, h) = self.size();
        let (w, h) = (f64::from(w), f64::from(h));
        let s = &self.screen;
        let (px, py) = match (self.window, window, self.area) {
            (Some(_), Some((fx, fy, fw, fh)), _) => {
                if fw <= 0 || fh <= 0 {
                    return None;
                }
                let k = (w / f64::from(fw)).min(h / f64::from(fh));
                (
                    (w - f64::from(fw) * k) / 2.0 + f64::from(x - fx) * k,
                    (h - f64::from(fh) * k) / 2.0 + f64::from(y - fy) * k,
                )
            }
            (Some(_), None, _) => return None,
            (None, _, Some((ax, ay, _, _))) => (
                f64::from(x - s.x - ax as i32),
                f64::from(y - s.y - ay as i32),
            ),
            (None, _, None) => (f64::from(x - s.x), f64::from(y - s.y)),
        };
        (px >= 0.0 && py >= 0.0 && px < w && py < h).then_some((px, py))
    }

    /// Where it is on its monitor, in the monitor's physical pixels (the countdown's place): the
    /// area, the window (as picked), or all of it.
    pub fn on_screen(&self) -> (i32, i32, u32, u32) {
        let s = &self.screen;
        match (self.area, self.window, self.at) {
            (Some((x, y, w, h)), _, _) => (x as i32, y as i32, w, h),
            (None, Some((_, w, h)), Some((x, y))) => (x - s.x, y - s.y, w, h),
            _ => (0, 0, s.width, s.height),
        }
    }

    /// The picture's size.
    pub fn size(&self) -> (u32, u32) {
        match (self.window, self.area) {
            (Some((_, w, h)), _) => (w & !1, h & !1),
            (None, Some((_, _, w, h))) => (w, h),
            (None, None) => (self.screen.width & !1, self.screen.height & !1),
        }
    }

    /// `gfxcapture`'s options for it: the monitor, and the crop (on the GPU); or the window, its
    /// sides rounded down to even, and if it's resized while recording, scaled to fit the size it
    /// started at.
    fn source(&self) -> String {
        if let Some((hwnd, _, _)) = self.window {
            return format!("hwnd={hwnd}:width=-2:height=-2:resize_mode=scale_aspect");
        }
        let s = &self.screen;
        let (x, y) = self.area.map_or((0, 0), |a| (a.0, a.1));
        let (w, h) = self.size();
        format!(
            "hmonitor={}:crop_left={x}:crop_top={y}:crop_right={}:crop_bottom={}",
            s.hmonitor,
            s.width - x - w,
            s.height - y - h
        )
    }
}

/// A recording is under way or starting.
pub fn busy() -> bool {
    NOW.lock().unwrap().is_some() || *STARTING.lock().unwrap()
}

/// Starts recording `target`, on a thread; `add` puts it on the end of the timeline when done,
/// else it replaces it. Says how it went with [`RecordingChanged`].
pub fn start(app: &AppHandle, add: bool, target: Target) -> Result<(), String> {
    {
        let mut starting = STARTING.lock().unwrap();
        if *starting || NOW.lock().unwrap().is_some() {
            return Err("A recording is under way.".into());
        }
        *starting = true;
        *STOP_ASKED.lock().unwrap() = false;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let started = begin(&app, add, &target);
        // Under the same lock as `stop` checks it: a Stop now is either seen there, or asked.
        let asked = {
            let mut starting = STARTING.lock().unwrap();
            *starting = false;
            std::mem::take(&mut *STOP_ASKED.lock().unwrap())
        };
        match started {
            Ok(true) => {
                if asked {
                    stop(&app);
                }
                watch(app);
            }
            // Cancelled in the countdown: nothing recorded, nothing to say.
            Ok(false) => {
                EARLY.lock().unwrap().take();
                drop_camera(&app);
                logln!("[recording] cancelled in the countdown");
                close_control(&app);
                show_editor(&app);
                let _ = RecordingChanged {
                    recording: false,
                    message: None,
                }
                .emit_to(&app, LABEL);
            }
            Err(message) => {
                EARLY.lock().unwrap().take();
                drop_camera(&app);
                logln!("[recording] couldn't start: {message}");
                close_control(&app);
                show_editor(&app);
                let _ = RecordingChanged {
                    recording: false,
                    message: Some(format!("Couldn't record: {message}")),
                }
                .emit_to(&app, LABEL);
            }
        }
    });
    Ok(())
}

/// Puts the control up, counts down, and starts ffmpeg recording (the editor is aside already).
/// False if Stop (Cancel) was pressed in the countdown.
fn begin(app: &AppHandle, add: bool, target: &Target) -> Result<bool, String> {
    let dir = folder(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    let template = app
        .state::<AppState>()
        .settings
        .read()
        .unwrap()
        .recording
        .file_name
        .clone();
    let name = file_name(&dir, &template);
    let file = dir.join(format!("{name}.mp4"));
    let base = dir.join(&name);

    if let Some(editor) = app.get_webview_window(LABEL) {
        let _ = editor.minimize();
    }
    let settings = app
        .state::<AppState>()
        .settings
        .read()
        .unwrap()
        .recording
        .clone();
    // The marks first: the control is shown after, so it's in front of their dimming. Clicks
    // shown live (PLAN 5b.6f) are drawn there too, whatever's recorded.
    let marks = target.area.is_some() && (settings.corners || settings.dim);
    if marks || settings.live_clicks {
        open_outline(app, &target.screen, target.area, &settings);
    }
    if settings.live_clicks {
        let (tx, rx) = channel();
        *LIVE.lock().unwrap() = Some(tx);
        show_live(app.clone(), target.clone(), rx);
    }
    let mut sources = sound_sources(app);
    let mic = sources.iter().any(|s| Sound::Microphone.is(s));
    let system = sources.iter().any(|s| Sound::System.is(s));
    let count = settings.countdown;
    *EARLY.lock().unwrap() = Some(Early {
        mic,
        muted: false,
        system,
        system_muted: false,
        clicks: settings.clicks,
    });
    open_control(app, &target.screen, mic, system, count, settings.clicks);
    let mut warning = None;
    // The camera from now, so it's going when the screen starts (it takes a moment to open);
    // fitted to the recording when it's done.
    let camera = crate::camera::held()
        && match encoders(app).first() {
            Some(&encoder) => crate::camera::record(app, camera_take(&base), encoder)
                .inspect_err(|e| warning = Some(format!("Recorded without the camera: {e}.")))
                .is_ok(),
            None => false,
        };
    if count > 0 {
        open_countdown(app, target, count);
        let until = Instant::now() + Duration::from_secs(u64::from(count));
        while Instant::now() < until {
            if *STOP_ASKED.lock().unwrap() {
                close_countdown(app);
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        close_countdown(app);
    }
    // The overlays, the countdown and the editor out of the way before the first frame.
    std::thread::sleep(Duration::from_millis(250));

    // Noting from before ffmpeg starts, not once it's seen to: its frames are from the start of
    // its clock, and a click in its first moments would be lost (the control's toggle sets it).
    let mut noting = EARLY
        .lock()
        .unwrap()
        .as_ref()
        .filter(|e| e.clicks)
        .and_then(|_| {
            let window = target.window.map(|w| w.0 as isize);
            input::Watch::start(true, window, LIVE.lock().unwrap().clone())
                .inspect_err(|e| logln!("[recording] clicks: {e}"))
                .ok()
        });

    let (w, h) = target.size();
    let video = video(app);
    let mut why = String::from("no encoder worked");
    for encoder in encoders(app) {
        loop {
            let part = segment_path(&base, 0);
            match spawn(target, encoder, &part, &sources, video) {
                Ok(seg) => {
                    logln!(
                        "[recording] {w}×{h} at {} fps with {encoder:?}, sound {sources:?}",
                        video.fps
                    );
                    let has = |sound| seg.sound.iter().any(|c| Sound::of(c) == sound);
                    hold_keys(app, true, has(Sound::Microphone), has(Sound::System));
                    // Said before it can be stopped, so "stopped" always comes after.
                    let _ = RecordingChanged {
                        recording: true,
                        message: None,
                    }
                    .emit_to(app, LABEL);
                    // As the control was set before it got going.
                    let mut early = EARLY.lock().unwrap();
                    let set = early.take();
                    let muted = set.is_some_and(|e| e.muted);
                    let system_muted = set.is_some_and(|e| e.system_muted);
                    set_mutes(&seg, muted, system_muted);
                    *NOW.lock().unwrap() = Some(Running {
                        seg: Some(seg),
                        parts: Vec::new(),
                        spans: Vec::new(),
                        starts: Vec::new(),
                        camera,
                        input: noting.take(),
                        clicks: false,
                        base,
                        target: target.clone(),
                        encoder,
                        sources,
                        video,
                        file,
                        add,
                        warning,
                        muted,
                        system_muted,
                    });
                    drop(early);
                    if set.is_some_and(|e| e.clicks) {
                        note(app, Some(true));
                    }
                    return Ok(true);
                }
                // The microphone chosen isn't there: the default one; a source not there at all:
                // recorded without it, and it's said when done.
                Err(Failed::Sound(n, e)) => {
                    logln!("[recording] no sound from {:?}: {e}", sources[n]);
                    if matches!(sources[n], audio::Source::Microphone(Some(_))) {
                        sources[n] = audio::Source::Microphone(None);
                        warning = Some(
                            "The microphone chosen in Settings wasn't found: the default one was used."
                                .into(),
                        );
                    } else {
                        let what = match sources.remove(n) {
                            audio::Source::System => "the system's sound",
                            audio::Source::Microphone(_) => "the microphone",
                        };
                        warning = Some(format!("Recorded without {what}: {e}."));
                    }
                }
                Err(Failed::Ffmpeg(e)) => {
                    logln!("[recording] {encoder:?} didn't start: {e}");
                    why = e;
                    let _ = std::fs::remove_file(&part);
                    break;
                }
            }
        }
    }
    if let Some(w) = noting {
        w.stop();
    }
    Err(why)
}

/// The file's name: "Recording 2026-10-25 14-03-22", a number added if it's taken.
fn file_name(dir: &std::path::Path, template: &str) -> String {
    let t = crate::names::Timestamp::now_local();
    let rendered = crate::names::render(template, "", None, &t);
    let base = crate::names::number(&rendered, crate::names::taken_in(dir));
    let mut name = base.clone();
    let mut n = 2;
    while dir.join(format!("{name}.mp4")).exists() {
        name = format!("{base} ({n})");
        n += 1;
    }
    name
}

/// The video's filters: the capture (`target`, the pointer or not, at most `fps`), stamped on the
/// wall clock from `clock` (µs since 1970), made a steady `fps` from 0, and converted for the
/// encoder (`pixels`).
///
/// Each frame is stamped by when it was captured (the capture's own stamp, from Windows: its
/// first frame is 0), moved onto the wall clock by where that first frame falls on it. That's
/// each frame's `RTCTIME` (when the filter has it) less its capture stamp, at its least so far
/// (`st`/`ld` keep it from frame to frame): a frame held up before it's taken (ffmpeg waiting on
/// the sound) only says it later. `RTCTIME` alone stamped such frames late: up to ±60 ms off, a
/// camera recorded with it showed (PLAN 5d.3).
fn video_source(target: &Target, video: Video, stamp: Option<i64>, pixels: &str) -> String {
    let stamp = stamp.map_or(String::new(), |us| {
        let captured = "PTS*TB*1000000";
        let start = format!("RTCTIME-{captured}");
        format!(
            "setpts='({captured}+st(0,if(eq(N,0),{start},min(ld(0),{start})))-{us})/1000000/TB',"
        )
    });
    let (fps, cursor) = (video.fps, u8::from(video.cursor));
    format!(
        "gfxcapture={}:max_framerate={fps}:capture_cursor={cursor},{stamp}hwdownload,format=bgra,fps={fps}:start_time=0,scale=out_color_matrix=bt709:out_range=tv,format={pixels}",
        target.source()
    )
}

/// ffmpeg recording `target` with `encoder` to `part`, with sound from `sources`, once it's
/// running; why if it stopped at once.
///
/// With sound, both are on one clock (audio.rs): the frames are stamped by the wall clock as
/// they come, from the moment the sound starts, and the timestamps are kept as they are
/// (`-copyts`: else ffmpeg starts each at 0, and the capture's start-up becomes an offset).
fn spawn(
    target: &Target,
    encoder: Encoder,
    part: &PathBuf,
    sources: &[audio::Source],
    video: Video,
) -> Result<Segment, Failed> {
    let (w, h) = target.size();
    let clock = Clock::now();
    let mut sound = Vec::new();
    for (n, s) in sources.iter().enumerate() {
        match Capture::start(s.clone(), clock) {
            Ok(c) => sound.push(c),
            Err(e) => {
                sound.into_iter().for_each(Capture::stop);
                return Err(Failed::Sound(n, e));
            }
        }
    }
    // Always on the clock, sound or not, so a press's time is the picture's (PLAN 5b.6).
    let stamp = Some(clock.unix_us);
    let mut cmd = sidecar::command(Tool::Ffmpeg).map_err(Failed::Ffmpeg)?;
    cmd.args([
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
    ])
    .arg(video_source(target, video, stamp, encoder.pixels()));
    let inputs: Vec<SoundInput> = sound
        .iter()
        .map(|s| {
            let f = &s.format;
            (f.sample, f.rate, f.channels, s.pipe.as_str())
        })
        .collect();
    cmd.args(sound_args(&inputs));
    cmd.args(encoder.args(bitrate(w, h, f64::from(video.fps))))
        .args([
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-color_range",
            "tv",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ])
        .arg(part)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = match sidecar::spawn(&mut cmd) {
        Ok(c) => c,
        Err(e) => {
            sound.into_iter().for_each(Capture::stop);
            return Err(Failed::Ffmpeg(format!("ffmpeg didn't start: {e}")));
        }
    };
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| Failed::Ffmpeg("no input to ffmpeg".into()))?;
    // Its errors read as they come (a full pipe would stall it).
    let log = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        let log = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut l = log.lock().unwrap();
                l.push(line);
                if l.len() > 20 {
                    l.remove(0);
                }
            }
        });
    }
    let t0 = Instant::now();
    while t0.elapsed() < STARTED {
        if let Ok(Some(status)) = child.try_wait() {
            std::thread::sleep(Duration::from_millis(50));
            let said = log.lock().unwrap().last().cloned().unwrap_or_default();
            sound.into_iter().for_each(Capture::stop);
            return Err(Failed::Ffmpeg(format!("ffmpeg stopped ({status}): {said}")));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(Segment {
        clock,
        child,
        stdin,
        part: part.clone(),
        log,
        sound,
    })
}

/// Ends segment `seg`: its sound first (its pipe closing ends ffmpeg's sound), then `q` its
/// video, unless ffmpeg already stopped (`ended`). Its file if whole, and its span on the clock;
/// else gone.
fn end_segment(mut seg: Segment, ended: bool) -> Option<(PathBuf, (i64, i64))> {
    let span = (seg.clock.qpc, audio::qpc_now());
    seg.sound.into_iter().for_each(Capture::stop);
    if !ended {
        let _ = seg.stdin.write_all(b"q\n");
        let _ = seg.stdin.flush();
    }
    let t0 = Instant::now();
    let status = loop {
        match seg.child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if t0.elapsed() < FINISHING => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = seg.child.kill();
                break None;
            }
        }
    };
    let whole = status.is_some_and(|s| s.success())
        && std::fs::metadata(&seg.part).is_ok_and(|m| m.len() > 0);
    if whole {
        return Some((seg.part, span));
    }
    let said = seg.log.lock().unwrap().last().cloned().unwrap_or_default();
    logln!("[recording] a segment failed ({status:?}): {said}");
    let _ = std::fs::remove_file(&seg.part);
    None
}

/// Waits for a recording to end on its own (ffmpeg failing: a monitor unplugged), and ends it,
/// keeping what was recorded.
fn watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        // Not while a pause, resume or stop is under way: it has the segment.
        let Ok(_switch) = SWITCH.try_lock() else {
            continue;
        };
        let mut now = NOW.lock().unwrap();
        let Some(r) = now.as_mut() else {
            return;
        };
        if let Some(seg) = r.seg.as_mut() {
            if let Ok(Some(_)) = seg.child.try_wait() {
                let r = now.take().unwrap();
                drop(now);
                finish(&app, r, true);
                return;
            }
        }
    });
}

/// Pauses the recording, or resumes it (the control's Pause, or [`PAUSE_KEY`]): the segment
/// ends, and a new one starts on resuming. Says so to the control.
pub fn pause(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _switch = SWITCH.lock().unwrap();
        let mut now = NOW.lock().unwrap();
        let Some(r) = now.as_mut() else {
            return;
        };
        if let Some(seg) = r.seg.take() {
            drop(now);
            let start = seg.clock.unix_us;
            let done = end_segment(seg, false);
            if let (Some(r), Some((part, span))) = (NOW.lock().unwrap().as_mut(), done) {
                r.parts.push(part);
                r.spans.push(span);
                r.starts.push(start);
            }
            logln!("[recording] paused");
            let _ = RecordingPaused(true).emit_to(&app, RECORDER);
            return;
        }
        // Resuming: a new segment, as the first was made.
        let part = segment_path(&r.base, r.parts.len() + 1);
        let (target, encoder, sources, video, muted, system_muted) = (
            r.target.clone(),
            r.encoder,
            r.sources.clone(),
            r.video,
            r.muted,
            r.system_muted,
        );
        drop(now);
        match spawn(&target, encoder, &part, &sources, video) {
            Ok(seg) => {
                set_mutes(&seg, muted, system_muted);
                if let Some(r) = NOW.lock().unwrap().as_mut() {
                    r.seg = Some(seg);
                }
                logln!("[recording] resumed");
                let _ = RecordingPaused(false).emit_to(&app, RECORDER);
            }
            Err(Failed::Sound(_, e) | Failed::Ffmpeg(e)) => {
                logln!("[recording] couldn't resume: {e}");
                let _ = std::fs::remove_file(&part);
                let _ = RecordingPaused(true).emit_to(&app, RECORDER);
            }
        }
    });
}

/// Stops the recording (the control's Stop, [`STOP_KEY`], or the editor's): its file finished and
/// opened. While it starts, it's remembered (in the countdown, it cancels).
pub fn stop(app: &AppHandle) {
    {
        let starting = STARTING.lock().unwrap();
        if NOW.lock().unwrap().is_none() {
            if *starting {
                *STOP_ASKED.lock().unwrap() = true;
            }
            return;
        }
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let _switch = SWITCH.lock().unwrap();
        let Some(r) = NOW.lock().unwrap().take() else {
            return;
        };
        finish(&app, r, false);
    });
}

/// Ends recording `r`: its segment finished (unless ffmpeg already stopped, `ended`), the
/// segments joined into its file, opened; or says why there isn't one.
fn finish(app: &AppHandle, mut r: Running, ended: bool) {
    close_control(app);
    hold_keys(app, false, false, false);
    // Where the bubble was left, before it goes.
    let circle = crate::camera::bubble_circle(app);
    if let Some(seg) = r.seg.take() {
        let start = seg.clock.unix_us;
        let done = end_segment(seg, ended);
        if ended && done.is_some() && !r.parts.is_empty() {
            r.warning = Some("The recording stopped on its own: what was recorded is kept.".into());
        }
        if let Some((part, span)) = done {
            r.parts.push(part);
            r.spans.push(span);
            r.starts.push(start);
        }
    }
    let take = crate::camera::stop_recording(app).filter(|_| r.camera);
    // Each part's length, read before they're joined, for the camera.
    let fps = f64::from(r.video.fps);
    let lengths: Vec<f64> = r
        .parts
        .iter()
        .map(|p| crate::media::mp4::read(p).map_or(0.0, |i| i.video.len() as f64 / fps))
        .collect();
    // The clicks, on the recording (5b.6b makes markup of them).
    let presses = r.input.take().map(input::Watch::stop).unwrap_or_default();
    let mut noted = recorded(presses, &r.spans, &r.target);
    if !noted.clicks.is_empty() {
        logln!("[recording] {} clicks noted", noted.clicks.len());
    }
    show_editor(app);
    let joined = match r.parts.len() {
        0 => Err(if ended {
            "The recording stopped on its own, and couldn't be kept.".to_string()
        } else {
            "The recording couldn't be finished.".to_string()
        }),
        1 => std::fs::rename(&r.parts[0], &r.file).map_err(|e| e.to_string()),
        _ => join(&r.parts, &r.base, &r.file),
    };
    match joined {
        Ok(()) => {
            logln!("[recording] done ({} segments)", r.parts.len().max(1));
            for p in &r.parts {
                let _ = std::fs::remove_file(p);
            }
            let _ = RecordingChanged {
                recording: false,
                message: r.warning.take(),
            }
            .emit_to(app, LABEL);
            if let Some(take) = take {
                let file = camera_file(&r.file);
                let parts: Vec<(i64, f64)> = r.starts.iter().copied().zip(lengths).collect();
                let (x, y, _, _) = r.target.on_screen();
                let s = &r.target.screen;
                let origin = (f64::from(s.x + x), f64::from(s.y + y));
                let (w, h) = r.target.size();
                let (x, y, size) = circle.map_or((0.0, 0.0, 0.0), |c| {
                    crate::camera::on_picture(c, origin, (f64::from(w), f64::from(h)))
                });
                noted.camera = Some(RecordedCamera {
                    file: file.to_string_lossy().into_owned(),
                    x,
                    y,
                    size,
                });
                fit_camera(take, parts, r.encoder, file);
            }
            if !noted.clicks.is_empty() || noted.camera.is_some() {
                NOTED.lock().unwrap().push((r.file.clone(), noted));
            }
            crate::editor::request_open(app, r.file, r.add);
        }
        Err(message) => {
            logln!("[recording] failed: {message}");
            let _ = RecordingChanged {
                recording: false,
                message: Some(message),
            }
            .emit_to(app, LABEL);
        }
    }
}

/// Where the camera's recorded while recording to `base`.
fn camera_take(base: &std::path::Path) -> PathBuf {
    let mut name = base.as_os_str().to_owned();
    name.push(".camera.mkv");
    PathBuf::from(name)
}

/// The camera's file beside the recording `file`: "Recording 2026-10-27 10-00-00 (camera).mp4".
fn camera_file(file: &std::path::Path) -> PathBuf {
    let stem = file.file_stem().unwrap_or_default().to_string_lossy();
    file.with_file_name(format!("{stem} (camera).mp4"))
}

/// Fits the camera's take to the recording's `parts` (each's start and length), into `file`, in
/// the background: the recording opens meanwhile. If it fails, the take is kept.
fn fit_camera(take: crate::camera::Take, parts: Vec<(i64, f64)>, encoder: Encoder, file: PathBuf) {
    std::thread::spawn(move || {
        let t0 = Instant::now();
        match crate::camera::fit(&take, &parts, encoder, &file) {
            Ok(()) => logln!(
                "[recording] the camera fitted in {:.1} s: {}",
                t0.elapsed().as_secs_f64(),
                file.display()
            ),
            Err(e) => logln!(
                "[recording] the camera couldn't be fitted ({} is kept): {e}",
                take.path.display()
            ),
        }
    });
}

/// A recording that didn't start: the camera's stopped, and anything it took deleted.
fn drop_camera(app: &AppHandle) {
    if let Some(take) = crate::camera::stop_recording(app) {
        let _ = std::fs::remove_file(take.path);
    }
}

/// The concat demuxer's list of `parts`, in order (forward slashes; quotes escaped as it asks).
fn concat_list(parts: &[PathBuf]) -> String {
    parts
        .iter()
        .map(|p| {
            let path = p
                .to_string_lossy()
                .replace('\\', "/")
                .replace('\'', r"'\''");
            format!("file '{path}'\n")
        })
        .collect()
}

/// Joins the segments into `file`, as they are (the same encoder and settings: no re-encoding).
/// The segments are kept if it fails, so nothing's lost.
fn join(parts: &[PathBuf], base: &std::path::Path, file: &PathBuf) -> Result<(), String> {
    let mut list = base.as_os_str().to_owned();
    list.push(".parts.txt");
    let list = PathBuf::from(list);
    std::fs::write(&list, concat_list(parts)).map_err(|e| e.to_string())?;
    let mut cmd = sidecar::command(Tool::Ffmpeg)?;
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
    ])
    .arg(&list)
    .args(["-c", "copy", "-movflags", "+faststart", "-f", "mp4"])
    .arg(file);
    let out = cmd.output().map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&list);
    match out {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(format!(
            "The recording's {} parts couldn't be joined (they're kept in the recordings folder): {}",
            parts.len(),
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Err(e) => Err(e),
    }
}

/// The control: a small window at the top of `screen`, over everything, not in the taskbar, and
/// left out of the recording.
fn open_control(
    app: &AppHandle,
    screen: &Screen,
    mic: bool,
    system: bool,
    countdown: u32,
    clicks: bool,
) {
    let buttons = u8::from(mic) + u8::from(system);
    let width = CONTROL.0 + f64::from(buttons) * CONTROL_MIC;
    let builder = WebviewWindowBuilder::new(app, RECORDER, WebviewUrl::App("recorder.html".into()))
        // The microphone's and the system sound's mute buttons, when they're recorded; the
        // countdown it shows first; the clicks noted at the start.
        .initialization_script(format!(
            "window.recordingMic = {mic}; window.recordingSystem = {system}; \
             window.recordingCountdown = {countdown}; window.recordingClicks = {clicks};"
        ));
    let built = crate::appearance::themed(app, builder)
        .title("Recording")
        .inner_size(width, CONTROL.1)
        .decorations(false)
        // With a shadow, resizing a window with no frame adds the frame's size back.
        .shadow(false)
        // See-through, so the bar's corners are rounded (RecorderApp.module.css).
        .transparent(true)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build();
    match built {
        Ok(window) => {
            exclude_from_capture(&window);
            crate::webview_crash::watch(&window);
            // Placed in physical pixels on its monitor, then sized there (its scale).
            let wide = (width * screen.scale).round() as i32;
            let x = screen.x + (screen.width as i32 - wide) / 2;
            let y = screen.y + (CONTROL_TOP * screen.scale).round() as i32;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            let _ = window.set_size(tauri::LogicalSize::new(width, CONTROL.1));
            let _ = window.show();
        }
        Err(e) => logln!("[recording] the control failed: {e}"),
    }
}

/// The marks round `area` (the monitor's physical pixels), if one's recorded, and the clicks
/// shown live, over all of `screen`, as Settings › Recording has them: transparent, over
/// everything, clicks through to what's under it, and left out of the recording.
fn open_outline(
    app: &AppHandle,
    screen: &Screen,
    area: Option<(u32, u32, u32, u32)>,
    marks: &crate::settings::Recording,
) {
    let corners = if marks.corners {
        format!("{:?}", marks.corner_color)
    } else {
        "null".into()
    };
    let dim = if marks.dim { marks.dim_opacity } else { 0.0 };
    let mut script = String::new();
    if let Some((x, y, width, height)) = area {
        script += &format!(
            "window.recordingArea = {{ x: {x}, y: {y}, width: {width}, height: {height} }};\
             window.recordingMarks = {{ corners: {corners}, dim: {dim} }};"
        );
    }
    // How clicks look: Settings › Recording's, whose click fields the page takes.
    if marks.live_clicks {
        if let Ok(json) = serde_json::to_string(marks) {
            script += &format!("window.liveClickStyle = {json};");
        }
    }
    let built =
        WebviewWindowBuilder::new(app, OUTLINE_LABEL, WebviewUrl::App("outline.html".into()))
            .initialization_script(script)
            .title("Recording area")
            .decorations(false)
            .resizable(false)
            .shadow(false)
            .transparent(true)
            .background_color(tauri::webview::Color(0, 0, 0, 0))
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .build();
    match built {
        Ok(window) => {
            exclude_from_capture(&window);
            let _ = window.set_ignore_cursor_events(true);
            // Position first, then size: moving onto a monitor of another scale rescales it.
            let _ = window.set_position(tauri::PhysicalPosition::new(screen.x, screen.y));
            let _ = window.set_size(tauri::PhysicalSize::new(screen.width, screen.height));
            let _ = window.show();
        }
        Err(e) => logln!("[recording] the outline failed: {e}"),
    }
}

/// The countdown: big numbers over what's to be recorded, on all of its monitor, never taking
/// the keys (the window picked stays active) or the pointer, and left out of the recording.
fn open_countdown(app: &AppHandle, target: &Target, seconds: u32) {
    let s = &target.screen;
    let (x, y, w, h) = target.on_screen();
    let built = WebviewWindowBuilder::new(
        app,
        COUNTDOWN_LABEL,
        WebviewUrl::App("countdown.html".into()),
    )
    .initialization_script(format!(
        "window.countdown = {{ seconds: {seconds}, x: {x}, y: {y}, width: {w}, height: {h} }};"
    ))
    .title("Countdown")
    .decorations(false)
    .resizable(false)
    .shadow(false)
    .transparent(true)
    .background_color(tauri::webview::Color(0, 0, 0, 0))
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .build();
    match built {
        Ok(window) => {
            exclude_from_capture(&window);
            let _ = window.set_ignore_cursor_events(true);
            let _ = window.set_position(tauri::PhysicalPosition::new(s.x, s.y));
            let _ = window.set_size(tauri::PhysicalSize::new(s.width, s.height));
            let _ = window.show();
        }
        Err(e) => logln!("[recording] the countdown failed: {e}"),
    }
}

fn close_countdown(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(COUNTDOWN_LABEL) {
        let _ = w.destroy();
    }
}

/// Leaves `window` out of screen captures (Windows 10 2004 and later; earlier, it shows black).
pub fn exclude_from_capture(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };
    if let Ok(hwnd) = window.hwnd() {
        if let Err(e) = unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) } {
            logln!(
                "[recording] {} may show in the recording: {e}",
                window.label()
            );
        }
    }
}

/// Clicks shown live (PLAN 5b.6f): to the hook, while recording.
static LIVE: Mutex<Option<Sender<Press>>> = Mutex::new(None);

/// Shows each click noted (the hook's, through `rx`) in the outline window as it's made, if it's
/// on what's recorded and the recording isn't paused: where it is on the monitor (physical px),
/// its button, and whether it's a double-click (the same `id` again as it becomes one). Till the
/// hook and the recording are done with it.
fn show_live(app: AppHandle, target: Target, rx: Receiver<Press>) {
    std::thread::spawn(move || {
        for press in rx {
            let Press::Click {
                qpc,
                x,
                y,
                button,
                double,
                window,
            } = press;
            let paused = NOW
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|r| r.seg.is_none());
            if paused || target.on_picture(x, y, window).is_none() {
                continue;
            }
            let (Some(outline), Ok(button)) = (
                app.get_webview_window(OUTLINE_LABEL),
                serde_json::to_string(&button),
            ) else {
                continue;
            };
            let (x, y) = (x - target.screen.x, y - target.screen.y);
            let _ = outline.eval(format!(
                "window.liveClick?.({{ id: {qpc}, x: {x}, y: {y}, button: {button}, double: {double} }})"
            ));
        }
    });
}

/// The control, the outline and the countdown go (and the clicks shown live with them).
fn close_control(app: &AppHandle) {
    LIVE.lock().unwrap().take();
    for label in [RECORDER, OUTLINE_LABEL, COUNTDOWN_LABEL] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
}

pub fn show_editor(app: &AppHandle) {
    crate::editor::show_window(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen() -> Screen {
        Screen {
            hmonitor: 7,
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.25,
        }
    }

    #[test]
    fn a_whole_screen_is_cropped_to_nothing() {
        let t = Target::of(screen(), None);
        assert_eq!(t.size(), (1920, 1080));
        assert_eq!(
            t.source(),
            "hmonitor=7:crop_left=0:crop_top=0:crop_right=0:crop_bottom=0"
        );
    }

    #[test]
    fn an_area_is_cropped_on_the_gpu_its_sides_even() {
        let t = Target::of(screen(), Some((100, 50, 801, 601)));
        assert_eq!(t.size(), (800, 600));
        assert_eq!(
            t.source(),
            "hmonitor=7:crop_left=100:crop_top=50:crop_right=1020:crop_bottom=430"
        );
    }

    #[test]
    fn an_area_stays_on_the_screen_and_isnt_too_small() {
        let t = Target::of(screen(), Some((1915, 1078, 3, 1)));
        assert_eq!(t.area, Some((1904, 1064, 16, 16)));
        let t = Target::of(screen(), Some((10, 10, 5000, 5000)));
        assert_eq!(t.size(), (1910, 1070));
    }

    #[test]
    fn a_window_is_recorded_by_its_handle_its_sides_even() {
        let t = Target::window(screen(), 0x1234, (-1800, 40, 1001, 7));
        assert_eq!(t.size(), (1000, 16));
        // Its place on the monitor at -1920: the countdown's.
        assert_eq!(t.on_screen(), (120, 40, 1001, 16));
        assert_eq!(
            t.source(),
            "hwnd=4660:width=-2:height=-2:resize_mode=scale_aspect"
        );
    }

    #[test]
    fn a_press_falls_where_it_was_in_the_joined_recording() {
        // Two segments: 0-2 s and, after a pause, 5-6 s on the clock.
        let spans = [(0, 20_000_000), (50_000_000, 60_000_000)];
        assert_eq!(recording_time(&spans, 10_000_000), Some(1.0));
        assert_eq!(recording_time(&spans, 30_000_000), None);
        assert_eq!(recording_time(&spans, 55_000_000), Some(2.5));
        assert_eq!(recording_time(&spans, 60_000_000), None);
    }

    #[test]
    fn a_click_lands_on_the_picture_or_is_dropped() {
        // The screen at x -1920; an area at (100, 50), 800 × 600.
        let area = Target::of(screen(), Some((100, 50, 800, 600)));
        assert_eq!(area.on_picture(-1920 + 150, 60, None), Some((50.0, 10.0)));
        assert_eq!(area.on_picture(-1920 + 99, 60, None), None);
        let whole = Target::of(screen(), None);
        assert_eq!(whole.on_picture(-1, 1079, None), Some((1919.0, 1079.0)));
        // A window picked 1000 × 600, now 500 × 600: fitted, centred (k = 1).
        let w = Target::window(screen(), 1, (0, 0, 1000, 600));
        assert_eq!(
            w.on_picture(260, 100, Some((250, 0, 500, 600))),
            Some((260.0, 100.0))
        );
        // Twice as big now: halved.
        assert_eq!(
            w.on_picture(400, 200, Some((0, 0, 2000, 1200))),
            Some((200.0, 100.0))
        );
        assert_eq!(w.on_picture(400, 200, None), None);
    }

    #[test]
    fn presses_in_a_pause_or_off_the_picture_are_left_out() {
        let t = Target::of(screen(), None);
        let spans = [(0, 20_000_000)];
        let presses = vec![
            Press::Click {
                qpc: 5_000_000,
                x: -1900,
                y: 20,
                button: input::Button::Left,
                double: false,
                window: None,
            },
            Press::Click {
                qpc: 5_000_000,
                x: 100,
                y: 20,
                button: input::Button::Left,
                double: false,
                window: None,
            },
            Press::Click {
                qpc: 30_000_000,
                x: 100,
                y: 20,
                button: input::Button::Left,
                double: false,
                window: None,
            },
        ];
        let r = recorded(presses, &spans, &t);
        assert_eq!(r.clicks.len(), 1);
        assert_eq!((r.clicks[0].x, r.clicks[0].time), (20.0, 0.5));
    }

    #[test]
    fn the_countdown_goes_over_the_area_or_the_whole_screen() {
        let t = Target::of(screen(), Some((100, 50, 800, 600)));
        assert_eq!(t.on_screen(), (100, 50, 800, 600));
        assert_eq!(Target::of(screen(), None).on_screen(), (0, 0, 1920, 1080));
    }

    #[test]
    fn the_video_takes_the_rate_and_the_pointer_asked_for() {
        let t = Target::of(screen(), None);
        let v = video_source(
            &t,
            Video {
                fps: 30,
                cursor: false,
            },
            None,
            "nv12",
        );
        assert!(v.contains(":max_framerate=30:capture_cursor=0,hwdownload"));
        assert!(v.contains("fps=30:start_time=0") && v.ends_with("format=nv12"));
        let v = video_source(
            &t,
            Video {
                fps: 60,
                cursor: true,
            },
            Some(1234),
            "nv12",
        );
        // Stamped by when each frame was captured, on the wall clock.
        assert!(v.contains(
            ":capture_cursor=1,setpts='(PTS*TB*1000000+st(0,if(eq(N,0),RTCTIME-PTS*TB*1000000,\
             min(ld(0),RTCTIME-PTS*TB*1000000)))-1234)/1000000/TB',hwdownload"
        ));
    }

    #[test]
    fn the_segments_are_listed_for_joining() {
        let parts = [
            PathBuf::from(r"C:\Rec\Recording 1.0.part"),
            PathBuf::from(r"C:\Rec\Bob's.1.part"),
        ];
        assert_eq!(
            concat_list(&parts),
            "file 'C:/Rec/Recording 1.0.part'\nfile 'C:/Rec/Bob'\\''s.1.part'\n"
        );
        assert_eq!(
            segment_path(std::path::Path::new(r"C:\Rec\Recording"), 2),
            PathBuf::from(r"C:\Rec\Recording.2.part")
        );
    }

    #[test]
    fn one_sound_is_mapped_and_two_are_mixed() {
        assert_eq!(sound_args(&[]), ["-copyts"]);
        let one = sound_args(&[("f32le", 48000, 2, "P1")]).join(" ");
        assert!(one.contains("-f f32le -ar 48000 -ac 2 -i P1"));
        assert!(one.contains("-copyts -map 0:v -map 1:a -c:a aac"));
        let two = sound_args(&[("f32le", 48000, 1, "P1"), ("s16le", 44100, 2, "P2")]).join(" ");
        assert!(two.contains("-i P1") && two.contains("-f s16le -ar 44100 -ac 2 -i P2"));
        assert!(two.contains(
            "[1:a]aresample=48000,aformat=channel_layouts=stereo[s1];[2:a]aresample=48000,aformat=channel_layouts=stereo[s2];[s1][s2]amix=inputs=2:duration=longest:normalize=0[sound]"
        ));
        assert!(two.contains("-map 0:v -filter_complex") && two.contains("-map [sound] -c:a aac"));
    }

    #[test]
    fn a_screen_has_its_points() {
        let s = screen();
        assert!(s.contains(-1920, 0) && s.contains(-1, 1079));
        assert!(!s.contains(0, 0) && !s.contains(-1, 1080));
    }
}
