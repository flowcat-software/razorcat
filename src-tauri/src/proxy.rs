//! The proxy: a small copy of the open source for stepping and scrubbing (spike 0.2). ffmpeg
//! makes it in the background on open: 540 lines on the short side, H.264 with a keyframe every
//! 10 frames, upright, and at the timeline rate, so proxy frame k is timeline frame k (the `fps`
//! filter picks the same pictures as the grid and export). Playing and the paused picture use
//! the original; the proxy is what moves while you step and scrub.
//!
//! Proxies are cached by file (path, size and modified time), so opening a file again finds its
//! proxy ready. The cache drops the least recently used past its size limit. The copies that
//! conversion on open makes (convert.rs) are kept in the same cache.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::editor::LABEL;
use crate::ffmpeg::{self, Outcome};
use crate::media::grid::Rate;
use crate::settings::Proxies;
use crate::state::AppState;

/// Changes when the proxy's recipe does, so old proxies aren't used.
const RECIPE: &str = "h264 540 g10 crf26 v1";

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

/// The cache's folder (proxies, and conversions' copies).
pub fn folder(app: &AppHandle) -> Option<PathBuf> {
    folder_for(app, &settings(app))
}

pub fn limit(app: &AppHandle) -> u64 {
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
        trim(&to, &in_use(app), limit(app));
        return;
    }
    // Copying to another drive may take a while.
    let app = app.clone();
    std::thread::spawn(move || {
        move_cache(&app, &from, &to);
        trim(&to, &in_use(&app), limit(&app));
    });
}

/// Gives the open sources their proxies: from the cache, or made now.
fn resume(app: &AppHandle) {
    let wanted: Vec<_> = {
        let state = app.state::<AppState>();
        let open = state.sources.lock().unwrap();
        open.iter()
            .filter(|s| s.proxy.is_none())
            .map(|s| {
                let input = s.playable.clone().unwrap_or_else(|| s.path.clone());
                (
                    s.generation,
                    s.path.clone(),
                    input,
                    s.grid.rate,
                    s.grid.frames,
                )
            })
            .collect()
    };
    for (generation, path, input, rate, frames) in wanted {
        resume_one(app, generation, path, input, rate, frames);
    }
}

/// Gives the source opened as `generation` its proxy: from the cache, or made now.
fn resume_one(
    app: &AppHandle,
    generation: u64,
    path: PathBuf,
    input: PathBuf,
    rate: Rate,
    frames: u32,
) {
    let Some(file) = cached(app, &path) else {
        make(app, generation, path, input, rate, frames);
        return;
    };
    let state = app.state::<AppState>();
    let mut open = state.sources.lock().unwrap();
    if let Some(s) = open.iter_mut().find(|s| s.generation == generation) {
        s.proxy = Some(file);
        drop(open);
        let _ = ProxyReady {
            source: crate::protocol::source_url(generation),
            url: crate::protocol::proxy_url(generation),
        }
        .emit_to(app, LABEL);
        crate::thumbs::start(app, generation);
    }
}

/// The cached files the open sources are using: their proxies, converted copies, thumbnails.
pub fn in_use(app: &AppHandle) -> Vec<PathBuf> {
    let state = app.state::<AppState>();
    let open = state.sources.lock().unwrap();
    open.iter()
        .flat_map(|s| {
            let thumbs = s.thumbs.as_ref().filter(|t| t.ready).map(|t| &t.file);
            let wave = s.wave.as_ref().filter(|w| w.ready).map(|w| &w.file);
            s.proxy
                .iter()
                .chain(&s.playable)
                .chain(thumbs)
                .chain(wave)
                .cloned()
                .collect::<Vec<_>>()
        })
        .collect()
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
        // The open sources' proxies and thumbnails are read from their new place from now on.
        let state = app.state::<AppState>();
        let mut open = state.sources.lock().unwrap();
        for s in open.iter_mut() {
            if s.proxy.as_deref() == Some(&old) {
                s.proxy = Some(new.clone());
            }
            if let Some(t) = s.thumbs.as_mut().filter(|t| t.file == old) {
                t.file = new.clone();
            }
            if let Some(w) = s.wave.as_mut().filter(|w| w.file == old) {
                w.file = new.clone();
            }
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

/// A cached file's name: 16 hex digits and `.mp4` or `.thumbs` (`file_for`), or `.part` while
/// it's made. Nothing else in the folder is ever moved or deleted, whatever folder the user
/// picks.
fn is_proxy(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.strip_suffix(".mp4")
        .or_else(|| name.strip_suffix(".thumbs"))
        .or_else(|| name.strip_suffix(".wave"))
        .or_else(|| name.strip_suffix(".pcm"))
        .or_else(|| name.strip_suffix(".part"))
        .is_some_and(|stem| stem.len() == 16 && stem.chars().all(|c| c.is_ascii_hexdigit()))
}

/// A finished cached file (not a `.part`).
fn is_finished(path: &Path) -> bool {
    is_proxy(path)
        && path.extension().is_some_and(|x| {
            x == "mp4" || x == crate::thumbs::EXTENSION || x == crate::wave::EXTENSION
        })
}

/// The cached file made from `source` by `recipe`: named by a hash of what identifies the
/// file's contents and how it was made, with `extension` (`mp4`, or `thumbs`).
pub fn file_for(folder: &Path, source: &Path, recipe: &str, extension: &str) -> Option<PathBuf> {
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
        recipe.as_bytes(),
    ]);
    Some(folder.join(format!("{key:016x}.{extension}")))
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
    find(app, source, RECIPE)
}

