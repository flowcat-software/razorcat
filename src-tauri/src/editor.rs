//! The main window: the editor. It opens hidden and shows once its page has loaded (no white
//! flash), and opens the files Razorcat is given: from Open, a drop, "Open with" or a second
//! launch. A project (`.rct`, project.rs) opens its videos and hands the page its document;
//! Save writes one.

use std::path::{Path, PathBuf};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_specta::Event;

use crate::media::grid::Rate;
use crate::placement::{self, Placement};
use crate::project;
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
    /// Started with Windows (PLAN 5b.8a): the window stays hidden as the page loads, till it's
    /// asked for.
    pub start_hidden: bool,
    /// It has been shown (the first time shows it maximized, if it was).
    shown: bool,
    /// The project open, once saved or opened (PLAN PR2): Save writes it.
    project: Option<PathBuf>,
    /// What the title names: the project, else the first file.
    title: String,
    /// The timeline has changes not saved (PLAN PR3), as the page says (`set_unsaved`): the title
    /// shows a dot, and quitting asks first.
    unsaved: bool,
}

/// Held while files open, so the files of one request, and requests one after another, open
/// in order: each its turn (PLAN 4.5e4).
static OPENING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Rust → editor: a file was opened (it replaces the timeline's files).
#[derive(Clone, Serialize, Type, Event)]
pub struct SourceOpened(pub SourceInfo);

/// Rust → editor: a project was opened (PLAN PR2): its videos, in its document's order, opened
/// in place of the timeline's files, and its document (the page's JSON, as saved).
#[derive(Clone, Serialize, Type, Event)]
pub struct ProjectOpened {
    /// Its name, without `.rct`.
    pub name: String,
    pub sources: Vec<SourceInfo>,
    pub doc: String,
    /// Unsaved work a run left behind (PLAN PR4), not the project as saved: `name` is its
    /// project's, or (`untitled`, never saved) the first video's.
    pub recovered: bool,
    pub untitled: bool,
}

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
    /// A recording just stopped (PLAN 5b.8c), not files dropped.
    pub recording: bool,
    /// A project (PLAN PR3): it can only replace the timeline, which has unsaved changes.
    pub project: bool,
}

/// Rust → editor: Razorcat is quitting (the tray's Quit, or closing the editor quits) with
/// unsaved changes (PLAN PR3): the page asks whether to save them, then `quit_now`.
#[derive(Clone, Serialize, Type, Event)]
pub struct QuitAsked;

/// Rust → editor: an update is to install, with unsaved changes: the page asks whether to save
/// them, as quitting does, and answers `update_answer` (Cancel: the update waits).
#[derive(Clone, Serialize, Type, Event)]
pub struct UpdateAsked;

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

