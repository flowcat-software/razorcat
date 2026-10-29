// The timeline's view: how frames map to pixels, zoom and scroll, and the ruler's ticks (the
// mockup's, made pure and tested). Positions are timeline frames; x is in CSS pixels from the
// timeline's left edge.

/** The column at the left for track headers. */
export const HEADER = 44;
/** Room kept after the end of the timeline when it's fitted. */
const FIT_MARGIN = 40;
/** The most pixels a frame can take: zoomed all the way in. */
export const MAX_ZOOM = 24;
/** The fewest pixels between ruler labels. */
const LABEL_GAP = 70;
/** The fewest pixels between minor ticks. */
const MINOR_GAP = 6;
/** Frame ticks show from this zoom. */
export const FRAME_TICKS = 6;

export interface View {
  /** Pixels per frame. */
  zoom: number;
  /** The frame at the left edge of the tracks (after the header). */
  scroll: number;
}

/** Pixel x of frame `f`. */
export const xOf = (v: View, f: number) => HEADER + (f - v.scroll) * v.zoom;

/** Frame (fractional) at pixel x. */
export const fOf = (v: View, x: number) => v.scroll + (x - HEADER) / v.zoom;

/** The zoom that fits `frames` into a timeline `width` wide. */
export function fitZoom(width: number, frames: number): number {
  return Math.max(1e-6, (width - HEADER - FIT_MARGIN) / Math.max(1, frames));
}

/** The whole timeline in view. */
export function fitted(width: number, frames: number): View {
  return { zoom: fitZoom(width, frames), scroll: 0 };
}

/** The least zoom allowed: half of fitted. */
const minZoom = (width: number, frames: number) => fitZoom(width, frames) * 0.5;

/**
 * Fitted or zoomed out past it, the timeline's start never comes into the view past the left
 * edge (2026-10-08). Zooming still follows the pointer, so the frame under it never
 * flies off: zoomed in and back out at the same place, the timeline retraces its path to the
 * left edge; elsewhere it may stay partly off the left, and scrolling brings it back to the
 * edge, no further.
 */
const atLeft = (zoom: number, width: number, frames: number) =>
  zoom <= fitZoom(width, frames) * (1 + 1e-9);

/**
 * How far the view may scroll at a zoom: either end may leave up to a tenth of the view empty.
 * At fit or below, none: the left edge (a view zoomed in to there from the pointer may only
 * scroll back toward it, `scrolled`).
 */
function scrollLimits(zoom: number, width: number, frames: number): [number, number] {
  if (atLeft(zoom, width, frames)) return [0, 0];
  const visible = (width - HEADER) / zoom;
  return [Math.min(-visible * 0.1, frames - visible), Math.max(frames - visible * 0.9, 0)];
}

/** Keeps the timeline in view (`scrollLimits`). */
export function clampScroll(v: View, width: number, frames: number): View {
  const [lo, hi] = scrollLimits(v.zoom, width, frames);
  const scroll = Math.max(lo, Math.min(hi, v.scroll));
  return { zoom: v.zoom, scroll: Number.isFinite(scroll) ? scroll : 0 };
}

/**
 * Zooms to `zoom` keeping the frame under `anchorX` where it is. On the timeline, it stays put
 * even if that leaves more of the view empty than scrolling would (the limits would pull it
 * away from the pointer); off it, the view is kept in its limits. At fit or below, its start
 * stays at or past the left edge (`atLeft`).
 */
export function zoomAt(
  v: View,
  zoom: number,
  anchorX: number,
  width: number,
  frames: number,
): View {
  const f = fOf(v, anchorX);
  const z = Math.max(minZoom(width, frames), Math.min(MAX_ZOOM, zoom));
  const next = { zoom: z, scroll: f - (anchorX - HEADER) / z };
  if (f < 0 || f > frames) return clampScroll(next, width, frames);
  return atLeft(z, width, frames) ? { zoom: z, scroll: Math.max(0, next.scroll) } : next;
}

/**
 * Scrolls by `dx` pixels, within the limits. A view already past them (zooming can leave it so)
 * may move back toward them, but no further out: it never jumps.
 */
