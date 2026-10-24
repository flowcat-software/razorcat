//! The markup tools' remembered styles (Vandal's): each tool's color, width, fill, font... as
//! the editor last left them, so the next session starts where the user was.
//!
//! Kept in its own store file, not settings.json: it's working state, not configuration. Rust
//! stores it as opaque JSON text; the page owns its shape and ignores anything it doesn't
//! recognize, so adding a tool option needs no change here. `markup.rememberToolStyles` off:
//! nothing is handed out or kept.

use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::state::AppState;

const FILE: &str = "tool-styles.json";
const KEY: &str = "styles";

fn enabled(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .settings
        .read()
        .unwrap()
        .markup
        .remember_tool_styles
}

/// The remembered styles as JSON text, or `None` (none yet, or the setting is off).
pub fn load(app: &AppHandle) -> Option<String> {
    if !enabled(app) {
        return None;
    }
    let value = app.store(FILE).ok()?.get(KEY)?;
    Some(value.to_string())
}

/// Remember `json` for the next window. Ignored when the setting is off or it
/// isn't a JSON object.
pub fn save(app: &AppHandle, json: &str) {
    if !enabled(app) {
        return;
    }
    let value = match serde_json::from_str::<serde_json::Value>(json) {
        Ok(v) if v.is_object() => v,
        _ => {
            logln!("[tool-styles] ignoring a value that isn't a JSON object");
            return;
        }
    };
    let Ok(store) = app.store(FILE) else {
        return;
    };
    store.set(KEY, value);
    if let Err(e) = store.save() {
        logln!("[tool-styles] cannot save: {e}");
    }
}
