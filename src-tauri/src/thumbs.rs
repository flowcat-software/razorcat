//! Thumbnails for the timeline's clip: small pictures of grid frames, every `step` frames, made
//! by ffmpeg in the background from the proxy, once it's made: it's small, so quick to read, and
//! already on the grid. With no proxy (proxies off, or it failed) there are none: reading the
//! source itself would be slow. They're raw RGBA, all the same size, one after another
//! in one file, so thumbnail `i` (grid frame `i * step`) is at `i * width * height * 4`. The page
//! reads them as they're made (`/thumbs/{generation}/{from}`, see protocol.rs), so the strip
//! fills in from the start.
//!
//! They're cached with the proxies (proxy.rs), so a file opens with its thumbnails next time.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::editor::LABEL;
use crate::ffmpeg::{self, Outcome};
use crate::proxy;
use crate::state::AppState;

/// Pixels high: the timeline's thumbnails are 38 px high, so twice that for high-DPI screens.
pub const HEIGHT: u32 = 76;
/// The most bytes a source's thumbnails take (in the cache, and in the page): a long source
/// gets them further apart. Upright video's are narrower, so it gets more.
const BUDGET: u64 = 64 << 20;
/// Changes when the recipe does, so old thumbnails aren't used.
const RECIPE: &str = "thumbs rgba v1";
/// The cache's name for them (proxy.rs).
pub const EXTENSION: &str = "thumbs";

/// The open source's thumbnails, made or being made.
#[derive(Clone)]
pub struct Thumbs {
    /// Where they are: the cache file, or its `.part` while ffmpeg writes it.
    pub file: PathBuf,
    pub width: u32,
    /// Grid frames between thumbnails.
    pub step: u32,
    /// How many there will be.
    pub count: u32,
    pub ready: bool,
}

impl Thumbs {
    /// Bytes per thumbnail.
    pub fn size(&self) -> u64 {
        u64::from(self.width) * u64::from(HEIGHT) * 4
    }

    pub fn info(&self, generation: u64) -> ThumbsInfo {
        ThumbsInfo {
            url: crate::protocol::thumbs_url(generation),
            width: self.width,
            height: HEIGHT,
            step: self.step,
            count: self.count,
            ready: self.ready,
        }
    }
}

/// What the page needs to read and place the thumbnails.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThumbsInfo {
    /// Thumbnails from `i` on are at `{url}/{i}`.
    pub url: String,
    pub width: u32,
    pub height: u32,
    pub step: u32,
    pub count: u32,
    /// All made: no more are coming.
    pub ready: bool,
}

/// Rust → editor: more of a source's thumbnails are ready (or all of them are).
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ThumbsUpdate {
    /// The source they're for (its `SourceInfo::id`).
    pub source: String,
    pub thumbs: ThumbsInfo,
}

/// Thumbnail width (even, for ffmpeg), grid frames between thumbnails, and how many, for a
/// picture `width` x `height` (as shown) and `frames` long.
fn layout(width: u32, height: u32, frames: u32) -> (u32, u32, u32) {
    let w =
        (f64::from(HEIGHT) * f64::from(width) / f64::from(height.max(1)) / 2.0).round() as u32 * 2;
    let w = w.clamp(2, HEIGHT * 4);
    let most = (BUDGET / (u64::from(w) * u64::from(HEIGHT) * 4)).max(1);
    let step = (u64::from(frames).div_ceil(most) as u32).max(1);
    (w, step, frames.div_ceil(step))
}

/// Settings › General › Show thumbnails, which needs proxies.
fn enabled(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let s = state.settings.read().unwrap();
    s.timeline.thumbnails && s.proxies.enabled
}

/// Thumbnails were turned on: the open sources get them.
pub fn turned_on(app: &AppHandle) {
    let generations: Vec<u64> = {
        let state = app.state::<AppState>();
        let open = state.sources.lock().unwrap();
        open.iter().map(|s| s.generation).collect()
    };
    for generation in generations {
        start(app, generation);
    }
}

