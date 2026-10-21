import { describe, expect, it } from "vitest";
import { trim } from "./drawMarks";

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
