// The time readout: timeline frames as timecode (m:ss.ff), or as frame numbers.

/**
 * Frame `n` of a timeline at `num/den` fps as `mm:ss.ff`, with hours (`h:mm:ss.ff`) when `hours`.
 * The seconds are real time, so at 29.97 fps a second now and then has 29 frames (00–28) instead
 * of 30: the readout never drifts from the clock.
 */
export function timecode(n: number, num: number, den: number, hours = false): string {
  const s = Math.floor((n * den) / num);
  const ff = n - Math.ceil((s * num) / den);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${hours ? `${h}:` : ""}${p(hours ? m % 60 : m)}:${p(s % 60)}.${p(ff)}`;
}

/** Whether a timeline `frames` long needs hours in its timecode. */
export function needsHours(frames: number, num: number, den: number): boolean {
  return (frames * den) / num >= 3600;
}
