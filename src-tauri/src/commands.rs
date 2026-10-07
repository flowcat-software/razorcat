//! All `#[tauri::command]`s. TS bindings are generated into `src/shared/bindings.ts` on debug
//! runs; call them via `src/shared/ipc.ts`.

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::appearance::{self, WindowsAccent};
use crate::editor;
use crate::settings::{self, Settings};
use crate::settings_window;
use crate::state::AppState;

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

/// The current settings.
#[tauri::command]
#[specta::specta]
pub fn get_settings(app: AppHandle) -> Settings {
    app.state::<AppState>().settings.read().unwrap().clone()
}

/// Validate, save and apply new settings; returns them as stored (normalized).
#[tauri::command]
#[specta::specta]
pub fn update_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    settings::update(&app, settings)
}

/// Open (or focus) the settings window.
#[tauri::command]
#[specta::specta]
pub fn open_settings(app: AppHandle) {
    settings_window::open(&app);
}
