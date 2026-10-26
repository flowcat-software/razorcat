//! Sound for recordings (PLAN 5b.4): Rust takes it from Windows itself (WASAPI, shared mode), the
//! system's sound by loopback or a microphone, and hands it to ffmpeg through a named pipe as raw
//! samples, beside the video.
//!
//! One clock: [`Clock`] is taken once as a recording starts. The video's frames are stamped by
//! the wall clock as they arrive (recording.rs, `setpts=RTCTIME`), and the sound is laid on the
//! same line by the performance-counter time Windows gives each packet: a packet late is padded
//! before with silence, one early is cut. Loopback sends nothing while nothing plays, so silence
//! fills those gaps as the clock goes on.

use std::collections::VecDeque;
use std::fs::File;
use std::os::windows::io::FromRawHandle;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use specta::Type;
use windows::core::{GUID, HSTRING};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
    MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE_ACTIVE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Storage::FileSystem::PIPE_ACCESS_OUTBOUND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_TYPE_BYTE, PIPE_WAIT,
};

/// Where the sound comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// What the computer plays (the default output, looped back).
    System,
    /// A microphone, by its Windows id; None, the default one.
    Microphone(Option<String>),
}

/// A microphone Windows has connected.
#[derive(Debug, Clone, Serialize, Type)]
pub struct Microphone {
    pub id: String,
    pub name: String,
}

/// The microphones connected, and the default one's name (None: there isn't one).
#[derive(Debug, Clone, Serialize, Type)]
pub struct Microphones {
    pub default: Option<String>,
    pub devices: Vec<Microphone>,
}

/// A device's name as Windows shows it (`PKEY_Device_FriendlyName`).
const FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};

/// The microphones connected now (on a thread of its own, for COM).
pub fn microphones() -> Microphones {
    let none = Microphones {
        default: None,
        devices: Vec::new(),
    };
    std::thread::spawn(|| unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let found = list_microphones();
        CoUninitialize();
        found
    })
    .join()
    .ok()
    .flatten()
    .unwrap_or(none)
}

unsafe fn list_microphones() -> Option<Microphones> {
    let devices: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
    let default = devices
        .GetDefaultAudioEndpoint(eCapture, eConsole)
        .ok()
        .map(|d| device_name(&d));
    let all = devices
        .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
        .ok()?;
    let mut found = Vec::new();
    for i in 0..all.GetCount().unwrap_or(0) {
        let Ok(device) = all.Item(i) else { continue };
        let Ok(id) = device.GetId() else { continue };
        let text = id.to_string().unwrap_or_default();
        CoTaskMemFree(Some(id.0 as *const _));
        found.push(Microphone {
            id: text,
            name: device_name(&device),
        });
    }
    found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Some(Microphones {
        default,
        devices: found,
    })
}

