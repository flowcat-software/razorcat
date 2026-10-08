import { describe, expect, it } from "vitest";
import { BINS, Peaks, waveHeight } from "./wave";

describe("peaks", () => {
  // 1000 frames of quiet, with a few louder bins.
  const raw = new Uint8Array(1000 * BINS).fill(3);
  raw[10 * BINS + 2] = 200; // frame 10
  raw[500 * BINS + 7] = 90; // frame 500
  raw[999 * BINS] = 40; // the last frame
  const peaks = new Peaks(raw);

  const brute = (f0: number, f1: number) => {
    let m = 0;
    for (
      let i = Math.max(0, Math.floor(f0 * BINS));
      i < Math.min(raw.length, Math.ceil(f1 * BINS));
      i++
    )
      m = Math.max(m, raw[i]);
    return m;
  };

  it("finds the loudest in a span, at any zoom", () => {
    for (const [f0, f1] of [
      [0, 1000],
      [10, 11],
      [10.2, 10.4],
      [11, 499],
      [400, 600],
      [500.9, 501],
      [999, 1000],
      [3.3, 997.6],
      [12.125, 500.875],
    ]) {
      expect(peaks.max(f0, f1)).toBe(brute(f0, f1));
    }
    expect(peaks.max(10, 11)).toBe(200);
    expect(peaks.max(11, 499)).toBe(3);
    expect(peaks.max(0, 1000)).toBe(200);
  });

  it("is silent outside the audio, or for an empty span", () => {
    expect(peaks.max(2000, 3000)).toBe(0);
    expect(peaks.max(5, 5)).toBe(0);
  });
});

describe("waveHeight", () => {
  it("is on a dB scale down to -48", () => {
    expect(waveHeight(0)).toBe(0);
    expect(waveHeight(255)).toBe(1);
    // Half scale is -6 dB: seven eighths of the way up.
    expect(waveHeight(127.5)).toBeCloseTo(1 - 6.02 / 48, 3);
    expect(waveHeight(1)).toBe(0);
  });
});
