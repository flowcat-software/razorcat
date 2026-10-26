// A recording's clicks, made markup on its clip (PLAN 5b.6b): a click mark each, where and when
// it was clicked, a moment long and fading out, in the left or right click's colour. Rust notes
// them while recording (recording.rs) and hands them over once, as the file opens. Pure.

import { clickTiming } from "../markup/click";
import type { ClickLook } from "../markup/model/types";
import type { RecordedInput } from "../shared/ipc";
import { addMark, clipStarts, freeLane, setFades, type ClipId, type Doc } from "./doc";
import { fitIn, type Point, type Size } from "./fit";

/** Each button's colour (5b.6d makes them settings). */
export const CLICK_COLOURS: Record<RecordedInput["clicks"][number]["button"], string> = {
  left: "#ffd60a",
  right: "#ff4fd8",
  middle: "#4c9aff",
};

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
 * `fps` frames a second), looking as `look` says. Clicks off the clip's frames are left out.
 */
export function withRecordedClicks(
  doc: Doc,
  clip: ClipId,
  input: RecordedInput,
  fps: number,
  size: Size,
  look: { look: ClickLook; size: number },
): Doc {
  const i = doc.clips.findIndex((c) => c.id === clip);
  if (i < 0 || fps <= 0) return doc;
  const c = doc.clips[i];
  const start = clipStarts(doc)[i];
  const { length, fadeOut: fade } = clickTiming(fps);
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
        look: look.look,
        size: look.size,
        color: CLICK_COLOURS[k.button],
        double: k.double,
      },
      t,
      length,
      freeLane(d, t, t + length),
    );
    if (d.nextMarkId !== id && fade > 0) d = setFades(d, [id], 0, fade);
  }
  return d;
}
