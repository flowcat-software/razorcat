//! App-wide state, managed by Tauri (`app.state::<AppState>()`).

use std::sync::Mutex;

use crate::editor::EditorState;

#[derive(Default)]
pub struct AppState {
    pub editor: Mutex<EditorState>,
}
