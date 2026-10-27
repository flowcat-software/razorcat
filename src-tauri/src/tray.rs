//! Razorcat in the tray (PLAN 5b.8a; Vandal's tray.rs the model): an icon and its menu, so
//! recording is at hand with the editor closed. Closing the editor hides it (Settings › General
//! › "Keep running in the tray when the editor is closed"); the menu's Quit ends Razorcat.
//!
//! The menu is rebuilt as the settings change, so its check marks always match them.

use serde::Serialize;
use specta::Type;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;
use tauri_specta::Event;

use crate::settings::{self, Settings};
use crate::state::AppState;
use crate::{editor, settings_window};

const TRAY_ID: &str = "main";

/// The argument Windows starts Razorcat with (Launch on login): in the tray, the editor
/// hidden.
pub const STARTED_ARG: &str = "--tray";

/// Rust → the editor: the tray's Record (the editor's own Record, its questions and all).
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct RecordAsked;

/// Rust → the editor: it's closing for the first time, ever, and Razorcat stays in the tray:
/// the page says so, and the answer comes back (`closed_to_tray`).
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct ClosingToTray;

fn build_menu(app: &AppHandle, s: &Settings) -> tauri::Result<Menu<Wry>> {
    let none = None::<&str>;
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "record", "Record", true, none)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "editor",
        "Open editor",
        true,
        none,
    )?)?;
    menu.append(&MenuItem::with_id(app, "settings", "Settings", true, none)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "start-with-windows",
        "Launch on login",
        true,
        s.tray.start_with_windows,
        none,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit Razorcat",
        true,
        none,
    )?)?;
    Ok(menu)
}

/// The icon and its menu, as `s` has them.
pub fn create(app: &AppHandle, s: &Settings) -> tauri::Result<()> {
    TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(crate::product_name(app))
        .icon(tray_icon()?)
        .menu(&build_menu(app, s)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "record" => {
                editor::show_window(app);
                let _ = RecordAsked.emit_to(app, editor::LABEL);
            }
            "editor" => editor::show_window(app),
            "settings" => settings_window::open(app, None),
            "start-with-windows" => {
                let mut s = app.state::<AppState>().settings.read().unwrap().clone();
                s.tray.start_with_windows = !s.tray.start_with_windows;
                if let Err(e) = settings::update(app, s) {
                    logln!("[tray] launch on login: {e}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                editor::show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// The menu again, as `s` has it (its check marks).
pub fn refresh(app: &AppHandle, s: &Settings) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), build_menu(app, s)) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Razorcat starts with Windows, or doesn't. Never a dev build.
pub fn start_with_windows(app: &AppHandle, on: bool) {
    if cfg!(debug_assertions) {
        logln!("[tray] dev build: launch on login {on} (not applied)");
        return;
    }
    let launcher = app.autolaunch();
    let done = if on {
        launcher.enable()
    } else {
        launcher.disable()
    };
    if let Err(e) = done {
        logln!("[tray] launch on login {on}: {e}");
    }
}

/// The editor is closing (its window's close): hidden, Razorcat staying in the tray, unless
/// Settings says closing quits. The first time, ever, the page says so first. True if the close
/// is to go ahead (Razorcat quits).
pub fn editor_closing(app: &AppHandle, window: &tauri::Window) -> bool {
    let tray = app
        .state::<AppState>()
        .settings
        .read()
        .unwrap()
        .tray
        .clone();
    if !tray.keep_running {
        return true;
    }
    if tray.told {
        let _ = window.hide();
    } else {
        let _ = ClosingToTray.emit_to(app, editor::LABEL);
    }
    false
}

/// The first close's answer: Razorcat stays in the tray (`keep`), the editor hidden, or quits,
/// and closing does that from now on. Not said again either way.
pub fn closed_to_tray(app: &AppHandle, keep: bool) -> Result<(), String> {
    let mut s = app.state::<AppState>().settings.read().unwrap().clone();
    s.tray.told = true;
    s.tray.keep_running = keep;
    settings::update(app, s)?;
    if keep {
        if let Some(w) = app.get_webview_window(editor::LABEL) {
            let _ = w.hide();
        }
    } else {
        app.exit(0);
    }
    Ok(())
}

/// Tray art pre-scaled to each small-icon size Windows uses (16 px at 100% up to 48 px at
/// 300%), so the shell never shrinks it itself.
const TRAY_ICONS: [(i32, &[u8]); 7] = [
    (16, include_bytes!("../icons/tray/16.png")),
    (20, include_bytes!("../icons/tray/20.png")),
    (24, include_bytes!("../icons/tray/24.png")),
    (28, include_bytes!("../icons/tray/28.png")),
    (32, include_bytes!("../icons/tray/32.png")),
    (40, include_bytes!("../icons/tray/40.png")),
    (48, include_bytes!("../icons/tray/48.png")),
];

/// The tray art for the system DPI: the smallest at least the shell's small icon, or the
/// largest there is.
fn tray_icon() -> tauri::Result<tauri::image::Image<'static>> {
    use windows::Win32::UI::HiDpi::{GetDpiForSystem, GetSystemMetricsForDpi};
    use windows::Win32::UI::WindowsAndMessaging::SM_CXSMICON;

    let want = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, GetDpiForSystem()) };
    let (_, bytes) = TRAY_ICONS
        .iter()
        .find(|(size, _)| *size >= want)
        .unwrap_or(&TRAY_ICONS[TRAY_ICONS.len() - 1]);
    tauri::image::Image::from_bytes(bytes)
}
