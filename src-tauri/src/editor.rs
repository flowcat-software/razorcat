//! The main window: the editor. It opens hidden and shows once its page has loaded (no white
//! flash), and opens the files Razorcat is given: from Open, a drop, "Open with" or a second
//! launch.

use std::path::PathBuf;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_specta::Event;

use crate::placement::{self, Placement};
use crate::source::{self, OpenError, Source, SourceInfo};
use crate::state::AppState;

pub const LABEL: &str = "editor";
const SIZE: (f64, f64) = (1280.0, 800.0);
const MIN_SIZE: (f64, f64) = (720.0, 480.0);

/// What the Open dialog offers. MP4 and MOV open directly; the rest are converted on open
/// (Phase 1.6). Keep in step with `windows/hooks.nsh` ("Open with").
pub const EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "mkv", "webm", "gif"];

#[derive(Default)]
pub struct EditorState {
    /// The page has called `editor_ready`; files open in it from now on.
    ready: bool,
    /// A file asked for before the page was ready; opened when it is.
    pending: Option<PathBuf>,
    /// Where the window is when not maximized or minimized, kept up to date as it moves, so
    /// closing it maximized still remembers where it was.
    normal: Option<Placement>,
    /// It was maximized when it last closed: it shows maximized.
    show_maximized: bool,
    /// A file dropped (or launched with) while the timeline has files: the page asks whether
    /// to add it or replace them (`answer_offer`).
    offered: Option<PathBuf>,
}

/// Rust → editor: a file was opened (it replaces the timeline's files).
#[derive(Clone, Serialize, Type, Event)]
pub struct SourceOpened(pub SourceInfo);

/// Rust → editor: a file was added to the timeline's (PLAN 4.5e): it goes on the end.
#[derive(Clone, Serialize, Type, Event)]
pub struct SourceAdded(pub SourceInfo);

/// Rust → editor: a file was dropped on the window (or launched with) while the timeline has
/// files: ask whether to add it or replace them, then `answer_offer` (PLAN 4.5e3).
#[derive(Clone, Serialize, Type, Event)]
pub struct OpenOffered {
    /// Its file name.
    pub name: String,
}

/// Rust → editor: the open source plays from a converted copy now (its codec): the same
/// source, at a new URL.
#[derive(Clone, Serialize, Type, Event)]
pub struct SourceConverted(pub SourceInfo);

/// Rust → editor: a file couldn't be opened; the one before (if any) stays.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct OpenFailed {
    /// A sentence for the user.
    pub message: String,
}

/// Opens the editor window, hidden, where it was last time (if that's still on a screen), else
/// centred. Its title is the product name from `tauri.conf.json`, so a rename is one edit there.
pub fn open(app: &AppHandle) -> tauri::Result<()> {
    let saved = placement::load(app);
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("editor.html".into()));
    let window = crate::appearance::themed(app, builder)
        .title(crate::product_name(app))
        .inner_size(SIZE.0, SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .center()
        .visible(false)
        .build()?;
    placement::apply(app, &window, saved);
    let app_state = app.state::<AppState>();
    let mut state = app_state.editor.lock().unwrap();
    state.normal = saved.normal;
    state.show_maximized = saved.maximized;
    Ok(())
}

/// The window moved or resized: note where it is, unless it's maximized or minimized.
pub fn moved(app: &AppHandle, window: &tauri::Window) {
    if let Some(p) = placement::current(window) {
        app.state::<AppState>().editor.lock().unwrap().normal = Some(p);
    }
}

/// The window is closing: remember where it was for next time.
pub fn closing(app: &AppHandle, window: &tauri::Window) {
    let normal =
        placement::current(window).or(app.state::<AppState>().editor.lock().unwrap().normal);
    placement::save(
        app,
        placement::Saved {
            normal,
            maximized: placement::is_maximized(window),
        },
    );
}

/// The page has loaded: show the window, and open a file asked for before then. Returns the
/// open sources, first first (the page reloaded), or none.
pub fn ready(app: &AppHandle, window: &WebviewWindow) -> Vec<SourceInfo> {
    let (pending, maximized) = {
        let app_state = app.state::<AppState>();
        let mut state = app_state.editor.lock().unwrap();
        state.ready = true;
        (state.pending.take(), state.show_maximized)
    };
    let shown = if maximized {
        placement::show_maximized(window)
    } else {
        window.show()
    };
    if let Err(e) = shown.and_then(|_| window.set_focus()) {
        eprintln!("[editor] couldn't show the window: {e}");
    }
    if let Some(path) = pending {
        request_open(app, path, false);
    }
    let state = app.state::<AppState>();
    let sources = state.sources.lock().unwrap();
    sources.iter().map(Source::info).collect()
}

