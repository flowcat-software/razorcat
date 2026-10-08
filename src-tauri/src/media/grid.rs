//! The timeline's frame grid for a source (PLAN §3, VFR option B): a constant rate taken from
//! the frames themselves, not the container's claimed rate (an iPhone clip claims 120 fps for
//! ~30), and for each grid frame the source frame it shows.
//!
//! The rule is ffmpeg's `fps` filter's, so the preview and export pick the same frames: each
//! source frame goes to the grid slot its time rounds to, and a grid frame shows the latest
//! source frame in a slot at or before it (a later frame in the same slot replaces an earlier
//! one; an empty slot repeats the previous frame). The frame check (check.rs) confirms it
//! against ffmpeg on the test clips.

use super::mp4::VideoIndex;

/// Frames per second as a fraction, e.g. 30000/1001.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rate {
    pub num: u32,
    pub den: u32,
}

impl Rate {
    pub fn fps(self) -> f64 {
        f64::from(self.num) / f64::from(self.den)
    }
}

/// The rates cameras and recorders use. A measured rate this close to one is that one.
const STANDARD: [(u32, u32); 15] = [
    (24000, 1001),
    (24, 1),
    (25, 1),
    (30000, 1001),
    (30, 1),
    (48, 1),
    (50, 1),
    (60000, 1001),
    (60, 1),
    (90, 1),
    (100, 1),
    (120000, 1001),
    (120, 1),
    (144, 1),
    (240, 1),
];

#[derive(Debug, Clone, PartialEq)]
pub struct Grid {
    pub rate: Rate,
    /// Grid frames, from the first shown frame to the end of the last.
    pub frames: u32,
    /// For each grid frame, the source frame shown (an index into the `VideoIndex`, which is in
    /// decode order).
    pub source: Vec<u32>,
    /// The source's frame times vary (a phone clip): some grid frames repeat a source frame or
    /// skip one.
    pub variable: bool,
}

/// The grid for a video track; `None` if it has no shown frames.
pub fn build(v: &VideoIndex) -> Option<Grid> {
    // Shown frames in presentation order (the edit list hides those before 0).
    let mut shown: Vec<u32> = (0..v.len() as u32)
        .filter(|&i| v.pts[i as usize] >= 0)
        .collect();
    shown.sort_by_key(|&i| v.pts[i as usize]);
    let first = *shown.first()?;
    let start = v.pts[first as usize];

    let deltas: Vec<u64> = shown
        .windows(2)
        .map(|w| (v.pts[w[1] as usize] - v.pts[w[0] as usize]) as u64)
        .filter(|&d| d > 0)
        .collect();
    let (count, sum) = typical_gap(&deltas).unwrap_or((1, u64::from(v.last_duration.max(1))));
    let rate = rate_for(v.timescale, count, sum);
    let typical = sum / count;
    let variable = deltas.iter().any(|&d| d.abs_diff(typical) * 20 > typical);

    // The clip ends when its last frame does.
    let last = v.pts[*shown.last()? as usize];
    let last_len = if v.last_duration > 0 {
        u64::from(v.last_duration)
    } else {
        typical
    };
    let span = (last - start) as u64 + last_len;
    let frames = slot(span, v.timescale, rate).max(1) as u32;

    let mut source = Vec::with_capacity(frames as usize);
    let mut k = 0;
    for n in 0..u64::from(frames) {
        // Advance to the latest shown frame whose slot is at or before n.
        while k + 1 < shown.len()
            && slot(
                (v.pts[shown[k + 1] as usize] - start) as u64,
                v.timescale,
                rate,
            ) <= n
        {
            k += 1;
        }
        source.push(shown[k]);
    }
    Some(Grid {
        rate,
        frames,
        source,
        variable,
    })
}

/// Where each grid frame's picture is in the source, in seconds on the player's clock (the
/// presentation times, as `<video>` reports them): for each grid frame, when its source frame
/// starts showing and the middle of that frame. The player seeks to the middle, so rounding
/// can't land on a neighbour, and reads the start to tell which grid frame is on screen.
pub fn times(v: &VideoIndex, g: &Grid) -> Vec<(f64, f64)> {
    let mut shown: Vec<u32> = (0..v.len() as u32)
        .filter(|&i| v.pts[i as usize] >= 0)
        .collect();
    shown.sort_by_key(|&i| v.pts[i as usize]);
    // Where each source frame stops showing: when the next one starts, or after the last's
    // duration.
    let mut end = vec![0i64; v.len()];
    for w in shown.windows(2) {
        end[w[0] as usize] = v.pts[w[1] as usize];
    }
    if let Some(&last) = shown.last() {
        let p = v.pts[last as usize];
        let len = if v.last_duration > 0 {
            i64::from(v.last_duration)
        } else {
            // No duration recorded: as long as the gap before it.
            shown
                .len()
                .checked_sub(2)
                .map_or(1, |i| p - v.pts[shown[i] as usize])
        };
        end[last as usize] = p + len.max(1);
    }
    let ts = f64::from(v.timescale);
    g.source
        .iter()
        .map(|&i| {
            let (a, b) = (v.pts[i as usize], end[i as usize]);
            (a as f64 / ts, (a + b) as f64 / 2.0 / ts)
        })
        .collect()
}

