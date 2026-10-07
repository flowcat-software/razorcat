//! Reads an MP4/MOV file's index from its `moov` box, without reading the media: per video
//! frame its presentation time, size, file offset and whether it's a keyframe; the stream facts
//! (size, rotation, codec, audio tracks). Milliseconds even for multi-GB recordings (ffprobe
//! reads the whole file for packets: 16 s for 5.9 GB). Ported from spike 0.3's
//! `spikes/export/mp4index.mjs`, which matched ffprobe on every packet.
//!
//! Not handled here, so the caller converts the file on open instead (Phase 1.6): other
//! containers (MKV, GIF...) and fragmented MP4 (samples in `moof` boxes, not `moov`).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Why a file's index can't be read here.
#[derive(Debug, PartialEq)]
pub enum Mp4Error {
    /// Not an MP4/MOV file (no `ftyp`/`moov` at the top level).
    NotMp4,
    /// Fragmented MP4: the samples are in `moof` boxes.
    Fragmented,
    /// No video track.
    NoVideo,
    /// Damaged or truncated: what's wrong.
    Malformed(String),
    Io(String),
}

impl std::fmt::Display for Mp4Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Mp4Error::NotMp4 => write!(f, "not an MP4 or MOV file"),
            Mp4Error::Fragmented => write!(f, "a fragmented MP4"),
            Mp4Error::NoVideo => write!(f, "no video track"),
            Mp4Error::Malformed(why) => write!(f, "damaged file ({why})"),
            Mp4Error::Io(e) => write!(f, "{e}"),
        }
    }
}

fn bad(why: &str) -> Mp4Error {
    Mp4Error::Malformed(why.to_string())
}

/// The video track's frames, in decode order (as stored).
#[derive(Debug, Clone, PartialEq)]
pub struct VideoIndex {
    /// The track's timescale (ticks per second).
    pub timescale: u32,
    /// Presentation time of each frame, in `timescale` ticks, with the edit list applied: the
    /// first frame shown is at 0 (or later, after an empty edit). Negative for frames the edit
    /// list hides (decoded but never shown).
    pub pts: Vec<i64>,
    pub size: Vec<u32>,
    pub offset: Vec<u64>,
    pub key: Vec<bool>,
    /// Ticks the last frame lasts (its `stts` duration), for the clip's end.
    pub last_duration: u32,
}

