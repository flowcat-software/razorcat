import { describe, expect, it } from "vitest";
import type { MarkObject } from "./doc";
import {
  addMark,
  addRange,
  fadeEnds,
  deleteClip,
  deleteMark,
  dropMark,
  duplicateClip,
  editPoints,
  freeLane,
  keepRanges,
  keepRangesInPlace,
  laneCount,
  markFades,
  markLabel,
  markOpacity,
  moveClip,
  packLanes,
  placeMarks,
  removeRanges,
  resizeEdges,
  setMark,
  setMarkFades,
  settleLanes,
  stackLane,
  stepLane,
  shownMarks,
  split,
  trimClip,
  wholeSource,
  type Doc,
} from "./doc";

/** Text saying `text`. */
const text = (text: string): MarkObject => ({
  kind: "text",
  x: 0,
  y: 0,
  width: 0,
  autoWidth: true,
  text,
  fontFamily: "Segoe UI",
  fontSize: 20,
  bold: false,
  italic: false,
  align: "left",
  rotation: 0,
  color: "#fff",
  background: false,
  backgroundColor: "#000",
});

/** Text from 40 to 60 on a 100-frame source. */
const withText = (): Doc => addMark(wholeSource(100), text("Hi"), 40, 20, 0);
const place = (doc: Doc) => shownMarks(doc).map((m) => [m.start, m.end, m.lane]);

