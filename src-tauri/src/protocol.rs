//! `media://` (the page sees `http://media.localhost/`): the open source's bytes for `<video>`,
//! honouring `Range`. Rust owns the media (PLAN §1): only the open source is served, at a URL
//! that changes with every file opened (`/source/{generation}`), so nothing else on disk can be
//! asked for and a stale `<video>` can't read the new file. Ported from spike 0.2.
//!
//! `/playable/{generation}` is its converted copy (convert.rs), when it has one;
//! `/proxy/{generation}` is its proxy (proxy.rs), once made. `/frames/{generation}` is the
//! source's frame times (`grid::times`), for the player: two little-endian f64s per grid frame
//! (when its picture starts showing, and the middle of it). `/thumbs/{generation}/{from}` is its
//! thumbnails from `from` on (thumbs.rs), as many as are made. `/wave/{generation}` is its
//! waveform's peaks (wave.rs), once made.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::media::grid;
use crate::state::AppState;

pub const SCHEME: &str = "media";

/// An open-ended range (`bytes=n-`) gets at most this much, so a 6 GB file is never read whole.
const OPEN_RANGE_MAX: u64 = 8 << 20;
/// Any one response is at most this much.
const RANGE_MAX: u64 = 64 << 20;

/// The URL the page uses for the source opened as `generation`.
pub fn source_url(generation: u64) -> String {
    format!("http://{SCHEME}.localhost/source/{generation}")
}

/// Where the page reads the converted copy of the source opened as `generation` (convert.rs).
pub fn playable_url(generation: u64) -> String {
    format!("http://{SCHEME}.localhost/playable/{generation}")
}

/// Where the page reads the proxy of the source opened as `generation`.
pub fn proxy_url(generation: u64) -> String {
    format!("http://{SCHEME}.localhost/proxy/{generation}")
}

/// Where the page reads the frame times of the source opened as `generation`.
pub fn frames_url(generation: u64) -> String {
    format!("http://{SCHEME}.localhost/frames/{generation}")
}

/// Where the page reads the thumbnails of the source opened as `generation` (`/{from}` added).
pub fn thumbs_url(generation: u64) -> String {
    format!("http://{SCHEME}.localhost/thumbs/{generation}")
}

/// Where the page reads the waveform of the source opened as `generation`.
pub fn wave_url(generation: u64) -> String {
    format!("http://{SCHEME}.localhost/wave/{generation}")
}

/// Thumbnails per response: the page asks again for more.
const THUMBS_MAX: u64 = 100;

/// What a request asks for.
#[derive(Debug, PartialEq)]
enum Route {
    Source(u64),
    Playable(u64),
    Proxy(u64),
    Frames(u64),
    /// The generation, and the first thumbnail.
    Thumbs(u64, u64),
    Wave(u64),
}

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    req: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    // File reads stay off the thread that called us.
    std::thread::spawn(move || {
        let path = req.uri().path().to_string();
        let state = app.state::<AppState>();
        let resp = match route(&path) {
            Some(route @ (Route::Source(_) | Route::Playable(_) | Route::Proxy(_))) => {
                let file = {
                    let source = state.source.lock().unwrap();
                    match (source.as_ref(), route) {
                        (Some(s), Route::Source(asked)) if s.generation == asked => {
                            Some(s.path.clone())
                        }
                        (Some(s), Route::Playable(asked)) if s.generation == asked => {
                            s.playable.clone()
                        }
                        (Some(s), Route::Proxy(asked)) if s.generation == asked => s.proxy.clone(),
                        _ => None,
                    }
                };
                match file {
                    Some(file) => serve(&file, range(&req)).unwrap_or_else(|e| {
                        eprintln!("[protocol] {}: {e}", file.display());
                        reply(StatusCode::INTERNAL_SERVER_ERROR, vec![])
                    }),
                    None => reply(StatusCode::NOT_FOUND, vec![]),
                }
            }
            Some(Route::Frames(asked)) => {
                let times = {
                    let source = state.source.lock().unwrap();
                    source
                        .as_ref()
                        .filter(|s| s.generation == asked)
                        .map(|s| grid::times(&s.info.video, &s.grid))
                };
                match times {
                    Some(times) => frames(&times),
                    None => reply(StatusCode::NOT_FOUND, vec![]),
                }
            }
            Some(Route::Thumbs(asked, from)) => {
                let thumbs = {
                    let source = state.source.lock().unwrap();
                    source
                        .as_ref()
                        .filter(|s| s.generation == asked)
                        .and_then(|s| s.thumbs.as_ref())
                        .map(|t| (t.file.clone(), t.size()))
                };
                match thumbs {
                    Some((file, size)) => {
                        match crate::thumbs::read(&file, size, from, THUMBS_MAX) {
                            Ok(bytes) => bytes_for_page(bytes),
                            // Not started writing, or just renamed into place: none yet.
                            Err(_) => bytes_for_page(vec![]),
                        }
                    }
                    None => reply(StatusCode::NOT_FOUND, vec![]),
                }
            }
            Some(Route::Wave(asked)) => {
                let file = {
                    let source = state.source.lock().unwrap();
                    source
                        .as_ref()
                        .filter(|s| s.generation == asked)
                        .and_then(|s| s.wave.as_ref())
                        .filter(|w| w.ready)
                        .map(|w| w.file.clone())
                };
                match file.map(std::fs::read) {
                    Some(Ok(bytes)) => bytes_for_page(bytes),
                    _ => reply(StatusCode::NOT_FOUND, vec![]),
                }
            }
            None => reply(StatusCode::NOT_FOUND, vec![]),
        };
        responder.respond(resp);
    });
}

