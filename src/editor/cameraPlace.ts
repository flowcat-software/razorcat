// Where a recording's camera shows in the preview (PLAN 5d.4): its place on its recording's
// picture, through the picture's fit and the crop, on the finished frame; never cut off
// (2026-10-27): kept inside the frame, as large as it at most.

import type { CameraSize } from "../shared/ipc";
import type { CameraState } from "./cameraKeys";
import type { Size } from "./fit";
import { fitIn } from "./fit";

export interface CameraPlace {
  x: number;
  y: number;
  size: number;
}

/** Each size's circle across, a share of the picture's shorter side (settings.rs). */
export const CAMERA_SHARES: Readonly<Record<CameraSize, number>> = {
  small: 0.15,
  medium: 0.23,
  large: 0.33,
};

export const CAMERA_SIZES: readonly CameraSize[] = ["small", "medium", "large"];

/** The sizes, as the options bar and the clip's menu name them. */
export const CAMERA_SIZE_NAMES: Readonly<Record<CameraSize, string>> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

/**
 * `place` at `size` on picture `s` (none: as it is), the corner it's nearest kept where it is,
 * so one tucked into a corner stays there.
 */
export function sizedPlace(place: CameraPlace, size: CameraSize | undefined, s: Size): CameraPlace {
  if (!size) return place;
  const across = Math.round(Math.min(s.width, s.height) * CAMERA_SHARES[size]);
  const keep = (at: number, room: number) =>
    at + place.size / 2 < room / 2 ? at : at + place.size - across;
  return { x: keep(place.x, s.width), y: keep(place.y, s.height), size: across };
}

/** The camera's gap from the picture's edges where it snaps, a share of its shorter side. */
export const CAMERA_GAP = 0.04;

/**
 * `place` moved by (`dx`, `dy`) on picture `s` (its px), kept on it; within `pull` px of an
 * edge's gap (its corners' as recorded), snapped to it (PLAN 5d.6b), else where it's put. Whole
 * pixels.
 */
export function movedPlace(
  place: CameraPlace,
  dx: number,
  dy: number,
  s: Size,
  pull: number,
): CameraPlace {
  const gap = Math.round(Math.min(s.width, s.height) * CAMERA_GAP);
  const snap = (v: number, room: number) => {
    const far = room - gap - place.size;
    const kept = Math.min(Math.max(v, 0), Math.max(0, room - place.size));
    if (Math.abs(kept - gap) <= pull) return gap;
    if (Math.abs(kept - far) <= pull) return far;
    return Math.round(kept);
  };
  return { x: snap(place.x + dx, s.width), y: snap(place.y + dy, s.height), size: place.size };
}

/** The size nearest `place`'s on picture `s`: what a clip with none chosen shows as. */
export function sizeOfPlace(place: CameraPlace, s: Size): CameraSize {
  const share = place.size / Math.max(1, Math.min(s.width, s.height));
  return CAMERA_SIZES.reduce((best, k) =>
    Math.abs(CAMERA_SHARES[k] - share) < Math.abs(CAMERA_SHARES[best] - share) ? k : best,
  );
}

/** A square on the stage, in CSS px. */
export interface Square {
  left: number;
  top: number;
  size: number;
}

/**
 * A clip's camera as the preview shows it on a frame: on the stage, the camera in effect there
 * (`state`), and its place on its file's picture (`picture`, px) with the stage's CSS px to one
 * of the picture's (to move it by).
 */
export interface ShownCamera {
  square: Square;
  state: CameraState;
  place: CameraPlace;
  picture: Size;
  scale: number;
  /** How much of it shows (0 to 1): its fades at keyframes (PLAN 5d.9). */
  opacity: number;
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
