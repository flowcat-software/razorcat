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
pub(crate) const MIN_SIZE: (f64, f64) = (720.0, 480.0);

/// What the Open dialog offers. MP4 and MOV open directly; the rest are converted on open
/// (Phase 1.6). Keep in step with `windows/hooks.nsh` ("Open with").
pub const EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "mkv", "webm", "gif"];

#[derive(Default)]
pub struct EditorState {
    /// The page has called `editor_ready`; files open in it from now on.
    ready: bool,
    /// Files asked for before the page was ready; opened when it is.
    pending: Vec<PathBuf>,
    /// Where the window is when not maximized or minimized, kept up to date as it moves, so
    /// closing it maximized still remembers where it was.
    normal: Option<Placement>,
    /// It was maximized when it last closed: it shows maximized.
    show_maximized: bool,
    /// Files dropped (or launched with) while the timeline has files: the page asks whether
    /// to add them or replace its files (`answer_offer`).
    offered: Vec<PathBuf>,
}

/// Held while files open, so the files of one request, and requests one after another, open
/// in order: each its turn (PLAN 4.5e4).
static OPENING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Rust → editor: a file was opened (it replaces the timeline's files).
#[derive(Clone, Serialize, Type, Event)]
pub struct SourceOpened(pub SourceInfo);

/// Rust → editor: a file was added to the timeline's (PLAN 4.5e): it goes before clip `at` (its
/// index), else on the end.
#[derive(Clone, Serialize, Type, Event)]
pub struct SourceAdded {
    pub source: SourceInfo,
    pub at: Option<u32>,
}

/// Rust → editor: files are being dragged over the window, the pointer here (CSS pixels in the
/// page), or (`over` false) no longer: the timeline shows where they'd go in (PLAN 4.5e5).
#[derive(Clone, Serialize, Type, Event)]
pub struct DropHover {
    pub x: f64,
    pub y: f64,
    pub over: bool,
}

/// Rust → editor: files were dropped on the window (or launched with) while the timeline has
/// files: ask whether to add them or replace its files, then `answer_offer` (PLAN 4.5e3).
#[derive(Clone, Serialize, Type, Event)]
pub struct OpenOffered {
    /// Their file names, in order.
    pub names: Vec<String>,
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
    crate::webview_crash::watch(&window);
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
        (std::mem::take(&mut state.pending), state.show_maximized)
    };
    let shown = if maximized {
        placement::show_maximized(window)
    } else {
        window.show()
    };
    if let Err(e) = shown.and_then(|_| window.set_focus()) {
        logln!("[editor] couldn't show the window: {e}");
    }
    request_open_all(app, pending, false);
    let state = app.state::<AppState>();
    let sources = state.sources.lock().unwrap();
    sources.iter().map(Source::info).collect()
}

/// Open `path` in the editor (`request_open_all`, one file).
pub fn request_open(app: &AppHandle, path: PathBuf, add: bool) {
    request_open_all(app, vec![path], add);
}

/// Open `paths` in the editor, in order, one after another: now if its page is ready, else once
/// it is (files asked for while others wait replace them). The first replaces the timeline's
/// files, the rest go on the end; with `add`, they all do, at the timeline's rate (PLAN 4.5e;
/// with none open, adding is opening).
pub fn request_open_all(app: &AppHandle, paths: Vec<PathBuf>, add: bool) {
    request_open_at(app, paths, add, None);
}

/// As `request_open_all`, the added files going in before clip `at` (its index on the
/// timeline), else on the end (PLAN 4.5e5).
pub fn request_open_at(app: &AppHandle, paths: Vec<PathBuf>, add: bool, at: Option<u32>) {
    if paths.is_empty() {
        return;
    }
    for path in &paths {
        crate::log::private_file(path);
        logln!("[editor] open {}", path.display());
    }
    {
        let app_state = app.state::<AppState>();
        let mut state = app_state.editor.lock().unwrap();
        if !state.ready {
            state.pending = paths;
            return;
        }
    }
    // A file being converted for opening is replaced by these (an added one is let finish).
    if !add {
        crate::convert::cancel(app);
    }
    // Reading the index takes milliseconds, but it's file I/O (and converting takes longer): off
    // the main thread.
    let app = app.clone();
    std::thread::spawn(move || {
        let _turn = OPENING.lock().unwrap_or_else(|e| e.into_inner());
        // Once one has replaced the timeline's files, the rest are added; inserted ones go one
        // after another.
        let mut add = add;
        let mut at = at;
        for path in paths {
            let added = add;
            if open_one(&app, path, add, at) {
                add = true;
                if added {
                    at = at.map(|k| k + 1);
                }
            }
        }
    });
}

