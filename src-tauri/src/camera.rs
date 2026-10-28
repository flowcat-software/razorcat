//! The camera (PLAN 5d): the cameras connected, as ffmpeg's DirectShow lists them; the mode
//! each is opened at; and the bubble (5d.2), a small round window showing it while what to
//! record is picked, dragged anywhere, left out of the recording.
//!
//! A camera opens to one program at a time (spike 5d.1), so the page never opens it: ffmpeg
//! does, and sends a small preview (JPEGs on its stdout), which the bubble reads from
//! `media://bubble/{after}` (protocol.rs). While recording (5d.3), the same ffmpeg records the
//! camera too, each frame stamped by the wall clock as the screen's are; at Stop, its file is
//! fitted to the recording (`fit`): its delay taken off, the pauses cut as the screen's were, a
//! steady 30 fps from the recording's first frame. So the camera's time is the recording's.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::export::{bitrate, Encoder};
use crate::recording::Screen;
use crate::sidecar::{self, Tool};

pub const BUBBLE: &str = "camera";
/// The bubble's window, CSS px square, and its gap from the monitor's corner.
const BUBBLE_SIZE: f64 = 200.0;
const BUBBLE_MARGIN: f64 = 32.0;
/// The circle's gap from the window's edge, CSS px (camera.css: room for its shadow).
const BUBBLE_INSET: f64 = 8.0;
/// The preview: a square this many pixels across, at this rate.
const PREVIEW_SIDE: u32 = 320;
const PREVIEW_FPS: u32 = 15;
/// The tallest picture a camera is opened at, and the rate wanted.
const MAX_HEIGHT: u32 = 1080;
const FPS: f64 = 30.0;
/// How far the camera's frames trail what they show (spike 5d.1: 70 to 90 ms behind the
/// screen's), taken off its stamps to line it up.
const DELAY: f64 = 0.08;
/// How long a recording's ffmpeg has to finish its file once asked.
const FINISHING: Duration = Duration::from_secs(10);

/// A camera connected: its name, as Windows shows it (what Settings keeps), and DirectShow's
/// name for its device, which ffmpeg opens.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct Camera {
    pub name: String,
    #[serde(skip)]
    device: String,
}

/// The cameras connected now.
pub fn cameras() -> Vec<Camera> {
    let out = sidecar::command(Tool::Ffmpeg).and_then(|mut c| {
        c.args([
            "-hide_banner",
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
        ])
        .output()
        .map_err(|e| e.to_string())
    });
    match out {
        Ok(out) => parse_cameras(&String::from_utf8_lossy(&out.stderr)),
        Err(e) => {
            logln!("[camera] couldn't list the cameras: {e}");
            Vec::new()
        }
    }
}

/// The video devices in ffmpeg's list: a `"Name" (video)` line, then its `Alternative name`.
fn parse_cameras(text: &str) -> Vec<Camera> {
    let mut found = Vec::new();
    let mut video = false;
    for line in text.lines() {
        let said = line.split_once("] ").map_or(line, |(_, rest)| rest).trim();
        if let Some(rest) = said.strip_prefix('"') {
            video = false;
            if let Some(name) = rest.strip_suffix("\" (video)") {
                video = true;
                found.push(Camera {
                    name: name.to_string(),
                    device: name.to_string(),
                });
            }
        } else if let Some(alt) = said.strip_prefix("Alternative name \"") {
            if let (true, Some(camera)) = (video, found.last_mut()) {
                camera.device = alt.trim_end_matches('"').to_string();
            }
            video = false;
        }
    }
    found
}

/// How a camera sends its pictures: raw, in a pixel format, or as JPEGs.
#[derive(Debug, Clone, PartialEq)]
enum Format {
    Pixels(String),
    Mjpeg,
}

/// One of a camera's modes: a format at a size, between two rates.
#[derive(Debug, Clone, PartialEq)]
struct Mode {
    format: Format,
    width: u32,
    height: u32,
    min_fps: f64,
    max_fps: f64,
}

/// The modes in ffmpeg's `-list_options` for a camera: `pixel_format=nv12  min s=640x480 fps=5
/// max s=640x480 fps=30` (other codecs, e.g. H.264, aren't taken).
fn parse_modes(text: &str) -> Vec<Mode> {
    let mut modes: Vec<Mode> = Vec::new();
    for line in text.lines() {
        let Some(at) = line.find("pixel_format=").or_else(|| line.find("vcodec=")) else {
            continue;
        };
        let mut words = line[at..].split_whitespace();
        let format = match words.next().and_then(|w| w.split_once('=')) {
            Some(("pixel_format", f)) => Format::Pixels(f.to_string()),
            Some(("vcodec", "mjpeg")) => Format::Mjpeg,
            _ => continue,
        };
        // min s=WxH fps=F max s=WxH fps=F
        let rest: Vec<&str> = words.collect();
        let value = |key: &str, from: usize| {
            rest[from..]
                .iter()
                .find_map(|w| w.strip_prefix(key))
                .map(str::to_string)
        };
        let Some(max) = rest.iter().position(|w| *w == "max") else {
            continue;
        };
        let size = value("s=", max).and_then(|s| {
            let (w, h) = s.split_once('x')?;
            Some((w.parse().ok()?, h.parse().ok()?))
        });
        let fps = |from| value("fps=", from).and_then(|f| f.parse::<f64>().ok());
        let (Some((width, height)), Some(min_fps), Some(max_fps)) = (size, fps(0), fps(max)) else {
            continue;
        };
        let mode = Mode {
            format,
            width,
            height,
            min_fps,
            max_fps,
        };
        // Each is listed twice, the second with its colour details.
        if !modes.contains(&mode) {
            modes.push(mode);
        }
    }
    modes
}

/// The mode to open at, and its rate: the largest picture up to 1080 tall that keeps up 30 fps
/// (24 at least), raw before JPEGs (no decoding), NV12 first; at 30 fps if it can, else as near
/// as it goes. None that keep up: the quickest up to 1080.
fn best(modes: &[Mode]) -> Option<(Mode, f64)> {
    let rank = |m: &Mode| match &m.format {
        Format::Pixels(p) if p == "nv12" => 2,
        Format::Pixels(_) => 1,
        Format::Mjpeg => 0,
    };
    let area = |m: &Mode| u64::from(m.width) * u64::from(m.height);
    let tall_enough = |m: &&Mode| m.height <= MAX_HEIGHT;
    let mode = modes
        .iter()
        .filter(tall_enough)
        .filter(|m| m.max_fps >= 24.0)
        .max_by_key(|m| (area(m), rank(m)))
        .or_else(|| {
            modes
                .iter()
                .filter(tall_enough)
                .max_by(|a, b| a.max_fps.total_cmp(&b.max_fps))
        })?;
    Some((mode.clone(), FPS.clamp(mode.min_fps, mode.max_fps)))
}

