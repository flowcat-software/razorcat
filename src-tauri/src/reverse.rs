//! Reversed renders (PLAN §7, Clip speed SP8): a stretch of an open source's grid frames, back to
//! front, which the preview plays forward (as another file) and the export reads, so a reversed
//! clip plays smoothly and with its sound, and the preview stays the export.
//!
//! `<video>` can't play backward, and ffmpeg's `reverse` holds every frame it turns round in
//! memory, so the picture is made in chunks from the stretch's end, each its own ffmpeg run onto
//! the grid (the export's `fps` and `trim`), turned round and encoded (H.264, a keyframe every 10
//! frames, near-lossless), then joined by stream copy. The sound is taken whole as PCM, turned
//! round here in blocks (no joins, constant memory), and encoded once with the picture. Spike
//! SP7 (`spikes/reverse/render.mjs`): every frame exact across the joins, the sound within a
//! millisecond.
//!
//! The renders are cached with the proxies (by file, size, date, stretch and recipe), and the
//! cache's limit trims them too. One is made at a time, in the background; each can be stopped.
//! Once made, it's read like a source: its index, its grid and its frame times.

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::editor::LABEL;
use crate::ffmpeg::{self, Outcome};
use crate::media::grid::{self, Rate};
use crate::media::mp4;
use crate::state::AppState;

/// Changes when the render's recipe does, so old renders aren't used.
const RECIPE: &str = "reverse h264 veryfast crf16 g10 aac192 v1";
/// The frames a chunk holds (raw, as `reverse` keeps them): 82 at 1080p, 20 at 4K (SP7: ffmpeg's
/// own threads take more than this, so smaller chunks only cost time).
const CHUNK_BYTES: u64 = 256 << 20;
const CHUNK_MIN: u32 = 8;
const CHUNK_MAX: u32 = 120;
/// The sound's rate and channels, as PCM.
const RATE: u64 = 48_000;
const SAMPLE: u64 = 4;

/// Rust → editor: a reversed render is this far along.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ReverseProgress {
    pub id: String,
    /// 0 to 1.
    pub done: f64,
}

/// Rust → editor: a reversed render is ready to play.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ReverseReady {
    pub render: Reversed,
}

/// Rust → editor: a reversed render stopped (cancelled, or its file closed) or failed.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ReverseEnded {
    pub id: String,
    /// A sentence for the user if it failed; none if it was stopped.
    pub message: Option<String>,
}

/// A reversed render as the page knows it.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Reversed {
    /// What the page and the export name it by.
    pub id: String,
    /// Its file (`SourceInfo::id`), and the grid frames it turns round, `from` to `to`
    /// (exclusive): its frame k is the file's frame `to − 1 − k`.
    pub source: String,
    pub from: u32,
    pub to: u32,
    pub ready: bool,
    /// Where the page reads it and its frame times (protocol.rs), once ready.
    pub url: String,
    pub frames_url: String,
}

struct Render {
    info: Reversed,
    generation: u64,
    file: PathBuf,
    stop: Arc<AtomicBool>,
    /// Once ready: each frame's start and middle, in seconds (`grid::times`).
    times: Vec<(f64, f64)>,
    rate: Rate,
    width: u32,
    height: u32,
    audio: bool,
}

/// The renders asked for this run, ready or being made.
static RENDERS: Mutex<Vec<Render>> = Mutex::new(Vec::new());
/// Held while one is made: one at a time (each uses every core).
static MAKING: Mutex<()> = Mutex::new(());

