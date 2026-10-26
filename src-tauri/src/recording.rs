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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_specta::Event;

use crate::editor::LABEL;
use crate::export::{bitrate, encoders, Encoder};
use crate::sidecar::{self, Tool};
use crate::state::AppState;

/// The control's window.
pub const RECORDER: &str = "recorder";
/// The marks round an area being recorded (PLAN 5b.3c; outline.html): its corners, the rest of
/// its monitor dimmed.
const OUTLINE_LABEL: &str = "recording-outline";
/// The recording's frame rate (5b.5 makes it a choice).
const FPS: u32 = 60;
/// The control's size (logical px) and its gap from the monitor's top.
const CONTROL: (f64, f64) = (196.0, 44.0);
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

struct Running {
    child: Child,
    stdin: ChildStdin,
    part: PathBuf,
    file: PathBuf,
    /// Added to the timeline when done (else it replaces it).
    add: bool,
    log: Arc<Mutex<Vec<String>>>,
}

static NOW: Mutex<Option<Running>> = Mutex::new(None);
/// Set while a recording starts (before it's `NOW`), so a second can't.
static STARTING: Mutex<bool> = Mutex::new(false);

/// Where recordings go: Settings › Recording › Folder, else the default.
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
        }
    }

    /// Window `hwnd`, `width` × `height` when picked, on `screen` (or mostly).
    pub fn window(screen: Screen, hwnd: u64, width: u32, height: u32) -> Self {
        Self {
            screen,
            area: None,
            window: Some((hwnd, width.max(MIN_SIDE), height.max(MIN_SIDE))),
        }
    }

    /// The picture's size.
    fn size(&self) -> (u32, u32) {
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
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let started = begin(&app, add, &target);
        *STARTING.lock().unwrap() = false;
        match started {
            Ok(()) => {
                let _ = RecordingChanged {
                    recording: true,
                    message: None,
                }
                .emit_to(&app, LABEL);
                watch(app);
            }
            Err(message) => {
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

/// Puts the control up, and ffmpeg recording (the editor is aside already).
fn begin(app: &AppHandle, add: bool, target: &Target) -> Result<(), String> {
    let dir = folder(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    let name = file_name(&dir);
    let file = dir.join(format!("{name}.mp4"));
    let part = dir.join(format!("{name}.part"));

    if let Some(editor) = app.get_webview_window(LABEL) {
        let _ = editor.minimize();
    }
    // The marks first: the control is shown after, so it's in front of their dimming.
    if let Some(area) = target.area {
        let marks = app
            .state::<AppState>()
            .settings
            .read()
            .unwrap()
            .recording
            .clone();
        if marks.corners || marks.dim {
            open_outline(app, &target.screen, area, &marks);
        }
    }
    open_control(app, &target.screen);
    // The overlays and the editor out of the way before the first frame.
    std::thread::sleep(Duration::from_millis(250));

    let (w, h) = target.size();
    let mut why = String::from("no encoder worked");
    for encoder in encoders(app) {
        match spawn(target, encoder, &part) {
            Ok(running) => {
                logln!("[recording] {w}×{h} with {encoder:?}");
                *NOW.lock().unwrap() = Some(Running {
                    file,
                    add,
                    ..running
                });
                return Ok(());
            }
            Err(e) => {
                logln!("[recording] {encoder:?} didn't start: {e}");
                why = e;
            }
        }
    }
    let _ = std::fs::remove_file(&part);
    Err(why)
}

/// The file's name: "Recording 2026-10-25 14-03-22", a number added if it's taken.
fn file_name(dir: &std::path::Path) -> String {
    let t = crate::names::Timestamp::now_local();
    let base = crate::names::render("Recording {yyyy}-{MM}-{dd} {HH}-{mm}-{ss}", "", None, &t);
    let mut name = base.clone();
    let mut n = 2;
    while dir.join(format!("{name}.mp4")).exists() {
        name = format!("{base} ({n})");
        n += 1;
    }
    name
}

/// ffmpeg recording `target` with `encoder` to `part`, once it's running; its error if it
/// stopped at once.
fn spawn(target: &Target, encoder: Encoder, part: &PathBuf) -> Result<Running, String> {
    let (w, h) = target.size();
    let mut cmd = sidecar::command(Tool::Ffmpeg)?;
    cmd.args(["-hide_banner", "-nostats", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!(
            "gfxcapture={}:max_framerate={FPS}:capture_cursor=1,hwdownload,format=bgra,fps={FPS}:start_time=0,scale=out_color_matrix=bt709:out_range=tv,format={}",
            target.source(),
            encoder.pixels()
        ))
        .args(encoder.args(bitrate(w, h, f64::from(FPS))))
        .args([
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-color_range", "tv", "-movflags", "+faststart", "-f", "mp4",
        ])
        .arg(part)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = sidecar::spawn(&mut cmd).map_err(|e| format!("ffmpeg didn't start: {e}"))?;
    let stdin = child.stdin.take().ok_or("no input to ffmpeg")?;
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
            return Err(format!("ffmpeg stopped ({status}): {said}"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(Running {
        child,
        stdin,
        part: part.clone(),
        file: PathBuf::new(),
        add: false,
        log,
    })
}

/// Waits for a recording to end on its own (ffmpeg failing: a monitor unplugged), and ends it.
fn watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let mut now = NOW.lock().unwrap();
        let Some(r) = now.as_mut() else {
            return;
        };
        if let Ok(Some(_)) = r.child.try_wait() {
            let r = now.take().unwrap();
            drop(now);
            finish(&app, r, true);
            return;
        }
    });
}

/// Stops the recording (the control's Stop, or the editor's): its file finished and opened.
pub fn stop(app: &AppHandle) {
    let Some(r) = NOW.lock().unwrap().take() else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || finish(&app, r, false));
}

/// Ends recording `r`: asks ffmpeg to finish (unless it already has, `ended`), then opens the
/// file, or says why there isn't one.
fn finish(app: &AppHandle, mut r: Running, ended: bool) {
    close_control(app);
    if !ended {
        let _ = r.stdin.write_all(b"q\n");
        let _ = r.stdin.flush();
    }
    let t0 = Instant::now();
    let status = loop {
        match r.child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if t0.elapsed() < FINISHING => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = r.child.kill();
                break None;
            }
        }
    };
    show_editor(app);
    let whole = status.is_some_and(|s| s.success())
        && std::fs::metadata(&r.part).is_ok_and(|m| m.len() > 0)
        && std::fs::rename(&r.part, &r.file).is_ok();
    if whole {
        logln!("[recording] done");
        let _ = RecordingChanged {
            recording: false,
            message: None,
        }
        .emit_to(app, LABEL);
        crate::editor::request_open(app, r.file, r.add);
        return;
    }
    let said = r.log.lock().unwrap().last().cloned().unwrap_or_default();
    logln!("[recording] failed ({status:?}): {said}");
    let _ = std::fs::remove_file(&r.part);
    let _ = RecordingChanged {
        recording: false,
        message: Some(if ended {
            "The recording stopped on its own, and couldn't be kept.".into()
        } else {
            "The recording couldn't be finished.".into()
        }),
    }
    .emit_to(app, LABEL);
}

/// The control: a small window at the top of `screen`, over everything, not in the taskbar, and
/// left out of the recording.
fn open_control(app: &AppHandle, screen: &Screen) {
    let builder = WebviewWindowBuilder::new(app, RECORDER, WebviewUrl::App("recorder.html".into()));
    let built = crate::appearance::themed(app, builder)
        .title("Recording")
        .inner_size(CONTROL.0, CONTROL.1)
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
            let width = (CONTROL.0 * screen.scale).round() as i32;
            let x = screen.x + (screen.width as i32 - width) / 2;
            let y = screen.y + (CONTROL_TOP * screen.scale).round() as i32;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            let _ = window.set_size(tauri::LogicalSize::new(CONTROL.0, CONTROL.1));
            let _ = window.show();
        }
        Err(e) => logln!("[recording] the control failed: {e}"),
    }
}

