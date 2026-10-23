//! Markup for the export (PLAN 4.3a). The page draws each item on its own (drawMarks.ts) and
//! POSTs its straight-alpha RGBA to `/markup/{id}` (protocol.rs), never over JSON; then the
//! export command names the items, back to front: where each goes on the frame and on which
//! timeline frames it shows. They're kept as raw RGBA files, which ffmpeg reads as `rawvideo`
//! (no image encoder needed), in a folder of the export's own, removed when it's done. A
//! highlight (PLAN 4.5c) is kept as RGB, laid over white: what the frame under it is multiplied
//! by.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};

use crate::state::AppState;

/// An item of markup, as the page names it for an export.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportMark {
    pub id: u32,
    /// What it covers of the output frame, in its pixels.
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// The timeline frames it shows on, `start` to `end` (exclusive).
    pub start: u32,
    pub end: u32,
    /// How many of its frames it fades in over, and out over (fitted to its length).
    pub fade_in: u32,
    pub fade_out: u32,
    /// A highlighter's: multiplied into the frame, beneath the other markup (PLAN 4.5c).
    pub highlight: bool,
}

/// An item ready for ffmpeg: its pixels' file, and where and when it goes.
#[derive(Debug)]
pub struct MarkFile {
    pub path: PathBuf,
    pub mark: ExportMark,
}

/// An export's markup, back to front; its folder goes when it does.
#[derive(Debug, Default)]
pub struct Markup {
    dir: Option<PathBuf>,
    pub items: Vec<MarkFile>,
}

impl Drop for Markup {
    fn drop(&mut self) {
        if let Some(dir) = &self.dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// The pixels the page sent for item `id`, until the export takes them.
pub fn upload<R: Runtime>(app: &AppHandle<R>, id: u32, rgba: Vec<u8>) {
    let state = app.state::<AppState>();
    state.markup.lock().unwrap().insert(id, rgba);
}

/// The items `marks`, with the pixels sent for them, written out for an export. What was sent
/// for other items (an export that didn't start) is dropped.
pub fn take(app: &AppHandle, marks: Vec<ExportMark>) -> Result<Markup, String> {
    let sent = {
        let state = app.state::<AppState>();
        let mut markup = state.markup.lock().unwrap();
        std::mem::take(&mut *markup)
    };
    if marks.is_empty() {
        return Ok(Markup::default());
    }
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "razorcat-markup-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut markup = Markup {
        dir: Some(dir.clone()),
        items: Vec::new(),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("The markup couldn't be kept ({e})."))?;
    let pixels = pair(marks, sent)?;
    for (mark, rgba) in pixels {
        let (path, bytes) = if mark.highlight {
            (dir.join(format!("{}.rgb", mark.id)), over_white(&rgba))
        } else {
            (dir.join(format!("{}.rgba", mark.id)), rgba)
        };
        std::fs::write(&path, bytes).map_err(|e| format!("The markup couldn't be kept ({e})."))?;
        markup.items.push(MarkFile { path, mark });
    }
    eprintln!("[export] {} markup items", markup.items.len());
    Ok(markup)
}

/// Straight-alpha RGBA laid over white, as RGB: a highlight's pixels as the frame is multiplied
/// by them (transparent is white, which leaves the frame as it is).
fn over_white(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|p| {
            let a = u32::from(p[3]);
            let over = |c: u8| (255 - ((255 - u32::from(c)) * a + 127) / 255) as u8;
            [over(p[0]), over(p[1]), over(p[2])]
        })
        .collect()
}

/// Each of `marks` with the pixels `sent` for it, checked: all there, of its size.
fn pair(
    marks: Vec<ExportMark>,
    mut sent: HashMap<u32, Vec<u8>>,
) -> Result<Vec<(ExportMark, Vec<u8>)>, String> {
    marks
        .into_iter()
        .map(|m| {
            let rgba = sent
                .remove(&m.id)
                .ok_or("The markup wasn't all sent: try again.")?;
            let size = u64::from(m.width) * u64::from(m.height) * 4;
            if size == 0 || rgba.len() as u64 != size || m.start >= m.end {
                return Err("The markup sent doesn't fit: try again.".to_string());
            }
            Ok((m, rgba))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mark(id: u32, width: u32, height: u32) -> ExportMark {
        ExportMark {
            id,
            x: 0,
            y: 0,
            width,
            height,
            start: 0,
            end: 10,
            fade_in: 0,
            fade_out: 0,
            highlight: false,
        }
    }

    #[test]
    fn a_highlight_is_laid_over_white() {
        // Opaque yellow; half-clear red; clear anything.
        let rgba = [255, 255, 0, 255, 255, 0, 0, 128, 10, 20, 30, 0];
        assert_eq!(
            over_white(&rgba),
            [255, 255, 0, 255, 127, 127, 255, 255, 255]
        );
    }

    #[test]
    fn pairs_each_item_with_its_pixels() {
        let sent = HashMap::from([(1, vec![0; 2 * 3 * 4]), (2, vec![0; 4]), (9, vec![0; 8])]);
        let paired = pair(vec![mark(2, 1, 1), mark(1, 2, 3)], sent).unwrap();
        assert_eq!(
            paired
                .iter()
                .map(|(m, p)| (m.id, p.len()))
                .collect::<Vec<_>>(),
            [(2, 4), (1, 24)]
        );
    }

    #[test]
    fn refuses_missing_or_misfit_pixels() {
        assert!(pair(vec![mark(1, 1, 1)], HashMap::new()).is_err());
        assert!(pair(vec![mark(1, 2, 2)], HashMap::from([(1, vec![0; 4])])).is_err());
        assert!(pair(vec![mark(1, 0, 0)], HashMap::from([(1, vec![])])).is_err());
        let mut backwards = mark(1, 1, 1);
        backwards.start = 10;
        assert!(pair(vec![backwards], HashMap::from([(1, vec![0; 4])])).is_err());
    }
}
