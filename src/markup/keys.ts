// A keys mark's layout and drawing (PLAN 5b.6c): the preview and the export draw it with this, so
// they match. Centred on (0, 0); `size` is the font's. The looks are the mockup's
// (internal/mockup/input-markup.html): light key caps with an edge, caps on a dark bar, a pill of
// text, outlined caps. The mark's colour is the caps', bar's or pill's (its text black or white,
// whichever reads), or an outline's and its text.

import { hexToRgb } from "./color";
import type { KeysAnnotation } from "./model/types";
import { contrastingText } from "./steps";
import { measureTextWidth } from "./textMeasure";

const FAMILY = "Segoe UI";

/** How long keys show after the last press, and fade in and out over (s): recorded or placed
 *  (5b.6d makes them settings). They come at once, as the press does (Richard: faded in, one
 *  just placed seemed to vanish, the playhead on its first frame). */
export const KEYS_SECONDS = 1.5;
export const KEYS_FADE_IN_SECONDS = 0;
export const KEYS_FADE_OUT_SECONDS = 0.3;

/** A keys mark's length (`seconds` long), fade-in and fade-out, in frames at `fps`. */
export function keysTiming(
  fps: number,
  seconds = KEYS_SECONDS,
): { length: number; fadeIn: number; fadeOut: number } {
  const length = Math.max(1, Math.round(seconds * fps));
  const fadeIn = Math.min(length, Math.round(KEYS_FADE_IN_SECONDS * fps));
  return {
    length,
    fadeIn,
    fadeOut: Math.min(length - fadeIn, Math.round(KEYS_FADE_OUT_SECONDS * fps)),
  };
}

/** The keys' font, as the canvas takes it. */
export function keysFont(px: number): string {
  return `bold ${px}px "${FAMILY}"`;
}

/** One piece of the row: a key, the "+" between keys, the "," between presses, or a pill's text. */
interface Piece {
  kind: "key" | "plus" | "comma" | "text";
  text: string;
  /** Its left edge, from the row's centre. */
  x: number;
  width: number;
}

export interface KeysLayout {
  pieces: Piece[];
  /** The whole mark's size (a bar's or pill's padding included). */
  width: number;
  height: number;
  /** A key's height (a pill's line of text). */
  keyHeight: number;
}

/** "Ctrl + C, Ctrl + V": the keys as text (a pill's, and the timeline's name for the mark). */
export function keysText(presses: string[][]): string {
  return presses.map((p) => p.join(" + ")).join(", ");
}

/** Where each piece goes, its text measured by `measure` (px, in the keys' font). */
export function keysLayout(
  a: Pick<KeysAnnotation, "presses" | "size" | "look">,
  measure: (text: string) => number,
): KeysLayout {
  const s = a.size;
  const line = s * 1.2;
  if (a.look === "pill") {
    const text = keysText(a.presses);
    const w = measure(text);
    return {
      pieces: [{ kind: "text", text, x: -w / 2, width: w }],
      width: w + s * 2.13,
      height: line + s * 1.07,
      keyHeight: line,
    };
  }
  const caps = a.look === "caps";
  const padX = s * (caps ? 0.73 : 0.67);
  const keyHeight = line + 2 * s * (caps ? 0.4 : 0.33);
  const gap = s * 0.4;
  const pieces: Piece[] = [];
  let x = 0;
  const add = (kind: Piece["kind"], text: string, width: number) => {
    if (pieces.length) x += gap;
    pieces.push({ kind, text, x, width });
    x += width;
  };
  a.presses.forEach((press, i) => {
    if (i > 0) add("comma", ",", measure(","));
    press.forEach((key, j) => {
      // Caps and outlined keys have a round "+" chip between them; a bar has the sign.
      if (j > 0) add("plus", "+", a.look === "bar" ? measure("+") : s * 1.07);
      // A single letter's key is no narrower than it's tall.
      add("key", key, Math.max(keyHeight, measure(key) + 2 * padX));
    });
  });
  for (const p of pieces) p.x -= x / 2;
  // A bar's padding; a cap's edge below it.
  const around = a.look === "bar" ? s * 0.53 * 2 : 0;
  return {
    pieces,
    width: x + around,
    height: keyHeight + around + (caps ? s * 0.2 : 0),
    keyHeight,
  };
}

