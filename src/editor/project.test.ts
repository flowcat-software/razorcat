import { describe, expect, it } from "vitest";
import { wholeSource } from "./doc";
import { openedDoc } from "./project";

describe("openedDoc", () => {
  const saved = wholeSource(100, { width: 640, height: 360 }, "media://old/1");
  const file = { id: "media://new/7", frames: 100, name: "a.mp4" };

  it("gives the clips their files' ids now", () => {
    const opened = openedDoc(JSON.stringify(saved), [file]);
    expect(opened?.doc.sources).toEqual([{ id: file.id, frames: 100 }]);
    expect(opened?.doc.clips.map((c) => c.source)).toEqual([file.id]);
    expect(opened?.changed).toEqual([]);
  });

  it("names a file whose length changed", () => {
    const opened = openedDoc(JSON.stringify(saved), [{ ...file, frames: 90 }]);
    expect(opened?.changed).toEqual(["a.mp4"]);
  });

  it("refuses what isn't a document of those files", () => {
    expect(openedDoc("nope", [file])).toBeNull();
    expect(openedDoc(JSON.stringify(saved), [])).toBeNull();
    expect(openedDoc("{}", [file])).toBeNull();
  });
});
