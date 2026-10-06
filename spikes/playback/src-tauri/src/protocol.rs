//! `media://` (served as `http://media.localhost/` on Windows).
//!
//! - `GET /file/{id}`: the file's bytes, honouring `Range` (for `<video>` and WebCodecs).
//!   An open-ended range gets at most 8 MB, so a 6 GB file is never read whole.
//! - `GET /frame/{id}/{n}?w=960&hw=0`: display frame n as raw RGBA, from ffmpeg (frames.rs).
//!   `x-width`/`x-height` give its size; `x-ms` the time Rust spent; `x-restarts` the number of
//!   ffmpeg sessions started so far.
//! - `GET /reset`: ends all frame sessions.

use std::io::{Read, Seek, SeekFrom};
use std::time::Instant;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::AppState;

const OPEN_RANGE_MAX: u64 = 8 << 20;
const RANGE_MAX: u64 = 256 << 20;

fn reply(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "x-width, x-height, x-ms, x-restarts, content-range, content-length",
        )
}

fn error(status: StatusCode, msg: impl Into<String>) -> Response<Vec<u8>> {
    reply(status).body(msg.into().into_bytes()).unwrap()
}

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    req: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let resp =
            route(&state, &req).unwrap_or_else(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e));
        responder.respond(resp);
    });
}

fn route(state: &AppState, req: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, String> {
    let path = req.uri().path().to_string();
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let query = req.uri().query().unwrap_or("");
    let q = |k: &str| {
        query
            .split('&')
            .find_map(|kv| kv.strip_prefix(&format!("{k}=")))
            .map(str::to_string)
    };
    match parts.as_slice() {
        ["file", id] => file(state, id.parse().map_err(|_| "bad id")?, req),
        ["frame", id, n] => {
            let id: usize = id.parse().map_err(|_| "bad id")?;
            let n: u64 = n.parse().map_err(|_| "bad frame")?;
            let w: u32 = q("w").and_then(|w| w.parse().ok()).unwrap_or(960);
            let hw = q("hw").as_deref() == Some("1");
            frame(state, id, n, w, hw)
        }
        ["reset"] => {
            state.frames.clear();
            Ok(reply(StatusCode::OK).body(vec![]).unwrap())
        }
        _ => Ok(error(StatusCode::NOT_FOUND, "not found")),
    }
}

fn file(state: &AppState, id: usize, req: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, String> {
    let e = state.entry(id).ok_or("no such media")?;
    let mut f = std::fs::File::open(&e.path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| v.split_once('-'))
        .map(|(a, b)| (a.parse::<u64>().unwrap_or(0), b.parse::<u64>().ok()));
    let (start, end, partial) = match range {
        Some((a, Some(b))) => (a, b.min(len - 1).min(a + RANGE_MAX - 1), true),
        Some((a, None)) => (a, (a + OPEN_RANGE_MAX - 1).min(len - 1), true),
        None => (0, (OPEN_RANGE_MAX - 1).min(len - 1), true),
    };
    if start >= len {
        return Ok(reply(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(vec![])
            .unwrap());
    }
    let mut buf = vec![0u8; (end - start + 1) as usize];
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let mut b = reply(if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    })
    .header(header::CONTENT_TYPE, "video/mp4")
    .header(header::ACCEPT_RANGES, "bytes")
    .header(header::CONTENT_LENGTH, buf.len().to_string());
    if partial {
        b = b.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    Ok(b.body(buf).unwrap())
}

fn frame(
    state: &AppState,
    id: usize,
    n: u64,
    w: u32,
    hw: bool,
) -> Result<Response<Vec<u8>>, String> {
    let started = Instant::now();
    let e = state.entry(id).ok_or("no such media")?;
    let p = state.probe(id)?;
    let src = state.frames.source(id, w, hw, &p);
    let mut src = src.lock().unwrap();
    let f = src
        .get(&e.path, &p, n, hw)
        .map_err(|e| format!("frame {n}: {e}"))?;
    Ok(reply(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header("x-width", src.w.to_string())
        .header("x-height", src.h.to_string())
        .header("x-restarts", src.restarts.to_string())
        .header(
            "x-ms",
            format!("{:.2}", started.elapsed().as_secs_f64() * 1000.0),
        )
        .body(f.as_ref().clone())
        .unwrap())
}