/// `/source/`, `/playable/`, `/proxy/` or `/frames/`, then the generation; or `/thumbs/`, the
/// generation and the first thumbnail.
fn route(path: &str) -> Option<Route> {
    let (kind, rest) = path.strip_prefix('/')?.split_once('/')?;
    if kind == "thumbs" {
        let (generation, from) = rest.split_once('/')?;
        return Some(Route::Thumbs(generation.parse().ok()?, from.parse().ok()?));
    }
    let generation = rest.parse().ok()?;
    match kind {
        "source" => Some(Route::Source(generation)),
        "playable" => Some(Route::Playable(generation)),
        "proxy" => Some(Route::Proxy(generation)),
        "frames" => Some(Route::Frames(generation)),
        "wave" => Some(Route::Wave(generation)),
        _ => None,
    }
}

/// The frame times as bytes.
fn frames(times: &[(f64, f64)]) -> Response<Vec<u8>> {
    let body: Vec<u8> = times
        .iter()
        .flat_map(|&(a, b)| [a.to_le_bytes(), b.to_le_bytes()])
        .flatten()
        .collect();
    bytes_for_page(body)
}

/// Bytes the page fetches (the video doesn't), so they need CORS.
fn bytes_for_page(body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap()
}

/// The `Range` header's `bytes=start-[end]`.
fn range(req: &Request<Vec<u8>>) -> Option<(u64, Option<u64>)> {
    let (a, b) = req
        .headers()
        .get(header::RANGE)?
        .to_str()
        .ok()?
        .strip_prefix("bytes=")?
        .split_once('-')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()))
}

/// The bytes to send for a range of a file `len` long: (start, end inclusive), or `None` if
/// it starts past the end. No range: the start of the file, as an open-ended range.
fn span(len: u64, range: Option<(u64, Option<u64>)>) -> Option<(u64, u64)> {
    let (start, end) = match range {
        Some((a, Some(b))) => (a, b.min(a.saturating_add(RANGE_MAX - 1))),
        Some((a, None)) => (a, a.saturating_add(OPEN_RANGE_MAX - 1)),
        None => (0, OPEN_RANGE_MAX - 1),
    };
    (start < len && start <= end).then(|| (start, end.min(len - 1)))
}

fn serve(path: &PathBuf, range: Option<(u64, Option<u64>)>) -> std::io::Result<Response<Vec<u8>>> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let Some((start, end)) = span(len, range) else {
        return Ok(Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(vec![])
            .unwrap());
    };
    let mut buf = vec![0u8; (end - start + 1) as usize];
    f.seek(SeekFrom::Start(start))?;
    f.read_exact(&mut buf)?;
    // Always partial: the page gets the file in pieces, never whole. CORS lets the page read the
    // video's pixels (the frame check draws them to a canvas); only Razorcat's pages can reach
    // this scheme at all.
    Ok(Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CONTENT_TYPE, "video/mp4")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, buf.len().to_string())
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
        .body(buf)
        .unwrap())
}

fn reply(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder().status(status).body(body).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes() {
        assert_eq!(route("/source/3"), Some(Route::Source(3)));
        assert_eq!(route("/frames/12"), Some(Route::Frames(12)));
        assert_eq!(route("/proxy/4"), Some(Route::Proxy(4)));
        assert_eq!(route("/playable/5"), Some(Route::Playable(5)));
        assert_eq!(route("/thumbs/6/120"), Some(Route::Thumbs(6, 120)));
        assert_eq!(route("/wave/7"), Some(Route::Wave(7)));
        assert_eq!(route("/thumbs/6"), None);
        assert_eq!(route("/thumbs/6/x"), None);
        assert_eq!(route("/source/x"), None);
        assert_eq!(route("/frames/"), None);
        assert_eq!(route("/C:/Windows/win.ini"), None);
        assert_eq!(route("/source/3/../../x"), None);
    }

    #[test]
    fn spans() {
        let mb = 1 << 20;
        // A closed range, clamped to the file.
        assert_eq!(span(1000, Some((0, Some(99)))), Some((0, 99)));
        assert_eq!(span(1000, Some((900, Some(5000)))), Some((900, 999)));
        // Open-ended and no range: at most 8 MB.
        assert_eq!(
            span(100 * mb, Some((10, None))),
            Some((10, 10 + 8 * mb - 1))
        );
        assert_eq!(span(100 * mb, None), Some((0, 8 * mb - 1)));
        assert_eq!(span(1000, None), Some((0, 999)));
        // A huge closed range: at most 64 MB.
        assert_eq!(
            span(1 << 40, Some((0, Some(1 << 39)))),
            Some((0, 64 * mb - 1))
        );
        // Past the end, or backwards: not satisfiable.
        assert_eq!(span(1000, Some((1000, None))), None);
        assert_eq!(span(1000, Some((50, Some(10)))), None);
        assert_eq!(span(0, None), None);
    }
}
