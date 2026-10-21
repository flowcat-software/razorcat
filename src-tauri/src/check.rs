//! Development: the preview = export check (PLAN 1.8). `razorcat --check-frames <file>` opens a
//! barcoded test clip (`spikes/make-test-media.mjs`) and the page steps and seeks the preview
//! over it, reading the barcode of the frame on screen; `--check-edit` does it on an edited
//! timeline (clips cut out and moved), plays across the cuts, and exports it (export = preview),
//! then again cropped, and with test markup (PLAN 4.3c), read at points of the picture.
//! Here: the frames export would pick (the `fps` filter over the original, as export reads it),
//! the edit's export read back frame by frame, and the report. Release builds do none of it.

use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::editor::LABEL;
use crate::export::{ExportClip, ExportFrame};
use crate::ffmpeg::{self, Outcome};
use crate::markup::ExportMark;
use crate::state::AppState;

/// The barcode: 16 cells along the bottom sixteenth of the picture, least significant bit on
/// the left, white = 1.
const BITS: usize = 16;

/// The next file opened is to be checked.
static PENDING: AtomicBool = AtomicBool::new(false);
/// ...on an edited timeline.
static EDITED: AtomicBool = AtomicBool::new(false);

/// Rust → editor: check the source just opened.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct CheckFrames {
    /// The source (its `SourceInfo::id`).
    pub source: String,
    /// Edit the timeline first, and play across the cuts.
    pub edit: bool,
}

/// A launch's arguments ask for a check (development builds only).
pub fn requested(args: &[String]) {
    if !cfg!(debug_assertions) {
        return;
    }
    let edit = args.iter().any(|a| a == "--check-edit");
    if edit || args.iter().any(|a| a == "--check-frames") {
        PENDING.store(true, Ordering::Relaxed);
        EDITED.store(edit, Ordering::Relaxed);
    }
}

/// A source was opened: the page checks it, if that was asked for.
pub fn opened(app: &AppHandle, id: String) {
    if PENDING.swap(false, Ordering::Relaxed) {
        let edit = EDITED.load(Ordering::Relaxed);
        let _ = CheckFrames { source: id, edit }.emit_to(app, LABEL);
    }
}

/// The source frame (by barcode) export would show at each grid frame of the open source.
pub fn expected(app: &AppHandle) -> Result<Vec<u32>, String> {
    if !cfg!(debug_assertions) {
        return Err("development only".into());
    }
    let (path, rate, frames, generation) = {
        let state = app.state::<AppState>();
        let open = state.source.lock().unwrap();
        let s = open.as_ref().ok_or("nothing open")?;
        (s.path.clone(), s.grid.rate, s.grid.frames, s.generation)
    };
    let out = std::env::temp_dir().join(format!("razorcat-check-{generation}.gray"));
    let mut args: Vec<OsString> = vec!["-i".into(), path.into()];
    args.extend(["-map", "0:v:0", "-an", "-sn", "-dn", "-vf"].map(OsString::from));
    // Export's grid (as the proxy's), then the barcode strip, a pixel per cell.
    args.push(
        format!(
            "fps={}/{},crop=iw:ih/16:0:ih-ih/16,scale={BITS}:1:flags=area,format=gray",
            rate.num, rate.den
        )
        .into(),
    );
    args.extend(["-frames:v".into(), frames.to_string().into()]);
    args.extend(["-fps_mode", "passthrough", "-f", "rawvideo"].map(OsString::from));
    match ffmpeg::run(&args, &out, Some(u64::from(frames)), |_| {}, || false)? {
        Outcome::Finished => {}
        Outcome::Stopped => return Err("stopped".into()),
    }
    let bytes = fs::read(&out).map_err(|e| e.to_string());
    let _ = fs::remove_file(&out);
    Ok(barcodes(&bytes?, BITS))
}

/// Exports `clips` of the open source in `frame` (export.rs, as a real export) to a temporary
/// file, then reads each of its frames' barcodes: what the edit's export shows, frame by frame.
/// A pixel of the exported picture to read on every frame.
#[derive(Debug, Clone, Copy, Deserialize, Type)]
pub struct Probe {
    pub x: u32,
    pub y: u32,
}

/// The export read back: each frame's barcode, and its probes' colours (RGB, probe after probe).
#[derive(Debug, Serialize, Type)]
pub struct Exported {
    pub barcodes: Vec<u32>,
    pub probes: Vec<Vec<u8>>,
}

