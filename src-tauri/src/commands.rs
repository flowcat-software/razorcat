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

/// The editor's page has loaded: shows the window, and opens a file Razorcat was started with
/// ([`editor::SourceOpened`] follows). Returns the open sources, if the page reloaded.
#[tauri::command]
#[specta::specta]
pub fn editor_ready(app: AppHandle, window: WebviewWindow) -> Vec<SourceInfo> {
    editor::ready(&app, &window)
}

/// Show the Open dialog and open the picked file ([`editor::SourceOpened`] or
/// [`editor::OpenFailed`] follows); with `add`, add it to the timeline
/// ([`editor::SourceAdded`]).
#[tauri::command]
#[specta::specta]
pub async fn open_dialog(app: AppHandle, add: bool) {
    let _ = tauri::async_runtime::spawn_blocking(move || editor::ask_open(&app, add)).await;
}

/// The answer to [`editor::OpenOffered`]: add the dropped files (true; before clip `at`, its
/// index, else on the end), replace the timeline's files with them (false), or neither (null).
#[tauri::command]
#[specta::specta]
pub fn answer_offer(app: AppHandle, add: Option<bool>, at: Option<u32>) {
    editor::answer_offer(&app, add, at);
}

/// The Windows accent color, if Windows has one, read on a worker thread (WinRT and a COM init,
/// kept off the main thread amid the window's start-up). The rare start-up crash here was
/// WinRT's DLL unloaded under it: see `appearance::keep_com_alive`.
#[tauri::command]
#[specta::specta]
pub async fn windows_accent() -> Option<WindowsAccent> {
    tauri::async_runtime::spawn_blocking(appearance::windows_accent)
        .await
        .unwrap_or_default()
}

/// Lines for the log from a page (PLAN C1): its edits, tool and errors, in small batches.
#[tauri::command]
#[specta::specta]
pub fn log_page(page: String, lines: Vec<String>) {
    crate::log::page(&page, lines);
}

/// What the editor says once it's up, once: the last run crashed, or the window was reloaded
/// after the webview's crash (PLAN C3, C4).
#[tauri::command]
#[specta::specta]
pub fn crash_notice() -> Option<String> {
    crate::log::take_notice()
}

/// Opens the logs folder (logs and crash dumps) in Explorer.
#[tauri::command]
#[specta::specta]
pub fn open_logs_folder() -> Result<(), String> {
    let dir = crate::log::dir().ok_or("There's no logs folder.")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer.exe")
        .arg(dir)
        .spawn()
        .map(drop)
        .map_err(|e| e.to_string())
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

/// Open (or focus) the settings window, at `section` if given (its id, e.g. "export").
#[tauri::command]
#[specta::specta]
pub fn open_settings(app: AppHandle, section: Option<String>) {
    settings_window::open(&app, section.as_deref());
}

/// Where exports go when Settings › Export › Folder is empty, as the field shows it.
#[tauri::command]
#[specta::specta]
pub fn default_export_folder(app: AppHandle) -> String {
    crate::export::default_folder(&app)
        .map(|p| crate::paths::for_settings(&p.to_string_lossy()))
        .unwrap_or_default()
}

/// The grow presets a new install has (Settings › Editing › Restore defaults).
#[tauri::command]
#[specta::specta]
pub fn default_grow_presets() -> Vec<crate::settings::GrowPreset> {
    crate::settings::default_grow_presets()
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

/// The preview can't play the open source at `url` (its codec): converts it, then sends
/// [`editor::SourceConverted`] (or `ConvertEnded` with why not).
#[tauri::command]
#[specta::specta]
pub fn convert_for_preview(app: AppHandle, url: String) {
    crate::convert::for_preview(&app, url);
}

/// The status bar's Cancel: stops the conversion under way.
#[tauri::command]
#[specta::specta]
pub fn cancel_conversion(app: AppHandle) {
    crate::convert::cancel(&app);
}

/// Exports the timeline (`clip` None) or one clip (`clip`, its number) as MP4 or GIF, with
/// `marks` (their pixels POSTed just before, markup.rs): the Save
/// dialog, then the export on a thread ([`crate::export::ExportProgress`], then
/// [`crate::export::ExportEnded`]). False if it didn't start (the dialog cancelled, or an export
/// under way).
#[tauri::command]
#[specta::specta]
pub async fn export(
    app: AppHandle,
    clips: Vec<crate::export::ExportClip>,
    frame: crate::export::ExportFrame,
    marks: Vec<crate::markup::ExportMark>,
    clip: Option<u32>,
    format: crate::export::Format,
) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        crate::export::ask_and_export(&app, clips, frame, marks, clip, format)
    })
    .await
    .unwrap_or(false)
}

