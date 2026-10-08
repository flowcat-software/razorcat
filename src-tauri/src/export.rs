//! Export (PLAN 2.5): the edit rendered to MP4 by ffmpeg, the way spike 0.3 measured it exact.
//!
//! Each clip is its own input, seeked half a second before its first frame. Its timestamps are
//! put back on the source's clock (from its first shown frame, as the grid counts), the `fps`
//! filter puts it on the timeline's grid (the same rule the grid and the preview follow,
//! grid.rs), and `trim` keeps the clip's grid frames. The audio is cut at the same times (all
//! its tracks mixed, as the waveform shows them). The clips are joined with `concat`.
//!
//! The encoder is the machine's best that works, found at startup by trying each in turn
//! (`probe`): NVIDIA's, AMD's, Intel's, Windows' own (Media Foundation), then libx264, which
//! always works. If one fails mid-export, the next takes over.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::editor::LABEL;
use crate::ffmpeg::{self, Outcome};
use crate::media::grid::{self, Rate};
use crate::sidecar::{self, Tool};
use crate::source::file_name;
use crate::state::AppState;

/// A clip of the edit, as the page sends it: its number, and its source grid frames.
#[derive(Debug, Clone, Deserialize, Type)]
pub struct ExportClip {
    pub id: u32,
    #[serde(rename = "in")]
    pub from: u32,
    pub out: u32,
}

/// Rust → editor: an export is this far along.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    /// The file being written, for the status bar.
    pub name: String,
    /// 0 to 1, over all the files.
    pub done: f64,
}

/// Rust → editor: an export ended. `files` were written; `message` says why it failed. Neither:
/// cancelled.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ExportEnded {
    pub files: Vec<String>,
    pub message: Option<String>,
}

/// The H.264 encoders, best first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoder {
    Nvenc,
    Amf,
    Qsv,
    MediaFoundation,
    X264,
}

impl Encoder {
    const ALL: [Encoder; 5] = [
        Encoder::Nvenc,
        Encoder::Amf,
        Encoder::Qsv,
        Encoder::MediaFoundation,
        Encoder::X264,
    ];

    fn codec(self) -> &'static str {
        match self {
            Encoder::Nvenc => "h264_nvenc",
            Encoder::Amf => "h264_amf",
            Encoder::Qsv => "h264_qsv",
            Encoder::MediaFoundation => "h264_mf",
            Encoder::X264 => "libx264",
        }
    }

    /// Media Foundation, AMF and QSV want NV12 frames.
    fn pixels(self) -> &'static str {
        match self {
            Encoder::Amf | Encoder::Qsv | Encoder::MediaFoundation => "nv12",
            Encoder::Nvenc | Encoder::X264 => "yuv420p",
        }
    }

    /// The codec and its rate control, at `bitrate` bits a second (the hardware encoders; x264
    /// aims at a quality instead).
    fn args(self, bitrate: u64) -> Vec<String> {
        let b = bitrate.to_string();
        let max = (bitrate * 2).to_string();
        let mut a: Vec<String> = vec!["-c:v".into(), self.codec().into()];
        let rest: Vec<&str> = match self {
            Encoder::Nvenc => vec![
                "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-b:v", &b, "-maxrate", &max,
                "-bufsize", &max,
            ],
            Encoder::Amf => vec![
                "-quality", "quality", "-rc", "vbr_peak", "-b:v", &b, "-maxrate", &max,
            ],
            Encoder::Qsv => vec!["-preset", "medium", "-b:v", &b, "-maxrate", &max],
            Encoder::MediaFoundation => vec!["-b:v", &b],
            Encoder::X264 => vec!["-preset", "veryfast", "-crf", "20"],
        };
        a.extend(rest.into_iter().map(String::from));
        a
    }
}

/// The bitrate for a picture `width` × `height` at `fps`: about 6 Mbit/s at 1080p30, and in
/// proportion (spike 0.3: hardware encoders score 99+ VMAF there).
fn bitrate(width: u32, height: u32, fps: f64) -> u64 {
    let bits = f64::from(width) * f64::from(height) * fps * 0.1;
    (bits as u64).clamp(2_000_000, 80_000_000)
}

