//! Export (PLAN 2.5): the edit rendered to MP4 by ffmpeg, the way spike 0.3 measured it exact.
//!
//! Each clip is its own input (of its file: PLAN 4.5e), seeked half a second before its first
//! frame. Its timestamps are put back on its file's clock (from its first shown frame, as the
//! grid counts), the `fps` filter puts it on the timeline's grid (the same rule the grid and the
//! preview follow, grid.rs), and `trim` keeps the clip's grid frames. A file of another size than
//! the first is fitted into the first's picture, black round it, as the preview shows it. The
//! audio is cut at the same times (all its tracks mixed, as the waveform shows them); a file with
//! none is silence there. The clips are joined with `concat`, then the
//! joined picture is cropped and grown (the project's frame, frame.ts), and the markup is laid
//! over it, each item (drawn by the page, markup.rs) on the frames it shows on. A muted clip's
//! sound is silenced (`concat` still joins it); with every clip muted, the file has no audio.
//! A clip's fades (PLAN 4.7a) are black laid over the whole frame, under the markup, its alpha
//! ramped frame by frame as the preview's is; its sound fades with it. A clip that crossfades
//! with the one before it (4.7b) is blended in over that one's last frames (`xfade`, the sound
//! with `acrossfade`), the export that much shorter.
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

use crate::camera::Place;
use crate::editor::LABEL;
use crate::ffmpeg::{self, Outcome};
use crate::markup::{self, ExportMark, MarkLayer, Markup, RedactMode};
use crate::media::grid::{self, Rate};
use crate::sidecar::{self, Tool};
use crate::source::file_name;
use crate::state::AppState;

/// A clip at another speed than 100% (PLAN §7, Clip speed; the page's speed.ts): `num` source
/// frames to every `den` of its own, its frame v showing source frame floor((v·num + phase)/den),
/// its first frame, and how many frames it has (its length on the timeline).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Type)]
pub struct ClipSpeed {
    pub num: u32,
    pub den: u32,
    pub phase: u32,
    pub first: u32,
    pub length: u32,
}

/// A clip of the edit, as the page sends it: its number, its source grid frames (`in` to `out`,
/// at another speed the ones its video spans), and whether it's silent (its own mute, or the
/// track's).
#[derive(Debug, Clone, Deserialize, Type)]
pub struct ExportClip {
    pub id: u32,
    /// Its file (`SourceInfo::id`).
    pub source: String,
    #[serde(rename = "in")]
    pub from: u32,
    pub out: u32,
    pub muted: bool,
    /// Where it starts on the whole edit's timeline, which the markup's frames count on.
    pub start: u32,
    /// How many of its frames it fades in from black over, and out to black over (fitted to
    /// its length).
    #[serde(rename = "fadeIn")]
    pub fade_in: u32,
    #[serde(rename = "fadeOut")]
    pub fade_out: u32,
    /// The colours it fades in from and out to (`#rrggbb`; black if not one).
    #[serde(rename = "fadeInColour")]
    pub fade_in_colour: String,
    #[serde(rename = "fadeOutColour")]
    pub fade_out_colour: String,
    /// How many frames it crossfades with the clip before it in the export over (none for the
    /// first).
    pub crossfade: u32,
    /// Its speed, if not 100%.
    #[serde(default)]
    pub speed: Option<ClipSpeed>,
}

impl ExportClip {
    /// How many frames it has on the timeline: its source frames', at another speed its own.
    fn length(&self) -> u32 {
        self.speed.map_or(self.out - self.from, |s| s.length)
    }
}

/// A part of the picture as shown (rotation applied), in its pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// A grown side: how much, in the picture's pixels, and its colour (`#rrggbb`).
#[derive(Debug, Clone, Deserialize, Type)]
pub struct GrowSide {
    pub size: u32,
    pub colour: String,
}

/// The space grown round the cropped picture, each side in the colour it's drawn in.
#[derive(Debug, Clone, Deserialize, Type)]
pub struct ExportGrow {
    pub top: GrowSide,
    pub bottom: GrowSide,
    pub left: GrowSide,
    pub right: GrowSide,
}

/// The project's frame, as the page sends it (the document's, frame.ts).
#[derive(Debug, Clone, Deserialize, Type)]
pub struct ExportFrame {
    pub crop: Crop,
    pub grow: ExportGrow,
}

/// The most a side grows (frame.ts's `MAX_GROW`).
const MAX_GROW: u32 = 4000;

/// `crop` of a `width` × `height` picture, kept inside it, at least 1 px.
fn kept_crop(crop: Crop, width: u32, height: u32) -> Crop {
    let x = crop.x.min(width.saturating_sub(1));
    let y = crop.y.min(height.saturating_sub(1));
    Crop {
        x,
        y,
        width: crop.width.clamp(1, width - x),
        height: crop.height.clamp(1, height - y),
    }
}

/// The grown sides that are there, in the order they're drawn, sizes kept to `MAX_GROW`.
fn grown(grow: &ExportGrow) -> Vec<(&'static str, u32, String)> {
    [
        ("top", &grow.top),
        ("bottom", &grow.bottom),
        ("left", &grow.left),
        ("right", &grow.right),
    ]
    .into_iter()
    .filter(|(_, g)| g.size > 0)
    .map(|(side, g)| {
        let colour =
            crate::settings::normalize_color(&g.colour).unwrap_or_else(|| "#000000".into());
        (side, g.size.min(MAX_GROW), colour)
    })
    .collect()
}

/// The size the frame comes out at from a `width` × `height` picture: the crop plus the grow,
/// even (4:2:0 needs it: an odd one drops its last row or column).
fn output_size(frame: &ExportFrame, width: u32, height: u32) -> (u32, u32) {
    let c = kept_crop(frame.crop, width, height);
    let (mut w, mut h) = (c.width, c.height);
    for (side, size, _) in grown(&frame.grow) {
        if side == "top" || side == "bottom" {
            h += size;
        } else {
            w += size;
        }
    }
    ((w & !1).max(2), (h & !1).max(2))
}

/// The filters that make the frame from a `width` × `height` picture: the crop, then each grown
/// side padded in its colour, then the whole made even (dropping its last row or column if odd,
/// never resampling); `None` for the whole picture, ungrown. In full colour (4:4:4) so the crop
/// and the pads land on the pixels the preview shows, not on the chroma's grid.
fn frame_filter(frame: &ExportFrame, width: u32, height: u32) -> Option<String> {
    let c = kept_crop(frame.crop, width, height);
    let whole = c.x == 0 && c.y == 0 && c.width == width && c.height == height;
    let sides = grown(&frame.grow);
    if whole && sides.is_empty() {
        return None;
    }
    let mut f = vec!["format=yuv444p".to_string()];
    if !whole {
        f.push(format!(
            "crop={}:{}:{}:{}:exact=1",
            c.width, c.height, c.x, c.y
        ));
    }
    for (side, size, colour) in sides {
        let colour = colour.replace('#', "0x");
        f.push(match side {
            "top" => format!("pad=w=iw:h=ih+{size}:x=0:y={size}:color={colour}"),
            "bottom" => format!("pad=w=iw:h=ih+{size}:x=0:y=0:color={colour}"),
            "left" => format!("pad=w=iw+{size}:h=ih:x={size}:y=0:color={colour}"),
            _ => format!("pad=w=iw+{size}:h=ih:x=0:y=0:color={colour}"),
        });
    }
    f.push("crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0".into());
    Some(f.join(","))
}

