//! A diagnostic: `RAZORCAT_TRACE_UNLOADS=1` logs every DLL unloaded, and every WinRT UI DLL
//! loaded, with the stack of the thread doing it (as module+offset, for the build's symbols).
//! The start-up crash was a call into `Windows.UI.dll` after something unloaded it; this says
//! what. Windows calls back under the loader lock, so this only captures the stack and writes
//! the log, nothing that could load a DLL.

use std::ffi::c_void;

use windows::core::{s, w};
use windows::Win32::System::Diagnostics::Debug::RtlCaptureStackBackTrace;
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

const LOADED: u32 = 1;
const UNLOADED: u32 = 2;

#[repr(C)]
struct UnicodeString {
    length: u16,
    capacity: u16,
    buffer: *const u16,
}

#[repr(C)]
struct Notification {
    flags: u32,
    full_name: *const UnicodeString,
    base_name: *const UnicodeString,
    base: *const c_void,
    size: u32,
}

type Callback = unsafe extern "system" fn(u32, *const Notification, *mut c_void);
type Register = unsafe extern "system" fn(u32, Callback, *mut c_void, *mut *mut c_void) -> i32;

/// Starts tracing if `RAZORCAT_TRACE_UNLOADS` is set.
pub fn trace_from_env() {
    if std::env::var_os("RAZORCAT_TRACE_UNLOADS").is_none() {
        return;
    }
    unsafe {
        let Ok(ntdll) = GetModuleHandleW(w!("ntdll.dll")) else {
            return;
        };
        let Some(register) = GetProcAddress(ntdll, s!("LdrRegisterDllNotification")) else {
            logln!("[unloads] no LdrRegisterDllNotification");
            return;
        };
        let register: Register = std::mem::transmute(register);
        let mut cookie = std::ptr::null_mut();
        let status = register(0, notified, std::ptr::null_mut(), &mut cookie);
        logln!("[unloads] tracing (status 0x{status:08x})");
    }
}

unsafe extern "system" fn notified(reason: u32, data: *const Notification, _: *mut c_void) {
    let Some(data) = (unsafe { data.as_ref() }) else {
        return;
    };
    let Some(name) = (unsafe { data.base_name.as_ref() }) else {
        return;
    };
    let name = String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(name.buffer, usize::from(name.length) / 2)
    });
    let ui = name.to_ascii_lowercase().starts_with("windows.ui");
    let what = match reason {
        UNLOADED => "unloaded",
        LOADED if ui => "loaded",
        _ => return,
    };
    let mut frames = [std::ptr::null_mut(); 48];
    let n = unsafe { RtlCaptureStackBackTrace(1, &mut frames, None) } as usize;
    let stack: Vec<String> = frames[..n]
        .iter()
        .map(|&f| format!("    {}", crate::crash::place(f as usize)))
        .collect();
    let thread = std::thread::current();
    logln!(
        "[unloads] {name} {what} at 0x{:x}, thread {:?} {}:\n{}",
        data.base as usize,
        thread.id(),
        thread.name().unwrap_or("unnamed"),
        stack.join("\n")
    );
}