/// What a render of an open file needs to know about it.
pub(crate) struct Of {
    pub(crate) generation: u64,
    pub(crate) path: PathBuf,
    pub(crate) rate: Rate,
    /// Each grid frame's start, on the file's clock.
    pub(crate) starts: Vec<f64>,
    pub(crate) tracks: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

/// The page asks for `source`'s grid frames `from` to `to` reversed: its render, ready if it's
/// made already (this run, or cached), else started.
pub fn request(app: &AppHandle, source: &str, from: u32, to: u32) -> Result<Reversed, String> {
    let of = {
        let state = app.state::<AppState>();
        let open = state.sources.lock().unwrap();
        let s = open
            .iter()
            .find(|s| crate::protocol::source_url(s.generation) == source)
            .ok_or("That video isn't open.")?;
        if from >= to || to > s.grid.frames {
            return Err("That stretch isn't in the video.".into());
        }
        let (w, h) = (s.info.width, s.info.height);
        let (width, height) = if s.info.rotation % 180 == 90 {
            (h, w)
        } else {
            (w, h)
        };
        Of {
            generation: s.generation,
            path: s.path.clone(),
            rate: s.grid.rate,
            starts: grid::times(&s.info.video, &s.grid)
                .into_iter()
                .map(|(start, _)| start)
                .collect(),
            tracks: s.info.audio_tracks,
            width,
            height,
        }
    };
    let folder = crate::proxy::folder(app).ok_or("There's no folder for the cache.")?;
    fs::create_dir_all(&folder).map_err(|e| format!("Can't make the cache's folder: {e}"))?;
    let recipe = format!("{RECIPE} {from} {to} {}/{}", of.rate.num, of.rate.den);
    let file = crate::proxy::file_for(&folder, &of.path, &recipe, "mp4")
        .ok_or("Can't read the file's details.")?;
    let id = file
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("no name")?
        .to_string();
    let info = Reversed {
        id: id.clone(),
        source: source.to_string(),
        from,
        to,
        ready: false,
        url: crate::protocol::reversed_url(&id),
        frames_url: crate::protocol::reversed_frames_url(&id),
    };
    let mut renders = RENDERS.lock().unwrap();
    // Those of files let go go too.
    let open = open_generations(app);
    renders.retain(|r| open.contains(&r.generation));
    if let Some(r) = renders.iter_mut().find(|r| r.info.id == id) {
        // Another clip of the same file opened again (a twin) is the same render.
        r.info.source = source.to_string();
        r.generation = of.generation;
        return Ok(r.info.clone());
    }
    let mut render = Render {
        info,
        generation: of.generation,
        file: file.clone(),
        stop: Arc::new(AtomicBool::new(false)),
        times: Vec::new(),
        rate: of.rate,
        width: of.width,
        height: of.height,
        audio: of.tracks > 0,
    };
    // Made before (this run or another): read it.
    if crate::proxy::touch(&file) {
        match read(&file, of.rate, to - from) {
            Ok(times) => {
                render.times = times;
                render.info.ready = true;
                let info = render.info.clone();
                renders.push(render);
                return Ok(info);
            }
            Err(e) => {
                logln!("[reverse] the cached render is no good ({e}): making it again");
                let _ = fs::remove_file(&file);
            }
        }
    }
    let stop = render.stop.clone();
    let info = render.info.clone();
    renders.push(render);
    drop(renders);
    let app = app.clone();
    std::thread::spawn(move || {
        let _one = MAKING.lock().unwrap_or_else(|e| e.into_inner());
        let started = Instant::now();
        let made = if stop.load(Ordering::Relaxed) {
            Ok(Outcome::Stopped)
        } else {
            make(&app, &of, &id, &file, from, to, &stop)
        };
        let ended = |message: Option<String>| {
            RENDERS.lock().unwrap().retain(|r| r.info.id != id);
            let _ = ReverseEnded {
                id: id.clone(),
                message,
            }
            .emit_to(&app, LABEL);
        };
        match made.and_then(|o| match o {
            Outcome::Finished => read(&file, of.rate, to - from).map(Some),
            Outcome::Stopped => Ok(None),
        }) {
            Ok(Some(times)) => {
                logln!(
                    "[reverse] made {} frames in {:.1} s",
                    to - from,
                    started.elapsed().as_secs_f64()
                );
                let ready = {
                    let mut renders = RENDERS.lock().unwrap();
                    renders.iter_mut().find(|r| r.info.id == id).map(|r| {
                        r.times = times;
                        r.info.ready = true;
                        r.info.clone()
                    })
                };
                if let Some(render) = ready {
                    let _ = ReverseReady { render }.emit_to(&app, LABEL);
                }
                if let Some(parent) = file.parent() {
                    let mut keep = crate::proxy::in_use(&app);
                    keep.push(file.clone());
                    crate::proxy::trim(parent, &keep, crate::proxy::limit(&app));
                }
            }
            Ok(None) => {
                logln!("[reverse] stopped");
                let _ = fs::remove_file(&file);
                ended(None);
            }
            Err(message) => {
                logln!("[reverse] failed: {message}");
                let _ = fs::remove_file(&file);
                ended(Some(format!("Couldn't reverse the clip ({message}).")));
            }
        }
    });
    Ok(info)
}

/// Stops render `id`, if it's being made (one that's made stays).
pub fn cancel(id: &str) {
    if let Some(r) = RENDERS
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.info.id == id && !r.info.ready)
    {
        r.stop.store(true, Ordering::Relaxed);
    }
}