/// Exports each clip as its own file, into a folder the user picks.
#[tauri::command]
#[specta::specta]
pub async fn export_each(
    app: AppHandle,
    clips: Vec<crate::export::ExportClip>,
    frame: crate::export::ExportFrame,
    marks: Vec<crate::markup::ExportMark>,
    format: crate::export::Format,
) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        crate::export::ask_and_export_each(&app, clips, frame, marks, format)
    })
    .await
    .unwrap_or(false)
}

/// The status bar's Cancel: stops the export under way.
#[tauri::command]
#[specta::specta]
pub fn cancel_export(app: AppHandle) {
    crate::export::cancel(&app);
}

/// Shows a file in Explorer, selected (after an export).
#[tauri::command]
#[specta::specta]
pub fn show_in_folder(path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // Raw: Explorer wants `/select,"C:\a b\c.mp4"`. Quoted as a whole (`.arg` quotes anything
    // with a space), it can't read the path and opens Documents.
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{path}\""))
        .spawn()
        .map(drop)
        .map_err(|e| e.to_string())
}

/// Development: the source frame export would show at each grid frame of the open source, by
/// its barcode (the preview = export check, check.rs).
#[tauri::command]
#[specta::specta]
pub async fn frame_check_expected(app: AppHandle) -> Result<Vec<u32>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::check::expected(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// Development: exports `clips` (with `marks`, sent first) to a temporary file and reads back
/// each frame's barcode and the colours at `probes` (the export check, check.rs).
#[tauri::command]
#[specta::specta]
pub async fn frame_check_export(
    app: AppHandle,
    clips: Vec<crate::export::ExportClip>,
    frame: crate::export::ExportFrame,
    marks: Vec<crate::markup::ExportMark>,
    probes: Vec<crate::check::Probe>,
    cells: u32,
) -> Result<crate::check::Exported, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::check::exported(&app, &clips, frame, marks, &probes, cells)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Development: adds the first file again, on the end of the timeline: the edited check's
/// second file (check.rs).
#[tauri::command]
#[specta::specta]
pub fn frame_check_add(app: AppHandle) -> Result<(), String> {
    crate::check::add_again(&app)
}

/// Development: keeps the check's report (JSON) and logs `summary`; returns the report's path.
#[tauri::command]
#[specta::specta]
pub fn frame_check_report(
    app: AppHandle,
    summary: String,
    report: String,
) -> Result<String, String> {
    crate::check::report(&app, &summary, &report)
}

/// Installed font families for the text tool's font picker (cached after the first call).
#[tauri::command]
#[specta::specta]
pub async fn list_fonts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(crate::fonts::list)
        .await
        .unwrap_or_default()
}

/// The markup tools' styles remembered from last time (JSON text), or null: none yet, or
/// `markup.rememberToolStyles` is off.
#[tauri::command]
#[specta::specta]
pub fn get_tool_styles(app: AppHandle) -> Option<String> {
    crate::tool_styles::load(&app)
}

/// Remember the markup tools' current styles (JSON text) for next time.
#[tauri::command]
#[specta::specta]
pub fn set_tool_styles(app: AppHandle, styles: String) {
    crate::tool_styles::save(&app, &styles);
}

/// Add a color to the presets the given markup tool uses (the custom color picker's "Save as
/// preset"). Returns a message to show if it can't.
#[tauri::command]
#[specta::specta]
pub fn add_color_preset(app: AppHandle, tool: String, color: String) -> Result<(), String> {
    let mut s = app.state::<AppState>().settings.read().unwrap().clone();
    s.styles.add_preset(&tool, &color)?;
    settings::update(&app, s).map(|_| ())
}

/// Change (`color` given) or delete (`None`) a preset of the palette the given markup tool uses
/// (right-click on a swatch). Returns a message to show if it can't.
#[tauri::command]
#[specta::specta]
pub fn edit_color_preset(
    app: AppHandle,
    tool: String,
    index: u32,
    color: Option<String>,
) -> Result<(), String> {
    let mut s = app.state::<AppState>().settings.read().unwrap().clone();
    s.styles
        .edit_preset(&tool, index as usize, color.as_deref())?;
    settings::update(&app, s).map(|_| ())
}
