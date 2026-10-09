import { describe, expect, it } from "vitest";
import { setCrop, setGrow, split, wholeSource } from "./doc";
import {
  colourGrow,
  cropToRatio,
  fullFrame,
  growColour,
  growMode,
  growSide,
  isCropped,
  keepCrop,
  MAX_GROW,
  outputSize,
  setCropField,
  SIDES,
} from "./frame";
import { dragGain } from "./numberDrag";

const source = { width: 1920, height: 1080 };

describe("the frame", () => {
  it("starts as the whole picture, nothing added", () => {
    const f = fullFrame(source);
    expect(f.crop).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(isCropped(f)).toBe(false);
    expect(outputSize(f)).toEqual(source);
  });

  it("adds the grow to the crop for the output's size", () => {
    const f = { ...fullFrame(source), crop: { x: 10, y: 0, width: 1000, height: 800 } };
    expect(isCropped(f)).toBe(true);
    expect(outputSize({ ...f, grow: { ...f.grow, top: 100, left: 20 } })).toEqual({
      width: 1020,
      height: 900,
    });
  });

  it("keeps a crop to the source, in whole pixels", () => {
    expect(keepCrop({ x: -5, y: 1000.4, width: 2000, height: 200.6 }, source)).toEqual({
      x: 0,
      y: 879,
      width: 1920,
      height: 201,
    });
    expect(keepCrop({ x: 0, y: 0, width: 0, height: -3 }, source)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("sets X and Y within the source, W and H from the top-left", () => {
    const crop = { x: 100, y: 100, width: 800, height: 600 };
    expect(setCropField(crop, "x", 5000, source)).toEqual({ ...crop, x: 1120 });
    expect(setCropField(crop, "width", 1000, source)).toEqual({ ...crop, width: 1000 });
    // Too wide for where it is: it moves left to fit.
    expect(setCropField(crop, "width", 1900, source)).toEqual({ ...crop, x: 20, width: 1900 });
    // A held ratio: the other side follows.
    expect(setCropField(crop, "height", 450, source, 16 / 9)).toEqual({
      ...crop,
      width: 800,
      height: 450,
    });
  });

  it("refits to a ratio where the box was", () => {
    const square = cropToRatio({ x: 0, y: 0, width: 1920, height: 1080 }, source, 1);
    expect(square).toEqual({ x: 420, y: 0, width: 1080, height: 1080 });
    // Near an edge: as far over as fits.
    const tall = cropToRatio({ x: 1800, y: 0, width: 100, height: 100 }, source, 9 / 16);
    expect(tall).toEqual({ x: 1312, y: 0, width: 608, height: 1080 });
  });
});

describe("the grow", () => {
  const none = fullFrame(source).grow;

  it("keeps each side to whole pixels, 0 to the most", () => {
    expect(growSide(none, "top", 150.6).top).toBe(151);
    expect(growSide(none, "top", -20).top).toBe(0);
    expect(growSide(none, "left", 1e9).left).toBe(MAX_GROW);
  });

  it("colours each side until grown sides meet, then one colour", () => {
    let g = growSide(growSide(none, "top", 100), "bottom", 100);
    expect(growMode(g)).toBe("each");
    g = colourGrow(g, "bottom", "#ffffff");
    expect(growColour(g, "top")).toBe("#000000");
    expect(growColour(g, "bottom")).toBe("#ffffff");
    // A side grown meets the top and bottom: one colour.
    const meet = growSide(g, "left", 10);
    expect(growMode(meet)).toBe("one");
    expect(growColour(meet, "bottom")).toBe("#000000");
    // A colour picked then is for all of it.
    const red = colourGrow(meet, "left", "#ff0000");
    expect(SIDES.map((s) => growColour(red, s))).toEqual(Array(4).fill("#ff0000"));
    expect(red.colours).toEqual({});
  });

  it("is part of the document, and the same grow changes nothing", () => {
    const doc = wholeSource(100, source);
    const grown = setGrow(doc, growSide(doc.frame.grow, "top", 200));
    expect(outputSize(grown.frame)).toEqual({ width: 1920, height: 1280 });
    expect(setGrow(grown, { ...grown.frame.grow, colours: {} })).toBe(grown);
  });
});

describe("the document's crop", () => {
  it("is part of the document, kept to the source, and survives edits of the clips", () => {
    const doc = wholeSource(100, source);
    const cropped = setCrop(doc, { x: 10, y: 20, width: 3000, height: 500 });
    expect(cropped.frame.crop).toEqual({ x: 0, y: 20, width: 1920, height: 500 });
    expect(setCrop(cropped, cropped.frame.crop)).toBe(cropped);
    expect(split(cropped, 50).frame).toBe(cropped.frame);
  });
});

describe("dragging a number", () => {
  it("moves slowly when the mouse does, up to a cap", () => {
    expect(dragGain(0)).toBe(0.25);
    expect(dragGain(0.8)).toBeCloseTo(1.25);
    expect(dragGain(10)).toBe(5);
  });

  it("scales with the setting", () => {
    expect(dragGain(0.4, "verySlow")).toBeLessThan(dragGain(0.4));
    expect(dragGain(0.4, "veryFast")).toBeGreaterThan(dragGain(0.4));
  });
});