fn open_generations(app: &AppHandle) -> Vec<u64> {
    let state = app.state::<AppState>();
    let open = state.sources.lock().unwrap();
    open.iter().map(|s| s.generation).collect()
}

/// Makes the render: the picture in chunks from the end, joined; the sound turned round; both
/// into `file`. `Stopped` if `stop` is set or its file is let go meanwhile.
fn make(
    app: &AppHandle,
    of: &Of,
    id: &str,
    file: &Path,
    from: u32,
    to: u32,
    stop: &AtomicBool,
) -> Result<Outcome, String> {
    let work = std::env::temp_dir().join(format!("razorcat-reverse-{id}"));
    let generation = of.generation;
    let stopped = || stop.load(Ordering::Relaxed) || !open_generations(app).contains(&generation);
    let report = |done: f64| {
        let _ = ReverseProgress {
            id: id.to_string(),
            done: done.clamp(0.0, 1.0),
        }
        .emit_to(app, LABEL);
    };
    render(of, file, from, to, &work, report, stopped)
}

/// Renders `of`'s grid frames `from` to `to` back to front into `file`, working in `work` (made
/// and removed here); `report` gets 0 to 1, and `stopped` ends it.
pub(crate) fn render(
    of: &Of,
    file: &Path,
    from: u32,
    to: u32,
    work: &Path,
    report: impl Fn(f64),
    stopped: impl Fn() -> bool + Copy,
) -> Result<Outcome, String> {
    let _ = fs::remove_dir_all(work);
    fs::create_dir_all(work).map_err(|e| format!("can't make a work folder: {e}"))?;
    let made = render_in(of, file, from, to, work, report, stopped);
    let _ = fs::remove_dir_all(work);
    made
}

fn render_in(
    of: &Of,
    file: &Path,
    from: u32,
    to: u32,
    work: &Path,
    report: impl Fn(f64),
    stopped: impl Fn() -> bool + Copy,
) -> Result<Outcome, String> {
    let total = to - from;
    let fps = of.rate.fps();
    let origin = of.starts.first().copied().unwrap_or(0.0);
    let chunk = chunk_frames(of.width, of.height);
    // The picture: 90% of the work.
    let mut parts = Vec::new();
    let mut done = 0;
    for (a, b) in chunks(from, to, chunk) {
        let seek = (of.starts[a as usize] - 0.5).max(0.0);
        let part = work.join(format!("part{}.mp4", parts.len()));
        let mut args: Vec<OsString> = vec!["-ss".into(), format!("{seek:.6}").into()];
        args.extend(["-i".into(), of.path.clone().into_os_string()]);
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
        args.push(
            format!(
                "setpts=PTS+({:.6})/TB,fps={}/{},trim=start_pts={a}:end_pts={b},setpts=PTS-STARTPTS,reverse,format=yuv420p",
                seek - origin,
                of.rate.num,
                of.rate.den
            )
            .into(),
        );
        args.extend(encoder().map(OsString::from));
        let n = b - a;
        let at = done;
        let progress = |p: f64| report(0.9 * (f64::from(at) + p * f64::from(n)) / f64::from(total));
        if let Outcome::Stopped = ffmpeg::run(&args, &part, Some(u64::from(n)), progress, stopped)?
        {
            return Ok(Outcome::Stopped);
        }
        parts.push(part);
        done += n;
    }
    // Joined as they are.
    let list = work.join("parts.txt");
    let lines: String = parts
        .iter()
        .map(|p| format!("file '{}'\n", p.to_string_lossy().replace('\'', "'\\''")))
        .collect();
    fs::write(&list, lines).map_err(|e| format!("can't write the list: {e}"))?;
    let video = work.join("video.mp4");
    let mut args: Vec<OsString> = ["-f", "concat", "-safe", "0", "-i"]
        .map(OsString::from)
        .into();
    args.push(list.into_os_string());
    args.extend(["-c", "copy", "-f", "mp4"].map(OsString::from));
    if let Outcome::Stopped = ffmpeg::run(&args, &video, None, |_| {}, stopped)? {
        return Ok(Outcome::Stopped);
    }
    // The sound, if it has any: the stretch as the export takes it, as PCM, turned round here.
    let samples = (f64::from(total) / fps * RATE as f64).round() as u64;
    let mut args: Vec<OsString> = vec!["-i".into(), video.into_os_string()];
    if of.tracks > 0 {
        let pcm = work.join("sound.pcm");
        let seek = (of.starts[from as usize] - 0.5).max(0.0);
        let start = (origin + f64::from(from) / fps - seek).max(0.0);
        let tracks: String = (0..of.tracks).map(|t| format!("[0:a:{t}]")).collect();
        let mix = if of.tracks > 1 {
            format!("amix=inputs={}:normalize=0:duration=longest,", of.tracks)
        } else {
            String::new()
        };
        let mut a: Vec<OsString> = vec!["-ss".into(), format!("{seek:.6}").into()];
        a.extend(["-i".into(), of.path.clone().into_os_string()]);
        a.extend(["-vn".into(), "-filter_complex".into()]);
        a.push(
            format!(
                "{tracks}{mix}atrim=start={start:.6}:duration={:.6},asetpts=N/SR/TB[a]",
                f64::from(total) / fps
            )
            .into(),
        );
        a.extend(["-map", "[a]", "-ac", "2", "-ar", "48000", "-f", "s16le"].map(OsString::from));
        if let Outcome::Stopped = ffmpeg::run(&a, &pcm, None, |_| {}, stopped)? {
            return Ok(Outcome::Stopped);
        }
        let back = work.join("back.pcm");
        turn_round(&pcm, &back, samples).map_err(|e| format!("can't turn the sound round: {e}"))?;
        args.extend(["-f", "s16le", "-ar", "48000", "-ac", "2", "-i"].map(OsString::from));
        args.push(back.into_os_string());
        args.extend(["-map", "1:a", "-c:a", "aac", "-b:a", "192k"].map(OsString::from));
    }
    args.extend(
        [
            "-map",
            "0:v",
            "-c:v",
            "copy",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ]
        .map(OsString::from),
    );
    report(0.95);
    let made = ffmpeg::run(&args, file, None, |_| {}, stopped)?;
    if let Outcome::Finished = made {
        report(1.0);
    }
    Ok(made)
}

