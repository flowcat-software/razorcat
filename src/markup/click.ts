// A click mark's drawing (PLAN 5b.6b): the preview and the export draw it with this, so they
// match. Centred on (0, 0), `size` across (a double-click's second ring, and a ripple's spread,
// go outside that). The looks are the mockup's (internal/mockup/input-markup.html): a ring round
// a dot, a soft glow, crosshair ticks round a ring, and rings spreading out from a dot (5b.6e:
// the one that moves, drawn for its age, the time since the click).

import {
  DEFAULT_CLICK_SETTINGS,
  buttonColor,
  doublesShown,
  useClickSettings,
} from "./clickSettings";
import type { ClickAnnotation } from "./model/types";
import { hexToRgb } from "./color";

/** How long a click shows, and fades in and out over (s). */
export interface ClickTimes {
  seconds: number;
  fadeIn: number;
  fadeOut: number;
}

/**
 * How long a click placed by hand lasts: as Settings › Recording says, while placed clicks
 * follow it; else as a recorded one does by default.
 */
export function placedClickTimes(): ClickTimes {
  const s = useClickSettings.getState();
  return s.follow ? s : DEFAULT_CLICK_SETTINGS;
}

/** A click mark's length, fade-in and fade-out, in frames at `fps` (the fades fitted to it). */
export function clickTiming(
  fps: number,
  t: ClickTimes = placedClickTimes(),
): { length: number; fadeIn: number; fadeOut: number } {
  const length = Math.max(1, Math.round(t.seconds * fps));
  const fadeIn = Math.min(length, Math.round(t.fadeIn * fps));
  return { length, fadeIn, fadeOut: Math.min(length - fadeIn, Math.round(t.fadeOut * fps)) };
}

/** A double-click's second ring, as a multiple of the mark's size. */
export const DOUBLE_RING = 1.44;
/** A ripple's ring at its widest, as a multiple of the mark's size; how long one takes to
 *  spread (s), and when the second follows it. */
const RIPPLE_WIDEST = 1.3;
const RIPPLE_SECONDS = 1.2;
const RIPPLE_SECOND = 0.3;
/** The age a ripple drawn still is shown at (an icon, a selection's box): its rings mid-spread. */
const RIPPLE_STILL = 0.35;

/** How far the mark reaches from its centre (a double-click's second ring included). */
export function clickReach(a: Pick<ClickAnnotation, "size" | "double" | "look">): number {
  const ring = a.double && doublesShown() ? DOUBLE_RING : 1;
  return (a.size / 2) * Math.max(ring, a.look === "ripple" ? RIPPLE_WIDEST : 1);
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** A thin dark edge under the colour, so a light colour reads on a light screen. */
const EDGE = "rgba(0, 0, 0, 0.28)";

function ring(c: CanvasRenderingContext2D, radius: number, width: number, color: string) {
  c.beginPath();
  c.arc(0, 0, radius, 0, Math.PI * 2);
  c.lineWidth = width + 2;
  c.strokeStyle = EDGE;
  c.stroke();
  c.lineWidth = width;
  c.strokeStyle = color;
  c.stroke();
}

function dot(c: CanvasRenderingContext2D, radius: number, color: string) {
  c.beginPath();
  c.arc(0, 0, radius, 0, Math.PI * 2);
  c.fillStyle = color;
  c.fill();
  c.lineWidth = 1;
  c.strokeStyle = EDGE;
  c.stroke();
}

/**
 * Draws click mark `a`; a ripple as it is `age` seconds after the click (its rings spread out
 * from a fifth of its size to past it, fading as they go, the second a moment after the first,
 * each again every 1.2 s, as the mockup's CSS does).
 */
export function drawClick(c: CanvasRenderingContext2D, a: ClickAnnotation, age?: number): void {
  // Its button's colour, as Settings › Recording has it now (PLAN 5b.6d).
  const color = buttonColor(a.button);
  const r = a.size / 2;
  const line = Math.max(2, a.size * 0.07);
  c.save();
  if (a.look === "ripple") {
    const t = age ?? RIPPLE_STILL;
    const opacity = c.globalAlpha;
    for (const delay of [0, RIPPLE_SECOND]) {
      if (t < delay) continue;
      const p = ((t - delay) % RIPPLE_SECONDS) / RIPPLE_SECONDS;
      // CSS's ease-out.
      const eased = 1 - (1 - p) ** 2;
      const scale = 0.2 + (RIPPLE_WIDEST - 0.2) * eased;
      c.globalAlpha = opacity * (1 - p);
      ring(c, Math.max(0.5, r * scale - line / 2), line, color);
    }
    c.globalAlpha = opacity;
    dot(c, a.size * 0.1, color);
  } else if (a.look === "halo") {
    const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, rgba(color, 0.75));
    g.addColorStop(0.35, rgba(color, 0.75));
    g.addColorStop(0.55, rgba(color, 0.35));
    g.addColorStop(0.72, rgba(color, 0));
    g.addColorStop(1, rgba(color, 0));
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fillStyle = g;
    c.fill();
  } else if (a.look === "target") {
    const thin = Math.max(1.5, a.size * 0.045);
    ring(c, r * 0.64 - thin / 2, thin, color);
    // Ticks from the ring's edge out, each way.
    c.lineCap = "butt";
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      c.beginPath();
      c.moveTo(dx * r * 0.78, dy * r * 0.78);
      c.lineTo(dx * r, dy * r);
      c.lineWidth = thin + 2;
      c.strokeStyle = EDGE;
      c.stroke();
      c.lineWidth = thin;
      c.strokeStyle = color;
      c.stroke();
    }
  } else {
    ring(c, r - line / 2 - 1, line, color);
    dot(c, a.size * 0.12, color);
  }
  if (a.double && doublesShown()) {
    // Under the mark's own opacity (fading, while selected).
    c.globalAlpha *= 0.6;
    ring(c, r * DOUBLE_RING - line / 2, Math.max(1.5, line * 0.7), color);
  }
  c.restore();
}
