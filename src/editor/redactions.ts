// Redactions on video (PLAN 4.8): blur or pixelate a fixed box of the picture for the item's
// frames, beneath all other markup and under the clip fades. The preview draws them from the
// picture on screen (RedactLayer.tsx) with the arithmetic here, which is ffmpeg's, so the export
// (export.rs, 4.8b) makes the same pixels: the box rounded to whole output pixels; pixelate's
// blocks on a grid from its top-left corner, each its pixels' average, truncated (`pixelize`);
// blur as three box blurs across, then three down, each rounded, reading past the box as far
// as they reach and reflected at the frame's edge (`boxblur`, which is Vandal's blur too).

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

/** Box blurs each way (three come close to a Gaussian). */
const PASSES = 3;

/** How far past its box a blur of `radius` reads: a radius per pass. */
export const blurReach = (radius: number) => PASSES * radius;

/** A blur's radius in a region this size: at most half its shorter side, as `boxblur` allows. */
export const blurRadius = (radius: number, region: Size) =>
  Math.min(radius, Math.floor(Math.min(region.width, region.height) / 2));

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
 * the top-left corner becomes its pixels' average, truncated as `pixelize` does (a cell cut by
 * the right or bottom edge averages what it has).
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
      const avg = sum.map((s) => Math.floor(s / n));
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

/**
 * Blurs RGBA `pixels` (`width` × `height`) in place as ffmpeg's `boxblur` with `luma_power` 3:
 * three box blurs of `radius` along each row, then three down each column, each pixel the
 * rounded mean of the 2r + 1 around it, the edges reflected (a pixel past them is the one as far
 * in, the edge pixel itself first). `radius` at most half the shorter side (`blurRadius`).
 */
export function boxBlur(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): void {
  if (radius < 1) return;
  const longest = Math.max(width, height);
  const work = { line: new Int32Array(longest), out: new Int32Array(longest) };
  for (let y = 0; y < height; y++) {
    for (let c = 0; c < 3; c++) boxPasses(pixels, y * width * 4 + c, 4, width, radius, work);
  }
  for (let x = 0; x < width; x++) {
    for (let c = 0; c < 3; c++) boxPasses(pixels, x * 4 + c, width * 4, height, radius, work);
  }
}

/** Index `i` of `n`, reflected back in at the edges (`boxblur`'s). */
function reflect(i: number, n: number): number {
  while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - 1 - i;
  return i;
}

/** `PASSES` box blurs along `n` values of `buf`, from `start`, `stride` apart. */
function boxPasses(
  buf: Uint8ClampedArray,
  start: number,
  stride: number,
  n: number,
  r: number,
  { line, out }: { line: Int32Array; out: Int32Array },
): void {
  for (let i = 0; i < n; i++) line[i] = buf[start + i * stride];
  const d = 2 * r + 1;
  const half = Math.floor(d / 2);
  for (let pass = 0; pass < PASSES; pass++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += line[reflect(k, n)];
    for (let i = 0; i < n; i++) {
      out[i] = Math.floor((sum + half) / d);
      sum += line[reflect(i + r + 1, n)] - line[reflect(i - r, n)];
    }
    line.set(out.subarray(0, n));
  }
  for (let i = 0; i < n; i++) buf[start + i * stride] = line[i];
}