/// The page has loaded: show the window (unless Razorcat started with Windows, in the tray), and
/// open a file asked for before then. Returns the open sources, first first (the page
/// reloaded), or none.
pub fn ready(app: &AppHandle) -> Vec<SourceInfo> {
    let (pending, hidden) = {
        let app_state = app.state::<AppState>();
        let mut state = app_state.editor.lock().unwrap();
        state.ready = true;
        (std::mem::take(&mut state.pending), state.start_hidden)
    };
    if !hidden {
        show_window(app);
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
    // From the tray (a recording, a second launch's file): the editor comes out.
    if !app.state::<AppState>().editor.lock().unwrap().start_hidden {
        show_window(app);
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
    // A project opens alone, in place of the timeline (its files with it).
    if let Some(project) = paths.iter().find(|p| is_project(p)).cloned() {
        crate::convert::cancel(app);
        let app = app.clone();
        std::thread::spawn(move || {
            let _turn = OPENING.lock().unwrap_or_else(|e| e.into_inner());
            open_project(&app, &project);
        });
        return;
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
    match load(app, &path, rate) {
        Some(opened) => {
            show(app, path, opened, add, at, true);
            true
        }
        None => false,
    }
}

/// `path` read (at `rate`, if it's added to a timeline at it), converted first if it must be;
/// none if it couldn't be (`OpenFailed` or `ConvertEnded` has told the page why).
fn load(app: &AppHandle, path: &Path, rate: Option<Rate>) -> Option<Source> {
    let opened = match source::open(path, None, rate) {
        // MKV, GIF...: opened from a converted copy.
        Err(OpenError::NeedsConversion) => match crate::convert::before_open(app, path) {
            Ok(Some(copy)) => source::open(path, Some(copy), rate),
            // Cancelled, or failed: `ConvertEnded` has told the page.
            Ok(None) | Err(_) => return None,
        },
        // The preview needed a copy of this one before (its codec): it plays that at once.
        Ok(mut opened) => {
            opened.playable = crate::convert::cached_for_preview(app, path);
            Ok(opened)
        }
        Err(e) => Err(e),
    };
    match opened {
        Ok(opened) => Some(opened),
        Err(e) => {
            let message = match e {
                OpenError::Failed(message) => message,
                OpenError::NeedsConversion => {
                    format!("{} can't be opened.", source::file_name(path))
                }
            };
            failed(app, message);
            None
        }
    }
}

fn failed(app: &AppHandle, message: String) {
    logln!("[editor] {message}");
    let _ = OpenFailed { message }.emit_to(app, LABEL);
}

/// Makes `opened` the timeline's file, or with `add` one more of them (before clip `at`, else on
/// the end): the title, the page (with `tell`; a project's are told together), its proxy.
fn show(
    app: &AppHandle,
    path: PathBuf,
    mut opened: Source,
    add: bool,
    at: Option<u32>,
    tell: bool,
) -> SourceInfo {
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
    // The title names the first file; a new edit, no project yet.
    if !add {
        app.state::<AppState>().editor.lock().unwrap().project = None;
        set_title(app, &info.name);
    }
    let id = info.id.clone();
    if tell {
        let told = if add {
            SourceAdded {
                source: info.clone(),
                at,
            }
            .emit_to(app, LABEL)
        } else {
            SourceOpened(info.clone()).emit_to(app, LABEL)
        };
        if let Err(e) = told {
            logln!("[editor] couldn't tell the page: {e}");
        }
    }
    if !add {
        crate::check::opened(app, id);
    }
    crate::wave::start(app, generation);
    crate::camera::look(app, generation);
    // The thumbnails come from the proxy, so they wait for one being made.
    if let Some((generation, input, rate, frames)) = make {
        crate::proxy::make(app, generation, path, input, rate, frames);
    } else {
        crate::thumbs::start(app, generation);
    }
    info
}

/// The window's title names `name` (a file's, or the project's) now.
fn set_title(app: &AppHandle, name: &str) {
    app.state::<AppState>().editor.lock().unwrap().title = name.into();
    show_title(app);
}

/// The timeline has changes not saved, or hasn't (the page says so as it changes: PLAN PR3).
pub fn set_unsaved(app: &AppHandle, unsaved: bool) {
    app.state::<AppState>().editor.lock().unwrap().unsaved = unsaved;
    show_title(app);
    // Nothing to recover (PLAN PR4).
    if !unsaved {
        crate::recovery::discard(app);
    }
}

/// The timeline has changes not saved, as the page last said.
pub fn is_unsaved(app: &AppHandle) -> bool {
    app.state::<AppState>().editor.lock().unwrap().unsaved
}

/// The project open, once saved or opened.
pub fn project_path(app: &AppHandle) -> Option<PathBuf> {
    app.state::<AppState>()
        .editor
        .lock()
        .unwrap()
        .project
        .clone()
}

/// The window's title: what's open (a dot before it while it has unsaved changes), then
/// Razorcat.
fn show_title(app: &AppHandle) {
    let (name, unsaved) = {
        let app_state = app.state::<AppState>();
        let state = app_state.editor.lock().unwrap();
        (state.title.clone(), state.unsaved)
    };
    let title = match (name.is_empty(), unsaved) {
        (true, _) => crate::product_name(app),
        (false, false) => format!("{name} — {}", crate::product_name(app)),
        (false, true) => format!("• {name} — {}", crate::product_name(app)),
    };
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.set_title(&title);
    }
}

/// Razorcat is to quit: with unsaved changes the editor comes out and asks first (PLAN PR3),
/// and true is returned (the page quits, `quit_now`, once answered); else false.
pub fn asks_before_quit(app: &AppHandle) -> bool {
    let (ready, unsaved) = {
        let app_state = app.state::<AppState>();
        let state = app_state.editor.lock().unwrap();
        (state.ready, state.unsaved)
    };
    if !ready || !unsaved {
        return false;
    }
    show_window(app);
    if let Err(e) = QuitAsked.emit_to(app, LABEL) {
        logln!("[editor] couldn't ask before quitting: {e}");
        return false;
    }
    true
}

/// An update is to install (updater.rs): with unsaved changes the editor comes out and asks
/// first, and true is returned (the answer comes back through `update_answer`); else false.
pub fn asks_before_update(app: &AppHandle) -> bool {
    let (ready, unsaved) = {
        let app_state = app.state::<AppState>();
        let state = app_state.editor.lock().unwrap();
        (state.ready, state.unsaved)
    };
    if !ready || !unsaved {
        return false;
    }
    show_window(app);
    if let Err(e) = UpdateAsked.emit_to(app, LABEL) {
        logln!("[editor] couldn't ask before updating: {e}");
        return false;
    }
    true
}

fn is_project(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(project::EXTENSION))
}

pub fn project_name(path: &Path) -> String {
    path.file_stem()
        .map_or_else(|| "Project".into(), |s| s.to_string_lossy().into_owned())
}

/// Opens project `path` (PLAN PR2).
fn open_project(app: &AppHandle, path: &Path) {
    let file_name = source::file_name(path);
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) => return failed(app, format!("{file_name} couldn't be read: {e}")),
    };
    let file = match project::read(&text, &file_name) {
        Ok(file) => file,
        Err(message) => return failed(app, message),
    };
    let dir = path.parent().unwrap_or(Path::new(""));
    open_document(app, file, &file_name, dir, Some(path), false);
}

