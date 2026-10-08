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

/// A folder picker, modal to the calling window, starting at `current` (a folder setting, may
/// contain `%VARS%`). Paths under the user profile come back as `%USERPROFILE%\...`.
#[tauri::command]
#[specta::specta]
pub async fn pick_folder(window: WebviewWindow, current: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let start = crate::paths::resolve_dir(&current);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = window
            .dialog()
            .file()
            .set_title("Choose a folder")
            .set_parent(&window);
        if start.is_dir() {
            dialog = dialog.set_directory(&start);
        }
        dialog.blocking_pick_folder()
    })
    .await
    .ok()
    .flatten()?;
    let path = picked.into_path().ok()?;
    Some(crate::paths::for_settings(&path.to_string_lossy()))
}

/// Opens a folder setting's folder (may contain `%VARS%`) in Explorer, making it first so the
/// button always does something.
#[tauri::command]
#[specta::specta]
pub fn open_folder(path: String) -> Result<(), String> {
    let dir = crate::paths::resolve_dir(&path);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    std::process::Command::new("explorer.exe")
        .arg(&dir)
        .spawn()
        .map(drop)
        .map_err(|e| e.to_string())
}

/// Where proxies go when Settings › Proxies › Folder is empty, as the field shows it.
#[tauri::command]
#[specta::specta]
pub fn default_proxy_folder(app: AppHandle) -> String {
    crate::proxy::default_folder(&app)
        .map(|p| crate::paths::for_settings(&p.to_string_lossy()))
        .unwrap_or_default()
}

/// The proxy cache's size, and what lowering its limit to `limit_gb` would delete.
#[tauri::command]
#[specta::specta]
pub async fn proxy_cache(app: AppHandle, limit_gb: u32) -> crate::proxy::CacheReport {
    tauri::async_runtime::spawn_blocking(move || crate::proxy::report(&app, limit_gb))
        .await
        .unwrap_or(crate::proxy::CacheReport {
            bytes: 0.0,
            files: 0,
            dropping: 0,
            dropping_bytes: 0.0,
        })
}
