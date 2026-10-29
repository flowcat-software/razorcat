import { describe, expect, it } from "vitest";
import {
  addRange,
  clipStarts,
  deleteClip,
  deleteRange,
  editPoints,
  keepRanges,
  keepRangesInPlace,
  moveClip,
  rangeRoom,
  removeRanges,
  separateRanges,
  setRange,
  shownRanges,
  split,
  total,
  trimClip,
  wholeSource,
  type Doc,
} from "./doc";

/** The shown ranges as [a, b] pairs. */
const places = (doc: Doc) => shownRanges(doc).map((r) => [r.a, r.b]);

describe("ranges", () => {
  it("are added over the timeline, a frame at least, inside it", () => {
    const doc = addRange(wholeSource(1000), 500, 600);
    expect(places(doc)).toEqual([[500, 600]]);
    expect(places(addRange(wholeSource(1000), 950, 1100))).toEqual([[950, 1000]]);
    const none = wholeSource(1000);
    expect(addRange(none, 1000, 1200)).toBe(none);
    expect(editPoints(doc)).toEqual([0, 500, 600, 1000]);
  });

  it("follow their video through a trim (the worked example)", () => {
    // Frames 500-600, then 50 frames trimmed off the front.
    const doc = trimClip(addRange(wholeSource(1000), 500, 600), 1, 50, 1000);
    expect(places(doc)).toEqual([[450, 550]]);
  });

  it("follow their clip when it moves, and a split hands them on", () => {
    // Clips 0-400 and 400-1000 (clip 2); a range on clip 2 at 500-600.
    let doc = addRange(split(wholeSource(1000), 400), 500, 600);
    expect(doc.ranges[0].pieces).toEqual([{ clip: 2, in: 500, out: 600 }]);
    doc = moveClip(doc, 2, 0);
    expect(places(doc)).toEqual([[100, 200]]);
  });

  it("are hidden when trimmed away, and come back whole when the trim is pulled back", () => {
    const doc = addRange(wholeSource(1000), 500, 600);
    const trimmed = trimClip(doc, 1, 0, 400);
    expect(places(trimmed)).toEqual([]);
    expect(trimmed.ranges).toHaveLength(1);
    expect(places(trimClip(trimmed, 1, 0, 1000))).toEqual([[500, 600]]);
  });

  it("stay one range on the second half when the first half is extended over their frames", () => {
    // A bug found in the mockup: split at 600, a range on the second half, then the first
    // half's out pulled over the range's source frames. The range must stay on the second half.
    let doc = split(wholeSource(1000), 600);
    doc = addRange(doc, 660, 720);
    doc = trimClip(doc, 1, 0, 840);
    doc = separateRanges(doc);
    const starts = clipStarts(doc);
    expect(places(doc)).toEqual([[starts[1] + 60, starts[1] + 120]]);
  });

  it("split in two when a clip moves out of their middle", () => {
    // Clips 0-400, 400-600, 600-1000; a range 350-650 across both cuts.
    let doc = split(split(wholeSource(1000), 400), 600);
    doc = addRange(doc, 350, 650);
    doc = separateRanges(moveClip(doc, 2, 2));
    // Clip 2 is now last (800-1000): the range's parts on clips 1 and 3 meet at 350-450, and
    // its part on clip 2 is a range of its own.
    expect(places(doc)).toEqual([
      [350, 450],
      [800, 1000],
    ]);
    expect(doc.ranges.map((r) => r.id)).toEqual([1, 2]);
  });

  it("go with their clip when it's deleted, unless that's off", () => {
    let doc = split(wholeSource(1000), 400);
    doc = addRange(addRange(doc, 100, 200), 500, 600);
    expect(places(deleteClip(doc, 1))).toEqual([[100, 200]]);
    expect(deleteClip(doc, 1).ranges).toHaveLength(1);
    // Off: kept, hidden.
    expect(places(deleteClip(doc, 1, false))).toEqual([[100, 200]]);
    expect(deleteClip(doc, 1, false).ranges).toHaveLength(2);
  });

  it("are moved and resized to mark what's there now, and deleted", () => {
    const doc = addRange(wholeSource(1000), 500, 600);
    expect(places(setRange(doc, 1, 700, 650))).toEqual([[650, 700]]);
    expect(setRange(doc, 1, 500, 600)).toBe(doc);
    expect(deleteRange(doc, 1).ranges).toEqual([]);
  });

  it("never overlap: a new one stops at the next, and none starts inside one", () => {
    const doc = addRange(wholeSource(1000), 500, 600);
    expect(places(addRange(doc, 400, 700))).toEqual([
      [500, 600],
      [400, 500],
    ]);
    expect(addRange(doc, 550, 700)).toBe(doc);
    // Touching is fine.
    expect(places(addRange(doc, 600, 650))).toEqual([
      [500, 600],
      [600, 650],
    ]);
    expect(rangeRoom(doc, 700, 700, null)).toEqual({ a: 600, b: 1000 });
    expect(rangeRoom(doc, 450, 450, null)).toEqual({ a: 0, b: 500 });
  });

  it("are moved and resized only up to the ranges either side", () => {
    const doc = addRange(addRange(wholeSource(1000), 100, 200), 500, 600);
    expect(places(setRange(doc, 2, 150, 600))).toEqual([
      [100, 200],
      [200, 600],
    ]);
    expect(places(setRange(doc, 1, 100, 900))).toEqual([
      [100, 500],
      [500, 600],
    ]);
  });

  it("can stay at their place on the timeline instead", () => {
    const doc = addRange(wholeSource(1000), 500, 600);
    const trimmed = keepRangesInPlace(doc, trimClip(doc, 1, 30, 1000));
    expect(places(trimmed)).toEqual([[500, 600]]);
    // Cut short by the timeline's end; gone with nothing left.
    expect(places(keepRangesInPlace(doc, trimClip(doc, 1, 0, 550)))).toEqual([[500, 550]]);
    expect(keepRangesInPlace(doc, trimClip(doc, 1, 0, 400)).ranges).toEqual([]);
  });
});

describe("keep and remove", () => {
  // Clips 0-400 and 400-1000; ranges 100-200 and 350-500 (across the cut).
  const doc = addRange(addRange(split(wholeSource(1000), 400), 100, 200), 350, 500);

  it("remove cuts the ranges out (ripple)", () => {
    const out = removeRanges(doc);
    expect(out.clips).toEqual([
      { id: 1, source: "source", in: 0, out: 100 },
      { id: 3, source: "source", in: 200, out: 350 },
      { id: 2, source: "source", in: 500, out: 1000 },
    ]);
    expect(total(out)).toBe(750);
    expect(out.ranges).toEqual([]);
  });

  it("keep cuts everything else out", () => {
    const out = keepRanges(doc);
    expect(out.clips).toEqual([
      { id: 1, source: "source", in: 100, out: 200 },
      { id: 3, source: "source", in: 350, out: 400 },
      { id: 2, source: "source", in: 400, out: 500 },
    ]);
    expect(out.ranges).toEqual([]);
  });

  it("nothing to do without ranges, and never removes everything", () => {
    const none = wholeSource(100);
    expect(keepRanges(none)).toBe(none);
    const all = addRange(none, 0, 100);
    expect(removeRanges(all)).toBe(all);
    expect(keepRanges(all).clips).toEqual(none.clips);
  });
});
