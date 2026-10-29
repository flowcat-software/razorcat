// Clip speed in the document (PLAN §7, Clip speed SP1): the frames a retimed clip shows, and
// trims, splits, ranges and markup on it.
import { beforeEach, describe, expect, it } from "vitest";
import {
  addMark,
  addRange,
  clipAt,
  clipLength,
  copyClip,
  insertClip,
  shownMarks,
  shownRanges,
  sourceLength,
  split,
  total,
  trimClip,
  wholeSource,
  type Doc,
  type MarkObject,
} from "./doc";
import { useDoc } from "./docStore";
import {
  clipFrame,
  retimedLength,
  setClipSpeed,
  setClipsSpeed,
  sourceFrame,
  speed,
  speedFromPercent,
  speedOf,
  speedPercent,
  videoEnd,
} from "./speed";

const last = (xs: readonly number[]) => xs[xs.length - 1];

/** The source frame on each timeline frame. */
function shown(doc: Doc): number[] {
  return Array.from({ length: total(doc) }, (_, f) => {
    const at = clipAt(doc, f)!;
    return sourceFrame(at.clip, at.clip.in + f - at.start);
  });
}

const text: MarkObject = {
  kind: "text",
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  text: "hi",
} as unknown as MarkObject;

const SPEEDS = [
  speed(1, 10),
  speed(3333, 10000),
  speed(1, 2),
  speed(2, 3),
  speed(3, 2),
  speed(2, 1),
  speed(7, 3),
  speed(10, 1),
];

