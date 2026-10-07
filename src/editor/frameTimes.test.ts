import { describe, expect, it } from "vitest";
import { frameAt, parseFrameTimes } from "./frameTimes";

describe("parseFrameTimes", () => {
  it("reads pairs of little-endian f64s", () => {
    const bytes = new ArrayBuffer(32);
    const view = new DataView(bytes);
    [0, 0.5, 1, 1.5].forEach((v, i) => view.setFloat64(i * 8, v, true));
    const t = parseFrameTimes(bytes);
    expect([...t.start]).toEqual([0, 1]);
    expect([...t.seek]).toEqual([0.5, 1.5]);
  });
});

describe("frameAt", () => {
  // 30 fps; picture 2 shows for two timeline frames (2 and 3), picture at 0.2 s is skipped.
  const start = Float64Array.from([0, 1 / 30, 2 / 30, 2 / 30, 4 / 30, 6 / 30]);

  it("finds the frame showing a picture, despite microsecond rounding", () => {
    expect(frameAt(start, 0)).toBe(0);
    expect(frameAt(start, 0.033333)).toBe(1);
    expect(frameAt(start, 0.033334)).toBe(1);
  });

  it("takes the first of the frames a picture shows for", () => {
    expect(frameAt(start, 2 / 30)).toBe(2);
  });

  it("takes the next frame for a picture the timeline skips, and stays in range", () => {
    expect(frameAt(start, 5 / 30)).toBe(5);
    expect(frameAt(start, 99)).toBe(5);
  });
});
