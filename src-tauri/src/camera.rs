//! The camera (PLAN 5d): the cameras connected, as ffmpeg's DirectShow lists them; the mode
//! each is opened at; and the bubble (5d.2), a small round window showing it while what to
//! record is picked, dragged anywhere, left out of the recording.
//!
//! A camera opens to one program at a time (spike 5d.1), so the page never opens it: ffmpeg
//! does, and sends a small preview (JPEGs on its stdout), which the bubble reads from
//! `media://camera/{after}` (protocol.rs). Recording it (5d.3) will tee the same feed.

use std::io::Read;
use std::process::{Child, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::recording::Screen;
use crate::sidecar::{self, Tool};

pub const BUBBLE: &str = "camera";
/// The bubble's window, CSS px square, and its gap from the monitor's corner.
const BUBBLE_SIZE: f64 = 200.0;
const BUBBLE_MARGIN: f64 = 32.0;
/// The preview: a square this many pixels across, at this rate.
const PREVIEW_SIDE: u32 = 320;
const PREVIEW_FPS: u32 = 15;
/// The tallest picture a camera is opened at, and the rate wanted.
const MAX_HEIGHT: u32 = 1080;
const FPS: f64 = 30.0;

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
}

static FRAMES: Mutex<Frames> = Mutex::new(Frames {
    preview: 0,
    seq: 0,
    jpeg: None,
    ended: None,
});
static NEW_FRAME: Condvar = Condvar::new();

/// The preview's ffmpeg, and the camera it has.
static PREVIEW: Mutex<Option<(Child, String)>> = Mutex::new(None);

/// What `next_frame` found.
pub enum Next {
    Frame(u64, Arc<Vec<u8>>),
    /// None newer yet.
    Waiting,
    /// The preview stopped, and why.
    Ended(String),
}

/// The first picture newer than `after`, waiting for it a while.
pub fn next_frame(after: u64) -> Next {
    let frames = FRAMES.lock().unwrap();
    let (frames, _) = NEW_FRAME
        .wait_timeout_while(frames, Duration::from_secs(2), |f| {
            f.seq <= after && f.ended.is_none()
        })
        .unwrap();
    if let Some(why) = &frames.ended {
        return Next::Ended(why.clone());
    }
    match &frames.jpeg {
        Some(jpeg) if frames.seq > after => Next::Frame(frames.seq, jpeg.clone()),
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

/// Starts the preview of the camera named `name` (empty: the first), unless it's running.
fn start_preview(name: &str) {
    let mut preview = PREVIEW.lock().unwrap();
    if preview.as_ref().is_some_and(|(_, n)| n == name) {
        return;
    }
    if let Some((mut child, _)) = preview.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let this = {
        let mut f = FRAMES.lock().unwrap();
        f.preview += 1;
        f.jpeg = None;
        f.ended = None;
        f.preview
    };
    let camera = match chosen(name) {
        Ok(c) => c,
        Err(e) => return ended(this, e),
    };
    let mode = mode_of(&camera);
    logln!("[camera] {} at {:?}", camera.name, mode);
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error"]
        .map(String::from)
        .into();
    args.extend(input_args(&camera, mode.as_ref()));
    let side = PREVIEW_SIDE;
    args.extend([
        "-vf".into(),
        format!("fps={PREVIEW_FPS},crop='min(iw,ih)':'min(iw,ih)',scale={side}:{side}"),
        "-c:v".into(),
        "mjpeg".into(),
        "-q:v".into(),
        "6".into(),
        "-f".into(),
        "image2pipe".into(),
        "pipe:1".into(),
    ]);
    let spawned = sidecar::command(Tool::Ffmpeg).and_then(|mut c| {
        c.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        sidecar::spawn(&mut c).map_err(|e| e.to_string())
    });
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => return ended(this, format!("The camera didn't start: {e}")),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *preview = Some((child, name.to_string()));
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
            if f.preview == preview {
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

fn stop_preview() {
    if let Some((mut child, _)) = PREVIEW.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// One `sync` at a time: two would make two bubbles.
static SYNCING: Mutex<()> = Mutex::new(());

/// The bubble is up while what to record is picked and Settings › Recording records the camera
/// (the picker's toggle sets it), showing the camera chosen; else it's gone.
pub fn sync(app: &AppHandle) {
    let app = app.clone();
    // Windows aren't made from a command's thread (it can deadlock).
    std::thread::spawn(move || {
        let _one = SYNCING.lock().unwrap();
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
                start_preview(&recording.camera_device);
                if bubble.is_none() {
                    open_bubble(&app, &screen);
                }
            }
            _ => {
                if let Some(w) = bubble {
                    let _ = w.destroy();
                }
                stop_preview();
            }
        }
    });
}

/// The bubble, in the bottom-right corner of `screen`: round, over everything (the picker's
/// overlays too), never taking the keys from them, and left out of the recording.
fn open_bubble(app: &AppHandle, screen: &Screen) {
    let built = WebviewWindowBuilder::new(app, BUBBLE, WebviewUrl::App("camera.html".into()))
        .title("Camera")
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
            let side = ((BUBBLE_SIZE + BUBBLE_MARGIN) * screen.scale).round() as i32;
            let x = screen.x + screen.width as i32 - side;
            let y = screen.y + screen.height as i32 - side;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            let _ = window.set_size(tauri::LogicalSize::new(BUBBLE_SIZE, BUBBLE_SIZE));
            let _ = window.show();
        }
        Err(e) => logln!("[camera] the bubble failed: {e}"),
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
}
