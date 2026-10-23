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
use crate::markup::{self, ExportMark, Markup};
use crate::media::grid::{self, Rate};
use crate::sidecar::{self, Tool};
use crate::source::file_name;
use crate::state::AppState;

/// A clip of the edit, as the page sends it: its number, its source grid frames, and whether
/// it's silent (its own mute, or the track's).
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
}

/// How far before a clip's first frame its input is seeked: the frame is kept whatever the
/// rounding, and a source frame shown for several grid frames (VFR) is there for `fps`.
const SEEK_EARLY: f64 = 0.5;

/// An item of markup as ffmpeg lays it over the frame: its pixels' file (raw RGBA; a highlight's,
/// RGB over white, multiplied in), its size and place, the export's stretches it shows on, and
/// its fades (over its own `length` frames).
#[derive(Debug, Clone, PartialEq)]
struct Overlay {
    highlight: bool,
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
/// none of them are left out. The highlights come first, beneath the rest, as the preview draws
/// them (Vandal's rule, Richard 2026-10-23); otherwise back to front as sent.
fn overlays(clips: &[ExportClip], markup: &Markup) -> Vec<Overlay> {
    let (highlights, rest): (Vec<_>, Vec<_>) =
        markup.items.iter().partition(|item| item.mark.highlight);
    highlights
        .into_iter()
        .chain(rest)
        .filter_map(|item| {
            let m = &item.mark;
            let shows = shown(clips, m.start, m.end);
            (!shows.is_empty()).then(|| Overlay {
                highlight: m.highlight,
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
/// meet in both the export and the item.
fn shown(clips: &[ExportClip], start: u32, end: u32) -> Vec<Show> {
    let mut shows: Vec<Show> = Vec::new();
    let mut at = 0;
    for c in clips {
        let length = c.out - c.from;
        let (a, b) = (start.max(c.start), end.min(c.start + length));
        if a < b {
            let show = Show {
                from: at + a - c.start,
                to: at + b - c.start,
                at: a - start,
            };
            match shows.last_mut() {
                Some(last)
                    if last.to == show.from && last.at + (last.to - last.from) == show.at =>
                {
                    last.to = show.to;
                }
                _ => shows.push(show),
            }
        }
        at += length;
    }
    shows
}

/// Clip `c` of `input`, as ffmpeg seeks it, in the picture of `first` (the timeline's file).
fn cut(input: &Input, first: &Input, c: &ExportClip) -> Cut {
    let fitted = (input.width, input.height) != (first.width, first.height);
    Cut {
        path: input.path.clone(),
        seek: (input.starts[c.from as usize] - SEEK_EARLY).max(0.0),
        origin: input.starts[0],
        from: c.from,
        out: c.out,
        muted: c.muted,
        tracks: input.audio_tracks,
        fit: fitted.then_some((first.width, first.height)),
    }
}

/// Whether there's anything to hear: a clip with sound, not muted.
fn heard(cuts: &[Cut]) -> bool {
    cuts.iter().any(|c| !c.muted && c.tracks > 0)
}

/// The ffmpeg arguments for `cuts`, up to the output file: inputs, the graph, the encoder and
/// the container.
fn args(
    cuts: &[Cut],
    rate: Rate,
    frame: Option<&str>,
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
    let mut a = graph(cuts, rate, audio, frame, overlays, &last);
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
fn gif_args(
    cuts: &[Cut],
    rate: Rate,
    frame: Option<&str>,
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
    let mut a = graph(cuts, rate, false, frame, overlays, &last);
    a.extend(["-f", "yuv4mpegpipe", "-"].map(OsString::from));
    a
}

/// The inputs and the graph for `cuts`, mapped: the joined picture, made into the `frame`
/// (crop and grow), with the `overlays` laid over it, through `last` (a filter chain) as
/// `[vout]`; and the joined sound as `[ac]` if there's `audio`.
fn graph(
    cuts: &[Cut],
    rate: Rate,
    audio: bool,
    frame: Option<&str>,
    overlays: &[Overlay],
    last: &str,
) -> Vec<OsString> {
    let fps = rate.fps();
    let mut a: Vec<OsString> = Vec::new();
    for c in cuts {
        a.extend(["-ss".into(), format!("{:.6}", c.seek).into()]);
        a.extend(["-i".into(), c.path.as_os_str().to_owned()]);
    }
    // Each item's pixels: one picture, raw RGBA (a highlight's, RGB).
    for o in overlays {
        let pixels = if o.highlight { "rgb24" } else { "rgba" };
        a.extend(["-f", "rawvideo", "-pix_fmt", pixels, "-video_size"].map(OsString::from));
        a.push(format!("{}x{}", o.width, o.height).into());
        a.extend(["-i".into(), o.path.as_os_str().to_owned()]);
    }
    let mut f: Vec<String> = Vec::new();
    for (i, c) in cuts.iter().enumerate() {
        // Back on its file's clock from its first shown frame, then onto the grid, then the
        // clip's grid frames (`fps` gives frame k the timestamp k); fitted into the first file's
        // picture if it's another size.
        let fit = c.fit.map_or(String::new(), |(w, h)| {
            format!(
                ",scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
            )
        });
        f.push(format!(
            "[{i}:v:0]setpts=PTS+({:.6})/TB,fps={}/{},trim=start_pts={}:end_pts={},setpts=PTS-STARTPTS{fit}[v{i}]",
            c.seek - c.origin,
            rate.num,
            rate.den,
            c.from,
            c.out
        ));
        if !audio {
            continue;
        }
        let length = f64::from(c.out - c.from) / fps;
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
        // put at 0.
        let start = (c.origin + f64::from(c.from) / fps - c.seek).max(0.0);
        let silence = if c.muted { ",volume=0" } else { "" };
        f.push(format!(
            "{tracks}{mix}atrim=start={start:.6}:duration={length:.6},asetpts=PTS-STARTPTS{silence}[a{i}]"
        ));
    }
    let n = cuts.len();
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
    // The frame, then the markup over it, back to front: in full colour (4:4:4), as the frame is
    // made, so each item lands on the pixels the preview shows it on. Each item is made YUV
    // once, not on every frame (spike 0.3), and is on only between its frames (`n` counts the
    // joined frames from 0).
    let mut at = "vc".to_string();
    if let Some(frame) = frame {
        f.push(format!("[vc]{frame}[vf]"));
        at = "vf".into();
    }
    for (k, o) in overlays.iter().enumerate() {
        let place = format!("x={}:y={}:format=yuv444", o.x, o.y);
        if o.highlight {
            at = highlight(&mut f, &at, n + k, k, o, rate);
            continue;
        }
        f.push(format!("[{}:v:0]format=yuva444p[m{k}]", n + k));
        if o.fade_in == 0 && o.fade_out == 0 {
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
        // Faded: the picture once per frame of the item, faded by frame count (the preview's
        // ramp: the fade-in's first frame clear), then each stretch's frames timed to the
        // export's. A fine time base first, or the frame times round to the input's 1/25 s.
        let mut chain = format!("[m{k}]loop=loop={}:size=1:start=0", o.length - 1);
        if o.fade_in > 0 {
            chain += &format!(",fade=t=in:s=0:n={}:alpha=1", o.fade_in);
        }
        if o.fade_out > 0 {
            chain += &format!(
                ",fade=t=out:s={}:n={}:alpha=1",
                o.length - o.fade_out,
                o.fade_out
            );
        }
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
                "[f{k}_{j}]trim=start_frame={}:end_frame={},settb=AVTB,setpts=(N+{})/({}/{}*TB)[g{k}_{j}]",
                s.at,
                s.at + s.to - s.from,
                s.from,
                rate.num,
                rate.den
            ));
            f.push(format!(
                "[{at}][g{k}_{j}]overlay={place}:eof_action=pass:enable='between(n,{},{})'[o{k}_{j}]",
                s.from,
                s.to - 1
            ));
            at = format!("o{k}_{j}");
        }
    }
    f.push(format!("[{at}]{last}[vout]"));
    a.extend(["-filter_complex".into(), f.join(";").into()]);
    a.extend(["-map", "[vout]"].map(OsString::from));
    if audio {
        a.extend(["-map", "[ac]"].map(OsString::from));
    }
    a
}

/// A highlight (input `input`, item `k`) multiplied into the picture `at` (PLAN 4.5c), as the
/// preview's CSS multiply does: on each stretch it shows on, the frame's region under it cut out,
/// multiplied with it in RGB (white leaves it as it is), and put back. Faded, the highlight fades
/// towards white, frame by frame as a faded item's alpha does. The picture's label after it.
fn highlight(
    f: &mut Vec<String>,
    at: &str,
    input: usize,
    k: usize,
    o: &Overlay,
    rate: Rate,
) -> String {
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
            f.push(format!("[{input}:v:0]format=gbrp[hw{name}]"));
            at = back(f, &at, &format!("hw{name}"), &name, s.from, s.to);
        }
        return at;
    }
    // Faded: the picture once per frame of the item, faded to white by frame count (the preview's
    // ramp), then each stretch's frames timed to the export's.
    let mut chain = format!(
        "[{input}:v:0]format=gbrp,loop=loop={}:size=1:start=0",
        o.length - 1
    );
    if o.fade_in > 0 {
        chain += &format!(",fade=t=in:s=0:n={}:color=white", o.fade_in);
    }
    if o.fade_out > 0 {
        chain += &format!(
            ",fade=t=out:s={}:n={}:color=white",
            o.length - o.fade_out,
            o.fade_out
        );
    }
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
            "[hf{name}]trim=start_frame={}:end_frame={},settb=AVTB,setpts=(N+{})/({}/{}*TB)[hw{name}]",
            s.at,
            s.at + s.to - s.from,
            s.from,
            rate.num,
            rate.den
        ));
        at = back(f, &at, &format!("hw{name}"), &name, s.from, s.to);
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
/// its file, and `output` isn't one of them.
fn prepare(
    app: &AppHandle,
    clips: &[ExportClip],
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
    let mut cuts = Vec::with_capacity(clips.len());
    for c in clips {
        let input = inputs
            .iter()
            .find(|i| i.id == c.source)
            .ok_or("The edit names a video that isn't open.")?;
        if c.from >= c.out || c.out as usize > input.starts.len() {
            return Err("The edit doesn't fit the video.".into());
        }
        cuts.push(cut(input, first, c));
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
        eprintln!(
            "[export] {} in {:.1} s",
            output.display(),
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
    let (input, cuts) = prepare(app, clips, output)?;
    let frames: u64 = clips.iter().map(|c| u64::from(c.out - c.from)).sum();
    let made = frame_filter(frame, input.width, input.height);
    let marks = overlays(clips, markup);
    let (width, height) = output_size(frame, input.width, input.height);
    let rate = bitrate(width, height, input.rate.fps());
    let mut last = String::new();
    for encoder in encoders(app) {
        let a = args(&cuts, input.rate, made.as_deref(), &marks, encoder, rate);
        match ffmpeg::run_now(&a, output, Some(frames), &mut progress, || {
            stop.load(Ordering::Relaxed)
        }) {
            Ok(done) => {
                eprintln!("[export] encoded with {}", encoder.codec());
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

    let (input, cuts) = prepare(app, clips, output)?;
    let (gif_fps, size) = {
        let state = app.state::<AppState>();
        let settings = state.settings.read().unwrap();
        (settings.export.gif_fps, settings.export.gif_size)
    };
    let grid: u64 = clips.iter().map(|c| u64::from(c.out - c.from)).sum();
    let frames = ((grid as f64) * f64::from(gif_fps) / input.rate.fps())
        .ceil()
        .max(1.0);
    let part = output.with_extension("part");

    let mut ffmpeg = sidecar::command(Tool::Ffmpeg)?;
    ffmpeg
        .args(["-hide_banner", "-nostdin", "-loglevel", "error"])
        .args(gif_args(
            &cuts,
            input.rate,
            frame_filter(frame, input.width, input.height).as_deref(),
            &overlays(clips, markup),
            gif_fps,
            size,
        ))
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
            eprintln!("[export] passing frames to gifski: {e}");
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

/// The file name for the whole timeline, or for clip `n`, from Settings › Export's templates:
/// `{name}` the video's name; `{n}` the clip's number, `{nn}` with at least two digits, `{nnn}`
/// three... (as Vandal's).
fn export_name(names: &Names, stem: &str, clip: Option<u32>, format: Format) -> String {
    let named = match clip {
        Some(n) => numbered(&names.clip, n),
        None => names.timeline.clone(),
    };
    format!("{}.{}", named.replace("{name}", stem), format.extension())
}

/// `template` with each `{n}`, `{nn}`, `{nnn}`... as `n`, zero-padded to that many digits.
/// Anything else in braces stays as it is.
fn numbered(template: &str, n: u32) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{n") {
        let digits = rest[start + 1..].bytes().take_while(|&b| b == b'n').count();
        out.push_str(&rest[..start]);
        if rest[start + 1 + digits..].starts_with('}') {
            out.push_str(&format!("{n:0digits$}"));
            rest = &rest[start + digits + 2..];
        } else {
            // "{name}" and the like: plain text here.
            out.push_str(&rest[start..start + 2]);
            rest = &rest[start + 2..];
        }
    }
    out.push_str(rest);
    out
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
    let file = export_name(&names, &stem, clip, format);
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
    let jobs = clips
        .into_iter()
        .map(|c| Job {
            output: free_name(&folder, &export_name(&names, &stem, Some(c.id), format)),
            clips: vec![c],
            frame: frame.clone(),
            markup: markup.clone(),
            format,
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
            overlays,
            gif_fps,
            size,
        )
    }

    #[test]
    fn each_clip_is_seeked_before_its_first_frame() {
        let a = input("a", 1920, 1080, 1);
        let c = [
            cut(&a, &a, &clip(1, 0, 30, 0)),
            cut(&a, &a, &clip(2, 240, 270, 0)),
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
        let a = joined(&args(&c, rate, None, &[], Encoder::X264, 6_000_000));
        assert!(a.starts_with("-ss 0.000000 -i a.mp4 -ss 1.000000 -i b.mp4"));
        assert!(a.contains(
            "[1:v:0]setpts=PTS+(0.800000)/TB,fps=30/1,trim=start_pts=60:end_pts=90,setpts=PTS-STARTPTS,\
             scale=1920:1080:force_original_aspect_ratio=decrease,\
             pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v1]"
        ));
        assert!(a.contains("anullsrc=r=48000:cl=stereo,atrim=duration=1.000000[a1]"));
        assert!(a.contains("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][ac]"));
        // Only the silent file heard: no sound at all.
        let quiet = joined(&args(&c[1..], rate, None, &[], Encoder::X264, 6_000_000));
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
        let names = Names {
            timeline: crate::settings::TIMELINE_NAME.into(),
            clip: crate::settings::CLIP_NAME.into(),
            save_to: None,
        };
        assert_eq!(
            export_name(&names, "trip", None, Format::Mp4),
            "trip-edit.mp4"
        );
        assert_eq!(
            export_name(&names, "trip", Some(3), Format::Mp4),
            "trip-clip03.mp4"
        );
        assert_eq!(
            export_name(&names, "trip", Some(12), Format::Gif),
            "trip-clip12.gif"
        );
        let mine = Names {
            timeline: "final {name}".into(),
            clip: "{n} of {name}".into(),
            save_to: None,
        };
        assert_eq!(
            export_name(&mine, "trip", None, Format::Gif),
            "final trip.gif"
        );
        assert_eq!(
            export_name(&mine, "trip", Some(7), Format::Mp4),
            "7 of trip.mp4"
        );
    }

    #[test]
    fn more_ns_pad_the_number() {
        assert_eq!(numbered("{name}-clip{n}", 7), "{name}-clip7");
        assert_eq!(numbered("clip {nn}", 7), "clip 07");
        assert_eq!(numbered("clip {nnn}", 7), "clip 007");
        assert_eq!(numbered("clip {nnnn}", 12345), "clip 12345");
        assert_eq!(numbered("{n} and {nn}", 3), "3 and 03");
        assert_eq!(numbered("{nope} {n", 3), "{nope} {n");
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
        }
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
            highlight: false,
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
        // After the clip's input, each item's.
        assert!(a.contains(
            "-i in.mp4 -f rawvideo -pix_fmt rgba -video_size 10x6 -i m.rgba -f rawvideo"
        ));
        assert!(a.contains("[vc]format=yuv444p[vf];[1:v:0]format=yuva444p[m0];"));
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
            highlight: false,
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
            "[m0]loop=loop=9:size=1:start=0,fade=t=in:s=0:n=4:alpha=1,\
             fade=t=out:s=8:n=2:alpha=1,split=2[f0_0][f0_1];"
        ));
        assert!(a.contains(
            "[f0_1]trim=start_frame=3:end_frame=8,settb=AVTB,\
             setpts=(N+20)/(30000/1001*TB)[g0_1];"
        ));
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
            highlight,
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
        assert!(a.contains("-f rawvideo -pix_fmt rgb24 -video_size 30x40 -i h.rgb"));
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
            "format=gbrp,loop=loop=9:size=1:start=0,fade=t=in:s=0:n=4:color=white[hf0_0]"
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
                    highlight: false,
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
                    highlight: true,
                },
            },
        ];
        let order: Vec<bool> = overlays(&[clip(1, 0, 90, 0)], &markup)
            .iter()
            .map(|o| o.highlight)
            .collect();
        assert_eq!(order, [true, false]);
    }
}