/// What `recipe` made of `source`, if it's in the cache (marked as just used).
pub fn find(app: &AppHandle, source: &Path, recipe: &str) -> Option<PathBuf> {
    let file = file_for(&folder(app)?, source, recipe, "mp4")?;
    touch(&file).then_some(file)
}

/// Marks a cached file as just used. False if it isn't there.
pub fn touch(file: &Path) -> bool {
    let Ok(f) = fs::File::options().write(true).open(file) else {
        return false;
    };
    let _ = f.set_modified(SystemTime::now());
    true
}

/// Removes what runs stopped by a crash left behind (`.part` files). At startup, before any
/// run: one in progress would lose its file.
pub fn sweep(app: &AppHandle) {
    let Some(folder) = folder(app) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&folder) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        if is_proxy(&path) && !is_finished(&path) {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// Makes the proxy for the source opened as `generation`, on a thread, from `input` (the source,
/// or its converted copy). It stops if another file is opened meanwhile.
pub fn make(
    app: &AppHandle,
    generation: u64,
    source: PathBuf,
    input: PathBuf,
    rate: Rate,
    frames: u32,
) {
    let app = app.clone();
    std::thread::spawn(move || {
        let url = crate::protocol::source_url(generation);
        let started = Instant::now();
        match run(&app, generation, &source, &input, rate, frames, &url) {
            Ok(Some(file)) => {
                eprintln!(
                    "[proxy] made {} in {:.1} s",
                    file.display(),
                    started.elapsed().as_secs_f64()
                );
                let state = app.state::<AppState>();
                let mut open = state.sources.lock().unwrap();
                if let Some(s) = open.iter_mut().find(|s| s.generation == generation) {
                    s.proxy = Some(file.clone());
                    drop(open);
                    let _ = ProxyReady {
                        source: url,
                        url: crate::protocol::proxy_url(generation),
                    }
                    .emit_to(&app, LABEL);
                }
                if let Some(parent) = file.parent() {
                    let mut keep = in_use(&app);
                    keep.push(file.clone());
                    trim(parent, &keep, limit(&app));
                }
                crate::thumbs::start(&app, generation);
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

/// Runs ffmpeg. `Ok(None)` if it was stopped: another file was opened, or proxies turned off.
fn run(
    app: &AppHandle,
    generation: u64,
    source: &Path,
    input: &Path,
    rate: Rate,
    frames: u32,
    url: &str,
) -> Result<Option<PathBuf>, String> {
    let folder = folder(app).ok_or("no local data folder")?;
    fs::create_dir_all(&folder).map_err(|e| format!("can't make {}: {e}", folder.display()))?;
    let file = file_for(&folder, source, RECIPE, "mp4").ok_or("can't read the file's details")?;
    let mut args: Vec<OsString> = vec!["-i".into(), input.into()];
    args.extend(
        [
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-vf",
        ]
        .map(OsString::from),
    );
    // Upright (ffmpeg turns it by default), on the grid, 540 on the short side.
    args.push(
        format!(
            "fps={}/{},scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)':flags=bilinear,format=yuv420p",
            rate.num, rate.den
        )
        .into(),
    );
    args.extend(["-frames:v".into(), frames.to_string().into()]);
    args.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "fastdecode",
            "-bf",
            "0",
            "-g",
            "10",
            "-crf",
            "26",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ]
        .map(OsString::from),
    );
    let progress = |done: f64| {
        let _ = ProxyProgress {
            source: url.to_string(),
            done,
        }
        .emit_to(app, LABEL);
    };
    let stop = || !still_open(app, generation) || !enabled(app);
    match ffmpeg::run(&args, &file, Some(u64::from(frames)), progress, stop)? {
        Outcome::Finished => Ok(Some(file)),
        Outcome::Stopped => Ok(None),
    }
}

fn still_open(app: &AppHandle, generation: u64) -> bool {
    let state = app.state::<AppState>();
    let open = state.sources.lock().unwrap();
    open.iter().any(|s| s.generation == generation)
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
    let drop = to_drop(
        files.clone(),
        u64::from(limit_gb) * 1_000_000_000,
        &in_use(app),
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
        .filter(|e| is_finished(&e.path()))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((e.path(), m.len(), m.modified().ok()?))
        })
        .collect()
}

/// Drops the least recently used files until the cache is within `limit`, never those in `keep`.
pub fn trim(folder: &Path, keep: &[PathBuf], limit: u64) {
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
    keep: &[PathBuf],
) -> Vec<PathBuf> {
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.2);
    let mut drop = Vec::new();
    for (path, size, _) in files {
        if total <= limit {
            break;
        }
        if keep.contains(&path) {
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
        assert!(is_proxy(Path::new(r"D:\p\0912b2a2a5ad7664.thumbs")));
        assert!(!is_finished(Path::new(r"D:\p\0912b2a2a5ad7664.part")));
        assert!(!is_proxy(Path::new(r"D:\p\holiday.mp4")));
        assert!(!is_proxy(Path::new(r"D:\p\0912b2a2a5ad766.mp4")));
        assert!(!is_proxy(Path::new(r"D:\p\0912b2a2a5ad7664.mov")));
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
            to_drop(files.clone(), 100, &["new".into()]),
            [PathBuf::from("old")]
        );
        assert_eq!(
            to_drop(files.clone(), 30, &["old".into()]),
            [PathBuf::from("mid"), PathBuf::from("new")]
        );
        assert!(to_drop(files.clone(), 120, &[]).is_empty());
        assert_eq!(to_drop(files, 50, &[]).len(), 2);
    }
}