/** How far the mark reaches from its centre each way, for its bounds and hit area. */
export function keysExtent(a: KeysAnnotation): { width: number; height: number } {
  const { width, height } = keysLayout(a, (t) => {
    // No canvas (unit tests): about as wide as bold Segoe UI's capitals.
    const w = typeof document === "undefined" ? 0 : measureTextWidth(t, a.size, FAMILY, true);
    return w || t.length * a.size * 0.62;
  });
  return { width, height };
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** `hex` darkened by `k` (0 to 1). */
function darker(hex: string, k: number): string {
  const { r, g, b } = hexToRgb(hex);
  const d = (v: number) => Math.round(v * (1 - k));
  return `rgb(${d(r)}, ${d(g)}, ${d(b)})`;
}

function box(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

export function drawKeys(c: CanvasRenderingContext2D, a: KeysAnnotation): void {
  const s = a.size;
  c.save();
  c.font = keysFont(s);
  const layout = keysLayout(a, (t) => c.measureText(t).width);
  const { width, height, keyHeight } = layout;
  // Text centred on its capitals.
  const baseline = c.measureText("H").actualBoundingBoxAscent / 2;
  const ink = contrastingText(a.color);
  c.textAlign = "center";
  c.textBaseline = "alphabetic";
  // The mark's own opacity (fading, while selected) under any of the drawing's.
  const opacity = c.globalAlpha;
  const text = (t: string, x: number, color: string, alpha = 1) => {
    c.globalAlpha = opacity * alpha;
    c.fillStyle = color;
    c.fillText(t, x, baseline);
    c.globalAlpha = opacity;
  };
  const shadow = (blur: number, y: number, alpha: number) => {
    c.shadowColor = `rgba(0, 0, 0, ${alpha})`;
    c.shadowBlur = blur;
    c.shadowOffsetY = y;
  };
  const noShadow = () => shadow(0, 0, 0);
  /** The "+" between caps: a dark chip, so it reads on light and dark screens alike. */
  const plusChip = (cx: number) => {
    const r = s * 0.53;
    c.beginPath();
    c.arc(cx, 0, r, 0, Math.PI * 2);
    c.fillStyle = "rgba(0, 0, 0, 0.55)";
    c.fill();
    c.beginPath();
    c.moveTo(cx - r / 2, 0);
    c.lineTo(cx + r / 2, 0);
    c.moveTo(cx, -r / 2);
    c.lineTo(cx, r / 2);
    c.lineWidth = Math.max(1, s * 0.13);
    c.strokeStyle = "#ffffff";
    c.stroke();
  };
  /** The "," between presses, on the picture: white with a dark edge. */
  const comma = (cx: number) => {
    shadow(s * 0.2, 0, 0.8);
    text(",", cx, "#ffffff", 0.9);
    noShadow();
  };

  if (a.look === "pill" || a.look === "bar") {
    shadow(s * 1.6, s * 0.4, 0.35);
    box(c, -width / 2, -height / 2, width, height, a.look === "pill" ? height / 2 : s * 0.8);
    c.fillStyle = rgba(a.color, 0.86);
    c.fill();
    noShadow();
  }
  const top = a.look === "caps" ? -(keyHeight + s * 0.2) / 2 : -keyHeight / 2;
  // Caps sit a little high, their edge below; the text centres on the face.
  const textY = top + keyHeight / 2;
  c.translate(0, textY);
  for (const p of layout.pieces) {
    const cx = p.x + p.width / 2;
    if (p.kind === "text") {
      text(p.text, 0, ink);
    } else if (p.kind === "comma") {
      if (a.look === "bar") text(",", cx, ink, 0.5);
      else comma(cx);
    } else if (p.kind === "plus") {
      if (a.look === "bar") text("+", cx, ink, 0.7);
      else plusChip(cx);
    } else {
      const y = -keyHeight / 2;
      const r = s * (a.look === "caps" ? 0.47 : 0.4);
      if (a.look === "caps") {
        // The edge below, with the shadow under it; then the face, lit from above.
        shadow(s * 0.67, s * 0.27, 0.35);
        box(c, p.x, y + s * 0.2, p.width, keyHeight, r);
        c.fillStyle = darker(a.color, 0.25);
        c.fill();
        noShadow();
        box(c, p.x, y, p.width, keyHeight, r);
        const g = c.createLinearGradient(0, y, 0, y + keyHeight);
        g.addColorStop(0, a.color);
        g.addColorStop(1, darker(a.color, 0.07));
        c.fillStyle = g;
        c.fill();
        text(p.text, cx, ink);
      } else if (a.look === "bar") {
        box(c, p.x, y, p.width, keyHeight, r);
        c.fillStyle = ink === "#ffffff" ? "rgba(255, 255, 255, 0.14)" : "rgba(0, 0, 0, 0.1)";
        c.fill();
        text(p.text, cx, ink);
      } else {
        const line = Math.max(1.5, s * 0.13);
        box(c, p.x + line / 2, y + line / 2, p.width - line, keyHeight - line, r);
        c.fillStyle = "rgba(0, 0, 0, 0.35)";
        c.fill();
        c.lineWidth = line;
        c.strokeStyle = a.color;
        c.stroke();
        shadow(s * 0.2, s * 0.07, 0.6);
        text(p.text, cx, a.color);
        noShadow();
      }
    }
  }
  c.restore();
}
