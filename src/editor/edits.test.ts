import { beforeEach, describe, expect, it } from "vitest";
import { shownMarks, type MarkObject } from "./doc";
import { useDoc } from "./docStore";
import { copySelectedMarks, pasteClip, pasteFades, pasteStyle, pasteTiming } from "./edits";
import type { Player } from "./player";
import { duplicateSelection } from "../markup/objectActions";

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

  it("duplicates it with its fades, or without when copies don't keep them", () => {
    const a = s().addMark(rect, 10, 20, 0)!;
    s().setMarkFades(a, { fadeIn: 5 });
    s().setMarkFades(a, { fadeOut: 3 });
    const fadesOfLast = () => {
      const m = s().doc.marks[s().doc.marks.length - 1];
      return [m.fadeIn ?? 0, m.fadeOut ?? 0];
    };
    s().selectMarks([a]);
    expect(duplicateSelection()).toBe(true);
    expect(fadesOfLast()).toEqual([5, 3]);
    const options = s().options;
    try {
      s().setOptions({ ...options, copyFades: false });
      s().selectMarks([a]);
      expect(duplicateSelection()).toBe(true);
      expect(fadesOfLast()).toEqual([0, 0]);
      s().selectMarks([a]);
      expect(copySelectedMarks()).toBe(true);
      expect(pasteClip(at(100))).toBe(true);
      expect(fadesOfLast()).toEqual([0, 0]);
    } finally {
      s().setOptions(options);
    }
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

  it("pastes its fades onto the selected markup, kept to each one's length", () => {
    const a = s().addMark(rect, 0, 60, 0)!;
    const b = s().addMark(arrow, 70, 60, 0)!;
    const c = s().addMark(arrow, 140, 12, 0)!;
    s().setMarkFades(a, { fadeIn: 10 });
    s().setMarkFades(a, { fadeOut: 20 });
    s().setMarkFades(b, { fadeIn: 3 });
    s().selectMarks([a]);
    copySelectedMarks();
    s().selectMarks([b, c]);
    expect(pasteFades()).toBe(true);
    const fades = (id: number) => {
      const m = s().doc.marks.find((k) => k.id === id)!;
      return [m.fadeIn ?? 0, m.fadeOut ?? 0];
    };
    expect(fades(b)).toEqual([10, 20]);
    // 12 frames: the fade-in, then what's left.
    expect(fades(c)).toEqual([10, 2]);
  });

  it("pastes its timing onto the selected markup, stacked in their order", () => {
    const a = s().addMark(rect, 10, 30, 0)!;
    const b = s().addMark(arrow, 100, 20, 0)!;
    const c = s().addMark(arrow, 150, 20, 1)!;
    s().selectMarks([a]);
    copySelectedMarks();
    s().selectMarks([b, c]);
    expect(pasteTiming()).toBe(true);
    const place = (id: number) => shownMarks(s().doc).find((m) => m.id === id)!;
    expect([place(b).start, place(b).end, place(c).start, place(c).end]).toEqual([10, 40, 10, 40]);
    // a stays put; b over c, under a.
    expect([place(a).lane, place(b).lane, place(c).lane]).toEqual([0, 1, 2]);
    s().undo();
    expect(place(b).start).toBe(100);
  });
});
