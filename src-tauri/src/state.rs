//! App-wide state, managed by Tauri (`app.state::<AppState>()`).

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use crate::editor::EditorState;
use crate::export::Encoder;
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
    /// The export under way (export.rs): set to stop it.
    pub exporting: Mutex<Option<Arc<AtomicBool>>>,
    /// The encoders that work here, best first, once found (export.rs).
    pub encoders: Mutex<Option<Vec<Encoder>>>,
    /// The markup's pixels the page sent for the next export, by item (markup.rs).
    pub markup: Mutex<HashMap<u32, Vec<u8>>>,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings: RwLock::new(settings),
            editor: Mutex::new(EditorState::default()),
            source: Mutex::new(None),
            converting: Mutex::new(None),
            exporting: Mutex::new(None),
            encoders: Mutex::new(None),
            markup: Mutex::new(HashMap::new()),
        }
    }
}
