//! The proxy: a small copy of the open source for stepping and scrubbing (spike 0.2). ffmpeg
//! makes it in the background on open: 540 lines on the short side, H.264 with a keyframe every
//! 10 frames, upright, and at the timeline rate, so proxy frame k is timeline frame k (the `fps`
//! filter picks the same pictures as the grid and export). Playing and the paused picture use
//! the original; the proxy is what moves while you step and scrub.
//!
//! Proxies are cached by file (path, size and modified time), so opening a file again finds its
//! proxy ready. The cache drops the least recently used past its size limit.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Instant, SystemTime};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::editor::LABEL;
use crate::media::grid::Rate;
use crate::sidecar::{self, Tool};
use crate::state::AppState;

/// Changes when the proxy's recipe does, so old proxies aren't used.
const RECIPE: &str = "h264 540 g10 crf26 v1";
/// The cache's size limit (1.5b: a setting).
const LIMIT: u64 = 5_000_000_000;
/// Progress events at most this often.
const PROGRESS_EVERY_MS: u128 = 250;

/// Rust → editor: the proxy for a source is this far along.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ProxyProgress {
    /// The source it's for (its `SourceInfo::url`).
    pub source: String,
    /// 0 to 1.
    pub done: f64,
}

/// Rust → editor: the proxy for a source is ready.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ProxyReady {
    pub source: String,
    /// Where the page reads it (see protocol.rs).
    pub url: String,
}

/// Rust → editor: the proxy couldn't be made. Stepping stays on the original.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ProxyFailed {
    pub source: String,
    /// A sentence for the user.
    pub message: String,
}

/// Where proxies are kept (1.5b: a setting).
fn folder(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("proxies"))
        .map_err(|e| eprintln!("[proxy] no local data folder: {e}"))
        .ok()
}

/// The proxy's file for `source`: named by a hash of what identifies the file's contents.
fn file_for(folder: &Path, source: &Path) -> Option<PathBuf> {
    let meta = fs::metadata(source).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let path = source.to_string_lossy().to_lowercase();
    let key = fnv1a(&[
        path.as_bytes(),
        &meta.len().to_le_bytes(),
        &modified.to_le_bytes(),
        RECIPE.as_bytes(),
    ]);
    Some(folder.join(format!("{key:016x}.mp4")))
}

/// FNV-1a, 64-bit: stable across runs and Rust versions (std's hasher isn't).
fn fnv1a(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for &b in *part {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        // Separates the parts, so ("ab", "c") and ("a", "bc") differ.
        h ^= 0xff;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// The source's proxy if it's in the cache (marked as just used), else `None`.
pub fn cached(app: &AppHandle, source: &Path) -> Option<PathBuf> {
    let file = file_for(&folder(app)?, source)?;
    let f = fs::File::options().write(true).open(&file).ok()?;
    let _ = f.set_modified(SystemTime::now());
    Some(file)
}

/// Makes the proxy for the source opened as `generation`, on a thread. It stops if another
/// file is opened meanwhile.
pub fn make(app: &AppHandle, generation: u64, source: PathBuf, rate: Rate, frames: u32) {
    let app = app.clone();
    std::thread::spawn(move || {
        let url = crate::protocol::source_url(generation);
        let started = Instant::now();
        match run(&app, generation, &source, rate, frames, &url) {
            Ok(Some(file)) => {
                eprintln!(
                    "[proxy] made {} in {:.1} s",
                    file.display(),
                    started.elapsed().as_secs_f64()
                );
                let state = app.state::<AppState>();
                let mut open = state.source.lock().unwrap();
                if let Some(s) = open.as_mut().filter(|s| s.generation == generation) {
                    s.proxy = Some(file.clone());
                    drop(open);
                    let _ = ProxyReady {
                        source: url,
                        url: crate::protocol::proxy_url(generation),
                    }
                    .emit_to(&app, LABEL);
                }
                if let Some(parent) = file.parent() {
                    trim(parent, &file);
                }
            }
            // Another file was opened.
            Ok(None) => eprintln!("[proxy] stopped for {}", source.display()),
            Err(message) => {
                eprintln!("[proxy] {}: {message}", source.display());
                let _ = ProxyFailed {
                    source: url,
                    message: format!(
                        "Couldn't make the preview copy, so stepping may be slow ({message})."
                    ),
                }
                .emit_to(&app, LABEL);
            }
        }
    });
}

/// Runs ffmpeg. `Ok(None)` if it was stopped because another file was opened.
fn run(
    app: &AppHandle,
    generation: u64,
    source: &Path,
    rate: Rate,
    frames: u32,
    url: &str,
) -> Result<Option<PathBuf>, String> {
    let folder = folder(app).ok_or("no local data folder")?;
    fs::create_dir_all(&folder).map_err(|e| format!("can't make {}: {e}", folder.display()))?;
    let file = file_for(&folder, source).ok_or("can't read the file's details")?;
    // Leftovers from a run that was stopped or crashed.
    remove_parts(&folder);
    let part = file.with_extension("part");

    let mut cmd = sidecar::background(Tool::Ffmpeg)?;
    cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i"])
        .arg(source)
        .args(["-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1"])
        .arg("-vf")
        .arg(format!(
            // Upright (ffmpeg turns it by default), on the grid, 540 on the short side.
            "fps={}/{},scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)':flags=bilinear,format=yuv420p",
            rate.num, rate.den
        ))
        .args(["-frames:v", &frames.to_string()])
        .args(["-c:v", "libx264", "-preset", "ultrafast", "-tune", "fastdecode"])
        .args(["-bf", "0", "-g", "10", "-crf", "26"])
        .args(["-movflags", "+faststart", "-f", "mp4"])
        .args(["-progress", "pipe:1", "-stats_period", "0.25"])
        .arg(&part)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = sidecar::spawn(&mut cmd).map_err(|e| format!("ffmpeg didn't start: {e}"))?;

    let stdout = child.stdout.take().ok_or("no output from ffmpeg")?;
    let mut last = Instant::now();
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if !still_open(app, generation) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&part);
            return Ok(None);
        }
        if let Some(n) = progress_frame(&line) {
            if last.elapsed().as_millis() >= PROGRESS_EVERY_MS {
                last = Instant::now();
                let _ = ProxyProgress {
                    source: url.to_string(),
                    done: (n as f64 / f64::from(frames.max(1))).min(1.0),
                }
                .emit_to(app, LABEL);
            }
        }
    }
    let mut errors = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = std::io::Read::read_to_string(&mut stderr, &mut errors);
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let _ = fs::remove_file(&part);
        let why = errors.lines().last().unwrap_or("").trim();
        return Err(if why.is_empty() {
            format!("ffmpeg {status}")
        } else {
            why.to_string()
        });
    }
    fs::rename(&part, &file).map_err(|e| format!("can't keep the proxy: {e}"))?;
    Ok(Some(file))
}

