//! The main window: the editor.

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "editor";
const SIZE: (f64, f64) = (1280.0, 800.0);
const MIN_SIZE: (f64, f64) = (720.0, 480.0);

/// Opens the editor window. Its title is the product name from `tauri.conf.json`, so a rename
/// is one edit there.
pub fn open(app: &AppHandle) -> tauri::Result<()> {
    let title = app.package_info().name.clone();
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("editor.html".into()))
        .title(title)
        .inner_size(SIZE.0, SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .center()
        .build()?;
    Ok(())
}
