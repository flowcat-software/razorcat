//! What to record (PLAN 5b.3): a live, dimmed overlay over every monitor (picker.html, as
//! Vandal's overlays, but transparent: the screen goes on under it), where the user drags an area
//! or takes a whole screen, or with W picks a window (5b.3b). One selection over all of them:
//! starting one on a monitor clears the others'. Then the overlays go, and recording.rs records
//! what was picked.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::webview::Color;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow};
use tauri_specta::Event;

use crate::camera::Area;
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
    /// The first recording ever (PLAN 5b.7, asked here since 5b.8c): the folder to ask about,
    /// as the setting holds it (the default if empty), before it starts. None once asked.
    pub ask_folder: Option<String>,
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
    /// Which opening this is ([`OPENED`]).
    id: u64,
    /// The editor was showing (not hidden in the tray, nor minimized): Esc brings it back.
    editor_shown: bool,
    screens: Vec<Screen>,
    windows: Vec<SnapWindow>,
}

static PICKING: Mutex<Option<Picking>> = Mutex::new(None);

/// Openings so far: each picking's id.
static OPENED: AtomicU64 = AtomicU64::new(0);
/// The newest opening an overlay's page has loaded for: its webview is up and the main thread
/// answers.
static LOADED: AtomicU64 = AtomicU64::new(0);
/// How long an opening has for an overlay to load before it's taken as stuck. Overlays load in
/// well under a second; a release copy left running for two days once never showed them, with
/// the editor minimized and the app frozen.
const STUCK_AFTER: Duration = Duration::from_secs(8);
/// `RAZORCAT_CRASH_TEST=picker-hang`: the next opening blocks the main thread for a while.
pub static HANG_FOR_TEST: AtomicBool = AtomicBool::new(false);

pub fn label(index: usize) -> String {
    format!("{PREFIX}{index}")
}

