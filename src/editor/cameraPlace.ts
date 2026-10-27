// Where a recording's camera shows in the preview (PLAN 5d.4): its place on its recording's
// picture, through the picture's fit and the crop, on the finished frame; never cut off (Richard,
// 2026-10-27): kept inside the frame, as large as it at most.

import type { Size } from "./fit";
import { fitIn } from "./fit";

export interface CameraPlace {
  x: number;
  y: number;
  size: number;
}

/** A square on the stage, in CSS px. */
export interface Square {
  left: number;
  top: number;
  size: number;
}

/**
 * The camera of file `s` (its `place` on `s`'s picture, px) on a stage `stage` (CSS px, the
 * finished frame) whose picture of the first file `first` shows at `picture` (CSS px, from the
 * stage's top-left: cropped and grown, it may run past it).
 */
export function cameraOnStage(
  place: CameraPlace,
  s: Size,
  first: Size,
  picture: { left: number; top: number; width: number; height: number },
  stage: Size,
): Square {
  const box = fitIn(s, first, picture);
  const k = s.width > 0 ? box.width / s.width : 0;
  const size = Math.max(0, Math.min(place.size * k, stage.width, stage.height));
  const left = picture.left + box.left + place.x * k;
  const top = picture.top + box.top + place.y * k;
  return {
    left: Math.min(Math.max(left, 0), stage.width - size),
    top: Math.min(Math.max(top, 0), stage.height - size),
    size,
  };
}