/// Gives the source opened as `generation` its thumbnails: from the cache, or made now on a
/// thread from its proxy. Nothing if it has them, they're being made, it has no proxy yet (this
/// is called again when it does), or they're turned off.
pub fn start(app: &AppHandle, generation: u64) {
    if !enabled(app) {
        return;
    }
    let state = app.state::<AppState>();
    let mut open = state.sources.lock().unwrap();
    let Some(k) = open
        .iter()
        .position(|s| s.generation == generation && s.thumbs.is_none())
    else {
        return;
    };
    // Being made for a twin (the same file again): they're this one's too.
    let making = open
        .iter()
        .filter(|t| t.path == open[k].path)
        .find_map(|t| t.thumbs.clone().filter(|t| !t.ready));
    if let Some(thumbs) = making {
        open[k].thumbs = Some(thumbs);
        return;
    }
    let s = &mut open[k];
    let info = s.info();
    let (width, step, count) = layout(info.width, info.height, info.frames);
    let recipe = format!("{RECIPE} {width}x{HEIGHT} step {step}");
    let Some(file) =
        proxy::folder(app).and_then(|f| proxy::file_for(&f, &s.path, &recipe, EXTENSION))
    else {
        return;
    };
    let mut thumbs = Thumbs {
        file: file.with_extension("part"),
        width,
        step,
        count,
        ready: false,
    };
    if proxy::touch(&file) {
        thumbs.file = file;
        thumbs.ready = true;
        s.thumbs = Some(thumbs);
        let update = ThumbsUpdate {
            source: info.id,
            thumbs: s.thumbs.as_ref().unwrap().info(generation),
        };
        drop(open);
        let _ = update.emit_to(app, LABEL);
        return;
    }
    let Some(input) = s.proxy.clone() else {
        return;
    };
    s.thumbs = Some(thumbs);
    drop(open);

    let app = app.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        // Proxy frame k is grid frame k.
        let mut args: Vec<OsString> = vec!["-i".into(), input.as_os_str().into()];
        args.extend(["-map", "0:v:0", "-an", "-sn", "-dn", "-vf"].map(OsString::from));
        args.push(
            format!(
                "select='not(mod(n\\,{step}))',scale={width}:{HEIGHT}:flags=area,setsar=1,format=rgba"
            )
            .into(),
        );
        args.extend(["-frames:v".into(), count.to_string().into()]);
        args.extend(["-fps_mode", "passthrough", "-f", "rawvideo"].map(OsString::from));
        // It and its twins, which wait for these.
        let progress = |_: f64| {
            for g in proxy::twins(&app, generation) {
                emit(&app, g);
            }
        };
        let stop = || !still_open(&app, generation) || !enabled(&app);
        let made = ffmpeg::run(&args, &file, Some(u64::from(count)), progress, stop);
        let all = proxy::twins(&app, generation);
        let state = app.state::<AppState>();
        let mut open = state.sources.lock().unwrap();
        let Some(path) = open
            .iter()
            .find(|s| s.generation == generation)
            .map(|s| s.path.clone())
        else {
            return;
        };
        let waiting = open
            .iter_mut()
            .filter(|s| all.contains(&s.generation) && s.thumbs.as_ref().is_some_and(|t| !t.ready));
        match made {
            Ok(Outcome::Finished) => {
                eprintln!(
                    "[thumbs] made {count} for {} in {:.1} s",
                    path.display(),
                    started.elapsed().as_secs_f64(),
                );
                for s in waiting {
                    if let Some(t) = s.thumbs.as_mut() {
                        t.file = file.clone();
                        t.ready = true;
                    }
                }
                drop(open);
                for &g in &all {
                    emit(&app, g);
                }
                if let Some(folder) = file.parent() {
                    proxy::trim(folder, &proxy::in_use(&app), proxy::limit(&app));
                }
            }
            Ok(Outcome::Stopped) => waiting.for_each(|s| s.thumbs = None),
            // The timeline does without (the clip shows its colour).
            Err(e) => {
                eprintln!("[thumbs] {}: {e}", path.display());
                waiting.for_each(|s| s.thumbs = None);
            }
        }
    });
}

/// Tells the page where the thumbnails of the source opened as `generation` are.
fn emit(app: &AppHandle, generation: u64) {
    let update = {
        let state = app.state::<AppState>();
        let open = state.sources.lock().unwrap();
        open.iter()
            .find(|s| s.generation == generation)
            .and_then(|s| {
                Some(ThumbsUpdate {
                    source: crate::protocol::source_url(generation),
                    thumbs: s.thumbs.as_ref()?.info(generation),
                })
            })
    };
    if let Some(update) = update {
        let _ = update.emit_to(app, LABEL);
    }
}

fn still_open(app: &AppHandle, generation: u64) -> bool {
    let state = app.state::<AppState>();
    let open = state.sources.lock().unwrap();
    open.iter().any(|s| s.generation == generation)
}

/// The thumbnails' bytes from `from` on: whole thumbnails only (ffmpeg may be part way through
/// one), at most `most` of them.
pub fn read(file: &Path, size: u64, from: u64, most: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(file)?;
    let have = f.metadata()?.len() / size.max(1);
    let n = have.saturating_sub(from).min(most);
    let mut buf = vec![0u8; (n * size) as usize];
    if n > 0 {
        f.seek(SeekFrom::Start(from * size))?;
        f.read_exact(&mut buf)?;
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnails_keep_the_picture_shape_and_a_most() {
        // 16:9: 41 KB each, so up to 1623 in 64 MB. 785 frames: every frame.
        assert_eq!(layout(1920, 1080, 785), (136, 1, 785));
        // Ten minutes at 60 fps: every 23rd (the last covers what's left).
        assert_eq!(layout(1920, 1080, 36_000), (136, 23, 1566));
        // Upright phone video, 13 KB each: two minutes at 30 fps gets every frame...
        assert_eq!(layout(1080, 1920, 3600), (42, 1, 3600));
        // ...half an hour, every 11th.
        assert_eq!(layout(1080, 1920, 54_000), (42, 11, 4910));
        // Extreme shapes stay sane.
        assert_eq!(layout(10_000, 10, 10).0, HEIGHT * 4);
        assert_eq!(layout(10, 10_000, 10).0, 2);
    }
}
