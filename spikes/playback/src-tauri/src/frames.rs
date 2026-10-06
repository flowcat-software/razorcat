//! The "Rust decodes" approach: frames come from an ffmpeg process that pipes raw RGBA at
//! preview size; the page fetches them one at a time over `media://`.
//!
//! One decoding session per (media, width, hw). A request for frame n:
//! - is served from the cache if it's there;
//! - else, if the session is just behind n, reads forward to it (stepping, playing);
//! - else restarts ffmpeg with an accurate `-ss`: at n going forward, or 59 frames before n
//!   going backward, so the next backward steps hit the cache.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use crate::probe::Probe;

const CACHE_FRAMES: usize = 240;
const READ_AHEAD_LIMIT: u64 = 90;
const BACKWARD_RUN: u64 = 59;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Session {
    child: Child,
    out: ChildStdout,
    next: u64,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct Source {
    pub w: u32,
    pub h: u32,
    session: Option<Session>,
    cache: BTreeMap<u64, Arc<Vec<u8>>>,
    order: VecDeque<u64>,
    last: Option<u64>,
    pub restarts: u64,
}

/// Output size for a preview width, after ffmpeg's autorotate.
fn size_for(p: &Probe, w: u32) -> (u32, u32) {
    let (sw, sh) = if p.rotation.abs() == 90 {
        (p.height, p.width)
    } else {
        (p.width, p.height)
    };
    let h = ((w as f64 * sh as f64 / sw as f64) / 2.0).round() as u32 * 2;
    (w, h)
}

impl Source {
    fn new(p: &Probe, w: u32) -> Self {
        let (w, h) = size_for(p, w);
        Source {
            w,
            h,
            session: None,
            cache: BTreeMap::new(),
            order: VecDeque::new(),
            last: None,
            restarts: 0,
        }
    }

    fn spawn(&mut self, path: &Path, p: &Probe, start: u64, hw: bool) -> std::io::Result<()> {
        self.session = None;
        let fps = p.fps_num as f64 / p.fps_den as f64;
        let mut cmd = Command::new(crate::tool("ffmpeg"));
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
        if hw {
            cmd.args(["-hwaccel", "d3d11va"]);
        }
        if start > 0 {
            cmd.args(["-ss", &format!("{:.6}", (start as f64 - 0.5) / fps)]);
        }
        cmd.arg("-i").arg(path);
        cmd.args([
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-fps_mode",
            "passthrough",
        ]);
        cmd.args([
            "-vf",
            &format!("scale={}:{}:flags=bilinear", self.w, self.h),
        ]);
        cmd.args(["-pix_fmt", "rgba", "-f", "rawvideo", "-"]);
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
        let out = child.stdout.take().unwrap();
        self.session = Some(Session {
            child,
            out,
            next: start,
        });
        self.restarts += 1;
        Ok(())
    }

    fn insert(&mut self, n: u64, f: Arc<Vec<u8>>) {
        if self.cache.insert(n, f).is_none() {
            self.order.push_back(n);
        }
        while self.order.len() > CACHE_FRAMES {
            if let Some(old) = self.order.pop_front() {
                self.cache.remove(&old);
            }
        }
    }

    pub fn get(
        &mut self,
        path: &Path,
        p: &Probe,
        n: u64,
        hw: bool,
    ) -> std::io::Result<Arc<Vec<u8>>> {
        let backward = self.last.is_some_and(|l| n < l);
        self.last = Some(n);
        if let Some(f) = self.cache.get(&n) {
            return Ok(f.clone());
        }
        let reuse = self
            .session
            .as_ref()
            .is_some_and(|s| s.next <= n && n - s.next <= READ_AHEAD_LIMIT);
        if !reuse {
            let start = if backward {
                n.saturating_sub(BACKWARD_RUN)
            } else {
                n
            };
            self.spawn(path, p, start, hw)?;
        }
        let size = (self.w * self.h * 4) as usize;
        loop {
            let s = self.session.as_mut().unwrap();
            let mut buf = vec![0u8; size];
            s.out.read_exact(&mut buf)?;
            let idx = s.next;
            s.next += 1;
            let f = Arc::new(buf);
            self.insert(idx, f.clone());
            if idx == n {
                return Ok(f);
            }
        }
    }
}

type Key = (usize, u32, bool);

#[derive(Default)]
pub struct Frames {
    sources: Mutex<HashMap<Key, Arc<Mutex<Source>>>>,
}

impl Frames {
    pub fn source(&self, id: usize, w: u32, hw: bool, p: &Probe) -> Arc<Mutex<Source>> {
        self.sources
            .lock()
            .unwrap()
            .entry((id, w, hw))
            .or_insert_with(|| Arc::new(Mutex::new(Source::new(p, w))))
            .clone()
    }

    /// Ends all sessions (between runs, so memory readings start clean).
    pub fn clear(&self) {
        self.sources.lock().unwrap().clear();
    }
}
