// Dragging a number field left or right (as Resolve): how far the value moves per
// pixel of mouse travel. Pure.

import type { DragSpeed } from "../shared/ipc";

/** Settings › Editing › Number drag speed: scales the mouse's speed. */
export const DRAG_SPEEDS: Record<DragSpeed, number> = {
  verySlow: 0.5,
  slow: 0.75,
  normal: 1,
  fast: 1.4,
  veryFast: 2,
};

/**
 * Value change per pixel of travel at mouse `speed` (px/ms): a smooth curve, ¼ when slow,
 * rising with the square of the speed, capped at 5 (Shift ×10 goes further). At Normal it takes
 * a brisk 0.8 px/ms to reach 1:1 and about 1.7 px/ms for the cap.
 */
export function dragGain(speed: number, setting: DragSpeed = "normal"): number {
  const v = (speed * DRAG_SPEEDS[setting]) / 0.4;
  return Math.min(5, 0.25 * (1 + v * v));
}

/** Px of travel before a press on a field becomes a drag (less is a click, to type). */
export const DRAG_THRESHOLD = 3;
