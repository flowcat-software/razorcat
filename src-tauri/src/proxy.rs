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
use crate::settings::Proxies;
use crate::sidecar::{self, Tool};
use crate::state::AppState;

/// Changes when the proxy's recipe does, so old proxies aren't used.
const RECIPE: &str = "h264 540 g10 crf26 v1";
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

/// Rust → editor: the proxy stopped being made (proxies were turned off, or another file opened).
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStopped {
    pub source: String,
}

/// Rust → editor: the proxy couldn't be made. Stepping stays on the original.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ProxyFailed {
    pub source: String,
    /// A sentence for the user.
    pub message: String,
}

/// Where proxies are kept unless Settings say otherwise: in local app data.
pub fn default_folder(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("proxies"))
        .map_err(|e| eprintln!("[proxy] no local data folder: {e}"))
        .ok()
}

/// Where proxies are kept, per these settings.
fn folder_for(app: &AppHandle, settings: &Proxies) -> Option<PathBuf> {
    if settings.folder.is_empty() {
        default_folder(app)
    } else {
        Some(crate::paths::resolve_dir(&settings.folder))
    }
}

fn settings(app: &AppHandle) -> Proxies {
    app.state::<AppState>()
        .settings
        .read()
        .unwrap()
        .proxies
        .clone()
}

/// Settings › Proxies › Use proxies.
pub fn enabled(app: &AppHandle) -> bool {
    settings(app).enabled
}

fn folder(app: &AppHandle) -> Option<PathBuf> {
    folder_for(app, &settings(app))
}

fn limit(app: &AppHandle) -> u64 {
    u64::from(settings(app).limit_gb) * 1_000_000_000
}

/// Settings › Proxies changed: a new folder gets the proxies already made (so none are lost),
/// and a lower limit trims the cache now.
pub fn settings_changed(app: &AppHandle, old: &Proxies, new: &Proxies) {
    // Turned on: the open video gets its proxy. (Turned off: one being made stops itself.)
    if new.enabled && !old.enabled {
        resume(app);
    }
    let (Some(from), Some(to)) = (folder_for(app, old), folder_for(app, new)) else {
        return;
    };
    if from == to {
        // Deleting files is quick: done before the page reads the cache's size again.
        trim(&to, open_proxy(app).as_deref(), limit(app));
        return;
    }
    // Copying to another drive may take a while.
    let app = app.clone();
    std::thread::spawn(move || {
        move_cache(&app, &from, &to);
        trim(&to, open_proxy(&app).as_deref(), limit(&app));
    });
}

/// Gives the open source its proxy: from the cache, or made now.
fn resume(app: &AppHandle) {
    let wanted = {
        let state = app.state::<AppState>();
        let open = state.source.lock().unwrap();
        open.as_ref()
            .filter(|s| s.proxy.is_none())
            .map(|s| (s.generation, s.path.clone(), s.grid.rate, s.grid.frames))
    };
    let Some((generation, path, rate, frames)) = wanted else {
        return;
    };
    let Some(file) = cached(app, &path) else {
        make(app, generation, path, rate, frames);
        return;
    };
    let state = app.state::<AppState>();
    let mut open = state.source.lock().unwrap();
    if let Some(s) = open.as_mut().filter(|s| s.generation == generation) {
        s.proxy = Some(file);
        drop(open);
        let _ = ProxyReady {
            source: crate::protocol::source_url(generation),
            url: crate::protocol::proxy_url(generation),
        }
        .emit_to(app, LABEL);
    }
}

/// The open source's proxy, if it has one.
fn open_proxy(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<AppState>();
    let open = state.source.lock().unwrap();
    open.as_ref().and_then(|s| s.proxy.clone())
}

/// Moves the proxies from one folder to another: a rename on the same drive, else a copy.
fn move_cache(app: &AppHandle, from: &Path, to: &Path) {
    let Ok(entries) = fs::read_dir(from) else {
        return;
    };
    if let Err(e) = fs::create_dir_all(to) {
        eprintln!("[proxy] can't make {}: {e}", to.display());
        return;
    }
    let started = Instant::now();
    let mut moved = 0;
    for e in entries.flatten() {
        let old = e.path();
        if !is_proxy(&old) {
            continue;
        }
        let new = to.join(e.file_name());
        let ok = fs::rename(&old, &new).is_ok()
            || (fs::copy(&old, &new).is_ok() && fs::remove_file(&old).is_ok());
        if !ok {
            eprintln!("[proxy] couldn't move {}", old.display());
            let _ = fs::remove_file(&new);
            continue;
        }
        moved += 1;
        // The open source's proxy is read from its new place from now on.
        let state = app.state::<AppState>();
        let mut open = state.source.lock().unwrap();
        if let Some(s) = open.as_mut().filter(|s| s.proxy.as_deref() == Some(&old)) {
            s.proxy = Some(new);
        }
    }
    eprintln!(
        "[proxy] moved {moved} to {} in {:.1} s",
        to.display(),
        started.elapsed().as_secs_f64()
    );
    // The old folder, if that left it empty (ours, or one the user made for proxies).
    let _ = fs::remove_dir(from);
}