/// ffmpeg's input for `camera` at `mode` (None: as the camera likes).
fn input_args(camera: &Camera, mode: Option<&(Mode, f64)>) -> Vec<String> {
    let mut a: Vec<String> = ["-f", "dshow", "-rtbufsize", "64M"]
        .map(String::from)
        .into();
    if let Some((m, fps)) = mode {
        a.extend(["-video_size".into(), format!("{}x{}", m.width, m.height)]);
        a.extend(["-framerate".into(), fps.to_string()]);
        match &m.format {
            Format::Pixels(p) => a.extend(["-pixel_format".into(), p.clone()]),
            Format::Mjpeg => a.extend(["-vcodec".into(), "mjpeg".into()]),
        }
    }
    a.extend(["-i".into(), source(camera)]);
    a
}

/// What ffmpeg opens for `camera`: its device name as listed, unescaped (`\\?\usb#...`).
fn source(camera: &Camera) -> String {
    format!("video={}", camera.device)
}

/// The mode `camera` opens at, from its list (None if it can't be listed).
fn mode_of(camera: &Camera) -> Option<(Mode, f64)> {
    let out = sidecar::command(Tool::Ffmpeg)
        .ok()?
        .args(["-hide_banner", "-list_options", "true", "-f", "dshow", "-i"])
        .arg(source(camera))
        .output()
        .ok()?;
    best(&parse_modes(&String::from_utf8_lossy(&out.stderr)))
}

/// The camera Settings › Recording names, or the first connected (it's empty: the first).
fn chosen(name: &str) -> Result<Camera, String> {
    let all = cameras();
    all.iter()
        .find(|c| c.name == name)
        .or(all.first())
        .cloned()
        .ok_or_else(|| "No camera connected".to_string())
}

/// The preview's latest picture, numbered (`seq` goes on counting across previews), or why
/// there's none; `preview` is which preview it's from (one stopped can't speak for the next).
struct Frames {
    preview: u64,
    seq: u64,
    jpeg: Option<Arc<Vec<u8>>>,
    ended: Option<String>,
    /// Said over the last picture until the next comes (the camera reopening to record).
    note: Option<&'static str>,
    /// Pictures before this aren't shown: the camera's first, reopened (one said it was
    /// offline).
    quiet_until: Option<Instant>,
}

static FRAMES: Mutex<Frames> = Mutex::new(Frames {
    preview: 0,
    seq: 0,
    jpeg: None,
    ended: None,
    note: None,
    quiet_until: None,
});

/// Over the bubble while the camera reopens to record.
const READYING: &str = "Getting ready to record…";

/// How long the camera's first pictures, reopened to record, are left out of the bubble.
const QUIET: Duration = Duration::from_secs(1);
static NEW_FRAME: Condvar = Condvar::new();

/// The camera's ffmpeg: the camera it has (as Settings names it), its input (`q` ends a
/// recording cleanly), and what it records, if it does.
struct Feed {
    child: Child,
    name: String,
    stdin: Option<ChildStdin>,
    take: Option<Take>,
}

static FEED: Mutex<Option<Feed>> = Mutex::new(None);

/// A recording with the camera is starting or under way: it has the camera, and the bubble
/// stays up.
static TAKING: AtomicBool = AtomicBool::new(false);

/// The camera as recorded (5d.3): its file (Matroska, which keeps the stamps as they come), the
/// moment its stamps count from (µs since 1970, the wall clock the screen is stamped by), and
/// its picture's size.
#[derive(Debug, Clone)]
pub struct Take {
    pub path: PathBuf,
    pub origin_us: i64,
    pub width: u32,
    pub height: u32,
}

/// What `next_frame` found.
pub enum Next {
    Frame(u64, Arc<Vec<u8>>),
    /// None newer yet.
    Waiting,
    /// None newer yet, and this to say over the last.
    Note(&'static str),
    /// The preview stopped, and why.
    Ended(String),
}

/// The first picture newer than `after`, waiting for it a while.
pub fn next_frame(after: u64) -> Next {
    let frames = FRAMES.lock().unwrap();
    let (frames, _) = NEW_FRAME
        .wait_timeout_while(frames, Duration::from_secs(2), |f| {
            f.seq <= after && f.ended.is_none() && f.note.is_none()
        })
        .unwrap();
    if let Some(why) = &frames.ended {
        return Next::Ended(why.clone());
    }
    match (&frames.jpeg, frames.note) {
        (Some(jpeg), _) if frames.seq > after => Next::Frame(frames.seq, jpeg.clone()),
        (_, Some(note)) => Next::Note(note),
        _ => Next::Waiting,
    }
}

/// Preview `preview` stopped, for `why`.
fn ended(preview: u64, why: String) {
    let mut f = FRAMES.lock().unwrap();
    if f.preview == preview {
        f.ended = Some(why);
        drop(f);
        NEW_FRAME.notify_all();
    }
}

/// The preview's filters: a square from the middle, small and slow.
fn preview_filter() -> String {
    let side = PREVIEW_SIDE;
    format!("fps={PREVIEW_FPS},crop='min(iw,ih)':'min(iw,ih)',scale={side}:{side}")
}

/// What the feed also records: to `path` (Matroska), its stamps counted from `origin_us`, with
/// `encoder` at `bitrate`.
struct Recorded<'a> {
    path: &'a Path,
    origin_us: i64,
    encoder: Encoder,
    bitrate: u64,
}

