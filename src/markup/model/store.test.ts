import { describe, expect, it } from "vitest";
import {
  addMark,
  moveClip,
  shownMarks,
  split,
  wholeSource,
  type MarkObject,
} from "../../editor/doc";
import { useDoc as useEdit } from "../../editor/docStore";
import { duplicateSelection } from "../objectActions";
import { docStore, timelineStepLabels } from "./store";
import { emptyDoc, type Annotation } from "./types";

const text: Annotation = {
  id: "t",
  kind: "text",
  x: 40,
  y: 30,
  width: 0,
  autoWidth: true,
  text: "Hi",
  fontFamily: "Segoe UI",
  fontSize: 20,
  bold: false,
  italic: false,
  align: "left",
  rotation: 0,
  color: "#ffffff",
  background: false,
  backgroundColor: "#000000",
};

describe("the markup's view of the edit", () => {
  it("duplicates in place, for the same frames, in front in a lane of its own", () => {
    docStore.getState().load({ ...emptyDoc({ width: 100, height: 100 }), annotations: [text] });
    const [original] = docStore.getState().doc.annotations;
    docStore.getState().select([original.id]);
    expect(duplicateSelection()).toBe(true);
    const marks = shownMarks(useEdit.getState().doc);
    expect(marks.map((m) => [m.start, m.end, m.lane])).toEqual([
      [0, 1000, 1],
      [0, 1000, 0],
    ]);
    const [copy] = docStore.getState().selection;
    const shown = docStore.getState().doc.annotations.find((a) => a.id === copy);
    expect(shown).toMatchObject({ x: 40, y: 30, text: "Hi" });
    // One undo step takes the copy away.
    useEdit.getState().undo();
    expect(useEdit.getState().doc.marks).toHaveLength(1);
  });

  it("duplicates markup selected on the timeline away from the playhead", () => {
    docStore.getState().load({ ...emptyDoc({ width: 100, height: 100 }), annotations: [text] });
    const [mark] = useEdit.getState().doc.marks;
    // Later on, the playhead (frame 0) off it: nothing of it shows.
    useEdit.getState().setMark(mark.id, 500, 600, 0);
    useEdit.getState().selectMarks([mark.id]);
    expect(docStore.getState().selection).toEqual([]);
    expect(duplicateSelection()).toBe(true);
    expect(shownMarks(useEdit.getState().doc).map((m) => [m.start, m.end, m.lane])).toEqual([
      [500, 600, 1],
      [500, 600, 0],
    ]);
    expect(useEdit.getState().selectedMarks).toEqual([2]);
  });

  it("places a click for a moment, fading out, as a recording's are", () => {
    docStore.getState().load(emptyDoc({ width: 100, height: 100 }));
    docStore.getState().add({
      kind: "click",
      x: 10,
      y: 10,
      size: 44,
      look: "ring",
      color: "#ffd60a",
      double: false,
    });
    // No player: at 30 fps, 0.8 s and 0.3 s.
    const [mark] = useEdit.getState().doc.marks;
    expect(mark).toMatchObject({ at: 0, length: 24, fadeOut: 9 });
  });
});

describe("timelineStepLabels", () => {
  /** A step marker, made `seq`th, with its own `label` if given. */
  const step = (seq: number, label?: string): MarkObject => ({
    kind: "step",
    x: 0,
    y: 0,
    seq,
    size: 30,
    shape: "circle",
    color: "#f00",
    textColor: "#fff",
    fontFamily: "Segoe UI",
    format: "numbers",
    start: 1,
    ...(label !== undefined && { label }),
  });

  it("counts by start time on the timeline, not by when they were made", () => {
    let doc = wholeSource(100);
    doc = addMark(doc, step(1), 60, 10, 0); // made first, starts last
    doc = addMark(doc, step(2), 10, 10, 0);
    doc = addMark(doc, step(3), 30, 10, 1);
    expect(timelineStepLabels(doc)).toEqual({ m1: "3", m2: "1", m3: "2" });
  });

  it("counts markers on the same frame in the order they were made, whatever their lanes", () => {
    let doc = wholeSource(100);
    doc = addMark(doc, step(1), 10, 10, 0);
    doc = addMark(doc, step(2), 10, 10, 1);
    doc = addMark(doc, step(3), 10, 10, 0); // both lanes busy: back in the first
    expect(timelineStepLabels(doc)).toEqual({ m1: "1", m2: "2", m3: "3" });
  });

  it("skips markers with a label of their own, and follows the first one's numbering", () => {
    let doc = wholeSource(100);
    doc = addMark(doc, { ...step(1), format: "letters", start: 2 } as MarkObject, 10, 5, 0);
    doc = addMark(doc, step(2, "X"), 20, 5, 0);
    doc = addMark(doc, step(3), 30, 5, 0);
    expect(timelineStepLabels(doc)).toEqual({ m1: "B", m2: "X", m3: "C" });
  });

  it("renumbers when a clip moves its markers' places", () => {
    let doc = split(wholeSource(100), 50);
    doc = addMark(doc, step(1), 10, 5, 0);
    doc = addMark(doc, step(2), 60, 5, 0);
    expect(timelineStepLabels(doc)).toEqual({ m1: "1", m2: "2" });
    expect(timelineStepLabels(moveClip(doc, 2, 0))).toEqual({ m1: "2", m2: "1" });
  });
});
