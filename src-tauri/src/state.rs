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
    /// The open source files, in the order opened: the first sets the timeline's frame size and
    /// rate (PLAN 4.5e). Kept for the session (undo can bring a deleted clip's file back), all
    /// let go when the timeline is replaced.
    pub sources: Mutex<Vec<Source>>,
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
            sources: Mutex::new(Vec::new()),
            converting: Mutex::new(None),
            exporting: Mutex::new(None),
            encoders: Mutex::new(None),
            markup: Mutex::new(HashMap::new()),
        }
    }
}