/// ffmpeg's arguments for the feed of `input`: the preview on stdout, JPEG after JPEG; and if it
/// records, the camera too, each frame stamped by the wall clock as it comes (as the spike
/// measured the delay by), from `origin_us`.
fn feed_args(input: &[String], record: Option<&Recorded>) -> Vec<OsString> {
    let mut a: Vec<OsString> = ["-hide_banner", "-loglevel", "error"]
        .map(OsString::from)
        .into();
    let preview = preview_filter();
    let jpegs = ["-c:v", "mjpeg", "-q:v", "6", "-f", "image2pipe", "pipe:1"];
    let Some(r) = record else {
        a.extend(input.iter().map(OsString::from));
        a.extend(["-vf".into(), preview.into()]);
        a.extend(jpegs.map(OsString::from));
        return a;
    };
    a.extend(["-use_wallclock_as_timestamps", "1"].map(OsString::from));
    a.extend(input.iter().map(OsString::from));
    let origin = r.origin_us as f64 / 1e6;
    let pixels = r.encoder.pixels();
    a.extend(["-copyts".into(), "-filter_complex".into()]);
    a.push(
        format!(
            "[0:v]setpts=PTS-{origin:.6}/TB,split=2[rec][pv];[rec]format={pixels}[out];[pv]{preview}[pvo]"
        )
        .into(),
    );
    a.extend(["-map", "[out]", "-fps_mode", "passthrough"].map(OsString::from));
    a.extend(r.encoder.args(r.bitrate).into_iter().map(OsString::from));
    a.extend(["-f", "matroska"].map(OsString::from));
    a.push(r.path.as_os_str().to_owned());
    a.extend(["-map", "[pvo]"].map(OsString::from));
    a.extend(jpegs.map(OsString::from));
    a
}

/// Starts the camera named `name` (empty: the first), previewing, and recording to `record`'s
/// file with its encoder if asked (`feed` is ended first). Why if it couldn't.
fn start_feed(
    feed: &mut Option<Feed>,
    name: &str,
    record: Option<(PathBuf, Encoder)>,
) -> Result<(), String> {
    // The old one over before it's stopped, or its stopping could be said as this one's.
    let this = {
        let mut f = FRAMES.lock().unwrap();
        f.preview += 1;
        f.jpeg = None;
        f.ended = None;
        // Reopened to record: the bubble keeps its picture, says why it's still, and leaves
        // out the camera's first pictures.
        f.note = record.is_some().then_some(READYING);
        f.quiet_until = record.is_some().then(|| Instant::now() + QUIET);
        f.preview
    };
    NEW_FRAME.notify_all();
    end_feed(feed.take());
    let fail = |why: String| {
        ended(this, why.clone());
        Err(why)
    };
    let camera = match chosen(name) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    let mode = mode_of(&camera);
    logln!("[camera] {} at {:?}", camera.name, mode);
    let (width, height) = mode
        .as_ref()
        .map_or((1920, 1080), |(m, _)| (m.width, m.height));
    let take = record.as_ref().map(|(path, _)| Take {
        path: path.clone(),
        origin_us: crate::audio::Clock::now().unix_us,
        width,
        height,
    });
    let recorded = match (&record, &take) {
        (Some((_, encoder)), Some(t)) => Some(Recorded {
            path: &t.path,
            origin_us: t.origin_us,
            encoder: *encoder,
            // Twice the usual: it's encoded again when fitted to the recording.
            bitrate: 2 * bitrate(width, height, FPS),
        }),
        _ => None,
    };
    let args = feed_args(&input_args(&camera, mode.as_ref()), recorded.as_ref());
    let spawned = sidecar::command(Tool::Ffmpeg).and_then(|mut c| {
        c.args(&args)
            .stdin(if take.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        sidecar::spawn(&mut c).map_err(|e| e.to_string())
    });
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => return fail(format!("The camera didn't start: {e}")),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();
    *feed = Some(Feed {
        child,
        name: name.to_string(),
        stdin,
        take,
    });
    std::thread::spawn(move || {
        let said = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut e) = stderr {
                let _ = e.read_to_string(&mut text);
            }
            text
        });
        if let Some(out) = stdout {
            read_jpegs(this, out);
        }
        let said = said.join().unwrap_or_default();
        if !said.trim().is_empty() {
            logln!("[camera] ffmpeg: {}", said.trim());
        }
        ended(this, why_stopped(&said));
    });
    Ok(())
}

/// Ends `feed`: a recording asked to finish (`q`), so its file is whole; else stopped.
fn end_feed(feed: Option<Feed>) -> Option<Take> {
    let mut f = feed?;
    let Some(take) = f.take.take() else {
        let _ = f.child.kill();
        let _ = f.child.wait();
        return None;
    };
    if let Some(mut stdin) = f.stdin.take() {
        let _ = stdin.write_all(b"q");
    }
    let t0 = Instant::now();
    loop {
        match f.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if t0.elapsed() < FINISHING => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = f.child.kill();
                let _ = f.child.wait();
                break;
            }
        }
    }
    let whole = std::fs::metadata(&take.path).is_ok_and(|m| m.len() > 0);
    whole.then_some(take)
}

/// Each JPEG on preview `preview`'s stdout (each ends FF D9, which can't occur inside one) as
/// the latest.
fn read_jpegs(preview: u64, mut out: impl Read) {
    let mut buf = Vec::new();
    let mut chunk = vec![0u8; 64 << 10];
    while let Ok(n) = out.read(&mut chunk) {
        if n == 0 {
            break;
        }
        // From one byte back: an end marker may straddle two reads.
        let from = buf.len().saturating_sub(1);
        buf.extend_from_slice(&chunk[..n]);
        let mut start = 0;
        let mut i = from;
        while let Some(at) = buf[i..].windows(2).position(|w| w == [0xff, 0xd9]) {
            let end = i + at + 2;
            let mut f = FRAMES.lock().unwrap();
            let quiet = f.quiet_until.is_some_and(|t| Instant::now() < t);
            if f.preview == preview && !quiet {
                f.note = None;
                f.seq += 1;
                f.jpeg = Some(Arc::new(buf[start..end].to_vec()));
                drop(f);
                NEW_FRAME.notify_all();
            }
            start = end;
            i = end;
        }
        buf.drain(..start);
    }
}

/// What to tell the bubble when ffmpeg stops.
fn why_stopped(said: &str) -> String {
    if said.contains("already in use") {
        "The camera is in use by another app".into()
    } else if said.contains("Could not find") || said.contains("I/O error") {
        "The camera isn't connected".into()
    } else {
        "The camera stopped".into()
    }
}

/// An area of the virtual desktop (physical px) the bubble sits in the corner of, and the scale
/// of its monitor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

impl Area {
    /// All of `screen`.
    pub fn of(screen: &Screen) -> Self {
        Self::on(screen, 0, 0, screen.width, screen.height)
    }

