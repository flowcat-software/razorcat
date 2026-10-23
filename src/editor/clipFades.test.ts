// Clip fades (PLAN 4.7a): to and from black (or a colour, 4.7c), kept to the clip, through
// splits, cuts and copies.
import { describe, expect, it } from "vitest";
import {
  addRange,
  clipFadeColourAt,
  clipFades,
  clipOpacityAt,
  copyClip,
  fadeColours,
  duplicateClip,
  fadeClipEnds,
  insertClip,
  muteClip,
  removeRanges,
  setClipFades,
  setClipFadeColours,
  setClipsFades,
  split,
  trimClip,
  wholeSource,
  type Doc,
} from "./doc";

/** One clip of 100 frames, fading in over 10 and out over 20. */
function faded(): Doc {
  const doc = setClipFades(wholeSource(100), 1, { fadeIn: 10 });
  return setClipFades(doc, 1, { fadeOut: 20 });
}

describe("clip fades", () => {
  it("are kept to whole frames and the clip's length, the fade-in first", () => {
    const doc = faded();
    expect(clipFades(doc.clips[0])).toEqual({ fadeIn: 10, fadeOut: 20 });
    expect(clipFades(setClipFades(doc, 1, { fadeOut: 500 }).clips[0]).fadeOut).toBe(90);
    expect(setClipFades(doc, 1, { fadeIn: 10.2 })).toBe(doc);
    // A trim shortens them; pulling it back gives them back.
    const short = trimClip(doc, 1, 0, 15);
    expect(clipFades(short.clips[0])).toEqual({ fadeIn: 10, fadeOut: 5 });
    expect(clipFades(trimClip(short, 1, 0, 100).clips[0])).toEqual({ fadeIn: 10, fadeOut: 20 });
  });

  it("show the picture as markup fades do: from black, and to black on the last frame", () => {
    const doc = faded();
    expect(clipOpacityAt(doc, 0)).toBe(0);
    expect(clipOpacityAt(doc, 5)).toBe(0.5);
    expect(clipOpacityAt(doc, 50)).toBe(1);
    expect(clipOpacityAt(doc, 80)).toBe(19 / 20);
    expect(clipOpacityAt(doc, 99)).toBe(0);
  });

  it("split clean, or with the setting each part fading at the cut", () => {
    const clean = split(faded(), 50);
    expect(clean.clips.map(clipFades)).toEqual([
      { fadeIn: 10, fadeOut: 0 },
      { fadeIn: 0, fadeOut: 20 },
    ]);
    expect(clean.clips[0]).not.toHaveProperty("fadeOut");
    const both = split(faded(), 50, true, false, true);
    expect(both.clips.map(clipFades)).toEqual([
      { fadeIn: 10, fadeOut: 20 },
      { fadeIn: 10, fadeOut: 20 },
    ]);
  });

  it("are cut the same way when ranges are cut out of a clip's middle", () => {
    const cut = removeRanges(addRange(faded(), 40, 60));
    expect(cut.clips.map(clipFades)).toEqual([
      { fadeIn: 10, fadeOut: 0 },
      { fadeIn: 0, fadeOut: 20 },
    ]);
  });

  it("go with copies, unless copies keep none, and with a mute", () => {
    const doc = faded();
    expect(clipFades(duplicateClip(doc, 1).clips[1])).toEqual({ fadeIn: 10, fadeOut: 20 });
    expect(clipFades(duplicateClip(doc, 1, false).clips[1])).toEqual({ fadeIn: 0, fadeOut: 0 });
    expect(clipFades(insertClip(doc, copyClip(doc, 1)!, 0).clips[0]).fadeIn).toBe(10);
    expect(muteClip(doc, 1, true).clips[0]).toMatchObject({ muted: true, fadeIn: 10 });
    expect(muteClip(muteClip(doc, 1, true), 1, false).clips[0]).not.toHaveProperty("muted");
  });

  it("take the default fade at either end or both, and pasted fades", () => {
    const doc = split(wholeSource(100), 20);
    const both = fadeClipEnds(doc, [1, 2], 15, "both");
    // The 20-frame clip gets half its length at its start, the rest at its end.
    expect(both.clips.map(clipFades)).toEqual([
      { fadeIn: 10, fadeOut: 10 },
      { fadeIn: 15, fadeOut: 15 },
    ]);
    expect(clipFades(fadeClipEnds(both, [2], 0, "out").clips[1])).toEqual({
      fadeIn: 15,
      fadeOut: 0,
    });
    expect(setClipsFades(doc, [1, 2], 5, 30).clips.map(clipFades)).toEqual([
      { fadeIn: 5, fadeOut: 15 },
      { fadeIn: 5, fadeOut: 30 },
    ]);
  });

  it("fade from and to a colour of their own, black if not set", () => {
    const doc = setClipFadeColours(faded(), [1], "#ffffff", "out");
    expect(fadeColours(doc.clips[0])).toEqual({ fadeIn: "#000000", fadeOut: "#ffffff" });
    expect(setClipFadeColours(doc, [1], "#ffffff", "out")).toBe(doc);
    // Black isn't kept: it's what none is.
    expect(setClipFadeColours(doc, [1], "#000000", "both").clips[0]).not.toHaveProperty(
      "fadeOutColour",
    );
    // The preview's fade shows the fade-in's colour, then the fade-out's.
    expect(clipFadeColourAt(doc, 3)).toBe("#000000");
    expect(clipFadeColourAt(doc, 95)).toBe("#ffffff");
    // Kept through a drag to no fade and back; Remove Fades takes it away.
    const none = setClipFades(doc, 1, { fadeOut: 0 });
    expect(fadeColours(setClipFades(none, 1, { fadeOut: 20 }).clips[0]).fadeOut).toBe("#ffffff");
    expect(fadeColours(fadeClipEnds(doc, [1], 0, "out").clips[0]).fadeOut).toBe("#000000");
  });

  it("keep their colours through splits, copies and pasted fades", () => {
    const doc = setClipFadeColours(faded(), [1], "#ffffff", "both");
    // The cut's own ends don't fade, so they're black; with the setting, as the whole's.
    const cut = split(doc, 50);
    expect(cut.clips.map(fadeColours)).toEqual([
      { fadeIn: "#ffffff", fadeOut: "#000000" },
      { fadeIn: "#000000", fadeOut: "#ffffff" },
    ]);
    expect(split(doc, 50, true, false, true).clips.map(fadeColours)).toEqual([
      { fadeIn: "#ffffff", fadeOut: "#ffffff" },
      { fadeIn: "#ffffff", fadeOut: "#ffffff" },
    ]);
    expect(fadeColours(duplicateClip(doc, 1).clips[1]).fadeOut).toBe("#ffffff");
    expect(fadeColours(duplicateClip(doc, 1, false).clips[1]).fadeOut).toBe("#000000");
    const copy = copyClip(doc, 1)!;
    expect(fadeColours(insertClip(doc, copy, 1).clips[1])).toEqual(fadeColours(doc.clips[0]));
    const two = split(faded(), 50);
    const pasted = setClipsFades(two, [1, 2], 5, 5, { fadeOut: "#ffffff" });
    expect(pasted.clips.map((c) => fadeColours(c).fadeOut)).toEqual(["#ffffff", "#ffffff"]);
    // Markup's fades have no colour: pasted, they're black.
    expect(fadeColours(setClipsFades(doc, [1], 5, 5).clips[0]).fadeOut).toBe("#000000");
  });
});
