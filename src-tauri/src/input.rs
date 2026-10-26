//! Clicks and keys noted while recording (PLAN 5b.6a), to become markup on the timeline. Windows'
//! low-level mouse and keyboard hooks, on a thread of their own, see every press anywhere; only
//! what's to be shown is kept, stamped on the recording's clock (audio.rs), and only in memory:
//! nothing typed is written to a file or the log.
//!
//! Keys, as Settings › Recording has them: none, shortcuts only (with Ctrl, Alt or Win held, and
//! lone keys like Enter, Esc, Tab: ordinary typing never), or all. Razorcat's own recording keys
//! (Ctrl+Alt+M, P, S, C, K) aren't noted.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde::{Deserialize, Serialize};
use specta::Type;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetDoubleClickTime, GetKeyNameTextW};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
    KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP,
    WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

/// Which keys are noted (Settings › Recording).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum KeyMode {
    #[default]
    Off,
    Shortcuts,
    All,
}

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
    Keys {
        qpc: i64,
        keys: Vec<String>,
    },
}

/// What the hooks keep, and how they're set.
struct Sink {
    clicks: Arc<AtomicBool>,
    keys: Arc<Mutex<KeyMode>>,
    /// The window recorded, if it's one: its frame is noted with each click.
    window: Option<isize>,
    presses: Vec<Press>,
    held: Held,
    /// Keys down now (a key held repeats: noted once).
    down: Vec<u32>,
}

/// The modifiers held.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Held {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
}

static SINK: Mutex<Option<Sink>> = Mutex::new(None);

/// Noting clicks and keys, until stopped.
pub struct Watch {
    thread: u32,
    handle: JoinHandle<()>,
    clicks: Arc<AtomicBool>,
    keys: Arc<Mutex<KeyMode>>,
    /// The keys' mode when they're turned on (Settings', or shortcuts if that's off).
    keys_on: KeyMode,
}

impl Watch {
    /// Starts noting: clicks if `clicks`, keys as `keys`; `window` is the window recorded.
    pub fn start(clicks: bool, keys: KeyMode, window: Option<isize>) -> Result<Watch, String> {
        let clicks = Arc::new(AtomicBool::new(clicks));
        let mode = Arc::new(Mutex::new(keys));
        *SINK.lock().unwrap() = Some(Sink {
            clicks: clicks.clone(),
            keys: mode.clone(),
            window,
            presses: Vec::new(),
            held: Held::default(),
            down: Vec::new(),
        });
        let (tx, rx) = channel();
        let handle = std::thread::spawn(move || unsafe {
            let module = GetModuleHandleW(None).ok().map(|m| m.into());
            let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), module, 0);
            let keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), module, 0);
            let ok = mouse.is_ok() && keyboard.is_ok();
            let _ = tx.send(ok.then(|| GetCurrentThreadId()));
            if ok {
                // The hooks are called on this thread, as its messages are pumped.
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
            }
            for hook in [mouse, keyboard].into_iter().flatten() {
                let _ = UnhookWindowsHookEx(hook);
            }
        });
        match rx.recv() {
            Ok(Some(thread)) => Ok(Watch {
                thread,
                handle,
                clicks,
                keys: mode,
                keys_on: if keys == KeyMode::Off {
                    KeyMode::Shortcuts
                } else {
                    keys
                },
            }),
            _ => {
                let _ = handle.join();
                SINK.lock().unwrap().take();
                Err("Windows didn't let Razorcat see the clicks and keys".into())
            }
        }
    }

    pub fn set_clicks(&self, on: bool) {
        self.clicks.store(on, Ordering::SeqCst);
    }

    /// Keys on (as Settings has them, or shortcuts) or off.
    pub fn set_keys(&self, on: bool) {
        *self.keys.lock().unwrap() = if on { self.keys_on } else { KeyMode::Off };
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
                    note_click(&mut sink.presses, qpc, m.pt.x, m.pt.y, button, window);
                }
            }
        }
    }
    CallNextHookEx(None, code, w, l)
}

