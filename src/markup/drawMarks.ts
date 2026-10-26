// Markup for the export (PLAN 4.3a): each item drawn alone at output size by the preview's own
// shapes, cut to what it covers of the frame, as straight-alpha RGBA, with where and when it
// shows. The preview's layer holds only the playhead's markup, so MarkupDrawing.tsx keeps every
// item drawn, out of sight, for this. Rust overlays them on the frame between their frames. A
// spotlight is its hole, drawn by the preview's path (PLAN 4.5g): Rust cuts it out of the dark.
// A ripple moves (PLAN 5b.6e): it's drawn again for each of its frames, by click.ts as the
// preview's is, each picture its own item for that frame, its fade drawn into it.

import type Konva from "konva";
import { markFades, markOpacity, shownMarks, type Doc, type MarkId } from "../editor/doc";
import type { Rect } from "../editor/fit";
import { outputSize } from "../editor/frame";
import { annotationBounds } from "./geometry";
import { clickReach, drawClick } from "./click";
import { annotationId, annotationOf, timelineFps } from "./model/store";
import type { Annotation, ClickAnnotation } from "./model/types";
import { fillSpotlight } from "./spotlightHole";

export interface DrawnMark {
  /** The markup's id; a ripple's frames each have their own (from {@link FRAME_IDS}). */
  id: MarkId;
  /** Its fades drawn in already (a ripple's frame): none for Rust to add. */
  faded?: boolean;
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
  /**
   * What it is to the export: laid over the frame; a highlighter's, multiplied in beneath the
   * rest (PLAN 4.5c); or a spotlight's hole, cut out of the dark (PLAN 4.5g).
   */
  layer: "item" | "highlight" | "hole";
}

/** Where the ids of a ripple's frame pictures start: past any markup's. */
const FRAME_IDS = 1 << 30;

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
  let frameId = FRAME_IDS;
  for (const m of shown.sort((a, b) => b.lane - a.lane || a.start - b.start || a.id - b.id)) {
    const kept = doc.marks.find((k) => k.id === m.id);
    // Redactions work on the video: Rust makes them (PLAN 4.8b).
    if (kept?.object.kind === "redact") continue;
    const node = group.findOne((n: Konva.Node) => n.id() === annotationId(m.id));
    if (!node || !kept) throw new Error("The markup isn't ready to export yet.");
    if (kept.object.kind === "spotlight") {
      const hole = drawHole(kept.object, frame);
      if (hole) drawn.push({ id: m.id, ...hole, start: m.start, end: m.end, layer: "hole" });
      continue;
    }
    if (kept.object.kind === "click" && kept.object.look === "ripple") {
      const a = annotationOf(m.id, kept.object);
      if (a.kind !== "click") continue;
      const length = m.end - m.start;
      const fades = markFades(kept, length);
      for (let f = m.start; f < m.end; f++) {
        const alpha = markOpacity(fades, length, f - m.start);
        const pic = drawRipple(a, (f - m.start) / timelineFps(), alpha, frame);
        if (pic)
          drawn.push({ id: frameId++, ...pic, start: f, end: f + 1, layer: "item", faded: true });
      }
      continue;
    }
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
      layer: kept.object.kind === "highlighter" ? "highlight" : "item",
    });
  }
  return drawn;
}

/** Ripple `a` as it is `age` s after its click, at opacity `alpha`, cut to `frame`: null if off. */
function drawRipple(
  a: ClickAnnotation,
  age: number,
  alpha: number,
  frame: { width: number; height: number },
): ReturnType<typeof trim> {
  const reach = clickReach(a) + 4;
  const x0 = Math.max(0, Math.floor(a.x - reach));
  const y0 = Math.max(0, Math.floor(a.y - reach));
  const x1 = Math.min(frame.width, Math.ceil(a.x + reach));
  const y1 = Math.min(frame.height, Math.ceil(a.y + reach));
  if (x1 <= x0 || y1 <= y0 || alpha <= 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = x1 - x0;
  canvas.height = y1 - y0;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("No 2D canvas context.");
  g.translate(a.x - x0, a.y - y0);
  g.globalAlpha = alpha;
  drawClick(g, a, age);
  const cut = trim(g.getImageData(0, 0, x1 - x0, y1 - y0));
  return cut && { ...cut, x: x0 + cut.x, y: y0 + cut.y };
}

/** Spotlight `spot`'s hole on a `frame`-sized picture, as the preview cuts it: null if it's off. */
function drawHole(
  spot: Parameters<typeof fillSpotlight>[1],
  frame: { width: number; height: number },
): ReturnType<typeof trim> {
  const r = spot.rect;
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(frame.width, Math.ceil(r.x + r.width));
  const y1 = Math.min(frame.height, Math.ceil(r.y + r.height));
  if (x1 <= x0 || y1 <= y0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = x1 - x0;
  canvas.height = y1 - y0;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("No 2D canvas context.");
  g.translate(-x0, -y0);
  g.fillStyle = "#000";
  fillSpotlight(g, spot);
  const cut = trim(g.getImageData(0, 0, x1 - x0, y1 - y0));
  return cut && { ...cut, x: x0 + cut.x, y: y0 + cut.y };
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
