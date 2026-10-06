//! Probing a source with ffprobe: stream facts, the decoder config (extradata) and the video
//! packet index, which WebCodecs needs instead of a JS demuxer.
//!
//! Listing packets makes ffprobe read the whole file (15 s for a 5.9 GB OBS recording), so the
//! index is cached in `spikes/.cache`. The real app would read the MP4 `moov` index itself.

use std::path::Path;
use std::process::Command;
use std::time::Instant;

use serde::{Deserialize, Serialize};

/// One video packet in decode (file) order: pts, dts, byte position, size, keyframe.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Packet(pub i64, pub i64, pub u64, pub u32, pub bool);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub rotation: i32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub tb_num: u32,
    pub tb_den: u32,
    pub duration: f64,
    pub audio_tracks: u32,
    pub extradata: Vec<u8>,
    pub packets: Vec<Packet>,
    pub probe_ms: f64,
    pub index_cached: bool,
}

fn ratio(s: &str) -> (u32, u32) {
    let mut it = s.split('/');
    let a = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let b = it.next().and_then(|x| x.parse().ok()).unwrap_or(1);
    (a, b)
}

/// Parses ffprobe's `-show_data` hexdump ("00000000: 0164 001f ...  .d...").
fn parse_hexdump(s: &str) -> Vec<u8> {
    let mut out = vec![];
    for line in s.lines() {
        let Some((_, rest)) = line.split_once(": ") else {
            continue;
        };
        let hex = rest.split("  ").next().unwrap_or("").replace(' ', "");
        for i in (0..hex.len() / 2 * 2).step_by(2) {
            if let Ok(b) = u8::from_str_radix(&hex[i..i + 2], 16) {
                out.push(b);
            }
        }
    }
    out
}

fn run(args: &[&str], path: &Path) -> Result<String, String> {
    let out = Command::new(crate::tool("ffprobe"))
        .args(["-v", "error"])
        .args(args)
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn index(path: &Path) -> Result<(Vec<Packet>, bool), String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    let stem = path.file_name().unwrap().to_string_lossy();
    let cache = crate::cache_dir().join(format!("{stem}-{}-{mtime}.index.json", meta.len()));
    if let Ok(text) = std::fs::read_to_string(&cache) {
        if let Ok(p) = serde_json::from_str(&text) {
            return Ok((p, true));
        }
    }
    let text = run(
        &[
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts,dts,size,pos,flags",
            "-of",
            "compact=p=0",
        ],
        path,
    )?;
    let mut packets = vec![];
    for line in text.lines() {
        let (mut pts, mut dts, mut pos, mut size, mut key) = (0i64, 0i64, 0u64, 0u32, false);
        for kv in line.split('|') {
            let Some((k, v)) = kv.split_once('=') else {
                continue;
            };
            match k {
                "pts" => pts = v.parse().unwrap_or(0),
                "dts" => dts = v.parse().unwrap_or(0),
                "pos" => pos = v.parse().unwrap_or(0),
                "size" => size = v.parse().unwrap_or(0),
                "flags" => key = v.starts_with('K'),
                _ => {}
            }
        }
        packets.push(Packet(pts, dts, pos, size, key));
    }
    let _ = std::fs::write(&cache, serde_json::to_string(&packets).unwrap());
    Ok((packets, false))
}

pub fn probe(path: &Path) -> Result<Probe, String> {
    let started = Instant::now();
    let text = run(
        &["-show_streams", "-show_format", "-show_data", "-of", "json"],
        path,
    )?;
    let j: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let streams = j["streams"].as_array().cloned().unwrap_or_default();
    let v = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .ok_or("no video stream")?;
    let audio_tracks = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .count() as u32;
    let rotation = v["side_data_list"]
        .as_array()
        .and_then(|l| l.iter().find_map(|d| d["rotation"].as_i64()))
        .unwrap_or(0) as i32;
    let (fps_num, fps_den) = ratio(v["r_frame_rate"].as_str().unwrap_or("30/1"));
    let (tb_num, tb_den) = ratio(v["time_base"].as_str().unwrap_or("1/1000"));
    let (packets, index_cached) = index(path)?;
    Ok(Probe {
        codec: v["codec_name"].as_str().unwrap_or("").to_string(),
        width: v["width"].as_u64().unwrap_or(0) as u32,
        height: v["height"].as_u64().unwrap_or(0) as u32,
        rotation,
        fps_num,
        fps_den,
        tb_num,
        tb_den,
        duration: j["format"]["duration"]
            .as_str()
            .and_then(|d| d.parse().ok())
            .unwrap_or(0.0),
        audio_tracks,
        extradata: parse_hexdump(v["extradata"].as_str().unwrap_or("")),
        packets,
        probe_ms: started.elapsed().as_secs_f64() * 1000.0,
        index_cached,
    })
}
