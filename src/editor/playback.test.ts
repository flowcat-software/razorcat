// The preview's sound (PLAN 5a): the slider on a curve, muting silent, the volume kept to 0–1.
import { describe, expect, it } from "vitest";
import { playbackGain, usePlayback } from "./playback";

describe("playback volume", () => {
  it("plays on a curve, and not at all muted", () => {
    expect(playbackGain(1, false)).toBe(1);
    expect(playbackGain(0.5, false)).toBe(0.25);
    expect(playbackGain(0, false)).toBe(0);
    expect(playbackGain(1, true)).toBe(0);
  });

  it("keeps the slider from nothing to full", () => {
    usePlayback.getState().setVolume(1.4);
    expect(usePlayback.getState().volume).toBe(1);
    usePlayback.getState().setVolume(-1);
    expect(usePlayback.getState().volume).toBe(0);
  });
});
