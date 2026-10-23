import { describe, expect, it } from "vitest";
import { addMark, setMarkFades, wholeSource, type Doc, type MarkObject } from "./doc";
import { darkAt, darkLayer } from "./spotlights";

const spot = (dim = 60): MarkObject => ({
  kind: "spotlight",
  rect: { x: 0, y: 0, width: 10, height: 10 },
  shape: "rect",
  dim,
});

/** Spotlights from `start` for `length` frames with their fades, made in this order (ids 1, 2…). */
function spots(...list: [start: number, length: number, fadeIn: number, fadeOut: number][]): Doc {
  let doc = wholeSource(200);
  list.forEach(([start, length, fadeIn, fadeOut], i) => {
    doc = addMark(doc, spot(), start, length, i);
    doc = setMarkFades(setMarkFades(doc, i + 1, { fadeIn }), i + 1, { fadeOut });
  });
  return doc;
}

describe("darkLayer", () => {
  it("is nothing without a spotlight showing", () => {
    expect(darkLayer(wholeSource(100))).toBeNull();
  });

  it("fades one spotlight's darkness, its hole opening and closing with it", () => {
    const layer = darkLayer(spots([10, 20, 4, 6]))!;
    expect(layer.runs).toEqual([{ start: 10, end: 30, fadeIn: 4, fadeOut: 6 }]);
    expect(layer.holes.get(1)).toEqual({ start: 10, end: 30, fadeIn: 0, fadeOut: 0 });
    expect(darkAt(layer, 12)).toEqual({ level: 0.5, holes: new Map([[1, 1]]) });
    expect(darkAt(layer, 30)).toBeNull();
  });

  it("keeps the darkness over spotlights that overlap or touch, fading the holes between", () => {
    // 10–30, then 25–50 (overlapping), then 50–60 (touching): one run.
    const layer = darkLayer(spots([10, 20, 4, 6], [25, 25, 5, 3], [50, 10, 2, 8]))!;
    expect(layer.runs).toEqual([{ start: 10, end: 60, fadeIn: 4, fadeOut: 8 }]);
    expect(layer.holes.get(1)).toEqual({ start: 10, end: 30, fadeIn: 0, fadeOut: 6 });
    expect(layer.holes.get(2)).toEqual({ start: 25, end: 50, fadeIn: 5, fadeOut: 3 });
    expect(layer.holes.get(3)).toEqual({ start: 50, end: 60, fadeIn: 2, fadeOut: 0 });
    // The second's hole half open, the first's closing, the darkness whole.
    const at = darkAt(layer, 27)!;
    expect(at.level).toBe(1);
    expect(at.holes.get(2)).toBe(2 / 5);
    expect(at.holes.get(1)).toBe(3 / 6);
  });

  it("starts a new run after a gap", () => {
    const layer = darkLayer(spots([10, 10, 0, 0], [21, 10, 3, 0]))!;
    expect(layer.runs.map((r) => [r.start, r.end, r.fadeIn])).toEqual([
      [10, 20, 0],
      [21, 31, 3],
    ]);
    expect(darkAt(layer, 20)).toBeNull();
  });

  it("fades a run in as long as the longest of those starting it", () => {
    const layer = darkLayer(spots([10, 20, 2, 0], [10, 30, 6, 0]))!;
    expect(layer.runs[0].fadeIn).toBe(6);
    expect(layer.holes.get(1)?.fadeIn).toBe(0);
    expect(layer.holes.get(2)?.fadeIn).toBe(0);
  });

  it("is as dark as the last spotlight made", () => {
    let doc = addMark(wholeSource(100), spot(30), 0, 10, 0);
    doc = addMark(doc, spot(85), 50, 10, 0);
    expect(darkLayer(doc)?.dim).toBe(85);
  });
});
