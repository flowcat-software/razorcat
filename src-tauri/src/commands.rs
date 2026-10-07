//! All `#[tauri::command]`s. TS bindings are generated into `src/shared/bindings.ts` on debug
//! runs; call them via `src/shared/ipc.ts`.

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::appearance::{self, WindowsAccent};
use crate::editor;
use crate::settings::{self, Settings};
use crate::settings_window;
use crate::sidecar::{self, MediaTools};
use crate::source::SourceInfo;
use crate::state::AppState;

/// The editor's page has loaded: shows the window, and opens a file Driveby was started with
/// ([`editor::SourceOpened`] follows). Returns the open source, if the page reloaded.
#[tauri::command]
#[specta::specta]
pub fn editor_ready(app: AppHandle, window: WebviewWindow) -> Option<SourceInfo> {
    editor::ready(&app, &window)
}

/// Show the Open dialog and open the picked file ([`editor::SourceOpened`] or
/// [`editor::OpenFailed`] follows).
#[tauri::command]
#[specta::specta]
pub async fn open_dialog(app: AppHandle) {
    let _ = tauri::async_runtime::spawn_blocking(move || editor::ask_open(&app)).await;
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

/// The bundled ffmpeg's and gifski's versions (Settings › About); runs each once.
#[tauri::command]
#[specta::specta]
pub async fn media_tools() -> MediaTools {
    tauri::async_runtime::spawn_blocking(sidecar::media_tools)
        .await
        .unwrap_or(MediaTools {
            ffmpeg: None,
            gifski: None,
        })
}