/// Puts the editor aside, if it's showing, and the overlays up, one per monitor (from the editor,
/// the tray or the key: PLAN 5b.8c).
pub fn open(app: &AppHandle) -> Result<(), String> {
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
    let windows: Vec<SnapWindow> = winenum::enumerate(&bounds)
        .into_iter()
        .filter(|w| Some(w.hwnd) != mine)
        .collect();
    // Hidden in the tray, it stays hidden (minimizing would show it in the taskbar).
    let editor_shown = editor
        .as_ref()
        .is_some_and(|e| e.is_visible().unwrap_or(false) && !e.is_minimized().unwrap_or(false));
    let id = OPENED.fetch_add(1, Ordering::SeqCst) + 1;
    logln!(
        "[picker] opening {id}: {} monitors, {} windows, the editor {}",
        screens.len(),
        windows.len(),
        if editor_shown { "shown" } else { "aside" }
    );
    *PICKING.lock().unwrap() = Some(Picking {
        id,
        editor_shown,
        screens: screens.clone(),
        windows,
    });
    crate::camera::unfollow();
    if let Some(editor) = editor.filter(|_| editor_shown) {
        let _ = editor.minimize();
    }
    watch(app, id);
    // Creating webviews from a command can deadlock on Windows: elsewhere.
    let app = app.clone();
    std::thread::spawn(move || {
        if HANG_FOR_TEST.swap(false, Ordering::SeqCst) {
            logln!("[picker] test: the main thread blocked for 20 s");
            let _ = app.run_on_main_thread(|| std::thread::sleep(Duration::from_secs(20)));
        }
        let cursor = cursor();
        let mut focus = None;
        for (i, s) in screens.iter().enumerate() {
            match create(&app, i, s) {
                Ok(w) => {
                    logln!("[picker] overlay {i} shown");
                    if cursor.is_some_and(|(x, y)| s.contains(x, y)) {
                        focus = Some(w);
                    }
                }
                Err(e) => logln!("[picker] overlay {i} failed: {e}"),
            }
        }
        // Given up on while they were made (the watchdog): none are left behind.
        if !is_current(id) {
            logln!("[picker] opening {id} given up: its overlays closed");
            close(&app);
            return;
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

/// Whether opening `id` is the picking under way.
fn is_current(id: u64) -> bool {
    PICKING.lock().unwrap().as_ref().is_some_and(|p| p.id == id)
}

/// If no overlay of opening `id` has loaded in [`STUCK_AFTER`], it's stuck: a dump of where
/// every thread is (`hang-*.dmp`, the cause unknown when this was written), then the picking is
/// given up and the editor brought back. If the main thread is what's stuck, the dump is still
/// written; bringing the editor back waits for it.
fn watch(app: &AppHandle, id: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(STUCK_AFTER);
        if LOADED.load(Ordering::SeqCst) >= id || !is_current(id) {
            return;
        }
        logln!(
            "[picker] opening {id} stuck: no overlay loaded in {} s",
            STUCK_AFTER.as_secs()
        );
        match crate::crash::dump("hang", None) {
            Ok(name) => logln!("[picker] dump written: {name}"),
            Err(e) => logln!("[picker] no dump: {e}"),
        }
        let taken = {
            let mut picking = PICKING.lock().unwrap();
            match picking.as_ref() {
                Some(p) if p.id == id => picking.take(),
                _ => None,
            }
        };
        if let Some(p) = taken {
            close(&app);
            if p.editor_shown {
                crate::recording::show_editor(&app);
            }
            logln!("[picker] opening {id} given up");
        }
    });
}

fn create(app: &AppHandle, index: usize, s: &Screen) -> tauri::Result<WebviewWindow> {
    let builder =
        tauri::WebviewWindowBuilder::new(app, label(index), WebviewUrl::App("picker.html".into()));
    let made = crate::recording::made_at(s.x, s.y, s.width, s.height, s.scale);
    let window = builder
        .title("Record")
        .position(made.0, made.1)
        .inner_size(crate::recording::MADE_SIZE, crate::recording::MADE_SIZE)
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
    // There before it's shown (Tauri's moves land later, and it showed where it was made).
    crate::recording::place(&window, s.x, s.y, s.width, s.height);
    window.show()?;
    Ok(window)
}

/// No show or hide animation (Vandal's): a window the size of a monitor zooming in makes the
/// whole screen jump. The recording's windows too (recording.rs).
pub fn no_transitions(window: &WebviewWindow) {
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
    let ask_folder = (!sound.asked_folder).then(|| {
        if sound.folder.is_empty() {
            crate::recording::default_folder(app)
                .map(|p| crate::paths::for_settings(&p.to_string_lossy()))
                .unwrap_or_default()
        } else {
            sound.folder.clone()
        }
    });
    let guard = PICKING.lock().unwrap();
    let p = guard.as_ref()?;
    let s = p.screens.get(index as usize)?;
    if LOADED.swap(p.id, Ordering::SeqCst) != p.id {
        logln!("[picker] opening {} loaded", p.id);
    }
    Some(PickLoad {
        x: s.x,
        y: s.y,
        windows: p.windows.iter().map(|w| w.rect).collect(),
        microphone: sound.microphone,
        system_sound: sound.system_sound,
        clicks: sound.clicks,
        camera: sound.camera,
        ask_folder,
    })
}

/// Window mode on or off, and the window under the pointer, from one overlay: all follow.
pub fn window_changed(app: &AppHandle, picking: bool, hovered: Option<u32>) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(PREFIX) {
            let _ = PickWindow { picking, hovered }.emit_to(app, window.label());
        }
    }
    // The bubble to the lit window's corner; out of window mode, its monitor's.
    let area = {
        let guard = PICKING.lock().unwrap();
        let Some(p) = guard.as_ref() else {
            return;
        };
        match (picking, hovered) {
            (true, Some(w)) => p.windows.get(w as usize).and_then(|w| window_area(p, w)),
            (true, None) => None,
            (false, _) => {
                let at = cursor();
                p.screens
                    .iter()
                    .find(|s| at.is_some_and(|(x, y)| s.contains(x, y)))
                    .map(Area::of)
            }
        }
    };
    if let Some(area) = area {
        crate::camera::follow(app, WINDOWS, area, false);
    }
}

