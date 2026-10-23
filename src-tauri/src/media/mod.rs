//! Reading sources: the MP4/MOV index ([`mp4`]) and the timeline's frame grid ([`grid`]).

pub mod grid;
pub mod mp4;

/// Checks against ffprobe on real files, frame by frame. Not run by default (they need the
/// spike's ffprobe and test media): `cargo test real_files -- --ignored --nocapture`. Files:
/// `spikes/media/` (`node spikes/make-test-media.mjs`) and any paths listed in
/// `spikes/playback/media.local.json` (Richard's recordings).
#[cfg(test)]
mod real_files {
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::Instant;

    use super::{grid, mp4};

    fn repo() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    fn files() -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = std::fs::read_dir(repo().join("spikes/media"))
            .map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).collect())
            .unwrap_or_default();
        if let Ok(text) = std::fs::read_to_string(repo().join("spikes/playback/media.local.json")) {
            let list: serde_json::Value = serde_json::from_str(&text).unwrap();
            for item in list.as_array().into_iter().flatten() {
                if let Some(p) = item["path"].as_str() {
                    out.push(PathBuf::from(p));
                }
            }
        }
        out.sort();
        out
    }

    /// ffprobe's video packets, in file order: (pts, size, pos, key).
    fn ffprobe(path: &Path) -> Vec<(i64, u32, u64, bool)> {
        let out = Command::new(repo().join("spikes/.tools/ffmpeg/bin/ffprobe.exe"))
            .args(["-v", "error", "-select_streams", "v:0"])
            .args([
                "-show_entries",
                "packet=pts,size,pos,flags",
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .output()
            .expect("ffprobe (spikes/.tools)");
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split(',').collect();
                Some((
                    f.first()?.parse().ok()?,
                    f.get(1)?.parse().ok()?,
                    f.get(2)?.parse().ok()?,
                    f.get(3)?.starts_with('K'),
                ))
            })
            .collect()
    }

    #[test]
    #[ignore]
    fn real_files_match_ffprobe() {
        let mut failures = 0;
        for path in files() {
            if !path.is_file() {
                println!("{}: missing, skipped", path.display());
                continue;
            }
            let t = Instant::now();
            let info = match mp4::read(&path) {
                Ok(i) => i,
                Err(e) => {
                    println!("{}: not read ({e})", path.display());
                    continue;
                }
            };
            let read_ms = t.elapsed().as_secs_f64() * 1000.0;
            let v = &info.video;
            let g = grid::build_at(v, None).unwrap();
            let probe = ffprobe(&path);
            let mut bad = 0;
            if probe.len() != v.len() {
                println!("  frame count: ours {} ffprobe {}", v.len(), probe.len());
                bad += 1;
            }
            for (i, &(pts, size, pos, key)) in probe.iter().enumerate().take(v.len()) {
                let ours = (v.pts[i], v.size[i], v.offset[i], v.key[i]);
                if ours != (pts, size, pos, key) {
                    if bad < 3 {
                        println!(
                            "  frame {i}: ours {ours:?} ffprobe {:?}",
                            (pts, size, pos, key)
                        );
                    }
                    bad += 1;
                }
            }
            println!(
                "{}: {} {}x{} rot {} audio {}, {} frames, read {read_ms:.1} ms; grid {}/{} fps \
                 ({:.3}), {} frames{}; mismatches {bad}",
                path.display(),
                info.codec,
                info.width,
                info.height,
                info.rotation,
                info.audio_tracks,
                v.len(),
                g.rate.num,
                g.rate.den,
                g.rate.fps(),
                g.frames,
                if g.variable { ", variable" } else { "" },
            );
            failures += usize::from(bad > 0);
        }
        assert_eq!(failures, 0, "files that didn't match ffprobe");
    }
}