export function scrolled(v: View, dx: number, width: number, frames: number): View {
  const [lo, hi] = scrollLimits(v.zoom, width, frames);
  const want = v.scroll + dx / v.zoom;
  const scroll = Math.max(Math.min(lo, v.scroll), Math.min(Math.max(hi, v.scroll), want));
  return { zoom: v.zoom, scroll };
}

/** How near the playhead (px) the pointer counts as on it, for zooming. */
const PLAYHEAD_PULL = 8;

/**
 * Where Ctrl+wheel zooms about: the pointer, or the playhead when the pointer is on it. Zoomed
 * out, a pixel can cover many frames, so the frame under the pointer can be a second away from
 * the playhead it's resting on; zooming about the playhead itself keeps it exactly in place.
 */
export function zoomAnchor(v: View, pointerX: number, playhead: number): number {
  const px = xOf(v, playhead);
  return Math.abs(pointerX - px) <= PLAYHEAD_PULL ? px : pointerX;
}

/** The zoom as 0 to 1 along the slider (logarithmic), and back. */
export function zoomToSlider(zoom: number, width: number, frames: number): number {
  const lo = Math.log(minZoom(width, frames));
  const hi = Math.log(MAX_ZOOM);
  return hi > lo ? (Math.log(zoom) - lo) / (hi - lo) : 0;
}

export function sliderToZoom(t: number, width: number, frames: number): number {
  const lo = Math.log(minZoom(width, frames));
  const hi = Math.log(MAX_ZOOM);
  return Math.exp(lo + Math.max(0, Math.min(1, t)) * (hi - lo));
}

/**
 * What the scrollbar shows: the furthest the view scrolls each way (`lo`, `hi`, frames at its
 * left edge) and how many frames it shows; null when there's nothing to scroll (fitted or wider).
 */
export function scrollRange(
  v: View,
  width: number,
  frames: number,
): { lo: number; hi: number; visible: number } | null {
  const [lo, hi] = scrollLimits(v.zoom, width, frames);
  return hi > lo ? { lo, hi, visible: (width - HEADER) / v.zoom } : null;
}

/** Scrolled to `scroll` (frames at the left edge), within the limits. */
export const scrolledTo = (v: View, scroll: number, width: number, frames: number) =>
  clampScroll({ zoom: v.zoom, scroll }, width, frames);

/**
 * Frame `f` brought into view after a jump (Home, End, the next cut): centred, within the
 * limits, so either end lands at its edge; a view already showing it stays put.
 */
export function reveal(v: View, f: number, width: number, frames: number): View {
  const x = xOf(v, f);
  if (x >= HEADER && x <= width - 20) return v;
  return scrolledTo(v, f - (width - HEADER) / v.zoom / 2, width, frames);
}

/** Scrolls so frame `f` is in view, a page at a time (as an NLE follows the playhead). */
export function follow(v: View, f: number, width: number, frames: number): View {
  const x = xOf(v, f);
  if (x >= HEADER && x <= width - 20) return v;
  return clampScroll(
    { zoom: v.zoom, scroll: f - ((width - HEADER) / v.zoom) * 0.1 },
    width,
    frames,
  );
}

/**
 * The ruler's ticks at this zoom: `major` (labelled) and `minor` frames apart (minor 0: none).
 * Steps are whole frames, then whole seconds of `perSecond` frames (the rate, rounded).
 */
export function ticks(zoom: number, perSecond: number): { major: number; minor: number } {
  const s = Math.max(1, Math.round(perSecond));
  // Frame steps that divide a second, so labels land on whole seconds; then seconds.
  const frameSteps = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30].filter((v) => v < s && s % v === 0);
  const secondSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const steps = [...frameSteps, ...secondSteps.map((m) => m * s)];
  const major = steps.find((st) => st * zoom >= LABEL_GAP) ?? steps[steps.length - 1];
  const minor =
    [...steps].reverse().find((st) => st < major && major % st === 0 && st * zoom >= MINOR_GAP) ??
    0;
  return { major, minor };
}
