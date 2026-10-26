// Bringing clicks in line (PLAN 5b.6h): every click mark given one style (Sync style, on the
// Click options bar), or Settings › Recording's style and timing (as "Lock click styles in the
// editor" is turned on, and while it's on); and a click's style and timing made Recording's. A
// click's button and whether it was a double-click are what it was, and never change. Pure.

import type { ClickTimes } from "../markup/click";
import type { ClickLook } from "../markup/model/types";
import { markFades, setFades, type Doc, type Mark, type MarkId } from "./doc";

/** What Sync style gives every click. */
export interface ClickStyle {
  look: ClickLook;
  size: number;
}

/** A click mark's length, fade-in and fade-out, in frames. */
export interface ClickFrames {
  length: number;
  fadeIn: number;
  fadeOut: number;
}

const clickMarks = (doc: Doc): Mark[] => doc.marks.filter((m) => m.object.kind === "click");

const styleOf = (m: Mark): ClickStyle =>
  m.object.kind === "click"
    ? { look: m.object.look, size: m.object.size }
    : { look: "ring", size: 0 };

const sameStyle = (a: ClickStyle, b: ClickStyle) => a.look === b.look && a.size === b.size;

/**
 * What Sync style would do with `style`: nothing (no clicks, or every one has it already),
 * restyle clicks that all look alike, or overwrite clicks styled differently from each other.
 */
export function clickSyncEffect(doc: Doc, style: ClickStyle): "none" | "uniform" | "mixed" {
  const clicks = clickMarks(doc);
  if (clicks.every((m) => sameStyle(styleOf(m), style))) return "none";
  const first = styleOf(clicks[0]);
  return clicks.every((m) => sameStyle(styleOf(m), first)) ? "uniform" : "mixed";
}

/** How many click marks the edit has. */
export const clickCount = (doc: Doc): number => clickMarks(doc).length;

/**
 * Every click mark in `style`, and with `timing` (Settings › Recording's, in frames) that
 * long and fading so: each keeps its start, button and double-click. The same document if
 * nothing changes.
 */
export function restyleClicks(doc: Doc, style: ClickStyle, timing?: ClickFrames): Doc {
  let changed = false;
  const timed: MarkId[] = [];
  const marks = doc.marks.map((m) => {
    if (m.object.kind !== "click") return m;
    const restyle = !sameStyle(styleOf(m), style);
    const fades = markFades(m, m.length);
    const retime =
      timing !== undefined &&
      (m.length !== timing.length ||
        fades.fadeIn !== timing.fadeIn ||
        fades.fadeOut !== timing.fadeOut);
    if (!restyle && !retime) return m;
    changed = true;
    if (retime) timed.push(m.id);
    return {
      ...m,
      object: restyle ? { ...m.object, look: style.look, size: style.size } : m.object,
      length: retime ? timing.length : m.length,
    };
  });
  if (!changed) return doc;
  const restyled = { ...doc, marks };
  return timing && timed.length
    ? setFades(restyled, timed, timing.fadeIn, timing.fadeOut)
    : restyled;
}

/** Settings › Recording's clicks, as "Set recording style" sets them from a click. */
export interface RecordingClickStyle extends ClickStyle, ClickTimes {}

/** Seconds as Settings › Recording keeps them: to its sliders' 0.05 s, within its limits. */
const seconds = (frames: number, fps: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round((frames / fps) * 20) / 20));

/**
 * Click mark `m`'s style and timing as Settings › Recording's (at `fps`): kept to its limits
 * (settings.rs `CLICK_SECONDS_RANGE`, `CLICK_FADE_RANGE`; Rust snaps the size to one the Click
 * tool offers). Null if it isn't a click.
 */
export function recordingStyleOf(m: Mark, fps: number): RecordingClickStyle | null {
  if (m.object.kind !== "click" || fps <= 0) return null;
  const fades = markFades(m, m.length);
  return {
    ...styleOf(m),
    seconds: seconds(m.length, fps, 0.2, 5),
    fadeIn: seconds(fades.fadeIn, fps, 0, 2),
    fadeOut: seconds(fades.fadeOut, fps, 0, 2),
  };
}
