//! Conversion on open: a copy of the source that Razorcat can index and the preview can play,
//! made by ffmpeg when the original can't be. Export still reads the original.
//!
//! - **Before opening** (`before_open`): files the MP4 index can't read (MKV, WebM, fragmented
//!   MP4, GIF...). Their streams are copied into an MP4 (seconds), the audio re-encoded if MP4
//!   can't hold it, and the video only if it must (GIF, always).
//! - **After opening** (`for_preview`): a codec the preview can't play (HEVC without Microsoft's
//!   extension, ProRes...). The page reports it; the video is re-encoded to H.264.
//!
//! Timestamps are kept as they are (`-fps_mode passthrough`), so the copy has the original's
//! frames at the original's times, and the timeline grid is the same either way. Copies are
//! cached with the proxies (proxy.rs), so a file opens at once next time.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::editor::LABEL;
use crate::ffmpeg::{self, Outcome};
use crate::proxy;
use crate::source::file_name;
use crate::state::AppState;

/// The copy's recipes, part of its cache key (change them when the commands change).
const REMUX: &str = "playable remux v1";
const TRANSCODE: &str = "playable h264 crf18 v1";

/// Rust → editor: a conversion is this far along.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ConvertProgress {
    /// The file being converted, for the status bar.
    pub name: String,
    /// 0 to 1.
    pub done: f64,
}

/// Rust → editor: a conversion ended without a copy: cancelled (or replaced by another file
/// being opened), or failed (`message` says why, for the user).
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ConvertEnded {
    pub name: String,
    pub message: Option<String>,
}

/// What a conversion is for.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    /// The streams into an MP4, re-encoding only what MP4 can't hold.
    Remux,
    /// The video to H.264.
    Transcode,
}

/// The copy to open in place of `path`, which the MP4 index can't read: from the cache, or
/// made now (blocking, with progress events). `Ok(None)` if it was cancelled.
pub fn before_open(app: &AppHandle, path: &Path) -> Result<Option<PathBuf>, String> {
    let gif = path
        .extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("gif"));
    if let Some(copy) = cached(app, path) {
        return Ok(Some(copy));
    }
    let kind = if gif { Kind::Transcode } else { Kind::Remux };
    convert(app, path, kind)
}

/// A copy of `path` the preview has already needed (its codec): from the cache only.
pub fn cached_for_preview(app: &AppHandle, path: &Path) -> Option<PathBuf> {
    proxy::find(app, path, TRANSCODE)
}

/// Either copy, from the cache.
fn cached(app: &AppHandle, path: &Path) -> Option<PathBuf> {
    proxy::find(app, path, REMUX).or_else(|| proxy::find(app, path, TRANSCODE))
}

/// The page can't play the open source (`url`): re-encodes it on a thread, then sends the
/// source again (`SourceConverted`) with its copy's URL.
pub fn for_preview(app: &AppHandle, url: String) {
    let open = {
        let state = app.state::<AppState>();
        let source = state.sources.lock().unwrap();
        source
            .iter()
            .find(|s| s.info().url == url)
            .map(|s| (s.generation, s.path.clone()))
    };
    let Some((generation, path)) = open else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let made = match cached_for_preview(&app, &path) {
            Some(copy) => Ok(Some(copy)),
            None => convert(&app, &path, Kind::Transcode),
        };
        let Ok(Some(copy)) = made else {
            return;
        };
        let state = app.state::<AppState>();
        let mut source = state.sources.lock().unwrap();
        if let Some(s) = source.iter_mut().find(|s| s.generation == generation) {
            s.playable = Some(copy);
            let info = s.info();
            drop(source);
            let _ = crate::editor::SourceConverted(info).emit_to(&app, LABEL);
        }
    });
}

