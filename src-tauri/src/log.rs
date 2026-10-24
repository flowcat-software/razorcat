//! The log (PLAN C1): every line to stderr, as before, and to a file a tester can send,
//! `logs\razorcat.log` in local app data, the last few runs kept. What goes in the file is
//! scrubbed (`scrub.rs`): no paths, no file names, nothing that identifies the user or their
//! project. Panics are logged with a backtrace, and native crashes by `crash.rs`.
//!
//! Lines before the file opens (Tauri's setup) are held and written when it does: a second
//! launch hands over to the first before then, so it never touches the first one's log.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Instant;

use crate::scrub;

/// Runs whose logs are kept: `razorcat.log`, then `razorcat.1.log` (the run before) and on.
const KEEP_RUNS: usize = 5;
/// Lines held before the file opens, at most.
const EARLY_MAX: usize = 500;

/// Logs a line: `logln!("[export] {n} markup items")`. Name a module in brackets first.
macro_rules! logln {
    ($($arg:tt)*) => {
        $crate::log::line(&format!($($arg)*))
    };
}

struct Log {
    file: Option<File>,
    early: Vec<String>,
    /// Scrubbed from every line: the user's and computer's names, the files opened and
    /// exported.
    names: Vec<String>,
}

static LOG: Mutex<Log> = Mutex::new(Log {
    file: None,
    early: Vec::new(),
    names: Vec::new(),
});
static START: OnceLock<Instant> = OnceLock::new();
static DIR: OnceLock<PathBuf> = OnceLock::new();

fn lock() -> MutexGuard<'static, Log> {
    LOG.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The folder of logs and crash dumps: `%LOCALAPPDATA%\{identifier}\logs`, Tauri's
/// `app_log_dir`, known before the app is built.
pub fn dir() -> Option<&'static Path> {
    DIR.get().map(PathBuf::as_path)
}

/// First thing at startup: the clock, the folder, the names to scrub, the panic hook and the
/// crash handler. The file opens later, in [`open`].
pub fn init(identifier: &str) {
    START.get_or_init(Instant::now);
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let _ = DIR.set(Path::new(&local).join(identifier).join("logs"));
    }
    {
        let mut log = lock();
        // The profile's folder can be named otherwise than the user.
        let profile = std::env::var("USERPROFILE")
            .ok()
            .and_then(|p| Some(Path::new(&p).file_name()?.to_string_lossy().into_owned()));
        let names = ["USERNAME", "COMPUTERNAME"]
            .map(|var| std::env::var(var).ok())
            .into_iter()
            .chain([profile])
            .flatten();
        for name in names {
            // Short ones would eat ordinary words.
            if name.chars().count() >= 3 && !log.names.contains(&name) {
                log.names.push(name);
            }
        }
    }
    std::panic::set_hook(Box::new(|info| {
        let thread = std::thread::current();
        let backtrace = std::backtrace::Backtrace::force_capture();
        // `{:#}`: the addresses too, which with the header's exe address and the build's
        // symbols name the functions.
        line(&format!(
            "[panic] thread {}: {info}\n{backtrace:#}",
            thread.name().unwrap_or("unnamed")
        ));
        match crate::crash::dump(None) {
            Ok(name) => line(&format!("[panic] dump written: {name}")),
            Err(e) => line(&format!("[panic] no dump: {e}")),
        }
    }));
    crate::crash::install();
}

/// Opens this run's file (the older ones moved along, the oldest dropped), with a header
/// naming the build, Windows and the time, then the lines held so far.
pub fn open(product: &str) {
    let mut log = lock();
    if log.file.is_some() {
        return;
    }
    let Some(dir) = dir() else { return };
    if let Err(e) = fs::create_dir_all(dir) {
        eprintln!("[log] can't make the logs folder: {e}");
        return;
    }
    rotate(dir);
    crate::crash::prune(dir);
    let mut file = match File::create(dir.join("razorcat.log")) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[log] can't open the log: {e}");
            return;
        }
    };
    let _ = writeln!(file, "{}", crate::crash::header(product));
    for held in std::mem::take(&mut log.early) {
        let _ = writeln!(file, "{}", scrub::scrub(&held, &log.names));
    }
    let _ = file.flush();
    log.file = Some(file);
}

fn rotate(dir: &Path) {
    let name = |k: usize| match k {
        0 => dir.join("razorcat.log"),
        k => dir.join(format!("razorcat.{k}.log")),
    };
    let _ = fs::remove_file(name(KEEP_RUNS - 1));
    for k in (0..KEEP_RUNS - 1).rev() {
        let _ = fs::rename(name(k), name(k + 1));
    }
}

/// Writes a line: to stderr as given, to the file scrubbed, with the seconds since startup.
pub fn line(text: &str) {
    eprintln!("{text}");
    let mut log = lock();
    write(&mut log, text);
}

fn write(log: &mut Log, text: &str) {
    let at = START.get_or_init(Instant::now).elapsed().as_secs_f64();
    let stamped = format!("[{at:9.3}] {text}");
    match log.file.as_mut() {
        Some(file) => {
            let _ = writeln!(file, "{}", scrub::scrub(&stamped, &log.names));
            // Every line, so a crash loses none.
            let _ = file.flush();
        }
        None if log.early.len() < EARLY_MAX => log.early.push(stamped),
        None => {}
    }
}

/// A line from the crash handler: never waits for the lock (the crash may have happened
/// while holding it), and opens the file if it isn't yet.
pub fn crash_line(text: &str, product: &str) {
    eprintln!("{text}");
    let Ok(mut log) = LOG.try_lock() else { return };
    if log.file.is_none() {
        drop(log);
        open(product);
        let Ok(again) = LOG.try_lock() else { return };
        log = again;
    }
    write(&mut log, text);
}

/// A file's name, kept out of the log from now on (with its stem, if long enough).
pub fn private_file(path: &Path) {
    let Some(name) = path.file_name() else { return };
    let mut log = lock();
    for name in scrub::file_names(&name.to_string_lossy()) {
        if !log.names.contains(&name) {
            log.names.push(name);
        }
    }
}

/// The names kept out of the log, for the crash handler's dump: never waits for the lock.
pub fn private_names() -> Vec<String> {
    LOG.try_lock()
        .map(|log| log.names.clone())
        .unwrap_or_default()
}
