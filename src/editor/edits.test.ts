import { beforeEach, describe, expect, it } from "vitest";
import { shownMarks, type MarkObject } from "./doc";
import { useDoc } from "./docStore";
import { copySelectedMarks, pasteClip, pasteStyle } from "./edits";
import type { Player } from "./player";

const s = () => useDoc.getState();
const style = (color: string, width: number) => ({ color, width, opacity: 1 });
const rect = {
  kind: "rect",
  rect: { x: 0, y: 0, width: 10, height: 10 },
  rotation: 0,
  fill: "none",
  fillColor: "#000000",
  style: style("#ff0000", 8),
} as MarkObject;
const arrow = {
  kind: "arrow",
  from: { x: 0, y: 0 },
  to: { x: 10, y: 10 },
  head: "filled",
  ends: "end",
  style: style("#0000ff", 2),
} as MarkObject;
/** A player whose playhead is at `frame`. */
const at = (frame: number) => ({ getState: () => ({ frame }) }) as unknown as Player;

describe("copying markup", () => {
  beforeEach(() => s().load(200));

  it("pastes it at the playhead, as far apart as it was, faded as it was, in one step", () => {
    const a = s().addMark(rect, 10, 20, 0)!;
    const b = s().addMark(arrow, 20, 30, 0)!;
    s().setMarkFades(a, { fadeIn: 5 });
    s().selectMarks([a, b]);
    expect(copySelectedMarks()).toBe(true);
    expect(pasteClip(at(100))).toBe(true);
    const pasted = shownMarks(s().doc).filter((m) => m.start >= 100);
    expect(pasted.map((m) => [m.start, m.end]).sort()).toEqual([
      [100, 120],
      [110, 140],
    ]);
    expect(s().selectedMarks).toHaveLength(2);
    expect(s().doc.marks.filter((m) => m.fadeIn === 5)).toHaveLength(2);
    s().undo();
    expect(s().doc.marks).toHaveLength(2);
  });

  it("pastes its style onto the selected markup, as one undo step", () => {
    const a = s().addMark(rect, 10, 20, 0)!;
    const b = s().addMark(arrow, 40, 20, 0)!;
    s().selectMarks([a]);
    copySelectedMarks();
    s().selectMarks([b]);
    expect(pasteStyle()).toBe(true);
    const styled = s().doc.marks.find((m) => m.id === b)!.object as { style: unknown };
    expect(styled.style).toEqual(style("#ff0000", 8));
    s().undo();
    expect((s().doc.marks.find((m) => m.id === b)!.object as { style: unknown }).style).toEqual(
      style("#0000ff", 2),
    );
  });
});
