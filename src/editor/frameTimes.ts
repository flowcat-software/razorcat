// The source's frame times from Rust (`/frames/{generation}`, see protocol.rs): for each
// timeline frame, when its picture starts showing on the video's clock and the middle of it.

export interface FrameTimes {
  /** When each timeline frame's picture starts showing, in seconds. Never decreases. */
  start: Float64Array;
  /** The middle of each timeline frame's picture: where to seek to show it. */
  seek: Float64Array;
}

/** Reads the protocol's pairs of little-endian f64s. */
export function parseFrameTimes(bytes: ArrayBuffer): FrameTimes {
  const view = new DataView(bytes);
  const n = Math.floor(bytes.byteLength / 16);
  const start = new Float64Array(n);
  const seek = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    start[i] = view.getFloat64(i * 16, true);
    seek[i] = view.getFloat64(i * 16 + 8, true);
  }
  return { start, seek };
}

/** `<video>` reports times to the microsecond; this absorbs the rounding. */
const SLACK = 1e-4;

/**
 * The timeline frame showing the picture presented at `mediaTime`: the first one that shows it
 * (a picture can show for several), or the next one if the timeline skips it.
 */
export function frameAt(start: Float64Array, mediaTime: number): number {
  let lo = 0;
  let hi = start.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (start[mid] < mediaTime - SLACK) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, start.length - 1);
}