/// What export reads of the open source.
struct Input {
    path: PathBuf,
    rate: Rate,
    /// When each grid frame's source frame starts showing, in seconds on the source's clock.
    starts: Vec<f64>,
    audio_tracks: u32,
    width: u32,
    height: u32,
}

/// A clip as ffmpeg seeks it.
#[derive(Debug, Clone, PartialEq)]
struct Cut {
    /// Where its input is seeked to, in seconds: before its first frame.
    seek: f64,
    from: u32,
    out: u32,
}

/// How far before a clip's first frame its input is seeked: the frame is kept whatever the
/// rounding, and a source frame shown for several grid frames (VFR) is there for `fps`.
const SEEK_EARLY: f64 = 0.5;

fn cuts(starts: &[f64], clips: &[ExportClip]) -> Vec<Cut> {
    clips
        .iter()
        .map(|c| Cut {
            seek: (starts[c.from as usize] - SEEK_EARLY).max(0.0),
            from: c.from,
            out: c.out,
        })
        .collect()
}

/// The ffmpeg arguments for `cuts` of `path`, up to the output file: inputs, the graph, the
/// encoder and the container.
fn args(
    path: &Path,
    cuts: &[Cut],
    rate: Rate,
    origin: f64,
    audio_tracks: u32,
    encoder: Encoder,
    bitrate: u64,
) -> Vec<OsString> {
    let fps = rate.fps();
    let mut a: Vec<OsString> = Vec::new();
    for c in cuts {
        a.extend(["-ss".into(), format!("{:.6}", c.seek).into()]);
        a.extend(["-i".into(), path.as_os_str().to_owned()]);
    }
    let mut f: Vec<String> = Vec::new();
    for (i, c) in cuts.iter().enumerate() {
        // Back on the source's clock from its first shown frame, then onto the grid, then the
        // clip's grid frames (`fps` gives frame k the timestamp k).
        f.push(format!(
            "[{i}:v:0]setpts=PTS+({:.6})/TB,fps={}/{},trim=start_pts={}:end_pts={},setpts=PTS-STARTPTS[v{i}]",
            c.seek - origin,
            rate.num,
            rate.den,
            c.from,
            c.out
        ));
        if audio_tracks > 0 {
            let tracks: String = (0..audio_tracks).map(|t| format!("[{i}:a:{t}]")).collect();
            let mix = if audio_tracks > 1 {
                format!("amix=inputs={audio_tracks}:normalize=0:duration=longest,")
            } else {
                String::new()
            };
            // The same stretch of time: from grid frame `from` on the source's clock, which
            // the seek put at 0.
            let start = (origin + f64::from(c.from) / fps - c.seek).max(0.0);
            let length = f64::from(c.out - c.from) / fps;
            f.push(format!(
                "{tracks}{mix}atrim=start={start:.6}:duration={length:.6},asetpts=PTS-STARTPTS[a{i}]"
            ));
        }
    }
    let n = cuts.len();
    let audio = audio_tracks > 0;
    let joined: String = (0..n)
        .map(|i| {
            if audio {
                format!("[v{i}][a{i}]")
            } else {
                format!("[v{i}]")
            }
        })
        .collect();
    f.push(format!(
        "{joined}concat=n={n}:v=1:a={}[vc]{}",
        u8::from(audio),
        if audio { "[ac]" } else { "" }
    ));
    // Even dimensions, as 4:2:0 needs.
    f.push(format!(
        "[vc]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format={}[vout]",
        encoder.pixels()
    ));
    a.extend(["-filter_complex".into(), f.join(";").into()]);
    a.extend(["-map", "[vout]"].map(OsString::from));
    if audio {
        a.extend(["-map", "[ac]", "-c:a", "aac", "-b:a", "192k"].map(OsString::from));
    }
    a.extend(encoder.args(bitrate).into_iter().map(OsString::from));
    a.extend(
        [
            "-fps_mode",
            "passthrough",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ]
        .map(OsString::from),
    );
    a
}

// --- the encoder ---

/// Finds the encoders that work here, best first, on a thread (at startup): a moment's test
/// encode with each.
pub fn probe(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let found = encoders_here();
        eprintln!(
            "[export] encoders: {}",
            found
                .iter()
                .map(|e| e.codec())
                .collect::<Vec<_>>()
                .join(", ")
        );
        *app.state::<AppState>().encoders.lock().unwrap() = Some(found);
    });
}

