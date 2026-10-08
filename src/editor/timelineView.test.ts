import { describe, expect, it } from "vitest";
import {
  HEADER,
  MAX_ZOOM,
  clampScroll,
  fOf,
  fitted,
  follow,
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

  it("keeps the frame under the pointer in place below fit, too", () => {
    // Zoomed out past fit, the pointer over the last quarter of the timeline.
    const out = zoomAt(fitted(width, frames), 0, 900, width, frames);
    const f = fOf(out, 900);
    const z = zoomAt(out, out.zoom * 1.3, 900, width, frames);
    expect(fOf(z, 900)).toBeCloseTo(f, 6);
  });

  it("holds the playhead exactly when the pointer is on it", () => {
    // Fitted, a pixel is about a frame; zoomed out it's two. The pointer 3 px off the playhead
    // still zooms about the playhead, and after zooming in 40x it hasn't moved.
    let v = zoomAt(fitted(width, frames), 0, 500, width, frames);
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
