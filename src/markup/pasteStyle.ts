// Paste Style (PLAN 4.5d3): one item's style onto others, as Elementor's Paste Style. The same
// kind takes it whole (a rectangle and an ellipse count as one); another kind takes what it has a
// place for, by colour's role: a line (a stroke, a border, a pointer), a fill (a shape's, a text's
// background, a callout's box, a step marker) and text. A callout's box and a step marker take a
// fill, else a line; an outlined shape given a fill gets one. Text colour is an island: it goes
// only to text (a text's colour, a callout's or a step's label) and text takes no other
// (Richard, 2026-10-22: an arrow's colour turned a text yellow but no label, and a text's turned
// a line its colour). A text's background is a fill, and goes as one. Never the text, the shape drawn or
// the place. Written for Vandal to take back too: it needs only the annotations.

import type { Annotation } from "./model/types";
import type { StylePatch } from "./restyle";

/** What an item's style says, by role rather than by field. */
interface Style {
  /** A stroke, a shape's border, a callout's pointer. */
  line?: string;
  /** A shape's fill, a text's background (when shown), a filled callout box, a step marker. */
  fill?: string;
  /** The colour text is in: a text's ink, a callout's or a step's label. */
  text?: string;
  width?: number;
  font?: { fontFamily: string; fontSize?: number; bold?: boolean; italic?: boolean };
  align?: StylePatch["align"];
  cornerRadius?: number;
}

function styleOf(a: Annotation): Style {
  switch (a.kind) {
    case "text":
      return {
        text: a.color,
        fill: a.background ? a.backgroundColor : undefined,
        font: { fontFamily: a.fontFamily, fontSize: a.fontSize, bold: a.bold, italic: a.italic },
        align: a.align,
      };
    case "callout":
      return {
        line: a.color,
        fill: a.shape === "box" ? a.color : undefined,
        text: a.textColor,
        width: a.lineWidth,
        font: { fontFamily: a.fontFamily, fontSize: a.fontSize, bold: a.bold, italic: a.italic },
        align: a.align,
        cornerRadius: a.cornerRadius,
      };
    case "step":
      return { fill: a.color, text: a.textColor, font: { fontFamily: a.fontFamily } };
    case "rect":
    case "ellipse":
      // Solid: no border, the shape's colour its fill.
      return {
        line: a.fill === "solid" ? undefined : a.style.color,
        fill: a.fill === "solid" ? a.style.color : a.fill === "both" ? a.fillColor : undefined,
        width: a.style.width,
        cornerRadius: a.cornerRadius,
      };
    case "arrow":
    case "line":
    case "pen":
    case "highlighter":
      return { line: a.style.color, width: a.style.width };
    case "redact":
    case "spotlight":
      return { cornerRadius: a.kind === "spotlight" ? a.cornerRadius : undefined };
  }
}

/** The kind's own settings, carried only to the same kind. */
function ownOf(a: Annotation): StylePatch {
  switch (a.kind) {
    case "text":
      return { background: a.background, backgroundColor: a.backgroundColor };
    case "callout":
      return { calloutShape: a.shape, pointerEnd: a.end };
    case "step":
      // Not the labels' format and start: every marker shares those.
      return { stepShape: a.shape, stepSize: a.size };
    case "rect":
    case "ellipse":
      return { fill: a.fill, fillColor: a.fillColor };
    case "arrow":
      return { head: a.head, ends: a.ends };
    case "redact":
      return { redactMode: a.mode, strength: a.strength };
    case "spotlight":
      // Not the darkness: every spotlight shares it.
      return { spotlightShape: a.shape };
    default:
      return {};
  }
}

const shape = (a: Annotation) => a.kind === "rect" || a.kind === "ellipse";

/** The patch that gives `target` the style of `source`, as far as its kind has a place for it. */
export function stylePatchFor(source: Annotation, target: Annotation): StylePatch {
  const s = styleOf(source);
  const same = source.kind === target.kind || (shape(source) && shape(target));
  const patch: StylePatch = same ? ownOf(source) : {};
  const t = target.kind;
  const textual = t === "text" || t === "callout";
  let color: string | undefined;
  if (t === "text") {
    color = s.text;
    // Another kind's fill: a background (a text's own comes whole, shown or not, above).
    if (!same && s.fill !== undefined) {
      patch.background = true;
      patch.backgroundColor = s.fill;
    }
  } else if (t === "callout" || t === "step") {
    color = s.fill ?? s.line;
    if (s.text !== undefined) patch.textColor = s.text;
  } else if (target.kind === "rect" || target.kind === "ellipse") {
    if (same && "style" in source) color = source.style.color;
    else if (target.fill === "solid") color = s.fill ?? s.line;
    else {
      color = s.line;
      if (s.fill !== undefined) {
        patch.fill = "both";
        patch.fillColor = s.fill;
      }
    }
  } else color = s.line ?? s.fill;
  if (color !== undefined) patch.color = color;
  if (s.width !== undefined && t !== "text" && t !== "step" && t !== "redact" && t !== "spotlight")
    patch.width = s.width;
  if (s.font && (textual || t === "step")) {
    patch.fontFamily = s.font.fontFamily;
    if (textual) {
      if (s.font.fontSize !== undefined) patch.fontSize = s.font.fontSize;
      if (s.font.bold !== undefined) patch.bold = s.font.bold;
      if (s.font.italic !== undefined) patch.italic = s.font.italic;
    }
  }
  if (s.align && textual) patch.align = s.align;
  if (s.cornerRadius !== undefined && (t === "rect" || t === "spotlight" || t === "callout"))
    patch.cornerRadius = s.cornerRadius;
  return patch;
}