fn encoders_here() -> Vec<Encoder> {
    Encoder::ALL
        .into_iter()
        .filter(|&e| e == Encoder::X264 || encodes(e))
        .collect()
}

/// Whether `encoder` can encode a few frames here (hardware encoders fail to open without
/// their hardware).
fn encodes(encoder: Encoder) -> bool {
    let Ok(mut cmd) = sidecar::command(Tool::Ffmpeg) else {
        return false;
    };
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=256x256:r=30:d=0.2",
        "-pix_fmt",
        encoder.pixels(),
    ])
    .args(encoder.args(2_000_000))
    .args(["-f", "null", "-"])
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null());
    sidecar::spawn(&mut cmd)
        .and_then(|mut c| c.wait())
        .is_ok_and(|s| s.success())
}

/// The encoders to try, best first (found at startup; found now if that isn't done yet).
fn encoders(app: &AppHandle) -> Vec<Encoder> {
    if let Some(found) = app.state::<AppState>().encoders.lock().unwrap().clone() {
        return found;
    }
    let found = encoders_here();
    *app.state::<AppState>().encoders.lock().unwrap() = Some(found.clone());
    found
}

// --- exporting ---

/// The open source, as export reads it.
fn input(app: &AppHandle) -> Result<Input, String> {
    let state = app.state::<AppState>();
    let open = state.source.lock().unwrap();
    let s = open.as_ref().ok_or("No video is open.")?;
    let (w, h) = (s.info.width, s.info.height);
    let (width, height) = if s.info.rotation % 180 == 90 {
        (h, w)
    } else {
        (w, h)
    };
    Ok(Input {
        path: s.path.clone(),
        rate: s.grid.rate,
        starts: grid::times(&s.info.video, &s.grid)
            .into_iter()
            .map(|(start, _)| start)
            .collect(),
        audio_tracks: s.info.audio_tracks,
        width,
        height,
    })
}

/// Renders `clips` of the open source to `output`, blocking: the best encoder, then the next
/// if one fails. `progress` gets 0 to 1.
pub fn render(
    app: &AppHandle,
    clips: &[ExportClip],
    output: &Path,
    mut progress: impl FnMut(f64),
    stop: &AtomicBool,
) -> Result<Outcome, String> {
    let input = input(app)?;
    if clips.is_empty() {
        return Err("There's nothing to export.".into());
    }
    if clips
        .iter()
        .any(|c| c.from >= c.out || c.out as usize > input.starts.len())
    {
        return Err("The edit doesn't fit the video.".into());
    }
    if output == input.path {
        return Err("The export can't replace the video it's made from.".into());
    }
    let frames: u64 = clips.iter().map(|c| u64::from(c.out - c.from)).sum();
    let cuts = cuts(&input.starts, clips);
    let rate = bitrate(input.width, input.height, input.rate.fps());
    let mut last = String::new();
    for encoder in encoders(app) {
        let a = args(
            &input.path,
            &cuts,
            input.rate,
            input.starts[0],
            input.audio_tracks,
            encoder,
            rate,
        );
        let started = Instant::now();
        match ffmpeg::run_now(&a, output, Some(frames), &mut progress, || {
            stop.load(Ordering::Relaxed)
        }) {
            Ok(done) => {
                if matches!(done, Outcome::Finished) {
                    eprintln!(
                        "[export] {} with {} in {:.1} s",
                        output.display(),
                        encoder.codec(),
                        started.elapsed().as_secs_f64()
                    );
                }
                return Ok(done);
            }
            Err(e) => {
                eprintln!("[export] {} failed: {e}", encoder.codec());
                last = e;
            }
        }
    }
    Err(last)
}

/// A file to write: its clips and where.
pub struct Job {
    pub clips: Vec<ExportClip>,
    pub output: PathBuf,
}