/// Opens the autosave `path` a run left unsaved (PLAN PR4, recovery.rs), as the project it was
/// of (if it was saved), with its changes still unsaved. True once it's open.
pub fn open_recovered(app: &AppHandle, path: &Path) -> bool {
    let _turn = OPENING.lock().unwrap_or_else(|e| e.into_inner());
    crate::convert::cancel(app);
    let file = match std::fs::read_to_string(path)
        .map_err(|e| e.to_string())
        .and_then(|text| project::read(&text, "The unsaved work"))
    {
        Ok(file) => file,
        Err(e) => {
            failed(app, format!("The unsaved work couldn't be recovered: {e}"));
            return false;
        }
    };
    let project = file.recovers.clone().map(PathBuf::from);
    let dir = project
        .as_deref()
        .and_then(Path::parent)
        .unwrap_or(Path::new(""))
        .to_path_buf();
    open_document(
        app,
        file,
        "The unsaved work",
        &dir,
        project.as_deref(),
        true,
    )
}

/// Opens project document `file` (named `file_name`; its videos relative to folder `dir`) as
/// `project` (none: never saved) (PLAN PR2): its videos, each found beside it or where it was
/// (or asked for), all read before any replaces the timeline's, so one that can't open leaves
/// the timeline as it was; then its document goes to the page. True once it's open.
fn open_document(
    app: &AppHandle,
    file: project::ProjectFile,
    file_name: &str,
    dir: &Path,
    project: Option<&Path>,
    recovered: bool,
) -> bool {
    let fail = |message: String| {
        failed(app, message);
        false
    };
    let mut loaded: Vec<(PathBuf, Source)> = Vec::new();
    for s in &file.sources {
        let Some(found) = project::find(dir, s, Path::exists).or_else(|| locate(app, &s.path))
        else {
            let name = source::file_name(Path::new(&s.path));
            return fail(format!(
                "{file_name} wasn't opened: its video {name} couldn't be found."
            ));
        };
        // The first sets the rate the rest are gridded at, as when they were added.
        let rate = loaded.first().map(|(_, s)| s.grid.rate);
        let Some(opened) = load(app, &found, rate) else {
            return false;
        };
        loaded.push((found, opened));
    }
    if loaded.is_empty() {
        return fail(format!("{file_name} has no videos."));
    }
    let sources: Vec<SourceInfo> = loaded
        .into_iter()
        .enumerate()
        .map(|(i, (p, s))| show(app, p, s, i > 0, None, false))
        .collect();
    // Never saved, it's named for its first video (as `show` titled it).
    let name = project.map_or_else(|| sources[0].name.clone(), project_name);
    app.state::<AppState>().editor.lock().unwrap().project = project.map(Path::to_path_buf);
    set_title(app, &name);
    if let Some(path) = project {
        crate::log::private_file(path);
    }
    logln!(
        "[editor] {} a project of {} videos",
        if recovered { "recovered" } else { "opened" },
        file.sources.len()
    );
    let told = ProjectOpened {
        name,
        sources,
        doc: file.doc.to_string(),
        recovered,
        untitled: project.is_none(),
    };
    if let Err(e) = told.emit_to(app, LABEL) {
        logln!("[editor] couldn't tell the page: {e}");
    }
    true
}

/// A project's video `was` isn't where it was, or beside the project: asks where it is now.
fn locate(app: &AppHandle, was: &str) -> Option<PathBuf> {
    let name = source::file_name(Path::new(was));
    let mut dialog = app
        .dialog()
        .file()
        .set_title(format!("Where is {name}?"))
        .set_file_name(&name)
        .add_filter("Videos", EXTENSIONS)
        .add_filter("All files", &["*"]);
    if let Some(window) = app.get_webview_window(LABEL) {
        dialog = dialog.set_parent(&window);
    }
    dialog.blocking_pick_file()?.into_path().ok()
}

