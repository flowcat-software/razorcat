//! Folder memory for the file dialogs, as Vandal's: Open starts in the folder last opened from
//! (the Videos folder at first); Export in the folder last exported to (the video's own folder
//! at first).

use std::path::{Path, PathBuf};

use serde_json::json;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

const STATE_FILE: &str = "window-state.json";
const OPEN_FOLDER_KEY: &str = "openFolder";
const EXPORT_FOLDER_KEY: &str = "exportFolder";

/// Where the Open dialog starts: the last folder opened from, if it's still there, else the
/// Videos folder, else the Desktop.
pub fn open_start(app: &AppHandle) -> Option<PathBuf> {
    remembered(app, OPEN_FOLDER_KEY)
        .or_else(|| app.path().video_dir().ok().filter(|d| d.is_dir()))
        .or_else(|| app.path().desktop_dir().ok())
}

/// A file was opened from `folder` (the dialog, a drop, "Open with"): Open starts there next.
pub fn opened_from(app: &AppHandle, folder: &Path) {
    remember(app, OPEN_FOLDER_KEY, folder);
}

/// Where the Export dialog starts: the last folder exported to, if it's still there, else the
/// video's own folder.
pub fn export_start(app: &AppHandle, source_folder: &Path) -> Option<PathBuf> {
    remembered(app, EXPORT_FOLDER_KEY).or_else(|| Some(source_folder.to_path_buf()))
}

/// An export was saved to `folder`: Export starts there next.
pub fn saved_to(app: &AppHandle, folder: &Path) {
    remember(app, EXPORT_FOLDER_KEY, folder);
}

/// A folder remembered under `key`, if it's still there.
fn remembered(app: &AppHandle, key: &str) -> Option<PathBuf> {
    app.store(STATE_FILE)
        .ok()?
        .get(key)?
        .as_str()
        .map(PathBuf::from)
        .filter(|d| d.is_dir())
}

/// Remember `folder` under `key` for the next dialog.
fn remember(app: &AppHandle, key: &str, folder: &Path) {
    let Ok(store) = app.store(STATE_FILE) else {
        return;
    };
    let folder = json!(folder.display().to_string());
    if store.get(key).as_ref() == Some(&folder) {
        return;
    }
    store.set(key, folder);
    if let Err(e) = store.save() {
        eprintln!("[folders] cannot save {key}: {e}");
    }
}
