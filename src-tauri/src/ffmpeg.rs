//! Running the bundled ffmpeg for background work (proxies, conversions): below-normal priority,
//! tied to Driveby's lifetime (sidecar.rs), with progress, a way to stop it, and its error.
//!
//! The output goes to a `.part` file next to where it belongs, renamed into place only once
//! ffmpeg succeeds, so a stopped or failed run never leaves a file that looks finished.

use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::sidecar::{self, Tool};

/// Progress callbacks at most this often.
const PROGRESS_EVERY_MS: u128 = 250;

pub enum Outcome {
    Finished,
    /// `stop` said so; the part file is gone.
    Stopped,
}

/// Runs ffmpeg with `args` (inputs, filters, codecs: everything but the output) writing to
/// `output`, in the background (below-normal priority). `frames`, if known, measures progress;
/// otherwise the input's duration does. `progress` gets 0 to 1; `stop` is asked as ffmpeg
/// reports, and ends it if true.
pub fn run(
    args: &[OsString],
    output: &Path,
    frames: Option<u64>,
    progress: impl FnMut(f64),
    stop: impl Fn() -> bool,
) -> Result<Outcome, String> {
    run_with(
        sidecar::background(Tool::Ffmpeg)?,
        args,
        output,
        frames,
        progress,
        stop,
    )
}

/// As `run`, at normal priority: work the user is waiting for (an export).
pub fn run_now(
    args: &[OsString],
    output: &Path,
    frames: Option<u64>,
    progress: impl FnMut(f64),
    stop: impl Fn() -> bool,
) -> Result<Outcome, String> {
    run_with(
        sidecar::command(Tool::Ffmpeg)?,
        args,
        output,
        frames,
        progress,
        stop,
    )
}

fn run_with(
    mut cmd: std::process::Command,
    args: &[OsString],
    output: &Path,
    frames: Option<u64>,
    mut progress: impl FnMut(f64),
    stop: impl Fn() -> bool,
) -> Result<Outcome, String> {
    let part = output.with_extension("part");
    cmd.args([
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-loglevel",
        "info",
        "-y",
    ])
    .args(args)
    .args(["-progress", "pipe:1", "-stats_period", "0.25"])
    // The output's format comes from `args`'s `-f`: the part file has no telling extension.
    .arg(&part)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = sidecar::spawn(&mut cmd).map_err(|e| format!("ffmpeg didn't start: {e}"))?;

    // stderr is read on its own thread (a full pipe would stall ffmpeg): the input's duration
    // and the last lines, for the error.
    let log = Arc::new(Mutex::new(Log::default()));
    let stderr = child.stderr.take().ok_or("no log from ffmpeg")?;
    let reader = {
        let log = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log.lock().unwrap().add(line);
            }
        })
    };

    let stdout = child.stdout.take().ok_or("no output from ffmpeg")?;
    let mut last = Instant::now();
    let mut out_us: Option<u64> = None;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if stop() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            let _ = fs::remove_file(&part);
            return Ok(Outcome::Stopped);
        }
        let done = match (frames, field(&line, "frame=")) {
            (Some(total), Some(n)) => Some(n as f64 / total.max(1) as f64),
            (None, _) => field(&line, "out_time_us=").and_then(|us| {
                out_us = Some(us);
                let secs = log.lock().unwrap().duration?;
                (secs > 0.0).then(|| us as f64 / 1e6 / secs)
            }),
            _ => None,
        };
        if let Some(done) = done {
            if last.elapsed().as_millis() >= PROGRESS_EVERY_MS {
                last = Instant::now();
                progress(done.clamp(0.0, 1.0));
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = reader.join();
    if !status.success() {
        let _ = fs::remove_file(&part);
        let log = log.lock().unwrap();
        return Err(log.error().unwrap_or_else(|| format!("ffmpeg {status}")));
    }
    fs::rename(&part, output).map_err(|e| format!("can't keep {}: {e}", output.display()))?;
    Ok(Outcome::Finished)
}

/// A `key=value` line of `-progress` output, as a number.
fn field(line: &str, key: &str) -> Option<u64> {
    line.strip_prefix(key)?.trim().parse().ok()
}

/// What ffmpeg's log says that matters here.
#[derive(Default)]
struct Log {
    /// The first input's duration, in seconds.
    duration: Option<f64>,
    /// The last few lines.
    tail: Vec<String>,
}

impl Log {
    fn add(&mut self, line: String) {
        if self.duration.is_none() {
            self.duration = duration(&line);
        }
        self.tail.push(line);
        if self.tail.len() > 20 {
            self.tail.remove(0);
        }
    }

    /// The line that says what went wrong: the last that looks like an error, else the last.
    fn error(&self) -> Option<String> {
        let wrong = |l: &&String| {
            let l = l.to_lowercase();
            [
                "error",
                "invalid",
                "not supported",
                "could not",
                "unknown",
                "no such",
            ]
            .iter()
            .any(|w| l.contains(w))
        };
        self.tail
            .iter()
            .rev()
            .find(wrong)
            .or(self.tail.last())
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
    }
}

/// The seconds in a log line's `Duration: 00:01:02.33`, if it has one.
fn duration(line: &str) -> Option<f64> {
    let rest = line.trim_start().strip_prefix("Duration: ")?;
    let hms = rest.split(',').next()?;
    let mut parts = hms.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_progress_fields() {
        assert_eq!(field("frame=123", "frame="), Some(123));
        assert_eq!(field("frame= 7", "frame="), Some(7));
        assert_eq!(
            field("out_time_us=1500000", "out_time_us="),
            Some(1_500_000)
        );
        assert_eq!(field("out_time_us=N/A", "out_time_us="), None);
        assert_eq!(field("fps=30.0", "frame="), None);
    }

    #[test]
    fn reads_the_duration() {
        assert_eq!(
            duration("  Duration: 00:01:02.50, start: 0.000000, bitrate: 3021 kb/s"),
            Some(62.5)
        );
        assert_eq!(duration("  Duration: N/A, bitrate: N/A"), None);
        assert_eq!(duration("Stream #0:0: Video: h264"), None);
    }

    #[test]
    fn the_error_is_the_line_that_says_so() {
        let mut log = Log::default();
        for l in [
            "Input #0, matroska,webm, from 'a.mkv':",
            "[mp4 @ 0x1] Could not find tag for codec vorbis in stream #1",
            "Conversion failed!",
        ] {
            log.add(l.to_string());
        }
        assert_eq!(
            log.error().as_deref(),
            Some("[mp4 @ 0x1] Could not find tag for codec vorbis in stream #1")
        );
        assert_eq!(Log::default().error(), None);
    }
}