describe("clip speed", () => {
  it("maps a clip's frames to its source's", () => {
    const half = { speed: speed(1, 2) };
    expect([0, 1, 2, 3, 4].map((v) => sourceFrame(half, v))).toEqual([0, 0, 1, 1, 2]);
    expect(clipFrame(half, 2)).toBe(4);
    const fast = { speed: speed(3, 2) };
    expect([0, 1, 2, 3, 4].map((v) => sourceFrame(fast, v))).toEqual([0, 1, 3, 4, 6]);
    // Frame 2 is never shown at 150%: the first frame showing it or what follows.
    expect(clipFrame(fast, 2)).toBe(2);
    expect(retimedLength(fast, 100)).toBe(67);
    expect(retimedLength(half, 100)).toBe(200);
    // With a phase: frame v shows floor((v·num + phase)/den).
    const phased = { speed: speed(3, 2), phase: 1 };
    expect([0, 1, 2, 3].map((v) => sourceFrame(phased, v))).toEqual([0, 2, 3, 5]);
    expect(clipFrame(phased, 2)).toBe(1);
    expect(retimedLength(phased, 100)).toBe(67);
    // Whole numbers past doubles' range stay exact.
    expect(sourceFrame({ speed: speed(9999, 10000) }, 2 ** 50)).toBe(
      Number((2n ** 50n * 9999n) / 10000n),
    );
  });

  it("takes percent to two decimals, kept to 10% and 1000%", () => {
    expect(speedFromPercent(150)).toEqual({ num: 3, den: 2 });
    expect(speedFromPercent(33.33)).toEqual({ num: 3333, den: 10000 });
    expect(speedFromPercent(5)).toEqual({ num: 1, den: 10 });
    expect(speedFromPercent(2000)).toEqual({ num: 10, den: 1 });
    expect(speedPercent(speed(7, 3))).toBeCloseTo(233.333, 3);
  });

  it("retimes a clip: its length, the frames it shows", () => {
    const doc = setClipSpeed(wholeSource(100), 1, speed(2, 1));
    expect(doc.clips[0]).toMatchObject({ in: 0, out: 50, speed: { num: 2, den: 1 } });
    expect(shown(doc)).toEqual(Array.from({ length: 50 }, (_, u) => 2 * u));
    const slow = setClipSpeed(wholeSource(100), 1, speed(1, 2));
    expect(total(slow)).toBe(200);
    expect(shown(slow).slice(0, 5)).toEqual([0, 0, 1, 1, 2]);
    expect(last(shown(slow))).toBe(99);
  });

  it("keeps a trimmed clip's first frame where the new speed shows it", () => {
    const doc = setClipSpeed(trimClip(wholeSource(1000), 1, 300, 400), 1, speed(3, 2));
    expect(doc.clips[0]).toMatchObject({ in: 200, out: 267 });
    expect(shown(doc)[0]).toBe(300);
    expect(last(shown(doc))).toBe(399);
  });

  it("keeps the first frame through any change of speed", () => {
    let doc = trimClip(wholeSource(5000), 1, 1234, 2345);
    for (const s of [...SPEEDS, ...SPEEDS.reverse(), speed(1, 1)]) {
      doc = setClipSpeed(doc, 1, s);
      expect(shown(doc)[0]).toBe(1234);
      expect(last(shown(doc))).toBeLessThanOrEqual(2344);
    }
    expect(doc.clips[0]).toEqual({ id: 1, source: "source", in: 1234, out: 2345 });
  });

  it("remembers a fast clip's video end, until a trim moves its end", () => {
    const doc = trimClip(wholeSource(5000), 1, 1234, 2345);
    const fast = setClipSpeed(doc, 1, speed(10, 1));
    // 112 frames, the last showing 2344 and covering to 2354: the video ends at 2345.
    expect(fast.clips[0]).toMatchObject({ out: fast.clips[0].in + 112, sourceOut: 2345 });
    expect(videoEnd(fast.clips[0])).toBe(2345);
    expect(setClipSpeed(fast, 1, speed(1, 1)).clips[0]).toMatchObject({ in: 1234, out: 2345 });
    // Trimmed a frame shorter, the video ends where its last frame does.
    const c = fast.clips[0];
    const shorter = trimClip(fast, 1, c.in, c.out - 1);
    expect(videoEnd(shorter.clips[0])).toBe(2344);
    expect(setClipSpeed(shorter, 1, speed(1, 1)).clips[0]).toMatchObject({ in: 1234, out: 2344 });
    // Its left part when split: the same.
    const left = split(fast, 50).clips[0];
    expect(videoEnd(left)).toBe(1734);
    // Its right part keeps the end.
    expect(videoEnd(split(fast, 50).clips[1])).toBe(2345);
  });

  it("back to 100% leaves no speed", () => {
    const fast = setClipSpeed(wholeSource(100), 1, speed(2, 1));
    const back = setClipSpeed(fast, 1, speed(1, 1));
    expect(back.clips[0]).toEqual({ id: 1, source: "source", in: 0, out: 100 });
    expect(setClipSpeed(back, 1, speed(1, 1))).toBe(back);
    expect(setClipSpeed(back, 9, speed(2, 1))).toBe(back);
  });

  it("makes a clip exactly a length, showing the same frames", () => {
    const doc = trimClip(wholeSource(1000), 1, 101, 401);
    for (const length of [30, 37, 77, 299, 300, 301, 1000, 2999, 3000]) {
      const r = setClipSpeed(doc, 1, { length });
      expect(clipLength(r.clips[0])).toBe(length);
      expect(shown(r)[0]).toBe(101);
      // The last frame shown is within the clip's video.
      expect(last(shown(r))).toBeLessThanOrEqual(400);
      expect(last(shown(r))).toBeGreaterThanOrEqual(400 - 300 / length);
    }
    // Past the limits, as near as they allow: 300 frames at 10% at most, 1000% at least.
    expect(clipLength(setClipSpeed(doc, 1, { length: 9000 }).clips[0])).toBe(3000);
    expect(clipLength(setClipSpeed(doc, 1, { length: 1 }).clips[0])).toBe(30);
    expect(speedOf(setClipSpeed(doc, 1, { length: 9000 }).clips[0])).toEqual({ num: 1, den: 10 });
  });

  // Every cut at every speed: a few seconds, more on CI's slower runners.
  it("never splits a frame differently: every cut, every speed", { timeout: 30_000 }, () => {
    for (const s of SPEEDS) {
      const doc = setClipSpeed(trimClip(wholeSource(2000), 1, 601, 902), 1, s);
      const whole = shown(doc);
      for (let f = 1; f < total(doc); f++) {
        expect(shown(split(doc, f))).toEqual(whole);
      }
    }
  });

  it("keeps the speed through a trim: the frames left are the ones shown before", () => {
    for (const s of SPEEDS) {
      const doc = setClipSpeed(trimClip(wholeSource(2000), 1, 601, 902), 1, s);
      const c = doc.clips[0];
      const whole = shown(doc);
      const k = Math.floor(clipLength(c) / 3);
      const trimmed = trimClip(doc, 1, c.in + k, c.out - k);
      expect(speedOf(trimmed.clips[0])).toEqual(s);
      expect(shown(trimmed)).toEqual(whole.slice(k, whole.length - k));
    }
  });

  it("pulls a trim out to the source's end at its speed", () => {
    const doc = setClipSpeed(trimClip(wholeSource(100), 1, 0, 50), 1, speed(1, 2));
    expect(sourceLength(doc, doc.clips[0])).toBe(200);
    const out = trimClip(doc, 1, 0, 999);
    expect(out.clips[0].out).toBe(200);
    expect(last(shown(out))).toBe(99);
  });

  it("never goes past the source's end", () => {
    for (const s of SPEEDS) {
      for (const [a, b] of [
        [0, 100],
        [37, 100],
        [99, 100],
      ]) {
        const doc = setClipSpeed(trimClip(wholeSource(100), 1, a, b), 1, s);
        const c = doc.clips[0];
        expect(c.out).toBeLessThanOrEqual(sourceLength(doc, c));
        expect(c.out).toBeGreaterThan(c.in);
        expect(Math.max(...shown(doc))).toBeLessThanOrEqual(99);
      }
    }
  });

  it("moves the clips after it along", () => {
    const doc = split(wholeSource(200), 100);
    const r = setClipSpeed(doc, 1, speed(2, 1));
    expect(total(r)).toBe(150);
    expect(shown(r).slice(49, 52)).toEqual([98, 100, 101]);
  });

  it("stretches ranges with the video, right to the clip's end", () => {
    let doc = split(wholeSource(300), 100);
    doc = addRange(doc, 50, 100); // the second half of clip 1
    doc = addRange(doc, 150, 200); // on clip 2
    for (const s of SPEEDS) {
      const r = setClipSpeed(doc, 1, s);
      const length = clipLength(r.clips[0]);
      const [first, second] = shownRanges(r);
      // Its video, from source frame 50 (or the first shown after it, if the speed skips it)
      // to the clip's end.
      expect(shown(r)[first.a]).toBeGreaterThanOrEqual(50);
      expect(shown(r)[first.a - 1]).toBeLessThan(50);
      expect(first.b).toBe(length);
      // Clip 2's range just moves with its clip.
      expect(second).toMatchObject({ a: length + 50, b: length + 100 });
    }
  });

  it("keeps markup on its video, its length and fades as they were", () => {
    let doc = split(wholeSource(300), 100);
    doc = addMark(doc, text, 40, 30, 0); // clip 1, source 40
    doc = addMark(doc, text, 120, 30, 0); // clip 2
    doc = { ...doc, marks: doc.marks.map((m) => ({ ...m, fadeIn: 6, fadeOut: 4 })) };
    const r = setClipSpeed(doc, 1, speed(2, 1));
    const [a, b] = shownMarks(r);
    expect(a).toMatchObject({ start: 20, end: 50 });
    expect(shown(r)[a.start]).toBe(40);
    expect(r.marks[0]).toMatchObject({ length: 30, fadeIn: 6, fadeOut: 4 });
    expect(b).toMatchObject({ start: 70, end: 100 });
  });

  it("or stretches markup with the speed", () => {
    let doc = wholeSource(300);
    doc = addMark(doc, text, 40, 30, 0);
    doc = { ...doc, marks: doc.marks.map((m) => ({ ...m, fadeIn: 6, fadeOut: 4 })) };
    const fast = setClipSpeed(doc, 1, speed(2, 1), true);
    expect(shownMarks(fast)[0]).toMatchObject({ start: 20, end: 35 });
    expect(fast.marks[0]).toMatchObject({ length: 15, fadeIn: 3, fadeOut: 2 });
    const slow = setClipSpeed(doc, 1, speed(1, 2), true);
    expect(shownMarks(slow)[0]).toMatchObject({ start: 80, end: 140 });
    expect(slow.marks[0]).toMatchObject({ length: 60, fadeIn: 12, fadeOut: 8 });
  });

  it("anchors markup to any frame of a slowed clip, not just each source frame's first", () => {
    let doc = setClipSpeed(wholeSource(100), 1, speed(1, 10));
    doc = addMark(doc, text, 15, 10, 0);
    expect(shownMarks(doc)[0]).toMatchObject({ start: 15, end: 25 });
    expect(shownMarks(split(doc, 12))[0]).toMatchObject({ start: 15, end: 25 });
  });

  it("copies keep the speed", () => {
    const doc = setClipSpeed(wholeSource(100), 1, speed(3, 2));
    const copy = copyClip(doc, 1)!;
    const two = insertClip(doc, copy, 1);
    expect(two.clips[1]).toMatchObject({ in: 0, out: 67, speed: { num: 3, den: 2 } });
    expect(shown(two)).toEqual([...shown(doc), ...shown(doc)]);
  });

  it("sets several clips' speed in one edit", () => {
    const doc = setClipsSpeed(split(wholeSource(200), 100), [1, 2], speed(2, 1));
    expect(doc.clips.map((c) => [c.in, c.out])).toEqual([
      [0, 50],
      [50, 100],
    ]);
    expect(shown(doc)).toEqual(Array.from({ length: 100 }, (_, u) => 2 * u));
  });
});

