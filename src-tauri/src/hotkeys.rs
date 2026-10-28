//! Global shortcuts set in Settings (PLAN 5b.8b): the key to record, from anywhere. Vandal's
//! hotkeys.rs, for Razorcat's keys. The keys held while recording (recording.rs) are the
//! plugin's too: these only ever let go of their own.

use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::settings::Hotkeys;

/// Settings use the Windows spelling (`Win+Shift+F12`); the parser wants `Super`.
pub fn to_accelerator(hotkey: &str) -> String {
    hotkey
        .split('+')
        .map(|part| match part.trim() {
            p if p.eq_ignore_ascii_case("win") || p.eq_ignore_ascii_case("windows") => "Super",
            p => p,
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// The shortcuts registered here, as accelerators: let go of before they're registered again.
static OURS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn unregister_ours(app: &AppHandle) {
    let gs = app.global_shortcut();
    for key in OURS.lock().unwrap().drain(..) {
        let _ = gs.unregister(key.as_str());
    }
}

/// Let go of ours while Settings records a new one (Vandal's PLAN 3B).
pub fn pause(app: &AppHandle) {
    unregister_ours(app);
}

/// Ours again, as settings have them now.
pub fn resume(app: &AppHandle) {
    let keys = app
        .state::<crate::state::AppState>()
        .settings
        .read()
        .unwrap()
        .hotkeys
        .clone();
    register(app, &keys);
}

/// Whether `hotkey` can be ours: it parses and no other app (or Windows) holds it. Registers it
/// for a moment, so call it while ours are paused.
pub fn check(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::Shortcut;
    let shortcut: Shortcut = to_accelerator(hotkey)
        .parse()
        .map_err(|_| format!("{hotkey} can't be a shortcut. Pick another one."))?;
    let gs = app.global_shortcut();
    match gs.register(shortcut) {
        Ok(()) => {
            let _ = gs.unregister(shortcut);
            Ok(())
        }
        Err(e) => {
            logln!("[hotkeys] check {hotkey}: {e}");
            if hotkey.to_ascii_lowercase().contains("printscreen") && print_screen_opens_snipping()
            {
                Err(format!(
                    "Windows uses {hotkey} to open its own screen capture. \
                     Turn that off in Windows Settings, or pick another shortcut."
                ))
            } else {
                Err(format!(
                    "{hotkey} is already used by Windows or another app. Pick another one."
                ))
            }
        }
    }
}

/// Windows 11's "Use the Print Screen key to open screen capture" (on unless turned off;
/// Windows 10 leaves the value unset, and the key free).
pub fn print_screen_opens_snipping() -> bool {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Control Panel\\Keyboard"),
            w!("PrintScreenKeyForSnippingEnabled"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    if result.is_ok() {
        value != 0
    } else {
        windows_11()
    }
}

fn windows_11() -> bool {
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OSVERSIONINFOW) -> i32;
    }
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    unsafe { RtlGetVersion(&mut info) == 0 && info.dwBuildNumber >= 22000 }
}

/// (Re)registers ours as `keys` has them. One another app holds is logged: the tray's Record
/// still works.
pub fn register(app: &AppHandle, keys: &Hotkeys) {
    unregister_ours(app);
    let gs = app.global_shortcut();
    let Some(hotkey) = keys.record.as_deref().filter(|h| !h.trim().is_empty()) else {
        return;
    };
    let accelerator = to_accelerator(hotkey);
    let result = gs.on_shortcut(accelerator.as_str(), |app, _, event| {
        if event.state == ShortcutState::Pressed {
            crate::tray::record(app);
        }
    });
    match result {
        Ok(()) => {
            logln!("[hotkeys] {hotkey} → record");
            OURS.lock().unwrap().push(accelerator);
        }
        Err(e) => logln!("[hotkeys] {hotkey} not available: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win_becomes_super() {
        assert_eq!(to_accelerator("Win+F11"), "Super+F11");
        assert_eq!(to_accelerator("Ctrl+Win+F11"), "Ctrl+Super+F11");
        assert_eq!(to_accelerator("ctrl + WIN + s"), "ctrl+Super+s");
        assert_eq!(to_accelerator("Shift+PrintScreen"), "Shift+PrintScreen");
    }

    #[test]
    fn the_defaults_parse() {
        use tauri_plugin_global_shortcut::Shortcut;
        let d = Hotkeys::default();
        for key in [d.record, d.pause, d.stop, d.mute, d.system, d.clicks] {
            let key = key.unwrap();
            assert!(to_accelerator(&key).parse::<Shortcut>().is_ok(), "{key}");
        }
    }
}