/// The marks round `area` (the monitor's physical pixels), over all of `screen`, as Settings ›
/// Recording has them: transparent, over everything, clicks through to what's under it, and left
/// out of the recording.
fn open_outline(
    app: &AppHandle,
    screen: &Screen,
    (x, y, width, height): (u32, u32, u32, u32),
    marks: &crate::settings::Recording,
) {
    let corners = if marks.corners {
        format!("{:?}", marks.corner_color)
    } else {
        "null".into()
    };
    let dim = if marks.dim { marks.dim_opacity } else { 0.0 };
    let built =
        WebviewWindowBuilder::new(app, OUTLINE_LABEL, WebviewUrl::App("outline.html".into()))
            .initialization_script(format!(
                "window.recordingArea = {{ x: {x}, y: {y}, width: {width}, height: {height} }};\
                 window.recordingMarks = {{ corners: {corners}, dim: {dim} }};"
            ))
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

/// Leaves `window` out of screen captures (Windows 10 2004 and later; earlier, it shows black).
fn exclude_from_capture(window: &tauri::WebviewWindow) {
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

/// The control and the outline go.
fn close_control(app: &AppHandle) {
    for label in [RECORDER, OUTLINE_LABEL] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
}

pub fn show_editor(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
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
        let t = Target::window(screen(), 0x1234, 1001, 7);
        assert_eq!(t.size(), (1000, 16));
        assert_eq!(
            t.source(),
            "hwnd=4660:width=-2:height=-2:resize_mode=scale_aspect"
        );
    }

    #[test]
    fn a_screen_has_its_points() {
        let s = screen();
        assert!(s.contains(-1920, 0) && s.contains(-1, 1079));
        assert!(!s.contains(0, 0) && !s.contains(-1, 1080));
    }
}
