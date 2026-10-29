//! Autosave and recovery after a crash (PLAN PR4). While the timeline has unsaved changes, the
//! page sends its document now and then (`autosave`), and it's written as a project file to
//! Razorcat's own folder, never over the project itself. Saved, or its changes let go, or
//! Razorcat quitting, the copy goes; so one that's there as Razorcat starts was left by a run
//! that ended without quitting, and the editor offers it back.
//!
//! The copy being written is `recovery.rct`. Found as the editor starts, it becomes
//! `recovered.rct`, the one offered, out of the way of the autosaves that follow.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};

use crate::{editor, project, source};

/// Held while the files are written, moved or removed, so an autosave can't land after its
/// changes were let go.
static FILES: Mutex<()> = Mutex::new(());

const LATEST: &str = "recovery.rct";
const FOUND: &str = "recovered.rct";

/// A run's unsaved work, left behind: what it was, and when it was last autosaved.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryOffer {
    /// The project's name, or (never saved) the first video's.
    pub name: String,
    /// Milliseconds since 1970.
    pub saved_at: f64,
}

fn dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("recovery"))
}

/// Writes the timeline's document `doc`, showing `paths`, as the copy to recover, if it still
/// has unsaved changes. True once it's written (false: it hadn't any).
pub fn autosave(app: &AppHandle, doc: &str, paths: Vec<String>) -> Result<bool, String> {
    let _held = FILES.lock().unwrap_or_else(|e| e.into_inner());
    if !editor::is_unsaved(app) {
        logln!("[recovery] autosave skipped: nothing unsaved");
        return Ok(false);
    }
    let doc: serde_json::Value = serde_json::from_str(doc).map_err(|e| e.to_string())?;
    let dir = dir(app).ok_or("There's no folder for autosaves.")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let open = editor::project_path(app);
    // Relative to the project, as it'd be saved; never saved, the absolute paths do.
    let base = open.as_deref().and_then(Path::parent).unwrap_or(&dir);
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let version = app.package_info().version.to_string();
    let text = project::write_recovery(base, &paths, doc, &version, open.as_deref());
    let partial = dir.join(format!("{LATEST}.partial"));
    let written = std::fs::write(&partial, text)
        .and_then(|()| std::fs::rename(&partial, dir.join(LATEST)))
        .map_err(|e| e.to_string());
    match &written {
        Ok(()) => logln!("[recovery] autosaved {} videos", paths.len()),
        Err(e) => logln!("[recovery] autosave failed: {e}"),
    }
    written.map(|()| true)
}

/// The timeline has nothing unsaved (saved, let go, or quitting): its copy goes.
pub fn discard(app: &AppHandle) {
    let _held = FILES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(dir) = dir(app) {
        let _ = std::fs::remove_file(dir.join(LATEST));
    }
}

/// What a run left unsaved, if one did (asked as the editor comes up; asked again, the same).
pub fn offer(app: &AppHandle) -> Option<RecoveryOffer> {
    let _held = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let dir = dir(app)?;
    let latest = dir.join(LATEST);
    let found = dir.join(FOUND);
    if latest.exists() {
        if let Err(e) = std::fs::rename(&latest, &found) {
            logln!("[recovery] couldn't set the autosave aside: {e}");
        }
    }
    let text = std::fs::read_to_string(&found).ok()?;
    let file = match project::read(&text, FOUND) {
        Ok(file) => file,
        Err(e) => {
            logln!("[recovery] {e}");
            let _ = std::fs::remove_file(&found);
            return None;
        }
    };
    let name = match (&file.recovers, file.sources.first()) {
        (Some(p), _) => editor::project_name(Path::new(p)),
        (None, Some(s)) => source::file_name(Path::new(&s.path)),
        (None, None) => return None,
    };
    let saved_at = std::fs::metadata(&found)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_millis() as f64);
    logln!("[recovery] found unsaved work");
    Some(RecoveryOffer { name, saved_at })
}

/// Opens what a run left unsaved, in place of the timeline: the copy becomes the one autosaved,
/// so it's kept till it's saved or let go.
pub fn recover(app: &AppHandle) -> Result<(), String> {
    let dir = dir(app).ok_or("There's nothing to recover.")?;
    let found = dir.join(FOUND);
    if editor::open_recovered(app, &found) {
        let _held = FILES.lock().unwrap_or_else(|e| e.into_inner());
        let _ = std::fs::rename(&found, dir.join(LATEST));
    }
    Ok(())
}

/// What a run left unsaved, let go.
pub fn forget(app: &AppHandle) {
    let _held = FILES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(dir) = dir(app) {
        let _ = std::fs::remove_file(dir.join(FOUND));
    }
}
