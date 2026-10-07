//! The open source file: its index and frame grid, read once on open, and what the page shows
//! about it. The MVP edits one source; opening another replaces it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use specta::Type;

use crate::media::grid::{self, Grid};
use crate::media::mp4::{self, Mp4Error, Mp4Info};

/// An opened source: what Rust keeps (the index, for the protocol, proxies and export later).
pub struct Source {
    /// Counts the files opened this run: the source's URL (`protocol::source_url`) changes with
    /// each, so the page never reads a stale one.
    pub generation: u64,
    pub path: PathBuf,
    pub info: Mp4Info,
    pub grid: Grid,
}

/// What the page shows about the open source.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub path: String,
    /// Where the page reads the file (`media://`, see protocol.rs).
    pub url: String,
    /// The file name, for the title and messages.
    pub name: String,
    pub bytes: f64,
    /// "H.264", "HEVC", or the codec's code if unfamiliar.
    pub codec: String,
    /// The picture as shown: rotation applied.
    pub width: u32,
    pub height: u32,
    /// Degrees clockwise the stored picture is turned to show it.
    pub rotation: u32,
    /// The timeline rate, frames per second as `rate_num / rate_den`.
    pub rate_num: u32,
    pub rate_den: u32,
    /// Timeline frames.
    pub frames: u32,
    /// Seconds: timeline frames at the timeline rate.
    pub duration: f64,
    pub audio_tracks: u32,
    /// The source's frame timing varies (a phone clip, a recorder dropping frames).
    pub variable: bool,
}

impl Source {
    pub fn info(&self) -> SourceInfo {
        let (w, h) = (self.info.width, self.info.height);
        let (width, height) = if self.info.rotation % 180 == 90 {
            (h, w)
        } else {
            (w, h)
        };
        let rate = self.grid.rate;
        SourceInfo {
            path: self.path.display().to_string(),
            url: crate::protocol::source_url(self.generation),
            name: file_name(&self.path),
            bytes: std::fs::metadata(&self.path).map_or(0.0, |m| m.len() as f64),
            codec: codec_name(&self.info.codec),
            width,
            height,
            rotation: self.info.rotation,
            rate_num: rate.num,
            rate_den: rate.den,
            frames: self.grid.frames,
            duration: f64::from(self.grid.frames) / rate.fps(),
            audio_tracks: self.info.audio_tracks,
            variable: self.grid.variable,
        }
    }
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

fn codec_name(code: &str) -> String {
    match code {
        "avc1" | "avc3" => "H.264",
        "hvc1" | "hev1" => "HEVC",
        "av01" => "AV1",
        "vp09" => "VP9",
        "mp4v" => "MPEG-4",
        "apcn" | "apch" | "apcs" | "apco" | "ap4h" => "ProRes",
        other => other,
    }
    .to_string()
}

/// Reads `path`'s index and builds its grid. The error is a sentence for the user.
pub fn open(path: &Path) -> Result<Source, String> {
    if !path.is_file() {
        return Err(format!("{} isn't there any more.", file_name(path)));
    }
    let info = mp4::read(path).map_err(|e| match e {
        // Converting these on open comes in Phase 1.6.
        Mp4Error::NotMp4 | Mp4Error::Fragmented => format!(
            "{} isn't an MP4 or MOV file. Opening MKV, GIF and other formats comes soon.",
            file_name(path)
        ),
        Mp4Error::NoVideo => format!("{} has no video.", file_name(path)),
        Mp4Error::Malformed(why) => {
            format!(
                "{} looks damaged and can't be opened ({why}).",
                file_name(path)
            )
        }
        Mp4Error::Io(why) => format!("{} can't be read ({why}).", file_name(path)),
    })?;
    let grid = grid::build(&info.video)
        .ok_or_else(|| format!("{} has no frames to show.", file_name(path)))?;
    static OPENED: AtomicU64 = AtomicU64::new(0);
    Ok(Source {
        generation: OPENED.fetch_add(1, Ordering::Relaxed) + 1,
        path: path.to_path_buf(),
        info,
        grid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_names() {
        assert_eq!(codec_name("avc1"), "H.264");
        assert_eq!(codec_name("hev1"), "HEVC");
        assert_eq!(codec_name("xyz1"), "xyz1");
    }

    #[test]
    fn a_missing_file_says_so() {
        let e = open(Path::new(r"C:\nowhere\clip.mp4")).err().unwrap();
        assert_eq!(e, "clip.mp4 isn't there any more.");
    }
}
