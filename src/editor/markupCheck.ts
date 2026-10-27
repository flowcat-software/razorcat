// Development: the markup export's check (PLAN 4.3a). On each export, the items drawn for it
// that show at the playhead, put together on a frame, are compared with the preview's own layer
// drawn at full size (Vandal's `renderLayer`): the same pixels, or the drawing cut something off
// or put it in the wrong place. The result goes to the dev app's log (`[check] … markup:`).

import { renderLayer } from "../markup/export";
import type { DrawnMark } from "../markup/drawMarks";
import { annotationId, docStore as markupDoc } from "../markup/model/store";
import { useToolStore } from "../markup/toolStore";
import { commands } from "../shared/ipc";
import type { Size } from "./fit";

/** How far apart (0–255, premultiplied) two pixels may be: canvas rounding at soft edges. */
const TOLERANCE = 3;

/** Checks `drawn` against the preview at timeline frame `at`, on a frame `size`, and logs it. */
export async function checkMarkup(drawn: readonly DrawnMark[], at: number, size: Size) {
  // Text being typed into is hidden on the preview: nothing to compare.
  if (useToolStore.getState().editing) return;
  // Markup mid-fade is see-through on the preview but drawn whole for the export (ffmpeg fades
  // it): nothing to compare.
  if (Object.keys(markupDoc.getState().opacity).length) {
    await commands.frameCheckReport(`markup: not checked at frame ${at} (fading)`, "{}");
    return;
  }
  // The spotlights' darkness is in the preview's layer, but Rust makes it for the export (the
  // export check reads it): nothing to compare.
  if (markupDoc.getState().dark) {
    await commands.frameCheckReport(`markup: not checked at frame ${at} (spotlit)`, "{}");
    return;
  }
  // Highlights are the preview's highlight layer, multiplied (the export check reads them).
  const on = drawn.filter(
    (m) => m.start <= at && at < m.end && (m.layer === "item" || m.layer === "frames"),
  );
  const live = renderLayer(markupDoc.getState().doc, "annotations");
  if (!on.length && !live) return;
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const g = canvas.getContext("2d");
  if (!g) return;
  for (const m of on) {
    const piece = document.createElement("canvas");
    piece.width = m.width;
    piece.height = m.height;
    // A ripple's: its picture for this frame.
    const size = m.width * m.height * 4;
    const from = m.layer === "frames" ? (at - m.start) * size : 0;
    const pixels = m.pixels.slice(from, from + size);
    piece.getContext("2d")?.putImageData(new ImageData(pixels, m.width, m.height), 0, 0);
    g.drawImage(piece, m.x, m.y);
  }
  const ours = g.getImageData(0, 0, size.width, size.height).data;
  const theirs = live ?? new Uint8ClampedArray(ours.length);
  let wrong = 0;
  let worst = 0;
  // Where they differ, and how: more (or less) there in ours than the preview's.
  const box = { x0: size.width, y0: size.height, x1: -1, y1: -1 };
  let more = 0;
  for (let i = 0; i < ours.length; i += 4) {
    const a = ours[i + 3];
    const b = theirs[i + 3];
    let d = Math.abs(a - b);
    for (let c = 0; c < 3; c++) {
      d = Math.max(d, Math.abs((ours[i + c] * a - theirs[i + c] * b) / 255));
    }
    if (d > TOLERANCE) {
      wrong++;
      if (a > b) more++;
      const p = i / 4;
      const x = p % size.width;
      const y = Math.floor(p / size.width);
      box.x0 = Math.min(box.x0, x);
      box.y0 = Math.min(box.y0, y);
      box.x1 = Math.max(box.x1, x);
      box.y1 = Math.max(box.y1, y);
    }
    worst = Math.max(worst, d);
  }
  // The items over where they differ: which, and what they are.
  const kinds = new Map(
    markupDoc
      .getState()
      .doc.annotations.map((a) => [a.id, a.kind === "click" ? `click ${a.look}` : a.kind]),
  );
  const under = wrong
    ? on
        .filter(
          (m) =>
            m.x <= box.x1 && box.x0 < m.x + m.width && m.y <= box.y1 && box.y0 < m.y + m.height,
        )
        .map((m) => ({
          id: m.id,
          kind: kinds.get(annotationId(m.id)) ?? "?",
          layer: m.layer,
          box: [m.x, m.y, m.width, m.height],
          frames: m.layer === "frames" ? [at - m.start, m.end - m.start] : undefined,
        }))
    : [];
  const where = wrong ? ` in ${box.x0},${box.y0} to ${box.x1},${box.y1}, ${more} more in ours` : "";
  const summary =
    `markup: ${on.length} of ${drawn.length} items at frame ${at}; ` +
    (wrong
      ? `${wrong} pixels differ (up to ${Math.round(worst)})${where}; under: ` +
        under.map((u) => `${u.kind} (${u.layer})`).join(", ")
      : "all match");
  const report = JSON.stringify({
    at,
    items: drawn.length,
    on: on.length,
    wrong,
    worst,
    box,
    under,
  });
  await commands.frameCheckReport(summary, report);
}
