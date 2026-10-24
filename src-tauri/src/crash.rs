//! Native crashes (PLAN C2): an unhandled-exception filter that logs the exception, where it
//! happened (module and offset) and writes a small minidump next to the log, then lets Windows
//! go on as before. Windows' own dumps (LocalDumps) need an HKLM key, which a per-user
//! install can't set. The dump holds the threads' stacks and registers and the module list:
//! with the build's symbols (`build:local` keeps them), the stack names its functions. The
//! names the log keeps out are blanked in it too.

use std::fs::{self, File};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HMODULE};
use windows::Win32::System::Diagnostics::Debug::{
    MiniDumpNormal, MiniDumpWithThreadInfo, MiniDumpWithUnloadedModules, MiniDumpWriteDump,
    SetUnhandledExceptionFilter, EXCEPTION_POINTERS, MINIDUMP_EXCEPTION_INFORMATION, MINIDUMP_TYPE,
};
use windows::Win32::System::LibraryLoader::{
    GetModuleFileNameW, GetModuleHandleExW, GetModuleHandleW,
    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
};
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};
use windows::Win32::System::SystemInformation::GetLocalTime;
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId,
};

/// Crash dumps kept, newest first.
const KEEP_DUMPS: usize = 5;
const EXCEPTION_CONTINUE_SEARCH: i32 = 0;
const ACCESS_VIOLATION: u32 = 0xC000_0005;

/// The product name, for a crash before the log has opened.
static PRODUCT: OnceLock<String> = OnceLock::new();

/// The build, as the About page shows it: `0.1.0+98 (c308660, modified)`; dev builds say so.
pub fn build() -> String {
    let version = option_env!("VITE_BUILD_VERSION").unwrap_or("");
    if version.is_empty() {
        return format!("{} dev", env!("CARGO_PKG_VERSION"));
    }
    let commit = option_env!("VITE_BUILD_COMMIT").unwrap_or("?");
    let modified = !option_env!("VITE_BUILD_MODIFIED").unwrap_or("").is_empty();
    format!(
        "{version} ({commit}{})",
        if modified { ", modified" } else { "" }
    )
}

/// The log's first line: the build, Windows, the local time, and where the exe is loaded (so
/// a backtrace's addresses can be made offsets).
pub fn header(product: &str) -> String {
    let _ = PRODUCT.set(product.to_string());
    let t = unsafe { GetLocalTime() };
    let base = unsafe { GetModuleHandleW(PCWSTR::null()) }.map_or(0, |m| m.0 as usize);
    format!(
        "{product} {} · Windows {} · {:04}-{:02}-{:02} {:02}:{:02}:{:02} · exe at 0x{base:x}",
        build(),
        windows_version(),
        t.wYear,
        t.wMonth,
        t.wDay,
        t.wHour,
        t.wMinute,
        t.wSecond
    )
}

/// `build 26200.6899 (25H2)`.
fn windows_version() -> String {
    let key = w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let text = |value: PCWSTR| -> Option<String> {
        let mut buf = [0u16; 64];
        let mut size = std::mem::size_of_val(&buf) as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key,
                value,
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        status.is_ok().then(|| {
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            String::from_utf16_lossy(&buf[..len])
        })
    };
    let mut ubr = 0u32;
    let mut size = 4u32;
    let has_ubr = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key,
            w!("UBR"),
            RRF_RT_REG_DWORD,
            None,
            Some((&raw mut ubr).cast()),
            Some(&mut size),
        )
    }
    .is_ok();
    let mut out = format!(
        "build {}",
        text(w!("CurrentBuild")).unwrap_or_else(|| "?".into())
    );
    if has_ubr {
        out += &format!(".{ubr}");
    }
    if let Some(release) = text(w!("DisplayVersion")) {
        out += &format!(" ({release})");
    }
    out
}

/// Installs the filter, for every thread. Windows still reports the crash after it.
pub fn install() {
    unsafe {
        SetUnhandledExceptionFilter(Some(on_crash));
    }
}

unsafe extern "system" fn on_crash(info: *const EXCEPTION_POINTERS) -> i32 {
    // A second thread crashing meanwhile, or this handler crashing, goes straight on.
    static ONCE: AtomicBool = AtomicBool::new(false);
    if ONCE.swap(true, Ordering::SeqCst) || info.is_null() {
        return EXCEPTION_CONTINUE_SEARCH;
    }
    let product = PRODUCT.get().map_or("Razorcat", String::as_str);
    if let Some(record) = unsafe { (*info).ExceptionRecord.as_ref() } {
        let code = record.ExceptionCode.0 as u32;
        let mut what = format!(
            "[crash] exception 0x{code:08x} at {}, thread {}",
            place(record.ExceptionAddress as usize),
            std::thread::current().name().unwrap_or("unnamed")
        );
        if code == ACCESS_VIOLATION && record.NumberParameters >= 2 {
            let kind = match record.ExceptionInformation[0] {
                0 => "reading",
                1 => "writing",
                8 => "executing",
                _ => "touching",
            };
            what += &format!(", {kind} 0x{:x}", record.ExceptionInformation[1]);
        }
        crate::log::crash_line(&what, product);
    }
    let result = match dump(Some(info)) {
        Ok(name) => format!("[crash] dump written: {name}"),
        Err(e) => format!("[crash] no dump: {e}"),
    };
    crate::log::crash_line(&result, product);
    EXCEPTION_CONTINUE_SEARCH
}