/// Exports `jobs` one after another on a thread, with progress events, then `ExportEnded`. One
/// export at a time: false if one is under way.
pub fn start(app: &AppHandle, jobs: Vec<Job>) -> bool {
    let stop = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<AppState>();
        let mut exporting = state.exporting.lock().unwrap();
        if exporting.is_some() {
            return false;
        }
        *exporting = Some(stop.clone());
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let n = jobs.len() as f64;
        let mut files = Vec::new();
        let mut message = None;
        for (k, job) in jobs.iter().enumerate() {
            let name = file_name(&job.output);
            let progress = |done: f64| {
                let _ = ExportProgress {
                    name: name.clone(),
                    done: (k as f64 + done) / n,
                }
                .emit_to(&app, LABEL);
            };
            progress(0.0);
            match render(&app, &job.clips, &job.output, progress, &stop) {
                Ok(Outcome::Finished) => files.push(job.output.display().to_string()),
                Ok(Outcome::Stopped) => break,
                Err(e) => {
                    message = Some(format!("{name} couldn't be exported ({e})."));
                    break;
                }
            }
        }
        *app.state::<AppState>().exporting.lock().unwrap() = None;
        let _ = ExportEnded { files, message }.emit_to(&app, LABEL);
    });
    true
}

/// An export is under way.
fn busy(app: &AppHandle) -> bool {
    app.state::<AppState>().exporting.lock().unwrap().is_some()
}

/// The status bar's Cancel: stops the export under way.
pub fn cancel(app: &AppHandle) {
    if let Some(stop) = app.state::<AppState>().exporting.lock().unwrap().as_ref() {
        stop.store(true, Ordering::Relaxed);
    }
}

// --- where to ---

/// The open source's file name without its extension, for naming exports.
fn stem(app: &AppHandle) -> Option<(String, PathBuf)> {
    let state = app.state::<AppState>();
    let open = state.source.lock().unwrap();
    let s = open.as_ref()?;
    let name = s
        .path
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "export".into());
    Some((
        name,
        s.path.parent().map(Path::to_path_buf).unwrap_or_default(),
    ))
}

/// The file name for the whole timeline, or for clip `n`.
fn export_name(stem: &str, clip: Option<u32>) -> String {
    match clip {
        Some(n) => format!("{stem}-clip{n:02}.mp4"),
        None => format!("{stem}-edit.mp4"),
    }
}