unsafe fn device_name(device: &IMMDevice) -> String {
    device
        .OpenPropertyStore(STGM_READ)
        .and_then(|store| store.GetValue(&FRIENDLY_NAME))
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "Microphone".into())
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
pub(crate) fn qpc_now() -> i64 {
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
    /// It's the microphone (it can be muted).
    pub microphone: bool,
    stop: Arc<AtomicBool>,
    /// Muting and unmuting, each when it was asked on the clock: silence goes in place of the
    /// sound captured from then (not read from then: it comes a little after), and the clock
    /// goes on, so sync holds.
    mutes: Arc<Mutex<Mutes>>,
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

        let microphone = matches!(source, Source::Microphone(_));
        let stop = Arc::new(AtomicBool::new(false));
        let mutes = Arc::new(Mutex::new(Mutes::default()));
        let (chunks, rx) = channel::<Vec<u8>>();
        let (ready, started) = channel::<Result<Format, String>>();
        let taking = {
            let (stop, mutes) = (stop.clone(), mutes.clone());
            std::thread::spawn(move || take(source, clock, &stop, &mutes, &ready, &chunks))
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
            microphone,
            stop,
            mutes,
            threads: vec![taking, writing],
        })
    }

    /// From now on the clock.
    pub fn set_muted(&self, muted: bool) {
        let mut m = self.mutes.lock().unwrap();
        m.presses.push_back((qpc_now(), muted));
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
    mutes: &Mutex<Mutes>,
    ready: &Sender<Result<Format, String>>,
    chunks: &Sender<Vec<u8>>,
) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let opened = unsafe { open(source.clone()) };
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
    // How long after capture the sound reaches us (100 ns), the most seen: the log says.
    let mut late = 0i64;
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
            let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
            let at = out.len();
            if silent || data.is_null() {
                out.resize(out.len() + kept, 0);
            } else {
                let from = place.skip as usize * format.block;
                // SAFETY: WASAPI's buffer holds `frames` frames until ReleaseBuffer.
                let all =
                    unsafe { std::slice::from_raw_parts(data, frames as usize * format.block) };
                out.extend_from_slice(&all[from..from + kept]);
            }
            late = late.max(qpc_now() - qpc as i64);
            // Muted where it was captured while muted.
            let first = qpc as i64 + place.skip * 10_000_000 / rate;
            let n = kept / format.block;
            for (a, b) in mutes.lock().unwrap().spans(first, n, format.rate) {
                out[at + a * format.block..at + b * format.block].fill(0);
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
    logln!(
        "[audio] {source:?}: sound came up to {} ms after it was captured",
        late / 10_000
    );
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
    let (device, flags) = match &source {
        Source::System => (
            devices.GetDefaultAudioEndpoint(eRender, eConsole),
            AUDCLNT_STREAMFLAGS_LOOPBACK,
        ),
        Source::Microphone(None) => (devices.GetDefaultAudioEndpoint(eCapture, eConsole), 0),
        Source::Microphone(Some(id)) => (devices.GetDevice(&HSTRING::from(id.as_str())), 0),
    };
    let device = device.map_err(|err| match source {
        Source::Microphone(Some(_)) => e("the microphone chosen isn't connected", err),
        Source::Microphone(None) => e("no microphone", err),
        Source::System => e("no sound output", err),
    })?;
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

/// Muting asked for, in order, each stamped on the clock (100 ns), and how it stands for the
/// sound taken so far.
#[derive(Debug, Default)]
struct Mutes {
    /// For the sound taken so far.
    now: bool,
    presses: VecDeque<(i64, bool)>,
}

impl Mutes {
    /// Which of `frames` frames, the first captured at `first` (100 ns) at `rate`, are muted:
    /// spans [from, to) of them. Presses at or before a frame's time apply to it.
    fn spans(&mut self, first: i64, frames: usize, rate: u32) -> Vec<(usize, usize)> {
        let mut spans = Vec::new();
        let mut from = 0;
        let at = |i: usize| first + i as i64 * 10_000_000 / i64::from(rate);
        while from < frames {
            // Presses up to this frame change how it stands.
            while let Some(&(t, m)) = self.presses.front() {
                if t > at(from) {
                    break;
                }
                self.now = m;
                self.presses.pop_front();
            }
            // As it stands until the next press, or the end.
            let to = match self.presses.front() {
                Some(&(t, _)) => (from + 1..frames).find(|&i| at(i) >= t).unwrap_or(frames),
                None => frames,
            };
            if self.now {
                spans.push((from, to));
            }
            from = to;
        }
        spans
    }
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
    fn muting_falls_where_the_sound_was_captured_when_asked() {
        // 1000 frames a second: a frame each 10_000 (100 ns).
        let mut m = Mutes::default();
        assert!(m.spans(0, 10, 1000).is_empty());
        // Muted at frame 15's time, unmuted at 18's: a packet of 10 from frame 10.
        m.presses.push_back((150_000, true));
        m.presses.push_back((180_000, false));
        assert_eq!(m.spans(100_000, 10, 1000), vec![(5, 8)]);
        // Muted from before a packet: all of it, until unmuted.
        m.presses.push_back((190_000, true));
        assert_eq!(m.spans(200_000, 4, 1000), vec![(0, 4)]);
        m.presses.push_back((260_000, false));
        assert_eq!(m.spans(240_000, 4, 1000), vec![(0, 2)]);
        assert!(m.spans(280_000, 4, 1000).is_empty());
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
