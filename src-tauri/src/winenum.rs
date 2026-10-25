//! The top-level windows on screen when the overlays open, for picking a window to record (PLAN
//! 5b.3b; Vandal's). Read-only and well under a millisecond.

use std::mem::size_of;

use serde::Serialize;
use specta::Type;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowLongW, GetWindowRect, IsIconic, IsWindowVisible,
    SetForegroundWindow, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

/// Smaller than this (physical px, either side) isn't worth picking: hidden helper windows are
/// often 16×16 or less.
const MIN_SIDE: i32 = 32;

/// Shell windows that aren't "a window" to the user: the taskbars and the desktop.
const SHELL_CLASSES: &[&str] = &[
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "Progman",
    "WorkerW",
];

/// A window's visible frame (no invisible resize borders), virtual-desktop physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub struct WinRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl WinRect {
    fn overlaps(&self, o: &WinRect) -> bool {
        self.x < o.x + o.width
            && o.x < self.x + self.width
            && self.y < o.y + o.height
            && o.y < self.y + self.height
    }
}

/// A window that can be picked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapWindow {
    pub hwnd: isize,
    pub rect: WinRect,
}

/// What enumeration learns about one window, before filtering.
#[derive(Debug, Clone)]
struct Candidate {
    class: String,
    ex_style: u32,
    cloaked: bool,
    rect: WinRect,
}

/// Whether `c` is a window the user would mean to pick, on one of `screens`. Visibility and
/// minimized state are checked before a candidate is built.
fn pickable(c: &Candidate, screens: &[WinRect]) -> bool {
    let tool = c.ex_style & WS_EX_TOOLWINDOW.0 != 0 && c.ex_style & WS_EX_APPWINDOW.0 == 0;
    // Click-through windows (game overlays, screen tints) would cover what's below.
    let click_through = c.ex_style & WS_EX_TRANSPARENT.0 != 0;
    !c.cloaked
        && !tool
        && !click_through
        && c.rect.width >= MIN_SIDE
        && c.rect.height >= MIN_SIDE
        && screens.iter().any(|s| c.rect.overlaps(s))
        && !SHELL_CLASSES.contains(&c.class.as_str())
}

/// Pickable windows in z-order, topmost first.
pub fn enumerate(screens: &[WinRect]) -> Vec<SnapWindow> {
    let mut hwnds: Vec<HWND> = Vec::new();
    unsafe {
        // Only fails if the callback does, and ours never stops early.
        let _ = EnumWindows(Some(collect), LPARAM(&mut hwnds as *mut Vec<HWND> as isize));
    }
    hwnds
        .into_iter()
        .filter_map(|hwnd| {
            let c = candidate(hwnd)?;
            pickable(&c, screens).then_some(SnapWindow {
                hwnd: hwnd.0 as isize,
                rect: c.rect,
            })
        })
        .collect()
}

/// Makes `hwnd` the active window, so it's recorded active rather than greyed out (and a window
/// that's still gives its first frame). False if Windows refused.
pub fn activate(hwnd: isize) -> bool {
    unsafe { SetForegroundWindow(HWND(hwnd as *mut _)).as_bool() }
}

unsafe extern "system" fn collect(hwnd: HWND, out: LPARAM) -> BOOL {
    let hwnds = &mut *(out.0 as *mut Vec<HWND>);
    if IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() {
        hwnds.push(hwnd);
    }
    true.into()
}

fn candidate(hwnd: HWND) -> Option<Candidate> {
    unsafe {
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as _,
            size_of::<u32>() as u32,
        );
        // The frame as drawn; falls back to the window rect (which includes invisible resize
        // borders) if DWM doesn't know the window.
        let mut r = RECT::default();
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as _,
            size_of::<RECT>() as u32,
        )
        .is_err()
        {
            GetWindowRect(hwnd, &mut r).ok()?;
        }
        let mut class = [0u16; 64];
        let len = GetClassNameW(hwnd, &mut class).max(0) as usize;
        Some(Candidate {
            class: String::from_utf16_lossy(&class[..len]),
            ex_style: GetWindowLongW(hwnd, GWL_EXSTYLE) as u32,
            cloaked: cloaked != 0,
            rect: WinRect {
                x: r.left,
                y: r.top,
                width: r.right - r.left,
                height: r.bottom - r.top,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREENS: &[WinRect] = &[
        WinRect {
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
        },
        WinRect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        },
    ];

    fn rect(x: i32, y: i32, width: i32, height: i32) -> WinRect {
        WinRect {
            x,
            y,
            width,
            height,
        }
    }

    fn app(rect: WinRect) -> Candidate {
        Candidate {
            class: "Chrome_WidgetWin_1".into(),
            ex_style: 0,
            cloaked: false,
            rect,
        }
    }

    #[test]
    fn keeps_an_ordinary_window() {
        assert!(pickable(&app(rect(100, 100, 800, 600)), SCREENS));
        // On a monitor left of the primary.
        assert!(pickable(&app(rect(-1800, 50, 800, 600)), SCREENS));
    }

    #[test]
    fn drops_shell_windows() {
        for class in SHELL_CLASSES {
            let c = Candidate {
                class: (*class).into(),
                ..app(rect(0, 1392, 2560, 48))
            };
            assert!(!pickable(&c, SCREENS), "{class}");
        }
    }

    #[test]
    fn drops_cloaked_tiny_and_offscreen() {
        let r = rect(100, 100, 800, 600);
        assert!(!pickable(
            &Candidate {
                cloaked: true,
                ..app(r)
            },
            SCREENS
        ));
        assert!(!pickable(&app(rect(0, 0, 16, 16)), SCREENS));
        assert!(!pickable(&app(rect(0, 0, 800, 20)), SCREENS));
        assert!(!pickable(&app(rect(-32000, -32000, 800, 600)), SCREENS));
        // In the gap below the shorter monitor.
        assert!(!pickable(&app(rect(-1800, 1100, 800, 300)), SCREENS));
    }

    #[test]
    fn tool_windows_only_with_appwindow() {
        let r = rect(100, 100, 400, 300);
        let tool = Candidate {
            ex_style: WS_EX_TOOLWINDOW.0,
            ..app(r)
        };
        assert!(!pickable(&tool, SCREENS));
        let shown = Candidate {
            ex_style: WS_EX_TOOLWINDOW.0 | WS_EX_APPWINDOW.0,
            ..app(r)
        };
        assert!(pickable(&shown, SCREENS));
    }

    #[test]
    fn drops_click_through_windows() {
        let c = Candidate {
            ex_style: WS_EX_TRANSPARENT.0,
            ..app(rect(0, 0, 2560, 1440))
        };
        assert!(!pickable(&c, SCREENS));
    }
}
