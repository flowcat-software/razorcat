import { describe, expect, it } from "vitest";
import { trim, trimAll } from "./drawMarks";

/** A `width` × `height` image, transparent but for the opaque pixels at `on` ([x, y]). */
function image(width: number, height: number, on: [number, number][]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [x, y] of on) data.set([x, y, 7, 255], (y * width + x) * 4);
  return { width, height, data };
}

describe("trim", () => {
  it("cuts the transparent edges off, keeping the pixels inside", () => {
    const cut = trim(
      image(6, 5, [
        [2, 1],
        [4, 3],
      ]),
    )!;
    expect([cut.x, cut.y, cut.width, cut.height]).toEqual([2, 1, 3, 3]);
    expect([...cut.pixels.subarray(0, 4)]).toEqual([2, 1, 7, 255]);
    expect([...cut.pixels.subarray(8 * 4, 9 * 4)]).toEqual([4, 3, 7, 255]);
    expect([...cut.pixels.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
  });

  it("keeps a full image whole, and finds nothing in an empty one", () => {
    const full = trim(image(1, 1, [[0, 0]]))!;
    expect([full.x, full.y, full.width, full.height]).toEqual([0, 0, 1, 1]);
    expect(trim(image(3, 3, []))).toBeNull();
  });
});

describe("trimAll", () => {
  it("cuts the edges all of them leave, and puts them one after another", () => {
    // A ripple growing: frame 0 a dot, frame 1 wider, frame 2 nothing.
    const cut = trimAll([
      image(6, 5, [[2, 2]]),
      image(6, 5, [
        [1, 1],
        [3, 3],
      ]),
      image(6, 5, []),
    ])!;
    expect([cut.x, cut.y, cut.width, cut.height]).toEqual([1, 1, 3, 3]);
    expect(cut.pixels.length).toBe(3 * 3 * 4 * 3);
    const at = (k: number, x: number, y: number) => {
      const i = (k * 9 + y * 3 + x) * 4;
      return [...cut.pixels.subarray(i, i + 4)];
    };
    expect(at(0, 1, 1)).toEqual([2, 2, 7, 255]);
    expect(at(0, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(at(1, 0, 0)).toEqual([1, 1, 7, 255]);
    expect(at(1, 2, 2)).toEqual([3, 3, 7, 255]);
    expect(cut.pixels.subarray(18 * 4).every((v) => v === 0)).toBe(true);
    expect(trimAll([image(2, 2, []), image(2, 2, [])])).toBeNull();
  });
});
