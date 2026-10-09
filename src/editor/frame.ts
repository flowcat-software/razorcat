// The frame (PLAN §3, Phase 3): what the export's picture is made of. One for the whole project:
// the crop, a part of the source picture as shown (rotation applied), then the grow, space added
// round it. Both in the source's pixels. Pure; the edit document holds it (doc.ts).

import type { GrowAmount, GrowPreset } from "../shared/ipc";
import { fitRatio, inFrame, resizeCrop } from "./cropGeometry";
import type { Rect, Size } from "./fit";

export type Side = "top" | "bottom" | "left" | "right";
export const SIDES: readonly Side[] = ["top", "bottom", "left", "right"];

/** Space added round the cropped picture. */
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

/** The most a side grows, in px. */
export const MAX_GROW = 4000;

/**
 * One colour per grown side while they don't meet (one side, or two opposite ones: black top,
 * white bottom), or one colour for all once two grown sides share a corner (the mockup's rule).
 */
export function growMode(g: Grow): "each" | "one" {
  const across = g.top > 0 || g.bottom > 0;
  const along = g.left > 0 || g.right > 0;
  return across && along ? "one" : "each";
}

/** The colour side `side` is drawn in. */
export const growColour = (g: Grow, side: Side) =>
  growMode(g) === "one" ? g.colour : (g.colours[side] ?? g.colour);

/** `g` with `side` grown by `px`: whole pixels, 0 to `MAX_GROW`. */
export function growSide(g: Grow, side: Side, px: number): Grow {
  return { ...g, [side]: clamp(Math.round(px), 0, MAX_GROW) };
}

/**
 * `g` with `colour` for `side`, or for all of it (`side` null, or once grown sides meet: one
 * colour then).
 */
export function colourGrow(g: Grow, side: Side | null, colour: string): Grow {
  if (side === null || growMode(g) === "one") return { ...g, colour, colours: {} };
  return { ...g, colours: { ...g.colours, [side]: colour } };
}

/**
 * Preset `p` for a picture `picture` big (the crop): each side in px, a % of the picture's height
 * (top, bottom) or width (left, right); one colour.
 */
export function presetGrow(p: GrowPreset, picture: Size): Grow {
  const px = (a: GrowAmount, base: number) =>
    clamp(Math.round(a.unit === "percent" ? (base * a.value) / 100 : a.value), 0, MAX_GROW);
  return {
    top: px(p.top, picture.height),
    bottom: px(p.bottom, picture.height),
    left: px(p.left, picture.width),
    right: px(p.right, picture.width),
    colour: p.colour,
    colours: {},
  };
}

/** The grow is preset `p`'s, sizes and colour (its chip shows as on). */
export function isPreset(g: Grow, p: GrowPreset, picture: Size): boolean {
  const want = presetGrow(p, picture);
  return (
    isGrown(want) &&
    SIDES.every((s) => g[s] === want[s] && (g[s] === 0 || growColour(g, s) === want.colour))
  );
}

/** The grow as a preset named `name`: its sizes in px, in the colour of its first grown side. */
export function growPreset(g: Grow, name: string): GrowPreset {
  const px = (value: number): GrowAmount => ({ value, unit: "px" });
  const first = SIDES.find((s) => g[s] > 0);
  return {
    name,
    top: px(g.top),
    bottom: px(g.bottom),
    left: px(g.left),
    right: px(g.right),
    colour: first ? growColour(g, first) : g.colour,
  };
}

/** A preset's sides, said: "top 15 %, bottom 120 px". */
export function presetSummary(p: GrowPreset): string {
  const said = SIDES.filter((s) => p[s].value > 0).map(
    (s) => `${s} ${p[s].value} ${p[s].unit === "percent" ? "%" : "px"}`,
  );
  return said.join(", ") || "nothing grown";
}

/** The same grow: sizes and the colours as drawn. */
export function sameGrow(a: Grow, b: Grow): boolean {
  return (
    SIDES.every((s) => a[s] === b[s]) &&
    a.colour === b.colour &&
    SIDES.every((s) => a.colours[s] === b.colours[s])
  );
}

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