/// Opens `path` (`add`: onto the timeline, before clip `at` or on the end); true if it opened.
fn open_one(app: &AppHandle, path: PathBuf, add: bool, at: Option<u32>) -> bool {
    // Added: gridded at the timeline's rate (the first file's).
    let rate = {
        let state = app.state::<AppState>();
        let sources = state.sources.lock().unwrap();
        sources.first().filter(|_| add).map(|s| s.grid.rate)
    };
    let add = rate.is_some();
    let opened = match source::open(&path, None, rate) {
        // MKV, GIF...: opened from a converted copy.
        Err(OpenError::NeedsConversion) => match crate::convert::before_open(app, &path) {
            Ok(Some(copy)) => source::open(&path, Some(copy), rate),
            // Cancelled, or failed: `ConvertEnded` has told the page.
            Ok(None) | Err(_) => return false,
        },
        // The preview needed a copy of this one before (its codec): it plays that at once.
        Ok(mut opened) => {
            opened.playable = crate::convert::cached_for_preview(app, &path);
            Ok(opened)
        }
        Err(e) => Err(e),
    };
    match opened {
        Ok(opened) => {
            show(app, path, opened, add, at);
            true
        }
        Err(e) => {
            let message = match e {
                OpenError::Failed(message) => message,
                OpenError::NeedsConversion => {
                    format!("{} can't be opened.", source::file_name(&path))
                }
            };
            logln!("[editor] {message}");
            let _ = OpenFailed { message }.emit_to(app, LABEL);
            false
        }
    }
}

/// Makes `opened` the timeline's file, or with `add` one more of them (before clip `at`, else on
/// the end): the title, the page, its proxy.
fn show(app: &AppHandle, path: PathBuf, mut opened: Source, add: bool, at: Option<u32>) {
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
    // The file by its facts, never its name (the log's file scrubs it anyway).
    let kind = path.extension().map_or_else(
        || "no extension".into(),
        |e| e.to_string_lossy().to_lowercase(),
    );
    let megabytes = std::fs::metadata(&path).map_or(0.0, |m| m.len() as f64 / 1e6);
    logln!(
        "[editor] {} a {kind} of {megabytes:.1} MB: {}x{} {} at {}/{} fps, {} frames{}{}",
        if add { "added" } else { "opened" },
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
        SourceAdded { source: info, at }.emit_to(app, LABEL)
    } else {
        SourceOpened(info).emit_to(app, LABEL)
    };
    if let Err(e) = told {
        logln!("[editor] couldn't tell the page: {e}");
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

/// Files are dragged over the window, the pointer at `at` (CSS pixels), or (`None`) no longer.
pub fn drop_hover(app: &AppHandle, at: Option<(f64, f64)>) {
    let (x, y) = at.unwrap_or_default();
    let _ = DropHover {
        x,
        y,
        over: at.is_some(),
    }
    .emit_to(app, LABEL);
}

/// Files dropped on the window, or a launch's: opened if the timeline is empty, else offered
/// (the page asks whether to add them or replace the timeline's files).
pub fn offer(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let empty = {
        let state = app.state::<AppState>();
        let sources = state.sources.lock().unwrap();
        sources.is_empty()
    };
    let ready = app.state::<AppState>().editor.lock().unwrap().ready;
    if empty || !ready {
        request_open_all(app, paths, false);
        return;
    }
    let names = paths.iter().map(|p| source::file_name(p)).collect();
    app.state::<AppState>().editor.lock().unwrap().offered = paths;
    let _ = OpenOffered { names }.emit_to(app, LABEL);
}

/// The page's answer to [`OpenOffered`]: add the files, replace the timeline's with them (`add`
/// false), or neither (`None`). Added, they go before clip `at` (its index), else on the end.
pub fn answer_offer(app: &AppHandle, add: Option<bool>, at: Option<u32>) {
    let offered = std::mem::take(&mut app.state::<AppState>().editor.lock().unwrap().offered);
    if let Some(add) = add {
        request_open_at(app, offered, add, at.filter(|_| add));
    }
}

/// The Open dialog, starting in the folder last opened from; opens the picked files (the first
/// replacing the timeline's, the rest after it), or with `add` adds them to the timeline.
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
    let picked: Vec<PathBuf> = dialog
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| {
            p.into_path()
                .map_err(|e| logln!("[editor] can't open the picked file: {e}"))
                .ok()
        })
        .collect();
    request_open_all(app, picked, add);
}

/// Brings the editor to the front (a second launch).
pub fn focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
