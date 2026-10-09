import { describe, expect, it } from "vitest";
import { shownMarks } from "../../editor/doc";
import { useDoc as useEdit } from "../../editor/docStore";
import { duplicateSelection } from "../objectActions";
import { docStore } from "./store";
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
  it("duplicates in place, for the same frames, in another lane", () => {
    docStore.getState().load({ ...emptyDoc({ width: 100, height: 100 }), annotations: [text] });
    const [original] = docStore.getState().doc.annotations;
    docStore.getState().select([original.id]);
    expect(duplicateSelection()).toBe(true);
    const marks = shownMarks(useEdit.getState().doc);
    expect(marks.map((m) => [m.start, m.end, m.lane])).toEqual([
      [0, 1000, 0],
      [0, 1000, 1],
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
      [500, 600, 0],
      [500, 600, 1],
    ]);
    expect(useEdit.getState().selectedMarks).toEqual([2]);
  });
});