impl VideoIndex {
    pub fn len(&self) -> usize {
        self.pts.len()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Mp4Info {
    /// The video's codec as its sample entry names it: `avc1`, `avc3`, `hvc1`, `hev1`...
    pub codec: String,
    /// Stored picture size, before rotation.
    pub width: u32,
    pub height: u32,
    /// Degrees clockwise to turn the stored picture to show it upright: 0, 90, 180 or 270.
    pub rotation: u32,
    /// Audio tracks (OBS can record several: desktop, microphone...).
    pub audio_tracks: u32,
    /// The edit list has more than one shown segment; only the first is applied.
    pub complex_edits: bool,
    pub video: VideoIndex,
}

/// Reads the index of the MP4/MOV file at `path`.
pub fn read(path: &Path) -> Result<Mp4Info, Mp4Error> {
    let mut file = File::open(path).map_err(|e| Mp4Error::Io(e.to_string()))?;
    let moov = find_moov(&mut file)?;
    parse_moov(&moov)
}

/// Walks the top-level boxes (headers only, so a `moov` at the end costs a few seeks) and
/// returns the `moov` box's body.
fn find_moov(file: &mut File) -> Result<Vec<u8>, Mp4Error> {
    let io = |e: std::io::Error| Mp4Error::Io(e.to_string());
    let size = file.seek(SeekFrom::End(0)).map_err(io)?;
    let mut pos = 0u64;
    let mut first = true;
    while pos + 8 <= size {
        file.seek(SeekFrom::Start(pos)).map_err(io)?;
        let mut h = [0u8; 16];
        let got = file.read(&mut h).map_err(io)?;
        if got < 8 {
            break;
        }
        let kind = &h[4..8];
        let (len, header) = match u32::from_be_bytes(h[0..4].try_into().unwrap()) {
            1 if got >= 16 => (u64::from_be_bytes(h[8..16].try_into().unwrap()), 16),
            0 => (size - pos, 8),
            n => (u64::from(n), 8),
        };
        // An MP4 starts with known boxes; anything else (MKV, GIF) isn't one.
        if first
            && !matches!(
                kind,
                b"ftyp" | b"moov" | b"mdat" | b"free" | b"skip" | b"wide"
            )
        {
            return Err(Mp4Error::NotMp4);
        }
        first = false;
        if len < header {
            return Err(bad("a box shorter than its header"));
        }
        if kind == b"moov" {
            let body = len - header;
            if body > 512 * 1024 * 1024 {
                return Err(bad("an index over 512 MB"));
            }
            let mut moov = vec![0u8; body as usize];
            file.seek(SeekFrom::Start(pos + header)).map_err(io)?;
            file.read_exact(&mut moov).map_err(io)?;
            return Ok(moov);
        }
        pos += len;
    }
    Err(if first {
        Mp4Error::NotMp4
    } else {
        bad("no moov box")
    })
}

/// A box inside a buffer: its type and body range.
#[derive(Clone, Copy)]
struct Bx {
    kind: [u8; 4],
    start: usize,
    end: usize,
}

/// The child boxes of `b[start..end]`.
fn children(b: &[u8], start: usize, end: usize) -> Result<Vec<Bx>, Mp4Error> {
    let mut out = Vec::new();
    let mut p = start;
    while p + 8 <= end {
        let len32 = be32(b, p)?;
        let kind: [u8; 4] = b[p + 4..p + 8].try_into().unwrap();
        let (len, header) = match len32 {
            1 => (
                usize::try_from(be64(b, p + 8)?).map_err(|_| bad("box size"))?,
                16,
            ),
            0 => (end - p, 8),
            n => (n as usize, 8),
        };
        if len < header || p + len > end {
            return Err(bad("a box runs past its parent"));
        }
        out.push(Bx {
            kind,
            start: p + header,
            end: p + len,
        });
        p += len;
    }
    Ok(out)
}

fn child(b: &[u8], parent: Bx, kind: &[u8; 4]) -> Result<Option<Bx>, Mp4Error> {
    Ok(children(b, parent.start, parent.end)?
        .into_iter()
        .find(|c| &c.kind == kind))
}

fn path(b: &[u8], parent: Bx, kinds: &[&[u8; 4]]) -> Result<Option<Bx>, Mp4Error> {
    let mut at = parent;
    for kind in kinds {
        match child(b, at, kind)? {
            Some(c) => at = c,
            None => return Ok(None),
        }
    }
    Ok(Some(at))
}

fn be16(b: &[u8], p: usize) -> Result<u16, Mp4Error> {
    b.get(p..p + 2)
        .map(|s| u16::from_be_bytes(s.try_into().unwrap()))
        .ok_or_else(|| bad("truncated"))
}

fn be32(b: &[u8], p: usize) -> Result<u32, Mp4Error> {
    b.get(p..p + 4)
        .map(|s| u32::from_be_bytes(s.try_into().unwrap()))
        .ok_or_else(|| bad("truncated"))
}

fn be64(b: &[u8], p: usize) -> Result<u64, Mp4Error> {
    b.get(p..p + 8)
        .map(|s| u64::from_be_bytes(s.try_into().unwrap()))
        .ok_or_else(|| bad("truncated"))
}

/// A full box's version byte.
fn version(b: &[u8], bx: Bx) -> Result<u8, Mp4Error> {
    b.get(bx.start).copied().ok_or_else(|| bad("truncated"))
}

/// Parses a `moov` body.
pub fn parse_moov(b: &[u8]) -> Result<Mp4Info, Mp4Error> {
    let moov = Bx {
        kind: *b"moov",
        start: 0,
        end: b.len(),
    };
    let top = children(b, moov.start, moov.end)?;
    let mvhd = top
        .iter()
        .find(|c| &c.kind == b"mvhd")
        .ok_or_else(|| bad("no mvhd"))?;
    let movie_timescale = if version(b, *mvhd)? == 1 {
        be32(b, mvhd.start + 20)?
    } else {
        be32(b, mvhd.start + 12)?
    };
    let fragmented = top.iter().any(|c| &c.kind == b"mvex");

    let mut video = None;
    let mut audio_tracks = 0;
    for trak in top.iter().filter(|c| &c.kind == b"trak") {
        let hdlr = path(b, *trak, &[b"mdia", b"hdlr"])?.ok_or_else(|| bad("no hdlr"))?;
        match b.get(hdlr.start + 8..hdlr.start + 12) {
            Some(b"vide") if video.is_none() => video = Some(*trak),
            Some(b"soun") => audio_tracks += 1,
            _ => {}
        }
    }
    let trak = video.ok_or(Mp4Error::NoVideo)?;

    let mdhd = path(b, trak, &[b"mdia", b"mdhd"])?.ok_or_else(|| bad("no mdhd"))?;
    let timescale = if version(b, mdhd)? == 1 {
        be32(b, mdhd.start + 20)?
    } else {
        be32(b, mdhd.start + 12)?
    };
    if timescale == 0 {
        return Err(bad("a zero timescale"));
    }

    let tkhd = child(b, trak, b"tkhd")?.ok_or_else(|| bad("no tkhd"))?;
    let matrix_at = tkhd.start + if version(b, tkhd)? == 1 { 52 } else { 40 };
    let rotation = rotation(&[
        be32(b, matrix_at)? as i32,
        be32(b, matrix_at + 4)? as i32,
        be32(b, matrix_at + 12)? as i32,
        be32(b, matrix_at + 16)? as i32,
    ]);

    let stbl = path(b, trak, &[b"mdia", b"minf", b"stbl"])?.ok_or_else(|| bad("no stbl"))?;
    let stsd = child(b, stbl, b"stsd")?.ok_or_else(|| bad("no stsd"))?;
    // The first sample entry: size, format, then (a visual entry) width and height at +32.
    let entry = stsd.start + 8;
    let codec = String::from_utf8_lossy(b.get(entry + 4..entry + 8).ok_or_else(|| bad("stsd"))?)
        .into_owned();
    let width = u32::from(be16(b, entry + 32)?);
    let height = u32::from(be16(b, entry + 34)?);

    let table = |kind: &[u8; 4]| child(b, stbl, kind);
    let stsz = table(b"stsz")?.ok_or_else(|| bad("no stsz"))?;
    let fixed = be32(b, stsz.start + 4)?;
    let n = be32(b, stsz.start + 8)? as usize;
    if n == 0 && fragmented {
        return Err(Mp4Error::Fragmented);
    }
    if n == 0 {
        return Err(bad("no video frames"));
    }
    let size = (0..n)
        .map(|i| {
            if fixed != 0 {
                Ok(fixed)
            } else {
                be32(b, stsz.start + 12 + i * 4)
            }
        })
        .collect::<Result<Vec<_>, _>>()?;

    // Decode times (stts) and each frame's duration.
    let stts = table(b"stts")?.ok_or_else(|| bad("no stts"))?;
    let mut dts = Vec::with_capacity(n);
    let mut last_duration = 0;
    let mut t: i64 = 0;
    for k in 0..be32(b, stts.start + 4)? as usize {
        let count = be32(b, stts.start + 8 + k * 8)?;
        let delta = be32(b, stts.start + 12 + k * 8)?;
        for _ in 0..count {
            if dts.len() == n {
                break;
            }
            dts.push(t);
            t += i64::from(delta);
            last_duration = delta;
        }
    }
    if dts.len() != n {
        return Err(bad("stts covers fewer frames than stsz"));
    }

    // Composition offsets (ctts): B-frames are shown later than they're decoded.
    let mut pts = dts;
    if let Some(ctts) = table(b"ctts")? {
        let mut i = 0;
        for k in 0..be32(b, ctts.start + 4)? as usize {
            let count = be32(b, ctts.start + 8 + k * 8)?;
            // Signed in version 1; version 0 is unsigned on paper, but some muxers write
            // negative offsets there too (as ffmpeg reads it).
            let off = i64::from(be32(b, ctts.start + 12 + k * 8)? as i32);
            for _ in 0..count {
                if i == n {
                    break;
                }
                pts[i] += off;
                i += 1;
            }
        }
    }

    // The edit list: where the shown part starts in the media (media_time), after any empty
    // edit (a delay before the first frame, in the movie's timescale).
    let mut complex_edits = false;
    if let Some(elst) = path(b, trak, &[b"edts", b"elst"])? {
        let v1 = version(b, elst)? == 1;
        let entry_len = if v1 { 20 } else { 12 };
        let mut delay: i64 = 0;
        let mut media_time = None;
        for k in 0..be32(b, elst.start + 4)? as usize {
            let e = elst.start + 8 + k * entry_len;
            let (duration, time) = if v1 {
                (be64(b, e)? as i64, be64(b, e + 8)? as i64)
            } else {
                (i64::from(be32(b, e)?), i64::from(be32(b, e + 4)? as i32))
            };
            if time == -1 {
                if media_time.is_none() {
                    delay += duration;
                }
            } else if media_time.is_none() {
                media_time = Some(time);
            } else {
                complex_edits = true;
            }
        }
        let delay = if movie_timescale == 0 {
            0
        } else {
            delay * i64::from(timescale) / i64::from(movie_timescale)
        };
        let shift = delay - media_time.unwrap_or(0);
        for p in &mut pts {
            *p += shift;
        }
    }

    let key = match table(b"stss")? {
        // No sync sample table: every frame is a keyframe.
        None => vec![true; n],
        Some(stss) => {
            let mut key = vec![false; n];
            for k in 0..be32(b, stss.start + 4)? as usize {
                let i = be32(b, stss.start + 8 + k * 4)? as usize;
                if i >= 1 && i <= n {
                    key[i - 1] = true;
                }
            }
            key
        }
    };

    // File offsets: chunk offsets (stco/co64) and frames per chunk (stsc).
    let (co, wide) = match (table(b"stco")?, table(b"co64")?) {
        (Some(c), _) => (c, false),
        (None, Some(c)) => (c, true),
        _ => return Err(bad("no chunk offsets")),
    };
    let chunks = be32(b, co.start + 4)? as usize;
    let chunk = |k: usize| -> Result<u64, Mp4Error> {
        if wide {
            be64(b, co.start + 8 + k * 8)
        } else {
            be32(b, co.start + 8 + k * 4).map(u64::from)
        }
    };
    let stsc = table(b"stsc")?.ok_or_else(|| bad("no stsc"))?;
    let runs = (0..be32(b, stsc.start + 4)? as usize)
        .map(|k| {
            Ok((
                be32(b, stsc.start + 8 + k * 12)?.saturating_sub(1) as usize,
                be32(b, stsc.start + 12 + k * 12)?,
            ))
        })
        .collect::<Result<Vec<_>, Mp4Error>>()?;
    if runs.is_empty() {
        return Err(bad("empty stsc"));
    }
    let mut offset = Vec::with_capacity(n);
    let mut r = 0;
    for k in 0..chunks {
        if offset.len() == n {
            break;
        }
        while r + 1 < runs.len() && runs[r + 1].0 <= k {
            r += 1;
        }
        let mut o = chunk(k)?;
        for _ in 0..runs[r].1 {
            if offset.len() == n {
                break;
            }
            offset.push(o);
            o += u64::from(size[offset.len() - 1]);
        }
    }
    if offset.len() != n {
        return Err(bad("chunks cover fewer frames than stsz"));
    }

    Ok(Mp4Info {
        codec,
        width,
        height,
        rotation,
        audio_tracks,
        complex_edits,
        video: VideoIndex {
            timescale,
            pts,
            size,
            offset,
            key,
            last_duration,
        },
    })
}

/// Degrees clockwise to show the picture upright, from the track matrix's `a, b, c, d` (16.16
/// fixed point). The matrix maps stored to shown: (0, 1, -1, 0) turns it a quarter clockwise.
/// Anything other than the four right angles counts as upright.
fn rotation(m: &[i32; 4]) -> u32 {
    const ONE: i32 = 1 << 16;
    match *m {
        [0, ONE, x, 0] if x == -ONE => 90,
        [x, 0, 0, y] if x == -ONE && y == -ONE => 180,
        [0, x, ONE, 0] if x == -ONE => 270,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A box: length, type, body.
    fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(body);
        v
    }

    /// A full box: version, flags, body.
    fn full(kind: &[u8; 4], version: u8, body: &[u8]) -> Vec<u8> {
        let mut v = vec![version, 0, 0, 0];
        v.extend_from_slice(body);
        bx(kind, &v)
    }

    fn u32s(values: &[u32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_be_bytes()).collect()
    }

    const ONE: u32 = 1 << 16;

    /// A tkhd (version 0) with the given matrix's a, b, c, d.
    fn tkhd(m: [u32; 4]) -> Vec<u8> {
        let mut body = vec![0u8; 36];
        body.extend(u32s(&[m[0], m[1], 0, m[2], m[3], 0, 0, 0, 0x4000_0000]));
        body.extend(u32s(&[1920 << 16, 1080 << 16]));
        full(b"tkhd", 0, &body)
    }

    fn hdlr(kind: &[u8; 4]) -> Vec<u8> {
        let mut body = vec![0u8; 4];
        body.extend_from_slice(kind);
        body.extend([0u8; 13]);
        full(b"hdlr", 0, &body)
    }

    fn mdhd(timescale: u32) -> Vec<u8> {
        full(
            b"mdhd",
            0,
            &[u32s(&[0, 0, timescale, 0]), vec![0u8; 4]].concat(),
        )
    }

    fn stsd(codec: &[u8; 4], w: u16, h: u16) -> Vec<u8> {
        let mut entry = vec![0u8; 24];
        entry.extend(w.to_be_bytes());
        entry.extend(h.to_be_bytes());
        entry.extend([0u8; 50]);
        let entry = bx(codec, &entry);
        full(b"stsd", 0, &[u32s(&[1]), entry].concat())
    }

    struct Tables {
        stts: Vec<(u32, u32)>,
        ctts: Option<(u8, Vec<(u32, u32)>)>,
        stss: Option<Vec<u32>>,
        sizes: Vec<u32>,
        /// Frames per chunk runs: (first chunk, 1-based; frames per chunk).
        stsc: Vec<(u32, u32)>,
        chunks: Vec<u64>,
        wide: bool,
        elst: Option<(u8, Vec<(i64, i64)>)>,
        matrix: [u32; 4],
    }

    impl Default for Tables {
        fn default() -> Self {
            Tables {
                stts: vec![(4, 512)],
                ctts: None,
                stss: Some(vec![1, 3]),
                sizes: vec![100, 20, 30, 40],
                stsc: vec![(1, 2)],
                chunks: vec![1000, 5000],
                wide: false,
                elst: None,
                matrix: [ONE, 0, 0, ONE],
            }
        }
    }

    fn moov(t: &Tables, audio_tracks: usize) -> Vec<u8> {
        let mut stbl = stsd(b"avc1", 1920, 1080);
        let pairs =
            |v: &[(u32, u32)]| u32s(&v.iter().flat_map(|&(a, b)| [a, b]).collect::<Vec<_>>());
        stbl.extend(full(
            b"stts",
            0,
            &[u32s(&[t.stts.len() as u32]), pairs(&t.stts)].concat(),
        ));
        if let Some((v, runs)) = &t.ctts {
            stbl.extend(full(
                b"ctts",
                *v,
                &[u32s(&[runs.len() as u32]), pairs(runs)].concat(),
            ));
        }
        if let Some(keys) = &t.stss {
            stbl.extend(full(
                b"stss",
                0,
                &[u32s(&[keys.len() as u32]), u32s(keys)].concat(),
            ));
        }
        stbl.extend(full(
            b"stsz",
            0,
            &[u32s(&[0, t.sizes.len() as u32]), u32s(&t.sizes)].concat(),
        ));
        let runs: Vec<u32> = t.stsc.iter().flat_map(|&(c, f)| [c, f, 1]).collect();
        stbl.extend(full(
            b"stsc",
            0,
            &[u32s(&[t.stsc.len() as u32]), u32s(&runs)].concat(),
        ));
        if t.wide {
            let offs: Vec<u8> = t.chunks.iter().flat_map(|c| c.to_be_bytes()).collect();
            stbl.extend(full(
                b"co64",
                0,
                &[u32s(&[t.chunks.len() as u32]), offs].concat(),
            ));
        } else {
            let offs: Vec<u32> = t.chunks.iter().map(|&c| c as u32).collect();
            stbl.extend(full(
                b"stco",
                0,
                &[u32s(&[offs.len() as u32]), u32s(&offs)].concat(),
            ));
        }
        let minf = bx(b"minf", &bx(b"stbl", &stbl));
        let mdia = bx(b"mdia", &[mdhd(15360), hdlr(b"vide"), minf].concat());
        let mut trak = tkhd(t.matrix);
        if let Some((v, entries)) = &t.elst {
            let mut body = u32s(&[entries.len() as u32]);
            for &(dur, time) in entries {
                if *v == 1 {
                    body.extend((dur as u64).to_be_bytes());
                    body.extend(time.to_be_bytes());
                } else {
                    body.extend((dur as u32).to_be_bytes());
                    body.extend((time as i32).to_be_bytes());
                }
                body.extend(u32s(&[ONE]));
            }
            trak.extend(bx(b"edts", &full(b"elst", *v, &body)));
        }
        trak.extend(mdia);
        let mut out = full(
            b"mvhd",
            0,
            &[u32s(&[0, 0, 1000, 0]), vec![0u8; 80]].concat(),
        );
        out.extend(bx(b"trak", &trak));
        for _ in 0..audio_tracks {
            let mdia = bx(b"mdia", &[mdhd(48000), hdlr(b"soun")].concat());
            out.extend(bx(b"trak", &[tkhd([ONE, 0, 0, ONE]), mdia].concat()));
        }
        out
    }

    #[test]
    fn reads_a_plain_index() {
        let info = parse_moov(&moov(&Tables::default(), 2)).unwrap();
        assert_eq!(info.codec, "avc1");
        assert_eq!((info.width, info.height, info.rotation), (1920, 1080, 0));
        assert_eq!(info.audio_tracks, 2);
        let v = &info.video;
        assert_eq!(v.timescale, 15360);
        assert_eq!(v.pts, [0, 512, 1024, 1536]);
        assert_eq!(v.offset, [1000, 1100, 5000, 5030]);
        assert_eq!(v.key, [true, false, true, false]);
        assert_eq!(v.last_duration, 512);
    }

    #[test]
    fn b_frames_show_later_than_they_decode() {
        // Decoded I P B B (dts 0, 512, 1024, 1536), shown I B B P: the I frame's composition
        // offset is one frame, which the edit list's media_time takes back off.
        let t = Tables {
            ctts: Some((0, vec![(1, 512), (1, 1536), (2, 0)])),
            elst: Some((0, vec![(4000, 512)])),
            ..Tables::default()
        };
        let v = parse_moov(&moov(&t, 0)).unwrap().video;
        assert_eq!(v.pts, [0, 1536, 512, 1024]);
    }

    #[test]
    fn negative_composition_offsets() {
        // Version 1 ctts (signed): the offsets put the I frame at 0 with no edit list.
        let neg = (-512i32) as u32;
        let t = Tables {
            ctts: Some((1, vec![(1, 0), (1, 1024), (2, neg)])),
            ..Tables::default()
        };
        let v = parse_moov(&moov(&t, 0)).unwrap().video;
        assert_eq!(v.pts, [0, 1536, 512, 1024]);
    }

    #[test]
    fn an_empty_edit_delays_the_first_frame() {
        // 500 ms of nothing (movie timescale 1000), then the media from its start.
        let t = Tables {
            elst: Some((1, vec![(500, -1), (4000, 0)])),
            ..Tables::default()
        };
        let info = parse_moov(&moov(&t, 0)).unwrap();
        assert_eq!(info.video.pts, [7680, 8192, 8704, 9216]);
        assert!(!info.complex_edits);
    }

    #[test]
    fn several_shown_edits_are_flagged() {
        let t = Tables {
            elst: Some((0, vec![(1000, 0), (1000, 1024)])),
            ..Tables::default()
        };
        assert!(parse_moov(&moov(&t, 0)).unwrap().complex_edits);
    }

    #[test]
    fn wide_offsets_and_changing_chunk_runs() {
        // Chunk 1 holds 1 frame, chunk 2 the other 3; offsets past 4 GB (co64).
        let big = 5_000_000_000u64;
        let t = Tables {
            stsc: vec![(1, 1), (2, 3)],
            chunks: vec![big, big + 1000],
            wide: true,
            ..Tables::default()
        };
        let v = parse_moov(&moov(&t, 0)).unwrap().video;
        assert_eq!(v.offset, [big, big + 1000, big + 1020, big + 1050]);
    }

    #[test]
    fn no_sync_table_means_every_frame_is_a_key() {
        let t = Tables {
            stss: None,
            ..Tables::default()
        };
        assert_eq!(parse_moov(&moov(&t, 0)).unwrap().video.key, [true; 4]);
    }

    #[test]
    fn damaged_tables_are_errors_not_panics() {
        let t = Tables {
            stts: vec![(2, 512)],
            ..Tables::default()
        };
        assert!(matches!(
            parse_moov(&moov(&t, 0)),
            Err(Mp4Error::Malformed(_))
        ));
        let mut m = moov(&Tables::default(), 0);
        m.truncate(m.len() - 10);
        assert!(parse_moov(&m).is_err());
        assert!(parse_moov(&[]).is_err());
    }

    #[test]
    fn rotation_from_the_matrix() {
        let neg = (-(ONE as i32)) as u32;
        for (m, deg) in [
            ([ONE, 0, 0, ONE], 0),
            ([0, ONE, neg, 0], 90),
            ([neg, 0, 0, neg], 180),
            ([0, neg, ONE, 0], 270),
        ] {
            let t = Tables {
                matrix: m,
                ..Tables::default()
            };
            assert_eq!(parse_moov(&moov(&t, 0)).unwrap().rotation, deg, "{m:?}");
        }
    }
}