/// The grid slot a time (ticks from the start) rounds to: `round(t * rate / timescale)`.
fn slot(ticks: u64, timescale: u32, rate: Rate) -> u64 {
    let a = u128::from(ticks) * u128::from(rate.num);
    let b = u128::from(timescale) * u128::from(rate.den);
    ((2 * a + b) / (2 * b)) as u64
}

/// The gap between frames that most frames share, as (how many gaps, their total ticks): the
/// gap with the most gaps within 10% of it (ties: the shorter), averaged over those. Timestamps
/// rounded to a coarse timescale jitter by a tick (an iPhone's 29.97 fps at 1/600 s is gaps of
/// 20 and 21), which the average absorbs. Longer gaps, from dropped frames (twice the gap) or
/// a camera slowing in low light (25 for 20), don't count: they're what the grid repeats
/// frames for, not the rate.
fn typical_gap(deltas: &[u64]) -> Option<(u64, u64)> {
    let mut d = deltas.to_vec();
    d.sort_unstable();
    // The gaps within 10% of `v`: a range of the sorted list.
    let near = |v: u64| {
        let lo = d.partition_point(|&x| x < v && (v - x) * 10 > v);
        let hi = d.partition_point(|&x| x <= v || (x - v) * 10 <= v);
        lo..hi
    };
    let (mut best, mut i) = (0..0, 0);
    while i < d.len() {
        let r = near(d[i]);
        if r.len() > best.len() {
            best = r;
        }
        i += d[i..].iter().take_while(|&&x| x == d[i]).count();
    }
    if best.is_empty() {
        return None;
    }
    Some((best.len() as u64, d[best].iter().sum()))
}