/// A click: a second one soon after, close by, with the same button, makes the first a
/// double-click instead.
fn note_click(
    presses: &mut Vec<Press>,
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
        if *b0 == button
            && !*double
            && qpc - *then <= soon
            && (x - *x0).abs() <= 8
            && (y - *y0).abs() <= 8
        {
            *double = true;
            return;
        }
    }
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

unsafe extern "system" fn on_key(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let k = &*(l.0 as *const KBDLLHOOKSTRUCT);
        let down = matches!(w.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
        let up = matches!(w.0 as u32, WM_KEYUP | WM_SYSKEYUP);
        if let Some(sink) = SINK.lock().unwrap().as_mut() {
            let vk = k.vkCode;
            if let Some(held) = modifier(&mut sink.held, vk) {
                *held = down;
            } else if up {
                sink.down.retain(|&d| d != vk);
            } else if down && !sink.down.contains(&vk) {
                sink.down.push(vk);
                let mode = *sink.keys.lock().unwrap();
                if shown(mode, sink.held, vk) {
                    let extended = k.flags.0 & 1 != 0;
                    let keys = combo(sink.held, vk, k.scanCode, extended);
                    sink.presses.push(Press::Keys {
                        qpc: crate::audio::qpc_now(),
                        keys,
                    });
                }
            }
        }
    }
    CallNextHookEx(None, code, w, l)
}

/// The modifier `vk` is, as its place in `held`.
fn modifier(held: &mut Held, vk: u32) -> Option<&mut bool> {
    match vk {
        0x10 | 0xA0 | 0xA1 => Some(&mut held.shift),
        0x11 | 0xA2 | 0xA3 => Some(&mut held.ctrl),
        0x12 | 0xA4 | 0xA5 => Some(&mut held.alt),
        0x5B | 0x5C => Some(&mut held.win),
        _ => None,
    }
}

/// Keys that show on their own as shortcuts: Enter, Esc, Tab, Print Screen, F1–F24.
fn lone_shortcut(vk: u32) -> bool {
    matches!(vk, 0x0D | 0x1B | 0x09 | 0x2C | 0x70..=0x87)
}

/// Razorcat's own keys while recording (recording.rs): not noted.
fn ours(held: Held, vk: u32) -> bool {
    held.ctrl
        && held.alt
        && !held.shift
        && !held.win
        && matches!(vk, 0x43 | 0x4B | 0x4D | 0x50 | 0x53)
}

/// Whether key `vk`, pressed with `held`, is noted in `mode`. Ctrl and Alt together without Win
/// count as a shortcut, unless it's one of ours; AltGr (which types characters on many layouts)
/// arrives as both too, so a lone Alt+Ctrl character might show: rare, and never a password's
/// whole.
pub fn shown(mode: KeyMode, held: Held, vk: u32) -> bool {
    if ours(held, vk) {
        return false;
    }
    match mode {
        KeyMode::Off => false,
        KeyMode::All => true,
        KeyMode::Shortcuts => held.ctrl || held.alt || held.win || lone_shortcut(vk),
    }
}

/// The keys as shown: the modifiers held, in Windows' order, then the key.
pub fn combo(held: Held, vk: u32, scan: u32, extended: bool) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for (on, name) in [
        (held.ctrl, "Ctrl"),
        (held.alt, "Alt"),
        (held.shift, "Shift"),
        (held.win, "Win"),
    ] {
        if on {
            keys.push(name.into());
        }
    }
    keys.push(key_name(vk).unwrap_or_else(|| layout_name(scan, extended)));
    keys
}

