// The speed popover's state (PLAN §7, Clip speed): which clip's speed is open, and where. Opened
// by Ctrl+R, a clip's Speed… item, or a click on its speed badge; the timeline says where a clip
// is (`setSpeedAnchor`), for Ctrl+R.

import { create } from "zustand";
import type { ClipId } from "./doc";

/** A point in the window: the popover goes below it. */
export interface Point {
  x: number;
  y: number;
}

export const useSpeedPopover = create<{ at: ({ clip: ClipId } & Point) | null }>(() => ({
  at: null,
}));

let anchorOf: (clip: ClipId) => Point | null = () => null;

/** Where the timeline shows clip `id`, for a popover opened from the keyboard. */
export function setSpeedAnchor(f: (clip: ClipId) => Point | null): void {
  anchorOf = f;
}

/** Opens clip `clip`'s speed below `at` (else below the clip). False if it's nowhere to be seen. */
export function openSpeed(clip: ClipId, at?: Point): boolean {
  const p = at ?? anchorOf(clip);
  if (!p) return false;
  useSpeedPopover.setState({ at: { clip, ...p } });
  return true;
}

export const closeSpeed = () => useSpeedPopover.setState({ at: null });