    /// Of `screen`, from (`x`, `y`) in its own pixels.
    pub fn on(screen: &Screen, x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            x: screen.x + x,
            y: screen.y + y,
            width,
            height,
            scale: screen.scale,
        }
    }

    /// Where the bubble's window goes in its bottom-right corner (its margin inside it).
    fn corner(&self) -> (i32, i32) {
        let side = ((BUBBLE_SIZE + BUBBLE_MARGIN) * self.scale).round() as i32;
        (
            self.x + self.width as i32 - side,
            self.y + self.height as i32 - side,
        )
    }
}

/// While picking, the bubble follows what's picked into its corner (Richard), until it's dragged:
/// the area it's in, and which overlay's selection put it there (another's clearing its own
/// selection doesn't move it).
struct Follow {
    dragged: bool,
    by: Option<u32>,
    area: Option<Area>,
}

static FOLLOW: Mutex<Follow> = Mutex::new(Follow {
    dragged: false,
    by: None,
    area: None,
});

/// Picking starts: the bubble follows again.
pub fn unfollow() {
    *FOLLOW.lock().unwrap() = Follow {
        dragged: false,
        by: None,
        area: None,
    };
}

/// A drag of the bubble: where the pointer and the bubble were when it was pressed.
struct Grab {
    pointer: (i32, i32),
    at: (i32, i32),
}

static GRAB: Mutex<Option<Grab>> = Mutex::new(None);

/// How far the pointer goes before a press on the bubble is a drag (physical px).
const DRAG_START: i32 = 4;

/// The pointer, on the virtual desktop (physical px).
fn pointer() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT::default();
    // SAFETY: a valid out pointer.
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x, p.y))
}

/// The bubble's pressed: a drag may start. Rust moves it, not the system's window drag, which
/// can't tell a click from a drag.
pub fn grab(app: &AppHandle) {
    let at = app
        .get_webview_window(BUBBLE)
        .and_then(|w| w.outer_position().ok());
    *GRAB.lock().unwrap() = match (pointer(), at) {
        (Some(pointer), Some(at)) => Some(Grab {
            pointer,
            at: (at.x, at.y),
        }),
        _ => None,
    };
}

/// The pointer's moved with the bubble pressed: the bubble goes with it. Once it's gone a few
/// pixels it's been put somewhere, and no longer follows what's picked; a click alone isn't.
pub fn drag(app: &AppHandle) {
    let (Some(g), Some(p)) = (
        GRAB.lock().unwrap().as_ref().map(|g| (g.pointer, g.at)),
        pointer(),
    ) else {
        return;
    };
    let ((x0, y0), (wx, wy)) = g;
    let (dx, dy) = (p.0 - x0, p.1 - y0);
    {
        let mut f = FOLLOW.lock().unwrap();
        if !f.dragged && dx.abs().max(dy.abs()) < DRAG_START {
            return;
        }
        f.dragged = true;
    }
    if let Some(w) = app.get_webview_window(BUBBLE) {
        let _ = w.set_position(tauri::PhysicalPosition::new(wx + dx, wy + dy));
    }
}

/// The bubble's let go: the picker's overlay has the keys back (the click took them; given back
/// while it was pressed, the drag could end).
pub fn release(app: &AppHandle) {
    *GRAB.lock().unwrap() = None;
    crate::picker::refocus(app);
}

/// Overlay `by` (or the window picking) has `area` picked, `cleared` if that's its selection
/// gone: the bubble goes into its corner, if it hasn't been dragged.
pub fn follow(app: &AppHandle, by: u32, area: Area, cleared: bool) {
    {
        let mut f = FOLLOW.lock().unwrap();
        if f.dragged || (cleared && f.by.is_some_and(|b| b != by)) {
            return;
        }
        f.by = Some(by);
        f.area = Some(area);
    }
    if let Some(window) = app.get_webview_window(BUBBLE) {
        put_bubble(&window, area);
    }
}

/// The bubble's window into `area`'s corner, its size kept on that monitor.
fn put_bubble(window: &WebviewWindow, area: Area) {
    let (x, y) = area.corner();
    let side = (BUBBLE_SIZE * area.scale).round() as u32;
    // There before it's shown (Tauri's moves land later).
    crate::recording::place(window, x, y, side, side);
}

/// One `sync` at a time: two would make two bubbles.
static SYNCING: Mutex<()> = Mutex::new(());

/// The bubble is up while what to record is picked and Settings › Recording records the camera
/// (the picker's toggle sets it), showing the camera chosen; else it's gone. While a recording
/// has the camera, it's left as it is.
pub fn sync(app: &AppHandle) {
    let app = app.clone();
    // Windows aren't made from a command's thread (it can deadlock).
    std::thread::spawn(move || {
        let _one = SYNCING.lock().unwrap();
        if TAKING.load(Ordering::SeqCst) {
            return;
        }
        let recording = app
            .state::<crate::state::AppState>()
            .settings
            .read()
            .unwrap()
            .recording
            .clone();
        let screen = crate::picker::screen_under_pointer();
        let bubble = app.get_webview_window(BUBBLE);
        match (recording.camera, screen) {
            (true, Some(screen)) => {
                let name = &recording.camera_device;
                let mut feed = FEED.lock().unwrap();
                if feed.as_ref().is_none_or(|f| &f.name != name) {
                    let _ = start_feed(&mut feed, name, None);
                }
                drop(feed);
                if bubble.is_none() {
                    let area = FOLLOW.lock().unwrap().area;
                    open_bubble(&app, area.unwrap_or_else(|| Area::of(&screen)));
                }
            }
            _ => {
                if let Some(w) = bubble {
                    let _ = w.destroy();
                }
                end_feed(FEED.lock().unwrap().take());
            }
        }
    });
}

/// What to record is picked: if the camera's on, the recording will have it, so the bubble
/// stays as the picker goes.
pub fn hold(app: &AppHandle) {
    let on = app
        .state::<crate::state::AppState>()
        .settings
        .read()
        .unwrap()
        .recording
        .camera;
    TAKING.store(on, Ordering::SeqCst);
}

/// Whether the recording starting has the camera.
pub fn held() -> bool {
    TAKING.load(Ordering::SeqCst)
}

