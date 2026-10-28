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
pub fn editor_ready(app: AppHandle) -> Vec<SourceInfo> {
    editor::ready(&app)
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

/// Deletes the logs and crash reports, the current log emptied (Settings › About › Debugging).
#[tauri::command]
#[specta::specta]
pub fn clear_logs() -> Result<(), String> {
    crate::log::clear()
}

/// The logs folder's size in bytes (Settings › About › Debugging).
#[tauri::command]
#[specta::specta]
pub fn logs_size() -> f64 {
    crate::log::folder_bytes() as f64
}

/// Settings › Export › file names: the name `template` gives an export now (a clip's, with
/// `clip`), as Vandal's preview.
#[tauri::command]
#[specta::specta]
pub fn preview_export_name(app: AppHandle, template: String, clip: bool) -> String {
    crate::export::preview_name(&app, &template, clip)
}

/// Settings › Recording › File name: the name `template` gives a recording now.
#[tauri::command]
#[specta::specta]
pub fn preview_recording_name(app: AppHandle, template: String) -> String {
    crate::recording::preview_name(&app, &template)
}

/// Flowcat Software's website, the maker (Settings › About). A fixed address.
#[tauri::command]
#[specta::specta]
pub fn open_flowcat_site() {
    let _ = std::process::Command::new("explorer.exe")
        .arg("https://flowcat.studio")
        .spawn();
}

/// The current settings.
#[tauri::command]
#[specta::specta]
pub fn get_settings(app: AppHandle) -> Settings {
    app.state::<AppState>().settings.read().unwrap().clone()
}

/// The editor's first close, ever: Razorcat stays in the tray (`keep`) or quits, and closing
/// does that from now on (PLAN 5b.8a).
#[tauri::command]
#[specta::specta]
pub fn closed_to_tray(app: AppHandle, keep: bool) -> Result<(), String> {
    crate::tray::closed_to_tray(&app, keep)
}

/// Settings is recording a new shortcut (PLAN 5b.8b): ours let go of, so pressing one is
/// recorded instead of acted on.
#[tauri::command]
#[specta::specta]
pub fn hotkeys_pause(app: AppHandle) {
    crate::hotkeys::pause(&app);
}

/// Done recording one: ours again, as settings have them now.
#[tauri::command]
#[specta::specta]
pub fn hotkeys_resume(app: AppHandle) {
    crate::hotkeys::resume(&app);
}

/// Whether a just-recorded shortcut can be ours; the reason if not.
#[tauri::command]
#[specta::specta]
pub fn hotkey_check(app: AppHandle, hotkey: String) -> Option<String> {
    crate::hotkeys::check(&app, &hotkey).err()
}

/// Whether Windows 11 keeps PrintScreen for its own screen capture.
#[tauri::command]
#[specta::specta]
pub fn print_screen_opens_snipping() -> bool {
    crate::hotkeys::print_screen_opens_snipping()
}

/// Windows Settings › Accessibility › Keyboard (the Print Screen switch).
#[tauri::command]
#[specta::specta]
pub fn open_keyboard_settings() {
    let _ = std::process::Command::new("explorer.exe")
        .arg("ms-settings:easeofaccess-keyboard")
        .spawn();
}

/// Every setting as installed: what a group's Reset (Settings, its heading's link) puts back.
#[tauri::command]
#[specta::specta]
pub fn default_settings() -> Settings {
    Settings::default()
}

/// Settings › About's resets: every setting as installed, or with `styles_only` only the styles
/// (Settings › Markup and Recording's clicks); either way the tools' remembered styles are
/// forgotten. Returns the settings as stored.
#[tauri::command]
#[specta::specta]
pub fn reset_settings(app: AppHandle, styles_only: bool) -> Result<Settings, String> {
    let now = get_settings(app.clone());
    let reset = if styles_only {
        settings::styles_reset(&now)
    } else {
        Settings::default()
    };
    let stored = settings::update(&app, reset)?;
    crate::tool_styles::forget(&app);
    logln!(
        "[settings] reset ({})",
        if styles_only { "styles" } else { "all" }
    );
    Ok(stored)
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

/// The bytes in the files directly in a folder setting's folder (may contain `%VARS%`); 0 if
/// it isn't there. Off the main thread: the folder may be a big one.
#[tauri::command]
#[specta::specta]
pub async fn folder_size(path: String) -> f64 {
    let dir = crate::paths::resolve_dir(&path);
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| e.metadata().ok())
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .sum::<u64>()
        })
        .unwrap_or(0) as f64
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

/// Record: the overlays, to pick what to record (PLAN 5b.3; picker.rs); done, the recording's
/// offered to the editor (5b.8c). [`crate::recording::RecordingChanged`] says how it went. An
/// error if one is under way.
#[tauri::command]
#[specta::specta]
pub fn start_recording(app: AppHandle) -> Result<(), String> {
    crate::picker::open(&app)
}

/// The first recording's folder question, answered in the picker (PLAN 5b.7, 5b.8c): `folder`
/// from now on (None: as it is); never asked again.
#[tauri::command]
#[specta::specta]
pub fn answer_recording_folder(app: AppHandle, folder: Option<String>) -> Result<(), String> {
    let mut s = get_settings(app.clone());
    s.recording.asked_folder = true;
    if let Some(folder) = folder {
        s.recording.folder = folder;
    }
    crate::settings::update(&app, s).map(|_| ())
}

