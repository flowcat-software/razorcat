import { beforeEach, describe, expect, it } from "vitest";
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

  it("keeps at most the history limit", () => {
    s().load(1000);
    for (let f = 1; f <= HISTORY_LIMIT + 10; f++) s().split(f);
    expect(s().past).toHaveLength(HISTORY_LIMIT);
  });
});