/// Records the camera to `path` with `encoder` (its preview goes on), from now on: the preview's
/// ffmpeg gives way to one that does both, as only one can have the camera.
pub fn record(app: &AppHandle, path: PathBuf, encoder: Encoder) -> Result<(), String> {
    let name = app
        .state::<crate::state::AppState>()
        .settings
        .read()
        .unwrap()
        .recording
        .camera_device
        .clone();
    start_feed(&mut FEED.lock().unwrap(), &name, Some((path, encoder)))
}

/// The recording's done with the camera: its file, whole, if it was recorded. The bubble goes.
pub fn stop_recording(app: &AppHandle) -> Option<Take> {
    let take = end_feed(FEED.lock().unwrap().take());
    TAKING.store(false, Ordering::SeqCst);
    sync(app);
    take
}

/// Where the bubble's circle is on the screen (virtual-desktop px): its middle, and across.
pub fn bubble_circle(app: &AppHandle) -> Option<(f64, f64, f64)> {
    let w = app.get_webview_window(BUBBLE)?;
    let (at, size, scale) = (
        w.outer_position().ok()?,
        w.outer_size().ok()?,
        w.scale_factor().ok()?,
    );
    let across = f64::from(size.width) - 2.0 * BUBBLE_INSET * scale;
    Some((
        f64::from(at.x) + f64::from(size.width) / 2.0,
        f64::from(at.y) + f64::from(size.height) / 2.0,
        across,
    ))
}

/// The camera's file fitted to the recording, at `out`: from the take's frames, the stretch of
/// each of the recording's parts (each started at µs since 1970, lasting s), less the camera's
/// delay, one after another, at a steady 30 fps from the recording's first frame; where the
/// bubble was left (`place`) kept in it; `progress` hears how far along it is (0 to 1). Then the
/// take is deleted.
pub fn fit(
    take: &Take,
    parts: &[(i64, f64)],
    encoder: Encoder,
    out: &Path,
    place: Option<Place>,
    mut progress: impl FnMut(f64),
) -> Result<(), String> {
    let (filter, frames) = fit_filter(take.origin_us, parts, encoder.pixels());
    let mut writing = out.as_os_str().to_owned();
    writing.push(".part");
    let writing = PathBuf::from(writing);
    let mut cmd = sidecar::background(Tool::Ffmpeg)?;
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-copyts", "-i"])
        .arg(&take.path)
        .args(["-vf", &filter, "-an"])
        .args(encoder.args(bitrate(take.width, take.height, FPS)))
        // A keyframe a second, so the editor seeks it quickly (spike 5d.1 measured it so; the
        // encoders' own, NVENC's 250, made a seek decode up to 8 s).
        .args(["-g", "30"]);
    if let Some(p) = place {
        cmd.args(["-metadata".into(), format!("comment={}", p.tag())]);
    }
    // How far it's got, as frames written (`progress`, 0 to 1), on stdout.
    cmd.args(["-movflags", "+faststart", "-f", "mp4"])
        .arg(&writing)
        .args(["-progress", "pipe:1", "-nostats"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Not in Razorcat's job: closed while fitting, the camera's still fitted.
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stderr = child.stderr.take();
    let said = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut e) = stderr {
            let _ = e.read_to_string(&mut text);
        }
        text
    });
    if let Some(out) = child.stdout.take() {
        use std::io::BufRead;
        for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            let written = line
                .strip_prefix("frame=")
                .and_then(|n| n.trim().parse::<u64>().ok());
            if let Some(n) = written {
                progress((n as f64 / frames.max(1) as f64).min(1.0));
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let said = said.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(&writing);
        return Err(said.trim().to_string());
    }
    std::fs::rename(&writing, out).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&take.path);
    Ok(())
}

/// The filters fitting a take whose stamps count from `origin_us` to the recording's `parts`
/// (each started at µs since 1970, lasting s), in `pixels`; and the frames that makes. Each
/// part's stretch of the take, its stamps less the delay, is kept (`select`) and moved on to
/// follow the last (`setpts`); `fps` holds each frame till the next, from 0 (the first frame
/// filling in before the camera started), and `tpad` the last, to the end.
fn fit_filter(origin_us: i64, parts: &[(i64, f64)], pixels: &str) -> (String, u64) {
    let mut windows = Vec::new();
    let mut before = 0.0;
    for &(start_us, seconds) in parts {
        let a = (start_us - origin_us) as f64 / 1e6 + DELAY;
        windows.push((a, a + seconds, before));
        before += seconds;
    }
    let frames = (before * FPS).round() as u64;
    let keep: Vec<String> = windows
        .iter()
        .map(|(a, b, _)| format!("gte(t,{a:.6})*lt(t,{b:.6})"))
        .collect();
    let mut moved = String::new();
    for (k, (a, b, at)) in windows.iter().enumerate().rev() {
        let here = format!("T-{a:.6}+{at:.6}");
        moved = if k + 1 == windows.len() {
            here
        } else {
            format!("if(lt(T,{b:.6}),{here},{moved})")
        };
    }
    let fps = FPS;
    (
        format!(
            "select='{}',setpts='({moved})/TB',fps={fps}:start_time=0,tpad=stop_mode=clone:stop=-1,trim=end_frame={frames},format={pixels}",
            keep.join("+")
        ),
        frames,
    )
}

/// Where the bubble (its circle: middle and across, virtual-desktop px) goes on a picture
/// `size` whose top-left is at `origin` on the screen: its top-left and across on the picture,
/// kept on it (as large as the picture, at most).
pub fn on_picture(circle: (f64, f64, f64), origin: (f64, f64), size: (f64, f64)) -> Place {
    let (cx, cy, across) = circle;
    let across = across.min(size.0).min(size.1).max(0.0);
    Place {
        x: (cx - origin.0 - across / 2.0).clamp(0.0, size.0 - across),
        y: (cy - origin.1 - across / 2.0).clamp(0.0, size.1 - across),
        size: across,
    }
}

/// Where the camera shows on its recording's picture: the bubble's top-left and across (px).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
pub struct Place {
    pub x: f64,
    pub y: f64,
    pub size: f64,
}

/// What the camera's file says it is, in its `comment`: "razorcat-camera x y size".
const PLACE_TAG: &str = "razorcat-camera";

impl Place {
    fn tag(self) -> String {
        format!("{PLACE_TAG} {:.1} {:.1} {:.1}", self.x, self.y, self.size)
    }