/// A proxy's file name: 16 hex digits and `.mp4` (`file_for`). Nothing else in the folder is
/// ever moved or deleted, whatever folder the user picks.
fn is_proxy(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.strip_suffix(".mp4")
        .or_else(|| name.strip_suffix(".part"))
        .is_some_and(|stem| stem.len() == 16 && stem.chars().all(|c| c.is_ascii_hexdigit()))
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
                    trim(parent, Some(&file), limit(&app));
                }
            }
            // Another file was opened, or proxies were turned off.
            Ok(None) => {
                eprintln!("[proxy] stopped for {}", source.display());
                let _ = ProxyStopped { source: url }.emit_to(&app, LABEL);
            }
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
        if !still_open(app, generation) || !enabled(app) {
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
        if is_proxy(&e.path()) && e.path().extension().is_some_and(|x| x == "part") {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// The cache's size, and what a limit would drop (Settings asks before lowering it).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CacheReport {
    /// Bytes the proxies take up.
    pub bytes: f64,
    pub files: u32,
    /// What `limit_gb` would delete: how many proxies, and their bytes.
    pub dropping: u32,
    pub dropping_bytes: f64,
}

pub fn report(app: &AppHandle, limit_gb: u32) -> CacheReport {
    let files = folder(app).map(|f| cached_files(&f)).unwrap_or_default();
    let keep = open_proxy(app);
    let drop = to_drop(
        files.clone(),
        u64::from(limit_gb) * 1_000_000_000,
        keep.as_deref(),
    );
    let size = |p: &PathBuf| files.iter().find(|f| &f.0 == p).map_or(0, |f| f.1);
    CacheReport {
        bytes: files.iter().map(|f| f.1).sum::<u64>() as f64,
        files: files.len() as u32,
        dropping: drop.len() as u32,
        dropping_bytes: drop.iter().map(size).sum::<u64>() as f64,
    }
}

/// The finished proxies in `folder`: path, size, last used.
fn cached_files(folder: &Path) -> Vec<(PathBuf, u64, SystemTime)> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| is_proxy(&e.path()) && e.path().extension().is_some_and(|x| x == "mp4"))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((e.path(), m.len(), m.modified().ok()?))
        })
        .collect()
}

/// Drops the least recently used proxies until the cache is within `limit`, never `keep`.
fn trim(folder: &Path, keep: Option<&Path>, limit: u64) {
    let files = cached_files(folder);
    for path in to_drop(files, limit, keep) {
        eprintln!("[proxy] dropping {} (cache full)", path.display());
        let _ = fs::remove_file(path);
    }
}

/// Which files to drop, oldest use first, to bring the total within `limit`; never `keep`.
fn to_drop(
    mut files: Vec<(PathBuf, u64, SystemTime)>,
    limit: u64,
    keep: Option<&Path>,
) -> Vec<PathBuf> {
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.2);
    let mut drop = Vec::new();
    for (path, size, _) in files {
        if total <= limit {
            break;
        }
        if Some(path.as_path()) == keep {
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
    fn only_proxy_files_are_touched() {
        assert!(is_proxy(Path::new(r"D:\p\0912b2a2a5ad7664.mp4")));
        assert!(is_proxy(Path::new(r"D:\p\0912b2a2a5ad7664.part")));
        assert!(!is_proxy(Path::new(r"D:\p\holiday.mp4")));
        assert!(!is_proxy(Path::new(r"D:\p\0912b2a2a5ad766.mp4")));
        assert!(!is_proxy(Path::new(r"D:\p\0912b2a2a5ad7664.mov")));
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
            to_drop(files.clone(), 100, Some(Path::new("new"))),
            [PathBuf::from("old")]
        );
        assert_eq!(
            to_drop(files.clone(), 30, Some(Path::new("old"))),
            [PathBuf::from("mid"), PathBuf::from("new")]
        );
        assert!(to_drop(files.clone(), 120, None).is_empty());
        assert_eq!(to_drop(files, 50, None).len(), 2);
    }
}
