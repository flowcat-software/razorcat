//! App-wide state, managed by Tauri (`app.state::<AppState>()`).

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use crate::editor::EditorState;
use crate::settings::Settings;
use crate::source::Source;

pub struct AppState {
    /// The current settings; changed only through `settings::update`.
    pub settings: RwLock<Settings>,
    pub editor: Mutex<EditorState>,
    /// The open source file (one in the MVP).
    pub source: Mutex<Option<Source>>,
    /// The conversion under way (convert.rs): set to stop it.
    pub converting: Mutex<Option<Arc<AtomicBool>>>,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings: RwLock::new(settings),
            editor: Mutex::new(EditorState::default()),
            source: Mutex::new(None),
            converting: Mutex::new(None),
        }
    }
}