/// An overlay's selection started: the other overlays drop theirs.
#[tauri::command]
#[specta::specta]
pub fn pick_started(app: AppHandle, index: u32) {
    crate::picker::started(&app, index);
}

/// Overlay `index`'s selection is now `rect` (monitor pixels), or none: the camera's bubble
/// follows it.
#[tauri::command]
#[specta::specta]
pub fn pick_selection(app: AppHandle, index: u32, rect: Option<crate::picker::PickRect>) {
    crate::picker::selected(&app, index, rect);
}

/// The camera's bubble is pressed (`at` "down"), moved while pressed ("move"), or let go ("up"):
/// Rust drags it.
#[tauri::command]
#[specta::specta]
pub fn camera_drag(app: AppHandle, at: String) {
    match at.as_str() {
        "down" => crate::camera::grab(&app),
        "move" => crate::camera::drag(&app),
        _ => crate::camera::release(&app),
    }
}

/// Overlay `index`'s area `rect` (monitor pixels), or with none the whole monitor, is recorded.
#[tauri::command]
#[specta::specta]
pub fn pick_area(
    app: AppHandle,
    index: u32,
    rect: Option<crate::picker::PickRect>,
) -> Result<(), String> {
    crate::picker::picked(&app, index, rect)
}

/// Overlay `index`'s monitor and the windows it can pick; None once picking is over.
#[tauri::command]
#[specta::specta]
pub fn pick_load(app: AppHandle, index: u32) -> Option<crate::picker::PickLoad> {
    crate::picker::load(&app, index)
}

/// The Record bar's microphone, system sound, clicks and camera toggles (Settings › Recording's
/// too): each as given, or as it is.
#[tauri::command]
#[specta::specta]
pub fn set_record_sound(
    app: AppHandle,
    microphone: Option<bool>,
    system: Option<bool>,
    clicks: Option<bool>,
    camera: Option<bool>,
) -> Result<(), String> {
    let mut s = app
        .state::<crate::state::AppState>()
        .settings
        .read()
        .unwrap()
        .clone();
    if let Some(on) = microphone {
        s.recording.microphone = on;
    }
    if let Some(on) = system {
        s.recording.system_sound = on;
    }
    if let Some(on) = clicks {
        s.recording.clicks = on;
    }
    if let Some(on) = camera {
        s.recording.camera = on;
    }
    settings::update(&app, s).map(drop)
}

/// The control's clicks button: noted or not.
#[tauri::command]
#[specta::specta]
pub fn note_recording_clicks(app: AppHandle, on: bool) {
    crate::recording::note(&app, Some(on));
}

/// The clicks and keys noted while the file at `path` was recorded, once (PLAN 5b.6b).
#[tauri::command]
#[specta::specta]
pub fn take_recorded_input(path: String) -> Option<crate::recording::RecordedInput> {
    crate::recording::take_input(&path)
}

/// The control's Pause: pauses the recording, or resumes it.
#[tauri::command]
#[specta::specta]
pub fn pause_recording(app: AppHandle) {
    crate::recording::pause(&app);
}

/// The control's microphone button: muted or not.
#[tauri::command]
#[specta::specta]
pub fn mute_recording(app: AppHandle, muted: bool) {
    crate::recording::mute(&app, crate::recording::Sound::Microphone, Some(muted));
}

/// The control's system sound button: muted or not.
#[tauri::command]
#[specta::specta]
pub fn mute_system_sound(app: AppHandle, muted: bool) {
    crate::recording::mute(&app, crate::recording::Sound::System, Some(muted));
}

/// The microphones connected now, and which is the default (Settings › Recording).
#[tauri::command]
#[specta::specta]
pub async fn microphones() -> crate::audio::Microphones {
    crate::audio::microphones()
}

/// The cameras connected now (Settings › Recording).
#[tauri::command]
#[specta::specta]
pub async fn cameras() -> Vec<crate::camera::Camera> {
    crate::camera::cameras()
}

/// Window mode on or off, and the window under the pointer, on one overlay: all follow.
#[tauri::command]
#[specta::specta]
pub fn pick_window_changed(app: AppHandle, picking: bool, hovered: Option<u32>) {
    crate::picker::window_changed(&app, picking, hovered);
}

/// Window `index` of the overlays' list is recorded.
#[tauri::command]
#[specta::specta]
pub fn pick_window(app: AppHandle, index: u32) -> Result<(), String> {
    crate::picker::picked_window(&app, index)
}

/// The overlays' Esc: nothing recorded.
#[tauri::command]
#[specta::specta]
pub fn pick_cancel(app: AppHandle) {
    crate::picker::cancel(&app);
}

/// Stops the recording (the control's Stop): its file is finished and opened.
#[tauri::command]
#[specta::specta]
pub fn stop_recording(app: AppHandle) {
    crate::recording::stop(&app);
}

/// Where recordings go when Settings › Recording › Folder is empty.
#[tauri::command]
#[specta::specta]
pub fn default_recording_folder(app: AppHandle) -> String {
    crate::recording::default_folder(&app)
        .map(|p| crate::paths::for_settings(&p.to_string_lossy()))
        .unwrap_or_default()
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
