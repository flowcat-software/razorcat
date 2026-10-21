// Markup for the export (PLAN 4.3a): each item drawn alone at output size by the preview's own
// shapes, cut to what it covers of the frame, as straight-alpha RGBA, with where and when it
// shows. The preview's layer holds only the playhead's markup, so MarkupDrawing.tsx keeps every
// item drawn, out of sight, for this. Rust overlays them on the frame between their frames.

import type Konva from "konva";
import { shownMarks, type Doc, type MarkId } from "../editor/doc";
import type { Rect } from "../editor/fit";
import { outputSize } from "../editor/frame";
import { annotationBounds } from "./geometry";
import { annotationId, annotationOf } from "./model/store";
import type { Annotation } from "./model/types";

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

/** The longest the drawing waits for fonts to load (ms). */
const FONTS_WAIT = 2000;

/** MarkupDrawing's group: every item, in output pixels. */
let drawing: Konva.Group | null = null;

export function registerDrawing(group: Konva.Group | null): void {
  drawing = group;
}

/**
 * Where an item draws, in output pixels, generously: what Konva measures of its node (nothing
 * for the custom-drawn ones, arrows and lines, whose box it reports as empty), joined with the
 * markup's own bounds of it (which leave out the stroke: widened by its width, arrowheads
 * included), and then a margin past both, since some draw further (a text box's background,
 * an italic's lean). The export trims what's left empty; the preview's fading cache
 * (MarkupLayer.tsx) takes the same box.
 */
export function drawnBox(a: Annotation, measured: Rect): Rect {
  const own = annotationBounds(a);
  const stroke = "style" in a ? a.style.width * 4 : 0;
  const boxes = [
    {
      x: own.x - stroke,
      y: own.y - stroke,
      width: own.width + 2 * stroke,
      height: own.height + 2 * stroke,
    },
  ];
  if (measured.width > 0 || measured.height > 0) boxes.push(measured);
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  const pad = Math.ceil(Math.max(x1 - x0, y1 - y0) / 4) + 32;
  return { x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad };
}

/**
 * Every item of `doc`'s markup that shows, drawn: back to front (the bottom lane first), as the
 * preview stacks them. Items with nothing on the frame are left out.
 */
export async function drawMarks(doc: Doc): Promise<DrawnMark[]> {
  const shown = shownMarks(doc);
  if (!shown.length) return [];
  const group = drawing;
  if (!group) throw new Error("The markup isn't ready to export yet.");
  // Text drawn before its font has loaded comes out in another; but never wait for ever.
  await Promise.race([document.fonts.ready, new Promise((done) => setTimeout(done, FONTS_WAIT))]);
  const frame = outputSize(doc.frame);
  const drawn: DrawnMark[] = [];
  for (const m of shown.sort((a, b) => b.lane - a.lane || a.start - b.start || a.id - b.id)) {
    const node = group.findOne((n: Konva.Node) => n.id() === annotationId(m.id));
    const kept = doc.marks.find((k) => k.id === m.id);
    if (!node || !kept) throw new Error("The markup isn't ready to export yet.");
    const box = drawnBox(
      annotationOf(m.id, kept.object),
      node.getClientRect({ relativeTo: group }),
    );
    // The frame cuts it, as the preview's does.
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(frame.width, Math.ceil(box.x + box.width));
    const y1 = Math.min(frame.height, Math.ceil(box.y + box.height));
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
