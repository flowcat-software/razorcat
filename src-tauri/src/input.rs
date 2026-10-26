//! Clicks noted while recording (PLAN 5b.6a), to become markup on the timeline. Windows'
//! low-level mouse hook, on a thread of its own, sees every click anywhere; each is stamped on the
//! recording's clock (audio.rs), and kept only in memory. (Keys are shelved, on the keys-markup
//! branch: not every key pressed reaches an app, PLAN 5b.6c.)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde::Serialize;
use specta::Type;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentThread, GetCurrentThreadId, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, MSG,
    MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// A press, as noted: when (the performance counter, 100 ns), and where on the screen (virtual
/// desktop px), with the window recorded's frame then, if it's a window.
#[derive(Debug, Clone, PartialEq)]
pub enum Press {
    Click {
        qpc: i64,
        x: i32,
        y: i32,
        button: Button,
        double: bool,
        window: Option<(i32, i32, i32, i32)>,
    },
}

/// What the hook keeps, and whether it's to.
struct Sink {
    clicks: Arc<AtomicBool>,
    /// The window recorded, if it's one: its frame is noted with each click.
    window: Option<isize>,
    presses: Vec<Press>,
    /// When the last click was (100 ns): a run of quick clicks joins the first.
    last: i64,
}

static SINK: Mutex<Option<Sink>> = Mutex::new(None);

/// Noting clicks, until stopped.
pub struct Watch {
    thread: u32,
    handle: JoinHandle<()>,
    clicks: Arc<AtomicBool>,
}

impl Watch {
    /// Starts watching: noting clicks if `clicks`; `window` is the window recorded.
    pub fn start(clicks: bool, window: Option<isize>) -> Result<Watch, String> {
        let clicks = Arc::new(AtomicBool::new(clicks));
        *SINK.lock().unwrap() = Some(Sink {
            clicks: clicks.clone(),
            window,
            presses: Vec::new(),
            last: 0,
        });
        let (tx, rx) = channel();
        let handle = std::thread::spawn(move || unsafe {
            // Ahead of the rest: Windows drops a low-level hook that answers too slowly, without
            // a word (a recording with the machine busy noted no clicks).
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
            let module = GetModuleHandleW(None).ok().map(|m| m.into());
            let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), module, 0);
            let _ = tx.send(mouse.is_ok().then(|| GetCurrentThreadId()));
            if let Ok(hook) = mouse {
                // The hook is called on this thread, as its messages are pumped.
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
                let _ = UnhookWindowsHookEx(hook);
            }
        });
        match rx.recv() {
            Ok(Some(thread)) => Ok(Watch {
                thread,
                handle,
                clicks,
            }),
            _ => {
                let _ = handle.join();
                SINK.lock().unwrap().take();
                Err("Windows didn't let Razorcat see the clicks".into())
            }
        }
    }

    pub fn set_clicks(&self, on: bool) {
        self.clicks.store(on, Ordering::SeqCst);
    }

    /// Stops noting; what was noted, in order.
    pub fn stop(self) -> Vec<Press> {
        unsafe {
            let _ = PostThreadMessageW(self.thread, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        let _ = self.handle.join();
        SINK.lock()
            .unwrap()
            .take()
            .map(|s| s.presses)
            .unwrap_or_default()
    }
}

unsafe extern "system" fn on_mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let button = match w.0 as u32 {
            WM_LBUTTONDOWN => Some(Button::Left),
            WM_RBUTTONDOWN => Some(Button::Right),
            WM_MBUTTONDOWN => Some(Button::Middle),
            _ => None,
        };
        if let Some(button) = button {
            let m = &*(l.0 as *const MSLLHOOKSTRUCT);
            if let Some(sink) = SINK.lock().unwrap().as_mut() {
                if sink.clicks.load(Ordering::SeqCst) {
                    let window = sink.window.and_then(window_frame);
                    let qpc = crate::audio::qpc_now();
                    note_click(
                        &mut sink.presses,
                        &mut sink.last,
                        qpc,
                        m.pt.x,
                        m.pt.y,
                        button,
                        window,
                    );
                }
            }
        }
    }
    CallNextHookEx(None, code, w, l)
}

/// A click: a second one soon after, close by, with the same button, makes the first a
/// double-click instead; a third and more as quick (a triple-click) are part of it too
/// (Richard, 2026-10-26: no ×3 for now). `last` is when the click before it was.
fn note_click(
    presses: &mut Vec<Press>,
    last: &mut i64,
    qpc: i64,
    x: i32,
    y: i32,
    button: Button,
    window: Option<(i32, i32, i32, i32)>,
) {
    let soon = i64::from(unsafe { GetDoubleClickTime() }) * 10_000;
    if let Some(Press::Click {
        qpc: then,
        x: x0,
        y: y0,
        button: b0,
        double,
        ..
    }) = presses.last_mut()
    {
        let previous = if *double { *last } else { *then };
        if *b0 == button && qpc - previous <= soon && (x - *x0).abs() <= 8 && (y - *y0).abs() <= 8 {
            *double = true;
            *last = qpc;
            return;
        }
    }
    *last = qpc;
    presses.push(Press::Click {
        qpc,
        x,
        y,
        button,
        double: false,
        window,
    });
}

/// A window's frame as drawn (virtual-desktop px): x, y, width, height.
fn window_frame(hwnd: isize) -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    let mut r = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            HWND(hwnd as *mut _),
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as _,
            size_of::<RECT>() as u32,
        )
        .ok()?;
    }
    Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quick_second_click_makes_a_double_click() {
        let (mut p, mut last) = (Vec::new(), 0);
        note_click(&mut p, &mut last, 0, 100, 100, Button::Left, None);
        note_click(&mut p, &mut last, 1_000_000, 103, 101, Button::Left, None);
        assert_eq!(p.len(), 1);
        assert!(matches!(p[0], Press::Click { double: true, .. }));
        // One far away, or with another button, is its own.
        note_click(&mut p, &mut last, 1_600_000, 300, 101, Button::Left, None);
        note_click(&mut p, &mut last, 1_700_000, 300, 101, Button::Right, None);
        assert_eq!(p.len(), 3);
    }

    #[test]
    fn a_triple_click_is_a_double_click() {
        let soon = i64::from(unsafe { GetDoubleClickTime() }) * 10_000;
        let (mut p, mut last) = (Vec::new(), 0);
        // Each soon after the one before (the third later than that after the first).
        for k in 0..3 {
            note_click(
                &mut p,
                &mut last,
                k * (soon - 1),
                100,
                100,
                Button::Left,
                None,
            );
        }
        assert_eq!(p.len(), 1);
        assert!(matches!(
            p[0],
            Press::Click {
                qpc: 0,
                double: true,
                ..
            }
        ));
        // A click after a pause is a new one.
        note_click(&mut p, &mut last, 3 * soon, 100, 100, Button::Left, None);
        assert_eq!(p.len(), 2);
    }
}
