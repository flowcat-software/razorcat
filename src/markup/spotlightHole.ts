// A spotlight's bright area, as the preview cuts it out of the dark layer and the export draws
// it (Razorcat, PLAN 4.5g): the same path either way.

import type { SpotlightAnnotation } from "./model/types";
import { drawnCornerRadius } from "./styles";

/** Fills spotlight `spot`'s bright area on `c`, in its fill style: its ellipse or rounded box. */
export function fillSpotlight(
  c: CanvasRenderingContext2D,
  spot: Pick<SpotlightAnnotation, "rect" | "shape" | "cornerRadius">,
): void {
  const { rect: r, shape } = spot;
  c.beginPath();
  if (shape === "ellipse") {
    c.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, 2 * Math.PI);
  } else {
    c.roundRect(
      r.x,
      r.y,
      r.width,
      r.height,
      drawnCornerRadius(spot.cornerRadius, r.width, r.height),
    );
  }
  c.fill();
}
