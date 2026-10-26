import { describe, expect, it } from "vitest";
import type { RecordedInput } from "../shared/ipc";
import { addSource, wholeSource, type Doc } from "./doc";
import { NO_GROW } from "./frame";
import {
  CLICK_COLOURS,
  onFrame,
  RECORDED_KEYS,
  recordedKeysSize,
  withRecordedClicks,
  withRecordedKeys,
} from "./recordedInput";

const look = { look: "ring" as const, size: 44 };
const click = (time: number, x: number, y: number, button: "left" | "right" = "left") => ({
  time,
  x,
  y,
  button,
  double: false,
});

describe("onFrame", () => {
  it("is the picture's point on the first file, moved by the crop and the grown space", () => {
    const doc = wholeSource(100, { width: 1920, height: 1080 });
    expect(onFrame(doc, { width: 1920, height: 1080 }, { x: 100, y: 50 })).toEqual({
      x: 100,
      y: 50,
    });
    const framed: Doc = {
      ...doc,
      frame: {
        ...doc.frame,
        crop: { x: 20, y: 10, width: 1800, height: 1000 },
        grow: { ...NO_GROW, left: 40, top: 30 },
      },
    };
    expect(onFrame(framed, { width: 1920, height: 1080 }, { x: 100, y: 50 })).toEqual({
      x: 120,
      y: 70,
    });
  });

  it("fits another file's picture into the first's, centred", () => {
    const doc = wholeSource(100, { width: 1920, height: 1080 });
    // 960 × 1080: fitted at its size, centred across.
    expect(onFrame(doc, { width: 960, height: 1080 }, { x: 0, y: 0 })).toEqual({ x: 480, y: 0 });
    // 3840 × 2160: halved.
    expect(onFrame(doc, { width: 3840, height: 2160 }, { x: 200, y: 100 })).toEqual({
      x: 100,
      y: 50,
    });
  });
});

describe("withRecordedClicks", () => {
  const input: RecordedInput = {
    clicks: [click(1, 100, 50), click(2.5, 300, 200, "right")],
    keys: [],
  };

  it("marks each click where and when it was, a moment long, fading out", () => {
    const doc = withRecordedClicks(
      wholeSource(300, { width: 1920, height: 1080 }),
      1,
      input,
      30,
      { width: 1920, height: 1080 },
      look,
    );
    expect(doc.marks).toHaveLength(2);
    const [a, b] = doc.marks;
    expect(a).toMatchObject({ clip: 1, at: 30, length: 24, fadeOut: 9 });
    expect(a.object).toMatchObject({ kind: "click", x: 100, y: 50, color: CLICK_COLOURS.left });
    expect(b).toMatchObject({ at: 75 });
    expect(b.object).toMatchObject({ color: CLICK_COLOURS.right, look: "ring", size: 44 });
  });

  it("puts an added recording's clicks on its own clip, and leaves out any off its frames", () => {
    const doc = addSource(wholeSource(300, { width: 1920, height: 1080 }), "rec", 60);
    const after = withRecordedClicks(
      doc,
      2,
      { clicks: [click(1, 10, 10), click(5, 10, 10)], keys: [] },
      30,
      { width: 1920, height: 1080 },
      look,
    );
    // The second clip starts at 300; the click at 5 s is past its 60 frames.
    expect(after.marks).toHaveLength(1);
    expect(after.marks[0]).toMatchObject({ clip: 2, at: 30 });
  });

  it("is the same document for a clip that isn't there", () => {
    const doc = wholeSource(300, { width: 1920, height: 1080 });
    expect(withRecordedClicks(doc, 9, input, 30, { width: 1920, height: 1080 }, look)).toBe(doc);
  });
});

describe("withRecordedKeys", () => {
  const keys = (time: number, ...k: string[]) => ({ time, keys: k });

  it("joins presses close together, at the frame's bottom centre, fading out", () => {
    const doc = withRecordedKeys(
      wholeSource(600, { width: 1920, height: 1080 }),
      1,
      { clicks: [], keys: [keys(1, "Ctrl", "C"), keys(1.5, "Ctrl", "V"), keys(5, "Enter")] },
      30,
    );
    expect(doc.marks).toHaveLength(2);
    const [a, b] = doc.marks;
    // From the first press to 1.5 s after the last.
    expect(a).toMatchObject({ at: 30, length: 60, fadeOut: 9 });
    expect(a.fadeIn ?? 0).toBe(0);
    expect(a.object).toMatchObject({
      kind: "keys",
      presses: [
        ["Ctrl", "C"],
        ["Ctrl", "V"],
      ],
      x: 960,
      size: recordedKeysSize(1080),
      ...RECORDED_KEYS,
    });
    expect(a.object.kind === "keys" && a.object.y).toBeGreaterThan(900);
    expect(b).toMatchObject({ at: 150, length: 45 });
  });

  it("ends a mark at its clip's end", () => {
    const doc = withRecordedKeys(
      wholeSource(40, { width: 1920, height: 1080 }),
      1,
      { clicks: [], keys: [keys(1, "Esc")] },
      30,
    );
    expect(doc.marks[0]).toMatchObject({ at: 30, length: 10 });
  });
});
