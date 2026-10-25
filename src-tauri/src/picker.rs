//! What to record (PLAN 5b.3): a live, dimmed overlay over every monitor (picker.html, as
//! Vandal's overlays, but transparent: the screen goes on under it), where the user drags an area
//! or takes a whole screen. One selection over all of them: starting one on a monitor clears the
//! others'. Then the overlays go, and recording.rs records what was picked.

use std::ffi::c_void;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::webview::Color;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow};
use tauri_specta::Event;

use crate::editor::LABEL;
use crate::recording::{Screen, Target};
use std::sync::Mutex;

const PREFIX: &str = "pick-";

/// Rust → overlays: a selection started on monitor `except`; the others drop theirs.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct PickClear {
    pub except: u32,
}

/// An area of a monitor, in its own physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
pub struct PickRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

struct Picking {
    add: bool,
    screens: Vec<Screen>,
}

static PICKING: Mutex<Option<Picking>> = Mutex::new(None);

pub fn label(index: usize) -> String {
    format!("{PREFIX}{index}")
}

/// Puts the editor aside and the overlays up, one per monitor; `add` goes on to the recording.
pub fn open(app: &AppHandle, add: bool) -> Result<(), String> {
    if crate::recording::busy() || PICKING.lock().unwrap().is_some() {
        return Err("A recording is under way.".into());
    }
    let screens = crate::recording::screens(app)?;
    *PICKING.lock().unwrap() = Some(Picking {
        add,
        screens: screens.clone(),
    });
    if let Some(editor) = app.get_webview_window(LABEL) {
        let _ = editor.minimize();
    }
    // Creating webviews from a command can deadlock on Windows: elsewhere.
    let app = app.clone();
    std::thread::spawn(move || {
        let cursor = cursor();
        let mut focus = None;
        for (i, s) in screens.iter().enumerate() {
            match create(&app, i, s) {
                Ok(w) => {
                    if cursor.is_some_and(|(x, y)| s.contains(x, y)) {
                        focus = Some(w);
                    }
                }
                Err(e) => logln!("[picker] overlay {i} failed: {e}"),
            }
        }
        // The one under the pointer has the keys.
        if let Some(w) = focus {
            let _ = w.set_focus();
        }
    });
    Ok(())
}

fn create(app: &AppHandle, index: usize, s: &Screen) -> tauri::Result<WebviewWindow> {
    let builder =
        tauri::WebviewWindowBuilder::new(app, label(index), WebviewUrl::App("picker.html".into()));
    let window = builder
        .title("Record")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        .visible(false)
        .focused(false)
        .build()?;
    no_transitions(&window);
    // Position first, then size: moving onto a monitor of another scale rescales the window.
    window.set_position(PhysicalPosition::new(s.x, s.y))?;
    window.set_size(PhysicalSize::new(s.width, s.height))?;
    window.show()?;
    Ok(window)
}

/// No show or hide animation (Vandal's): a window the size of a monitor zooming in makes the
/// whole screen jump.
fn no_transitions(window: &WebviewWindow) {
    use windows::core::BOOL;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let disabled = BOOL::from(true);
    // SAFETY: a valid window handle and a BOOL-sized value.
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            &disabled as *const BOOL as *const c_void,
            size_of::<BOOL>() as u32,
        )
    };
}

fn cursor() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x, p.y))
}

fn close(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(PREFIX) {
            let _ = window.destroy();
        }
    }
}

/// A selection started on overlay `index`: the others drop theirs.
pub fn started(app: &AppHandle, index: u32) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(PREFIX) {
            let _ = PickClear { except: index }.emit_to(app, window.label());
        }
    }
}

/// Monitor `index`'s area `rect` (or all of it) is picked: the overlays go, and it's recorded.
pub fn picked(app: &AppHandle, index: u32, rect: Option<PickRect>) -> Result<(), String> {
    let Some(p) = PICKING.lock().unwrap().take() else {
        return Ok(());
    };
    close(app);
    let screen = p
        .screens
        .get(index as usize)
        .cloned()
        .ok_or("That monitor has gone.")?;
    let target = Target::of(screen, rect.map(|r| (r.x, r.y, r.width, r.height)));
    crate::recording::start(app, p.add, target)
}

/// Esc, or a right-click: no recording; the editor comes back.
pub fn cancel(app: &AppHandle) {
    if PICKING.lock().unwrap().take().is_some() {
        close(app);
        crate::recording::show_editor(app);
    }
}
