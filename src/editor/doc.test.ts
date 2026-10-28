import { describe, expect, it } from "vitest";
import {
  clipAt,
  clipStarts,
  copyClip,
  deleteClip,
  duplicateClip,
  editPoints,
  insertClip,
  moveClip,
  moveSlot,
  muteClip,
  muteTrack,
  pasteSlot,
  setCameraSize,
  split,
  total,
  trimClip,
  wholeSource,
  addSource,
  sourceLength,
} from "./doc";

describe("the document", () => {
  it("starts as the whole source, one clip", () => {
    const doc = wholeSource(785);
    expect(doc.clips).toEqual([{ id: 1, source: "source", in: 0, out: 785 }]);
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
      { id: 1, source: "source", in: 0, out: 40 },
      { id: 2, source: "source", in: 40, out: 100 },
    ]);
    // Nothing moves: the same frames play at the same places.
    expect(total(doc)).toBe(100);
    expect(clipStarts(doc)).toEqual([0, 40]);
    expect(editPoints(doc)).toEqual([0, 40, 100]);
  });

  it("splits a later clip in its own source frames", () => {
    const doc = split(split(wholeSource(100), 40), 70);
    expect(doc.clips).toEqual([
      { id: 1, source: "source", in: 0, out: 40 },
      { id: 2, source: "source", in: 40, out: 70 },
      { id: 3, source: "source", in: 70, out: 100 },
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

  it("a dragged clip stays put until its edge passes a neighbour's middle", () => {
    // Clips 0-30, 30-75 (2), 75-100 (3). Richard's bug: clip 2 longer than clip 3, so measured
    // by the pointer it jumped past clip 3 on a click.
    const long = split(split(wholeSource(100), 30), 75);
    expect(moveSlot(long, 2, 0)).toBe(1);
    expect(moveSlot(long, 2, 12)).toBe(1);
    expect(moveSlot(long, 2, 13)).toBe(2);
    expect(moveSlot(long, 2, -14)).toBe(1);
    expect(moveSlot(long, 2, -16)).toBe(0);
    expect(moveSlot(three, 1, 1000)).toBe(2);
  });
});

describe("trim", () => {
  const three = split(split(wholeSource(100), 40), 70);

  it("shortens a clip, the clips after it moving along", () => {
    const doc = trimClip(three, 1, 10, 30);
    expect(doc.clips[0]).toEqual({ id: 1, source: "source", in: 10, out: 30 });
    expect(clipStarts(doc)).toEqual([0, 20, 50]);
    expect(total(doc)).toBe(80);
  });

  it("pulls a clip back out, as far as the source goes", () => {
    const doc = trimClip(three, 2, -50, 500);
    expect(doc.clips[1]).toEqual({ id: 2, source: "source", in: 0, out: 100 });
  });

  it("keeps at least a frame", () => {
    // The in dragged past the out stops a frame before it, and the other way round.
    expect(trimClip(three, 2, 90, 70).clips[1]).toMatchObject({ in: 69, out: 70 });
    expect(trimClip(three, 2, 40, 10).clips[1]).toMatchObject({ in: 40, out: 41 });
    expect(trimClip(wholeSource(100), 1, 0, 0).clips[0]).toMatchObject({ in: 0, out: 1 });
  });

  it("does nothing if nothing changes", () => {
    expect(trimClip(three, 2, 40, 70)).toBe(three);
    expect(trimClip(three, 9, 0, 10)).toBe(three);
  });
});

describe("duplicate and paste", () => {
  // Clips 1 (0-40) and 2 (40-100), clip 1 trimmed to 10-40: 0-30 and 30-90 on the timeline.
  const doc = trimClip(split(wholeSource(100), 40), 1, 10, 40);

  it("puts a copy straight after the clip, a new clip with the same frames", () => {
    const dup = duplicateClip(doc, 1);
    expect(dup.clips).toEqual([
      { id: 1, source: "source", in: 10, out: 40 },
      { id: 3, source: "source", in: 10, out: 40 },
      { id: 2, source: "source", in: 40, out: 100 },
    ]);
    expect(dup.nextId).toBe(4);
    expect(clipStarts(dup)).toEqual([0, 30, 60]);
    expect(duplicateClip(doc, 9)).toBe(doc);
  });

  it("pastes a copy at a position, even once the original is gone", () => {
    const copy = copyClip(doc, 2)!;
    const pasted = insertClip(deleteClip(doc, 2), copy, 0);
    expect(pasted.clips.map((c) => [c.id, c.in, c.out])).toEqual([
      [3, 40, 100],
      [1, 10, 40],
    ]);
  });

  it("pastes at the cut nearest the playhead, the right one from a clip's middle", () => {
    // Cuts at 0, 30 and 90.
    expect(pasteSlot(doc, 0)).toBe(0);
    expect(pasteSlot(doc, 14)).toBe(0);
    expect(pasteSlot(doc, 15)).toBe(1);
    expect(pasteSlot(doc, 59)).toBe(1);
    expect(pasteSlot(doc, 60)).toBe(2);
    expect(pasteSlot(doc, 89)).toBe(2);
  });
});

describe("mute", () => {
  const doc = split(wholeSource(100), 40);

  it("mutes a clip, and unmutes it back to the same clip", () => {
    const muted = muteClip(doc, 2, true);
    expect(muted.clips[1]).toEqual({ id: 2, source: "source", in: 40, out: 100, muted: true });
    expect(muteClip(muted, 2, true)).toBe(muted);
    expect(muteClip(muted, 2, false).clips[1]).toStrictEqual({
      id: 2,
      source: "source",
      in: 40,
      out: 100,
    });
    expect(muteClip(doc, 9, true)).toBe(doc);
  });

  it("keeps a clip muted in its parts and copies", () => {
    const muted = muteClip(doc, 2, true);
    expect(split(muted, 70).clips.map((c) => c.muted)).toEqual([undefined, true, true]);
    expect(duplicateClip(muted, 2).clips.map((c) => c.muted)).toEqual([undefined, true, true]);
    expect(copyClip(muted, 1)).not.toHaveProperty("muted");
  });

  it("mutes the track", () => {
    expect(doc.muted).toBe(false);
    expect(muteTrack(doc, true).muted).toBe(true);
    expect(muteTrack(doc, false)).toBe(doc);
  });
});

describe("camera size", () => {
  const doc = split(wholeSource(100), 40);

  it("sets the clips' camera size, one change", () => {
    const sized = setCameraSize(doc, [1, 2], "large");
    expect(sized.clips.map((c) => c.cameraSize)).toEqual(["large", "large"]);
    expect(setCameraSize(sized, [1, 2], "large")).toBe(sized);
    expect(setCameraSize(doc, [9], "small")).toBe(doc);
  });

  it("keeps it in a clip's parts and copies", () => {
    const sized = setCameraSize(doc, [2], "small");
    expect(split(sized, 70).clips.map((c) => c.cameraSize)).toEqual([undefined, "small", "small"]);
    expect(duplicateClip(sized, 2).clips.map((c) => c.cameraSize)).toEqual([
      undefined,
      "small",
      "small",
    ]);
    expect(copyClip(sized, 1)).not.toHaveProperty("cameraSize");
  });
});

describe("several sources", () => {
  // A 100-frame first file, then a 50-frame one added.
  const doc = addSource(wholeSource(100, { width: 0, height: 0 }, "a"), "b", 50);

  it("puts an added file on the end, whole, as a clip of its own", () => {
    expect(doc.clips).toEqual([
      { id: 1, source: "a", in: 0, out: 100 },
      { id: 2, source: "b", in: 0, out: 50 },
    ]);
    expect(doc.sources).toEqual([
      { id: "a", frames: 100 },
      { id: "b", frames: 50 },
    ]);
    expect(total(doc)).toBe(150);
  });

  it("trims each clip only as far as its own file goes", () => {
    expect(trimClip(doc, 2, -10, 500).clips[1]).toEqual({ id: 2, source: "b", in: 0, out: 50 });
    expect(sourceLength(doc, doc.clips[0])).toBe(100);
    // Its parts keep their file.
    expect(split(doc, 120).clips.map((c) => c.source)).toEqual(["a", "b", "b"]);
  });

  it("adds the same file again as another clip, the file listed once", () => {
    const again = addSource(doc, "b", 50);
    expect(again.clips).toHaveLength(3);
    expect(again.sources).toHaveLength(2);
  });

  it("puts a file dropped onto a cut in there, kept to the timeline", () => {
    const at = (k: number) => addSource(doc, "c", 10, k).clips.map((c) => c.source);
    expect(at(0)).toEqual(["c", "a", "b"]);
    expect(at(1)).toEqual(["a", "c", "b"]);
    expect(at(2)).toEqual(["a", "b", "c"]);
    expect(at(9)).toEqual(["a", "b", "c"]);
    expect(addSource(doc, "c", 10, null).clips.map((c) => c.source)).toEqual(["a", "b", "c"]);
  });
});
