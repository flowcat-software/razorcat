import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const lines: string[] = [];
vi.mock("../shared/log", () => ({ logLine: (text: string) => lines.push(text) }));

const { logActions } = await import("./actionLog");
const { useDoc } = await import("./docStore");
const { useTool } = await import("./toolStore");

const s = () => useDoc.getState();

describe("the action log", () => {
  beforeAll(() => logActions());
  beforeEach(() => {
    s().load(100);
    lines.length = 0;
  });

  it("logs an edit by name, with the counts", () => {
    s().split(40);
    expect(lines).toEqual(["[edit] split · 2 clips, 0 markup, 0 ranges, 1 files"]);
  });

  it("logs nothing for an edit that changes nothing, or a selection", () => {
    s().split(0);
    s().select(1);
    expect(lines).toEqual([]);
  });

  it("logs undo and redo", () => {
    s().split(40);
    s().undo();
    s().redo();
    expect(lines.map((l) => l.split(" ·")[0])).toEqual([
      "[edit] split",
      "[edit] undo",
      "[edit] redo",
    ]);
  });

  it("logs a drag once, at its end, by its first edit", () => {
    s().beginGesture();
    s().split(20);
    s().split(40);
    expect(lines).toEqual([]);
    s().endGesture();
    expect(lines).toEqual(["[edit] split (drag) · 3 clips, 0 markup, 0 ranges, 1 files"]);
    lines.length = 0;
    s().beginGesture();
    s().endGesture();
    expect(lines).toEqual([]);
  });

  it("logs a tool change", () => {
    useTool.getState().setTool("crop");
    expect(lines).toContain("[tool] crop");
  });
});
