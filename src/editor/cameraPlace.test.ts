import { describe, expect, it } from "vitest";
import { cameraOnStage, sizedPlace, sizeOfPlace } from "./cameraPlace";

const hd = { width: 1920, height: 1080 };

// The same cases as camera.rs's `a_resized_camera_keeps_its_nearest_corner`.
describe("sizedPlace", () => {
  const bottomRight = { x: 1629, y: 789, size: 248 };

  it("keeps the corner it's nearest where it is", () => {
    expect(sizedPlace(bottomRight, "large", hd)).toEqual({ x: 1521, y: 681, size: 356 });
    expect(sizedPlace({ x: 43, y: 43, size: 248 }, "small", hd)).toEqual({
      x: 43,
      y: 43,
      size: 162,
    });
    expect(sizedPlace({ x: 1629, y: 43, size: 248 }, "small", hd)).toEqual({
      x: 1715,
      y: 43,
      size: 162,
    });
  });

  it("leaves it as recorded with no size chosen", () => {
    expect(sizedPlace(bottomRight, undefined, hd)).toBe(bottomRight);
  });
});

describe("sizeOfPlace", () => {
  it("is the size nearest the place's", () => {
    expect(sizeOfPlace({ x: 0, y: 0, size: 248 }, hd)).toBe("medium");
    expect(sizeOfPlace({ x: 0, y: 0, size: 150 }, hd)).toBe("small");
    expect(sizeOfPlace({ x: 0, y: 0, size: 400 }, hd)).toBe("large");
    // The old default, 28%: nearer Medium than Large.
    expect(sizeOfPlace({ x: 0, y: 0, size: 302 }, hd)).toBe("medium");
  });
});

describe("cameraOnStage", () => {
  it("is where it was on the picture, at the preview's scale", () => {
    // The picture at half size, filling the stage.
    const picture = { left: 0, top: 0, width: 960, height: 540 };
    const stage = { width: 960, height: 540 };
    expect(cameraOnStage({ x: 1500, y: 700, size: 300 }, hd, hd, picture, stage)).toEqual({
      left: 750,
      top: 350,
      size: 150,
    });
  });

  it("moves with a crop, and is never cut off by it", () => {
    // Cropped to its left half: the picture runs off the stage's right.
    const picture = { left: 0, top: 0, width: 960, height: 540 };
    const stage = { width: 480, height: 540 };
    expect(cameraOnStage({ x: 1500, y: 700, size: 300 }, hd, hd, picture, stage)).toEqual({
      left: 330,
      top: 350,
      size: 150,
    });
  });

  it("stays put on the picture as the frame grows round it", () => {
    // 100 px grown on the left, at half size.
    const picture = { left: 50, top: 0, width: 960, height: 540 };
    const stage = { width: 1010, height: 540 };
    expect(cameraOnStage({ x: 100, y: 100, size: 200 }, hd, hd, picture, stage)).toEqual({
      left: 100,
      top: 50,
      size: 100,
    });
  });

  it("follows another shape of file as it's fitted into the first's picture", () => {
    // A square file, fitted into a 16:9 picture: centred, as tall as it.
    const square = { width: 1000, height: 1000 };
    const picture = { left: 0, top: 0, width: 1920, height: 1080 };
    const at = cameraOnStage({ x: 0, y: 0, size: 100 }, square, hd, picture, hd);
    expect(at.left).toBeCloseTo(420);
    expect(at.top).toBe(0);
    expect(at.size).toBeCloseTo(108);
  });

  it("is no bigger than the frame", () => {
    const picture = { left: 0, top: 0, width: 200, height: 100 };
    const stage = { width: 200, height: 100 };
    expect(cameraOnStage({ x: 0, y: 0, size: 5000 }, hd, hd, picture, stage).size).toBe(100);
  });
});