    /// The place in ffmpeg's description of a file (its `comment` line), if it has one.
    fn from_description(text: &str) -> Option<Self> {
        let line = text.lines().find(|l| l.contains(PLACE_TAG))?;
        let rest = &line[line.find(PLACE_TAG)? + PLACE_TAG.len()..];
        let mut n = rest.split_whitespace().map(|w| w.parse::<f64>());
        let (x, y, size) = (n.next()?.ok()?, n.next()?.ok()?, n.next()?.ok()?);
        Some(Self { x, y, size })
    }

    /// Where a camera with no place said goes on a picture `width` × `height`: its bottom-right
    /// corner, a little in, a quarter as tall as the picture's shorter side and a bit.
    fn default_for(width: u32, height: u32) -> Self {
        let short = f64::from(width.min(height));
        let size = (short * 0.28).round();
        let margin = (short * 0.04).round();
        Self {
            x: f64::from(width) - size - margin,
            y: f64::from(height) - size - margin,
            size,
        }
    }
}

/// The camera's file beside a recording `file`: "Recording 2026-10-27 10-00-00 (camera).mp4".
pub fn beside(file: &Path) -> PathBuf {
    let stem = file.file_stem().unwrap_or_default().to_string_lossy();
    file.with_file_name(format!("{stem} (camera).mp4"))
}

/// A recording's camera, for the editor: where it reads the file (`media://`), and its place.
#[derive(Debug, Clone, Serialize, Type)]
pub struct SourceCamera {
    pub url: String,
    pub place: Place,
}

/// Rust → editor: an open file has a camera (PLAN 5d.4): found beside it as it opened, or fitted
/// since (a recording opens before its camera's ready).
#[derive(Clone, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct CameraReady {
    /// The source it's for (its `SourceInfo::id`).
    pub source: String,
    pub camera: SourceCamera,
}

/// Rust → editor: an open recording's camera is being fitted (PLAN 5d.5c), `progress` (0 to 1)
/// of the way: the editor shows where it'll be till it's ready (`CameraReady`).
#[derive(Clone, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct CameraFitting {
    /// The source it's for (its `SourceInfo::id`).
    pub source: String,
    pub place: Place,
    pub progress: f64,
}

/// The recordings whose cameras are being fitted: each one's file, the bubble's place (None:
/// the usual), and how far along.
static FITTING: Mutex<Vec<(PathBuf, Option<Place>, f64)>> = Mutex::new(Vec::new());

/// The camera of recording `file` is being fitted, `progress` of the way (its bubble at
/// `place`): the editor's told, if it has the file open.
pub fn fitting(app: &AppHandle, file: &Path, place: Option<Place>, progress: f64) {
    {
        let mut all = FITTING.lock().unwrap();
        match all.iter_mut().find(|f| f.0 == file) {
            Some(f) => f.2 = progress,
            None => all.push((file.to_path_buf(), place, progress)),
        }
    }
    let open: Vec<u64> = app
        .state::<crate::state::AppState>()
        .sources
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.path == file)
        .map(|s| s.generation)
        .collect();
    for generation in open {
        tell_fitting(app, generation, place, progress);
    }
}

/// The camera of recording `file` is fitted, or couldn't be.
pub fn fitting_over(file: &Path) {
    FITTING.lock().unwrap().retain(|f| f.0 != file);
}

/// Tells the editor the camera of the source opened as `generation` is being fitted.
fn tell_fitting(app: &AppHandle, generation: u64, place: Option<Place>, progress: f64) {
    let info = app
        .state::<crate::state::AppState>()
        .sources
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.generation == generation)
        .map(|s| s.info());
    let Some(info) = info else {
        return;
    };
    let fitting = CameraFitting {
        source: info.id,
        place: place.unwrap_or_else(|| Place::default_for(info.width, info.height)),
        progress,
    };
    let _ = tauri_specta::Event::emit_to(&fitting, app, crate::editor::LABEL);
}

/// Looks beside the source opened as `generation` for its camera, and if it's there, tells the
/// editor (on a thread of its own: ffmpeg reads the place); if it's still being fitted, tells
/// it so.
pub fn look(app: &AppHandle, generation: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<crate::state::AppState>();
        let Some((path, info)) = state
            .sources
            .lock()
            .unwrap()
            .iter()
            .find(|s| s.generation == generation)
            .map(|s| (s.path.clone(), s.info()))
        else {
            return;
        };
        let file = beside(&path);
        if !file.is_file() {
            let fitting = FITTING
                .lock()
                .unwrap()
                .iter()
                .find(|f| f.0 == path)
                .map(|f| (f.1, f.2));
            if let Some((place, progress)) = fitting {
                tell_fitting(&app, generation, place, progress);
            }
            return;
        }
        let described = sidecar::command(Tool::Ffmpeg)
            .ok()
            .and_then(|mut c| c.args(["-hide_banner", "-i"]).arg(&file).output().ok());
        let place = described
            .and_then(|o| Place::from_description(&String::from_utf8_lossy(&o.stderr)))
            .unwrap_or_else(|| Place::default_for(info.width, info.height));
        {
            let mut sources = state.sources.lock().unwrap();
            let Some(s) = sources.iter_mut().find(|s| s.generation == generation) else {
                return;
            };
            s.camera = Some((file, place));
        }
        logln!("[camera] found with a source, at {place:?}");
        let ready = CameraReady {
            source: info.id,
            camera: SourceCamera {
                url: crate::protocol::camera_url(generation),
                place,
            },
        };
        let _ = tauri_specta::Event::emit_to(&ready, &app, crate::editor::LABEL);
    });
}

/// The camera of the recording `file` is fitted: if the file's open, it gets it.
pub fn fitted(app: &AppHandle, file: &Path) {
    let open: Vec<u64> = app
        .state::<crate::state::AppState>()
        .sources
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.path == file)
        .map(|s| s.generation)
        .collect();
    for generation in open {
        look(app, generation);
    }
}

/// The bubble, in the bottom-right corner of `area`: round, over everything (the picker's
/// overlays too), never taking the keys from them, and left out of the recording.
fn open_bubble(app: &AppHandle, area: Area) {
    let made = crate::recording::made_at(area.x, area.y, area.width, area.height, area.scale);
    let built = WebviewWindowBuilder::new(app, BUBBLE, WebviewUrl::App("camera.html".into()))
        .title("Camera")
        .position(made.0, made.1)
        .inner_size(crate::recording::MADE_SIZE, crate::recording::MADE_SIZE)
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .transparent(true)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build();
    match built {
        Ok(window) => {
            crate::recording::exclude_from_capture(&window);
            crate::picker::no_transitions(&window);
            put_bubble(&window, area);
            show_quietly(&window);
        }
        Err(e) => logln!("[camera] the bubble failed: {e}"),
    }
}

