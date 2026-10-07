//! The main window: the editor. It opens hidden and shows once its page has loaded (no white
//! flash), and takes the files Driveby is asked to open.

use std::path::PathBuf;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_specta::Event;

use crate::state::AppState;

pub const LABEL: &str = "editor";
const SIZE: (f64, f64) = (1280.0, 800.0);
const MIN_SIZE: (f64, f64) = (720.0, 480.0);

#[derive(Default)]
pub struct EditorState {
    /// The page has called `editor_ready`; files go to it as [`OpenFile`] events from now on.
    ready: bool,
    /// A file asked for before the page was ready; `editor_ready` hands it over.
    pending: Option<PathBuf>,
}

/// A file to open in the editor (from a second launch; later Open and drag-drop).
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct OpenFile {
    pub path: String,
}

/// Opens the editor window, hidden. Its title is the product name from `tauri.conf.json`, so a
/// rename is one edit there.
pub fn open(app: &AppHandle) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("editor.html".into()));
    crate::appearance::themed(app, builder)
        .title(crate::product_name(app))
        .inner_size(SIZE.0, SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .center()
        .visible(false)
        .build()?;
    Ok(())
}

/// The page has loaded: show the window and hand over a file asked for before then.
pub fn ready(app: &AppHandle, window: &WebviewWindow) -> Option<String> {
    let pending = {
        let app_state = app.state::<AppState>();
        let mut state = app_state.editor.lock().unwrap();
        state.ready = true;
        state.pending.take()
    };
    if let Err(e) = window.show().and_then(|_| window.set_focus()) {
        eprintln!("[editor] couldn't show the window: {e}");
    }
    pending.map(|p| p.to_string_lossy().into_owned())
}

/// Open `path` in the editor: now if its page is ready, else once it is. The MVP edits one
/// source, so a file asked for while another waits replaces it.
pub fn request_open(app: &AppHandle, path: PathBuf) {
    eprintln!("[editor] open {}", path.display());
    let ready = {
        let app_state = app.state::<AppState>();
        let mut state = app_state.editor.lock().unwrap();
        if !state.ready {
            state.pending = Some(path.clone());
        }
        state.ready
    };
    if ready {
        let event = OpenFile {
            path: path.to_string_lossy().into_owned(),
        };
        if let Err(e) = event.emit_to(app, LABEL) {
            eprintln!("[editor] couldn't send the file to the page: {e}");
        }
    }
}

/// Brings the editor to the front (a second launch).
pub fn focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
