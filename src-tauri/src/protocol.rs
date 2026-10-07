//! `media://` (the page sees `http://media.localhost/`): the open source's bytes for `<video>`,
//! honouring `Range`. Rust owns the media (PLAN §1): only the open source is served, at a URL
//! that changes with every file opened (`/source/{generation}`), so nothing else on disk can be
//! asked for and a stale `<video>` can't read the new file. Ported from spike 0.2.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

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

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    req: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    // File reads stay off the thread that called us.
    std::thread::spawn(move || {
        let path = req.uri().path().to_string();
        let open = {
            let state = app.state::<AppState>();
            let source = state.source.lock().unwrap();
            source.as_ref().map(|s| (s.generation, s.path.clone()))
        };
        let resp = match (route(&path), open) {
            (Some(asked), Some((generation, file))) if asked == generation => {
                serve(&file, range(&req)).unwrap_or_else(|e| {
                    eprintln!("[protocol] {}: {e}", file.display());
                    reply(StatusCode::INTERNAL_SERVER_ERROR, vec![])
                })
            }
            _ => reply(StatusCode::NOT_FOUND, vec![]),
        };
        responder.respond(resp);
    });
}

/// The generation asked for by `/source/{generation}`.
fn route(path: &str) -> Option<u64> {
    path.strip_prefix("/source/")?.parse().ok()
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
    // Always partial: the page gets the file in pieces, never whole.
    Ok(Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
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
        assert_eq!(route("/source/3"), Some(3));
        assert_eq!(route("/source/x"), None);
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
