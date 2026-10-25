// Reversed clips played from their renders (PLAN §7, Clip speed SP8): the render, played forward,
// shows the frames the document says.
import { describe, expect, it } from "vitest";
import { trimClip, wholeSource } from "./doc";
import { deckOf, playedClip, readyFor, type Render } from "./reverse";
import {
  setClipSpeed,
  sourceFrame,
  speed,
  speedOf,
  streamEnd,
  videoEnd,
  videoStart,
  type Speed,
} from "./speed";

const render = (from: number, to: number): Render => ({
  id: "0123456789abcdef",
  source: "source",
  from,
  to,
  ready: true,
  url: "",
  framesUrl: "",
  done: 1,
});

const SPEEDS: Speed[] = [
  speed(1, 10),
  speed(3333, 10000),
  speed(1, 2),
  speed(1, 1),
  speed(3, 2),
  speed(7, 3),
  speed(10, 1),
];

describe("a reversed clip's render", () => {
  it("shows each frame the clip does, played forward", () => {
    const doc = trimClip(wholeSource(5000), 1, 1234, 2345);
    const r = render(1100, 2500);
    for (const s of SPEEDS) {
      const c = setClipSpeed(doc, 1, s, false, true).clips[0];
      const renders = { [r.id]: r };
      expect(readyFor(c, renders)).toBe(r);
      const p = playedClip(c, renders);
      expect(p.source).toBe(deckOf(r.id));
      expect(p.mirror).toBeUndefined();
      expect(p.out - p.in).toBe(c.out - c.in);
      // Its phase stays below the speed's numerator, as a speed change leaves it.
      expect(p.phase ?? 0).toBeGreaterThanOrEqual(0);
      expect(p.phase ?? 0).toBeLessThan(speedOf(p).num);
      for (let d = 0; d < c.out - c.in; d++) {
        // Render frame k is source frame to − 1 − k.
        expect(r.to - 1 - sourceFrame(p, p.in + d)).toBe(sourceFrame(c, c.in + d));
      }
      // The stretch the export reads, within the render, mirroring the clip's video.
      expect(r.to - videoEnd(p)).toBe(videoStart(c));
      expect(streamEnd(p)).toBeLessThanOrEqual(r.to - r.from);
    }
  });

  it("isn't used for a clip it doesn't cover, nor one going forward", () => {
    const doc = trimClip(wholeSource(5000), 1, 1234, 2345);
    const c = setClipSpeed(doc, 1, speed(1, 1), false, true).clips[0];
    const short = render(1300, 2500);
    expect(readyFor(c, { [short.id]: short })).toBeNull();
    expect(playedClip(c, { [short.id]: short })).toBe(c);
    const wide = render(1000, 3000);
    expect(readyFor(doc.clips[0], { [wide.id]: wide })).toBeNull();
    expect(readyFor(c, { [wide.id]: { ...wide, ready: false } })).toBeNull();
  });
});
