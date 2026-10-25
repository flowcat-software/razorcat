//! Screen recording (PLAN 5b.2): the monitor the editor is on, recorded by the bundled ffmpeg's
//! `gfxcapture` (Windows.Graphics.Capture, on the GPU; spike 5b.1), into the recordings folder,
//! then opened (or added to the timeline).
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

/// Starts recording the monitor the editor is on, on a thread; `add` puts it on the end of the
/// timeline when done, else it replaces it. Says how it went with [`RecordingChanged`].
pub fn start(app: &AppHandle, add: bool) -> Result<(), String> {
    {
        let mut starting = STARTING.lock().unwrap();
        if *starting || NOW.lock().unwrap().is_some() {
            return Err("A recording is under way.".into());
        }
        *starting = true;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let started = begin(&app, add);
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

/// Puts the editor aside, the control up, and ffmpeg recording.
fn begin(app: &AppHandle, add: bool) -> Result<(), String> {
    let editor = app
        .get_webview_window(LABEL)
        .ok_or("the editor isn't open")?;
    let monitor = editor
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("no monitor")?;
    let hmonitor = monitor_of(&editor)?;
    let dir = folder(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    let name = file_name(&dir);
    let file = dir.join(format!("{name}.mp4"));
    let part = dir.join(format!("{name}.part"));

    let _ = editor.minimize();
    open_control(app, &monitor);
    // The editor's minimizing animation out of the way before the first frame.
    std::thread::sleep(Duration::from_millis(250));

    let (w, h) = (monitor.size().width, monitor.size().height);
    let mut why = String::from("no encoder worked");
    for encoder in encoders(app) {
        match spawn(hmonitor, encoder, w, h, &part) {
            Ok(running) => {
                logln!("[recording] {}×{} with {encoder:?}", w, h);
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

/// The monitor `window` is on, as Windows names it (`HMONITOR`, for `gfxcapture`).
fn monitor_of(window: &tauri::WebviewWindow) -> Result<u64, String> {
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONEAREST};
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let m = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if m.is_invalid() {
        return Err("no monitor".into());
    }
    Ok(m.0 as u64)
}

/// ffmpeg recording monitor `hmonitor` (`w` × `h` px) with `encoder` to `part`, once it's
/// running; its error if it stopped at once.
fn spawn(
    hmonitor: u64,
    encoder: Encoder,
    w: u32,
    h: u32,
    part: &PathBuf,
) -> Result<Running, String> {
    let mut cmd = sidecar::command(Tool::Ffmpeg)?;
    cmd.args(["-hide_banner", "-nostats", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!(
            "gfxcapture=hmonitor={hmonitor}:max_framerate={FPS}:capture_cursor=1,hwdownload,format=bgra,fps={FPS}:start_time=0,scale=out_color_matrix=bt709:out_range=tv,format={}",
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

/// The control: a small window at the top of `monitor`, over everything, not in the taskbar, and
/// left out of the recording.
fn open_control(app: &AppHandle, monitor: &tauri::Monitor) {
    let scale = monitor.scale_factor();
    let pos = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    let builder = WebviewWindowBuilder::new(app, RECORDER, WebviewUrl::App("recorder.html".into()));
    let built = crate::appearance::themed(app, builder)
        .title("Recording")
        .inner_size(CONTROL.0, CONTROL.1)
        .position(pos.x + (size.width - CONTROL.0) / 2.0, pos.y + CONTROL_TOP)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .build();
    match built {
        Ok(window) => {
            exclude_from_capture(&window);
            crate::webview_crash::watch(&window);
        }
        Err(e) => logln!("[recording] the control failed: {e}"),
    }
}

/// Leaves `window` out of screen captures (Windows 10 2004 and later; earlier, it shows black).
fn exclude_from_capture(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };
    if let Ok(hwnd) = window.hwnd() {
        if let Err(e) = unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) } {
            logln!("[recording] the control may show in the recording: {e}");
        }
    }
}

fn close_control(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(RECORDER) {
        let _ = w.destroy();
    }
}

fn show_editor(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
