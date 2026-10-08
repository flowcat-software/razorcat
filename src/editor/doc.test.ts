import { describe, expect, it } from "vitest";
import {
  clipAt,
  clipStarts,
  deleteClip,
  editPoints,
  moveClip,
  split,
  total,
  wholeSource,
} from "./doc";

describe("the document", () => {
  it("starts as the whole source, one clip", () => {
    const doc = wholeSource(785);
    expect(doc.clips).toEqual([{ id: 1, in: 0, out: 785 }]);
    expect(total(doc)).toBe(785);
    expect(editPoints(doc)).toEqual([0, 785]);
  });

  it("finds the clip under a frame", () => {
    const doc = split(wholeSource(100), 40);
    expect(clipAt(doc, 39)).toMatchObject({ index: 0, start: 0 });
    expect(clipAt(doc, 40)).toMatchObject({ index: 1, start: 40 });
    expect(clipAt(doc, 100)).toBeNull();
    expect(clipAt(doc, -1)).toBeNull();
  });
});

describe("split", () => {
  it("cuts the clip under the playhead in two, the second a new clip", () => {
    const doc = split(wholeSource(100), 40);
    expect(doc.clips).toEqual([
      { id: 1, in: 0, out: 40 },
      { id: 2, in: 40, out: 100 },
    ]);
    // Nothing moves: the same frames play at the same places.
    expect(total(doc)).toBe(100);
    expect(clipStarts(doc)).toEqual([0, 40]);
    expect(editPoints(doc)).toEqual([0, 40, 100]);
  });

  it("splits a later clip in its own source frames", () => {
    const doc = split(split(wholeSource(100), 40), 70);
    expect(doc.clips).toEqual([
      { id: 1, in: 0, out: 40 },
      { id: 2, in: 40, out: 70 },
      { id: 3, in: 70, out: 100 },
    ]);
  });

  it("does nothing on a cut or past the end", () => {
    const doc = split(wholeSource(100), 40);
    expect(split(doc, 40)).toBe(doc);
    expect(split(doc, 0)).toBe(doc);
    expect(split(doc, 100)).toBe(doc);
  });

  it("leaves the document it was given alone", () => {
    const doc = wholeSource(100);
    split(doc, 50);
    expect(doc.clips).toHaveLength(1);
  });
});

describe("delete and move", () => {
  // Three clips: 0-40, 40-70, 70-100.
  const three = split(split(wholeSource(100), 40), 70);

  it("deletes a clip and closes the gap", () => {
    const doc = deleteClip(three, 2);
    expect(doc.clips.map((c) => [c.in, c.out])).toEqual([
      [0, 40],
      [70, 100],
    ]);
    expect(total(doc)).toBe(70);
    expect(clipStarts(doc)).toEqual([0, 40]);
  });

  it("keeps the last clip", () => {
    const one = wholeSource(100);
    expect(deleteClip(one, 1)).toBe(one);
    expect(deleteClip(three, 99)).toBe(three);
  });

  it("moves a clip, the others sliding aside", () => {
    const doc = moveClip(three, 3, 0);
    expect(doc.clips.map((c) => c.id)).toEqual([3, 1, 2]);
    expect(clipStarts(doc)).toEqual([0, 30, 70]);
    expect(moveClip(three, 1, 5).clips.map((c) => c.id)).toEqual([2, 3, 1]);
    expect(moveClip(three, 2, 1)).toBe(three);
  });
});