/// Where the camera of a file `size` (its `place` on its picture) shows on the export's frame
/// (`out`, the crop and grow of `first`'s picture): through the file's fit into the first's
/// picture (centred, as large as fits), the crop and the grow; kept inside the frame, as large as
/// it at most. As the preview places it (cameraPlace.ts). Its top-left and across, px.
fn camera_on_frame(
    place: Place,
    size: (u32, u32),
    first: (u32, u32),
    frame: &ExportFrame,
    out: (u32, u32),
) -> (u32, u32, u32) {
    let (sw, sh) = (f64::from(size.0), f64::from(size.1));
    let (fw, fh) = (f64::from(first.0), f64::from(first.1));
    let (k, dx, dy) = if size == first || sw <= 0.0 || sh <= 0.0 {
        (1.0, 0.0, 0.0)
    } else {
        let k = (fw / sw).min(fh / sh);
        (k, (fw - sw * k) / 2.0, (fh - sh * k) / 2.0)
    };
    let crop = kept_crop(frame.crop, first.0, first.1);
    let side = |s: &str| {
        grown(&frame.grow)
            .into_iter()
            .find(|(g, _, _)| *g == s)
            .map_or(0.0, |(_, n, _)| f64::from(n))
    };
    let across = (place.size * k)
        .round()
        .clamp(0.0, f64::from(out.0.min(out.1)));
    let x = dx + place.x * k - f64::from(crop.x) + side("left");
    let y = dy + place.y * k - f64::from(crop.y) + side("top");
    let keep = |v: f64, room: u32| v.round().clamp(0.0, (f64::from(room) - across).max(0.0));
    (keep(x, out.0) as u32, keep(y, out.1) as u32, across as u32)
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
    /// Their size together.
    pub bytes: f64,
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

    pub(crate) fn codec(self) -> &'static str {
        match self {
            Encoder::Nvenc => "h264_nvenc",
            Encoder::Amf => "h264_amf",
            Encoder::Qsv => "h264_qsv",
            Encoder::MediaFoundation => "h264_mf",
            Encoder::X264 => "libx264",
        }
    }

    /// Media Foundation, AMF and QSV want NV12 frames.
    pub(crate) fn pixels(self) -> &'static str {
        match self {
            Encoder::Amf | Encoder::Qsv | Encoder::MediaFoundation => "nv12",
            Encoder::Nvenc | Encoder::X264 => "yuv420p",
        }
    }

    /// The codec and its rate control, at `bitrate` bits a second (the hardware encoders; x264
    /// aims at a quality instead). NVENC's `p2`: 2.5 times as fast as `p5`, with the same VMAF
    /// on a screen recording, the file about a fifth bigger.
    pub(crate) fn args(self, bitrate: u64) -> Vec<String> {
        let b = bitrate.to_string();
        let max = (bitrate * 2).to_string();
        let mut a: Vec<String> = vec!["-c:v".into(), self.codec().into()];
        let rest: Vec<&str> = match self {
            Encoder::Nvenc => vec![
                "-preset", "p2", "-tune", "hq", "-rc", "vbr", "-b:v", &b, "-maxrate", &max,
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
pub(crate) fn bitrate(width: u32, height: u32, fps: f64) -> u64 {
    let bits = f64::from(width) * f64::from(height) * fps * 0.1;
    (bits as u64).clamp(2_000_000, 80_000_000)
}

/// What export reads of an open file.
struct Input {
    /// What the page names it by (`SourceInfo::id`).
    id: String,
    path: PathBuf,
    rate: Rate,
    /// When each grid frame's source frame starts showing, in seconds on the source's clock.
    starts: Vec<f64>,
    audio_tracks: u32,
    width: u32,
    height: u32,
    /// The camera recorded with it, and its place on its picture (PLAN 5d.5).
    camera: Option<(PathBuf, Place)>,
}

/// A clip as ffmpeg seeks it.
#[derive(Debug, Clone, PartialEq, Default)]
struct Cut {
    /// Its file.
    path: PathBuf,
    /// Where its input is seeked to, in seconds: before its first frame.
    seek: f64,
    /// When its file's first frame starts showing, on its clock: the grid counts from there.
    origin: f64,
    from: u32,
    out: u32,
    muted: bool,
    /// Its file's audio tracks (none: silence, if the export has sound).
    tracks: u32,
    /// A file of another size than the first: fitted into the first's picture, this size.
    fit: Option<(u32, u32)>,
    /// Its fades from and to black, in frames, and their colours if not black (ffmpeg's
    /// `0xrrggbb`).
    fade_in: u32,
    fade_out: u32,
    fade_in_colour: Option<String>,
    fade_out_colour: Option<String>,
    /// Its crossfade with the cut before it, in frames (the first's doesn't count: `crossfades`).
    crossfade: u32,
    /// Its speed, if not 100%, and whether its sound keeps its pitch then (Settings › Timeline).
    speed: Option<ClipSpeed>,
    keep_pitch: bool,
    /// Its file's camera, laid over it (PLAN 5d.5).
    camera: Option<CutCamera>,
}

/// A clip's camera as the export lays it: its file (fitted to the clip's, so its time is the
/// file's), its square on the frame (top-left and across, px), and the frames it fades in and
/// out over with its clip (none if it doesn't: Settings › Recording).
#[derive(Debug, Clone, PartialEq, Default)]
struct CutCamera {
    path: PathBuf,
    x: u32,
    y: u32,
    size: u32,
    fade_in: u32,
    fade_out: u32,
}

impl Cut {
    /// How many frames it has in the export: its source frames', at another speed its own.
    fn length(&self) -> u32 {
        self.speed.map_or(self.out - self.from, |s| s.length)
    }
}

/// How far before a clip's first frame its input is seeked: the frame is kept whatever the
/// rounding, and a source frame shown for several grid frames (VFR) is there for `fps`.
const SEEK_EARLY: f64 = 0.5;

/// An item of markup as ffmpeg lays it over the frame: its pixels' file (raw RGBA, a ripple's a
/// picture per frame; a highlight's or a spotlight's hole's, RGB over white, multiplied in; the
/// darkness has none), its size and
/// place, the export's stretches it shows on, and its fades (over its own `length` frames).
#[derive(Debug, Clone, PartialEq)]
struct Overlay {
    layer: MarkLayer,
    path: PathBuf,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    shows: Vec<Show>,
    length: u32,
    fade_in: u32,
    fade_out: u32,
}

/// A stretch of the export an item shows on: export frames `from` to `to` (exclusive), which
/// show its own frames from `at` on (0 is its first).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Show {
    from: u32,
    to: u32,
    at: u32,
}

/// The markup over `clips` (in the export's order), with the export's frames each item shows
/// on: what of its timeline frames the clips cover, wherever they are in the export. Items over
/// none of them are left out. As the preview draws them (Vandal's rule, Richard 2026-10-23): the
/// redactions first (PLAN 4.8b, on the video), then the highlights, then the spotlights' holes and
/// darkness, then the rest, back to front as sent.
fn overlays(clips: &[ExportClip], markup: &Markup) -> Vec<Overlay> {
    let mut items: Vec<_> = markup.items.iter().collect();
    items.sort_by_key(|item| match item.mark.layer {
        MarkLayer::Redact { .. } => 0,
        MarkLayer::Highlight => 1,
        MarkLayer::Hole => 2,
        MarkLayer::Dark { .. } => 3,
        MarkLayer::Item | MarkLayer::Frames => 4,
    });
    items
        .into_iter()
        .filter_map(|item| {
            let m = &item.mark;
            let shows = shown(clips, m.start, m.end);
            (!shows.is_empty()).then(|| Overlay {
                layer: m.layer,
                path: item.path.clone(),
                x: m.x,
                y: m.y,
                width: m.width,
                height: m.height,
                shows,
                length: m.end - m.start,
                fade_in: m.fade_in,
                fade_out: m.fade_out,
            })
        })
        .collect()
}

/// The export's stretches on which timeline frames `start` to `end` show, joined where they
/// meet (or overlap, over a crossfade) in both the export and the item.
fn shown(clips: &[ExportClip], start: u32, end: u32) -> Vec<Show> {
    let mut shows: Vec<Show> = Vec::new();
    let mut at = 0u32;
    for (i, c) in clips.iter().enumerate() {
        let length = c.length();
        // Over the end of the one before, crossfading.
        if i > 0 {
            at = at.saturating_sub(c.crossfade);
        }
        let (a, b) = (start.max(c.start), end.min(c.start + length));
        if a < b {
            let show = Show {
                from: at + a - c.start,
                to: at + b - c.start,
                at: a - start,
            };
            match shows.last_mut() {
                Some(last)
                    if last.to >= show.from
                        && show.from >= last.from
                        && last.at + (show.from - last.from) == show.at =>
                {
                    last.to = last.to.max(show.to);
                }
                _ => shows.push(show),
            }
        }
        at += length;
    }
    shows
}

/// Clip `c` of `input`, as ffmpeg seeks it, in the picture of `first` (the timeline's file).
fn cut(input: &Input, first: &Input, c: &ExportClip, keep_pitch: bool) -> Cut {
    let fitted = (input.width, input.height) != (first.width, first.height);
    let length = if c.from < c.out { c.length() } else { 0 };
    let fade_in = c.fade_in.min(length);
    Cut {
        path: input.path.clone(),
        seek: (input.starts[c.from as usize] - SEEK_EARLY).max(0.0),
        origin: input.starts[0],
        from: c.from,
        out: c.out,
        muted: c.muted,
        tracks: input.audio_tracks,
        fit: fitted.then_some((first.width, first.height)),
        fade_in,
        fade_out: c.fade_out.min(length - fade_in),
        fade_in_colour: fade_colour(&c.fade_in_colour),
        fade_out_colour: fade_colour(&c.fade_out_colour),
        crossfade: c.crossfade.min(length.saturating_sub(1)),
        speed: c.speed,
        keep_pitch,
        camera: None,
    }
}

/// A clip's sound at speed `s` (PLAN §7, Clip speed), `length` seconds long as its picture is.
/// Its pitch kept: `atempo` (0.5 to 100 a stage, so chained below 50%), delayed by its lead
/// (`tempo_lead`). Else tape-style: played at another rate, higher when faster. Then padded or cut
/// to the picture's length, so the joins stay in sync: stamped by its samples first, as `atrim`
/// goes by the stamps, and after `atempo` and the delay they put it about 90 ms early at 10% (the
/// export check, `retimed_exports_show_the_previews_frames`).
fn tempo(s: ClipSpeed, keep_pitch: bool, length: f64) -> String {
    let speed = f64::from(s.num) / f64::from(s.den);
    let fit = format!(",asetpts=N/SR/TB,apad,atrim=duration={length:.6}");
    if !keep_pitch {
        return format!(
            ",aresample=48000,asetrate={:.4},aresample=48000{fit}",
            48000.0 * speed
        );
    }
    let mut stages = Vec::new();
    let mut rest = speed;
    while rest < 0.5 {
        stages.push(0.5);
        rest /= 0.5;
    }
    stages.push(rest);
    let chain: String = stages.iter().map(|t| format!(",atempo={t:.6}")).collect();
    format!(
        "{chain},adelay={:.3}:all=1{fit}",
        tempo_lead(speed, stages.len())
    )
}

/// How early `atempo` puts the sound at `speed` through `stages` of it, in ms, measured against
/// the picture (spike SP0, `spikes/speed/compensate.mjs`): 10 ms over the speed for one stage,
/// 13 for a chain. What's left is within 11 ms at every speed, 10% to 400%.
fn tempo_lead(speed: f64, stages: usize) -> f64 {
    (if stages > 1 { 13.0 } else { 10.0 }) / speed
}

/// A fade's colour as ffmpeg takes it (`0xrrggbb`): none for black, or if it isn't one.
fn fade_colour(colour: &str) -> Option<String> {
    crate::settings::normalize_color(colour)
        .filter(|c| c != "#000000")
        .map(|c| c.replace('#', "0x"))
}

/// Each cut's crossfade with the one before it, kept to the frames that one has (none for the
/// first: an export of one clip, or of clips apart, has none at its start).
fn crossfades(cuts: &[Cut]) -> Vec<u32> {
    let mut xf: Vec<u32> = Vec::with_capacity(cuts.len());
    for (i, c) in cuts.iter().enumerate() {
        xf.push(match i.checked_sub(1) {
            Some(p) => c.crossfade.min(cuts[p].length() - xf[p]),
            None => 0,
        });
    }
    xf
}

/// How many frames the export of `cuts` has: theirs, less their crossfades.
fn export_frames(cuts: &[Cut]) -> u32 {
    let lengths: u32 = cuts.iter().map(Cut::length).sum();
    lengths - crossfades(cuts).iter().sum::<u32>()
}

/// The size of the black a clip fades to: the frame's, and never smaller than the picture (an
/// odd-sized one, unframed, is made even only at the end).
fn black_size(frame: &ExportFrame, width: u32, height: u32) -> (u32, u32) {
    let (w, h) = output_size(frame, width, height);
    (w.max(width), h.max(height))
}

/// Whether there's anything to hear: a clip with sound, not muted.
fn heard(cuts: &[Cut]) -> bool {
    cuts.iter().any(|c| !c.muted && c.tracks > 0)
}

/// The ffmpeg arguments for `cuts`, up to the output file: inputs, the graph, the encoder and
/// the container.
#[allow(clippy::too_many_arguments)]
fn args(
    cuts: &[Cut],
    rate: Rate,
    frame: Option<&str>,
    black: (u32, u32),
    overlays: &[Overlay],
    encoder: Encoder,
    bitrate: u64,
) -> Vec<OsString> {
    // Nothing to hear: no audio at all.
    let audio = heard(cuts);
    // Even dimensions, as 4:2:0 needs (for a source of odd size, with no frame).
    let last = format!(
        "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format={}",
        encoder.pixels()
    );
    let mut a = graph(cuts, rate, audio, frame, black, overlays, &last);
    if audio {
        a.extend(["-c:a", "aac", "-b:a", "192k"].map(OsString::from));
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

/// The ffmpeg arguments for a GIF of `cuts`: the picture alone at `gif_fps`, its longer side at
/// most `size` (0: as it is), as raw frames (YUV4MPEG) on stdout for gifski.
#[allow(clippy::too_many_arguments)]
fn gif_args(
    cuts: &[Cut],
    rate: Rate,
    frame: Option<&str>,
    black: (u32, u32),
    overlays: &[Overlay],
    gif_fps: u32,
    size: u32,
) -> Vec<OsString> {
    let scale = if size == 0 {
        "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos".to_string()
    } else {
        // Never larger than the video; the other side in proportion, even.
        format!(
            "scale='if(gte(iw,ih),min({size},iw),-2)':'if(gte(iw,ih),-2,min({size},ih))':flags=lanczos"
        )
    };
    let last = format!("fps={gif_fps},{scale},setsar=1,format=yuv420p");
    let mut a = graph(cuts, rate, false, frame, black, overlays, &last);
    a.extend(["-f", "yuv4mpegpipe", "-"].map(OsString::from));
    a
}

/// A raw picture read in the graph (`movie`): `pixels` (ffmpeg's pixel format), `width` by
/// `height`.
fn picture(path: &Path, pixels: &str, width: u32, height: u32) -> String {
    let options = format!(
        "filename={}:f=rawvideo:format_opts={}",
        escaped(&path.to_string_lossy(), ":'"),
        escaped(
            &format!("pixel_format={pixels}:video_size={width}x{height}"),
            ":'"
        )
    );
    format!("movie={}", escaped(&options, "'[],;"))
}

/// The chain's output as `{name}_0` to `{name}_{n-1}`: split if more than one.
fn split(name: &str, n: usize) -> String {
    let labels: String = (0..n).map(|j| format!("[{name}_{j}]")).collect();
    if n > 1 {
        format!(",split={n}{labels}")
    } else {
        labels
    }
}

/// `s` with a backslash before each of `special` and each backslash: a filter option's value
/// (`:'`), or a filter's options in a graph (`'[],;`), as ffmpeg reads them.
fn escaped(s: &str, special: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '\\' || special.contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The graph's file, removed when dropped.
struct GraphFile(PathBuf);

impl Drop for GraphFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// `a` with its graph read from a file in `dir` (`-/filter_complex`): a long project's graph
/// (each clip's chain, and its camera's) runs past what Windows lets a command line be (32,767
/// characters). The file lasts as long as the `GraphFile`.
fn graph_from_file(mut a: Vec<OsString>, dir: &Path) -> Result<(Vec<OsString>, GraphFile), String> {
    let at = a
        .iter()
        .position(|x| x == "-filter_complex")
        .filter(|at| at + 1 < a.len())
        .ok_or("the export has no graph")?;
    let file = GraphFile(dir.join(format!("razorcat-export-{}.graph", std::process::id())));
    std::fs::write(&file.0, a[at + 1].as_encoded_bytes())
        .map_err(|e| format!("the export's graph couldn't be written: {e}"))?;
    a[at] = "-/filter_complex".into();
    a[at + 1] = file.0.clone().into();
    Ok((a, file))
}

/// A clip's input put on its frames: back on its file's clock from its first shown frame, then
/// onto the grid, then the clip's grid frames (`fps` gives frame k the timestamp k). Its picture,
/// or its camera's (fitted to the file, so on its clock).
fn on_grid(c: &Cut, rate: Rate) -> String {
    // At another speed (PLAN §7, Clip speed): each source frame onto the first of the clip's
    // frames that shows it (speed.ts's mapping), `fps` repeating it to the next or dropping all
    // but the last on a frame, as many frames as the clip has. Exact at every speed (spike SP0's
    // barcodes).
    let retime = c.speed.map_or(String::new(), |s| {
        format!(
            ",setpts='max(0,ceil(((N+{})*{}-{})/{})-{})',fps={}/{},trim=end_frame={}",
            c.from, s.den, s.phase, s.num, s.first, rate.num, rate.den, s.length
        )
    });
    format!(
        "setpts=PTS+({:.6})/TB,fps={}/{},trim=start_pts={}:end_pts={},setpts=PTS-STARTPTS{retime}",
        c.seek - c.origin,
        rate.num,
        rate.den,
        c.from,
        c.out
    )
}

/// The clips' cameras (PLAN 5d.5) laid over the picture `at`, on top of everything, as the
/// preview lays them: each clip's camera (its input in `inputs`, by clip) on the clip's frames
/// as its picture is (`on_grid`), a square from its middle at its size, made round (a circle's
/// mask as its alpha, its edge a pixel soft), faded as the preview fades it (`markOpacity`'s
/// ramp: ffmpeg's `fade` from the clip's first frame in, and a frame before its fade-out out),
/// on its stretch of the joined picture. The picture's label after it.
fn cameras(
    f: &mut Vec<String>,
    at: &str,
    cuts: &[Cut],
    inputs: &[(usize, usize)],
    rate: Rate,
) -> String {
    let mut at = at.to_string();
    let xf = crossfades(cuts);
    let mut starts = Vec::with_capacity(cuts.len());
    let mut start = 0;
    for (i, c) in cuts.iter().enumerate() {
        // Over the end of the one before, crossfading.
        start -= xf[i];
        starts.push(start);
        start += c.length();
    }
    for &(i, input) in inputs {
        let c = &cuts[i];
        let Some(cam) = c.camera.as_ref().filter(|cam| cam.size > 0) else {
            continue;
        };
        let (d, from, length) = (cam.size, starts[i], c.length());
        let r = f64::from(d) / 2.0;
        f.push(format!(
            "color=c=black:s={d}x{d}:r=1:d=1,format=gray,geq=lum='255*clip({r}+0.5-hypot(X+0.5-{r},Y+0.5-{r}),0,1)'[cm{i}]"
        ));
        f.push(format!(
            "[{input}:v:0]{},crop='min(iw,ih)':'min(iw,ih)',scale={d}:{d},format=yuva444p[cv{i}]",
            on_grid(c, rate)
        ));
        let mut fades = String::new();
        if cam.fade_in > 0 {
            fades += &format!(",fade=t=in:s=0:n={}:alpha=1", cam.fade_in);
        }
        if cam.fade_out > 0 {
            fades += &format!(
                ",fade=t=out:s={}:n={}:alpha=1",
                (length - cam.fade_out).saturating_sub(1),
                cam.fade_out
            );
        }
        f.push(format!(
            "[cv{i}][cm{i}]alphamerge{fades},settb={}/{},setpts=N+{from}[cc{i}]",
            rate.den, rate.num
        ));
        f.push(format!(
            "[{at}][cc{i}]overlay=x={}:y={}:format=yuv444:eof_action=pass:enable='between(n,{from},{})'[co{i}]",
            cam.x,
            cam.y,
            from + length - 1
        ));
        at = format!("co{i}");
    }
    at
}

/// The inputs and the graph for `cuts`, mapped: the joined picture, made into the `frame`
/// (crop and grow), the clips' fades laid over it (black, `black` in size), then the
/// `overlays`, through `last` (a filter chain) as `[vout]`; and the joined sound as `[ac]` if
/// there's `audio`.
fn graph(
    cuts: &[Cut],
    rate: Rate,
    audio: bool,
    frame: Option<&str>,
    black: (u32, u32),
    overlays: &[Overlay],
    last: &str,
) -> Vec<OsString> {
    let fps = rate.fps();
    let mut a: Vec<OsString> = Vec::new();
    for c in cuts {
        a.extend(["-ss".into(), format!("{:.6}", c.seek).into()]);
        a.extend(["-i".into(), c.path.as_os_str().to_owned()]);
    }
    let mut f: Vec<String> = Vec::new();
    // Each item's pixels: one picture, raw RGBA (a highlight's or a hole's, RGB), read in the
    // graph rather than as an input, as there can be hundreds (a recording's clicks) and the
    // command line has room for few; as `p{k}_{j}`, once for each time the graph reads it.
    let darkness = overlays
        .iter()
        .any(|o| matches!(o.layer, MarkLayer::Dark { .. }));
    for (k, o) in overlays.iter().enumerate() {
        let (pixels, uses) = match o.layer {
            MarkLayer::Dark { .. } | MarkLayer::Redact { .. } => continue,
            // The holes only show cut out of the darkness.
            MarkLayer::Hole if !darkness => continue,
            // Unfaded, read on each stretch it shows on (`highlight`).
            MarkLayer::Highlight | MarkLayer::Hole if o.fade_in == 0 && o.fade_out == 0 => {
                ("rgb24", o.shows.len())
            }
            MarkLayer::Highlight | MarkLayer::Hole => ("rgb24", 1),
            MarkLayer::Item | MarkLayer::Frames => ("rgba", 1),
        };
        f.push(format!(
            "{}{}",
            picture(&o.path, pixels, o.width, o.height),
            split(&format!("p{k}"), uses)
        ));
    }
    // Each clip's camera, seeked as its clip is; by clip, its input.
    let mut next = cuts.len();
    let mut camera_inputs = Vec::new();
    for (i, c) in cuts.iter().enumerate() {
        if let Some(cam) = &c.camera {
            camera_inputs.push((i, next));
            next += 1;
            a.extend(["-ss".into(), format!("{:.6}", c.seek).into()]);
            a.extend(["-i".into(), cam.path.as_os_str().to_owned()]);
        }
    }
    for (i, c) in cuts.iter().enumerate() {
        // Fitted into the first file's picture if it's another size.
        let fit = c.fit.map_or(String::new(), |(w, h)| {
            format!(
                ",scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
            )
        });
        f.push(format!("[{i}:v:0]{}{fit}[v{i}]", on_grid(c, rate)));
        if !audio {
            continue;
        }
        let length = f64::from(c.length()) / fps;
        if c.tracks == 0 {
            // A file with no sound: silence for as long.
            f.push(format!(
                "anullsrc=r=48000:cl=stereo,atrim=duration={length:.6}[a{i}]"
            ));
            continue;
        }
        let tracks: String = (0..c.tracks).map(|t| format!("[{i}:a:{t}]")).collect();
        let mix = if c.tracks > 1 {
            format!("amix=inputs={}:normalize=0:duration=longest,", c.tracks)
        } else {
            String::new()
        };
        // The same stretch of time: from grid frame `from` on its file's clock, which the seek
        // put at 0. At another speed, the source's stretch made as long as the clip (`tempo`).
        let start = (c.origin + f64::from(c.from) / fps - c.seek).max(0.0);
        let span = f64::from(c.out - c.from) / fps;
        let tempo = c
            .speed
            .map_or(String::new(), |s| tempo(s, c.keep_pitch, length));
        let silence = if c.muted { ",volume=0" } else { "" };
        // Its fades, the picture's in seconds.
        let mut fades = String::new();
        if c.fade_in > 0 {
            fades += &format!(",afade=t=in:st=0:d={:.6}", f64::from(c.fade_in) / fps);
        }
        if c.fade_out > 0 {
            fades += &format!(
                ",afade=t=out:st={:.6}:d={:.6}",
                f64::from(c.length() - c.fade_out) / fps,
                f64::from(c.fade_out) / fps
            );
        }
        f.push(format!(
            "{tracks}{mix}atrim=start={start:.6}:duration={span:.6},asetpts=PTS-STARTPTS{tempo}{fades}{silence}[a{i}]"
        ));
    }
    let n = cuts.len();
    let xf = crossfades(cuts);
    if xf.iter().all(|&x| x == 0) {
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
    } else {
        // Crossfades: two at a time, a crossfading clip blended in over the end of what's
        // before it from its start in the export (the same picture format and clock both sides,
        // as `xfade` needs), the others joined.
        let (mut v, mut a) = ("v0".to_string(), "a0".to_string());
        let mut at = cuts[0].length();
        for i in 1..n {
            if xf[i] > 0 {
                at -= xf[i];
                let d = f64::from(xf[i]) / fps;
                let clock = format!("format=yuv444p,settb={}/{}", rate.den, rate.num);
                f.push(format!("[{v}]{clock}[xa{i}];[v{i}]{clock}[xb{i}]"));
                f.push(format!(
                    "[xa{i}][xb{i}]xfade=transition=fade:duration={d:.6}:offset={:.6}[vj{i}]",
                    f64::from(at) / fps
                ));
                if audio {
                    f.push(format!(
                        "[{a}][a{i}]acrossfade=d={d:.6}:c1=tri:c2=tri[aj{i}]"
                    ));
                }
            } else {
                f.push(format!("[{v}][v{i}]concat=n=2:v=1:a=0[vj{i}]"));
                if audio {
                    f.push(format!("[{a}][a{i}]concat=n=2:v=0:a=1[aj{i}]"));
                }
            }
            v = format!("vj{i}");
            a = format!("aj{i}");
            at += cuts[i].length();
        }
        f.push(format!("[{v}]null[vc]"));
        if audio {
            f.push(format!("[{a}]anull[ac]"));
        }
    }
    // The frame, then the markup over it, back to front: in full colour (4:4:4), as the frame is
    // made, so each item lands on the pixels the preview shows it on. Each item is made YUV
    // once, not on every frame (spike 0.3), and is on only between its frames (`n` counts the
    // joined frames from 0). The redactions work on the frame itself, under the clip fades.
    let mut at = "vc".to_string();
    if let Some(frame) = frame {
        f.push(format!("[vc]{frame}[vf]"));
        at = "vf".into();
    }
    at = redactions(&mut f, &at, overlays, black);
    at = clip_fades(&mut f, &at, cuts, black, rate);
    let mut darkened = false;
    for (k, o) in overlays.iter().enumerate() {
        let place = format!("x={}:y={}:format=yuv444", o.x, o.y);
        match o.layer {
            MarkLayer::Highlight => {
                at = highlight(&mut f, &at, k, o, rate);
                continue;
            }
            MarkLayer::Hole | MarkLayer::Dark { .. } => {
                // The spotlights all at once, at the first of them.
                if !darkened {
                    darkened = true;
                    let total = export_frames(cuts);
                    at = dark(&mut f, &at, overlays, total, rate);
                }
                continue;
            }
            MarkLayer::Redact { .. } => continue,
            MarkLayer::Item | MarkLayer::Frames => {}
        }
        f.push(format!("[p{k}_0]format=yuva444p[m{k}]"));
        let frames = o.layer == MarkLayer::Frames;
        if !frames && o.fade_in == 0 && o.fade_out == 0 {
            // Unfaded: the one picture, on between its frames.
            let shows: Vec<String> = o
                .shows
                .iter()
                .map(|s| format!("between(n,{},{})", s.from, s.to - 1))
                .collect();
            f.push(format!(
                "[{at}][m{k}]overlay={place}:enable='{}'[o{k}]",
                shows.join("+")
            ));
            at = format!("o{k}");
            continue;
        }
        // Faded: the picture once per frame of the item and one more in front, faded by frame
        // count (`ramps`); a ripple's frames are its own, faded already. Then each stretch's
        // frames on the export's (`on_frames`).
        let (mut chain, first) = if frames {
            (format!("[m{k}]null"), 0)
        } else {
            let looped = format!("[m{k}]loop=loop={}:size=1:start=0", o.length);
            (
                looped + &ramps(o.length, o.fade_in, o.fade_out, ":alpha=1"),
                1,
            )
        };
        let parts = o.shows.len();
        if parts > 1 {
            chain += &format!(",split={parts}");
        }
        chain += &(0..parts)
            .map(|j| format!("[f{k}_{j}]"))
            .collect::<String>();
        f.push(chain);
        for (j, s) in o.shows.iter().enumerate() {
            f.push(format!(
                "[f{k}_{j}]trim=start_frame={}:end_frame={},{}[g{k}_{j}]",
                s.at + first,
                s.at + first + s.to - s.from,
                on_frames(rate, s.from)
            ));
            f.push(format!(
                "[{at}][g{k}_{j}]overlay={place}:eof_action=pass:enable='between(n,{},{})'[o{k}_{j}]",
                s.from,
                s.to - 1
            ));
            at = format!("o{k}_{j}");
        }
    }
    at = cameras(&mut f, &at, cuts, &camera_inputs, rate);
    f.push(format!("[{at}]{last}[vout]"));
    a.extend(["-filter_complex".into(), f.join(";").into()]);
    a.extend(["-map", "[vout]"].map(OsString::from));
    if audio {
        a.extend(["-map", "[ac]"].map(OsString::from));
    }
    a
}

/// The redactions (PLAN 4.8b) made in the picture `at` (`frame` in size), as the preview makes
/// them (redactions.ts), on their frames: each box cut out, pixelated (`pixelize`, its blocks
/// averaged on a grid from its corner) or blurred (`boxblur`, three passes each way, with as much
/// round it as they read, reflected at the frame's edge), and laid back. In full colour, so the
/// box's pixels are its own. Every box is cut from the one picture, as the preview's are, split
/// once: each cut from the last one's result made the graph slower by half again per redaction
/// (24 never finished; Richard, 2026-10-23). The picture's label after it.
fn redactions(f: &mut Vec<String>, at: &str, overlays: &[Overlay], frame: (u32, u32)) -> String {
    // Each one's index, kind and box, kept to the frame (the page sends it so).
    let boxes: Vec<_> = overlays
        .iter()
        .enumerate()
        .filter_map(|(k, o)| {
            let MarkLayer::Redact { mode, strength } = o.layer else {
                return None;
            };
            let (x, y) = (o.x, o.y);
            if x >= frame.0 || y >= frame.1 {
                return None;
            }
            let (w, h) = (o.width.min(frame.0 - x), o.height.min(frame.1 - y));
            Some((k, o, mode, strength, (x, y, w, h)))
        })
        .collect();
    if boxes.is_empty() {
        return at.to_string();
    }
    let cuts: String = boxes.iter().map(|(k, ..)| format!("[rc{k}]")).collect();
    f.push(format!(
        "[{at}]format=yuv444p,split={}[rb]{cuts}",
        boxes.len() + 1
    ));
    let mut at = "rb".to_string();
    for &(k, o, mode, strength, (x, y, w, h)) in &boxes {
        let on: Vec<String> = o
            .shows
            .iter()
            .map(|s| format!("between(n,{},{})", s.from, s.to - 1))
            .collect();
        let on = on.join("+");
        // Off its frames, the work's skipped (`enable`) and the box not laid back.
        let made = match mode {
            RedactMode::Pixelate => {
                let b = strength.max(2);
                format!("crop={w}:{h}:{x}:{y},pixelize=width={b}:height={b}:mode=avg:enable='{on}'")
            }
            RedactMode::Blur => {
                let r = strength.max(1);
                let (rx, ry, rw, rh) = grown_box((x, y, w, h), 3 * r, frame);
                let r = r.min(rw.min(rh) / 2);
                format!(
                    "crop={rw}:{rh}:{rx}:{ry},boxblur=luma_radius={r}:luma_power=3:chroma_radius={r}:chroma_power=3:enable='{on}',crop={w}:{h}:{}:{}",
                    x - rx,
                    y - ry
                )
            }
        };
        f.push(format!("[rc{k}]{made}[rm{k}]"));
        f.push(format!(
            "[{at}][rm{k}]overlay=x={x}:y={y}:format=yuv444:enable='{on}'[r{k}]"
        ));
        at = format!("r{k}");
    }
    at
}

/// Box `(x, y, width, height)` grown by `by` on every side, kept to the frame (redactions.ts's
/// `grownBox`).
fn grown_box(b: (u32, u32, u32, u32), by: u32, frame: (u32, u32)) -> (u32, u32, u32, u32) {
    let x0 = b.0.saturating_sub(by);
    let y0 = b.1.saturating_sub(by);
    let x1 = (b.0 + b.2 + by).min(frame.0);
    let y1 = (b.1 + b.3 + by).min(frame.1);
    (x0, y0, x1 - x0, y1 - y0)
}

/// The fades of an item `length` frames long (`fade_in` and `fade_out` frames), for a stream of
/// it with one frame more in front, which is dropped (its frame u is the stream's u + 1): fading
/// in, its first frame clear, u / fade-in; fading out, its last clear too, (length − 1 − u) /
/// fade-out (Richard, 2026-10-23: ending a step short, the last frame wasn't quite gone; the
/// frame in front lets ffmpeg's `fade` start a frame earlier). The preview's `markOpacity`.
/// `how`: what fades (`:alpha=1`, or `:color=white`).
fn ramps(length: u32, fade_in: u32, fade_out: u32, how: &str) -> String {
    let mut r = String::new();
    if fade_in > 0 {
        r += &format!(",fade=t=in:s=1:n={fade_in}{how}");
    }
    if fade_out > 0 {
        r += &format!(",fade=t=out:s={}:n={fade_out}{how}", length - fade_out);
    }
    r
}

/// A stream's frames put on the export's from frame `from`: its frame k at `from` + k, on a clock
/// of one frame a tick, so each lands on the picture's frame exactly. (In microseconds, markup's
/// were rounded: 37/60 s up past the picture's 37th frame, and a stretch's last frame went
/// missing.)
fn on_frames(rate: Rate, from: u32) -> String {
    format!("settb={}/{},setpts=N+{from}", rate.den, rate.num)
}

/// The clips' fades laid over the picture `at` (PLAN 4.7a): on each fade's frames, black (or
/// its colour, 4.7c) `black` in size, its alpha ramped as the preview's black is (the clip's first frame and last
/// all black, `ramps`), on the joined picture's clock: frame k
/// at k (timed in AVTB, a fade's last frame could round past the picture's and go missing; as
/// markup is, `on_frames`). The picture's label after it.
fn clip_fades(
    f: &mut Vec<String>,
    at: &str,
    cuts: &[Cut],
    black: (u32, u32),
    rate: Rate,
) -> String {
    let mut at = at.to_string();
    let xf = crossfades(cuts);
    let mut start = 0;
    for (i, c) in cuts.iter().enumerate() {
        let length = c.length();
        // Over the end of the one before, crossfading.
        start -= xf[i];
        // The black's own fade: out as the clip fades in (all black on its first frame); in as
        // it fades out, a frame early and that frame dropped (all black on its last).
        let fades = [
            ("in", start, c.fade_in, &c.fade_in_colour, "t=out:s=0", 0),
            (
                "out",
                start + length - c.fade_out,
                c.fade_out,
                &c.fade_out_colour,
                "t=in:s=0",
                1,
            ),
        ];
        for (name, from, n, colour, t, early) in fades {
            if n == 0 {
                continue;
            }
            let colour = colour.as_deref().unwrap_or("black");
            f.push(format!(
                "color=c={colour}:s={}x{}:r={}/{},format=yuva444p,trim=end_frame={},fade={t}:n={n}:alpha=1,trim=start_frame={early},settb={}/{},setpts=N+{from}[cf{i}{name}]",
                black.0, black.1, rate.num, rate.den, n + early, rate.den, rate.num
            ));
            f.push(format!(
                "[{at}][cf{i}{name}]overlay=x=0:y=0:format=yuv444:eof_action=pass:enable='between(n,{from},{})'[cd{i}{name}]",
                from + n - 1
            ));
            at = format!("cd{i}{name}");
        }
        start += length;
    }
    at
}

/// A highlight (item `k`, its picture `p{k}_{j}`) multiplied into the picture `at` (PLAN 4.5c),
/// as the preview's CSS multiply does: on each stretch it shows on, the frame's region under it
/// cut out, multiplied with it in RGB (white leaves it as it is), and put back. Faded, the
/// highlight fades towards white, frame by frame as a faded item's alpha does. The picture's
/// label after it.
fn highlight(f: &mut Vec<String>, at: &str, k: usize, o: &Overlay, rate: Rate) -> String {
    let region = format!("{}:{}:{}:{}", o.width, o.height, o.x, o.y);
    let back = |f: &mut Vec<String>, at: &str, by: &str, name: &str, from: u32, to: u32| {
        f.push(format!("[{at}]split[hb{name}][hc{name}]"));
        f.push(format!("[hc{name}]crop={region},format=gbrp[hr{name}]"));
        f.push(format!("[hr{name}][{by}]blend=all_mode=multiply[hm{name}]"));
        f.push(format!(
            "[hb{name}][hm{name}]overlay=x={}:y={}:format=yuv444:eof_action=pass:enable='between(n,{from},{})'[h{name}]",
            o.x,
            o.y,
            to - 1
        ));
        format!("h{name}")
    };
    if o.fade_in == 0 && o.fade_out == 0 {
        // Unfaded: the one picture, on each stretch.
        let mut at = at.to_string();
        for (j, s) in o.shows.iter().enumerate() {
            let name = format!("{k}_{j}");
            f.push(format!("[p{name}]format=gbrp[hw{name}]"));
            at = back(f, &at, &format!("hw{name}"), &name, s.from, s.to);
        }
        return at;
    }
    // Faded: the picture once per frame of the item, faded to white by frame count (the preview's
    // ramp), then each stretch's frames timed to the export's.
    let mut chain = format!("[p{k}_0]format=gbrp,loop=loop={}:size=1:start=0", o.length);
    chain += &ramps(o.length, o.fade_in, o.fade_out, ":color=white");
    let parts = o.shows.len();
    if parts > 1 {
        chain += &format!(",split={parts}");
    }
    chain += &(0..parts)
        .map(|j| format!("[hf{k}_{j}]"))
        .collect::<String>();
    f.push(chain);
    let mut at = at.to_string();
    for (j, s) in o.shows.iter().enumerate() {
        let name = format!("{k}_{j}");
        f.push(format!(
            "[hf{name}]trim=start_frame={}:end_frame={},{}[hw{name}]",
            s.at + 1,
            s.at + 1 + s.to - s.from,
            on_frames(rate, s.from)
        ));
        at = back(f, &at, &format!("hw{name}"), &name, s.from, s.to);
    }
    at
}

/// The spotlights' darkness laid over the picture `at` (PLAN 4.5g), as the preview's is: on each
/// stretch with a spotlight showing, black at the darkness (`MarkLayer::Dark`, faded as an item
/// is), with every hole showing cut out of it. The holes are multiplied into one white picture
/// the export's `total` frames long, as highlights are into the frame (a hole's RGB is white
/// outside it and black inside, and fades towards white): its grey is how much of the darkness
/// is left, which each stretch's black takes as its alpha. The picture's label after it.
fn dark(f: &mut Vec<String>, at: &str, overlays: &[Overlay], total: u32, rate: Rate) -> String {
    let runs: Vec<(usize, &Overlay, f64)> = overlays
        .iter()
        .enumerate()
        .filter_map(|(k, o)| match o.layer {
            MarkLayer::Dark { dim } => Some((k, o, dim)),
            _ => None,
        })
        .collect();
    let Some((_, first, _)) = runs.first() else {
        return at.to_string();
    };
    let size = format!("{}x{}", first.width, first.height);
    let clock = format!("r={}/{}", rate.num, rate.den);
    // On the holes' clock (`highlight`'s times), or a hole's frame and the white's can round
    // apart and the hole show a frame late.
    f.push(format!(
        "color=c=white:s={size}:{clock},format=gbrp,trim=end_frame={total},{}[k]",
        on_frames(rate, 0)
    ));
    let mut left = "k".to_string();
    for (k, o) in overlays.iter().enumerate() {
        if o.layer == MarkLayer::Hole {
            left = highlight(f, &left, k, o, rate);
        }
    }
    let parts: usize = runs.iter().map(|(_, o, _)| o.shows.len()).sum();
    let split = if parts > 1 {
        format!("split={parts}")
    } else {
        "null".to_string()
    };
    f.push(format!(
        "[{left}]{split}{}",
        (0..parts).map(|i| format!("[ks{i}]")).collect::<String>()
    ));
    let mut at = at.to_string();
    let mut part = 0;
    for (k, o, dim) in runs {
        // A frame more in front, for the fades (`ramps`).
        let mut chain = format!(
            "color=c=black@{:.4}:s={size}:{clock},format=gbrap,trim=end_frame={}",
            (dim / 100.0).clamp(0.0, 1.0),
            o.length + 1
        );
        chain += &ramps(o.length, o.fade_in, o.fade_out, ":alpha=1");
        let shows = o.shows.len();
        if shows > 1 {
            chain += &format!(",split={shows}");
        }
        chain += &(0..shows)
            .map(|j| format!("[dv{k}_{j}]"))
            .collect::<String>();
        f.push(chain);
        for (j, s) in o.shows.iter().enumerate() {
            let name = format!("{k}_{j}");
            f.push(format!(
                "[dv{name}]trim=start_frame={}:end_frame={},{}[dw{name}]",
                s.at + 1,
                s.at + 1 + s.to - s.from,
                on_frames(rate, s.from)
            ));
            // What's left of the darkness on these frames, as a grey picture's alpha.
            f.push(format!(
                "[ks{part}]trim=start_frame={}:end_frame={},split[ka{name}][kb{name}]",
                s.from, s.to
            ));
            f.push(format!(
                "[ka{name}]format=gbrap[kc{name}];[kc{name}][kb{name}]alphamerge[kd{name}]"
            ));
            f.push(format!(
                "[dw{name}][kd{name}]blend=all_mode=multiply[dk{name}]"
            ));
            f.push(format!(
                "[{at}][dk{name}]overlay=x=0:y=0:format=yuv444:eof_action=pass:enable='between(n,{},{})'[d{name}]",
                s.from,
                s.to - 1
            ));
            at = format!("d{name}");
            part += 1;
        }
    }
    at
}

// --- the encoder ---

/// Finds the encoders that work here, best first, on a thread (at startup): a moment's test
/// encode with each.
pub fn probe(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let found = encoders_here();
        logln!(
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
pub(crate) fn encoders(app: &AppHandle) -> Vec<Encoder> {
    if let Some(found) = app.state::<AppState>().encoders.lock().unwrap().clone() {
        return found;
    }
    let found = encoders_here();
    *app.state::<AppState>().encoders.lock().unwrap() = Some(found.clone());
    found
}

// --- exporting ---

/// The open files, as export reads them, first first (it sets the picture and the rate).
fn inputs(app: &AppHandle) -> Result<Vec<Input>, String> {
    let state = app.state::<AppState>();
    let open = state.sources.lock().unwrap();
    if open.is_empty() {
        return Err("No video is open.".into());
    }
    Ok(open
        .iter()
        .map(|s| {
            let (w, h) = (s.info.width, s.info.height);
            let (width, height) = if s.info.rotation % 180 == 90 {
                (h, w)
            } else {
                (w, h)
            };
            Input {
                id: crate::protocol::source_url(s.generation),
                path: s.path.clone(),
                rate: s.grid.rate,
                starts: grid::times(&s.info.video, &s.grid)
                    .into_iter()
                    .map(|(start, _)| start)
                    .collect(),
                audio_tracks: s.info.audio_tracks,
                width,
                height,
                camera: s.camera.clone(),
            }
        })
        .collect())
}

/// What an export makes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Mp4,
    Gif,
}

impl Format {
    fn extension(self) -> &'static str {
        match self {
            Format::Mp4 => "mp4",
            Format::Gif => "gif",
        }
    }
}

/// The first file (the picture and the rate) and the cuts for `clips`, checked: each clip fits
/// its file, and `output` isn't one of them. Each one's camera on `frame`, if its file has one.
fn prepare(
    app: &AppHandle,
    clips: &[ExportClip],
    frame: &ExportFrame,
    output: &Path,
) -> Result<(Input, Vec<Cut>), String> {
    let mut inputs = inputs(app)?;
    if clips.is_empty() {
        return Err("There's nothing to export.".into());
    }
    if inputs.iter().any(|i| i.path == output) {
        return Err("The export can't replace a video it's made from.".into());
    }
    let first = &inputs[0];
    let (keep_pitch, camera_fades) = {
        let state = app.state::<AppState>();
        let settings = state.settings.read().unwrap();
        (
            settings.timeline.keep_pitch,
            settings.recording.camera_fades,
        )
    };
    let first_size = (first.width, first.height);
    let out = output_size(frame, first.width, first.height);
    let mut cuts = Vec::with_capacity(clips.len());
    for c in clips {
        let input = inputs
            .iter()
            .find(|i| i.id == c.source)
            .ok_or("The edit names a video that isn't open.")?;
        if c.from >= c.out || c.out as usize > input.starts.len() || c.length() == 0 {
            return Err("The edit doesn't fit the video.".into());
        }
        let mut made = cut(input, first, c, keep_pitch);
        made.camera = input.camera.as_ref().map(|(path, place)| {
            let (x, y, size) =
                camera_on_frame(*place, (input.width, input.height), first_size, frame, out);
            let fades = camera_fades.then_some((made.fade_in, made.fade_out));
            let (fade_in, fade_out) = fades.unwrap_or_default();
            CutCamera {
                path: path.clone(),
                x,
                y,
                size,
                fade_in,
                fade_out,
            }
        });
        cuts.push(made);
    }
    Ok((inputs.swap_remove(0), cuts))
}

/// Renders `clips` of the open source to `output` as `format`, blocking. `progress` gets 0
/// to 1.
#[allow(clippy::too_many_arguments)]
pub fn render(
    app: &AppHandle,
    clips: &[ExportClip],
    frame: ExportFrame,
    markup: &Markup,
    output: &Path,
    format: Format,
    progress: impl FnMut(f64),
    stop: &AtomicBool,
) -> Result<Outcome, String> {
    let started = Instant::now();
    let done = match format {
        Format::Mp4 => render_mp4(app, clips, &frame, markup, output, progress, stop),
        Format::Gif => render_gif(app, clips, &frame, markup, output, progress, stop),
    }?;
    if matches!(done, Outcome::Finished) {
        logln!(
            "[export] {format:?} of {} clips, {} markup items, in {:.1} s",
            clips.len(),
            markup.items.len(),
            started.elapsed().as_secs_f64()
        );
    }
    Ok(done)
}

/// An MP4: the best encoder, then the next if one fails.
fn render_mp4(
    app: &AppHandle,
    clips: &[ExportClip],
    frame: &ExportFrame,
    markup: &Markup,
    output: &Path,
    mut progress: impl FnMut(f64),
    stop: &AtomicBool,
) -> Result<Outcome, String> {
    let (input, cuts) = prepare(app, clips, frame, output)?;
    let frames = u64::from(export_frames(&cuts));
    let made = frame_filter(frame, input.width, input.height);
    let marks = overlays(clips, markup);
    let (width, height) = output_size(frame, input.width, input.height);
    let rate = bitrate(width, height, input.rate.fps());
    let black = black_size(frame, input.width, input.height);
    let mut last = String::new();
    for encoder in encoders(app) {
        let (a, _graph) = graph_from_file(
            args(
                &cuts,
                input.rate,
                made.as_deref(),
                black,
                &marks,
                encoder,
                rate,
            ),
            &std::env::temp_dir(),
        )?;
        match ffmpeg::run_now(&a, output, Some(frames), &mut progress, || {
            stop.load(Ordering::Relaxed)
        }) {
            Ok(done) => {
                logln!("[export] encoded with {}", encoder.codec());
                return Ok(done);
            }
            Err(e) => {
                logln!("[export] {} failed: {e}", encoder.codec());
                last = e;
            }
        }
    }
    Err(last)
}

/// A GIF: ffmpeg's frames piped into gifski (spike 0.3: better and faster than ffmpeg's own
/// palette). The frames are counted on their way through, for progress.
fn render_gif(
    app: &AppHandle,
    clips: &[ExportClip],
    frame: &ExportFrame,
    markup: &Markup,
    output: &Path,
    mut progress: impl FnMut(f64),
    stop: &AtomicBool,
) -> Result<Outcome, String> {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::process::Stdio;

    let (input, cuts) = prepare(app, clips, frame, output)?;
    let (gif_fps, size) = {
        let state = app.state::<AppState>();
        let settings = state.settings.read().unwrap();
        (settings.export.gif_fps, settings.export.gif_size)
    };
    let grid = u64::from(export_frames(&cuts));
    let frames = ((grid as f64) * f64::from(gif_fps) / input.rate.fps())
        .ceil()
        .max(1.0);
    let part = output.with_extension("part");
    let (a, _graph) = graph_from_file(
        gif_args(
            &cuts,
            input.rate,
            frame_filter(frame, input.width, input.height).as_deref(),
            black_size(frame, input.width, input.height),
            &overlays(clips, markup),
            gif_fps,
            size,
        ),
        &std::env::temp_dir(),
    )?;

    let mut ffmpeg = sidecar::command(Tool::Ffmpeg)?;
    ffmpeg
        .args(["-hide_banner", "-nostdin", "-loglevel", "error"])
        .args(a)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut ffmpeg =
        sidecar::spawn(&mut ffmpeg).map_err(|e| format!("ffmpeg didn't start: {e}"))?;
    let ffmpeg_log = drain(ffmpeg.stderr.take());
    let mut frames_in = BufReader::new(ffmpeg.stdout.take().ok_or("no frames from ffmpeg")?);

    // The stream's header says the frame size: "YUV4MPEG2 W480 H270 F20:1 ... C420jpeg".
    let mut header = String::new();
    frames_in
        .read_line(&mut header)
        .map_err(|e| e.to_string())?;
    let Some((width, height)) = y4m_size(&header) else {
        let _ = ffmpeg.kill();
        let _ = ffmpeg.wait();
        let log = ffmpeg_log.join().unwrap_or_default();
        return Err(log.unwrap_or_else(|| "ffmpeg made no frames".into()));
    };
    let frame_bytes = width * height + 2 * width.div_ceil(2) * height.div_ceil(2);

    let mut gifski = sidecar::command(Tool::Gifski)?;
    gifski
        .args(["--quiet", "--quality", "90", "--fps"])
        .arg(gif_fps.to_string())
        // gifski shrinks to about 800x600 unless told the size.
        .args(["--width", &width.to_string(), "--output"])
        .arg(&part)
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut gifski =
        sidecar::spawn(&mut gifski).map_err(|e| format!("gifski didn't start: {e}"))?;
    let gifski_log = drain(gifski.stderr.take());
    let mut frames_out = gifski.stdin.take().ok_or("gifski takes no frames")?;

    let stopped = |ffmpeg: &mut std::process::Child, gifski: &mut std::process::Child| {
        let _ = ffmpeg.kill();
        let _ = gifski.kill();
        let _ = ffmpeg.wait();
        let _ = gifski.wait();
        let _ = std::fs::remove_file(&part);
    };
    let copied = (|| -> std::io::Result<()> {
        frames_out.write_all(header.as_bytes())?;
        let mut frame = vec![0u8; frame_bytes];
        let mut line = String::new();
        let mut n = 0.0;
        loop {
            if stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            // Each frame: a "FRAME" line, then its planes.
            line.clear();
            if frames_in.read_line(&mut line)? == 0 {
                return Ok(());
            }
            frames_in.read_exact(&mut frame)?;
            frames_out.write_all(line.as_bytes())?;
            frames_out.write_all(&frame)?;
            n += 1.0;
            progress((n / frames).min(1.0));
        }
    })();
    drop(frames_out);
    if stop.load(Ordering::Relaxed) {
        stopped(&mut ffmpeg, &mut gifski);
        return Ok(Outcome::Stopped);
    }
    let ffmpeg_ok = ffmpeg.wait().is_ok_and(|s| s.success());
    let gifski_ok = gifski.wait().is_ok_and(|s| s.success());
    let ffmpeg_log = ffmpeg_log.join().unwrap_or_default();
    let gifski_log = gifski_log.join().unwrap_or_default();
    if !ffmpeg_ok || !gifski_ok {
        if let Err(e) = &copied {
            logln!("[export] passing frames to gifski: {e}");
        }
        let _ = std::fs::remove_file(&part);
        let why = if ffmpeg_ok { gifski_log } else { ffmpeg_log };
        return Err(why.unwrap_or_else(|| "the GIF couldn't be made".into()));
    }
    std::fs::rename(&part, output).map_err(|e| format!("can't keep {}: {e}", output.display()))?;
    Ok(Outcome::Finished)
}

/// Reads a child's stderr on a thread (a full pipe would stall it); its last line, at the end.
fn drain(stderr: Option<std::process::ChildStderr>) -> std::thread::JoinHandle<Option<String>> {
    use std::io::{BufRead, BufReader};
    std::thread::spawn(move || {
        let mut last = None;
        for line in BufReader::new(stderr?).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                last = Some(line.trim().to_string());
            }
        }
        last
    })
}

/// The frame size in a YUV4MPEG2 stream's header line.
fn y4m_size(header: &str) -> Option<(usize, usize)> {
    let mut words = header.split_whitespace();
    if words.next()? != "YUV4MPEG2" {
        return None;
    }
    let (mut w, mut h) = (None, None);
    for word in words {
        if let Some(v) = word.strip_prefix('W') {
            w = v.parse().ok();
        } else if let Some(v) = word.strip_prefix('H') {
            h = v.parse().ok();
        }
    }
    Some((w?, h?))
}

/// A file to write: its clips, where, and as what.
pub struct Job {
    pub clips: Vec<ExportClip>,
    pub frame: ExportFrame,
    /// The markup, shared by the jobs of one export.
    pub markup: Arc<Markup>,
    pub output: PathBuf,
    pub format: Format,
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
        let mut bytes = 0.0;
        let mut message = None;
        for (k, job) in jobs.iter().enumerate() {
            crate::log::private_file(&job.output);
            let name = file_name(&job.output);
            let progress = |done: f64| {
                let _ = ExportProgress {
                    name: name.clone(),
                    done: (k as f64 + done) / n,
                }
                .emit_to(&app, LABEL);
            };
            progress(0.0);
            match render(
                &app,
                &job.clips,
                job.frame.clone(),
                &job.markup,
                &job.output,
                job.format,
                progress,
                &stop,
            ) {
                Ok(Outcome::Finished) => {
                    bytes += std::fs::metadata(&job.output).map_or(0.0, |m| m.len() as f64);
                    files.push(job.output.display().to_string());
                }
                Ok(Outcome::Stopped) => break,
                Err(e) => {
                    message = Some(format!("{name} couldn't be exported ({e})."));
                    break;
                }
            }
        }
        *app.state::<AppState>().exporting.lock().unwrap() = None;
        let _ = ExportEnded {
            files,
            bytes,
            message,
        }
        .emit_to(&app, LABEL);
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

/// The first file's name without its extension, for naming exports, and its folder.
fn stem(app: &AppHandle) -> Option<(String, PathBuf)> {
    let state = app.state::<AppState>();
    let open = state.sources.lock().unwrap();
    let s = open.first()?;
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

/// The file name for the whole timeline (`clip` None) or clip `clip`, from Settings › Export's
/// templates and their tags (names.rs); `{n}` counts up past `taken`, the names in the folder
/// it goes to.
fn export_name(
    names: &Names,
    stem: &str,
    clip: Option<u32>,
    format: Format,
    taken: Vec<String>,
    now: &crate::names::Timestamp,
) -> String {
    let template = if clip.is_some() {
        &names.clip
    } else {
        &names.timeline
    };
    let rendered = crate::names::render(template, stem, clip, now);
    format!(
        "{}.{}",
        crate::names::number(&rendered, taken),
        format.extension()
    )
}

/// Settings › Export: how exports are named, and whether (and where) they skip the dialog.
struct Names {
    timeline: String,
    clip: String,
    /// "Save to default folder": the folder.
    save_to: Option<PathBuf>,
}

fn names(app: &AppHandle) -> Names {
    let e = app
        .state::<AppState>()
        .settings
        .read()
        .unwrap()
        .export
        .clone();
    Names {
        timeline: e.timeline_name,
        clip: e.clip_name,
        save_to: e.save_to_folder.then(|| export_folder(app, &e.folder)),
    }
}

/// Settings › Export's preview of a name template: the file an export would get now, as MP4,
/// with the open video's name (else "video"), clip 1 for a clip's, `{n}` counted in the export
/// folder.
pub fn preview_name(app: &AppHandle, template: &str, clip: bool) -> String {
    let stem = stem(app).map_or_else(|| "video".to_string(), |(name, _)| name);
    let folder = {
        let state = app.state::<AppState>();
        let e = &state.settings.read().unwrap().export;
        export_folder(app, &e.folder)
    };
    let names = Names {
        timeline: template.to_string(),
        clip: template.to_string(),
        save_to: None,
    };
    let now = crate::names::Timestamp::now_local();
    let clip = clip.then_some(1);
    export_name(
        &names,
        &stem,
        clip,
        Format::Mp4,
        crate::names::taken_in(&folder),
        &now,
    )
}

/// The default export folder: Settings › Export › Folder, or the Videos folder's Razorcat folder.
fn export_folder(app: &AppHandle, setting: &str) -> PathBuf {
    if !setting.is_empty() {
        return crate::paths::resolve_dir(setting);
    }
    default_folder(app).unwrap_or_default()
}

/// Where exports go when Settings › Export › Folder is empty.
pub fn default_folder(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .video_dir()
        .or_else(|_| app.path().home_dir())
        .ok()
        .map(|d| d.join("Razorcat"))
}

/// Makes `folder` for a save there.
fn make_folder(folder: &Path) -> Result<(), String> {
    std::fs::create_dir_all(folder).map_err(|e| format!("can't make {}: {e}", folder.display()))
}

/// The export couldn't start: says why (as a failed export does).
fn refuse(app: &AppHandle, message: String) -> bool {
    let _ = ExportEnded {
        files: Vec::new(),
        bytes: 0.0,
        message: Some(message),
    }
    .emit_to(app, LABEL);
    false
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
pub fn ask_and_export(
    app: &AppHandle,
    clips: Vec<ExportClip>,
    frame: ExportFrame,
    marks: Vec<ExportMark>,
    clip: Option<u32>,
    format: Format,
) -> bool {
    use tauri_plugin_dialog::DialogExt;
    let Some((stem, source_folder)) = stem(app).filter(|_| !busy(app)) else {
        return false;
    };
    let markup = match markup::take(app, marks) {
        Ok(m) => Arc::new(m),
        Err(e) => return refuse(app, e),
    };
    let names = names(app);
    // `{n}` counts in the folder it goes to: the default one, or where the Save dialog opens.
    let start_in = crate::folders::export_start(app, &source_folder);
    let counted_in = names.save_to.clone().or_else(|| start_in.clone());
    let taken = counted_in
        .as_deref()
        .map(crate::names::taken_in)
        .unwrap_or_default();
    let now = crate::names::Timestamp::now_local();
    let file = export_name(&names, &stem, clip, format, taken, &now);
    // Save to default folder: no dialog, never over another file.
    if let Some(folder) = &names.save_to {
        if let Err(e) = make_folder(folder) {
            return refuse(app, format!("{file} couldn't be exported ({e})."));
        }
        let output = free_name(folder, &file);
        return start(
            app,
            vec![Job {
                clips,
                frame,
                markup,
                output,
                format,
            }],
        );
    }
    let (kind, ext) = match format {
        Format::Mp4 => ("MP4 video", "mp4"),
        Format::Gif => ("GIF animation", "gif"),
    };
    let mut dialog = app
        .dialog()
        .file()
        .set_title(if clip.is_some() {
            "Export clip"
        } else {
            "Export"
        })
        .add_filter(kind, &[ext])
        .set_file_name(file);
    if let Some(start) = start_in {
        dialog = dialog.set_directory(start);
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        dialog = dialog.set_parent(&window);
    }
    let Some(mut output) = dialog.blocking_save_file().and_then(|p| p.into_path().ok()) else {
        return false;
    };
    if output.extension().is_none() {
        output.set_extension(ext);
    }
    if let Some(folder) = output.parent() {
        crate::folders::saved_to(app, folder);
    }
    start(
        app,
        vec![Job {
            clips,
            frame,
            markup,
            output,
            format,
        }],
    )
}

/// Asks for a folder, then exports each clip as its own file there (named by its number; a
/// name already taken gets one of its own).
pub fn ask_and_export_each(
    app: &AppHandle,
    clips: Vec<ExportClip>,
    frame: ExportFrame,
    marks: Vec<ExportMark>,
    format: Format,
) -> bool {
    use tauri_plugin_dialog::DialogExt;
    let Some((stem, source_folder)) = stem(app).filter(|_| !busy(app)) else {
        return false;
    };
    let markup = match markup::take(app, marks) {
        Ok(m) => Arc::new(m),
        Err(e) => return refuse(app, e),
    };
    let names = names(app);
    let folder = if let Some(folder) = names.save_to.clone() {
        if let Err(e) = make_folder(&folder) {
            return refuse(app, format!("The clips couldn't be exported ({e})."));
        }
        folder
    } else {
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
        folder
    };
    // `{n}` counts on from file to file: each clip's name is taken for the next.
    let mut taken = crate::names::taken_in(&folder);
    let now = crate::names::Timestamp::now_local();
    let jobs = clips
        .into_iter()
        .map(|c| {
            let file = export_name(&names, &stem, Some(c.id), format, taken.clone(), &now);
            if let Some(name) = Path::new(&file).file_stem() {
                taken.push(name.to_string_lossy().into_owned());
            }
            Job {
                output: free_name(&folder, &file),
                clips: vec![c],
                frame: frame.clone(),
                markup: markup.clone(),
                format,
            }
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

    /// A file of 300 frames at 30 fps, `width` × `height`, with `tracks` of sound.
    fn input(id: &str, width: u32, height: u32, tracks: u32) -> Input {
        Input {
            id: id.into(),
            path: PathBuf::from(format!("{id}.mp4")),
            rate: Rate { num: 30, den: 1 },
            starts: (0..300).map(|k| f64::from(k) / 30.0).collect(),
            audio_tracks: tracks,
            width,
            height,
            camera: None,
        }
    }

    /// `cuts` all of `path`, its first frame at `origin`, with `tracks` of sound.
    fn of(path: &Path, cuts: &[Cut], origin: f64, tracks: u32) -> Vec<Cut> {
        cuts.iter()
            .map(|c| Cut {
                path: path.into(),
                origin,
                tracks,
                ..c.clone()
            })
            .collect()
    }

    /// The MP4 arguments for `cuts` of one file.
    #[allow(clippy::too_many_arguments)]
    fn one_file(
        path: &Path,
        cuts: &[Cut],
        rate: Rate,
        origin: f64,
        tracks: u32,
        frame: Option<&str>,
        overlays: &[Overlay],
        encoder: Encoder,
        bitrate: u64,
    ) -> Vec<OsString> {
        args(
            &of(path, cuts, origin, tracks),
            rate,
            frame,
            (1920, 1080),
            overlays,
            encoder,
            bitrate,
        )
    }

    /// The GIF arguments for `cuts` of one file.
    #[allow(clippy::too_many_arguments)]
    fn one_file_gif(
        path: &Path,
        cuts: &[Cut],
        rate: Rate,
        origin: f64,
        frame: Option<&str>,
        overlays: &[Overlay],
        gif_fps: u32,
        size: u32,
    ) -> Vec<OsString> {
        gif_args(
            &of(path, cuts, origin, 0),
            rate,
            frame,
            (1920, 1080),
            overlays,
            gif_fps,
            size,
        )
    }

    #[test]
    fn a_retimed_clip_picks_its_frames_and_stretches_its_sound() {
        let rate = Rate { num: 30, den: 1 };
        // Source frames 60 to 90 at 50%, phase 1: its frames 119 to 179, 60 of them.
        let half = ClipSpeed {
            num: 1,
            den: 2,
            phase: 1,
            first: 119,
            length: 60,
        };
        let c = [Cut {
            path: "a.mp4".into(),
            from: 60,
            out: 90,
            tracks: 1,
            speed: Some(half),
            keep_pitch: true,
            ..Cut::default()
        }];
        assert_eq!(export_frames(&c), 60);
        let a = joined(&args(
            &c,
            rate,
            None,
            (1920, 1080),
            &[],
            Encoder::X264,
            6_000_000,
        ));
        assert!(a.contains(
            "trim=start_pts=60:end_pts=90,setpts=PTS-STARTPTS,setpts='max(0,ceil(((N+60)*2-1)/1)-119)',fps=30/1,trim=end_frame=60[v0]"
        ));
        // A second of source made two: one atempo stage, its lead taken out, two seconds long.
        assert!(a.contains(
            "atrim=start=2.000000:duration=1.000000,asetpts=PTS-STARTPTS,atempo=0.500000,adelay=20.000:all=1,asetpts=N/SR/TB,apad,atrim=duration=2.000000[a0]"
        ));
        // Tape-style, and a chain below 50%.
        assert_eq!(
            tempo(half, false, 2.0),
            ",aresample=48000,asetrate=24000.0000,aresample=48000,asetpts=N/SR/TB,apad,atrim=duration=2.000000"
        );
        let tenth = ClipSpeed {
            num: 1,
            den: 10,
            ..half
        };
        assert_eq!(
            tempo(tenth, true, 10.0),
            ",atempo=0.500000,atempo=0.500000,atempo=0.500000,atempo=0.800000,adelay=130.000:all=1,asetpts=N/SR/TB,apad,atrim=duration=10.000000"
        );
    }

    #[test]
    fn each_clip_is_seeked_before_its_first_frame() {
        let a = input("a", 1920, 1080, 1);
        let c = [
            cut(&a, &a, &clip(1, 0, 30, 0), true),
            cut(&a, &a, &clip(2, 240, 270, 0), true),
        ];
        assert_eq!(c[0].seek, 0.0);
        assert!((c[1].seek - 7.5).abs() < 1e-9);
        assert_eq!(c[0].fit, None);
        // Another file, of another size: its own, fitted into the first's picture.
        let b = input("b", 1280, 1024, 0);
        let d = cut(
            &b,
            &a,
            &ExportClip {
                source: "b".into(),
                ..clip(3, 0, 30, 30)
            },
            true,
        );
        assert_eq!(d.path, PathBuf::from("b.mp4"));
        assert_eq!((d.tracks, d.fit), (0, Some((1920, 1080))));
    }

    #[test]
    fn another_file_is_fitted_in_and_silent_without_sound() {
        let rate = Rate { num: 30, den: 1 };
        let c = [
            Cut {
                path: "a.mp4".into(),
                out: 30,
                tracks: 1,
                ..Cut::default()
            },
            Cut {
                path: "b.mp4".into(),
                seek: 1.0,
                origin: 0.2,
                from: 60,
                out: 90,
                fit: Some((1920, 1080)),
                ..Cut::default()
            },
        ];
        let a = joined(&args(
            &c,
            rate,
            None,
            (1920, 1080),
            &[],
            Encoder::X264,
            6_000_000,
        ));
        assert!(a.starts_with("-ss 0.000000 -i a.mp4 -ss 1.000000 -i b.mp4"));
        assert!(a.contains(
            "[1:v:0]setpts=PTS+(0.800000)/TB,fps=30/1,trim=start_pts=60:end_pts=90,setpts=PTS-STARTPTS,\
             scale=1920:1080:force_original_aspect_ratio=decrease,\
             pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v1]"
        ));
        assert!(a.contains("anullsrc=r=48000:cl=stereo,atrim=duration=1.000000[a1]"));
        assert!(a.contains("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][ac]"));
        // Only the silent file heard: no sound at all.
        let quiet = joined(&args(
            &c[1..],
            rate,
            None,
            (1920, 1080),
            &[],
            Encoder::X264,
            6_000_000,
        ));
        assert!(quiet.contains("[v0]concat=n=1:v=1:a=0[vc];"));
        assert!(!quiet.contains("anullsrc"));
    }

    #[test]
    fn the_graph_puts_clips_on_the_grid_and_joins_them() {
        let c = [
            Cut {
                seek: 0.0,
                from: 0,
                out: 30,
                muted: false,
                ..Default::default()
            },
            Cut {
                seek: 7.5,
                from: 240,
                out: 270,
                muted: false,
                ..Default::default()
            },
        ];
        let rate = Rate { num: 30, den: 1 };
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            1,
            None,
            &[],
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
            muted: false,
            ..Default::default()
        }];
        let rate = Rate { num: 30, den: 1 };
        let two = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            2,
            None,
            &[],
            Encoder::Nvenc,
            6_000_000,
        ));
        assert!(two.contains("[0:a:0][0:a:1]amix=inputs=2:normalize=0:duration=longest,atrim="));
        let none = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            0,
            None,
            &[],
            Encoder::Nvenc,
            6_000_000,
        ));
        assert!(none.contains("[v0]concat=n=1:v=1:a=0[vc];"));
        assert!(!none.contains("[ac]"));
        assert!(!none.contains("-c:a"));
    }

    #[test]
    fn a_muted_clip_is_silenced_and_all_muted_has_no_audio() {
        let cut = |seek: f64, from: u32, muted: bool| Cut {
            seek,
            from,
            out: from + 30,
            muted,
            ..Default::default()
        };
        let rate = Rate { num: 30, den: 1 };
        let mp4 = |c: &[Cut]| {
            joined(&one_file(
                Path::new("in.mp4"),
                c,
                rate,
                0.0,
                1,
                None,
                &[],
                Encoder::X264,
                6_000_000,
            ))
        };
        let one = mp4(&[cut(0.0, 0, false), cut(7.5, 240, true)]);
        assert!(one.contains("asetpts=PTS-STARTPTS[a0]"));
        assert!(one.contains("asetpts=PTS-STARTPTS,volume=0[a1]"));
        assert!(one.contains("concat=n=2:v=1:a=1[vc][ac]"));
        let all = mp4(&[cut(0.0, 0, true), cut(7.5, 240, true)]);
        assert!(all.contains("[v0][v1]concat=n=2:v=1:a=0[vc];"));
        assert!(!all.contains("[ac]"));
        assert!(!all.contains("-c:a"));
    }

    #[test]
    fn a_late_first_frame_shifts_the_clock() {
        // The first shown frame at 0.1 s: the grid counts from there.
        let c = [Cut {
            seek: 1.6,
            from: 60,
            out: 90,
            muted: false,
            ..Default::default()
        }];
        let rate = Rate { num: 30, den: 1 };
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.1,
            1,
            None,
            &[],
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
    fn names_come_from_the_templates() {
        let now = crate::names::Timestamp {
            year: 2026,
            month: 10,
            day: 24,
            hour: 9,
            minute: 30,
            second: 0,
        };
        let name = |names: &Names, clip, format, taken: &[&str]| {
            let taken = taken.iter().map(|s| s.to_string()).collect();
            export_name(names, "trip", clip, format, taken, &now)
        };
        let names = Names {
            timeline: crate::settings::TIMELINE_NAME.into(),
            clip: crate::settings::CLIP_NAME.into(),
            save_to: None,
        };
        assert_eq!(name(&names, None, Format::Mp4, &[]), "trip-edit-01.mp4");
        assert_eq!(
            name(&names, None, Format::Mp4, &["trip-edit-01", "trip-edit-04"]),
            "trip-edit-05.mp4"
        );
        assert_eq!(name(&names, Some(3), Format::Mp4, &[]), "trip-clip-03.mp4");
        assert_eq!(name(&names, Some(12), Format::Gif, &[]), "trip-clip-12.gif");
        // Vandal's tags in both, and the auto number past what's in the folder.
        let mine = Names {
            timeline: "{name} {yyyy}-{MM}-{dd} {n}".into(),
            clip: "{c} of {name} {HH}{mm}".into(),
            save_to: None,
        };
        assert_eq!(
            name(&mine, None, Format::Gif, &["trip 2026-10-24 2"]),
            "trip 2026-10-24 3.gif"
        );
        assert_eq!(name(&mine, Some(7), Format::Mp4, &[]), "7 of trip 0930.mp4");
    }

    #[test]
    fn a_gif_is_the_picture_alone_resampled_and_scaled() {
        let c = [Cut {
            seek: 0.0,
            from: 0,
            out: 30,
            muted: false,
            ..Default::default()
        }];
        let rate = Rate { num: 30, den: 1 };
        let a = joined(&one_file_gif(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            None,
            &[],
            20,
            640,
        ));
        assert!(a.contains(
            "[v0]concat=n=1:v=1:a=0[vc];[vc]fps=20,scale='if(gte(iw,ih),min(640,iw),-2)'"
        ));
        assert!(a.ends_with("-map [vout] -f yuv4mpegpipe -"));
        let whole = joined(&one_file_gif(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            None,
            &[],
            25,
            0,
        ));
        assert!(whole.contains("fps=25,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos"));
    }

    fn frame(crop: (u32, u32, u32, u32), grow: [(u32, &str); 4]) -> ExportFrame {
        let side = |(size, colour): (u32, &str)| GrowSide {
            size,
            colour: colour.into(),
        };
        ExportFrame {
            crop: Crop {
                x: crop.0,
                y: crop.1,
                width: crop.2,
                height: crop.3,
            },
            grow: ExportGrow {
                top: side(grow[0]),
                bottom: side(grow[1]),
                left: side(grow[2]),
                right: side(grow[3]),
            },
        }
    }

    const NONE: [(u32, &str); 4] = [(0, ""), (0, ""), (0, ""), (0, "")];

    #[test]
    fn the_crop_is_exact_and_the_whole_picture_isnt_one() {
        assert_eq!(
            frame_filter(&frame((0, 0, 1920, 1080), NONE), 1920, 1080),
            None
        );
        let f = frame((241, 37, 1441, 811), NONE);
        assert_eq!(
            frame_filter(&f, 1920, 1080).as_deref(),
            Some(
                "format=yuv444p,crop=1441:811:241:37:exact=1,crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0"
            )
        );
        assert_eq!(output_size(&f, 1920, 1080), (1440, 810));
        // Kept inside the picture.
        assert_eq!(
            kept_crop(frame((1919, 0, 500, 0), NONE).crop, 1920, 1080),
            Crop {
                x: 1919,
                y: 0,
                width: 1,
                height: 1
            }
        );
        // An odd-sized source, uncropped: the scale evens it, as before.
        assert_eq!(
            frame_filter(&frame((0, 0, 1081, 721), NONE), 1081, 721),
            None
        );
    }

    #[test]
    fn each_grown_side_is_padded_in_its_colour() {
        let f = frame(
            (0, 0, 1920, 1080),
            [(200, "#FFF"), (101, "#000000"), (0, "#ff0000"), (0, "")],
        );
        assert_eq!(
            frame_filter(&f, 1920, 1080).as_deref(),
            Some(
                "format=yuv444p,pad=w=iw:h=ih+200:x=0:y=200:color=0xffffff,\
                 pad=w=iw:h=ih+101:x=0:y=0:color=0x000000,crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0"
            )
        );
        // 1381 high: the last row goes.
        assert_eq!(output_size(&f, 1920, 1080), (1920, 1380));
        let sides = frame(
            (0, 0, 100, 100),
            [(0, ""), (0, ""), (9999, "bad"), (3, "#123456")],
        );
        let made = frame_filter(&sides, 100, 100).unwrap();
        assert!(made.contains("pad=w=iw+4000:h=ih:x=4000:y=0:color=0x000000,"));
        assert!(made.contains("pad=w=iw+3:h=ih:x=0:y=0:color=0x123456,"));
    }

    #[test]
    fn the_frame_is_made_before_the_rest() {
        let c = [Cut {
            seek: 0.0,
            from: 0,
            out: 30,
            muted: false,
            ..Default::default()
        }];
        let rate = Rate { num: 30, den: 1 };
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            0,
            Some("format=yuv444p,crop=2:2:0:0:exact=1"),
            &[],
            Encoder::X264,
            6_000_000,
        ));
        assert!(a.contains("[vc]format=yuv444p,crop=2:2:0:0:exact=1[vf];[vf]scale=trunc(iw/2)*2"));
        let g = joined(&one_file_gif(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            Some("format=yuv444p"),
            &[],
            20,
            640,
        ));
        assert!(g.contains("[vc]format=yuv444p[vf];[vf]fps=20,"));
    }

    #[test]
    fn reads_the_frame_size_of_a_y4m_stream() {
        assert_eq!(
            y4m_size(
                "YUV4MPEG2 W480 H270 F20:1 Ip A1:1 C420jpeg XYSCSS=420JPEG
"
            ),
            Some((480, 270))
        );
        assert_eq!(y4m_size("RIFF W480 H270"), None);
        assert_eq!(y4m_size("YUV4MPEG2 W480"), None);
    }

    fn clip(id: u32, from: u32, out: u32, start: u32) -> ExportClip {
        ExportClip {
            id,
            source: "a".into(),
            from,
            out,
            muted: false,
            start,
            fade_in: 0,
            fade_out: 0,
            fade_in_colour: String::new(),
            fade_out_colour: String::new(),
            crossfade: 0,
            speed: None,
        }
    }

    #[test]
    fn a_crossfading_clip_is_blended_in_over_the_end_of_the_one_before() {
        let rate = Rate { num: 30, den: 1 };
        let cut = |from: u32, crossfade: u32| Cut {
            from,
            out: from + 30,
            crossfade,
            ..Default::default()
        };
        // Three clips of 30 frames: the second crossfades over 6, the third is joined.
        let c = [cut(0, 0), cut(100, 6), cut(200, 0)];
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            1,
            None,
            &[],
            Encoder::X264,
            6_000_000,
        ));
        assert!(a.contains(
            "[v0]format=yuv444p,settb=1/30[xa1];[v1]format=yuv444p,settb=1/30[xb1];\
             [xa1][xb1]xfade=transition=fade:duration=0.200000:offset=0.800000[vj1]"
        ));
        assert!(a.contains("[a0][a1]acrossfade=d=0.200000:c1=tri:c2=tri[aj1]"));
        assert!(a.contains("[vj1][v2]concat=n=2:v=1:a=0[vj2];[aj1][a2]concat=n=2:v=0:a=1[aj2]"));
        assert!(a.contains("[vj2]null[vc];[aj2]anull[ac]"));
        assert_eq!(export_frames(&c), 84);
        // A first clip's crossfade (one exported alone) doesn't count.
        assert_eq!(export_frames(&c[1..2]), 30);
        // Markup over the crossfade shows once, from its start to its end.
        let clips = [
            ExportClip {
                crossfade: 0,
                ..clip(1, 0, 30, 0)
            },
            ExportClip {
                crossfade: 6,
                ..clip(2, 100, 130, 24)
            },
        ];
        let show = |from, to, at| Show { from, to, at };
        assert_eq!(shown(&clips, 20, 40), [show(20, 40, 0)]);
    }

    #[test]
    fn a_clip_fades_from_and_to_black_under_the_markup_and_its_sound_too() {
        let rate = Rate { num: 30, den: 1 };
        // Two clips of 30 frames: the second fades in over 6 and out over 9.
        let c = [
            Cut {
                out: 30,
                ..Default::default()
            },
            Cut {
                seek: 7.5,
                from: 240,
                out: 270,
                fade_in: 6,
                fade_out: 9,
                ..Default::default()
            },
        ];
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            1,
            None,
            &[],
            Encoder::X264,
            6_000_000,
        ));
        // Black fading out over the clip's first 6 frames (export frames 30 to 35)...
        assert!(a.contains(
            "color=c=black:s=1920x1080:r=30/1,format=yuva444p,trim=end_frame=6,\
             fade=t=out:s=0:n=6:alpha=1,trim=start_frame=0,settb=1/30,setpts=N+30[cf1in]"
        ));
        assert!(a.contains(
            "[vc][cf1in]overlay=x=0:y=0:format=yuv444:eof_action=pass:enable='between(n,30,35)'[cd1in]"
        ));
        // ...and in over its last 9 (51 to 59), a frame early, so the last is all black.
        assert!(a.contains(
            "trim=end_frame=10,fade=t=in:s=0:n=9:alpha=1,trim=start_frame=1,settb=1/30,setpts=N+51[cf1out]"
        ));
        assert!(a.contains("enable='between(n,51,59)'[cd1out]"));
        assert!(a.contains("[cd1out]scale="));
        // Its sound fades over as long.
        assert!(a.contains(
            "asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.200000,afade=t=out:st=0.700000:d=0.300000[a1]"
        ));
        assert!(a.contains("asetpts=PTS-STARTPTS[a0]"));
        // Fades kept to the clip's length, the fade-in first.
        let a = input("a", 1920, 1080, 1);
        let long = cut(
            &a,
            &a,
            &ExportClip {
                fade_in: 20,
                fade_out: 20,
                ..clip(1, 0, 30, 0)
            },
            true,
        );
        assert_eq!((long.fade_in, long.fade_out), (20, 10));
    }

    #[test]
    fn the_camera_is_where_the_preview_puts_it() {
        let place = |x, y, size| Place { x, y, size };
        let hd = (1920, 1080);
        // The whole picture: where it was on it.
        let whole = frame((0, 0, 1920, 1080), NONE);
        assert_eq!(
            camera_on_frame(place(1500.0, 700.0, 300.0), hd, hd, &whole, hd),
            (1500, 700, 300)
        );
        // Cropped to its left half: moved with it, and kept inside.
        let half = frame((0, 0, 960, 1080), NONE);
        assert_eq!(
            camera_on_frame(place(1500.0, 700.0, 300.0), hd, hd, &half, (960, 1080)),
            (660, 700, 300)
        );
        // 100 px grown on the left: it stays on the picture.
        let grown = frame(
            (0, 0, 1920, 1080),
            [(0, ""), (0, ""), (100, "#000000"), (0, "")],
        );
        assert_eq!(
            camera_on_frame(place(100.0, 100.0, 200.0), hd, hd, &grown, (2020, 1080)),
            (200, 100, 200)
        );
        // A square file fitted into a 16:9 picture: centred, as tall as it.
        assert_eq!(
            camera_on_frame(place(0.0, 0.0, 100.0), (1000, 1000), hd, &whole, hd),
            (420, 0, 108)
        );
        // No bigger than the frame.
        let small = frame((0, 0, 200, 100), NONE);
        assert_eq!(
            camera_on_frame(place(0.0, 0.0, 5000.0), hd, hd, &small, (200, 100)),
            (0, 0, 100)
        );
    }

    #[test]
    fn the_camera_is_laid_over_everything_on_its_clips_frames_faded_with_them() {
        let rate = Rate { num: 30, den: 1 };
        let camera = |fade_in, fade_out| CutCamera {
            path: PathBuf::from("in (camera).mp4"),
            x: 1500,
            y: 700,
            size: 300,
            fade_in,
            fade_out,
        };
        // Two clips of 30 frames, each with the camera; the second fades in over 6 and out over 9.
        let c = [
            Cut {
                out: 30,
                camera: Some(camera(0, 0)),
                ..Default::default()
            },
            Cut {
                seek: 7.5,
                from: 240,
                out: 270,
                fade_in: 6,
                fade_out: 9,
                camera: Some(camera(6, 9)),
                ..Default::default()
            },
        ];
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            1,
            None,
            &[],
            Encoder::X264,
            6_000_000,
        ));
        // Its inputs after the clips', seeked as they are.
        assert!(a.contains(
            "-ss 0.000000 -i in.mp4 -ss 7.500000 -i in.mp4 -ss 0.000000 -i in (camera).mp4 \
             -ss 7.500000 -i in (camera).mp4 "
        ));
        // On the clip's frames as its picture is, a square, round.
        assert!(a.contains(
            "[3:v:0]setpts=PTS+(7.500000)/TB,fps=30/1,trim=start_pts=240:end_pts=270,\
             setpts=PTS-STARTPTS,crop='min(iw,ih)':'min(iw,ih)',scale=300:300,format=yuva444p[cv1]"
        ));
        assert!(a.contains(
            "color=c=black:s=300x300:r=1:d=1,format=gray,\
             geq=lum='255*clip(150+0.5-hypot(X+0.5-150,Y+0.5-150),0,1)'[cm1]"
        ));
        // Faded as the preview fades it, on its stretch of the export, over everything.
        assert!(a.contains(
            "[cv1][cm1]alphamerge,fade=t=in:s=0:n=6:alpha=1,fade=t=out:s=20:n=9:alpha=1,\
             settb=1/30,setpts=N+30[cc1]"
        ));
        assert!(a.contains("[cv0][cm0]alphamerge,settb=1/30,setpts=N+0[cc0]"));
        assert!(a.contains(
            "[co0][cc1]overlay=x=1500:y=700:format=yuv444:eof_action=pass:enable='between(n,30,59)'[co1];[co1]scale="
        ));
    }

    #[test]
    fn a_clip_fades_to_its_fades_colour() {
        assert_eq!(fade_colour("#FFFFFF").as_deref(), Some("0xffffff"));
        assert_eq!(fade_colour("#000000"), None);
        assert_eq!(fade_colour("white"), None);
        let rate = Rate { num: 30, den: 1 };
        let c = [Cut {
            out: 30,
            fade_in: 6,
            fade_out: 9,
            fade_out_colour: fade_colour("#ffffff"),
            ..Default::default()
        }];
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            1,
            None,
            &[],
            Encoder::X264,
            6_000_000,
        ));
        assert!(a.contains("color=c=black:s=1920x1080:r=30/1,format=yuva444p,trim=end_frame=6,"));
        assert!(
            a.contains("color=c=0xffffff:s=1920x1080:r=30/1,format=yuva444p,trim=end_frame=10,")
        );
    }

    #[test]
    fn markup_shows_on_the_export_frames_of_its_timeline_frames() {
        // Clips at timeline 0-30, 30-50 and 50-100.
        let all = [
            clip(1, 0, 30, 0),
            clip(2, 100, 120, 30),
            clip(3, 500, 550, 50),
        ];
        let show = |from, to, at| Show { from, to, at };
        // The whole timeline: as it is, across cuts in one stretch.
        assert_eq!(shown(&all, 20, 60), [show(20, 60, 0)]);
        // One clip: cut to it, from its own first frame, the item's frames from where it was.
        assert_eq!(shown(&all[1..2], 20, 60), [show(0, 20, 10)]);
        assert_eq!(shown(&all[2..], 20, 60), [show(0, 10, 30)]);
        // Over none of the clips: nowhere.
        assert!(shown(&all[..1], 30, 40).is_empty());
        // Clips not next to each other on the timeline: a stretch over each. Meeting in the
        // export but not in the item (its frames 10 to 29 are cut out), they stay two, so its
        // fades keep its own time.
        assert_eq!(
            shown(&[all[0].clone(), all[2].clone()], 20, 60),
            [show(20, 30, 0), show(30, 40, 30)]
        );
        let apart = [all[2].clone(), all[0].clone()];
        assert_eq!(shown(&apart, 20, 60), [show(0, 10, 30), show(70, 80, 0)]);
    }

    #[test]
    fn markup_is_laid_over_the_frame_between_its_frames() {
        let c = [Cut {
            seek: 0.0,
            from: 0,
            out: 90,
            muted: false,
            ..Default::default()
        }];
        let rate = Rate { num: 30, den: 1 };
        let mark = |x, shows: Vec<(u32, u32)>| Overlay {
            layer: MarkLayer::Item,
            path: PathBuf::from("m.rgba"),
            x,
            y: 4,
            width: 10,
            height: 6,
            shows: shows
                .into_iter()
                .map(|(from, to)| Show { from, to, at: 0 })
                .collect(),
            length: 10,
            fade_in: 0,
            fade_out: 0,
        };
        let marks = [mark(2, vec![(5, 10)]), mark(3, vec![(0, 2), (40, 41)])];
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            0,
            Some("format=yuv444p"),
            &marks,
            Encoder::X264,
            6_000_000,
        ));
        // The clip's the only input: each item's read in the graph.
        assert!(a.contains("-i in.mp4 -filter_complex "));
        assert!(a.contains(
            "-filter_complex movie=filename=m.rgba:f=rawvideo:format_opts=pixel_format=rgba\\\\:video_size=10x6[p0_0];\
             movie=filename=m.rgba:f=rawvideo:format_opts=pixel_format=rgba\\\\:video_size=10x6[p1_0];"
        ));
        assert!(a.contains("[vc]format=yuv444p[vf];"));
        assert!(a.contains("[p0_0]format=yuva444p[m0];"));
        assert!(a.contains("[vf][m0]overlay=x=2:y=4:format=yuv444:enable='between(n,5,9)'[o0];"));
        assert!(a.contains(
            "[o0][m1]overlay=x=3:y=4:format=yuv444:enable='between(n,0,1)+between(n,40,40)'[o1];"
        ));
        assert!(a.contains("[o1]scale=trunc(iw/2)*2"));
        // No frame: straight onto the joined picture.
        let bare = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            0,
            None,
            &marks[..1],
            Encoder::X264,
            6_000_000,
        ));
        assert!(bare.contains("[vc][m0]overlay="));
        let g = joined(&one_file_gif(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            None,
            &marks,
            20,
            640,
        ));
        assert!(g.contains("[o1]fps=20,"));
    }

    #[test]
    fn faded_markup_is_repeated_faded_and_timed_to_its_stretches() {
        let c = [Cut {
            seek: 0.0,
            from: 0,
            out: 90,
            muted: false,
            ..Default::default()
        }];
        let rate = Rate {
            num: 30000,
            den: 1001,
        };
        let faded = Overlay {
            layer: MarkLayer::Item,
            path: PathBuf::from("m.rgba"),
            x: 2,
            y: 4,
            width: 10,
            height: 6,
            shows: vec![
                Show {
                    from: 5,
                    to: 15,
                    at: 0,
                },
                Show {
                    from: 20,
                    to: 25,
                    at: 3,
                },
            ],
            length: 10,
            fade_in: 4,
            fade_out: 2,
        };
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            0,
            None,
            &[faded],
            Encoder::X264,
            6_000_000,
        ));
        assert!(a.contains(
            "[m0]loop=loop=10:size=1:start=0,fade=t=in:s=1:n=4:alpha=1,\
             fade=t=out:s=8:n=2:alpha=1,split=2[f0_0][f0_1];"
        ));
        assert!(
            a.contains("[f0_1]trim=start_frame=4:end_frame=9,settb=1001/30000,setpts=N+20[g0_1];")
        );
        assert!(a.contains(
            "[vc][g0_0]overlay=x=2:y=4:format=yuv444:eof_action=pass:\
             enable='between(n,5,14)'[o0_0];"
        ));
        assert!(a.contains("[o0_1]scale="));
    }

    #[test]
    fn a_highlight_is_multiplied_into_its_region_beneath_the_rest() {
        let rate = Rate { num: 30, den: 1 };
        let c = [Cut {
            out: 90,
            ..Default::default()
        }];
        let item = |highlight: bool, fade_in: u32| Overlay {
            layer: if highlight {
                MarkLayer::Highlight
            } else {
                MarkLayer::Item
            },
            path: PathBuf::from(if highlight { "h.rgb" } else { "m.rgba" }),
            x: 10,
            y: 20,
            width: 30,
            height: 40,
            shows: vec![Show {
                from: 5,
                to: 15,
                at: 0,
            }],
            length: 10,
            fade_in,
            fade_out: 0,
        };
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            0,
            None,
            &[item(true, 0)],
            Encoder::X264,
            6_000_000,
        ));
        assert!(a.contains(
            "movie=filename=h.rgb:f=rawvideo:format_opts=pixel_format=rgb24\\\\:video_size=30x40[p0_0];"
        ));
        assert!(a.contains("[p0_0]format=gbrp[hw0_0]"));
        assert!(a.contains("[vc]split[hb0_0][hc0_0];[hc0_0]crop=30:40:10:20,format=gbrp[hr0_0]"));
        assert!(a.contains("[hr0_0][hw0_0]blend=all_mode=multiply[hm0_0]"));
        assert!(a.contains(
            "[hb0_0][hm0_0]overlay=x=10:y=20:format=yuv444:eof_action=pass:enable='between(n,5,14)'[h0_0]"
        ));
        assert!(a.contains("[h0_0]scale="));
        // Faded: towards white.
        let faded = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            0,
            None,
            &[item(true, 4)],
            Encoder::X264,
            6_000_000,
        ));
        assert!(faded.contains(
            "format=gbrp,loop=loop=10:size=1:start=0,fade=t=in:s=1:n=4:color=white[hf0_0]"
        ));
        // Sent after other markup, a highlight still goes beneath it.
        let mut markup = Markup::default();
        markup.items = vec![
            markup::MarkFile {
                path: "m.rgba".into(),
                mark: ExportMark {
                    id: 1,
                    x: 0,
                    y: 0,
                    width: 2,
                    height: 2,
                    start: 0,
                    end: 10,
                    fade_in: 0,
                    fade_out: 0,
                    layer: MarkLayer::Item,
                },
            },
            markup::MarkFile {
                path: "h.rgb".into(),
                mark: ExportMark {
                    id: 2,
                    x: 0,
                    y: 0,
                    width: 2,
                    height: 2,
                    start: 0,
                    end: 10,
                    fade_in: 0,
                    fade_out: 0,
                    layer: MarkLayer::Highlight,
                },
            },
        ];
        let order: Vec<MarkLayer> = overlays(&[clip(1, 0, 90, 0)], &markup)
            .iter()
            .map(|o| o.layer)
            .collect();
        assert_eq!(order, [MarkLayer::Highlight, MarkLayer::Item]);
    }

    #[test]
    fn redactions_blur_or_pixelate_the_frame_under_the_clip_fades() {
        let rate = Rate { num: 30, den: 1 };
        let c = [Cut {
            out: 90,
            fade_in: 6,
            ..Default::default()
        }];
        let redact = |mode, strength, (x, y, width, height), shows: Vec<Show>| Overlay {
            layer: MarkLayer::Redact { mode, strength },
            path: PathBuf::new(),
            x,
            y,
            width,
            height,
            shows,
            length: 20,
            fade_in: 0,
            fade_out: 0,
        };
        let at = |from, to| Show { from, to, at: 0 };
        let marks = [
            redact(
                RedactMode::Pixelate,
                10,
                (100, 50, 64, 40),
                vec![at(0, 20), at(40, 50)],
            ),
            // At the frame's corner: what it reads round it stops at the frame.
            redact(RedactMode::Blur, 6, (0, 0, 30, 20), vec![at(10, 30)]),
        ];
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            0,
            None,
            &marks,
            Encoder::X264,
            6_000_000,
        ));
        // No pictures sent for them.
        assert!(!a.contains("rawvideo"));
        // Both cut from the one picture.
        assert!(a.contains("[vc]format=yuv444p,split=3[rb][rc0][rc1]"));
        assert!(a.contains(
            "[rc0]crop=64:40:100:50,pixelize=width=10:height=10:mode=avg:enable='between(n,0,19)+between(n,40,49)'[rm0]"
        ));
        assert!(a.contains(
            "[rb][rm0]overlay=x=100:y=50:format=yuv444:enable='between(n,0,19)+between(n,40,49)'[r0]"
        ));
        // Three radii round it, kept to the frame; the box cut back out of that.
        assert!(a.contains(
            "[rc1]crop=48:38:0:0,boxblur=luma_radius=6:luma_power=3:chroma_radius=6:chroma_power=3:enable='between(n,10,29)',crop=30:20:0:0[rm1]"
        ));
        // Then the clip fades, over them.
        assert!(a.contains("[r1][cf0in]overlay="));
        assert_eq!(grown_box((5, 5, 10, 10), 8, (100, 50)), (0, 0, 23, 23));
    }

    #[test]
    fn the_spotlights_darken_the_frame_but_their_holes() {
        let rate = Rate { num: 30, den: 1 };
        let c = [Cut {
            out: 90,
            ..Default::default()
        }];
        let at = |from, to, at| Show { from, to, at };
        let over = |layer, path: &str, (x, y, width, height), shows: Vec<Show>, fade_in| Overlay {
            layer,
            path: PathBuf::from(path),
            x,
            y,
            width,
            height,
            shows,
            length: 20,
            fade_in,
            fade_out: 0,
        };
        let marks = [
            over(
                MarkLayer::Hole,
                "s.rgb",
                (10, 20, 30, 40),
                vec![at(5, 15, 0)],
                3,
            ),
            over(
                MarkLayer::Dark { dim: 60.0 },
                "",
                (0, 0, 64, 48),
                vec![at(0, 10, 0), at(40, 50, 10)],
                4,
            ),
            over(
                MarkLayer::Item,
                "m.rgba",
                (1, 2, 3, 4),
                vec![at(0, 5, 0)],
                0,
            ),
        ];
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            0,
            None,
            &marks,
            Encoder::X264,
            6_000_000,
        ));
        // The hole's picture and the item's are read in the graph; the darkness has none.
        assert!(a.contains(
            "movie=filename=s.rgb:f=rawvideo:format_opts=pixel_format=rgb24\\\\:video_size=30x40[p0_0];\
             movie=filename=m.rgba:f=rawvideo:format_opts=pixel_format=rgba\\\\:video_size=3x4[p2_0];"
        ));
        assert!(!a.contains("[p1_0]"));
        // The holes multiplied into white, as long as the export.
        assert!(a.contains(
            "color=c=white:s=64x48:r=30/1,format=gbrp,trim=end_frame=90,settb=1/30,setpts=N+0[k];"
        ));
        assert!(a.contains("[k]split[hb0_0][hc0_0]"));
        assert!(a.contains(
            "[p0_0]format=gbrp,loop=loop=20:size=1:start=0,fade=t=in:s=1:n=3:color=white[hf0_0]"
        ));
        assert!(a.contains("[h0_0]split=2[ks0][ks1]"));
        // The darkness: black, faded as an item, each stretch timed to the export's.
        assert!(a.contains(
            "color=c=black@0.6000:s=64x48:r=30/1,format=gbrap,trim=end_frame=21,\
             fade=t=in:s=1:n=4:alpha=1,split=2[dv1_0][dv1_1]"
        ));
        assert!(a.contains("[dv1_1]trim=start_frame=11:end_frame=21,settb=1/30,setpts=N+40[dw1_1]"));
        // What's left of it on those frames is its alpha.
        assert!(a.contains("[ks1]trim=start_frame=40:end_frame=50,split[ka1_1][kb1_1]"));
        assert!(a.contains(
            "[kc1_1][kb1_1]alphamerge[kd1_1];[dw1_1][kd1_1]blend=all_mode=multiply[dk1_1]"
        ));
        assert!(a.contains(
            "[vc][dk1_0]overlay=x=0:y=0:format=yuv444:eof_action=pass:enable='between(n,0,9)'[d1_0]"
        ));
        assert!(a.contains(
            "[d1_0][dk1_1]overlay=x=0:y=0:format=yuv444:eof_action=pass:enable='between(n,40,49)'[d1_1]"
        ));
        // The rest over it.
        assert!(a.contains("[p2_0]format=yuva444p[m2];[d1_1][m2]overlay="));

        // A hole with no darkness isn't read (nothing would take it).
        let lone = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            rate,
            0.0,
            0,
            None,
            &marks[..1],
            Encoder::X264,
            6_000_000,
        ));
        assert!(!lone.contains("movie="));
    }

    #[test]
    fn a_ripple_is_one_item_its_frames_shown_on_the_exports() {
        let c = [Cut {
            out: 90,
            ..Default::default()
        }];
        // 20 frames, cut in two: its frames 0 to 4 on export frames 10 to 14, 12 to 19 on 30 to 37.
        let ripple = Overlay {
            layer: MarkLayer::Frames,
            path: PathBuf::from("r.rgba"),
            x: 7,
            y: 8,
            width: 30,
            height: 30,
            shows: vec![
                Show {
                    from: 10,
                    to: 15,
                    at: 0,
                },
                Show {
                    from: 30,
                    to: 38,
                    at: 12,
                },
            ],
            length: 20,
            fade_in: 0,
            fade_out: 0,
        };
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            Rate { num: 30, den: 1 },
            0.0,
            0,
            None,
            &[ripple],
            Encoder::X264,
            6_000_000,
        ));
        // Read once, as it is: no loop, no fades.
        assert!(a.contains("pixel_format=rgba\\\\:video_size=30x30[p0_0];"));
        assert!(a.contains("[p0_0]format=yuva444p[m0];[m0]null,split=2[f0_0][f0_1];"));
        // On the export's frames exactly.
        assert!(!a.contains("loop="));
        assert!(!a.contains("fade="));
        assert!(a.contains("[f0_0]trim=start_frame=0:end_frame=5,settb=1/30,setpts=N+10[g0_0]"));
        assert!(a.contains("[f0_1]trim=start_frame=12:end_frame=20,settb=1/30,setpts=N+30[g0_1]"));
        assert!(a.contains(
            "[vc][g0_0]overlay=x=7:y=8:format=yuv444:eof_action=pass:enable='between(n,10,14)'[o0_0]"
        ));
        assert!(a.contains("[o0_0][g0_1]overlay=x=7:y=8:format=yuv444:eof_action=pass:enable='between(n,30,37)'[o0_1]"));
    }

    #[test]
    fn a_picture_read_in_the_graph_has_its_name_escaped_and_is_split_for_each_read() {
        assert_eq!(
            picture(Path::new(r"C:\Temp\O'Neil [1], a;b\12.rgba"), "rgba", 10, 6),
            r"movie=filename=C\\:\\\\Temp\\\\O\\\'Neil \[1\]\, a\;b\\\\12.rgba:f=rawvideo:format_opts=pixel_format=rgba\\:video_size=10x6"
        );
        assert_eq!(split("p3", 1), "[p3_0]");
        assert_eq!(split("p3", 3), ",split=3[p3_0][p3_1][p3_2]");

        // An unfaded highlight on two stretches reads its picture twice.
        let c = [Cut {
            out: 90,
            ..Default::default()
        }];
        let o = Overlay {
            layer: MarkLayer::Highlight,
            path: PathBuf::from("h.rgb"),
            x: 0,
            y: 0,
            width: 2,
            height: 2,
            shows: vec![
                Show {
                    from: 0,
                    to: 5,
                    at: 0,
                },
                Show {
                    from: 10,
                    to: 15,
                    at: 5,
                },
            ],
            length: 10,
            fade_in: 0,
            fade_out: 0,
        };
        let a = joined(&one_file(
            Path::new("in.mp4"),
            &c,
            Rate { num: 30, den: 1 },
            0.0,
            0,
            None,
            &[o],
            Encoder::X264,
            6_000_000,
        ));
        assert!(a.contains("video_size=2x2,split=2[p0_0][p0_1];"));
        assert!(a.contains("[p0_0]format=gbrp[hw0_0]"));
        assert!(a.contains("[p0_1]format=gbrp[hw0_1]"));
    }

    #[test]
    fn the_graph_is_read_from_a_file_and_the_file_goes_after() {
        let dir = std::env::temp_dir();
        let graph = "[0:v:0]setpts=PTS-STARTPTS[vout]".repeat(2000);
        let a: Vec<OsString> = ["-i", "a.mp4", "-filter_complex", &graph, "-map", "[vout]"]
            .map(OsString::from)
            .to_vec();
        let (b, file) = graph_from_file(a, &dir).unwrap();
        let path = file.0.clone();
        assert_eq!(b[2], "-/filter_complex");
        assert_eq!(b[3], path.as_os_str());
        assert_eq!(b[4..], ["-map", "[vout]"].map(OsString::from));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), graph);
        drop(file);
        assert!(!path.exists());

        let none: Vec<OsString> = ["-i", "a.mp4"].map(OsString::from).to_vec();
        assert!(graph_from_file(none, &dir).is_err());
    }

    /// Development (PLAN §7, Clip speed SP4): retimed clips exported by the real arguments, every
    /// frame's barcode against the preview's mapping (speed.ts) and the beeps against where the
    /// source's whole seconds fall, with the pitch kept and tape-style. Needs the bundled ffmpeg
    /// and `spikes/media` (`node spikes/make-test-media.mjs`):
    /// `cargo test retimed_exports -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn retimed_exports_show_the_previews_frames() {
        use std::process::Command;
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let ff = root.join("binaries/ffmpeg-x86_64-pc-windows-msvc.exe");
        let src = root.join("../spikes/media/obs-1080p60-10m.mp4");
        assert!(
            ff.is_file() && src.is_file(),
            "needs the bundled ffmpeg and spikes/media"
        );
        let out = std::env::temp_dir().join("razorcat-retimed-check.mp4");
        let rate = Rate { num: 60, den: 1 };
        // Source frames 601 to 902 (not on a second or a keyframe), as speed.ts retimes them:
        // the first frame on source frame 601 exactly, the phase making it so.
        let (from, to) = (601u32, 902u32);
        let mut failed = 0;
        for (num, den) in [(1, 2), (3, 2), (2, 1), (3333, 10000), (1, 10), (7, 3)] {
            let first = from * den / num;
            let phase = from * den - first * num;
            let length = (to * den - phase).div_ceil(num) - first;
            let speed = ClipSpeed {
                num,
                den,
                phase,
                first,
                length,
            };
            for keep_pitch in [true, false] {
                let cut = Cut {
                    path: src.clone(),
                    seek: (f64::from(from) / 60.0 - SEEK_EARLY).max(0.0),
                    origin: 0.0,
                    from,
                    out: to,
                    tracks: 1,
                    speed: Some(speed),
                    keep_pitch,
                    ..Cut::default()
                };
                let mut a = vec!["-hide_banner".into(), "-loglevel".into(), "error".into()];
                a.push("-y".into());
                a.extend(args(
                    &[cut],
                    rate,
                    None,
                    (1920, 1080),
                    &[],
                    Encoder::X264,
                    20_000_000,
                ));
                a.push(out.as_os_str().to_owned());
                let r = Command::new(&ff).args(&a).output().unwrap();
                assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));

                // The picture: each frame's barcode, a row through its strip.
                let row = (1080.0 - 1080.0 / 32.0_f64).round() as u32;
                let pic = Command::new(&ff)
                    .args(["-loglevel", "error", "-i"])
                    .arg(&out)
                    .args(["-vf", &format!("format=gray,crop=1920:1:0:{row}"), "-f"])
                    .args(["rawvideo", "-"])
                    .output()
                    .unwrap()
                    .stdout;
                let got: Vec<u32> = pic
                    .chunks_exact(1920)
                    .map(|line| {
                        (0..16).fold(0, |n, k| {
                            let x = (f64::from(k) * 120.0 + 60.0).round() as usize;
                            if line[x] > 128 {
                                n | (1 << k)
                            } else {
                                n
                            }
                        })
                    })
                    .collect();
                let want: Vec<u32> = (0..length)
                    .map(|u| ((first + u) * num + phase) / den)
                    .collect();
                let wrong = got.iter().zip(&want).filter(|(g, w)| g != w).count()
                    + got.len().abs_diff(want.len());

                // The sound: each beep's energy centroid (a 50 ms beep on each whole second of
                // the source) against where that second is in the export.
                let pcm = Command::new(&ff)
                    .args(["-loglevel", "error", "-i"])
                    .arg(&out)
                    .args(["-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"])
                    .output()
                    .unwrap()
                    .stdout;
                let samples: Vec<f64> = pcm
                    .chunks_exact(2)
                    .map(|b| f64::from(i16::from_le_bytes([b[0], b[1]])))
                    .collect();
                let s = f64::from(num) / f64::from(den);
                let x0 = f64::from(from) / 60.0;
                let mut offsets = Vec::new();
                for k in 11..15 {
                    let at = (f64::from(k) - x0) / s;
                    let centre = at + 0.025 / s;
                    let (lo, hi) = (at - 0.4 / s, at + 0.5 / s);
                    let (a, b) = ((lo * 48000.0).max(0.0) as usize, (hi * 48000.0) as usize);
                    if b > samples.len() {
                        continue;
                    }
                    let (w, m) = samples[a..b]
                        .iter()
                        .enumerate()
                        .fold((0.0, 0.0), |(w, m), (i, v)| {
                            (w + v * v, m + v * v * (a + i) as f64)
                        });
                    if w > 0.0 {
                        offsets.push((m / w / 48000.0 - centre) * 1000.0);
                    }
                }
                let worst = offsets.iter().fold(0.0_f64, |m, o| m.max(o.abs()));
                println!(
                    "{:>7.2}% {:<5} frames {}/{} wrong {wrong}; beeps {} worst {worst:.1} ms {offsets:.1?}",
                    100.0 * s,
                    if keep_pitch { "pitch" } else { "tape" },
                    got.len(),
                    want.len(),
                    offsets.len(),
                );
                if wrong > 0 || offsets.is_empty() || worst > 25.0 {
                    failed += 1;
                }
            }
        }
        assert_eq!(failed, 0);
    }
}
