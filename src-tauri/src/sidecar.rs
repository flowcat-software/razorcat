//! The bundled media tools (ffmpeg, gifski): Tauri sidecars (`bundle.externalBin`), copied next
//! to Driveby's exe by both the installer and dev builds (as `ffmpeg.exe`, `gifski.exe`).
//! `npm run fetch-tools` downloads the pinned builds. They run as child processes with no
//! console window, and `spawn` ties them to Driveby: they end when it does, even if it crashes.

use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::OnceLock;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

use serde::Serialize;
use specta::Type;

/// Windows' CREATE_NO_WINDOW: a console tool started from a GUI app would open a console.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Windows' BELOW_NORMAL_PRIORITY_CLASS, for background work, so the app stays quick.
const BELOW_NORMAL: u32 = 0x0000_4000;

#[derive(Debug, Clone, Copy)]
pub enum Tool {
    Ffmpeg,
    Gifski,
}

impl Tool {
    fn file_name(self) -> &'static str {
        match self {
            Tool::Ffmpeg => "ffmpeg.exe",
            Tool::Gifski => "gifski.exe",
        }
    }

    fn version_arg(self) -> &'static str {
        match self {
            Tool::Ffmpeg => "-version",
            Tool::Gifski => "--version",
        }
    }
}

/// Where the tool sits: beside Driveby's own exe.
pub fn path(tool: Tool) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Can't find Driveby's folder: {e}"))?;
    let path = exe
        .parent()
        .ok_or("Can't find Driveby's folder")?
        .join(tool.file_name());
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "{} is missing from {}",
            tool.file_name(),
            path.parent().unwrap_or(&path).display()
        ))
    }
}

/// A command for the tool, with no console window.
pub fn command(tool: Tool) -> Result<Command, String> {
    let mut cmd = Command::new(path(tool)?);
    cmd.creation_flags(CREATE_NO_WINDOW);
    Ok(cmd)
}

/// A command for background work (proxies): as `command`, at below-normal priority.
pub fn background(tool: Tool) -> Result<Command, String> {
    let mut cmd = Command::new(path(tool)?);
    cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL);
    Ok(cmd)
}

/// Starts `cmd` inside Driveby's job object, which Windows closes when Driveby exits (or
/// crashes), killing whatever is still running: no ffmpeg is left behind writing a proxy.
pub fn spawn(cmd: &mut Command) -> std::io::Result<Child> {
    let child = cmd.spawn()?;
    if let Some(job) = job() {
        let process = HANDLE(child.as_raw_handle());
        if let Err(e) = unsafe { AssignProcessToJobObject(job, process) } {
            eprintln!("[sidecar] couldn't tie the tool to Driveby: {e}");
        }
    }
    Ok(child)
}

/// The job object, made once; it lives (open) as long as Driveby.
fn job() -> Option<HANDLE> {
    // HANDLE isn't Send; the raw value is, and a job handle is usable from any thread.
    static JOB: OnceLock<Option<usize>> = OnceLock::new();
    let raw = JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(None, None)
            .map_err(|e| eprintln!("[sidecar] no job object: {e}"))
            .ok()?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|e| eprintln!("[sidecar] job object limits: {e}"))
        .ok()?;
        Some(job.0 as usize)
    });
    raw.map(|h| HANDLE(h as *mut _))
}

/// The version the tool reports, e.g. "n8.1.3-20260926" or "1.34.0".
pub fn version(tool: Tool) -> Result<String, String> {
    let out = command(tool)?
        .arg(tool.version_arg())
        .output()
        .map_err(|e| format!("{} didn't start: {e}", tool.file_name()))?;
    let text = String::from_utf8_lossy(&out.stdout);
    parse_version(&text).ok_or_else(|| format!("{} gave no version", tool.file_name()))
}

/// The version from the first line of `ffmpeg -version` ("ffmpeg version n8.1.3-20260926
/// Copyright ...") or `gifski --version` ("gifski 1.34.0").
fn parse_version(output: &str) -> Option<String> {
    let line = output.lines().next()?;
    let mut words = line.split_whitespace();
    let name = words.next()?;
    let next = words.next()?;
    let version = if name == "ffmpeg" && next == "version" {
        words.next()?
    } else {
        next
    };
    Some(version.to_string())
}

/// The bundled tools' versions, for Settings › About. `None` when one is missing or broken.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MediaTools {
    pub ffmpeg: Option<String>,
    pub gifski: Option<String>,
}

pub fn media_tools() -> MediaTools {
    let check = |tool| version(tool).map_err(|e| eprintln!("[sidecar] {e}")).ok();
    MediaTools {
        ffmpeg: check(Tool::Ffmpeg),
        gifski: check(Tool::Gifski),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ffmpeg_and_gifski_versions() {
        assert_eq!(
            parse_version("ffmpeg version n8.1.3-20260926 Copyright (c) 2000-2026\nbuilt with gcc")
                .as_deref(),
            Some("n8.1.3-20260926")
        );
        assert_eq!(parse_version("gifski 1.34.0\n").as_deref(), Some("1.34.0"));
    }

    #[test]
    fn no_version_from_nothing() {
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("ffmpeg"), None);
        assert_eq!(parse_version("ffmpeg version"), None);
    }
}
