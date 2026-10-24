// Redactions on video (PLAN 4.8): blur or pixelate a fixed box of the picture for the item's
// frames, beneath all other markup and under the clip fades. The preview draws them from the
// picture on screen (RedactLayer.tsx) with the arithmetic here; the export makes them in ffmpeg
// (4.8b) on the same pixels: the box rounded to whole output pixels, pixelate's blocks on a grid
// from its top-left corner, blur reading past the box as far as it reaches.

import type { Rect, Size } from "./fit";

/** Smallest pixelate block and blur radius that still change anything (Vandal's). */
const MIN_BLOCK = 2;
const MIN_RADIUS = 1;

/** A redaction's box in whole output pixels, kept to the frame; null if nothing's left. */
export function redactBox(rect: Rect, frame: Size): Rect | null {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(frame.width, Math.round(rect.x + rect.width));
  const y1 = Math.min(frame.height, Math.round(rect.y + rect.height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** A pixelate block size or blur radius as used: whole, and at least the minimum. */
export function redactStrength(mode: "pixelate" | "blur", strength: number): number {
  return Math.max(mode === "pixelate" ? MIN_BLOCK : MIN_RADIUS, Math.round(strength));
}

/**
 * A blur radius as a Gaussian's standard deviation, in pixels: what Vandal's three box blurs of
 * that radius come to (each adds r(r + 1) / 3 to the variance), so a radius looks as it does there.
 */
export const blurSigma = (radius: number) => Math.sqrt(radius * (radius + 1));

/** How far past its box a blur of `radius` reads: three standard deviations. */
export const blurReach = (radius: number) => Math.ceil(3 * blurSigma(radius));

/** `box` grown by `by` on every side, kept to the frame. */
export function grownBox(box: Rect, by: number, frame: Size): Rect {
  const x0 = Math.max(0, box.x - by);
  const y0 = Math.max(0, box.y - by);
  const x1 = Math.min(frame.width, box.x + box.width + by);
  const y1 = Math.min(frame.height, box.y + box.height + by);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Pixelates RGBA `pixels` (`width` × `height`) in place: each `block`-square cell of a grid from
 * the top-left corner becomes its pixels' average, rounded (a cell cut by the right or bottom
 * edge averages what it has).
 */
export function pixelate(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  block: number,
): void {
  for (let by = 0; by < height; by += block) {
    const y1 = Math.min(height, by + block);
    for (let bx = 0; bx < width; bx += block) {
      const x1 = Math.min(width, bx + block);
      const sum = [0, 0, 0, 0];
      for (let y = by; y < y1; y++) {
        for (let x = bx; x < x1; x++) {
          const i = (y * width + x) * 4;
          sum[0] += pixels[i];
          sum[1] += pixels[i + 1];
          sum[2] += pixels[i + 2];
          sum[3] += pixels[i + 3];
        }
      }
      const n = (x1 - bx) * (y1 - by);
      const avg = sum.map((s) => Math.round(s / n));
      for (let y = by; y < y1; y++) {
        for (let x = bx; x < x1; x++) {
          const i = (y * width + x) * 4;
          pixels[i] = avg[0];
          pixels[i + 1] = avg[1];
          pixels[i + 2] = avg[2];
          pixels[i + 3] = avg[3];
        }
      }
    }
  }
}
