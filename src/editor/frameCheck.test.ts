import { describe, expect, it } from "vitest";
import { readBarcode, seeded } from "./frameCheck";

/** A row of `width` RGBA pixels with the barcode of `n`, a little blurred at the cell edges. */
function row(n: number, width: number) {
  const px = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x++) {
    const k = Math.floor((x * 16) / width);
    const on = (n >> k) & 1;
    const edge = (x * 16) % width < 16 ? 60 : 0;
    const v = on ? 235 - edge : 16 + edge;
    px.set([v, v, v, 255], x * 4);
  }
  return px;
}

describe("readBarcode", () => {
  it("reads the frame number, least significant cell on the left", () => {
    for (const n of [0, 1, 1234, 35999, 65535]) {
      expect(readBarcode(row(n, 1920), 1920)).toBe(n);
      // An odd width, as a 540-line proxy of a portrait clip (304 wide).
      expect(readBarcode(row(n, 304), 304)).toBe(n);
    }
  });
});

describe("seeded", () => {
  it("is the same every run, within the clip", () => {
    const a = seeded(50, 1234);
    expect(seeded(50, 1234)).toEqual(a);
    expect(a.every((f) => f >= 0 && f < 1234)).toBe(true);
    expect(new Set(a).size).toBeGreaterThan(40);
  });
});