/// A key's name, for the keys every layout names the same.
fn key_name(vk: u32) -> Option<String> {
    let name = match vk {
        0x41..=0x5A | 0x30..=0x39 => return char::from_u32(vk).map(String::from),
        0x70..=0x87 => return Some(format!("F{}", vk - 0x6F)),
        0x60..=0x69 => return Some(format!("Num {}", vk - 0x60)),
        0x0D => "Enter",
        0x1B => "Esc",
        0x09 => "Tab",
        0x20 => "Space",
        0x08 => "Backspace",
        0x2E => "Delete",
        0x2D => "Insert",
        0x24 => "Home",
        0x23 => "End",
        0x21 => "PgUp",
        0x22 => "PgDn",
        0x25 => "←",
        0x26 => "↑",
        0x27 => "→",
        0x28 => "↓",
        0x2C => "PrtScn",
        0x14 => "Caps Lock",
        _ => return None,
    };
    Some(name.into())
}

/// Another key's name, as the keyboard layout has it (`-`, `[`, `;`...).
fn layout_name(scan: u32, extended: bool) -> String {
    let lparam = ((scan & 0xFF) << 16) | (u32::from(extended) << 24);
    let mut buf = [0u16; 32];
    let n = unsafe { GetKeyNameTextW(lparam as i32, &mut buf) };
    if n > 0 {
        String::from_utf16_lossy(&buf[..n as usize])
    } else {
        "?".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CTRL: Held = Held {
        ctrl: true,
        alt: false,
        shift: false,
        win: false,
    };

    #[test]
    fn shortcuts_show_and_typing_does_not() {
        let none = Held::default();
        let shift = Held {
            shift: true,
            ..none
        };
        // Ctrl+S, Win+E, Alt+F4, lone Enter and F5: shown.
        assert!(shown(KeyMode::Shortcuts, CTRL, 0x53));
        assert!(shown(KeyMode::Shortcuts, Held { win: true, ..none }, 0x45));
        assert!(shown(KeyMode::Shortcuts, Held { alt: true, ..none }, 0x73));
        assert!(shown(KeyMode::Shortcuts, none, 0x0D));
        assert!(shown(KeyMode::Shortcuts, none, 0x74));
        // Typing, Shift+letter (a capital) and Space: not.
        assert!(!shown(KeyMode::Shortcuts, none, 0x41));
        assert!(!shown(KeyMode::Shortcuts, shift, 0x41));
        assert!(!shown(KeyMode::Shortcuts, none, 0x20));
        // All keys: typing too; off: nothing.
        assert!(shown(KeyMode::All, none, 0x41));
        assert!(!shown(KeyMode::Off, CTRL, 0x53));
    }

    #[test]
    fn our_own_recording_keys_are_left_out() {
        let ours = Held { alt: true, ..CTRL };
        for vk in [0x4D, 0x50, 0x53, 0x43, 0x4B] {
            assert!(!shown(KeyMode::All, ours, vk));
        }
        assert!(shown(KeyMode::Shortcuts, ours, 0x44));
    }

    #[test]
    fn combos_name_the_modifiers_in_order() {
        let all = Held {
            ctrl: true,
            alt: true,
            shift: true,
            win: true,
        };
        assert_eq!(
            combo(all, 0x53, 0, false),
            ["Ctrl", "Alt", "Shift", "Win", "S"]
        );
        assert_eq!(combo(CTRL, 0x70, 0, false), ["Ctrl", "F1"]);
        assert_eq!(combo(Held::default(), 0x25, 0, false), ["←"]);
        assert_eq!(combo(CTRL, 0x36, 0, false), ["Ctrl", "6"]);
    }

    #[test]
    fn a_quick_second_click_makes_a_double_click() {
        let mut p = Vec::new();
        note_click(&mut p, 0, 100, 100, Button::Left, None);
        note_click(&mut p, 1_000_000, 103, 101, Button::Left, None);
        assert_eq!(p.len(), 1);
        assert!(matches!(p[0], Press::Click { double: true, .. }));
        // A third starts again; one far away, or with another button, is its own.
        note_click(&mut p, 1_500_000, 103, 101, Button::Left, None);
        note_click(&mut p, 1_600_000, 300, 101, Button::Left, None);
        note_click(&mut p, 1_700_000, 300, 101, Button::Right, None);
        assert_eq!(p.len(), 4);
    }
}
