//! Sound for recordings (PLAN 5b.4): Rust takes it from Windows itself (WASAPI, shared mode), the
//! system's sound by loopback or a microphone, and hands it to ffmpeg through a named pipe as raw
//! samples, beside the video.
//!
//! One clock: [`Clock`] is taken once as a recording starts. The video's frames are stamped by
//! the wall clock as they arrive (recording.rs, `setpts=RTCTIME`), and the sound is laid on the
//! same line by the performance-counter time Windows gives each packet: a packet late is padded
//! before with silence, one early is cut. Loopback sends nothing while nothing plays, so silence
//! fills those gaps as the clock goes on.

use std::fs::File;
use std::os::windows::io::FromRawHandle;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use windows::core::{GUID, HSTRING};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
    MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Storage::FileSystem::PIPE_ACCESS_OUTBOUND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_TYPE_BYTE, PIPE_WAIT,
};

/// Where the sound comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// What the computer plays (the default output, looped back).
    System,
    /// The default microphone.
    Microphone,
}

/// The moment a recording starts, on both clocks: the performance counter (100 ns units, as
/// WASAPI stamps packets) and the wall clock (µs since 1970, as ffmpeg's `RTCTIME`).
#[derive(Debug, Clone, Copy)]
pub struct Clock {
    pub qpc: i64,
    pub unix_us: i64,
}

impl Clock {
    pub fn now() -> Self {
        let unix_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_micros() as i64);
        Self {
            qpc: qpc_now(),
            unix_us,
        }
    }
}

/// The performance counter, in 100 ns units.
fn qpc_now() -> i64 {
    let (mut count, mut freq) = (0i64, 0i64);
    unsafe {
        let _ = QueryPerformanceCounter(&mut count);
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    if freq == 0 {
        return 0;
    }
    (i128::from(count) * 10_000_000 / i128::from(freq)) as i64
}

/// The samples' shape, as ffmpeg's raw input needs it (`-f`, `-ar`, `-ac`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Format {
    pub sample: &'static str,
    pub rate: u32,
    pub channels: u16,
    /// Bytes per frame (all channels).
    block: usize,
}

/// A source being taken, into its pipe.
pub struct Capture {
    pub format: Format,
    /// The pipe ffmpeg reads (`-i`).
    pub pipe: String,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl Capture {
    /// Starts taking `source`, laid on `clock`'s line; ready once it returns (its format known,
    /// its pipe made for ffmpeg to open).
    pub fn start(source: Source, clock: Clock) -> Result<Capture, String> {
        let pipe = pipe_name();
        let handle = unsafe {
            CreateNamedPipeW(
                &HSTRING::from(pipe.as_str()),
                PIPE_ACCESS_OUTBOUND,
                PIPE_TYPE_BYTE | PIPE_WAIT,
                1,
                1 << 20,
                0,
                0,
                None,
            )
        };
        if handle.is_invalid() {
            return Err(format!(
                "the sound's pipe: {}",
                windows::core::Error::from_thread()
            ));
        }
        // SAFETY: a new, valid handle, owned by this File from here.
        let file = unsafe { File::from_raw_handle(handle.0) };

        let stop = Arc::new(AtomicBool::new(false));
        let (chunks, rx) = channel::<Vec<u8>>();
        let (ready, started) = channel::<Result<Format, String>>();
        let taking = {
            let stop = stop.clone();
            std::thread::spawn(move || take(source, clock, &stop, &ready, &chunks))
        };
        let format = match started.recv() {
            Ok(Ok(f)) => f,
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err("the sound stopped as it started".into()),
        };
        let writing = {
            let stop = stop.clone();
            let pipe = pipe.clone();
            std::thread::spawn(move || write(file, rx, &stop, &pipe))
        };
        Ok(Capture {
            format,
            pipe,
            stop,
            threads: vec![taking, writing],
        })
    }

    /// Stops taking; the pipe closes, which ends ffmpeg's sound.
    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        // A writer still waiting for ffmpeg (it never opened the pipe) is let go by opening it.
        let _ = std::fs::OpenOptions::new().read(true).open(&self.pipe);
        for t in self.threads {
            let _ = t.join();
        }
    }
}

