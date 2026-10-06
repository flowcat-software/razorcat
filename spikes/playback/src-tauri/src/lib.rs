//! Spike 0.2: how do frames reach the screen? A throwaway harness (internal/spikes/0.2-playback.md).
//!
//! Rust side: serves media files over `media://` with byte ranges (for `<video>` and WebCodecs),
//! decodes frames by piping raw RGBA from an ffmpeg process (the "Rust decodes" approach),
//! probes files, makes proxies, and measures memory. The page runs the measurements.

mod frames;
mod mem;
mod probe;
mod protocol;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

/// `spikes/`, where the tools, media and caches live.
pub fn spikes_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("spikes dir")
        .to_path_buf()
}

pub fn tool(name: &str) -> PathBuf {
    spikes_dir()
        .join(".tools/ffmpeg/bin")
        .join(format!("{name}.exe"))
}

pub fn cache_dir() -> PathBuf {
    let d = spikes_dir().join(".cache");
    let _ = std::fs::create_dir_all(&d);
    d
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
    #[serde(default)]
    pub id: usize,
    pub label: String,
    pub path: PathBuf,
    /// The picture carries make-test-media's frame barcode, matching display frame numbers.
    #[serde(default)]
    pub barcode: bool,
}

#[derive(Default)]
pub struct AppState {
    pub media: Mutex<Vec<MediaEntry>>,
    pub probes: Mutex<Vec<Option<Arc<probe::Probe>>>>,
    pub frames: frames::Frames,
}

impl AppState {
    pub fn entry(&self, id: usize) -> Option<MediaEntry> {
        self.media.lock().unwrap().get(id).cloned()
    }

    fn add(&self, mut e: MediaEntry) -> usize {
        let mut m = self.media.lock().unwrap();
        e.id = m.len();
        m.push(e);
        self.probes.lock().unwrap().push(None);
        m.len() - 1
    }

    pub fn probe(&self, id: usize) -> Result<Arc<probe::Probe>, String> {
        if let Some(Some(p)) = self.probes.lock().unwrap().get(id) {
            return Ok(p.clone());
        }
        let e = self.entry(id).ok_or("no such media")?;
        let p = Arc::new(probe::probe(&e.path)?);
        self.probes.lock().unwrap()[id] = Some(p.clone());
        Ok(p)
    }
}

fn load_media_list(file: &Path, base: &Path) -> Vec<MediaEntry> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return vec![];
    };
    let list: Vec<MediaEntry> = serde_json::from_str(&text).expect("media list");
    list.into_iter()
        .map(|mut e| {
            if e.path.is_relative() {
                e.path = base.join(&e.path);
            }
            e
        })
        .filter(|e| e.path.exists())
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    auto: bool,
    only: Option<String>,
    approaches: Option<String>,
    media: Vec<MediaEntry>,
}

#[tauri::command]
fn config(state: State<AppState>) -> Config {
    Config {
        auto: std::env::var("SPIKE_AUTO").is_ok(),
        only: std::env::var("SPIKE_ONLY").ok(),
        approaches: std::env::var("SPIKE_APPROACHES").ok(),
        media: state.media.lock().unwrap().clone(),
    }
}

#[tauri::command]
async fn probe_media(state: State<'_, AppState>, id: usize) -> Result<Arc<probe::Probe>, String> {
    state.probe(id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Proxy {
    id: usize,
    ms: f64,
    bytes: u64,
    cached: bool,
}

/// Makes (or reuses) a scrubbing proxy of a source: low-res, short GOP or all-intra.
#[tauri::command]
async fn make_proxy(state: State<'_, AppState>, id: usize, kind: String) -> Result<Proxy, String> {
    let e = state.entry(id).ok_or("no such media")?;
    let stem = e.path.file_stem().unwrap().to_string_lossy().to_string();
    let out = cache_dir().join(format!("{stem}.proxy-{kind}.mp4"));
    let started = Instant::now();
    let cached = out.exists();
    if !cached {
        let gop = match kind.as_str() {
            "gop10" => ["-g", "10", "-crf", "26"],
            "intra" => ["-g", "1", "-crf", "30"],
            _ => return Err(format!("unknown proxy kind {kind}")),
        };
        let tmp = out.with_extension("tmp.mp4");
        let status = std::process::Command::new(tool("ffmpeg"))
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&e.path)
            .args(["-map", "0:v:0", "-an", "-vf", "scale=-2:540:flags=bilinear"])
            .args([
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-tune",
                "fastdecode",
                "-bf",
                "0",
            ])
            .args(gop)
            .args(["-pix_fmt", "yuv420p", "-movflags", "+faststart"])
            .arg(&tmp)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("ffmpeg proxy failed: {status}"));
        }
        std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    }
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    let bytes = std::fs::metadata(&out).map_err(|e| e.to_string())?.len();
    let id = state.add(MediaEntry {
        id: 0,
        label: format!("{} [proxy {kind}]", e.label),
        path: out,
        barcode: e.barcode,
    });
    Ok(Proxy {
        id,
        ms,
        bytes,
        cached,
    })
}

#[tauri::command]
fn memory() -> mem::Memory {
    mem::measure()
}

#[tauri::command]
fn save_results(json: String) -> Result<String, String> {
    let dir = spikes_dir().join("playback/results");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let path = dir.join(format!("run-{secs}.json"));
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn log_line(line: String) {
    use std::io::Write;
    let dir = spikes_dir().join("playback/results");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("live.log"))
    {
        let _ = writeln!(f, "{line}");
    }
}

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

pub fn run() {
    let base = spikes_dir().join("playback");
    let mut list = load_media_list(&base.join("media.json"), &base);
    list.extend(load_media_list(&base.join("media.local.json"), &base));

    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("media", protocol::handle)
        .setup(move |app| {
            let state = AppState::default();
            for e in list {
                state.add(e);
            }
            app.manage(state);
            println!("spike ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config,
            probe_media,
            make_proxy,
            memory,
            save_results,
            log_line,
            quit
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
