//! The clip's waveform: how loud the audio is along the timeline, all its tracks mixed (what
//! export plays). ffmpeg decodes it in the background on open to a temporary mono file; Rust
//! boils that down to peaks, `BINS` per grid frame (so it has detail zoomed all the way in),
//! one byte each: the loudest sample in that stretch, 0 to 255. Decoding audio is quick, so it
//! doesn't wait for the proxy, and works without proxies.
//!
//! The peaks are cached with the proxies (proxy.rs); the page reads them whole once they're made
//! (`/wave/{generation}`, see protocol.rs).

use std::ffi::OsString;
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::editor::LABEL;
use crate::ffmpeg::{self, Outcome};
use crate::media::grid::Rate;
use crate::proxy;
use crate::state::AppState;

/// Peaks per grid frame.
pub const BINS: u32 = 8;
/// The decoded audio's sample rate: enough to catch peaks, small enough to be quick.
const SAMPLE_RATE: u32 = 16_000;
/// Changes when the recipe does, so old waveforms aren't used.
const RECIPE: &str = "wave peaks u8 v1";
/// The cache's name for them, and for the decoded audio while they're made (proxy.rs).
pub const EXTENSION: &str = "wave";
pub const PCM_EXTENSION: &str = "pcm";

/// The open source's waveform, made or being made.
pub struct Wave {
    pub file: PathBuf,
    pub ready: bool,
}

/// Rust → editor: a source's waveform is ready.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct WaveReady {
    /// The source it's for (its `SourceInfo::id`).
    pub source: String,
    /// Where the page reads it: `BINS` bytes per grid frame.
    pub url: String,
}

/// Settings › Timeline › Show waveform.
fn enabled(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let s = state.settings.read().unwrap();
    s.timeline.waveform
}

/// The waveform was turned on: the open sources get theirs.
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

/// Gives the source opened as `generation` its waveform: from the cache, or made now on a
/// thread. Nothing if it has no audio, has one, it's being made, or waveforms are turned off.
pub fn start(app: &AppHandle, generation: u64) {
    if !enabled(app) {
        return;
    }
    let state = app.state::<AppState>();
    let mut open = state.sources.lock().unwrap();
    let Some(s) = open
        .iter_mut()
        .find(|s| s.generation == generation && s.wave.is_none() && s.info.audio_tracks > 0)
    else {
        return;
    };
    let Some(file) =
        proxy::folder(app).and_then(|f| proxy::file_for(&f, &s.path, RECIPE, EXTENSION))
    else {
        return;
    };
    if proxy::touch(&file) {
        s.wave = Some(Wave { file, ready: true });
        drop(open);
        emit(app, generation);
        return;
    }
    s.wave = Some(Wave {
        file: file.clone(),
        ready: false,
    });
    // The file the index was read from: the audio tracks counted are its.
    let input = s.playable.clone().unwrap_or_else(|| s.path.clone());
    let (tracks, rate, frames) = (s.info.audio_tracks, s.grid.rate, s.grid.frames);
    drop(open);

    let app = app.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let made = make(&app, generation, &input, tracks, rate, frames, &file);
        let state = app.state::<AppState>();
        let mut open = state.sources.lock().unwrap();
        let Some(s) = open.iter_mut().find(|s| s.generation == generation) else {
            return;
        };
        match made {
            Ok(true) => {
                eprintln!(
                    "[wave] made for {} in {:.1} s",
                    s.path.display(),
                    started.elapsed().as_secs_f64()
                );
                if let Some(w) = s.wave.as_mut() {
                    w.ready = true;
                }
                drop(open);
                emit(&app, generation);
                if let Some(folder) = file.parent() {
                    proxy::trim(folder, &proxy::in_use(&app), proxy::limit(&app));
                }
            }
            Ok(false) => s.wave = None,
            // The timeline does without.
            Err(e) => {
                eprintln!("[wave] {}: {e}", s.path.display());
                s.wave = None;
            }
        }
    });
}