fn pipe_name() -> String {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    format!(
        r"\\.\pipe\razorcat-sound-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    )
}

/// Hands the chunks to ffmpeg once it opens the pipe, until they end or it goes.
fn write(mut file: File, rx: Receiver<Vec<u8>>, stop: &AtomicBool, pipe: &str) {
    use std::io::Write;
    use std::os::windows::io::AsRawHandle;
    let handle = windows::Win32::Foundation::HANDLE(file.as_raw_handle());
    // Fails with "already connected" if ffmpeg opened it first: fine.
    let _ = unsafe { ConnectNamedPipe(handle, None) };
    if stop.load(Ordering::SeqCst) {
        return;
    }
    for chunk in rx {
        if let Err(e) = file.write_all(&chunk) {
            logln!("[audio] {pipe}: {e}");
            return;
        }
    }
}

/// How far behind the clock silence is laid while a source sends nothing (s): packets due late
/// still find their place.
const IDLE_LAG: f64 = 0.1;
/// How far a packet may be off its place before it's moved (s): smaller, it's jitter.
const TOLERANCE: f64 = 0.02;

/// Takes `source` until `stop`, saying its format on `ready` first.
fn take(
    source: Source,
    clock: Clock,
    stop: &AtomicBool,
    ready: &Sender<Result<Format, String>>,
    chunks: &Sender<Vec<u8>>,
) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let opened = unsafe { open(source) };
    let (client, capture, format) = match opened {
        Ok(o) => o,
        Err(e) => {
            let _ = ready.send(Err(e));
            unsafe { CoUninitialize() };
            return;
        }
    };
    let _ = ready.send(Ok(format.clone()));

    let rate = i64::from(format.rate);
    let mut line = Timeline::new((TOLERANCE * rate as f64) as i64);
    let silence = |frames: i64| vec![0u8; frames.max(0) as usize * format.block];
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(10));
        let mut got = false;
        loop {
            let size = unsafe { capture.GetNextPacketSize() }.unwrap_or(0);
            if size == 0 {
                break;
            }
            let (mut data, mut frames, mut flags, mut qpc) =
                (std::ptr::null_mut(), 0u32, 0u32, 0u64);
            if unsafe {
                capture.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc))
            }
            .is_err()
            {
                break;
            }
            let start = (i128::from(qpc as i64 - clock.qpc) * i128::from(rate) / 10_000_000) as i64;
            let place = line.place(start, i64::from(frames));
            let mut out = silence(place.pad);
            let kept = (i64::from(frames) - place.skip).max(0) as usize * format.block;
            if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                out.resize(out.len() + kept, 0);
            } else {
                let from = place.skip as usize * format.block;
                // SAFETY: WASAPI's buffer holds `frames` frames until ReleaseBuffer.
                let all =
                    unsafe { std::slice::from_raw_parts(data, frames as usize * format.block) };
                out.extend_from_slice(&all[from..from + kept]);
            }
            let _ = unsafe { capture.ReleaseBuffer(frames) };
            got = true;
            if !out.is_empty() && chunks.send(out).is_err() {
                break;
            }
        }
        if !got {
            let due = ((qpc_now() - clock.qpc) as f64 / 1e7 - IDLE_LAG) * rate as f64;
            let pad = line.idle(due as i64);
            if pad > 0 {
                let _ = chunks.send(silence(pad));
            }
        }
    }
    unsafe {
        let _ = client.Stop();
        CoUninitialize();
    }
}

/// Opens the device for `source`, started: its client, its capture, its format.
unsafe fn open(source: Source) -> Result<(IAudioClient, IAudioCaptureClient, Format), String> {
    let e = |what: &str, err: windows::core::Error| format!("{what}: {err}");
    let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        .map_err(|err| e("the sound devices", err))?;
    let (flow, flags) = match source {
        Source::System => (eRender, AUDCLNT_STREAMFLAGS_LOOPBACK),
        Source::Microphone => (eCapture, 0),
    };
    let device = devices
        .GetDefaultAudioEndpoint(flow, eConsole)
        .map_err(|err| e("no sound device", err))?;
    let client: IAudioClient = device
        .Activate(CLSCTX_ALL, None)
        .map_err(|err| e("the sound device", err))?;
    let mix = client
        .GetMixFormat()
        .map_err(|err| e("the sound's format", err))?;
    let format = format_of(mix);
    // 200 ms of buffer: read every 10 ms.
    let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, mix, None);
    CoTaskMemFree(Some(mix as *const _));
    let format = format?;
    init.map_err(|err| e("the sound device", err))?;
    let capture: IAudioCaptureClient = client
        .GetService()
        .map_err(|err| e("the sound device", err))?;
    client.Start().map_err(|err| e("the sound device", err))?;
    Ok((client, capture, format))
}

