import { describe, expect, it } from "vitest";
import { clickCount, clickSyncEffect, recordingStyleOf, restyleClicks } from "./clickStyles";
import { addMark, markFades, setFades, wholeSource, type Doc, type MarkObject } from "./doc";
import type { ClickLook } from "../markup/model/types";

const click = (look: ClickLook, size: number, double = false): MarkObject => ({
  kind: "click",
  x: 10,
  y: 20,
  look,
  size,
  double,
  button: "right",
});

/** A 300-frame video with these clicks, a second apart at 30 fps, 24 frames each. */
function withClicks(...objects: MarkObject[]): Doc {
  return objects.reduce((d, o, i) => addMark(d, o, i * 30, 24, 0), wholeSource(300));
}

describe("Sync style for clicks", () => {
  it("has nothing to do with no clicks, or all in the style", () => {
    const ripple = { look: "ripple", size: 44 } as const;
    expect(clickSyncEffect(wholeSource(300), ripple)).toBe("none");
    expect(clickSyncEffect(withClicks(click("ripple", 44), click("ripple", 44)), ripple)).toBe(
      "none",
    );
  });

  it("restyles alike clicks without warning, and warns when they differ", () => {
    const alike = withClicks(click("ring", 44), click("ring", 44));
    expect(clickSyncEffect(alike, { look: "halo", size: 44 })).toBe("uniform");
    const mixed = withClicks(click("ring", 44), click("ring", 60));
    expect(clickSyncEffect(mixed, { look: "ring", size: 44 })).toBe("mixed");
  });

  it("gives every click the style, keeping its button, double-click and timing", () => {
    const doc = withClicks(click("ring", 44, true), click("halo", 60), {
      kind: "text",
      x: 0,
      y: 0,
      text: "hi",
    } as MarkObject);
    const after = restyleClicks(doc, { look: "ripple", size: 32 });
    const clicks = after.marks.filter((m) => m.object.kind === "click");
    expect(clicks.map((m) => m.object)).toEqual([
      { ...click("ripple", 32, true) },
      { ...click("ripple", 32) },
    ]);
    expect(clicks.map((m) => m.length)).toEqual([24, 24]);
    expect(after.marks[2]).toBe(doc.marks[2]);
    expect(clickCount(after)).toBe(2);
  });

  it("is the same document when nothing changes", () => {
    const doc = withClicks(click("ring", 44));
    expect(restyleClicks(doc, { look: "ring", size: 44 })).toBe(doc);
    expect(
      restyleClicks(doc, { look: "ring", size: 44 }, { length: 24, fadeIn: 0, fadeOut: 0 }),
    ).toBe(doc);
  });
});

describe("clicks following Settings › Recording", () => {
  it("take its timing too: length and fades", () => {
    const doc = withClicks(click("ring", 44), click("ring", 44));
    const after = restyleClicks(
      doc,
      { look: "ripple", size: 44 },
      { length: 15, fadeIn: 3, fadeOut: 6 },
    );
    for (const m of after.marks) {
      expect(m.length).toBe(15);
      expect(markFades(m, m.length)).toEqual({ fadeIn: 3, fadeOut: 6 });
      expect(m.object).toMatchObject({ look: "ripple", button: "right" });
    }
  });
});

describe("Set recording style", () => {
  it("is a click's style and timing in seconds, kept to Recording's limits", () => {
    const one = withClicks(click("halo", 60));
    const doc = setFades(one, [one.marks[0].id], 0, 9);
    expect(recordingStyleOf(doc.marks[0], 30)).toEqual({
      look: "halo",
      size: 60,
      seconds: 0.8,
      fadeIn: 0,
      fadeOut: 0.3,
    });
    const long = { ...doc.marks[0], length: 600, fadeOut: 200 };
    expect(recordingStyleOf(long, 30)).toMatchObject({ seconds: 5, fadeOut: 2 });
  });

  it("is nothing for markup that isn't a click", () => {
    const doc = addMark(wholeSource(300), { kind: "text", x: 0, y: 0 } as MarkObject, 0, 30, 0);
    expect(recordingStyleOf(doc.marks[0], 30)).toBeNull();
  });
});
