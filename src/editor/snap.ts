// Snapping (the mockup's): a dragged frame within a few pixels of a target lands on it. Always
// measured from the raw pointer frame, never from where the drag last landed, so a snap is
// stable: it holds within reach of a target and lets go beyond.

import { clipLength, clipStarts, editPoints, type Doc } from "./doc";

/** How near (px) a target pulls. */
export const SNAP_PX = 8;

export interface Snapped {
  frame: number;
  /** The target it snapped to (the guide is drawn there), or null. */
  target: number | null;
}

/**
 * Frame `f` (fractional), snapped to the nearest of `targets` within reach at `zoom` (pixels per
 * frame); otherwise `free(f)` (rounded, by default). `on` false: no snapping (off, or Alt held).
 */
export function snap(
  f: number,
  targets: readonly number[],
  zoom: number,
  on: boolean,
  free: (f: number) => number = Math.round,
): Snapped {
  if (on) {
    let best: number | null = null;
    let reach = SNAP_PX / zoom;
    for (const t of targets) {
      const d = Math.abs(t - f);
      if (d < reach) {
        reach = d;
        best = t;
      }
    }
    if (best !== null) return { frame: best, target: best };
  }
  return { frame: free(f), target: null };
}

/**
 * What scrubbing snaps the playhead to: each clip's first frame. (Not the timeline's end: the
 * playhead stops a frame before it, so the guide would show a frame off.)
 */
export const scrubTargets = (doc: Doc): number[] => clipStarts(doc);

/**
 * What trimming clip `index` may snap to, fixed when the drag starts: only things the trim can't
 * move, so the guide never chases a moving target. An out edge moves: the playhead, where the
 * edge started, and the edit points before it (what's after it slides along). An in edge stays
 * put while the clip's video slides under it: only the playhead (trim the start to the frame
 * under it) and where it started (no change).
 */
export function trimTargets(doc: Doc, index: number, edge: "in" | "out", playhead: number) {
  const start = clipStarts(doc)[index];
  if (edge === "in") return [playhead, start];
  const end = start + clipLength(doc.clips[index]);
  return [playhead, end, ...editPoints(doc).filter((t) => t < end)];
}
