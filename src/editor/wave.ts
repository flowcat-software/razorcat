// The clip's waveform (wave.rs): peaks, BINS per grid frame, 0 to 255. Zoomed out a pixel covers
// thousands of them, so they're also kept at halving resolutions, and a lookup reads whole
// blocks where it can.

/** Peaks per grid frame (wave.rs). */
export const BINS = 8;
/** The quietest level drawn, in dB: below it, nothing. */
const FLOOR_DB = -48;

export class Peaks {
  /** Level 0 is the peaks; each next has half as many, the louder of each pair. */
  private readonly levels: Uint8Array[];

  constructor(peaks: Uint8Array) {
    this.levels = [peaks];
    for (let a = peaks; a.length > 1;) {
      const next = new Uint8Array(Math.ceil(a.length / 2));
      for (let i = 0; i < next.length; i++) next[i] = Math.max(a[2 * i], a[2 * i + 1] ?? 0);
      this.levels.push(next);
      a = next;
    }
  }

  /** The loudest peak (0 to 255) from frame `f0` up to `f1` (fractional): exact, in a few reads. */
  max(f0: number, f1: number): number {
    // The bins from `lo` up to `hi`: odd ends read on their own at each level, the rest as pairs
    // a level up.
    let lo = Math.max(0, Math.floor(f0 * BINS));
    let hi = Math.min(this.levels[0].length, Math.ceil(f1 * BINS));
    let peak = 0;
    for (let level = 0; lo < hi; level++) {
      const a = this.levels[level];
      if (lo & 1) peak = Math.max(peak, a[lo++]);
      if (hi & 1) peak = Math.max(peak, a[--hi]);
      lo >>= 1;
      hi >>= 1;
    }
    return peak;
  }
}

/** How tall to draw a peak, 0 to 1: on a dB scale, so quiet speech still shows. */
export function waveHeight(peak: number): number {
  if (peak <= 0) return 0;
  const db = 20 * Math.log10(peak / 255);
  return Math.max(0, Math.min(1, 1 - db / FLOOR_DB));
}
