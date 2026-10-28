// Each recording's camera as it was recorded (PLAN 5d.8), by its file's id, once it's known
// (being fitted, or fitted): where it shows with no keyframe before it, and which files have a
// camera at all. The editor keeps it (EditorApp.tsx); the preview, the timeline, the export and
// the document's store read it.

import { create } from "zustand";
import type { CameraSize } from "../shared/ipc";
import { cameraAt, resizedCamera, type CameraState } from "./cameraKeys";
import { clipAt, type Clip, type Doc } from "./doc";
import type { Size } from "./fit";

export interface RecordedCamera {
  state: CameraState;
  /** Its file's picture. */
  picture: Size;
}

export const useRecordedCameras = create<{ cameras: Readonly<Record<string, RecordedCamera>> }>(
  () => ({ cameras: {} }),
);

/** Whether file `source` has a camera. */
export const hasCamera = (source: string) => source in useRecordedCameras.getState().cameras;

/**
 * The camera at timeline frame `f`, where it can be changed there: on clip `clip`, whose
 * recording has one. As the keyframes say, or before any, as it was recorded; and its file's
 * picture.
 */
export function cameraHere(
  doc: Doc,
  f: number,
  clip: Clip,
): { state: CameraState; picture: Size } | null {
  const rec = useRecordedCameras.getState().cameras[clip.source];
  if (!rec || clipAt(doc, f)?.clip.id !== clip.id) return null;
  return { state: cameraAt(doc, f) ?? rec.state, picture: rec.picture };
}

/** The camera at `f` (on `clip`) at `size`, its nearest corner kept: a keyframe there (5d.8). */
export function sizeCameraAt(
  doc: Doc,
  f: number,
  clip: Clip,
  size: CameraSize,
): CameraState | null {
  const here = cameraHere(doc, f, clip);
  return here && resizedCamera(here.state, size, here.picture);
}
