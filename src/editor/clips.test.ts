// Several clips at once (PLAN 4.5f): deleting, copying, muting and moving them together.
import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteClips,
  duplicateClips,
  moveClips,
  moveGroupSlot,
  muteClips,
  split,
  wholeSource,
  type Doc,
} from "./doc";
import { useDoc } from "./docStore";

/** Five clips of 100 frames (ids 1 to 5). */
function five(): Doc {
  let doc = wholeSource(500);
  for (const f of [100, 200, 300, 400]) doc = split(doc, f);
  return doc;
}
const ids = (doc: Doc) => doc.clips.map((c) => c.id);

describe("several clips", () => {
  it("deletes them, never all of them", () => {
    const doc = five();
    expect(ids(deleteClips(doc, [2, 4]))).toEqual([1, 3, 5]);
    expect(deleteClips(doc, [1, 2, 3, 4, 5])).toBe(doc);
  });

  it("duplicates them in order after the last of them", () => {
    const doc = duplicateClips(five(), [4, 2]);
    expect(ids(doc)).toEqual([1, 2, 3, 4, 6, 7, 5]);
    expect(doc.clips[4]).toMatchObject({ in: 100, out: 200 });
    expect(doc.clips[5]).toMatchObject({ in: 300, out: 400 });
  });

  it("mutes them", () => {
    const doc = muteClips(five(), [1, 3], true);
    expect(doc.clips.map((c) => !!c.muted)).toEqual([true, false, true, false, false]);
  });

  it("moves them gathered, in order, among the others", () => {
    const doc = five();
    expect(ids(moveClips(doc, [2, 4], 0))).toEqual([2, 4, 1, 3, 5]);
    expect(ids(moveClips(doc, [2, 4], 3))).toEqual([1, 3, 5, 2, 4]);
    expect(ids(moveClips(doc, [2, 4], 99))).toEqual([1, 3, 5, 2, 4]);
    // Side by side already, there: the same document.
    expect(moveClips(doc, [2, 3], 1)).toBe(doc);
  });

  it("drags a group past a clip once its edge is past that clip's middle", () => {
    const doc = five();
    // Clips 2 and 3 (frames 100 to 300), grabbed by 3.
    expect(moveGroupSlot(doc, [2, 3], 3, 0)).toBe(1);
    expect(moveGroupSlot(doc, [2, 3], 3, 49)).toBe(1);
    expect(moveGroupSlot(doc, [2, 3], 3, 51)).toBe(2);
    expect(moveGroupSlot(doc, [2, 3], 3, -51)).toBe(0);
    expect(moveGroupSlot(doc, [2, 3], 3, 500)).toBe(3);
  });
});

describe("selecting several clips", () => {
  const s = () => useDoc.getState();
  beforeEach(() => {
    s().load(500);
    for (const f of [100, 200, 300, 400]) s().split(f);
  });

  it("keeps the last picked as the one a single clip's action takes", () => {
    s().selectClips([2, 4, 2]);
    expect(s().selectedClips).toEqual([2, 4]);
    expect(s().selected).toBe(4);
    s().select(3);
    expect(s().selectedClips).toEqual([3]);
    s().selectMarks([]);
    expect(s().selectedClips).toEqual([]);
  });

  it("deletes them in one undo step, and lets go of what's gone", () => {
    s().selectClips([2, 4]);
    expect(s().removeClips([2, 4])).toBe(true);
    expect(s().doc.clips).toHaveLength(3);
    expect(s().selectedClips).toEqual([]);
    s().undo();
    expect(s().doc.clips).toHaveLength(5);
  });

  it("selects the copies of a duplicate or a paste", () => {
    const made = s().duplicateClips([1, 2]);
    expect(made).toEqual([6, 7]);
    expect(s().selectedClips).toEqual([6, 7]);
    expect(s().selected).toBe(7);
  });
});
