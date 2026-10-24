//! Export file names from Settings › Export's templates, with Vandal's tags (its `output.rs`):
//! `{yyyy} {MM} {dd}` the date, `{HH} {mm} {ss}` the time, `{n}` a number that counts up past
//! the highest in the folder (`{nn}` 01, `{nnn}` 001...), and Razorcat's own: `{name}` the
//! video's name, `{c}` a clip's number (`{cc}` 01...).

use std::path::Path;

/// A moment, local time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Timestamp {
    pub year: u16,
    pub month: u16,
    pub day: u16,
    pub hour: u16,
    pub minute: u16,
    pub second: u16,
}

impl Timestamp {
    pub fn now_local() -> Self {
        let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
        Self {
            year: t.wYear,
            month: t.wMonth,
            day: t.wDay,
            hour: t.wHour,
            minute: t.wMinute,
            second: t.wSecond,
        }
    }
}

/// `template` with everything but the auto number filled in: `{name}` as `name`, `{c}`...
/// as `clip` (padded to the braces' letters; left as it is with no clip), the date and time; a
/// valid file name.
pub fn render(template: &str, name: &str, clip: Option<u32>, t: &Timestamp) -> String {
    // The video's name goes in last (a name with braces in it is never taken for a tag), held
    // meanwhile by a character no template has.
    const HELD: char = '\u{E000}';
    let dated = template
        .replace("{name}", &HELD.to_string())
        .replace("{yyyy}", &format!("{:04}", t.year))
        .replace("{MM}", &format!("{:02}", t.month))
        .replace("{dd}", &format!("{:02}", t.day))
        .replace("{HH}", &format!("{:02}", t.hour))
        .replace("{mm}", &format!("{:02}", t.minute))
        .replace("{ss}", &format!("{:02}", t.second));
    let clipped = match clip {
        Some(c) => fill(&dated, 'c', |width| format!("{c:0width$}")),
        None => dated,
    };
    sanitize(&clipped).replace(HELD, name)
}

/// A rendered name's auto numbers (`{n}`...) filled with one more than the highest among
/// `taken` (file names without extensions) that fit it, letter case aside; 1 if none do. Gaps
/// aren't refilled.
pub fn number(rendered: &str, taken: impl IntoIterator<Item = String>) -> String {
    let parts = split(rendered, 'n');
    if !parts.iter().any(|p| matches!(p, Part::Tag(_))) {
        return rendered.to_string();
    }
    let next = taken
        .into_iter()
        .filter_map(|name| number_in(&name, &parts))
        .max()
        .map_or(1, |n| n.saturating_add(1));
    parts
        .iter()
        .map(|p| match p {
            Part::Text(text) => (*text).to_string(),
            Part::Tag(width) => format!("{next:0width$}"),
        })
        .collect()
}

/// The names (without extensions) of the files in `dir`, for [`number`].
pub fn taken_in(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            e.path()
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
        })
        .collect()
}

/// A clip template from before `{c}`: its `{n}`, `{nn}`... (then the clip's number) become
/// `{c}`, `{cc}`... (settings version 2).
pub fn clip_tags_from_v1(template: &str) -> String {
    fill(template, 'n', |width| format!("{{{}}}", "c".repeat(width)))
}

/// A piece of a template: text, or a tag of one letter repeated (`{n}`, `{nnn}`), its count.
#[derive(Debug, PartialEq)]
enum Part<'a> {
    Text(&'a str),
    Tag(usize),
}

fn split(s: &str, letter: char) -> Vec<Part<'_>> {
    let open = format!("{{{letter}");
    let mut parts = Vec::new();
    let mut rest = s;
    while let Some(start) = rest.find(&open) {
        let count = rest[start + 1..]
            .chars()
            .take_while(|&c| c == letter)
            .count();
        if rest[start + 1 + count..].starts_with('}') {
            if start > 0 {
                parts.push(Part::Text(&rest[..start]));
            }
            parts.push(Part::Tag(count));
            rest = &rest[start + count + 2..];
        } else {
            // "{name}" for 'n', and the like: text.
            parts.push(Part::Text(&rest[..start + 2]));
            rest = &rest[start + 2..];
        }
    }
    if !rest.is_empty() {
        parts.push(Part::Text(rest));
    }
    parts
}