/// Float or PCM, as `wFormatTag` or an extensible format's sub-format says.
const FLOAT: u16 = 3;
const PCM: u16 = 1;
const EXTENSIBLE: u16 = 0xFFFE;

/// The ffmpeg shape of a WASAPI mix format.
unsafe fn format_of(mix: *const WAVEFORMATEX) -> Result<Format, String> {
    let wf = std::ptr::read_unaligned(mix);
    let tag = if wf.wFormatTag == EXTENSIBLE {
        let ext = std::ptr::read_unaligned(mix as *const WAVEFORMATEXTENSIBLE);
        let sub: GUID = ext.SubFormat;
        sub.data1 as u16
    } else {
        wf.wFormatTag
    };
    let sample = match (tag, wf.wBitsPerSample) {
        (FLOAT, 32) => "f32le",
        (PCM, 16) => "s16le",
        (PCM, 24) => "s24le",
        (PCM, 32) => "s32le",
        (t, b) => return Err(format!("a sound format we can't take ({t}, {b} bits)")),
    };
    Ok(Format {
        sample,
        rate: wf.nSamplesPerSec,
        channels: wf.nChannels,
        block: usize::from(wf.nBlockAlign),
    })
}

/// Where the sound is up to on the clock's line, in frames, and what each packet needs to land
/// on its place.
#[derive(Debug)]
struct Timeline {
    written: i64,
    tolerance: i64,
}

/// A packet's landing: silence before it, and frames cut from its start.
#[derive(Debug, PartialEq, Eq)]
struct Place {
    pad: i64,
    skip: i64,
}

impl Timeline {
    fn new(tolerance: i64) -> Self {
        Self {
            written: 0,
            tolerance,
        }
    }

    /// A packet of `frames` due at frame `start`.
    fn place(&mut self, start: i64, frames: i64) -> Place {
        let mut p = Place { pad: 0, skip: 0 };
        if start > self.written + self.tolerance {
            p.pad = start - self.written;
        } else if start < self.written - self.tolerance {
            p.skip = (self.written - start).min(frames);
        }
        self.written += p.pad + frames - p.skip;
        p
    }

    /// Nothing came: silence up to frame `due`.
    fn idle(&mut self, due: i64) -> i64 {
        let pad = (due - self.written).max(0);
        self.written += pad;
        pad
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packets_on_time_follow_on() {
        let mut t = Timeline::new(960);
        assert_eq!(t.place(0, 480), Place { pad: 0, skip: 0 });
        // A little early or late: jitter, left as it is.
        assert_eq!(t.place(400, 480), Place { pad: 0, skip: 0 });
        assert_eq!(t.place(1500, 480), Place { pad: 0, skip: 0 });
        assert_eq!(t.written, 1440);
    }

    #[test]
    fn a_late_packet_has_silence_before_it() {
        let mut t = Timeline::new(960);
        assert_eq!(
            t.place(48_000, 480),
            Place {
                pad: 48_000,
                skip: 0
            }
        );
        assert_eq!(t.written, 48_480);
    }

    #[test]
    fn an_early_packet_is_cut_and_one_before_the_start_is_dropped() {
        let mut t = Timeline::new(960);
        assert_eq!(t.place(-200, 480), Place { pad: 0, skip: 0 });
        let mut t = Timeline::new(100);
        assert_eq!(t.place(-1000, 480), Place { pad: 0, skip: 480 });
        assert_eq!(t.written, 0);
        assert_eq!(t.place(-300, 480), Place { pad: 0, skip: 300 });
        assert_eq!(t.written, 180);
    }

    #[test]
    fn silence_fills_while_nothing_comes() {
        let mut t = Timeline::new(960);
        assert_eq!(t.idle(4800), 4800);
        assert_eq!(t.idle(4000), 0);
        // Sound again, where the clock says.
        assert_eq!(t.place(9600, 480), Place { pad: 4800, skip: 0 });
    }
}