/// Shows `window` without making it active: shown as usual, the bubble took the focus from the
/// picker's overlay, whose shortcuts went with it.
fn show_quietly(window: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    match window.hwnd() {
        // SAFETY: a valid window handle.
        Ok(hwnd) => {
            let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
        }
        Err(_) => {
            let _ = window.show();
        }
    }
}

/// Puts the bubble back on top: a picker overlay that takes the keys comes up over it.
pub fn raise(app: &AppHandle) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    let Some(hwnd) = app.get_webview_window(BUBBLE).and_then(|w| w.hwnd().ok()) else {
        return;
    };
    // SAFETY: a valid window handle.
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bubble_goes_in_the_corner_of_whats_picked() {
        let screen = Screen {
            hmonitor: 0,
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.5,
        };
        // (200 + 32) × 1.5 = 348 px from the corner, inside it.
        assert_eq!(Area::of(&screen).corner(), (-348, 732));
        let picked = Area::on(&screen, 100, 50, 800, 600);
        assert_eq!((picked.x, picked.y), (-1820, 50));
        assert_eq!(picked.corner(), (-1820 + 800 - 348, 50 + 600 - 348));
    }

    const DEVICES: &str = r#"[in#0 @ 0000019d3eb32200] "Logitech StreamCam" (video)
