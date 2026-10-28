import { beforeEach, describe, expect, it } from "vitest";
import {
  cameraAt,
  clipCamera,
  deleteKeys,
  keepCameraStarts,
  keyAt,
  placeOf,
  recordedCamera,
  resizedCamera,
  setCameraAt,
  startCamera,
  type CameraState,
} from "./cameraKeys";
import { useRecordedCameras } from "./cameraStore";
import { moveClip, split, trimClip, wholeSource, type Doc } from "./doc";
import { useDoc } from "./docStore";

const hd = { width: 1920, height: 1080 };
const small: CameraState = { x: 0.1, y: 0.1, size: "small", hidden: false };
const medium: CameraState = { x: 0.5, y: 0.5, size: "medium", hidden: false };
const large: CameraState = { x: 0.8, y: 0.7, size: "large", hidden: false };
const always = () => true;

/** Richard's example (2026-10-28): clips A, B and C, 100 frames each, of one recording. */
function abc(): Doc {
  let doc = split(split(wholeSource(300), 100), 200);
  doc = setCameraAt(doc, 0, small); // A's first frame
  doc = setCameraAt(doc, 150, medium); // B's middle
  doc = setCameraAt(doc, 250, large); // C's middle
  return doc;
}

describe("the camera at a frame", () => {
  it("is as the last keyframe before it says, an earlier clip's too", () => {
    const doc = abc();
    expect(cameraAt(doc, 0)).toEqual(small);
    expect(cameraAt(doc, 149)).toEqual(small);
    expect(cameraAt(doc, 150)).toEqual(medium);
    expect(cameraAt(doc, 249)).toEqual(medium);
    expect(cameraAt(doc, 299)).toEqual(large);
    expect(cameraAt(wholeSource(10), 5)).toBeNull();
  });

  it("leaves out a keyframe trimmed out of view, and has it back when it's pulled back", () => {
    const doc = abc();
    // B (clip 2) trimmed to end before its keyframe at its frame 150.
    const trimmed = trimClip(doc, 2, 100, 140);
    expect(cameraAt(trimmed, 150)).toEqual(small);
    expect(keyAt(trimmed, 140)).toBeNull();
    expect(cameraAt(trimmed, 139)).toEqual(small);
    expect(cameraAt(trimClip(trimmed, 2, 100, 200), 150)).toEqual(medium);
  });
});

describe("setting the camera at a frame", () => {
  it("adds a keyframe there, then changes it in place", () => {
    const one = setCameraAt(wholeSource(100), 40, small);
    expect(one.cameraKeys).toEqual([{ id: 1, clip: 1, at: 40, ...small }]);
    const two = setCameraAt(one, 40, large);
    expect(two.cameraKeys).toEqual([{ id: 1, clip: 1, at: 40, ...large }]);
    expect(setCameraAt(two, 40, large)).toBe(two);
    expect(setCameraAt(two, 500, small)).toBe(two);
  });

  it("deletes keyframes", () => {
    const doc = abc();
    const id = keyAt(doc, 150)!.id;
    const fewer = deleteKeys(doc, [id]);
    expect(cameraAt(fewer, 150)).toEqual(small);
    expect(deleteKeys(fewer, [id])).toBe(fewer);
  });

  it("starts a recording's clip as it was recorded, once", () => {
    const doc = startCamera(wholeSource(100), 1, medium);
    expect(cameraAt(doc, 0)).toEqual(medium);
    expect(startCamera(doc, 1, small)).toBe(doc);
  });
});

describe("keeping each clip's start through an edit to the clips", () => {
  it("adds nothing for a split: nothing changed", () => {
    const doc = setCameraAt(wholeSource(300), 0, small);
    const cut = split(doc, 120);
    expect(keepCameraStarts(doc, cut, always)).toBe(cut);
  });

  it("keeps each moved clip's start, with a keyframe in view (Richard's example)", () => {
    const doc = abc();
    // A, C, B: C would start small (A's), B large (C's).
    const moved = keepCameraStarts(doc, moveClip(doc, 3, 1), always);
    // C (now 100 to 199) starts medium as it did, B (200 to 299) small.
    expect(cameraAt(moved, 100)).toEqual(medium);
    expect(cameraAt(moved, 150)).toEqual(large);
    expect(cameraAt(moved, 200)).toEqual(small);
    expect(cameraAt(moved, 250)).toEqual(medium);
    expect(keyAt(moved, 100)).toMatchObject({ clip: 3, at: 200, ...medium });
    expect(keyAt(moved, 200)).toMatchObject({ clip: 2, at: 100, ...small });
  });

  it("leaves clips without a camera alone", () => {
    const doc = abc();
    const after = moveClip(doc, 3, 1);
    expect(keepCameraStarts(doc, after, () => false)).toBe(after);
  });
});

describe("a clip's camera, stretch by stretch", () => {
  it("changes at each keyframe in it, from the one in effect at its start", () => {
    const doc = abc();
    expect(clipCamera(doc, 1, null)).toEqual([
      { from: 0, length: 50, state: small },
      { from: 50, length: 50, state: medium },
    ]);
    expect(clipCamera(wholeSource(100), 0, large)).toEqual([
      { from: 0, length: 100, state: large },
    ]);
    expect(clipCamera(wholeSource(100), 0, null)).toEqual([]);
  });
});

describe("the camera's place", () => {
  it("is a share of the picture, so it means the same on any", () => {
    expect(placeOf(large, hd)).toEqual({ x: 1536, y: 756, size: 356 });
    expect(placeOf(large, { width: 960, height: 540 })).toEqual({ x: 768, y: 378, size: 178 });
  });

  it("is made from a recorded place, at the size nearest", () => {
    expect(recordedCamera({ x: 1629, y: 789, size: 248 }, hd)).toMatchObject({
      size: "medium",
      hidden: false,
    });
    expect(placeOf(recordedCamera({ x: 1629, y: 789, size: 248 }, hd), hd)).toEqual({
      x: 1629,
      y: 789,
      size: 248,
    });
  });

  it("resizes keeping its nearest corner", () => {
    const corner = recordedCamera({ x: 1629, y: 789, size: 248 }, hd);
    expect(placeOf(resizedCamera(corner, "large", hd), hd)).toEqual({
      x: 1521,
      y: 681,
      size: 356,
    });
  });
});

describe("the store, through edits", () => {
  const s = () => useDoc.getState();
  beforeEach(() => {
    useRecordedCameras.setState({
      cameras: { source: { state: medium, picture: hd } },
    });
    s().load(300);
  });

  it("keeps a moved clip's start, and doesn't put back a keyframe deleted", () => {
    s().split(100);
    s().setCamera(0, small);
    s().setCamera(150, large);
    // Moved first, it'd have nothing before it: it's kept small, as it started.
    s().move(2, 0);
    expect(cameraAt(s().doc, 0)).toEqual(small);
    expect(cameraAt(s().doc, 50)).toEqual(large);
    expect(cameraAt(s().doc, 200)).toEqual(small);
    // The keyframe kept deleted: the one before carries on.
    s().deleteKeys([keyAt(s().doc, 200)!.id]);
    expect(cameraAt(s().doc, 200)).toEqual(large);
  });
});
