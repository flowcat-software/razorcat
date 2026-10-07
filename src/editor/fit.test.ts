import { describe, expect, it } from "vitest";
import { fitRect, videoTransform } from "./fit";

describe("fitRect", () => {
  it("fits a landscape picture to the width, centred", () => {
    expect(fitRect({ width: 1032, height: 600 }, { width: 1920, height: 1080 }, 16)).toEqual({
      x: 16,
      y: 19,
      width: 1000,
      height: 563,
    });
  });

  it("fits a portrait picture to the height", () => {
    expect(fitRect({ width: 1000, height: 432 }, { width: 1080, height: 1920 }, 16)).toEqual({
      x: 388,
      y: 16,
      width: 225,
      height: 400,
    });
  });

  it("is empty when there's no room or no picture", () => {
    expect(fitRect({ width: 20, height: 600 }, { width: 1920, height: 1080 }, 16).width).toBe(0);
    expect(fitRect({ width: 800, height: 600 }, { width: 0, height: 0 }, 16).width).toBe(0);
  });
});

describe("videoTransform", () => {
  const stage = { width: 225, height: 400 };
  const iphone = { width: 1080, height: 1920, rotation: 90 };

  it("fills the stage when WebView2 honoured the rotation", () => {
    expect(videoTransform({ width: 1080, height: 1920 }, iphone, stage)).toEqual({
      width: 225,
      height: 400,
      css: "none",
    });
  });

  it("turns a sideways video into place when it didn't", () => {
    // Laid out 400 wide, 225 high in a 225 x 400 stage, centred, then turned a quarter.
    expect(videoTransform({ width: 1920, height: 1080 }, iphone, stage)).toEqual({
      width: 400,
      height: 225,
      css: "translate(-87.5px, 87.5px) rotate(90deg)",
    });
  });

  it("leaves unrotated and upside-down videos alone in size", () => {
    const flat = { width: 1920, height: 1080, rotation: 0 };
    expect(videoTransform({ width: 1920, height: 1080 }, flat, stage).css).toBe("none");
  });
});