/// Open `path` in the editor: now if its page is ready, else once it is (a file asked for while
/// another waits replaces that). It replaces the timeline's files, or with `add` goes on the end
/// of the timeline, at its rate (PLAN 4.5e; with none open, adding is opening).
pub fn request_open(app: &AppHandle, path: PathBuf, add: bool) {
    eprintln!("[editor] open {}", path.display());
    {
        let app_state = app.state::<AppState>();
        let mut state = app_state.editor.lock().unwrap();
        if !state.ready {
            state.pending = Some(path);
            return;
        }
    }
    // A file being converted for opening is replaced by this one.
    crate::convert::cancel(app);
    // Added: gridded at the timeline's rate (the first file's).
    let rate = {
        let state = app.state::<AppState>();
        let sources = state.sources.lock().unwrap();
        sources.first().filter(|_| add).map(|s| s.grid.rate)
    };
    let add = rate.is_some();
    // Reading the index takes milliseconds, but it's file I/O (and converting takes longer): off
    // the main thread.
    let app = app.clone();
    std::thread::spawn(move || {
        let opened = match source::open(&path, None, rate) {
            // MKV, GIF...: opened from a converted copy.
            Err(OpenError::NeedsConversion) => match crate::convert::before_open(&app, &path) {
                Ok(Some(copy)) => source::open(&path, Some(copy), rate),
                // Cancelled, or failed: `ConvertEnded` has told the page.
                Ok(None) | Err(_) => return,
            },
            // The preview needed a copy of this one before (its codec): it plays that at once.
            Ok(mut opened) => {
                opened.playable = crate::convert::cached_for_preview(&app, &path);
                Ok(opened)
            }
            Err(e) => Err(e),
        };
        match opened {
            Ok(opened) => show(&app, path, opened, add),
            Err(e) => {
                let message = match e {
                    OpenError::Failed(message) => message,
                    OpenError::NeedsConversion => {
                        format!("{} can't be opened.", source::file_name(&path))
                    }
                };
                eprintln!("[editor] {message}");
                let _ = OpenFailed { message }.emit_to(&app, LABEL);
            }
        }
    });
}

/// Makes `opened` the timeline's file, or with `add` one more of them: the title, the page, its
/// proxy.
fn show(app: &AppHandle, path: PathBuf, mut opened: Source, add: bool) {
    let use_proxies = crate::proxy::enabled(app);
    if use_proxies {
        opened.proxy = crate::proxy::cached(app, &path);
    }
    let make = (use_proxies && opened.proxy.is_none()).then(|| {
        let input = opened.playable.clone().unwrap_or_else(|| path.clone());
        (
            opened.generation,
            input,
            opened.grid.rate,
            opened.grid.frames,
        )
    });
    if let Some(folder) = path.parent() {
        crate::folders::opened_from(app, folder);
    }
    let info = opened.info();
    let generation = opened.generation;
    eprintln!(
        "[editor] {} {}: {}x{} {} at {}/{} fps, {} frames{}{}",
        if add { "added" } else { "opened" },
        info.name,
        info.width,
        info.height,
        info.codec,
        info.rate_num,
        info.rate_den,
        info.frames,
        if info.variable { ", variable" } else { "" },
        if opened.playable.is_some() {
            ", from a converted copy"
        } else {
            ""
        }
    );
    {
        let state = app.state::<AppState>();
        let mut sources = state.sources.lock().unwrap();
        if !add {
            sources.clear();
        }
        sources.push(opened);
    }
    // The title names the first file.
    if !add {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.set_title(&format!("{} — {}", info.name, crate::product_name(app)));
        }
    }
    let id = info.id.clone();
    let told = if add {
        SourceAdded(info).emit_to(app, LABEL)
    } else {
        SourceOpened(info).emit_to(app, LABEL)
    };
    if let Err(e) = told {
        eprintln!("[editor] couldn't tell the page: {e}");
    }
    if !add {
        crate::check::opened(app, id);
    }
    crate::wave::start(app, generation);
    // The thumbnails come from the proxy, so they wait for one being made.
    if let Some((generation, input, rate, frames)) = make {
        crate::proxy::make(app, generation, path, input, rate, frames);
    } else {
        crate::thumbs::start(app, generation);
    }
}

/// A file dropped on the window, or a launch's: opened if the timeline is empty, else offered
/// (the page asks whether to add it or replace the timeline's files).
pub fn offer(app: &AppHandle, path: PathBuf) {
    let empty = {
        let state = app.state::<AppState>();
        let sources = state.sources.lock().unwrap();
        sources.is_empty()
    };
    let ready = app.state::<AppState>().editor.lock().unwrap().ready;
    if empty || !ready {
        request_open(app, path, false);
        return;
    }
    let name = source::file_name(&path);
    app.state::<AppState>().editor.lock().unwrap().offered = Some(path);
    let _ = OpenOffered { name }.emit_to(app, LABEL);
}

/// The page's answer to [`OpenOffered`]: add the file, replace the timeline's with it (`add`
/// false), or neither (`None`).
pub fn answer_offer(app: &AppHandle, add: Option<bool>) {
    let offered = app
        .state::<AppState>()
        .editor
        .lock()
        .unwrap()
        .offered
        .take();
    if let (Some(path), Some(add)) = (offered, add) {
        request_open(app, path, add);
    }
}

/// The Open dialog, starting in the folder last opened from; opens the picked file, or with
/// `add` adds it to the timeline.
pub fn ask_open(app: &AppHandle, add: bool) {
    let mut dialog = app
        .dialog()
        .file()
        .set_title(if add { "Add video" } else { "Open video" })
        .add_filter("Videos", EXTENSIONS)
        .add_filter("All files", &["*"]);
    if let Some(start) = crate::folders::open_start(app) {
        dialog = dialog.set_directory(start);
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        dialog = dialog.set_parent(&window);
    }
    let picked = dialog.blocking_pick_file().and_then(|p| {
        p.into_path()
            .map_err(|e| eprintln!("[editor] can't open the picked file: {e}"))
            .ok()
    });
    if let Some(path) = picked {
        request_open(app, path, add);
    }
}

/// Brings the editor to the front (a second launch).
pub fn focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