fn still_open(app: &AppHandle, generation: u64) -> bool {
    let state = app.state::<AppState>();
    let open = state.source.lock().unwrap();
    open.as_ref().is_some_and(|s| s.generation == generation)
}

/// The frame count in a `-progress` line (`frame=123`).
fn progress_frame(line: &str) -> Option<u64> {
    line.strip_prefix("frame=")?.trim().parse().ok()
}

fn remove_parts(folder: &Path) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    for e in entries.flatten() {
        if e.path().extension().is_some_and(|x| x == "part") {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// Drops the least recently used proxies until the cache is within its limit, never `keep`.
fn trim(folder: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    let files: Vec<(PathBuf, u64, SystemTime)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "mp4"))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((e.path(), m.len(), m.modified().ok()?))
        })
        .collect();
    for path in to_drop(files, LIMIT, keep) {
        eprintln!("[proxy] dropping {} (cache full)", path.display());
        let _ = fs::remove_file(path);
    }
}

/// Which files to drop, oldest use first, to bring the total within `limit`; never `keep`.
fn to_drop(mut files: Vec<(PathBuf, u64, SystemTime)>, limit: u64, keep: &Path) -> Vec<PathBuf> {
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.2);
    let mut drop = Vec::new();
    for (path, size, _) in files {
        if total <= limit {
            break;
        }
        if path == keep {
            continue;
        }
        total -= size;
        drop.push(path);
    }
    drop
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn hashes_are_stable_and_part_aware() {
        assert_eq!(fnv1a(&[]), 0xcbf2_9ce4_8422_2325);
        assert_ne!(fnv1a(&[b"ab", b"c"]), fnv1a(&[b"a", b"bc"]));
        assert_eq!(fnv1a(&[b"clip"]), fnv1a(&[b"clip"]));
    }

    #[test]
    fn reads_progress_lines() {
        assert_eq!(progress_frame("frame=123"), Some(123));
        assert_eq!(progress_frame("frame= 7"), Some(7));
        assert_eq!(progress_frame("fps=30.0"), None);
    }

    #[test]
    fn drops_the_least_recently_used_until_within_the_limit() {
        let t = |s| SystemTime::UNIX_EPOCH + Duration::from_secs(s);
        let files = vec![
            (PathBuf::from("new"), 40, t(300)),
            (PathBuf::from("old"), 40, t(100)),
            (PathBuf::from("mid"), 40, t(200)),
        ];
        assert_eq!(
            to_drop(files.clone(), 100, Path::new("new")),
            [PathBuf::from("old")]
        );
        assert_eq!(
            to_drop(files.clone(), 30, Path::new("old")),
            [PathBuf::from("mid"), PathBuf::from("new")]
        );
        assert!(to_drop(files, 120, Path::new("new")).is_empty());
    }
}
