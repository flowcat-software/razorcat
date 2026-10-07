//! All `#[tauri::command]`s. TS bindings are generated into `src/shared/bindings.ts` on debug
//! runs; call them via `src/shared/ipc.ts`.

use tauri::{AppHandle, WebviewWindow};

use crate::appearance::{self, WindowsAccent};
use crate::editor;

/// The editor's page has loaded: shows the window. Returns a file to open, if Driveby was
/// started with one.
#[tauri::command]
#[specta::specta]
pub fn editor_ready(app: AppHandle, window: WebviewWindow) -> Option<String> {
    editor::ready(&app, &window)
}

/// The Windows accent color, if Windows has one.
#[tauri::command]
#[specta::specta]
pub fn windows_accent() -> Option<WindowsAccent> {
    appearance::windows_accent()
}