/// `name` in `folder`, numbered ("name (2).mp4") if it's taken.
fn free_name(folder: &Path, name: &str) -> PathBuf {
    let first = folder.join(name);
    if !first.exists() {
        return first;
    }
    let path = Path::new(name);
    let base = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    (2..)
        .map(|k| folder.join(format!("{base} ({k}).{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// Asks where to save the timeline (`clip` None) or one clip, with the Save dialog, starting in
/// the folder last saved to; then exports. False if it didn't start (cancelled, or busy).
pub fn ask_and_export(app: &AppHandle, clips: Vec<ExportClip>, clip: Option<u32>) -> bool {
    use tauri_plugin_dialog::DialogExt;
    let Some((stem, source_folder)) = stem(app).filter(|_| !busy(app)) else {
        return false;
    };
    let mut dialog = app
        .dialog()
        .file()
        .set_title(if clip.is_some() {
            "Export clip"
        } else {
            "Export"
        })
        .add_filter("MP4 video", &["mp4"])
        .set_file_name(export_name(&stem, clip));
    if let Some(start) = crate::folders::export_start(app, &source_folder) {
        dialog = dialog.set_directory(start);
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        dialog = dialog.set_parent(&window);
    }
    let Some(mut output) = dialog.blocking_save_file().and_then(|p| p.into_path().ok()) else {
        return false;
    };
    if output.extension().is_none() {
        output.set_extension("mp4");
    }
    if let Some(folder) = output.parent() {
        crate::folders::saved_to(app, folder);
    }
    start(app, vec![Job { clips, output }])
}

/// Asks for a folder, then exports each clip as its own file there (named by its number; a
/// name already taken gets one of its own).
pub fn ask_and_export_each(app: &AppHandle, clips: Vec<ExportClip>) -> bool {
    use tauri_plugin_dialog::DialogExt;
    let Some((stem, source_folder)) = stem(app).filter(|_| !busy(app)) else {
        return false;
    };
    let mut dialog = app.dialog().file().set_title("Export each clip to");
    if let Some(start) = crate::folders::export_start(app, &source_folder) {
        dialog = dialog.set_directory(start);
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        dialog = dialog.set_parent(&window);
    }
    let Some(folder) = dialog
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
    else {
        return false;
    };
    crate::folders::saved_to(app, &folder);
    let jobs = clips
        .into_iter()
        .map(|c| Job {
            output: free_name(&folder, &export_name(&stem, Some(c.id))),
            clips: vec![c],
        })
        .collect();
    start(app, jobs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn joined(a: &[OsString]) -> String {
        a.iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn each_clip_is_seeked_before_its_first_frame() {
        let starts: Vec<f64> = (0..300).map(|k| f64::from(k) / 30.0).collect();
        let clips = [
            ExportClip {
                id: 1,
                from: 0,
                out: 30,
            },
            ExportClip {
                id: 2,
                from: 240,
                out: 270,
            },
        ];
        let c = cuts(&starts, &clips);
        assert_eq!(c[0].seek, 0.0);
        assert!((c[1].seek - 7.5).abs() < 1e-9);
    }

    #[test]
    fn the_graph_puts_clips_on_the_grid_and_joins_them() {
        let c = [
            Cut {
                seek: 0.0,
                from: 0,
                out: 30,
            },
            Cut {
                seek: 7.5,
                from: 240,
                out: 270,
            },
        ];
        let rate = Rate { num: 30, den: 1 };
        let a = joined(&args(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            1,
            Encoder::X264,
            6_000_000,
        ));
        assert!(a.starts_with("-ss 0.000000 -i in.mp4 -ss 7.500000 -i in.mp4"));
        assert!(a.contains(
            "[1:v:0]setpts=PTS+(7.500000)/TB,fps=30/1,trim=start_pts=240:end_pts=270,setpts=PTS-STARTPTS[v1]"
        ));
        // Frame 240 is 8 s in; the seek put 7.5 s at 0.
        assert!(
            a.contains("[1:a:0]atrim=start=0.500000:duration=1.000000,asetpts=PTS-STARTPTS[a1]")
        );
        assert!(a.contains("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][ac]"));
        assert!(a.contains("format=yuv420p[vout]"));
        assert!(a.contains("-c:v libx264"));
    }

    #[test]
    fn several_audio_tracks_are_mixed_and_none_is_none() {
        let c = [Cut {
            seek: 0.0,
            from: 0,
            out: 30,
        }];
        let rate = Rate { num: 30, den: 1 };
        let two = joined(&args(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            2,
            Encoder::Nvenc,
            6_000_000,
        ));
        assert!(two.contains("[0:a:0][0:a:1]amix=inputs=2:normalize=0:duration=longest,atrim="));
        let none = joined(&args(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            0,
            Encoder::Nvenc,
            6_000_000,
        ));
        assert!(none.contains("[v0]concat=n=1:v=1:a=0[vc];"));
        assert!(!none.contains("[ac]"));
        assert!(!none.contains("-c:a"));
    }

    #[test]
    fn a_late_first_frame_shifts_the_clock() {
        // The first shown frame at 0.1 s: the grid counts from there.
        let c = [Cut {
            seek: 1.6,
            from: 60,
            out: 90,
        }];
        let rate = Rate { num: 30, den: 1 };
        let a = joined(&args(
            Path::new("in.mp4"),
            &c,
            rate,
            0.1,
            1,
            Encoder::X264,
            6_000_000,
        ));
        assert!(a.contains("setpts=PTS+(1.500000)/TB"));
        assert!(a.contains("atrim=start=0.500000"));
    }

    #[test]
    fn bitrate_follows_the_picture() {
        assert_eq!(bitrate(1920, 1080, 30.0), 6_220_800);
        assert_eq!(bitrate(320, 240, 30.0), 2_000_000);
        assert_eq!(bitrate(7680, 4320, 120.0), 80_000_000);
    }

    #[test]
    fn names() {
        assert_eq!(export_name("trip", None), "trip-edit.mp4");
        assert_eq!(export_name("trip", Some(3)), "trip-clip03.mp4");
        assert_eq!(export_name("trip", Some(12)), "trip-clip12.mp4");
    }
}
