import { describe, expect, it } from "vitest";
import {
  HEADER,
  MAX_ZOOM,
  clampScroll,
  fOf,
  fitted,
  follow,
  reveal,
  scrollRange,
  scrolled,
  sliderToZoom,
  ticks,
  xOf,
  zoomAnchor,
  zoomAt,
  zoomToSlider,
} from "./timelineView";

describe("frames and pixels", () => {
  it("map both ways", () => {
    const v = { zoom: 2, scroll: 100 };
    expect(xOf(v, 100)).toBe(HEADER);
    expect(xOf(v, 110)).toBe(HEADER + 20);
    expect(fOf(v, HEADER + 20)).toBe(110);
  });

  it("fit the whole timeline, with room after it", () => {
    const v = fitted(1084, 1000);
    expect(v.scroll).toBe(0);
    expect(xOf(v, 1000)).toBe(1084 - 40);
  });
});

describe("zoom", () => {
  const width = 1084;
  const frames = 1000;

  it("keeps the frame under the pointer in place", () => {
    const v = fitted(width, frames);
    const anchor = 500;
    const f = fOf(v, anchor);
    const z = zoomAt(v, v.zoom * 4, anchor, width, frames);
    expect(fOf(z, anchor)).toBeCloseTo(f, 6);
    expect(z.zoom).toBeCloseTo(v.zoom * 4, 9);
  });

  it("below fit, keeps your place without the start coming past the left edge", () => {
    // Zoomed out past fit from the left edge: still at the left edge (no gap opens there).
    const out = zoomAt(fitted(width, frames), 0, 400, width, frames);
    expect(out.scroll).toBe(0);
    expect(scrolled(out, -200, width, frames).scroll).toBe(0);
    expect(scrolled(out, 200, width, frames).scroll).toBe(0);
    // Zooming in follows the pointer at once, below fit too (Richard: the frame under it
    // mustn't fly off while the timeline grows to fill the view).
    const before = fOf(out, 400);
    const z = zoomAt(out, out.zoom * 1.3, 400, width, frames);
    expect(z.scroll).toBeGreaterThan(0);
    expect(fOf(z, 400)).toBeCloseTo(before, 6);
    // Back out at the same place: back at the left edge.
    expect(zoomAt(z, out.zoom, 400, width, frames).scroll).toBeCloseTo(0, 9);
    // Out elsewhere: partly off the left, and scrolling brings it back to the edge, no further.
    const away = zoomAt(z, out.zoom, 100, width, frames);
    expect(away.scroll).toBeGreaterThan(0);
    expect(scrolled(away, -100000, width, frames).scroll).toBe(0);
    expect(scrolled(away, 200, width, frames).scroll).toBe(away.scroll);
  });

  it("holds the playhead exactly when the pointer is on it", () => {
    // Fitted, a pixel is about a frame. The pointer 3 px off the playhead still zooms about
    // the playhead, and after zooming in 40x it hasn't moved.
    let v = fitted(width, frames);
    const playhead = 700;
    const at = xOf(v, playhead);
    for (let i = 0; i < 6; i++) {
      v = zoomAt(v, v.zoom * 1.9, zoomAnchor(v, at + 3, playhead), width, frames);
    }
    expect(xOf(v, playhead)).toBeCloseTo(at, 6);
    // Away from it, the pointer is the anchor.
    expect(zoomAnchor(v, at + 40, playhead)).toBe(at + 40);
  });

  it("stops at the limits", () => {
    const v = fitted(width, frames);
    expect(zoomAt(v, 1000, 500, width, frames).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(v, 1e-9, 500, width, frames).zoom).toBeCloseTo(v.zoom / 2, 9);
  });

  it("round-trips through the slider", () => {
    const z = 3;
    expect(sliderToZoom(zoomToSlider(z, width, frames), width, frames)).toBeCloseTo(z, 9);
    expect(sliderToZoom(1, width, frames)).toBeCloseTo(MAX_ZOOM, 9);
  });
});

describe("scrolling", () => {
  it("can't leave the timeline behind", () => {
    const width = 1044;
    // 1000 px of tracks at 10 px a frame: 100 frames visible.
    expect(clampScroll({ zoom: 10, scroll: -50 }, width, 1000).scroll).toBe(-10);
    expect(clampScroll({ zoom: 10, scroll: 5000 }, width, 1000).scroll).toBe(910);
  });

  it("moves a view left past its limits back toward them, without a jump", () => {
    // 100 frames visible, limit 910; the view sits at 950 after zooming about the end.
    const v = { zoom: 10, scroll: 950 };
    expect(scrolled(v, -100, 1044, 1000).scroll).toBe(940);
    expect(scrolled(v, 100, 1044, 1000).scroll).toBe(950);
    expect(scrolled({ zoom: 10, scroll: 500 }, 100, 1044, 1000).scroll).toBe(510);
  });

  it("follows the playhead a page at a time", () => {
    const v = { zoom: 10, scroll: 0 };
    expect(follow(v, 50, 1044, 1000)).toBe(v);
    expect(follow(v, 150, 1044, 1000).scroll).toBe(140);
  });

  it("centres the playhead after a jump out of view, the ends at their edges", () => {
    // 100 frames visible.
    const v = { zoom: 10, scroll: 0 };
    expect(reveal(v, 50, 1044, 1000)).toBe(v);
    expect(reveal(v, 500, 1044, 1000).scroll).toBe(450);
    // Home and End: as far as the limits go.
    expect(reveal({ zoom: 10, scroll: 500 }, 0, 1044, 1000).scroll).toBe(-10);
    expect(reveal(v, 999, 1044, 1000).scroll).toBe(910);
  });

  it("gives the scrollbar its range, or none when fitted", () => {
    expect(scrollRange({ zoom: 10, scroll: 0 }, 1044, 1000)).toEqual({
      lo: -10,
      hi: 910,
      visible: 100,
    });
    expect(scrollRange(fitted(1044, 1000), 1044, 1000)).toBeNull();
  });
});

describe("ruler ticks", () => {
  it("labels at least 70 px apart, with minor ticks between", () => {
    // 30 fps at 1 px a frame: 2 s is 60 px, too close, so a label every 5 s (150 px).
    expect(ticks(1, 30)).toEqual({ major: 150, minor: 30 });
    // Zoomed in to 24 px a frame: a label every 3 frames, a minor tick every frame.
    expect(ticks(24, 30)).toEqual({ major: 3, minor: 1 });
  });

  it("uses frame steps that divide a second", () => {
    // 25 fps: 2, 3, 4, 6... don't divide 25, so 1, then 5, then a second.
    expect(ticks(20, 25).major).toBe(5);
    expect(ticks(10, 25).major).toBe(25);
  });

  it("goes up to hours on long timelines", () => {
    expect(ticks(0.0005, 30).major).toBe(7200 * 30);
  });
});