/// `s` with each tag of `letter` replaced by `with(its count)`.
fn fill(s: &str, letter: char, with: impl Fn(usize) -> String) -> String {
    split(s, letter)
        .iter()
        .map(|p| match p {
            Part::Text(text) => (*text).to_string(),
            Part::Tag(count) => with(*count),
        })
        .collect()
}

/// The number in `name` where `parts` has its first auto number, if `name` fits `parts`.
fn number_in(name: &str, parts: &[Part]) -> Option<u64> {
    let name = name.to_lowercase();
    let mut rest = name.as_str();
    let mut found = None;
    for part in parts {
        match part {
            Part::Text(text) => rest = rest.strip_prefix(text.to_lowercase().as_str())?,
            Part::Tag(_) => {
                let len = rest.bytes().take_while(u8::is_ascii_digit).count();
                if len == 0 {
                    return None;
                }
                let n = rest[..len].parse().ok()?;
                found.get_or_insert(n);
                rest = &rest[len..];
            }
        }
    }
    rest.is_empty().then_some(found).flatten()
}

/// Characters Windows forbids in file names replaced; never empty.
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    // Windows drops trailing dots and spaces, which would change the name.
    let trimmed = cleaned.trim_start().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        "Razorcat export".into()
    } else {
        trimmed.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Timestamp = Timestamp {
        year: 2026,
        month: 10,
        day: 6,
        hour: 7,
        minute: 5,
        second: 9,
    };

    #[test]
    fn fills_the_name_clip_date_and_time() {
        assert_eq!(render("{name}-edit", "trip", None, &T), "trip-edit");
        assert_eq!(
            render("{name} {yyyy}-{MM}-{dd} {HH}.{mm}.{ss}", "trip", None, &T),
            "trip 2026-10-06 07.05.09"
        );
        assert_eq!(
            render("{name}-clip{cc}", "trip", Some(3), &T),
            "trip-clip03"
        );
        assert_eq!(render("{c}-{ccc}", "trip", Some(12), &T), "12-012");
        // Unknown tags stay; the auto number waits for `number`.
        assert_eq!(
            render("{foo} {n} {nnn}", "x", Some(1), &T),
            "{foo} {n} {nnn}"
        );
        // A video's name is never taken for a tag.
        assert_eq!(render("{name}", "{n} {c}", Some(4), &T), "{n} {c}");
    }

    #[test]
    fn makes_a_valid_file_name() {
        assert_eq!(render("{name}: take 2?", "trip", None, &T), "trip- take 2-");
        assert_eq!(render("  ...", "x", None, &T), "Razorcat export");
    }

    #[test]
    fn counts_up_past_the_highest() {
        let taken = |names: &[&str]| names.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(number("trip {n}", taken(&[])), "trip 1");
        assert_eq!(
            number("trip {n}", taken(&["trip 1", "TRIP 4", "trip x"])),
            "trip 5"
        );
        assert_eq!(number("trip {nnn}", taken(&["trip 009"])), "trip 010");
        // Only names that fit: another day's, or another template's, don't count.
        assert_eq!(
            number("2026-10-06 {n}", taken(&["2026-10-05 7", "2026-10-06 2"])),
            "2026-10-06 3"
        );
        // No auto number: as it is.
        assert_eq!(number("trip-edit", taken(&["trip-edit"])), "trip-edit");
    }

    #[test]
    fn old_clip_templates_take_c() {
        assert_eq!(clip_tags_from_v1("{name}-clip{nn}"), "{name}-clip{cc}");
        assert_eq!(clip_tags_from_v1("{n} of {name}"), "{c} of {name}");
        assert_eq!(clip_tags_from_v1("{name}-edit"), "{name}-edit");
    }
}
