// Crossfades (PLAN 4.7b): a clip over the end of the one before, the timeline that much shorter.
import { describe, expect, it } from "vitest";
import {
  addRange,
  clipAt,
  clipStarts,
  crossfadeAt,
  crossfades,
  deleteClip,
  fadesOf,
  inCrossfade,
  keepCrossfades,
  moveClip,
  playedClips,
  removeRanges,
  setClipFades,
  setCrossfade,
  split,
  total,
  trimClip,
  wholeSource,
  type Doc,
} from "./doc";

/** Three clips of 100 frames (ids 1 to 3), the second crossfading over 10. */
function three(): Doc {
  let doc = wholeSource(300);
  for (const f of [100, 200]) doc = split(doc, f);
  return setCrossfade(doc, 2, 10);
}

/** An edit as the store makes it: crossfades kept through it (`keepCrossfades`). */
const edited = (doc: Doc, edit: (d: Doc) => Doc) => keepCrossfades(doc, doc, edit(doc));

describe("crossfades", () => {
  it("overlap the clip before, the timeline that much shorter", () => {
    const doc = three();
    expect(crossfades(doc)).toEqual([0, 10, 0]);
    expect(clipStarts(doc)).toEqual([0, 90, 190]);
    expect(total(doc)).toBe(290);
    // In the crossfade, the outgoing clip is the one under the playhead; the incoming one mixes in.
    expect(clipAt(doc, 95)?.clip.id).toBe(1);
    expect(crossfadeAt(doc, 95)).toMatchObject({ index: 1, k: 5, length: 10 });
    expect(crossfadeAt(doc, 100)).toBeNull();
    // The player plays each clip from after its crossfade, end to end.
    expect(playedClips(doc).map((c) => [c.in, c.out])).toEqual([
      [0, 100],
      [110, 200],
      [200, 300],
    ]);
  });

  it("are kept to the clips: none on the first, a frame of each clip its own", () => {
    const doc = three();
    expect(setCrossfade(doc, 1, 5)).toBe(doc);
    expect(crossfades(setCrossfade(doc, 2, 500))[1]).toBe(99);
    // A short clip before: as long as it is, less its own crossfade.
    const short = trimClip(setCrossfade(doc, 3, 20), 2, 100, 125);
    expect(crossfades(short)).toEqual([0, 10, 15]);
    expect(setCrossfade(doc, 2, 0).clips[1]).not.toHaveProperty("crossfade");
  });

  it("take the place of the clip's own fade at that end", () => {
    let doc = setClipFades(three(), 2, { fadeIn: 30 });
    doc = setClipFades(doc, 1, { fadeOut: 30 });
    expect(fadesOf(doc, 1)).toEqual({ fadeIn: 0, fadeOut: 0 });
    expect(fadesOf(doc, 0)).toEqual({ fadeIn: 0, fadeOut: 0 });
    expect(fadesOf(setCrossfade(doc, 2, 0), 1).fadeIn).toBe(30);
  });

  it("can't be split, and a split elsewhere keeps them", () => {
    const doc = three();
    expect(inCrossfade(doc, 95)).toBe(true);
    // Its end too: the incoming clip's first part would be all crossfade.
    expect(inCrossfade(doc, 100)).toBe(true);
    expect(split(doc, 95)).toBe(doc);
    // Splitting the clip before it: its second part comes before it now, ending where it did.
    const cut = edited(doc, (d) => split(d, 50));
    expect(crossfades(cut)).toEqual([0, 0, 10, 0]);
    expect(total(cut)).toBe(290);
  });

  it("go when another clip comes before them, and come back with an undo", () => {
    const doc = three();
    expect(crossfades(edited(doc, (d) => moveClip(d, 2, 0)))).toEqual([0, 0, 0]);
    expect(crossfades(edited(doc, (d) => deleteClip(d, 1)))).toEqual([0, 0]);
    // Moved away and back within one drag: the clip before is the one it was.
    const away = keepCrossfades(doc, doc, moveClip(doc, 1, 2));
    const back = keepCrossfades(doc, away, moveClip(away, 1, 0));
    expect(crossfades(back)).toEqual([0, 10, 0]);
    // Trimmed, the clip before is still the one it was.
    expect(crossfades(edited(doc, (d) => trimClip(d, 1, 0, 80)))).toEqual([0, 10, 0]);
  });

  it("go when ranges are cut out over them, what comes after moving along", () => {
    const doc = three();
    // Frames 92 to 96, in the crossfade: it goes, and what came after it moves along with it.
    const cut = removeRanges(addRange(doc, 92, 96));
    expect(crossfades(cut)).toEqual([0, 0, 0]);
    expect(cut.clips.map((c) => [c.in, c.out])).toEqual([
      [0, 92],
      [106, 200],
      [200, 300],
    ]);
  });
});