/// Saves the timeline as a project (PLAN PR2): `doc`, the page's document, showing `paths` in
/// its order. To the project open, unless `save_as` or there's none: then where the Save
/// dialog says. Its file name, once saved; none if the dialog was cancelled.
pub fn save_project(
    app: &AppHandle,
    doc: &str,
    paths: Vec<String>,
    save_as: bool,
) -> Result<Option<String>, String> {
    let doc: serde_json::Value =
        serde_json::from_str(doc).map_err(|e| format!("The project couldn't be saved: {e}"))?;
    let open = app
        .state::<AppState>()
        .editor
        .lock()
        .unwrap()
        .project
        .clone();
    let target = match open.filter(|_| !save_as) {
        Some(path) => path,
        None => match ask_save(app, &paths) {
            Some(path) => path,
            None => return Ok(None),
        },
    };
    let dir = target.parent().unwrap_or(Path::new(""));
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let text = project::write(dir, &paths, doc, &app.package_info().version.to_string());
    // Written beside it, then put in its place: a crash midway never leaves half a project.
    let partial = target.with_extension("rct.partial");
    std::fs::write(&partial, text)
        .and_then(|()| std::fs::rename(&partial, &target))
        .map_err(|e| {
            let _ = std::fs::remove_file(&partial);
            format!("{} couldn't be saved: {e}", source::file_name(&target))
        })?;
    app.state::<AppState>().editor.lock().unwrap().project = Some(target.clone());
    set_title(app, &project_name(&target));
    crate::log::private_file(&target);
    logln!("[editor] saved a project of {} videos", paths.len());
    Ok(Some(source::file_name(&target)))
}

/// The Save dialog for a project: named and placed as the project open, else after the first
/// video, beside it.
fn ask_save(app: &AppHandle, paths: &[String]) -> Option<PathBuf> {
    let open = app
        .state::<AppState>()
        .editor
        .lock()
        .unwrap()
        .project
        .clone();
    let first = paths.first().map(PathBuf::from);
    let like = open.as_deref().or(first.as_deref());
    let name = like.map_or_else(|| "Project".into(), project_name);
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save project")
        .set_file_name(format!("{name}.{}", project::EXTENSION))
        .add_filter("Razorcat projects", &[project::EXTENSION]);
    if let Some(folder) = like.and_then(Path::parent) {
        dialog = dialog.set_directory(folder);
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        dialog = dialog.set_parent(&window);
    }
    let mut path = dialog.blocking_save_file()?.into_path().ok()?;
    if !is_project(&path) {
        path.set_extension(project::EXTENSION);
    }
    Some(path)
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
    offer_as(app, paths, false);
}

/// A recording, done (PLAN 5b.8c): opened if the timeline is empty, else offered as dropped
/// files are, the editor asking whether it's added or replaces the timeline.
pub fn offer_recording(app: &AppHandle, path: PathBuf) {
    offer_as(app, vec![path], true);
}

fn offer_as(app: &AppHandle, paths: Vec<PathBuf>, recording: bool) {
    if paths.is_empty() {
        return;
    }
    // A project replaces the timeline, asking first if it has unsaved changes (PLAN PR3).
    if paths.iter().any(|p| is_project(p)) {
        let (ready, unsaved) = {
            let app_state = app.state::<AppState>();
            let state = app_state.editor.lock().unwrap();
            (state.ready, state.unsaved)
        };
        if !ready || !unsaved {
            request_open_all(app, paths, false);
            return;
        }
        let names = paths.iter().map(|p| source::file_name(p)).collect();
        app.state::<AppState>().editor.lock().unwrap().offered = paths;
        let _ = OpenOffered {
            names,
            recording: false,
            project: true,
        }
        .emit_to(app, LABEL);
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
    let _ = OpenOffered {
        names,
        recording,
        project: false,
    }
    .emit_to(app, LABEL);
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
        .set_title(if add { "Add video" } else { "Open" });
    // Open takes projects too (PLAN PR2); Add, videos only.
    if !add {
        let both: Vec<&str> = EXTENSIONS
            .iter()
            .copied()
            .chain([project::EXTENSION])
            .collect();
        dialog = dialog
            .add_filter("Videos and projects", &both)
            .add_filter("Razorcat projects", &[project::EXTENSION]);
    }
    dialog = dialog
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
    show_window(app);
}

/// The window shown, if it was hidden (in the tray) or minimized, and in front: maximized the
/// first time, if it was when it last closed.
pub fn show_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let first = {
        let app_state = app.state::<AppState>();
        let mut state = app_state.editor.lock().unwrap();
        state.start_hidden = false;
        let first = !state.shown;
        state.shown = true;
        first.then_some(state.show_maximized)
    };
    let shown = match first {
        Some(true) => placement::show_maximized(&window),
        _ => window.show(),
    };
    let _ = window.unminimize();
    if let Err(e) = shown.and_then(|_| window.set_focus()) {
        logln!("[editor] couldn't show the window: {e}");
    }
}
