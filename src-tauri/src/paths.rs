//! Folder settings: stored with `%VARS%` (`%USERPROFILE%\Videos`), so they survive a profile
//! being renamed or moved, and expanded when used.

use std::path::PathBuf;

/// Expand `%NAME%` using `lookup`; unknown variables are left as-is.
pub fn expand_env(s: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match lookup(name) {
                    Some(v) => out.push_str(&v),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Inverse of [`expand_env`] for one variable: `C:\Users\me\Videos` → `%USERPROFILE%\Videos`.
pub fn contract_env(path: &str, name: &str, value: &str) -> String {
    let value = value.trim_end_matches('\\');
    if value.is_empty() || path.len() < value.len() || !path.is_char_boundary(value.len()) {
        return path.to_string();
    }
    let (head, rest) = path.split_at(value.len());
    if head.eq_ignore_ascii_case(value) && (rest.is_empty() || rest.starts_with('\\')) {
        format!("%{name}%{rest}")
    } else {
        path.to_string()
    }
}

/// A stored folder setting, with its `%VARS%` expanded.
pub fn resolve_dir(dir: &str) -> PathBuf {
    PathBuf::from(expand_env(dir, |k| std::env::var(k).ok()))
}

/// A picked folder as it's stored: under the profile, as `%USERPROFILE%\...`.
pub fn for_settings(path: &str) -> String {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    contract_env(path, "USERPROFILE", &home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_env_vars() {
        let lookup = |k: &str| match k {
            "USERPROFILE" => Some(r"C:\Users\Rich".to_string()),
            "EMPTY" => Some(String::new()),
            _ => None,
        };
        assert_eq!(
            expand_env(r"%USERPROFILE%\Videos\Proxies", lookup),
            r"C:\Users\Rich\Videos\Proxies"
        );
        assert_eq!(expand_env("%NOPE%/x", lookup), "%NOPE%/x");
        assert_eq!(expand_env("a%EMPTY%b", lookup), "ab");
        assert_eq!(expand_env("100% sure", lookup), "100% sure");
        assert_eq!(expand_env("%%", lookup), "%%");
        assert_eq!(expand_env("no vars", lookup), "no vars");
    }

    #[test]
    fn contracts_profile_prefix() {
        let home = r"C:\Users\Rich";
        assert_eq!(
            contract_env(r"C:\Users\Rich\Videos\Proxies", "USERPROFILE", home),
            r"%USERPROFILE%\Videos\Proxies"
        );
        assert_eq!(
            contract_env(r"c:\users\rich", "USERPROFILE", home),
            "%USERPROFILE%"
        );
        // Not a path-component boundary.
        assert_eq!(
            contract_env(r"C:\Users\Alice\x", "USERPROFILE", home),
            r"C:\Users\Alice\x"
        );
        assert_eq!(
            contract_env(r"D:\Proxies", "USERPROFILE", home),
            r"D:\Proxies"
        );
        assert_eq!(contract_env(r"C:\x", "USERPROFILE", ""), r"C:\x");
        let stored = contract_env(r"C:\Users\Rich\Videos", "USERPROFILE", home);
        assert_eq!(
            expand_env(&stored, |_| Some(home.to_string())),
            r"C:\Users\Rich\Videos"
        );
    }
}
