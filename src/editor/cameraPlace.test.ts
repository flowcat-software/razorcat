import { describe, expect, it } from "vitest";
import { cameraOnStage } from "./cameraPlace";

const hd = { width: 1920, height: 1080 };

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