/// Overlay `index`'s selection is now `rect`, or none (the whole monitor): the camera's bubble
/// follows it to its bottom-right corner, until it's dragged.
pub fn selected(app: &AppHandle, index: u32, rect: Option<PickRect>) {
    let Some(screen) = PICKING
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|p| p.screens.get(index as usize).cloned())
    else {
        return;
    };
    let area = match rect {
        Some(r) => Area::on(&screen, r.x as i32, r.y as i32, r.width, r.height),
        None => Area::of(&screen),
    };
    crate::camera::follow(app, index, area, rect.is_none());
}

/// The bubble follows windows as one more overlay would, past the monitors' indexes.
const WINDOWS: u32 = u32::MAX;

/// Window `window`'s area, on the monitor that has its middle.
fn window_area(p: &Picking, window: &SnapWindow) -> Option<Area> {
    let r = window.rect;
    let (cx, cy) = (r.x + r.width / 2, r.y + r.height / 2);
    let screen = p
        .screens
        .iter()
        .find(|s| s.contains(cx, cy))
        .or(p.screens.first())?;
    Some(Area {
        x: r.x,
        y: r.y,
        width: r.width.max(0) as u32,
        height: r.height.max(0) as u32,
        scale: screen.scale,
    })
}

/// The overlay that last had the keys.
static FOCUSED: Mutex<Option<String>> = Mutex::new(None);

/// Overlay `label` has the keys.
pub fn focused(label: &str) {
    *FOCUSED.lock().unwrap() = Some(label.to_string());
}

/// While picking, the keys back to the overlay that last had them: clicking the camera's bubble
/// takes them (its webview takes the focus, though the window won't).
pub fn refocus(app: &AppHandle) {
    if PICKING.lock().unwrap().is_none() {
        return;
    }
    let label = FOCUSED.lock().unwrap().clone();
    if let Some(w) = label.and_then(|l| app.get_webview_window(&l)) {
        let _ = w.set_focus();
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
    let screen = p
        .screens
        .get(index as usize)
        .cloned()
        .ok_or("That monitor has gone.")?;
    // The camera's bubble stays, in what's recorded's corner: the recording has the camera.
    let area = match rect {
        Some(r) => Area::on(&screen, r.x as i32, r.y as i32, r.width, r.height),
        None => Area::of(&screen),
    };
    crate::camera::follow(app, index, area, false);
    crate::camera::hold(app);
    close(app);
    let target = Target::of(screen, rect.map(|r| (r.x, r.y, r.width, r.height)));
    crate::recording::start(app, target)
}

/// Esc, or a right-click: no recording; the editor comes back if it was showing.
pub fn cancel(app: &AppHandle) {
    if let Some(p) = PICKING.lock().unwrap().take() {
        close(app);
        if p.editor_shown {
            crate::recording::show_editor(app);
        }
    }
}

/// Window `index` (of [`PickLoad::windows`]) is picked: the overlays go, it's made active, and
/// it's recorded, the control on the monitor that has its middle.
pub fn picked_window(app: &AppHandle, index: u32) -> Result<(), String> {
    let Some(p) = PICKING.lock().unwrap().take() else {
        return Ok(());
    };
    let window = *p
        .windows
        .get(index as usize)
        .ok_or("That window has gone.")?;
    // The camera's bubble stays, in the window's corner: the recording has the camera.
    if let Some(area) = window_area(&p, &window) {
        crate::camera::follow(app, WINDOWS, area, false);
    }
    crate::camera::hold(app);
    close(app);
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
    crate::recording::start(app, target)
}