describe("clip speed in the store", () => {
  const s = () => useDoc.getState();
  const options = (follow: boolean, stretchMarks: boolean) =>
    s().setOptions({ ...s().options, follow, stretchMarks });
  beforeEach(() => {
    s().load(300);
    s().addMark(text, 40, 30, 0);
    options(true, false);
  });

  it("sets a speed, and a duration, each one undo step", () => {
    expect(s().setSpeed([1], speed(2, 1))).toBe(true);
    expect(total(s().doc)).toBe(150);
    expect(s().setDuration(1, 100)).toBe(true);
    expect(total(s().doc)).toBe(100);
    s().undo();
    expect(total(s().doc)).toBe(150);
    s().undo();
    expect(total(s().doc)).toBe(300);
  });

  it("stretches markup only while it follows its video", () => {
    options(true, true);
    s().setSpeed([1], speed(2, 1));
    expect(shownMarks(s().doc)[0]).toMatchObject({ start: 20, end: 35 });
    s().undo();
    // Following off: markup keeps its place on the timeline, the stretch setting aside.
    options(false, true);
    s().setSpeed([1], speed(2, 1));
    expect(shownMarks(s().doc)[0]).toMatchObject({ start: 40, end: 70 });
  });
});

describe("the speed popover's one step", () => {
  const s = () => useDoc.getState();
  beforeEach(() => s().load(300));

  it("keeps a field's drag inside it, and Esc puts it all back", () => {
    s().beginGesture(); // opened
    s().setSpeed([1], speed(2, 1));
    s().beginGesture(); // a field dragged
    s().setSpeed([1], speed(3, 1));
    s().endGesture();
    expect(total(s().doc)).toBe(100);
    s().cancelGesture(); // Esc
    expect(total(s().doc)).toBe(300);
    expect(s().past).toHaveLength(0);
  });

  it("makes one undo step of it all when kept", () => {
    s().beginGesture();
    s().setSpeed([1], speed(2, 1));
    s().beginGesture();
    s().setDuration(1, 120);
    s().endGesture();
    s().endGesture(); // Enter
    expect(total(s().doc)).toBe(120);
    expect(s().past).toHaveLength(1);
    s().undo();
    expect(total(s().doc)).toBe(300);
  });
});