/// The x264 settings: near-lossless (the export encodes it again), and seeking as fast as the
/// proxy (a keyframe every 10 frames, no B-frames).
fn encoder() -> [&'static str; 12] {
    [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-g", "10", "-bf", "0", "-f", "mp4",
    ]
}

/// How many frames of a `width` × `height` picture a chunk holds.
fn chunk_frames(width: u32, height: u32) -> u32 {
    let frame = (u64::from(width) * u64::from(height) * 3 / 2).max(1);
    ((CHUNK_BYTES / frame) as u32).clamp(CHUNK_MIN, CHUNK_MAX)
}

/// The chunks of `from` to `to`, `size` frames each, from the end (the render's first frames
/// are the stretch's last), as (start, end) grid frames.
fn chunks(from: u32, to: u32, size: u32) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    let mut b = to;
    while b > from {
        let a = b.saturating_sub(size).max(from);
        out.push((a, b));
        b = a;
    }
    out
}

/// Writes `samples` stereo s16 samples of `input` back to front to `output`, in blocks: sample i
/// is the input's `samples − 1 − i`, silence where the input is shorter.
fn turn_round(input: &Path, output: &Path, samples: u64) -> std::io::Result<()> {
    let mut src = File::open(input)?;
    let have = src.metadata()?.len() / SAMPLE;
    let mut dst = std::io::BufWriter::new(File::create(output)?);
    const BLOCK: u64 = 1 << 18;
    let mut buf = vec![0u8; (BLOCK * SAMPLE) as usize];
    let mut i = 0;
    while i < samples {
        let n = BLOCK.min(samples - i);
        // Output samples i..i+n come from input samples (samples − i − n)..(samples − i).
        let hi = samples - i;
        let lo = hi - n;
        let block = &mut buf[..(n * SAMPLE) as usize];
        block.fill(0);
        let read_hi = hi.min(have);
        if lo < read_hi {
            src.seek(SeekFrom::Start(lo * SAMPLE))?;
            src.read_exact(&mut block[..((read_hi - lo) * SAMPLE) as usize])?;
        }
        reverse_samples(block);
        dst.write_all(block)?;
        i += n;
    }
    dst.flush()
}

/// Turns a block of 4-byte samples round, in place.
fn reverse_samples(block: &mut [u8]) {
    let n = block.len() / SAMPLE as usize;
    for k in 0..n / 2 {
        let (a, b) = (k * 4, (n - 1 - k) * 4);
        for j in 0..4 {
            block.swap(a + j, b + j);
        }
    }
}