/// The rate for `count` gaps totalling `sum` ticks: the nearest standard rate if within 1%,
/// else the measured one, exact when it fits (else to a thousandth of a frame per second).
fn rate_for(timescale: u32, count: u64, sum: u64) -> Rate {
    let measured = f64::from(timescale) * count as f64 / sum as f64;
    let nearest = STANDARD
        .iter()
        .map(|&(num, den)| {
            let r = f64::from(num) / f64::from(den);
            ((measured - r).abs() / r, num, den)
        })
        .min_by(|a, b| a.0.total_cmp(&b.0));
    if let Some((off, num, den)) = nearest {
        if off < 0.01 {
            return Rate { num, den };
        }
    }
    let (num, den) = (u64::from(timescale) * count, sum.max(1));
    let g = gcd(num, den);
    let (num, den) = (num / g, den / g);
    if let (Ok(num), Ok(den)) = (u32::try_from(num), u32::try_from(den)) {
        return Rate { num, den };
    }
    let num = (measured * 1000.0).round().max(1.0) as u64;
    let g = gcd(num, 1000);
    Rate {
        num: (num / g) as u32,
        den: (1000 / g) as u32,
    }
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a.max(1)
    } else {
        gcd(b, a % b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A track with frames at these presentation times, in decode order.
    fn track(timescale: u32, pts: &[i64], last_duration: u32) -> VideoIndex {
        VideoIndex {
            timescale,
            pts: pts.to_vec(),
            size: vec![1; pts.len()],
            offset: vec![0; pts.len()],
            key: vec![true; pts.len()],
            last_duration,
        }
    }

    #[test]
    fn constant_rate_maps_one_to_one() {
        let pts: Vec<i64> = (0..450).map(|i| i * 512).collect();
        let g = build(&track(15360, &pts, 512)).unwrap();
        assert_eq!(g.rate, Rate { num: 30, den: 1 });
        assert_eq!(g.frames, 450);
        assert_eq!(g.source, (0..450).collect::<Vec<u32>>());
        assert!(!g.variable);
    }

    #[test]
    fn ntsc_rates_are_recognised() {
        let pts: Vec<i64> = (0..10).map(|i| i * 1001).collect();
        let g = build(&track(30000, &pts, 1001)).unwrap();
        assert_eq!(
            g.rate,
            Rate {
                num: 30000,
                den: 1001
            }
        );
        let pts: Vec<i64> = (0..10).map(|i| i * 3003).collect();
        assert_eq!(build(&track(90000, &pts, 3003)).unwrap().rate.num, 30000);
    }

    #[test]
    fn an_odd_rate_stays_exact() {
        let pts: Vec<i64> = (0..10).map(|i| i * 7).collect();
        let g = build(&track(100, &pts, 7)).unwrap();
        assert_eq!(g.rate, Rate { num: 100, den: 7 });
    }

    #[test]
    fn dropped_frames_repeat_the_previous_one() {
        // 60 fps with frames 2 and 5 missing: the grid stays at 60 and shows 1 twice, 4 twice.
        let pts = [0, 256, 768, 1024, 1536];
        let g = build(&track(15360, &pts, 256)).unwrap();
        assert_eq!(g.rate, Rate { num: 60, den: 1 });
        assert_eq!(g.frames, 7);
        assert_eq!(g.source, [0, 1, 1, 2, 3, 3, 4]);
        assert!(g.variable);
    }

    #[test]
    fn times_seek_to_the_middle_of_each_shown_frame() {
        // Frame 1 shows for two slots (frame 2 dropped); both grid frames seek inside it.
        let pts = [0, 256, 768, 1024, 1536];
        let v = track(15360, &pts, 256);
        let t = times(&v, &build(&v).unwrap());
        let s = |ticks: f64| ticks / 15360.0;
        assert_eq!(t[0], (0.0, s(128.0)));
        assert_eq!(t[1], (s(256.0), s(512.0)));
        assert_eq!(t[2], t[1]);
        assert_eq!(t[6], (s(1536.0), s(1664.0)));
    }

    #[test]
    fn times_follow_presentation_order() {
        // B-frames: decode order I P B, shown I B P.
        let v = track(30, &[0, 2, 1], 1);
        let t = times(&v, &build(&v).unwrap());
        assert_eq!(
            t,
            [
                (0.0, 0.5 / 30.0),
                (1.0 / 30.0, 1.5 / 30.0),
                (2.0 / 30.0, 2.5 / 30.0)
            ]
        );
    }

    #[test]
    fn the_last_frame_without_a_duration_lasts_one_gap() {
        let v = track(30, &[0, 1, 2], 0);
        let t = times(&v, &build(&v).unwrap());
        assert_eq!(t[2], (2.0 / 30.0, 2.5 / 30.0));
    }

    #[test]
    fn jittery_phone_timing_lands_on_the_nearest_slot() {
        // ~30 fps with jitter (timescale 600, 20 ticks a frame): 0, 21, 40, 61, 80.
        let pts = [0, 21, 40, 61, 80];
        let g = build(&track(600, &pts, 20)).unwrap();
        assert_eq!(g.rate, Rate { num: 30, den: 1 });
        assert_eq!(g.source, [0, 1, 2, 3, 4]);
    }

    /// Times with these gaps (in order), from 0.
    fn gaps(pattern: &[(u64, usize)]) -> Vec<i64> {
        let mut t = 0;
        let mut pts = vec![0];
        for &(gap, n) in pattern {
            for _ in 0..n {
                t += gap as i64;
                pts.push(t);
            }
        }
        pts
    }

    #[test]
    fn an_iphone_at_29_97_with_rounded_timestamps() {
        // IMG_2661: 1/600 s ticks, gaps of 20 with a 21 now and then.
        let pts = gaps(&[(20, 49), (21, 1), (20, 49), (21, 1)]);
        let g = build(&track(600, &pts, 20)).unwrap();
        assert_eq!(
            g.rate,
            Rate {
                num: 30000,
                den: 1001
            }
        );
        assert!(!g.variable);
    }

    #[test]
    fn a_camera_slowing_down_doesnt_set_the_rate() {
        // IMG_2821: mostly 20 ticks, some 21, and stretches of 25 (low light).
        let pts = gaps(&[(20, 300), (25, 44), (21, 13), (20, 416)]);
        let g = build(&track(600, &pts, 20)).unwrap();
        assert_eq!(
            g.rate,
            Rate {
                num: 30000,
                den: 1001
            }
        );
        assert!(g.variable);
    }

    #[test]
    fn two_frames_in_one_slot_keep_the_later() {
        // At 30 fps, frames at 0, 20, 28 ticks (timescale 600): 20 and 28 both round to slot 1.
        let pts = [0, 20, 28, 40, 60];
        let g = build(&track(600, &pts, 20)).unwrap();
        assert_eq!(g.source[..4], [0, 2, 3, 4]);
    }

    #[test]
    fn b_frame_order_and_hidden_frames() {
        // Decode order I P B B with an edit hiding a leading frame (pts -512).
        let pts = [-512, 0, 1536, 512, 1024];
        let g = build(&track(15360, &pts, 512)).unwrap();
        assert_eq!(g.frames, 4);
        assert_eq!(g.source, [1, 3, 4, 2]);
    }

    #[test]
    fn nothing_shown_gives_no_grid() {
        assert!(build(&track(600, &[-20, -10], 10)).is_none());
        assert!(build(&track(600, &[], 10)).is_none());
    }

    #[test]
    fn a_single_frame_is_one_grid_frame() {
        let g = build(&track(600, &[0], 20)).unwrap();
        assert_eq!((g.frames, g.source.as_slice()), (1, &[0][..]));
    }
}
