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
    /// Its proxy, once made or found in the cache (proxy.rs).
    pub proxy: Option<PathBuf>,
    /// The copy the preview plays, when the original can't be (convert.rs). Export still
    /// reads `path`.
    pub playable: Option<PathBuf>,
}

/// What the page shows about the open source.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub path: String,
    /// Where the page reads the file (`media://`, see protocol.rs).
    pub url: String,
    /// Where the player reads the frame times (see protocol.rs).
    pub frames_url: String,
    /// Where the player reads the proxy, if it's ready (else `ProxyReady` says when it is).
    pub proxy_url: Option<String>,
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
    /// The preview plays a converted copy (convert.rs); export reads the original.
    pub converted: bool,
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
            url: if self.playable.is_some() {
                crate::protocol::playable_url(self.generation)
            } else {
                crate::protocol::source_url(self.generation)
            },
            frames_url: crate::protocol::frames_url(self.generation),
            proxy_url: self
                .proxy
                .as_ref()
                .map(|_| crate::protocol::proxy_url(self.generation)),
            name: file_name(&self.path),
            bytes: std::fs::metadata(&self.path).map_or(0.0, |m| m.len() as f64),
            // A GIF is indexed from its H.264 copy; it's still a GIF.
            codec: if self.playable.is_some() && has_extension(&self.path, "gif") {
                "GIF".into()
            } else {
                codec_name(&self.info.codec)
            },
            width,
            height,
            rotation: self.info.rotation,
            rate_num: rate.num,
            rate_den: rate.den,
            frames: self.grid.frames,
            duration: f64::from(self.grid.frames) / rate.fps(),
            audio_tracks: self.info.audio_tracks,
            variable: self.grid.variable,
            converted: self.playable.is_some(),
        }
    }
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

fn has_extension(path: &Path, ext: &str) -> bool {
    path.extension().is_some_and(|x| x.eq_ignore_ascii_case(ext))
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

/// Why a file didn't open.
#[derive(Debug, PartialEq)]
pub enum OpenError {
    /// The MP4 index can't be read from it (MKV, GIF, fragmented MP4...): a converted copy
    /// can be (convert.rs).
    NeedsConversion,
    /// A sentence for the user.
    Failed(String),
}

/// Reads the index and builds the grid of `path`, or of `playable`, its converted copy.
pub fn open(path: &Path, playable: Option<PathBuf>) -> Result<Source, OpenError> {
    let name = file_name(path);
    if !path.is_file() {
        return Err(OpenError::Failed(format!("{name} isn't there any more.")));
    }
    let indexed = playable.as_deref().unwrap_or(path);
    let info = mp4::read(indexed).map_err(|e| match e {
        Mp4Error::NotMp4 | Mp4Error::Fragmented if playable.is_none() => OpenError::NeedsConversion,
        Mp4Error::NotMp4 | Mp4Error::Fragmented => OpenError::Failed(format!(
            "{name} couldn't be converted into a form Driveby reads."
        )),
        Mp4Error::NoVideo => OpenError::Failed(format!("{name} has no video.")),
        Mp4Error::Malformed(why) => {
            OpenError::Failed(format!("{name} looks damaged and can't be opened ({why})."))
        }
        Mp4Error::Io(why) => OpenError::Failed(format!("{name} can't be read ({why}).")),
    })?;
    let grid = grid::build(&info.video)
        .ok_or_else(|| OpenError::Failed(format!("{name} has no frames to show.")))?;
    static OPENED: AtomicU64 = AtomicU64::new(0);
    Ok(Source {
        generation: OPENED.fetch_add(1, Ordering::Relaxed) + 1,
        path: path.to_path_buf(),
        info,
        grid,
        proxy: None,
        playable,
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
        let e = open(Path::new(r"C:\nowhere\clip.mp4"), None).err().unwrap();
        assert_eq!(
            e,
            OpenError::Failed("clip.mp4 isn't there any more.".into())
        );
    }
}
