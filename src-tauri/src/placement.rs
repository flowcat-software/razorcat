//! The editor window comes back where it was, as Vandal's editor does: its normal position and
//! size, and whether it was maximized. Kept up to date as it moves, saved when it closes, and
//! only used if it still lands on a screen (a monitor may be gone or rearranged).

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, PhysicalPosition, PhysicalSize, WebviewWindow, Window};
use tauri_plugin_store::StoreExt;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsZoomed, ShowWindow, SW_SHOWMAXIMIZED};

const STATE_FILE: &str = "window-state.json";
const STATE_KEY: &str = "editor";

/// Where the window is when neither maximized nor minimized: its outer position in physical
/// px, and its inner size in logical px (as Tauri sizes a new window).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub width: f64,
    pub height: f64,
}

/// What's saved between runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Saved {
    pub normal: Option<Placement>,
    pub maximized: bool,
}

/// A monitor's work area (the screen minus the taskbar) in physical px, and its scale.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub scale: f64,
}

/// Where to put the remembered window, in physical px (outer position, inner size), if the
/// middle of its title bar is still on a work area; its size is limited by that area.
pub fn restore(areas: &[Area], p: Placement) -> Option<(i32, i32, u32, u32)> {
    if !(p.width.is_finite() && p.height.is_finite() && p.width > 0.0 && p.height > 0.0) {
        return None;
    }
    areas.iter().find_map(|a| {
        let scale = if a.scale.is_finite() && a.scale > 0.0 {
            a.scale
        } else {
            1.0
        };
        let width = ((p.width * scale).round() as i32).min(a.width);
        let height = ((p.height * scale).round() as i32).min(a.height);
        // Below the invisible resize border.
        let (tx, ty) = (
            p.x.saturating_add(width / 2),
            p.y.saturating_add((16.0 * scale) as i32),
        );
        let on = tx >= a.x && tx < a.x + a.width && ty >= a.y && ty < a.y + a.height;
        on.then_some((p.x, p.y, width.max(1) as u32, height.max(1) as u32))
    })
}

pub fn load(app: &AppHandle) -> Saved {
    app.store(STATE_FILE)
        .ok()
        .and_then(|s| s.get(STATE_KEY))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, saved: Saved) {
    let Ok(store) = app.store(STATE_FILE) else {
        return;
    };
    store.set(STATE_KEY, json!(saved));
    if let Err(e) = store.save() {
        logln!("[placement] cannot save: {e}");
    }
}

/// The window's normal placement now, unless it's maximized or minimized (then the last one
/// stands).
pub fn current(window: &Window) -> Option<Placement> {
    // Ask Windows, not Tauri: while a window maximizes, its move arrives before Tauri's
    // `is_maximized` says so (as Vandal found).
    let hwnd = HWND(window.hwnd().ok()?.0);
    if unsafe { IsZoomed(hwnd).as_bool() || IsIconic(hwnd).as_bool() } {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let pos = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(Placement {
        x: pos.x,
        y: pos.y,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
    })
}

/// Is the window maximized? (Windows' answer; see [`current`].)
pub fn is_maximized(window: &Window) -> bool {
    window
        .hwnd()
        .is_ok_and(|h| unsafe { IsZoomed(HWND(h.0)).as_bool() })
}

/// Show a hidden window maximized in one step (Tauri's `maximize` leaves a hidden one hidden,
/// and showing it first would flash it at its normal size).
pub fn show_maximized(window: &WebviewWindow) -> tauri::Result<()> {
    let hwnd = HWND(window.hwnd()?.0);
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWMAXIMIZED);
    }
    Ok(())
}

/// The work areas of the monitors Tauri sees.
pub fn areas(app: &AppHandle) -> Vec<Area> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let w = m.work_area();
            Area {
                x: w.position.x,
                y: w.position.y,
                width: w.size.width as i32,
                height: w.size.height as i32,
                scale: m.scale_factor(),
            }
        })
        .collect()
}

/// Put a just-built (hidden) window where `saved` says, if that's still on a screen.
pub fn apply(app: &AppHandle, window: &tauri::WebviewWindow, saved: Saved) {
    let Some((x, y, w, h)) = saved.normal.and_then(|p| restore(&areas(app), p)) else {
        return;
    };
    let _ = window.set_size(PhysicalSize::new(w, h));
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE: Area = Area {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
        scale: 1.0,
    };
    /// A 150% monitor to the left of the primary.
    const LEFT: Area = Area {
        x: -2560,
        y: 0,
        width: 2560,
        height: 1400,
        scale: 1.5,
    };

    fn at(x: i32, y: i32, width: f64, height: f64) -> Placement {
        Placement {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn a_placement_on_screen_is_kept() {
        assert_eq!(
            restore(&[ONE], at(100, 50, 1280.0, 800.0)),
            Some((100, 50, 1280, 800))
        );
    }

    #[test]
    fn the_size_scales_with_the_monitor_it_lands_on() {
        assert_eq!(
            restore(&[ONE, LEFT], at(-2400, 40, 1280.0, 800.0)),
            Some((-2400, 40, 1920, 1200))
        );
    }

    #[test]
    fn a_placement_off_every_screen_is_dropped() {
        // Its monitor was unplugged.
        assert_eq!(restore(&[ONE], at(-2400, 40, 1280.0, 800.0)), None);
        // Its title bar is above the top.
        assert_eq!(restore(&[ONE], at(100, -200, 1280.0, 800.0)), None);
    }

    #[test]
    fn a_remembered_size_is_limited_to_the_work_area() {
        assert_eq!(
            restore(&[ONE], at(0, 0, 3000.0, 2000.0)),
            Some((0, 0, 1920, 1040))
        );
    }

    #[test]
    fn nonsense_sizes_are_ignored() {
        assert_eq!(restore(&[ONE], at(0, 0, f64::NAN, 800.0)), None);
        assert_eq!(restore(&[ONE], at(0, 0, 0.0, 800.0)), None);
    }

    #[test]
    fn saved_state_round_trips_and_tolerates_old_files() {
        let s = Saved {
            normal: Some(at(10, 20, 1000.0, 700.0)),
            maximized: true,
        };
        let back: Saved = serde_json::from_value(json!(s)).unwrap();
        assert_eq!(back, s);
        let empty: Saved = serde_json::from_value(json!({})).unwrap();
        assert_eq!(empty, Saved::default());
    }
}