/// The render at `file`, read as a source: its frame times on its grid, which must have exactly
/// `frames` frames.
pub(crate) fn read(file: &Path, rate: Rate, frames: u32) -> Result<Vec<(f64, f64)>, String> {
    let info = mp4::read(file).map_err(|e| format!("can't read the render: {e:?}"))?;
    let g = grid::build_at(&info.video, Some(rate)).ok_or("the render has no frames")?;
    if g.frames != frames {
        return Err(format!("the render has {} frames, not {frames}", g.frames));
    }
    Ok(grid::times(&info.video, &g))
}

/// Render `id`'s file, if it's ready (protocol.rs).
pub fn file(id: &str) -> Option<PathBuf> {
    let renders = RENDERS.lock().unwrap();
    renders
        .iter()
        .find(|r| r.info.id == id && r.info.ready)
        .map(|r| r.file.clone())
}

/// Render `id`'s frame times, if it's ready (protocol.rs).
pub fn times(id: &str) -> Option<Vec<(f64, f64)>> {
    let renders = RENDERS.lock().unwrap();
    renders
        .iter()
        .find(|r| r.info.id == id && r.info.ready)
        .map(|r| r.times.clone())
}

/// A ready render as export reads it: its id as the page names it (`reverse:{id}`), file,
/// rate, frame starts, whether it has sound, and its size (upright).
pub struct ForExport {
    pub id: String,
    pub path: PathBuf,
    pub rate: Rate,
    pub starts: Vec<f64>,
    pub audio: bool,
    pub width: u32,
    pub height: u32,
}

pub fn for_export() -> Vec<ForExport> {
    let renders = RENDERS.lock().unwrap();
    renders
        .iter()
        .filter(|r| r.info.ready)
        .map(|r| ForExport {
            id: format!("reverse:{}", r.info.id),
            path: r.file.clone(),
            rate: r.rate,
            starts: r.times.iter().map(|t| t.0).collect(),
            audio: r.audio,
            width: r.width,
            height: r.height,
        })
        .collect()
}

/// The renders the open files use: kept when the cache is trimmed.
pub fn in_use(open: &[u64]) -> Vec<PathBuf> {
    let renders = RENDERS.lock().unwrap();
    renders
        .iter()
        .filter(|r| r.info.ready && open.contains(&r.generation))
        .map(|r| r.file.clone())
        .collect()
}

/// The cache moved a file (Settings › Proxies' folder): a render there is read from its new place.
pub fn moved(old: &Path, new: &Path) {
    for r in RENDERS.lock().unwrap().iter_mut() {
        if r.file == old {
            r.file = new.to_path_buf();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_go_from_the_end_and_cover_the_stretch() {
        assert_eq!(chunks(10, 35, 10), [(25, 35), (15, 25), (10, 15)]);
        assert_eq!(chunks(0, 5, 10), [(0, 5)]);
        assert!(chunks(5, 5, 10).is_empty());
    }

    #[test]
    fn chunks_are_sized_by_bytes() {
        assert_eq!(chunk_frames(1920, 1080), 86);
        assert_eq!(chunk_frames(3840, 2160), 21);
        assert_eq!(chunk_frames(640, 360), CHUNK_MAX);
        assert_eq!(chunk_frames(16000, 16000), CHUNK_MIN);
    }

    #[test]
    fn turns_the_sound_round_padding_with_silence() {
        let dir =
            std::env::temp_dir().join(format!("razorcat-reverse-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a.pcm"), dir.join("b.pcm"));
        // Samples 1, 2, 3 (each its four bytes), turned round into 5: silence, then 3, 2, 1.
        let input: Vec<u8> = (1u8..=3)
            .flat_map(|s| [s, s + 10, s + 20, s + 30])
            .collect();
        fs::write(&a, &input).unwrap();
        turn_round(&a, &b, 5).unwrap();
        let out = fs::read(&b).unwrap();
        let mut want = vec![0u8; 8];
        want.extend((1u8..=3).rev().flat_map(|s| [s, s + 10, s + 20, s + 30]));
        assert_eq!(out, want);
        // Shorter than the input: its first samples, turned round.
        turn_round(&a, &b, 2).unwrap();
        assert_eq!(fs::read(&b).unwrap(), [2, 12, 22, 32, 1, 11, 21, 31]);
        let _ = fs::remove_dir_all(&dir);
    }
}