/// `cells`: how many of the barcode's cells the export's width holds (fewer, cropped at the
/// sides: the number read is the cells left). `marks`: markup over it, its pixels sent first as
/// for an export; `probes`: pixels to read.
pub fn exported(
    app: &AppHandle,
    clips: &[ExportClip],
    frame: ExportFrame,
    marks: Vec<ExportMark>,
    probes: &[Probe],
    cells: u32,
) -> Result<Exported, String> {
    if !cfg!(debug_assertions) {
        return Err("development only".into());
    }
    let markup = crate::markup::take(app, marks)?;
    let dir = std::env::temp_dir();
    let file = dir.join("razorcat-check-export.mp4");
    let stop = AtomicBool::new(false);
    match crate::export::render(
        app,
        clips,
        frame,
        &markup,
        &file,
        crate::export::Format::Mp4,
        |_| {},
        &stop,
    )? {
        Outcome::Finished => {}
        Outcome::Stopped => return Err("stopped".into()),
    }
    let out = dir.join("razorcat-check-export.gray");
    let mut args: Vec<OsString> = vec!["-i".into(), file.clone().into()];
    args.extend(["-map", "0:v:0", "-an", "-vf"].map(OsString::from));
    args.push(format!("crop=iw:ih/16:0:ih-ih/16,scale={cells}:1:flags=area,format=gray").into());
    args.extend(["-fps_mode", "passthrough", "-f", "rawvideo"].map(OsString::from));
    match ffmpeg::run(&args, &out, None, |_| {}, || false)? {
        Outcome::Finished => {}
        Outcome::Stopped => return Err("stopped".into()),
    }
    let bytes = fs::read(&out).map_err(|e| e.to_string());
    let _ = fs::remove_file(&out);
    let read = probed(&file, probes);
    let _ = fs::remove_file(&file);
    Ok(Exported {
        barcodes: barcodes(&bytes?, cells as usize),
        probes: read?,
    })
}

/// Each frame of `file`'s `probes`' colours, RGB, probe after probe: each a pixel cut out, in a
/// row (one ffmpeg pass).
fn probed(file: &std::path::Path, probes: &[Probe]) -> Result<Vec<Vec<u8>>, String> {
    if probes.is_empty() {
        return Ok(Vec::new());
    }
    let n = probes.len();
    let mut graph = format!("[0:v:0]format=rgb24,split={n}");
    graph += &(0..n).map(|k| format!("[s{k}]")).collect::<String>();
    for (k, p) in probes.iter().enumerate() {
        graph += &format!(";[s{k}]crop=1:1:{}:{}[p{k}]", p.x, p.y);
    }
    graph += ";";
    graph += &(0..n).map(|k| format!("[p{k}]")).collect::<String>();
    graph += &if n > 1 {
        format!("hstack=inputs={n}[out]")
    } else {
        "null[out]".into()
    };
    let out = std::env::temp_dir().join("razorcat-check-probes.rgb");
    let mut args: Vec<OsString> = vec!["-i".into(), file.into()];
    args.extend(["-filter_complex".into(), graph.into()]);
    args.extend(
        [
            "-map",
            "[out]",
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
        ]
        .map(OsString::from),
    );
    match ffmpeg::run(&args, &out, None, |_| {}, || false)? {
        Outcome::Finished => {}
        Outcome::Stopped => return Err("stopped".into()),
    }
    let bytes = fs::read(&out).map_err(|e| e.to_string());
    let _ = fs::remove_file(&out);
    Ok(bytes?.chunks_exact(3 * n).map(<[u8]>::to_vec).collect())
}

/// The numbers in `cells`-byte rows of grey cells.
fn barcodes(bytes: &[u8], cells: usize) -> Vec<u32> {
    bytes
        .chunks_exact(cells)
        .map(|cells| {
            cells
                .iter()
                .enumerate()
                .filter(|(_, &c)| c >= 128)
                .fold(0, |n, (k, _)| n | 1 << k)
        })
        .collect()
}

/// Keeps the page's report (JSON) in the temp folder; returns where.
pub fn report(app: &AppHandle, summary: &str, report: &str) -> Result<String, String> {
    if !cfg!(debug_assertions) {
        return Err("development only".into());
    }
    let name = {
        let state = app.state::<AppState>();
        let open = state.source.lock().unwrap();
        open.as_ref().map(|s| crate::source::file_name(&s.path))
    }
    .unwrap_or_default();
    let file: PathBuf = std::env::temp_dir().join(format!("razorcat-check-{name}.json"));
    fs::write(&file, report).map_err(|e| e.to_string())?;
    eprintln!("[check] {name}: {summary} ({})", file.display());
    Ok(file.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_barcodes() {
        let mut row = [0u8; 32];
        // 5 = cells 0 and 2; then 32768 = cell 15, a little blurred.
        row[0] = 250;
        row[2] = 200;
        row[1] = 90;
        row[16 + 15] = 180;
        assert_eq!(barcodes(&row, BITS), [5, 32768]);
        // A part row is ignored.
        assert_eq!(barcodes(&row[..20], BITS), [5]);
        // Fewer cells (cropped at the sides).
        assert_eq!(barcodes(&row[..24], 12), [5, 0]);
    }
}
