// The frame (PLAN §3, Phase 3): what the export's picture is made of. One for the whole project:
// the crop, a part of the source picture as shown (rotation applied), then the grow, space added
// round it. Both in the source's pixels. Pure; the edit document holds it (doc.ts).

import { fitRatio, inFrame, resizeCrop } from "./cropGeometry";
import type { Rect, Size } from "./fit";

export type Side = "top" | "bottom" | "left" | "right";
export const SIDES: readonly Side[] = ["top", "bottom", "left", "right"];

/** Space added round the cropped picture (Phase 3.4 edits it). */
export interface Grow {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** The colour, `#rrggbb`: all of it, or each grown side without one in `colours`. */
  colour: string;
  /** A side's own colour, while grown sides don't meet (the mockup's rule). */
  colours: Partial<Record<Side, string>>;
}

export const NO_GROW: Grow = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  colour: "#000000",
  colours: {},
};

export interface Frame {
  /** The source picture's size as shown. */
  source: Size;
  crop: Rect;
  grow: Grow;
}

/** The whole picture, nothing added. */
export function fullFrame(source: Size): Frame {
  return { source, crop: { x: 0, y: 0, ...source }, grow: NO_GROW };
}

export const isCropped = (f: Frame) =>
  f.crop.x !== 0 ||
  f.crop.y !== 0 ||
  f.crop.width !== f.source.width ||
  f.crop.height !== f.source.height;

export const isGrown = (g: Grow) => SIDES.some((s) => g[s] > 0);

/** The export's size: the crop plus the grow. */
export function outputSize(f: Frame): Size {
  return {
    width: f.crop.width + f.grow.left + f.grow.right,
    height: f.crop.height + f.grow.top + f.grow.bottom,
  };
}

/** `crop` kept to the source in whole pixels, at least 1 px. */
export function keepCrop(crop: Rect, source: Size): Rect {
  const width = clamp(Math.round(crop.width), 1, source.width);
  const height = clamp(Math.round(crop.height), 1, source.height);
  return {
    x: clamp(Math.round(crop.x), 0, source.width - width),
    y: clamp(Math.round(crop.y), 0, source.height - height),
    width,
    height,
  };
}

export type CropField = "x" | "y" | "width" | "height";

/**
 * The crop with one of its fields set (the options bar's X, Y, W, H). X and Y move it, kept
 * inside the source; W and H resize it from its top-left, the other side following a locked
 * `ratio`.
 */
export function setCropField(
  crop: Rect,
  field: CropField,
  value: number,
  source: Size,
  ratio?: number,
): Rect {
  if (field === "x" || field === "y") return keepCrop({ ...crop, [field]: value }, source);
  const width = field === "width" ? value : crop.width;
  const height = field === "height" ? value : crop.height;
  return resizeCrop(crop, Math.max(1, width), Math.max(1, height), source, ratio, field);
}

/**
 * The largest box of `ratio` inside the source, centred where `crop` is (picking an aspect
 * ratio, as Vandal).
 */
export function cropToRatio(crop: Rect, source: Size, ratio: number): Rect {
  const whole = inFrame({ x: 0, y: 0, ...source }, (size) =>
    fitRatio({ x: 0, y: 0, ...size }, ratio),
  );
  const cx = crop.x + crop.width / 2;
  const cy = crop.y + crop.height / 2;
  return keepCrop({ ...whole, x: cx - whole.width / 2, y: cy - whole.height / 2 }, source);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