/// Decodes the audio, then writes its peaks to `file`. `Ok(false)` if stopped.
fn make(
    app: &AppHandle,
    generation: u64,
    input: &Path,
    tracks: u32,
    rate: Rate,
    frames: u32,
    file: &Path,
) -> Result<bool, String> {
    let pcm = file.with_extension(PCM_EXTENSION);
    let mut args: Vec<OsString> = vec!["-i".into(), input.as_os_str().into()];
    // All the tracks, mixed at their own levels, as one channel.
    let inputs: String = (0..tracks).map(|i| format!("[0:a:{i}]")).collect();
    let mix = if tracks > 1 {
        format!("{inputs}amix=inputs={tracks}:normalize=0,")
    } else {
        inputs
    };
    args.extend([
        "-filter_complex".into(),
        format!("{mix}aresample={SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono[a]")
            .into(),
    ]);
    args.extend(["-map", "[a]", "-vn", "-sn", "-dn", "-f", "s16le"].map(OsString::from));
    let stop = || !still_open(app, generation) || !enabled(app);
    let outcome = ffmpeg::run(&args, &pcm, None, |_| {}, stop);
    let outcome = match outcome {
        Ok(o) => o,
        Err(e) => {
            let _ = fs::remove_file(&pcm);
            return Err(e);
        }
    };
    if let Outcome::Stopped = outcome {
        return Ok(false);
    }
    let read = fs::File::open(&pcm).map_err(|e| e.to_string());
    let peaks = read.map(|f| {
        let mut samples = Vec::new();
        let _ = BufReader::new(f).read_to_end(&mut samples);
        peaks(
            samples
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]])),
            rate,
            frames,
        )
    });
    let _ = fs::remove_file(&pcm);
    let part = file.with_extension("part");
    fs::write(&part, peaks?).map_err(|e| e.to_string())?;
    fs::rename(&part, file).map_err(|e| format!("can't keep {}: {e}", file.display()))?;
    Ok(true)
}

/// The loudest sample in each `1 / BINS` of each grid frame (at `rate`), 0 to 255: `frames *
/// BINS` of them, silent where the audio is shorter.
fn peaks(samples: impl Iterator<Item = i16>, rate: Rate, frames: u32) -> Vec<u8> {
    let len = frames as usize * BINS as usize;
    let mut out = vec![0u8; len];
    // Sample s falls in bin s * BINS * fps / SAMPLE_RATE.
    let per = u64::from(BINS) * u64::from(rate.num);
    let over = u64::from(SAMPLE_RATE) * u64::from(rate.den);
    for (s, v) in samples.enumerate() {
        let bin = (s as u64 * per / over) as usize;
        if bin >= len {
            break;
        }
        let level = (u32::from(v.unsigned_abs()) * 255).div_ceil(32768) as u8;
        out[bin] = out[bin].max(level);
    }
    out
}

/// Tells the page the waveform of the source opened as `generation` is ready.
fn emit(app: &AppHandle, generation: u64) {
    let _ = WaveReady {
        source: crate::protocol::source_url(generation),
        url: crate::protocol::wave_url(generation),
    }
    .emit_to(app, LABEL);
}

fn still_open(app: &AppHandle, generation: u64) -> bool {
    let state = app.state::<AppState>();
    let open = state.sources.lock().unwrap();
    open.iter().any(|s| s.generation == generation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peaks_fall_in_their_frame() {
        // 25 fps: a frame is 640 samples, a bin 80.
        let rate = Rate { num: 25, den: 1 };
        let mut samples = vec![0i16; 640 * 3];
        samples[80] = 16384; // frame 0, bin 1: half scale
        samples[640 + 79] = -32768; // frame 1, bin 0: full scale
        let p = peaks(samples.into_iter(), rate, 3);
        assert_eq!(p.len(), 24);
        assert_eq!(p[1], 128);
        assert_eq!(p[8], 255);
        assert_eq!(p.iter().filter(|&&v| v > 0).count(), 2);
    }

    #[test]
    fn audio_shorter_or_longer_than_the_video() {
        let rate = Rate {
            num: 30000,
            den: 1001,
        };
        // Half a second of loud audio under two seconds of video: the rest is silent.
        let p = peaks(std::iter::repeat_n(1000i16, 8000), rate, 60);
        assert_eq!(p.len(), 480);
        assert!(p[..115].iter().all(|&v| v > 0));
        assert!(p[125..].iter().all(|&v| v == 0));
        // Longer: cut at the end.
        assert_eq!(peaks(std::iter::repeat_n(1i16, 100_000), rate, 2).len(), 16);
    }
}
