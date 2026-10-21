// Markup for the export (PLAN 4.3a): each item drawn alone at output size by the preview's own
// shapes, cut to what it covers of the frame, as straight-alpha RGBA, with where and when it
// shows. The preview's layer holds only the playhead's markup, so MarkupDrawing.tsx keeps every
// item drawn, out of sight, for this. Rust overlays them on the frame between their frames.

import type Konva from "konva";
import { shownMarks, type Doc, type MarkId } from "../editor/doc";
import { outputSize } from "../editor/frame";

export interface DrawnMark {
  id: MarkId;
  /** What it covers of the output frame, in its pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The timeline frames it shows on, `start` to `end` (exclusive). */
  start: number;
  end: number;
  /** Straight-alpha RGBA, `width` × `height`. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/** MarkupDrawing's group: every item, in output pixels. */
let drawing: Konva.Group | null = null;

export function registerDrawing(group: Konva.Group | null): void {
  drawing = group;
}

/**
 * How far past a node's measured box to draw, in output pixels: some shapes draw outside it
 * (a text box's background), and the empty edge is trimmed off again.
 */
const margin = (width: number, height: number) => Math.ceil(Math.max(width, height) / 4) + 32;

/**
 * Every item of `doc`'s markup that shows, drawn: back to front (the bottom lane first), as the
 * preview stacks them. Items with nothing on the frame are left out.
 */
export async function drawMarks(doc: Doc): Promise<DrawnMark[]> {
  const shown = shownMarks(doc);
  if (!shown.length) return [];
  const group = drawing;
  if (!group) throw new Error("The markup isn't ready to export yet.");
  // Text drawn before its font has loaded comes out in another.
  await document.fonts.ready;
  const frame = outputSize(doc.frame);
  const drawn: DrawnMark[] = [];
  for (const m of shown.sort((a, b) => b.lane - a.lane || a.start - b.start || a.id - b.id)) {
    const node = group.findOne((n: Konva.Node) => n.id() === `m${m.id}`);
    if (!node) throw new Error("The markup isn't ready to export yet.");
    const box = node.getClientRect({ relativeTo: group });
    const pad = margin(box.width, box.height);
    // The frame cuts it, as the preview's does.
    const x0 = Math.max(0, Math.floor(box.x - pad));
    const y0 = Math.max(0, Math.floor(box.y - pad));
    const x1 = Math.min(frame.width, Math.ceil(box.x + box.width + pad));
    const y1 = Math.min(frame.height, Math.ceil(box.y + box.height + pad));
    if (x1 <= x0 || y1 <= y0) continue;
    const canvas = node.toCanvas({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, pixelRatio: 1 });
    const g = canvas.getContext("2d");
    if (!g) throw new Error("No 2D canvas context.");
    const cut = trim(g.getImageData(0, 0, x1 - x0, y1 - y0));
    if (!cut) continue;
    drawn.push({
      id: m.id,
      x: x0 + cut.x,
      y: y0 + cut.y,
      width: cut.width,
      height: cut.height,
      start: m.start,
      end: m.end,
      pixels: cut.pixels,
    });
  }
  return drawn;
}

/** `image` without its transparent edges; null if it's all transparent. */
export function trim(image: { width: number; height: number; data: Uint8ClampedArray }): {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
} | null {
  const { width, height, data } = image;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
    }
  }
  if (right < 0) return null;
  const w = right - left + 1;
  const h = bottom - top + 1;
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((top + y) * width + left) * 4;
    pixels.set(data.subarray(from, from + w * 4), y * w * 4);
  }
  return { x: left, y: top, width: w, height: h, pixels };
}
