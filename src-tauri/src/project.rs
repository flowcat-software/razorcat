//! Project files (PLAN PR2): a `.rct` file is JSON holding the editor's document as the page
//! keeps it (doc.ts), and the videos its clips show, in the document's order. Each video is
//! kept by its path relative to the project and its absolute path, so a folder moved with its
//! videos still opens, and so does a project moved away from them.
//!
//! Rust doesn't read the document: it's the page's, carried whole. `version` is the file's
//! format, raised when either changes so an older file can be brought up to date.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The extension, without its dot.
pub const EXTENSION: &str = "rct";

/// The format written now. A file of a higher one came from a newer Razorcat.
pub const VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectFile {
    /// Says what the file is, so a stray JSON file isn't taken for one.
    pub razorcat: String,
    pub version: u32,
    /// The Razorcat that wrote it, for a report.
    #[serde(default)]
    pub app: String,
    pub sources: Vec<ProjectSource>,
    /// The page's document.
    pub doc: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ProjectSource {
    pub path: String,
    /// From the project's folder (`..` steps up); none on another drive.
    #[serde(default)]
    pub relative: Option<String>,
}

const KIND: &str = "project";

/// The file for `doc` showing `paths`, saved in folder `dir`, as written: packed, as no one
/// reads it by hand (a JSON formatter lays it out).
pub fn write(dir: &Path, paths: &[PathBuf], doc: serde_json::Value, app: &str) -> String {
    let file = ProjectFile {
        razorcat: KIND.into(),
        version: VERSION,
        app: app.into(),
        sources: paths
            .iter()
            .map(|p| ProjectSource {
                path: p.to_string_lossy().into_owned(),
                relative: relative(dir, p).map(|r| r.to_string_lossy().into_owned()),
            })
            .collect(),
        doc,
    };
    serde_json::to_string(&file).expect("a project serializes")
}

/// The project in `text` (a file named `name`), or why it can't be read.
pub fn read(text: &str, name: &str) -> Result<ProjectFile, String> {
    let file: ProjectFile = serde_json::from_str(text)
        .ok()
        .filter(|f: &ProjectFile| f.razorcat == KIND)
        .ok_or_else(|| format!("{name} isn't a Razorcat project, or it's damaged."))?;
    if file.version > VERSION {
        return Err(format!(
            "{name} was saved by a newer Razorcat: update Razorcat to open it."
        ));
    }
    Ok(file)
}

/// `file` from folder `dir`, stepping up with `..` as far as needed; none on another drive (or
/// either isn't absolute).
pub fn relative(dir: &Path, file: &Path) -> Option<PathBuf> {
    if !dir.is_absolute() || !file.is_absolute() {
        return None;
    }
    let a: Vec<Component> = dir.components().collect();
    let b: Vec<Component> = file.components().collect();
    // Windows paths compare without case.
    let same = |x: &Component, y: &Component| {
        x.as_os_str().to_string_lossy().to_lowercase()
            == y.as_os_str().to_string_lossy().to_lowercase()
    };
    if a.is_empty() || b.is_empty() || !same(&a[0], &b[0]) {
        return None;
    }
    let common = a.iter().zip(&b).take_while(|(x, y)| same(x, y)).count();
    let mut out = PathBuf::new();
    for _ in common..a.len() {
        out.push("..");
    }
    for c in &b[common..] {
        out.push(c.as_os_str());
    }
    Some(out)
}

/// Where source `s` of a project in folder `dir` is now: beside the project as it was, else
/// where it was; none if it's in neither place.
pub fn find(dir: &Path, s: &ProjectSource, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let beside = s.relative.as_ref().map(|r| normalize(&dir.join(r)));
    let was = PathBuf::from(&s.path);
    beside
        .into_iter()
        .chain(std::iter::once(was))
        .find(|p| exists(p))
}

/// `p` with its `..` and `.` worked out (without asking the disk).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_steps_down_and_up() {
        let dir = Path::new(r"C:\Users\me\Videos\Project");
        assert_eq!(
            relative(dir, Path::new(r"C:\Users\me\Videos\Project\a.mp4")),
            Some(PathBuf::from("a.mp4"))
        );
        assert_eq!(
            relative(dir, Path::new(r"C:\Users\me\Videos\clips\b.mp4")),
            Some(PathBuf::from(r"..\clips\b.mp4"))
        );
        assert_eq!(
            relative(dir, Path::new(r"c:\users\ME\videos\project\sub\c.mp4")),
            Some(PathBuf::from(r"sub\c.mp4"))
        );
    }

    #[test]
    fn another_drive_has_no_relative_path() {
        let dir = Path::new(r"C:\Videos");
        assert_eq!(relative(dir, Path::new(r"D:\Videos\a.mp4")), None);
    }

    #[test]
    fn a_project_reads_back_what_it_wrote() {
        let dir = Path::new(r"C:\Videos\Project");
        let paths = [PathBuf::from(r"C:\Videos\Project\a.mp4")];
        let doc = serde_json::json!({ "clips": [], "nextId": 2 });
        let text = write(dir, &paths, doc.clone(), "0.1.0");
        let file = read(&text, "p.rct").unwrap();
        assert_eq!(file.version, VERSION);
        assert_eq!(file.doc, doc);
        assert_eq!(
            file.sources,
            vec![ProjectSource {
                path: r"C:\Videos\Project\a.mp4".into(),
                relative: Some("a.mp4".into()),
            }]
        );
    }

    #[test]
    fn other_files_and_newer_projects_are_refused() {
        assert!(read("{}", "x.rct")
            .unwrap_err()
            .contains("isn't a Razorcat project"));
        assert!(read("not json", "x.rct").is_err());
        let newer = format!(
            r#"{{"razorcat":"project","version":{},"sources":[],"doc":{{}}}}"#,
            VERSION + 1
        );
        assert!(read(&newer, "x.rct")
            .unwrap_err()
            .contains("newer Razorcat"));
    }

    #[test]
    fn a_video_is_found_beside_the_project_first() {
        let s = ProjectSource {
            path: r"C:\Old\Project\a.mp4".into(),
            relative: Some("a.mp4".into()),
        };
        let moved = Path::new(r"D:\New\Project");
        let found = find(moved, &s, |p| p == Path::new(r"D:\New\Project\a.mp4"));
        assert_eq!(found, Some(PathBuf::from(r"D:\New\Project\a.mp4")));
        // Not beside it: where it was.
        let found = find(moved, &s, |p| p == Path::new(r"C:\Old\Project\a.mp4"));
        assert_eq!(found, Some(PathBuf::from(r"C:\Old\Project\a.mp4")));
        assert_eq!(find(moved, &s, |_| false), None);
        // Up a folder.
        let up = ProjectSource {
            path: r"C:\Old\clips\b.mp4".into(),
            relative: Some(r"..\clips\b.mp4".into()),
        };
        let found = find(moved, &up, |p| p == Path::new(r"D:\New\clips\b.mp4"));
        assert_eq!(found, Some(PathBuf::from(r"D:\New\clips\b.mp4")));
    }
}