describe("markup", () => {
  it("is added where it's put, kept to the timeline, anchored to its video", () => {
    const doc = withText();
    expect(place(doc)).toEqual([[40, 60, 0]]);
    expect(doc.marks[0]).toMatchObject({ clip: 1, at: 40, length: 20, object: text("Hi") });
    // Near the end: cut short.
    expect(place(addMark(wholeSource(100), text(""), 95, 20, 5))).toEqual([[95, 100, 1]]);
    expect(editPoints(doc)).toEqual([0, 40, 60, 100]);
  });

  it("is copied with its clip, the copy's own, as new markup", () => {
    // Clips 1 (0-30) and 2 (30-100); the text on clip 2, at 40.
    const cut = split(withText(), 30);
    const dup = duplicateClip(cut, 2);
    expect(dup.marks.map((m) => [m.id, m.clip])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(dup.nextMarkId).toBe(3);
    expect(place(dup)).toEqual([
      [40, 60, 0],
      [110, 130, 0],
    ]);
    // Markup on another clip isn't.
    expect(duplicateClip(cut, 1).marks).toHaveLength(1);
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
    expect(cut.marks.map((m) => [m.id, m.clip, m.at, m.length, m.object])).toEqual([
      [1, 1, 40, 10, text("Hi")],
      [2, 2, 50, 10, text("Hi")],
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

  it("says on the timeline what it is", () => {
    expect(markLabel(text(" Hello\nthere"))).toBe("Hello");
    expect(markLabel(text(""))).toBe("Text");
    // A click: which button, and if it was a double-click (PLAN 5b.6d).
    const click = { kind: "click", x: 0, y: 0, size: 44, look: "ring" } as const;
    expect(markLabel({ ...click, button: "left", double: false })).toBe("L click");
    expect(markLabel({ ...click, button: "right", double: true })).toBe("R click ×2");
    // Double-clicks not shown (Settings › Recording): no "×2".
    expect(markLabel({ ...click, button: "right", double: true }, false)).toBe("R click");
    // None (made before there was a choice): the left.
    expect(markLabel({ ...click, double: true })).toBe("L click ×2");
  });

  it("goes in front: the top lane if it has room, else a new one above it", () => {
    const doc = withText();
    expect(freeLane(doc, 50, 70)).toBe(-1);
    expect(freeLane(doc, 60, 80)).toBe(0);
    // Room at the top over something lower down: still in front of it.
    expect(freeLane(addMark(doc, text(""), 70, 10, 1), 72, 78)).toBe(0);
  });
});

describe("fades", () => {
  // Text over 20-80 of a 100-frame source, fading in over 10 and out over 15.
  const faded = (): Doc => {
    const doc = addMark(wholeSource(100), text("Hi"), 20, 60, 0);
    return setMarkFades(setMarkFades(doc, 1, { fadeIn: 10 }), 1, { fadeOut: 15 });
  };
  const fadesOf = (doc: Doc) => doc.marks.map((m) => [m.fadeIn ?? 0, m.fadeOut ?? 0]);

  it("take the default at either end or both, as much as the length allows", () => {
    // 1: 60 frames, faded 10 in and 15 out; 2: 20 frames, unfaded.
    const doc = addMark(faded(), text("b"), 0, 20, 1);
    expect(fadesOf(fadeEnds(doc, [1, 2], 15, "in"))).toEqual([
      [15, 15],
      [15, 0],
    ]);
    expect(fadesOf(fadeEnds(doc, [1, 2], 15, "out"))).toEqual([
      [10, 15],
      [0, 15],
    ]);
    // Both on 20 frames: half each.
    expect(fadesOf(fadeEnds(doc, [1, 2], 15, "both"))).toEqual([
      [15, 15],
      [10, 10],
    ]);
    // 0 removes them.
    expect(fadesOf(fadeEnds(doc, [1], 0, "in"))).toEqual([
      [0, 15],
      [0, 0],
    ]);
    expect(fadesOf(fadeEnds(doc, [1], 0, "both"))).toEqual([
      [0, 0],
      [0, 0],
    ]);
    // Only those asked for.
    expect(fadesOf(fadeEnds(doc, [2], 5, "both"))).toEqual([
      [10, 15],
      [5, 5],
    ]);
  });

  it("fit its length: the fade-in first, the fade-out in what's left", () => {
    expect(markFades({}, 30)).toEqual({ fadeIn: 0, fadeOut: 0 });
    expect(markFades({ fadeIn: 10, fadeOut: 15 }, 60)).toEqual({ fadeIn: 10, fadeOut: 15 });
    expect(markFades({ fadeIn: 10, fadeOut: 15 }, 20)).toEqual({ fadeIn: 10, fadeOut: 10 });
    expect(markFades({ fadeIn: 50, fadeOut: 15 }, 20)).toEqual({ fadeIn: 20, fadeOut: 0 });
  });

  it("are set one at a time, kept to what the other leaves", () => {
    const doc = faded();
    expect(fadesOf(doc)).toEqual([[10, 15]]);
    expect(fadesOf(setMarkFades(doc, 1, { fadeIn: 100 }))).toEqual([[45, 15]]);
    expect(fadesOf(setMarkFades(doc, 1, { fadeOut: -4 }))).toEqual([[10, 0]]);
    expect(setMarkFades(doc, 1, { fadeIn: 10 })).toBe(doc);
    expect(setMarkFades(doc, 9, { fadeIn: 3 })).toBe(doc);
  });

  it("shorten with a trim and come back when it's pulled back", () => {
    const doc = faded();
    const short = setMark(doc, 1, 20, 40, 0);
    expect(markFades(short.marks[0], 20)).toEqual({ fadeIn: 10, fadeOut: 10 });
    const back = setMark(short, 1, 20, 80, 0);
    expect(markFades(back.marks[0], 60)).toEqual({ fadeIn: 10, fadeOut: 15 });
  });

  it("are cut clean at a split: the start keeps the fade-in, the end the fade-out", () => {
    expect(fadesOf(split(faded(), 50))).toEqual([
      [10, 0],
      [0, 15],
    ]);
  });

  it("fade at the cut too when asked, each part as the whole did", () => {
    expect(fadesOf(split(faded(), 50, true, true))).toEqual([
      [10, 15],
      [10, 15],
    ]);
    // Cutting a range out the same: the part between dropped.
    const ranged = addRange(faded(), 40, 60);
    expect(fadesOf(removeRanges(ranged, true, false))).toEqual([
      [10, 0],
      [0, 15],
    ]);
    expect(fadesOf(removeRanges(ranged, true, true))).toEqual([
      [10, 15],
      [10, 15],
    ]);
  });

  it("ramp its opacity frame by frame, as ffmpeg's fade does", () => {
    const fades = { fadeIn: 4, fadeOut: 2 };
    const ramp = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((u) => markOpacity(fades, 10, u));
    // Clear on the first frame and on the last.
    expect(ramp).toEqual([0, 0.25, 0.5, 0.75, 1, 1, 1, 1, 0.5, 0]);
    expect(markOpacity({ fadeIn: 0, fadeOut: 0 }, 10, 0)).toBe(1);
    expect(markOpacity({ fadeIn: 0, fadeOut: 0 }, 10, 9)).toBe(1);
    // Fades meeting in the middle.
    expect(markOpacity({ fadeIn: 5, fadeOut: 5 }, 10, 5)).toBe(0.8);
    expect(markOpacity({ fadeIn: 5, fadeOut: 5 }, 10, 6)).toBe(0.6);
  });

  it("go with a duplicate", () => {
    const doc = duplicateClip(faded(), 1);
    expect(fadesOf(doc)).toEqual([
      [10, 15],
      [10, 15],
    ]);
  });
});

describe("lanes", () => {
  /** Items' lanes, by id. */
  const lanes = (doc: Doc) => Object.fromEntries(shownMarks(doc).map((m) => [m.id, m.lane]));
  /** A 100-frame edit with markup at `places` ([start, end, lane]), settled as an edit is. */
  const with_ = (...places: [number, number, number][]) =>
    settleLanes(
      places.reduce(
        (doc, [a, b, lane]) => addMark(doc, text("x"), a, b - a, lane),
        wholeSource(100),
      ),
    );

  it("never overlap in a lane: the later item goes down, a new lane if need be", () => {
    const doc = with_([0, 20, 0], [10, 30, 0], [15, 25, 0]);
    expect(lanes(doc)).toEqual({ 1: 0, 2: 1, 3: 2 });
    expect(laneCount(doc)).toBe(3);
  });

  it("keep their lanes when they fit, and close up over empty ones", () => {
    expect(lanes(with_([0, 10, 0], [20, 30, 0]))).toEqual({ 1: 0, 2: 0 });
    expect(lanes(with_([0, 10, 2], [20, 30, 5]))).toEqual({ 1: 0, 2: 1 });
    expect(laneCount(wholeSource(100))).toBe(1);
  });

  it("make the moved item give way, not the one it landed on", () => {
    const doc = with_([0, 20, 0], [40, 60, 1]);
    const moved = settleLanes(setMark(doc, 2, 10, 30, 0), [2]);
    expect(lanes(moved)).toEqual({ 1: 0, 2: 1 });
    // Above the first lane: a new lane on top, the others moving down.
    const top = settleLanes(setMark(doc, 2, 10, 30, -1), [2]);
    expect(lanes(top)).toEqual({ 1: 1, 2: 0 });
  });

  it("are sorted out when moving video pushes items into each other", () => {
    // Clips 0-50 and 50-100; an item over 10-45 and one over 55-65, in one lane.
    let doc = split(wholeSource(100), 50);
    doc = settleLanes(addMark(addMark(doc, text("a"), 10, 35, 0), text("b"), 55, 10, 0));
    expect(lanes(doc)).toEqual({ 1: 0, 2: 0 });
    // Clip 1 trimmed to 20 frames: clip 2's item comes back to 25-35, under the first (which
    // runs on past its clip's end); it starts later, so it moves down.
    expect(lanes(settleLanes(trimClip(doc, 1, 0, 20)))).toEqual({ 1: 0, 2: 1 });
  });

  it("put an item in front of or behind all it overlaps", () => {
    const doc = with_([0, 20, 0], [10, 30, 0], [50, 60, 0]);
    expect(lanes(doc)).toEqual({ 1: 0, 2: 1, 3: 0 });
    expect(stackLane(doc, 2, "front")).toBe(-1);
    expect(stackLane(doc, 1, "back")).toBe(2);
    expect(stackLane(doc, 3, "front")).toBe(0);
    const front = settleLanes(setMark(doc, 2, 10, 30, stackLane(doc, 2, "front")), [2]);
    expect(lanes(front)).toEqual({ 1: 1, 2: 0, 3: 1 });
  });

  it("step an item a lane up or down, passing one lane of what it overlaps", () => {
    // Free there: just moves (1 over the top, 2 under it, 3 elsewhere in time).
    const doc = with_([0, 20, 0], [10, 30, 0], [50, 60, 1]);
    expect(lanes(doc)).toEqual({ 1: 0, 2: 1, 3: 1 });
    expect(lanes(stepLane(doc, 3, -1))).toEqual({ 1: 0, 2: 1, 3: 0 });
    // Busy there and no lane beyond: a new one between, only what makes way staying down (3
    // goes back to its lane).
    expect(lanes(stepLane(doc, 2, -1))).toEqual({ 1: 1, 2: 0, 3: 1 });
    // Down past 2 to a new bottom lane; the emptied top lane closes up.
    expect(lanes(stepLane(doc, 1, 1))).toEqual({ 1: 1, 2: 0, 3: 0 });
    // Nothing to pass at the top or bottom: stays.
    expect(stepLane(doc, 1, -1)).toBe(doc);
    expect(stepLane(doc, 2, 1)).toBe(doc);
  });

  it("move a group as one block, keeping its order front to back", () => {
    // Three in lanes 0-2 over 0-20, one in lane 3 over 3-23; the group: 4 in lane 2 over 23-40
    // in front of 5 in lane 3 over 33-52.
    const doc = with_([0, 20, 0], [0, 20, 1], [0, 20, 2], [3, 23, 3], [23, 40, 2], [33, 52, 3]);
    expect(lanes(doc)).toEqual({ 1: 0, 2: 1, 3: 2, 4: 3, 5: 2, 6: 3 });
    // Ten frames earlier: 5 lands on 3 and 6 on 4, so the block goes down two lanes, 5 still
    // over 6 (one by one, 5 went below 6).
    const moved = placeMarks(doc, [
      { id: 5, start: 13, end: 30, lane: 2 },
      { id: 6, start: 23, end: 42, lane: 3 },
    ]);
    expect(lanes(moved)).toEqual({ 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 });
    // Where it fits, it stays.
    const fits = placeMarks(doc, [
      { id: 5, start: 60, end: 77, lane: 2 },
      { id: 6, start: 70, end: 89, lane: 3 },
    ]);
    expect(lanes(fits)).toEqual({ 1: 0, 2: 1, 3: 2, 4: 3, 5: 2, 6: 3 });
  });

  it("drop between busy lanes into a new one, above or below as the pointer is", () => {
    // Three over 0-50 in lanes 0-2; 4 under them over 15-60.
    const doc = with_([0, 50, 0], [0, 50, 1], [0, 50, 2], [15, 60, 3]);
    expect(lanes(doc)).toEqual({ 1: 0, 2: 1, 3: 2, 4: 3 });
    // On lane 1's top half: between 1 and 2; its lower half: between 2 and 3.
    expect(lanes(dropMark(doc, 4, 15, 60, 1, false))).toEqual({ 1: 0, 2: 2, 3: 3, 4: 1 });
    expect(lanes(dropMark(doc, 4, 15, 60, 1, true))).toEqual({ 1: 0, 2: 1, 3: 3, 4: 2 });
    // A free lane, or above them all: straight in.
    expect(lanes(dropMark(doc, 4, 60, 90, 0, true))).toEqual({ 1: 0, 2: 1, 3: 2, 4: 0 });
    expect(lanes(dropMark(doc, 4, 15, 60, -1, false))).toEqual({ 1: 1, 2: 2, 3: 3, 4: 0 });
  });

  it("step past one lane into a free one beyond", () => {
    // 3 at the bottom under 2; lane 0 has room at 3's time.
    const doc = with_([0, 10, 0], [20, 40, 1], [25, 35, 2]);
    expect(lanes(doc)).toEqual({ 1: 0, 2: 1, 3: 2 });
    expect(lanes(stepLane(doc, 3, -1))).toEqual({ 1: 0, 2: 1, 3: 0 });
  });
});

describe("cleaning up the lanes", () => {
  /** Markup at these frames, in these lanes, on a 300-frame source (ids 1 on, in order). */
  const laid = (items: [number, number, number][]): Doc => {
    let doc = wholeSource(300);
    for (const [start, end] of items) doc = addMark(doc, text(""), start, end - start, 0);
    return { ...doc, marks: doc.marks.map((m, i) => ({ ...m, lane: items[i][2] })) };
  };
  const lanes = (doc: Doc) => shownMarks(doc).map((m) => m.lane);

  it("closes the lanes up, keeping every item's frames and its order against what it overlaps", () => {
    // A reported case: eight lanes, steps stacked at 130-150 with gaps under the long one.
    const doc = laid([
      [130, 150, 0],
      [175, 195, 0],
      [210, 230, 0],
      [175, 240, 1],
      [215, 235, 2],
      [130, 150, 3],
      [190, 210, 4],
      [130, 150, 5],
      [130, 150, 6],
      [130, 150, 7],
    ]);
    const packed = packLanes(doc);
    expect(lanes(packed)).toEqual([0, 0, 0, 1, 2, 1, 2, 2, 3, 4]);
    expect(shownMarks(packed).map((m) => [m.start, m.end])).toEqual(
      shownMarks(doc).map((m) => [m.start, m.end]),
    );
    // Nothing more to close up.
    expect(packLanes(packed)).toBe(packed);
  });

  it("never moves an item down, or past what's in front of it", () => {
    // B under A, both at 10-20; C alone further on, low down: up to the top.
    const doc = laid([
      [10, 20, 0],
      [10, 20, 2],
      [50, 60, 3],
    ]);
    expect(lanes(packLanes(doc))).toEqual([0, 1, 0]);
  });
});

describe("resizing several items' edges together", () => {
  // Lane 0: A 20-40, B 50-70 (B's neighbour on the left: A); lane 1: C 10-30.
  const doc = (() => {
    let d = wholeSource(100);
    for (const [start, end] of [
      [20, 40],
      [50, 70],
      [10, 30],
    ]) {
      d = addMark(d, text(""), start, end - start, 0);
    }
    return { ...d, marks: d.marks.map((m, i) => ({ ...m, lane: [0, 0, 1][i] })) };
  })();
  const spans = (places: { start: number; end: number }[]) => places.map((p) => [p.start, p.end]);

  it("moves each start by as much, each stopping where it's blocked", () => {
    // 15 earlier: B stops at A's end (40), C at the timeline's start.
    expect(spans(resizeEdges(doc, [2, 3], "start", -15))).toEqual([
      [40, 70],
      [0, 30],
    ]);
    // 25 later: C stops a frame short of its end; B goes all the way.
    expect(spans(resizeEdges(doc, [2, 3], "start", 25))).toEqual([
      [69, 70],
      [29, 30],
    ]);
  });

  it("moves each end by as much, each stopping where it's blocked", () => {
    // 20 later: A stops at B's start (50); C goes all the way.
    expect(spans(resizeEdges(doc, [1, 3], "end", 20))).toEqual([
      [20, 50],
      [10, 50],
    ]);
    // Past the timeline's end: B stops there.
    expect(spans(resizeEdges(doc, [2], "end", 60))).toEqual([[50, 100]]);
  });
});
