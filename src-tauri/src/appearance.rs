//! Light / dark and the accent color. Until the settings window exists (scaffold 0.1d) both
//! follow Windows: the native title bar does by default, the pages through theme.css, and the
//! accent through [`windows_accent`] and [`WindowsAccentChanged`].

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;
use windows::Foundation::TypedEventHandler;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::UI::ViewManagement::{UIColorType, UISettings};

/// The Windows accent color as Windows 11 apps use it: a darker shade on light backgrounds, a
/// lighter one on dark (WinUI's AccentDark1 and AccentLight2), as `#rrggbb`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowsAccent {
    pub light: String,
    pub dark: String,
}

/// Rust → pages: the Windows accent changed (None: not available).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct WindowsAccentChanged(pub Option<WindowsAccent>);

/// The current Windows accent, if Windows provides one.
pub fn windows_accent() -> Option<WindowsAccent> {
    // SAFETY: plain COM initialization; fine if the thread already has COM.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    accent_of(&UISettings::new().ok()?)
}

fn accent_of(ui: &UISettings) -> Option<WindowsAccent> {
    let hex = |t: UIColorType| {
        ui.GetColorValue(t)
            .ok()
            .map(|c| format!("#{:02x}{:02x}{:02x}", c.R, c.G, c.B))
    };
    Some(WindowsAccent {
        light: hex(UIColorType::AccentDark1)?,
        dark: hex(UIColorType::AccentLight2)?,
    })
}

/// Tell the pages whenever the Windows accent changes (Settings › Personalization › Colors),
/// for the app's lifetime.
pub fn watch_windows_accent(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // SAFETY: plain COM initialization for this thread.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let Ok(ui) = UISettings::new() else {
            eprintln!("[appearance] no UISettings: the Windows accent won't update live");
            return;
        };
        let last = std::sync::Mutex::new(accent_of(&ui));
        let handler = TypedEventHandler::new(move |sender: windows::core::Ref<UISettings>, _| {
            if let Some(ui) = sender.as_ref() {
                let now = accent_of(ui);
                // Also fires for light/dark switches: only report real changes.
                let mut last = last.lock().unwrap();
                if now != *last {
                    last.clone_from(&now);
                    let _ = WindowsAccentChanged(now).emit(&app);
                }
            }
            Ok(())
        });
        if let Err(e) = ui.ColorValuesChanged(&handler) {
            eprintln!("[appearance] can't watch the Windows accent: {e}");
            return;
        }
        // The subscription lives as long as `ui`: keep it for the app's lifetime.
        std::mem::forget(ui);
    });
}
