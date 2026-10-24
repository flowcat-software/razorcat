// Redactions on video (PLAN 4.8): the box in whole pixels, the strengths, pixelate's averages.
import { describe, expect, it } from "vitest";
import { addMark, fadeEnds, markFades, setMarkFades, wholeSource } from "./doc";
import { blurReach, blurSigma, grownBox, pixelate, redactBox, redactStrength } from "./redactions";

const frame = { width: 100, height: 50 };

describe("redactions", () => {
  it("cover whole output pixels, kept to the frame", () => {
    expect(redactBox({ x: 10.4, y: 5.6, width: 20.2, height: 10 }, frame)).toEqual({
      x: 10,
      y: 6,
      width: 21,
      height: 10,
    });
    expect(redactBox({ x: -5, y: 40, width: 20, height: 30 }, frame)).toEqual({
      x: 0,
      y: 40,
      width: 15,
      height: 10,
    });
    expect(redactBox({ x: 120, y: 0, width: 10, height: 10 }, frame)).toBeNull();
  });

  it("take whole strengths, at least the smallest that does anything", () => {
    expect(redactStrength("pixelate", 1)).toBe(2);
    expect(redactStrength("blur", 0)).toBe(1);
    expect(redactStrength("blur", 6.4)).toBe(6);
    // Vandal's three box blurs of radius r: variance r(r + 1).
    expect(blurSigma(3)).toBeCloseTo(Math.sqrt(12));
    expect(blurReach(3)).toBe(11);
    expect(grownBox({ x: 5, y: 5, width: 10, height: 10 }, 8, frame)).toEqual({
      x: 0,
      y: 0,
      width: 23,
      height: 23,
    });
  });

  it("pixelate on a grid from the box's corner, cut cells averaging what they have", () => {
    // 3 × 2 pixels, blocks of 2: one whole cell (0..1) and a cut one (2).
    const grey = (v: number) => [v, v, v, 255];
    const px = new Uint8ClampedArray([
      ...grey(0),
      ...grey(10),
      ...grey(100),
      ...grey(20),
      ...grey(31),
      ...grey(201),
    ]);
    pixelate(px, 3, 2, 2);
    const out = [...px].filter((_, i) => i % 4 === 0);
    // (0 + 10 + 20 + 31) / 4 = 15.25; (100 + 201) / 2 = 150.5, rounded up.
    expect(out).toEqual([15, 15, 151, 15, 15, 151]);
  });

  it("don't fade, whatever asks", () => {
    const redact = {
      kind: "redact" as const,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      mode: "blur" as const,
      strength: 6,
    };
    const doc = addMark(wholeSource(100), redact, 10, 30, 0);
    const id = doc.marks[0].id;
    expect(setMarkFades(doc, id, { fadeIn: 5 })).toBe(doc);
    expect(markFades(fadeEnds(doc, [id], 8, "both").marks[0], 30)).toEqual({
      fadeIn: 0,
      fadeOut: 0,
    });
  });
});
