import { describe, expect, it } from "vitest";
import { split, wholeSource } from "./doc";
import { snap, trimTargets } from "./snap";

describe("snap", () => {
  // At 2 px a frame, targets pull from 4 frames away.
  it("lands on the nearest target within reach", () => {
    expect(snap(103.2, [100, 105], 2, true)).toEqual({ frame: 105, target: 105 });
    expect(snap(101.9, [100, 105], 2, true)).toEqual({ frame: 100, target: 100 });
  });

  it("lets go beyond reach, and when it's off", () => {
    expect(snap(110.4, [100, 105], 2, true)).toEqual({ frame: 110, target: null });
    expect(snap(103.2, [100, 105], 2, false)).toEqual({ frame: 103, target: null });
    expect(snap(103.7, [], 2, true, Math.floor)).toEqual({ frame: 103, target: null });
  });

  it("reaches further zoomed out", () => {
    expect(snap(130, [100], 0.25, true).frame).toBe(100);
    expect(snap(130, [100], 1, true).frame).toBe(130);
  });
});

describe("trim targets", () => {
  // Clips 0-40, 40-70, 70-100.
  const three = split(split(wholeSource(100), 40), 70);

  it("an in edge: the playhead and where it started", () => {
    expect(trimTargets(three, 1, "in", 55)).toEqual([55, 40]);
  });

  it("an out edge: also the edit points before it, never those after", () => {
    expect(trimTargets(three, 1, "out", 55)).toEqual([55, 70, 0, 40]);
  });
});