/// `razorcat.exe+0x4a6150`, or the bare address when no loaded module holds it.
pub fn place(address: usize) -> String {
    let mut module = HMODULE::default();
    let found = unsafe {
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            PCWSTR(address as *const u16),
            &mut module,
        )
    };
    if found.is_err() {
        return format!("0x{address:x} (in no loaded module)");
    }
    let mut buf = [0u16; 260];
    let len = unsafe { GetModuleFileNameW(Some(module), &mut buf) } as usize;
    let path = String::from_utf16_lossy(&buf[..len]);
    // The name only: the folder would name the user.
    let name = path.rsplit('\\').next().unwrap_or("?");
    format!("{name}+0x{:x}", address - module.0 as usize)
}

/// Writes a minidump to the logs folder (`crash-20261024-001203.dmp`), with the exception
/// when there is one; its file name.
pub fn dump(info: Option<*const EXCEPTION_POINTERS>) -> Result<String, String> {
    let dir = crate::log::dir().ok_or("no logs folder")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let t = unsafe { GetLocalTime() };
    let name = format!(
        "crash-{:04}{:02}{:02}-{:02}{:02}{:02}.dmp",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    );
    let file = File::create(dir.join(&name)).map_err(|e| e.to_string())?;
    let exception = info.map(|pointers| MINIDUMP_EXCEPTION_INFORMATION {
        ThreadId: unsafe { GetCurrentThreadId() },
        ExceptionPointers: pointers.cast_mut(),
        ClientPointers: false.into(),
    });
    // Small: stacks, registers, threads, the modules and those unloaded (a call into an
    // unloaded DLL is how the start-up crash looked). No heap: it's big and may hold the
    // user's data.
    let kind =
        MINIDUMP_TYPE(MiniDumpNormal.0 | MiniDumpWithThreadInfo.0 | MiniDumpWithUnloadedModules.0);
    unsafe {
        MiniDumpWriteDump(
            GetCurrentProcess(),
            GetCurrentProcessId(),
            HANDLE(file.as_raw_handle()),
            kind,
            exception.as_ref().map(|e| e as *const _),
            None,
            None,
        )
    }
    .map_err(|e| e.to_string())?;
    drop(file);
    blank_names(&dir.join(&name));
    Ok(name)
}

/// The log's private names (the user's, the computer's, the files') overwritten in the dump:
/// its module list holds the exe's path, under the user's profile.
fn blank_names(path: &Path) {
    let Ok(mut bytes) = fs::read(path) else {
        return;
    };
    let mut blanked = 0;
    for name in crate::log::private_names() {
        blanked += crate::scrub::blank(&mut bytes, &name);
    }
    if blanked > 0 {
        let _ = fs::write(path, bytes);
    }
}

/// Crashes on purpose, to check the reports end to end: `RAZORCAT_CRASH_TEST` set to
/// `native` (an access violation), `panic` (on the main thread), `thread-panic`, `webview`
/// (the editor's renderer) or `browser` (the whole webview), a few seconds after startup; or
/// `accent`, which asks for the Windows accent again and again (the start-up crash's hunt).
pub fn test_from_env(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Ok(kind) = std::env::var("RAZORCAT_CRASH_TEST") else {
        return;
    };
    logln!("[crash] test: {kind} in 3 s");
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        match kind.as_str() {
            "native" => unsafe {
                std::ptr::write_volatile(std::ptr::null_mut::<u32>().wrapping_add(4), 1);
            },
            // A hunt, not a crash: ask for the Windows accent as the page does, with gaps
            // either side of the blocking pool's 10 s idle time, so its threads come and go.
            "accent" => {
                for gap in [0.5, 3.0, 11.0, 0.2, 14.0, 1.0, 12.0]
                    .iter()
                    .cycle()
                    .take(40)
                {
                    let asked = tauri::async_runtime::block_on(
                        tauri::async_runtime::spawn_blocking(crate::appearance::windows_accent),
                    );
                    logln!(
                        "[crash] test: accent {:?}",
                        asked.ok().flatten().map(|a| a.light)
                    );
                    std::thread::sleep(std::time::Duration::from_secs_f64(*gap));
                }
            }
            "webview" | "browser" => {
                if let Some(window) = app.get_webview_window(crate::editor::LABEL) {
                    crate::webview_crash::crash_for_test(&window, kind == "browser");
                }
            }
            "panic" => {
                let _ = app.run_on_main_thread(|| panic!("crash test on the main thread"));
            }
            _ => panic!("crash test on a worker thread"),
        }
    });
}

/// Drops all but the newest few dumps.
pub fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut dumps: Vec<_> = entries
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with("crash-") && name.ends_with(".dmp")
        })
        .map(|e| e.path())
        .collect();
    // The names sort by time.
    dumps.sort();
    let extra = dumps.len().saturating_sub(KEEP_DUMPS);
    for old in dumps.into_iter().take(extra) {
        let _ = fs::remove_file(old);
    }
}