[in#0 @ 0000019d3eb32200]   Alternative name "@device_pnp_\\?\usb#vid_046d&pid_0893&mi_00#7&1935c54e&1&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\global"
[in#0 @ 0000019d3eb32200] "LSVCam" (none)
[in#0 @ 0000019d3eb32200]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\LSVCam"
[in#0 @ 0000019d3eb32200] "OBS Virtual Camera" (video)
[in#0 @ 0000019d3eb32200]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
[in#0 @ 0000019d3eb32200] "Microphone (Logitech StreamCam)" (audio)
[in#0 @ 0000019d3eb32200]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{DB5BBB05}"
Error opening input file dummy."#;

    #[test]
    fn lists_the_video_devices_by_their_device_names() {
        let found = parse_cameras(DEVICES);
        let names: Vec<_> = found.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Logitech StreamCam", "OBS Virtual Camera"]);
        assert!(found[0].device.starts_with(r"@device_pnp_\\?\usb#vid_046d"));
        assert!(found[0].device.ends_with(r"}\global"));
        assert!(found[1].device.ends_with("ABA1250EC20B}"));
    }

    fn mode(format: Format, width: u32, height: u32, min_fps: f64, max_fps: f64) -> Mode {
        Mode {
            format,
            width,
            height,
            min_fps,
            max_fps,
        }
    }
    fn pixels(p: &str) -> Format {
        Format::Pixels(p.into())
    }

    #[test]
    fn reads_the_modes_once_each() {
        let text = "[in#0 @ 0] DirectShow video device options (from video devices)
[in#0 @ 0]  Pin \"Capture\" (alternative pin name \"0\")
[in#0 @ 0]   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=30
[in#0 @ 0]   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=30 (tv, bt470bg/bt709/unknown, topleft)
[in#0 @ 0]   vcodec=mjpeg  min s=1920x1080 fps=5 max s=1920x1080 fps=60.0002
[in#0 @ 0]   vcodec=h264  min s=1920x1080 fps=5 max s=1920x1080 fps=30
[in#0 @ 0]   pixel_format=nv12  min s=1920x1080 fps=5 max s=1920x1080 fps=30";
        assert_eq!(
            parse_modes(text),
            [
                mode(pixels("yuyv422"), 640, 480, 5.0, 30.0),
                mode(Format::Mjpeg, 1920, 1080, 5.0, 60.0002),
                mode(pixels("nv12"), 1920, 1080, 5.0, 30.0),
            ]
        );
    }

    #[test]
    fn opens_the_largest_that_keeps_up_raw_first_at_30() {
        let streamcam = [
            mode(pixels("yuyv422"), 1920, 1080, 5.0, 30.0),
            mode(pixels("yuyv422"), 2304, 1296, 5.0, 5.0),
            mode(Format::Mjpeg, 1920, 1080, 5.0, 60.0002),
            mode(pixels("nv12"), 1920, 1080, 5.0, 30.0),
            mode(pixels("nv12"), 1280, 720, 5.0, 30.0),
        ];
        assert_eq!(best(&streamcam), Some((streamcam[3].clone(), 30.0)));
        // Raw only small: the JPEGs, bigger.
        let cheap = [
            mode(pixels("yuyv422"), 640, 480, 5.0, 30.0),
            mode(Format::Mjpeg, 1280, 720, 5.0, 30.0),
        ];
        assert_eq!(best(&cheap), Some((cheap[1].clone(), 30.0)));
        // Only 60: at 60.
        let obs = [mode(pixels("nv12"), 1920, 1080, 60.0002, 60.0002)];
        assert_eq!(best(&obs), Some((obs[0].clone(), 60.0002)));
        // None keep up: the quickest.
        let slow = [
            mode(pixels("nv12"), 1920, 1080, 5.0, 10.0),
            mode(pixels("nv12"), 640, 480, 5.0, 15.0),
        ];
        assert_eq!(best(&slow), Some((slow[1].clone(), 15.0)));
        assert_eq!(best(&[]), None);
    }

    #[test]
    fn opens_the_device_at_its_mode() {
        let camera = Camera {
            name: "Cam".into(),
            device: "@device_pnp_x".into(),
        };
        let m = (mode(pixels("nv12"), 1920, 1080, 5.0, 30.0), 30.0);
        assert_eq!(
            input_args(&camera, Some(&m)).join(" "),
            "-f dshow -rtbufsize 64M -video_size 1920x1080 -framerate 30 -pixel_format nv12 \
             -i video=@device_pnp_x"
        );
        let j = (mode(Format::Mjpeg, 1280, 720, 5.0, 60.0), 30.0);
        assert!(input_args(&camera, Some(&j))
            .join(" ")
            .contains("-vcodec mjpeg -i"));
        assert_eq!(
            input_args(&camera, None).join(" "),
            "-f dshow -rtbufsize 64M -i video=@device_pnp_x"
        );
        let usb = Camera {
            name: "Cam".into(),
            device: r"@device_pnp_\\?\usb#vid_046d#{65e8}\global".into(),
        };
        assert_eq!(
            source(&usb),
            r"video=@device_pnp_\\?\usb#vid_046d#{65e8}\global"
        );
    }

    #[test]
    fn splits_the_jpegs_as_they_come() {
        let (preview, before) = {
            let f = FRAMES.lock().unwrap();
            (f.preview, f.seq)
        };
        // Two pictures, the second's end split across reads.
        let stream: Vec<u8> = [0xff, 0xd8, 1, 2, 0xff, 0xd9, 0xff, 0xd8, 3, 0xff, 0xd9].into();
        struct Dribble(Vec<u8>, usize);
        impl Read for Dribble {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = (self.0.len() - self.1).min(5).min(buf.len());
                buf[..n].copy_from_slice(&self.0[self.1..self.1 + n]);
                self.1 += n;
                Ok(n)
            }
        }
        read_jpegs(preview, Dribble(stream, 0));
        let f = FRAMES.lock().unwrap();
        assert_eq!(f.seq, before + 2);
        assert_eq!(f.jpeg.as_deref().unwrap(), &[0xff, 0xd8, 3, 0xff, 0xd9]);
    }

    #[test]
    fn says_why_the_camera_stopped() {
        assert_eq!(
            why_stopped("Could not run graph (sometimes caused by a device already in use by other application)"),
            "The camera is in use by another app"
        );
        assert_eq!(why_stopped(""), "The camera stopped");
    }

    fn joined(a: &[OsString]) -> String {
        a.iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn previews_or_records_and_previews() {
        let input: Vec<String> = ["-f", "dshow", "-i", "video=Cam"].map(String::from).into();
        let preview = joined(&feed_args(&input, None));
        assert_eq!(
            preview,
            "-hide_banner -loglevel error -f dshow -i video=Cam -vf \
             fps=15,crop='min(iw,ih)':'min(iw,ih)',scale=320:320 \
             -c:v mjpeg -q:v 6 -f image2pipe pipe:1"
        );
        let path = PathBuf::from(r"D:\Takes\Recording.camera.mkv");
        let r = Recorded {
            path: &path,
            origin_us: 1_700_000_000_250_000,
            encoder: Encoder::Nvenc,
            bitrate: 12_000_000,
        };
        let both = joined(&feed_args(&input, Some(&r)));
        // Stamped as they come, kept as they are, from the origin.
        assert!(both.starts_with(
            "-hide_banner -loglevel error -use_wallclock_as_timestamps 1 -f dshow -i video=Cam \
             -copyts -filter_complex [0:v]setpts=PTS-1700000000.250000/TB,split=2[rec][pv];\
             [rec]format=yuv420p[out];[pv]fps=15,"
        ));
        assert!(both.contains(
            "-map [out] -fps_mode passthrough -c:v h264_nvenc -preset p2 -tune hq -rc vbr \
             -b:v 12000000"
        ));
        assert!(both.ends_with(
            r"-f matroska D:\Takes\Recording.camera.mkv -map [pvo] -c:v mjpeg -q:v 6 -f image2pipe pipe:1"
        ));
    }

    #[test]
    fn fits_the_take_to_the_recordings_parts() {
        // The take's stamps from 1000 s; the recording's parts from 1001.5 s for 5 s, and from
        // 1010 s for 3 s: each 80 ms later on the take.
        let s = 1_000_000_000;
        let (filter, frames) =
            fit_filter(s, &[(s + 1_500_000, 5.0), (s + 10_000_000, 3.0)], "nv12");
        assert_eq!(frames, 240);
        assert_eq!(
            filter,
            "select='gte(t,1.580000)*lt(t,6.580000)+gte(t,10.080000)*lt(t,13.080000)',\
             setpts='(if(lt(T,6.580000),T-1.580000+0.000000,T-10.080000+5.000000))/TB',\
             fps=30:start_time=0,tpad=stop_mode=clone:stop=-1,trim=end_frame=240,format=nv12"
        );
        // One part: no `if`.
        let (one, frames) = fit_filter(s, &[(s, 2.0)], "yuv420p");
        assert_eq!(frames, 60);
        assert!(one.contains("setpts='(T-0.080000+0.000000)/TB'"));
    }

    #[test]
    fn the_bubble_stays_on_the_picture() {
        // Middle at (500, 400), 180 across; the picture at (100, 100), 1280 × 720.
        let picture = ((100.0, 100.0), (1280.0, 720.0));
        let place = |x, y, size| Place { x, y, size };
        assert_eq!(
            on_picture((500.0, 400.0, 180.0), picture.0, picture.1),
            place(310.0, 210.0, 180.0)
        );
        // Off its bottom-right corner: pulled in.
        assert_eq!(
            on_picture((1500.0, 900.0, 180.0), picture.0, picture.1),
            place(1100.0, 540.0, 180.0)
        );
        // Bigger than the picture: as large as it.
        assert_eq!(
            on_picture((0.0, 0.0, 500.0), (0.0, 0.0), (400.0, 300.0)),
            place(0.0, 0.0, 300.0)
        );
    }

    #[test]
    fn the_place_is_kept_in_the_cameras_file() {
        let p = Place {
            x: 1100.0,
            y: 540.25,
            size: 180.0,
        };
        assert_eq!(p.tag(), "razorcat-camera 1100.0 540.2 180.0");
        // As ffmpeg describes the file.
        let described =
            "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x (camera).mp4':\n  Metadata:\n    \
                         major_brand     : isom\n    \
                         comment         : razorcat-camera 1100.0 540.2 180.0\n";
        assert_eq!(
            Place::from_description(described),
            Some(Place {
                x: 1100.0,
                y: 540.2,
                size: 180.0
            })
        );
        assert_eq!(Place::from_description("comment : something else"), None);
        // None said: the bottom-right corner.
        assert_eq!(
            Place::default_for(1920, 1080),
            Place {
                x: 1575.0,
                y: 735.0,
                size: 302.0
            }
        );
    }

    #[test]
    fn the_camera_sits_beside_its_recording() {
        assert_eq!(
            beside(Path::new(r"D:\Takes\Recording 1.mp4")),
            PathBuf::from(r"D:\Takes\Recording 1 (camera).mp4")
        );
    }
}
