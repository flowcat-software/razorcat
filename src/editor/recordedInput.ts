// A recording's clicks, made markup on its clip (PLAN 5b.6b): a click mark each, where and when
// it was clicked, looking and lasting as Settings › Recording says (5b.6d). Rust notes them
// while recording (recording.rs) and hands them over once, as the file opens. Pure.

import { clickTiming, type ClickTimes } from "../markup/click";
import type { ClickLook } from "../markup/model/types";
import type { RecordedInput } from "../shared/ipc";
import { addMark, clipStarts, freeLane, setFades, type ClipId, type Doc } from "./doc";
import { fitIn, type Point, type Size } from "./fit";

/** How a recording's clicks look and last: Settings › Recording's (their colours are their
 *  buttons', drawn as Settings has them now). */
export interface RecordedClickStyle extends ClickTimes {
  look: ClickLook;
  size: number;
  /** A double-click shows a second ring. */
  double: boolean;
}

/**
 * Where point `p` of a file's picture (`size`) is in the frame (output px): fitted into the first
 * file's picture as it shows (PLAN 4.5e), then placed by the crop and the grown space round it.
 */
export function onFrame(doc: Doc, size: Size, p: Point): Point {
  const first = doc.frame.source;
  const f = fitIn(size, first, first);
  const k = size.width > 0 ? f.width / size.width : 1;
  return {
    x: f.left + p.x * k - doc.frame.crop.x + doc.frame.grow.left,
    y: f.top + p.y * k - doc.frame.crop.y + doc.frame.grow.top,
  };
}

/**
 * `doc` with the clicks of `input` as click marks on clip `clip` (its file's picture `size`, at
 * `fps` frames a second), looking and lasting as `style` says. Clicks off the clip's frames are
 * left out.
 */
export function withRecordedClicks(
  doc: Doc,
  clip: ClipId,
  input: RecordedInput,
  fps: number,
  size: Size,
  style: RecordedClickStyle,
): Doc {
  const i = doc.clips.findIndex((c) => c.id === clip);
  if (i < 0 || fps <= 0) return doc;
  const c = doc.clips[i];
  const start = clipStarts(doc)[i];
  const { length, fadeIn, fadeOut } = clickTiming(fps, style);
  let d = doc;
  for (const k of input.clicks) {
    // Rust's f64s arrive typed `number | null` (see ipc.ts); they're always numbers.
    const at = Math.round((k.time ?? 0) * fps);
    if (at < c.in || at >= c.out) continue;
    const t = start + at - c.in;
    const p = onFrame(d, size, { x: k.x ?? 0, y: k.y ?? 0 });
    const id = d.nextMarkId;
    d = addMark(
      d,
      {
        kind: "click",
        x: p.x,
        y: p.y,
        look: style.look,
        size: style.size,
        double: style.double && k.double,
        button: k.button,
      },
      t,
      length,
      freeLane(d, t, t + length),
    );
    if (d.nextMarkId !== id && (fadeIn > 0 || fadeOut > 0)) d = setFades(d, [id], fadeIn, fadeOut);
  }
  return d;
}
