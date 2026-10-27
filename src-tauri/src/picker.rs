//! What to record (PLAN 5b.3): a live, dimmed overlay over every monitor (picker.html, as
//! Vandal's overlays, but transparent: the screen goes on under it), where the user drags an area
//! or takes a whole screen, or with W picks a window (5b.3b). One selection over all of them:
//! starting one on a monitor clears the others'. Then the overlays go, and recording.rs records
//! what was picked.

use std::ffi::c_void;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::webview::Color;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow};
use tauri_specta::Event;

use crate::editor::LABEL;
use crate::recording::{Screen, Target};
use crate::winenum::{self, SnapWindow, WinRect};
use std::sync::Mutex;

const PREFIX: &str = "pick-";

/// Rust → overlays: a selection started on monitor `except`; the others drop theirs.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct PickClear {
    pub except: u32,
}

/// Rust → overlays: window mode is on or off, and which window (an index into
/// [`PickLoad::windows`]) is under the pointer, so a window across monitors is lit on each.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct PickWindow {
    pub picking: bool,
    pub hovered: Option<u32>,
}

/// What an overlay needs: where its monitor is, and the windows that can be picked (topmost
/// first), in virtual-desktop physical pixels.
#[derive(Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PickLoad {
    pub x: i32,
    pub y: i32,
    pub windows: Vec<WinRect>,
    /// The microphone and the system's sound are recorded (Settings › Recording; the bar's
    /// toggles).
    pub microphone: bool,
    pub system_sound: bool,
    /// Clicks are highlighted (Settings › Recording; the bar's toggle and the control's).
    pub clicks: bool,
    /// The camera is recorded (Settings › Recording; the bar's toggle), its bubble shown.
    pub camera: bool,
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
    windows: Vec<SnapWindow>,
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
    let bounds: Vec<WinRect> = screens
        .iter()
        .map(|s| WinRect {
            x: s.x,
            y: s.y,
            width: s.width as i32,
            height: s.height as i32,
        })
        .collect();
    // Not the editor: it may not be minimized yet.
    let editor = app.get_webview_window(LABEL);
    let mine = editor
        .as_ref()
        .and_then(|e| e.hwnd().ok())
        .map(|h| h.0 as isize);
    let windows = winenum::enumerate(&bounds)
        .into_iter()
        .filter(|w| Some(w.hwnd) != mine)
        .collect();
    *PICKING.lock().unwrap() = Some(Picking {
        add,
        screens: screens.clone(),
        windows,
    });
    if let Some(editor) = editor {
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
        // The camera's bubble, over them.
        crate::camera::sync(&app);
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
    crate::camera::sync(app);
}

/// While picking, the monitor the pointer is on (or the first); None otherwise.
pub fn screen_under_pointer() -> Option<Screen> {
    let guard = PICKING.lock().unwrap();
    let screens = &guard.as_ref()?.screens;
    let at = cursor();
    screens
        .iter()
        .find(|s| at.is_some_and(|(x, y)| s.contains(x, y)))
        .or(screens.first())
        .cloned()
}

/// Overlay `index`'s monitor and the windows; None once picking is over.
pub fn load(app: &AppHandle, index: u32) -> Option<PickLoad> {
    let sound = app
        .state::<crate::state::AppState>()
        .settings
        .read()
        .unwrap()
        .recording
        .clone();
    let guard = PICKING.lock().unwrap();
    let p = guard.as_ref()?;
    let s = p.screens.get(index as usize)?;
    Some(PickLoad {
        x: s.x,
        y: s.y,
        windows: p.windows.iter().map(|w| w.rect).collect(),
        microphone: sound.microphone,
        system_sound: sound.system_sound,
        clicks: sound.clicks,
        camera: sound.camera,
    })
}

/// Window mode on or off, and the window under the pointer, from one overlay: all follow.
pub fn window_changed(app: &AppHandle, picking: bool, hovered: Option<u32>) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(PREFIX) {
            let _ = PickWindow { picking, hovered }.emit_to(app, window.label());
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
    // The camera's bubble stays: the recording has the camera.
    crate::camera::hold(app);
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

/// Window `index` (of [`PickLoad::windows`]) is picked: the overlays go, it's made active, and
/// it's recorded, the control on the monitor that has its middle.
pub fn picked_window(app: &AppHandle, index: u32) -> Result<(), String> {
    let Some(p) = PICKING.lock().unwrap().take() else {
        return Ok(());
    };
    // The camera's bubble stays: the recording has the camera.
    crate::camera::hold(app);
    close(app);
    let window = *p
        .windows
        .get(index as usize)
        .ok_or("That window has gone.")?;
    let r = window.rect;
    let (cx, cy) = (r.x + r.width / 2, r.y + r.height / 2);
    let screen = p
        .screens
        .iter()
        .find(|s| s.contains(cx, cy))
        .or(p.screens.first())
        .cloned()
        .ok_or("No monitor found.")?;
    if !winenum::activate(window.hwnd) {
        logln!("[picker] couldn't make the window active");
    }
    let target = Target::window(
        screen,
        window.hwnd as u64,
        (r.x, r.y, r.width.max(0) as u32, r.height.max(0) as u32),
    );
    crate::recording::start(app, p.add, target)
}
