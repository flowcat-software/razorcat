// Redactions on video (PLAN 4.8): the box in whole pixels, the strengths, pixelate's averages.
import { describe, expect, it } from "vitest";
import { addMark, fadeEnds, markFades, setMarkFades, wholeSource } from "./doc";
import {
  blurRadius,
  blurReach,
  boxBlur,
  grownBox,
  pixelate,
  redactBox,
  redactStrength,
} from "./redactions";

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
    // Three box blurs reach three radii; boxblur takes at most half the shorter side.
    expect(blurReach(3)).toBe(9);
    expect(blurRadius(30, { width: 200, height: 41 })).toBe(20);
    expect(grownBox({ x: 5, y: 5, width: 10, height: 10 }, 8, frame)).toEqual({
      x: 0,
      y: 0,
      width: 23,
      height: 23,
    });
  });

  it("pixelate on a grid from the box's corner, cut cells averaging what they have", () => {
    // Truncated, as ffmpeg's pixelize.
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
    // (0 + 10 + 20 + 31) / 4 = 15.25; (100 + 201) / 2 = 150.5.
    expect(out).toEqual([15, 15, 150, 15, 15, 150]);
  });

  it("blur as ffmpeg's boxblur does, to the pixel", () => {
    // An 8 × 8 pattern, grey; what `boxblur=luma_radius=2:luma_power=3` makes of it.
    const grey = Array.from({ length: 64 }, (_, i) => {
      const [x, y] = [i % 8, Math.floor(i / 8)];
      return (x * 37 + y * 91 + x * y * 13) % 256;
    });
    const px = new Uint8ClampedArray(grey.flatMap((v) => [v, v, v, 255]));
    boxBlur(px, 8, 8, 2);
    expect([...px].filter((_, i) => i % 4 === 0)).toEqual([
      114, 117, 121, 126, 129, 131, 131, 131, 115, 118, 122, 127, 130, 132, 132, 132, 119, 122, 126,
      130, 133, 134, 134, 134, 124, 127, 130, 134, 136, 138, 137, 138, 128, 130, 133, 137, 140, 142,
      142, 142, 131, 134, 137, 141, 144, 146, 147, 147, 134, 137, 140, 145, 148, 150, 151, 152, 135,
      138, 141, 146, 150, 152, 153, 154,
    ]);
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
