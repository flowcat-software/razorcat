import { beforeEach, describe, expect, it } from "vitest";
import { shownMarks } from "./doc";
import { canRedo, canUndo, HISTORY_LIMIT, useDoc } from "./docStore";

const s = () => useDoc.getState();

describe("the document store", () => {
  beforeEach(() => s().load(100));

  it("loads a source as one clip, with no history", () => {
    expect(s().doc.clips).toHaveLength(1);
    expect(canUndo(s())).toBe(false);
  });

  it("undoes and redoes a split", () => {
    expect(s().split(40)).toBe(true);
    expect(s().doc.clips).toHaveLength(2);
    s().undo();
    expect(s().doc.clips).toHaveLength(1);
    expect(canRedo(s())).toBe(true);
    s().redo();
    expect(s().doc.clips).toHaveLength(2);
  });

  it("adds no step for an edit that changes nothing", () => {
    expect(s().split(0)).toBe(false);
    expect(canUndo(s())).toBe(false);
  });

  it("a new edit clears redo", () => {
    s().split(40);
    s().undo();
    s().split(60);
    expect(canRedo(s())).toBe(false);
    expect(s().doc.clips.map((c) => c.out)).toEqual([60, 100]);
  });

  it("drops the selection when undo removes its clip", () => {
    s().split(40);
    s().select(2);
    s().undo();
    expect(s().selected).toBeNull();
  });

  it("makes a gesture one step", () => {
    s().beginGesture();
    s().split(20);
    s().split(40);
    expect(canUndo(s())).toBe(false);
    s().endGesture();
    s().undo();
    expect(s().doc.clips).toHaveLength(1);
  });

  it("selects a new range, and one thing at a time", () => {
    s().select(1);
    const id = s().addRange(10, 20);
    expect(s().selectedRange).toBe(id);
    expect(s().selected).toBeNull();
    s().select(1);
    expect(s().selectedRange).toBeNull();
  });

  it("drops a range's selection when it's trimmed away", () => {
    const id = s().addRange(80, 90);
    s().trim(1, 0, 50);
    expect(s().selectedRange).toBeNull();
    s().undo();
    expect(s().doc.ranges.map((r) => r.id)).toEqual([id]);
  });

  it("keeps ranges in place through a whole drag, with following off", () => {
    s().setOptions({ follow: false, deleteWithClip: true, splitMarks: true, fadeCuts: false });
    s().addRange(60, 70);
    // A trim past the range and back again, in one drag: it's where it was.
    s().beginGesture();
    s().trim(1, 0, 50);
    s().trim(1, 5, 100);
    s().endGesture();
    s().setOptions({ follow: true, deleteWithClip: true, splitMarks: true, fadeCuts: false });
    const r = s().doc.ranges[0];
    expect(r.pieces).toEqual([{ clip: 1, in: 65, out: 75 }]);
  });

  it("keeps ranges, hidden, when their clip is deleted, if that's set", () => {
    s().split(50);
    s().addRange(60, 70);
    s().setOptions({ follow: true, deleteWithClip: false, splitMarks: true, fadeCuts: false });
    s().remove(2);
    s().setOptions({ follow: true, deleteWithClip: true, splitMarks: true, fadeCuts: false });
    expect(s().doc.ranges).toHaveLength(1);
    s().undo();
    s().remove(2);
    expect(s().doc.ranges).toHaveLength(0);
  });

  it("keeps at most the history limit", () => {
    s().load(1000);
    for (let f = 1; f <= HISTORY_LIMIT + 10; f++) s().split(f);
    expect(s().past).toHaveLength(HISTORY_LIMIT);
  });
});

describe("moving several markup items", () => {
  beforeEach(() => s().load(100));
  const text = { kind: "text", text: "x" } as never;
  const places = () => shownMarks(s().doc).map((m) => [m.id, m.start, m.end, m.lane]);

  it("places each from where they all were when the drag began, as one undo step", () => {
    s().addMark(text, 0, 10, 0);
    s().addMark(text, 20, 10, 0);
    s().beginGesture();
    // Two steps of one drag: the second from the start, not from the first.
    s().placeMarks([
      { id: 1, start: 5, end: 15, lane: 0 },
      { id: 2, start: 25, end: 35, lane: 0 },
    ]);
    s().placeMarks([
      { id: 1, start: 10, end: 20, lane: 0 },
      { id: 2, start: 30, end: 40, lane: 0 },
    ]);
    s().endGesture();
    expect(places()).toEqual([
      [1, 10, 20, 0],
      [2, 30, 40, 0],
    ]);
    s().undo();
    expect(places()).toEqual([
      [1, 0, 10, 0],
      [2, 20, 30, 0],
    ]);
  });

  it("gives way to markup left where it was", () => {
    s().addMark(text, 0, 10, 0);
    s().addMark(text, 40, 10, 0);
    s().placeMarks([{ id: 2, start: 5, end: 15, lane: 0 }]);
    expect(places()).toEqual([
      [1, 0, 10, 0],
      [2, 5, 15, 1],
    ]);
  });
});
