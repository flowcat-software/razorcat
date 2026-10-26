// A click mark's drawing (PLAN 5b.6b): the preview and the export draw it with this, so they
// match. Centred on (0, 0), `size` across (a double-click's second ring goes outside that).
// The looks are the mockup's (internal/mockup/input-markup.html): a ring round a dot, a soft
// glow, crosshair ticks round a ring.

import type { ClickAnnotation } from "./model/types";
import { hexToRgb } from "./color";

/** How long a click shows, and fades out over (s): recorded or placed (5b.6d makes them settings). */
export const CLICK_SECONDS = 0.8;
export const CLICK_FADE_SECONDS = 0.3;

/** A click mark's length and fade-out, in frames at `fps`. */
export function clickTiming(fps: number): { length: number; fadeOut: number } {
  const length = Math.max(1, Math.round(CLICK_SECONDS * fps));
  return { length, fadeOut: Math.min(length, Math.round(CLICK_FADE_SECONDS * fps)) };
}

/** A double-click's second ring, as a multiple of the mark's size. */
export const DOUBLE_RING = 1.44;

/** How far the mark reaches from its centre (a double-click's second ring included). */
export function clickReach(a: Pick<ClickAnnotation, "size" | "double">): number {
  return (a.size / 2) * (a.double ? DOUBLE_RING : 1);
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

export function drawClick(c: CanvasRenderingContext2D, a: ClickAnnotation): void {
  const r = a.size / 2;
  const line = Math.max(2, a.size * 0.07);
  c.save();
  if (a.look === "halo") {
    const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, rgba(a.color, 0.75));
    g.addColorStop(0.35, rgba(a.color, 0.75));
    g.addColorStop(0.55, rgba(a.color, 0.35));
    g.addColorStop(0.72, rgba(a.color, 0));
    g.addColorStop(1, rgba(a.color, 0));
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fillStyle = g;
    c.fill();
  } else if (a.look === "target") {
    const thin = Math.max(1.5, a.size * 0.045);
    ring(c, r * 0.64 - thin / 2, thin, a.color);
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
      c.strokeStyle = a.color;
      c.stroke();
    }
  } else {
    ring(c, r - line / 2 - 1, line, a.color);
    dot(c, a.size * 0.12, a.color);
  }
  if (a.double) {
    // Under the mark's own opacity (fading, while selected).
    c.globalAlpha *= 0.6;
    ring(c, r * DOUBLE_RING - line / 2, Math.max(1.5, line * 0.7), a.color);
  }
  c.restore();
}
