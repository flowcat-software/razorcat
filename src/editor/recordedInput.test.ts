import { describe, expect, it } from "vitest";
import type { RecordedInput } from "../shared/ipc";
import { addSource, wholeSource, type Doc } from "./doc";
import { NO_GROW } from "./frame";
import { onFrame, withRecordedClicks, type RecordedClickStyle } from "./recordedInput";

const look: RecordedClickStyle = {
  look: "ring",
  size: 44,
  double: true,
  seconds: 0.8,
  fadeIn: 0,
  fadeOut: 0.3,
};
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
    expect(a.object).toMatchObject({ kind: "click", x: 100, y: 50, button: "left" });
    expect(b).toMatchObject({ at: 75 });
    expect(b.object).toMatchObject({ button: "right", look: "ring", size: 44 });
  });

  it("puts an added recording's clicks on its own clip, and leaves out any off its frames", () => {
    const doc = addSource(wholeSource(300, { width: 1920, height: 1080 }), "rec", 60);
    const after = withRecordedClicks(
      doc,
      2,
      { clicks: [click(1, 10, 10), click(5, 10, 10)] },
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

describe("withRecordedClicks, as Settings › Recording says", () => {
  it("leaves out a double-click's second ring when they're not shown, and fades in", () => {
    const input: RecordedInput = { clicks: [{ ...click(1, 10, 10), double: true }] };
    const doc = withRecordedClicks(
      wholeSource(300, { width: 1920, height: 1080 }),
      1,
      input,
      30,
      { width: 1920, height: 1080 },
      { ...look, double: false, look: "ripple", seconds: 1, fadeIn: 0.2 },
    );
    expect(doc.marks[0]).toMatchObject({ length: 30, fadeIn: 6, fadeOut: 9 });
    expect(doc.marks[0].object).toMatchObject({ look: "ripple", double: false });
  });
});
