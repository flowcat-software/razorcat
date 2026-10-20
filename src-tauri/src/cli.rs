//! Command-line arguments, for a first launch and for the ones a second launch forwards to the
//! running app.

use std::path::{Path, PathBuf};

/// The files to open: every argument after the program that isn't a `--flag`, made absolute
/// against `cwd` (a forwarded launch ran in its own directory). "Open with" and dropping a file
/// on the exe both pass the path this way.
pub fn file_paths(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with("--"))
        .map(|a| cwd.join(a))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn takes_every_path_after_the_program() {
        let got = file_paths(
            &args(&["razorcat.exe", "a.mp4", "--flag", r"D:\b.mov"]),
            Path::new(r"C:\work"),
        );
        assert_eq!(
            got,
            [PathBuf::from(r"C:\work\a.mp4"), PathBuf::from(r"D:\b.mov")]
        );
    }

    #[test]
    fn no_paths_without_arguments() {
        assert!(file_paths(&args(&["razorcat.exe"]), Path::new(".")).is_empty());
        assert!(file_paths(&[], Path::new(".")).is_empty());
    }
}
