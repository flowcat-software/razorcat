import { describe, expect, it } from "vitest";
import {
  addMark,
  addRange,
  deleteClip,
  deleteMark,
  editPoints,
  freeLane,
  keepRanges,
  keepRangesInPlace,
  moveClip,
  removeRanges,
  setMark,
  shownMarks,
  split,
  trimClip,
  wholeSource,
  type Doc,
} from "./doc";

/** Text from 40 to 60 on a 100-frame source. */
const withText = (): Doc => addMark(wholeSource(100), "text", "Hi", 40, 20, 0);
const place = (doc: Doc) => shownMarks(doc).map((m) => [m.start, m.end, m.lane]);

describe("markup", () => {
  it("is added where it's put, kept to the timeline, anchored to its video", () => {
    const doc = withText();
    expect(place(doc)).toEqual([[40, 60, 0]]);
    expect(doc.marks[0]).toMatchObject({ clip: 1, at: 40, length: 20, text: "Hi" });
    // Near the end: cut short.
    expect(place(addMark(wholeSource(100), "text", "", 95, 20, 5))).toEqual([[95, 100, 1]]);
    expect(editPoints(doc)).toEqual([0, 40, 60, 100]);
  });

  it("follows its video when clips move", () => {
    // Split at 30: the text is on the second clip; moved to the front, it's at 10.
    const cut = split(withText(), 30);
    expect(cut.marks[0].clip).toBe(2);
    expect(place(moveClip(cut, 2, 0))).toEqual([[10, 30, 0]]);
  });

  it("slides to stay in its clip when its start is trimmed away, and back", () => {
    const trimmed = trimClip(withText(), 1, 50, 100);
    // Its video from 40 is gone: it starts the clip.
    expect(place(trimmed)).toEqual([[0, 20, 0]]);
    expect(place(trimClip(trimmed, 1, 0, 100))).toEqual([[40, 60, 0]]);
    // The end trimmed in past its start: it ends with the clip.
    expect(place(trimClip(withText(), 1, 0, 35))).toEqual([[15, 35, 0]]);
    // Past its end only: it stays (cut short at the timeline's end).
    expect(place(trimClip(withText(), 1, 0, 50))).toEqual([[40, 50, 0]]);
  });

  it("is split by a split through it, a part going with each clip", () => {
    const cut = split(withText(), 50);
    expect(place(cut)).toEqual([
      [40, 50, 0],
      [50, 60, 0],
    ]);
    expect(cut.marks.map((m) => [m.id, m.clip, m.at, m.length, m.text])).toEqual([
      [1, 1, 40, 10, "Hi"],
      [2, 2, 50, 10, "Hi"],
    ]);
    // The second clip moved to the front: its part goes with it.
    expect(place(moveClip(cut, 2, 0))).toEqual([
      [90, 100, 0],
      [0, 10, 0],
    ]);
  });

  it("stays whole over a split with the setting off, running on into the next clip", () => {
    const cut = split(withText(), 50, false);
    expect(cut.marks[0].clip).toBe(1);
    expect(place(cut)).toEqual([[40, 60, 0]]);
  });

  it("goes with its clip, or stays hidden for it (the setting)", () => {
    const cut = split(withText(), 30);
    expect(deleteClip(cut, 2, true).marks).toEqual([]);
    const kept = deleteClip(cut, 2, false);
    expect(place(kept)).toEqual([]);
    expect(kept.marks).toHaveLength(1);
  });

  it("keeps its place on the timeline when it doesn't follow", () => {
    const cut = split(withText(), 30);
    const moved = moveClip(cut, 2, 0);
    // Moved to the front, the second clip's frames 30-100 are now at 0-70; the text stays at 40.
    expect(place(keepRangesInPlace(cut, moved))).toEqual([[40, 60, 0]]);
  });

  it("survives keeping or removing ranges, handed to the part after a cut", () => {
    // Remove 10-20: the text (40-60) is in the part after the cut, 10 frames earlier.
    const doc = removeRanges(addRange(withText(), 10, 20));
    expect(place(doc)).toEqual([[30, 50, 0]]);
    expect(doc.marks[0].clip).toBe(doc.clips[1].id);
  });

  it("is cut where ranges cut through it, the part between dropped", () => {
    // Remove 50-55 from text 40-60: 40-50 and, closed up, 50-55.
    expect(place(removeRanges(addRange(withText(), 50, 55)))).toEqual([
      [40, 50, 0],
      [50, 55, 0],
    ]);
    // Setting off: whole, running on over the cut.
    expect(place(removeRanges(addRange(withText(), 50, 55), false))).toEqual([[40, 60, 0]]);
    // Keep 0-45 and 55-100: the same.
    const kept = keepRanges(addRange(addRange(withText(), 0, 45), 55, 100));
    expect(place(kept)).toEqual([
      [40, 45, 0],
      [45, 50, 0],
    ]);
  });

  it("moves, resizes and changes lane, re-anchored", () => {
    const doc = withText();
    const id = doc.marks[0].id;
    expect(place(setMark(doc, id, 70, 95, 1))).toEqual([[70, 95, 1]]);
    // Kept to a frame, and to the timeline.
    expect(place(setMark(doc, id, 50, 50, 0))).toEqual([[50, 51, 0]]);
    expect(place(setMark(doc, id, 90, 200, 9))).toEqual([[90, 100, 1]]);
    expect(setMark(doc, id, 40, 60, 0)).toBe(doc);
    expect(deleteMark(doc, id).marks).toEqual([]);
  });

  it("goes in a free lane", () => {
    const doc = withText();
    expect(freeLane(doc, 50, 70)).toBe(1);
    expect(freeLane(doc, 60, 80)).toBe(0);
    expect(freeLane(addMark(doc, "text", "", 50, 10, 1), 55, 58)).toBe(0);
  });
});
