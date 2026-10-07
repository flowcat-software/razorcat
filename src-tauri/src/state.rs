//! App-wide state, managed by Tauri (`app.state::<AppState>()`).

use std::sync::{Mutex, RwLock};

use crate::editor::EditorState;
use crate::settings::Settings;

pub struct AppState {
    /// The current settings; changed only through `settings::update`.
    pub settings: RwLock<Settings>,
    pub editor: Mutex<EditorState>,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings: RwLock::new(settings),
            editor: Mutex::new(EditorState::default()),
        }
    }
}