/// Cancels the conversion under way, if any (the status bar's Cancel).
pub fn cancel(app: &AppHandle) {
    if let Some(flag) = app.state::<AppState>().converting.lock().unwrap().take() {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Converts `path`, blocking. A conversion already under way is cancelled: only the latest file
/// asked for is converted. `Ok(None)` if cancelled; errors are also sent (`ConvertEnded`).
fn convert(app: &AppHandle, path: &Path, kind: Kind) -> Result<Option<PathBuf>, String> {
    let name = file_name(path);
    let stop = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<AppState>();
        let mut converting = state.converting.lock().unwrap();
        if let Some(old) = converting.replace(stop.clone()) {
            old.store(true, Ordering::Relaxed);
        }
    }
    let started = Instant::now();
    let result = attempts(app, path, kind, &name, &stop);
    // Done: no longer the one Cancel stops (unless another has taken its place).
    {
        let state = app.state::<AppState>();
        let mut converting = state.converting.lock().unwrap();
        if converting.as_ref().is_some_and(|c| Arc::ptr_eq(c, &stop)) {
            *converting = None;
        }
    }
    match &result {
        Ok(Some(copy)) => {
            eprintln!(
                "[convert] {} in {:.1} s: {}",
                path.display(),
                started.elapsed().as_secs_f64(),
                copy.display()
            );
            if let Some(folder) = copy.parent() {
                proxy::trim(folder, std::slice::from_ref(copy), proxy::limit(app));
            }
        }
        Ok(None) => {
            eprintln!("[convert] stopped: {}", path.display());
            let _ = ConvertEnded {
                name,
                message: None,
            }
            .emit_to(app, LABEL);
        }
        Err(e) => {
            eprintln!("[convert] {}: {e}", path.display());
            let _ = ConvertEnded {
                name: name.clone(),
                message: Some(format!("{name} couldn't be converted to play here ({e}).")),
            }
            .emit_to(app, LABEL);
        }
    }
    result
}

/// Remux: copy everything; failing that, the audio as AAC; failing that, re-encode (as
/// Transcode). Transcode: re-encode the video, the audio as AAC.
fn attempts(
    app: &AppHandle,
    path: &Path,
    kind: Kind,
    name: &str,
    stop: &AtomicBool,
) -> Result<Option<PathBuf>, String> {
    let folder = proxy::folder(app).ok_or("no local data folder")?;
    std::fs::create_dir_all(&folder)
        .map_err(|e| format!("can't make {}: {e}", folder.display()))?;
    let progress = |done: f64| {
        let _ = ConvertProgress {
            name: name.to_string(),
            done,
        }
        .emit_to(app, LABEL);
    };
    let stopped = || stop.load(Ordering::Relaxed);
    let mut last_error = String::new();
    let plans: &[(&str, &[&str])] = match kind {
        Kind::Remux => &[
            (REMUX, &["-c", "copy"]),
            (REMUX, &["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"]),
            (TRANSCODE, H264),
        ],
        Kind::Transcode => &[(TRANSCODE, H264)],
    };
    for (recipe, codecs) in plans {
        let file =
            proxy::file_for(&folder, path, recipe, "mp4").ok_or("can't read the file's details")?;
        let mut args: Vec<OsString> = vec!["-i".into(), path.into()];
        args.extend(
            [
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-sn",
                "-dn",
                "-fps_mode",
                "passthrough",
            ]
            .map(OsString::from),
        );
        args.extend(codecs.iter().map(OsString::from));
        args.extend(["-movflags", "+faststart", "-f", "mp4"].map(OsString::from));
        match ffmpeg::run(&args, &file, None, progress, stopped) {
            Ok(Outcome::Finished) => return Ok(Some(file)),
            Ok(Outcome::Stopped) => return Ok(None),
            Err(e) => {
                eprintln!("[convert] {recipe} {codecs:?} failed: {e}");
                last_error = e;
            }
        }
    }
    Err(last_error)
}

/// The video to H.264 at near the original's quality (even dimensions, as yuv420p needs).
const H264: &[&str] = &[
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
];
