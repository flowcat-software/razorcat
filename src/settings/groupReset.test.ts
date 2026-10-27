import { describe, expect, it } from "vitest";
import type { Settings } from "../shared/ipc";
import { groupDiffers, groupPaths, resetGroup, same } from "./groupReset";
import type { Group } from "./schema";

const defaults = {
  recording: { clickSize: 44, clickLook: "ripple", folder: "" },
  styles: { palette: ["#ff0000"], tools: { click: { palette: ["#ffd60a"] } } },
} as unknown as Settings;

const group: Group = {
  title: "Clicks",
  items: [
    { id: "a", kind: "toggle", label: "A", path: "recording.clickLook" as never },
    { id: "b", kind: "slider", label: "B", path: "recording.clickSize", min: 0, max: 1, step: 1 },
    { id: "c", kind: "toolStyle", label: "C", tool: "click", widths: false },
    { id: "d", kind: "about", label: "D" },
  ],
};

describe("a group's reset", () => {
  it("stands for its items' settings, and a tool's own style", () => {
    expect(groupPaths(group)).toEqual([
      "recording.clickLook",
      "recording.clickSize",
      "styles.tools.click",
    ]);
  });

  it("shows only while something in the group differs", () => {
    expect(groupDiffers(group, structuredClone(defaults), defaults)).toBe(false);
    const changed = structuredClone(defaults);
    changed.recording.folder = "D:/Takes"; // not this group's
    expect(groupDiffers(group, changed, defaults)).toBe(false);
    changed.recording.clickSize = 60;
    expect(groupDiffers(group, changed, defaults)).toBe(true);
  });

  it("puts back only the group's settings", () => {
    const s = structuredClone(defaults);
    s.recording.clickSize = 60;
    s.recording.folder = "D:/Takes";
    s.styles.tools.click = null as never;
    s.styles.palette = ["#00ff00"];
    const r = resetGroup(group, s, defaults);
    expect(r.recording.clickSize).toBe(44);
    expect(r.styles.tools.click).toEqual({ palette: ["#ffd60a"] });
    expect(r.recording.folder).toBe("D:/Takes");
    expect(r.styles.palette).toEqual(["#00ff00"]);
    expect(s.recording.clickSize).toBe(60);
  });

  it("leaves a tool's style out when it has none by default", () => {
    const g: Group = {
      items: [{ id: "p", kind: "toolStyle", label: "P", tool: "pen", widths: true }],
    };
    const s = structuredClone(defaults);
    (s.styles.tools as Record<string, unknown>).pen = { palette: ["#000000"] };
    expect(groupDiffers(g, s, defaults)).toBe(true);
    expect("pen" in resetGroup(g, s, defaults).styles.tools).toBe(false);
  });

  it("compares objects whatever their keys' order", () => {
    expect(same({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(same({ a: null }, {})).toBe(true);
    expect(same([1, 2], [2, 1])).toBe(false);
  });
});
