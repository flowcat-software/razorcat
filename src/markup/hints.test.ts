import { describe, expect, it } from "vitest";
import {
  CONTROL_HINTS,
  WHY,
  chooseHint,
  parseHint,
  withShortcuts,
  type ControlHint,
  type HintState,
} from "./hints";
import { RAZORCAT_SHORTCUTS } from "./shortcuts";
import { TOOLS } from "./toolStore";

const nothing = { clips: 0, range: false, marks: 0, pendingIn: false };
const base: HintState = {
  said: null,
  hover: null,
  drag: null,
  mode: null,
  tool: "select",
  selected: 0,
  textSelected: false,
  segmentSelected: false,
  stepSelected: false,
  calloutSelected: false,
  labelTyping: false,
  typing: false,
  overObject: false,
  twoColors: false,
  drawingToolsSelect: true,
  redactText: false,
  overRedactedWord: false,
  timeline: nothing,
};

describe("chooseHint", () => {
  it("prefers the hovered control, then the drag, then the tool", () => {
    const s: HintState = { ...base, tool: "rect", hover: "open", drag: "square" };
    expect(chooseHint(s)).toBe(CONTROL_HINTS.open);
    expect(chooseHint({ ...s, hover: null })).toBe("[Shift] square");
    expect(chooseHint({ ...s, hover: null, drag: null })).toMatch(/^\[Shift\] square/);
  });

  it("shows only how to get a video in an empty editor", () => {
    const hint = chooseHint({ ...base, mode: "empty" });
    expect(hint).toMatch(/^\[Ctrl\+O\] open a video/);
    expect(hint).not.toContain("tools");
    // A hovered control still explains itself.
    expect(chooseHint({ ...base, mode: "empty", hover: "open" })).toBe(CONTROL_HINTS.open);
  });

  it("says why a key did nothing first, for its moment", () => {
    const s: HintState = { ...base, hover: "open", drag: "trim", said: "split.cut" };
    expect(chooseHint(s)).toBe(WHY["split.cut"]);
    expect(chooseHint({ ...s, said: null })).toBe(CONTROL_HINTS.open);
  });

  it("shows the crop and grow keys while they're picked up", () => {
    expect(chooseHint({ ...base, mode: "crop" })).toContain("[Shift] keeps the shape");
    expect(chooseHint({ ...base, mode: "grow" })).toContain("[Shift] the opposite side too");
  });

  it("shows the keys for what's selected on the timeline", () => {
    const on = (t: Partial<HintState["timeline"]>) =>
      chooseHint({ ...base, timeline: { ...nothing, ...t } });
    expect(on({ clips: 1 })).toContain("[M] mute");
    expect(on({ clips: 3 })).toMatch(/^Drag one to move them all/);
    expect(on({ range: true })).toContain("keep the ranges");
    expect(on({ marks: 2 })).toContain("paste style");
    expect(on({ pendingIn: true, clips: 1 })).toMatch(/^\[O\] sets the out/);
    // Markup selected on the preview has Vandal's keys.
    expect(chooseHint({ ...base, selected: 1, timeline: { ...nothing, marks: 1 } })).toMatch(
      /nudge/,
    );
  });

  it("names Razorcat's tool keys", () => {
    const idle = withShortcuts(chooseHint(base), RAZORCAT_SHORTCUTS);
    expect(idle).toMatch(
      /^\[V\] \[P\] \[H\] \[\/\] \[A\] \[B\] \[E\] \[T\] \[Q\] \[U\] \[F\] \[N\] \[D\] \[Y\] tools/,
    );
    expect(withShortcuts(CONTROL_HINTS["tool.spotlight"], RAZORCAT_SHORTCUTS)).toMatch(/^\[F\]/);
    expect(withShortcuts(CONTROL_HINTS["tool.redact"], RAZORCAT_SHORTCUTS)).toMatch(/^\[U\]/);
  });

  it("has a hint for every tool's button", () => {
    // A tool without one left the hint line with nothing, and it failed (the click tool did).
    for (const tool of TOOLS) expect(CONTROL_HINTS[`tool.${tool}` as ControlHint]).toBeTruthy();
  });

  it("shows the general shortcuts with Select and nothing selected", () => {
    expect(chooseHint(base)).toContain("tools");
    expect(chooseHint({ ...base, selected: 2 })).toMatch(/^\[Del\]/);
    expect(chooseHint({ ...base, selected: 1, textSelected: true })).toMatch(/^\[Enter\]/);
    expect(chooseHint({ ...base, selected: 1, segmentSelected: true })).toMatch(/^Drag the ◆/);
    expect(chooseHint({ ...base, selected: 1, stepSelected: true })).toMatch(
      /^\[Enter\] or double-click/,
    );
    expect(chooseHint({ ...base, tool: "step", selected: 1, stepSelected: true })).toMatch(
      /type its own label/,
    );
    expect(chooseHint({ ...base, labelTyping: true })).toMatch(/^\[Enter\] done/);
  });

  it("says what Ctrl does over an object, following the setting", () => {
    const over = { ...base, tool: "arrow" as const, overObject: true };
    expect(chooseHint(over)).toContain("[Ctrl] draw over it");
    expect(chooseHint({ ...over, drawingToolsSelect: false })).toMatch(/^\[Ctrl\] select/);
    // The pen always draws.
    expect(chooseHint({ ...over, tool: "pen" })).not.toContain("[Ctrl]");
  });

  it("shows the typing keys while typing", () => {
    expect(chooseHint({ ...base, tool: "text", typing: true })).toMatch(/^\[Esc\] done/);
  });
});

describe("color hints", () => {
  it("names the fill color only when a shape has one", () => {
    const rect = { ...base, tool: "rect" as const };
    expect(chooseHint(rect)).not.toContain("Ctrl+Shift");
    expect(chooseHint({ ...rect, twoColors: true })).toContain(
      "[Ctrl+1…9] fill color · [Ctrl+Shift+1…9] border color",
    );
  });

  it("names text and background colors, the background only with a box", () => {
    const text = { ...base, tool: "text" as const };
    expect(chooseHint(text)).toMatch(/\[Ctrl\+1…9\] text color$/);
    expect(chooseHint({ ...text, twoColors: true })).toMatch(/background color$/);
    expect(chooseHint({ ...text, typing: true, twoColors: true })).toMatch(/background color$/);
  });
});

describe("parseHint", () => {
  it("splits text and key caps", () => {
    expect(parseHint("[Ctrl+Shift+1…9] fill · [Space]+drag")).toEqual([
      { keys: ["Ctrl", "Shift", "1…9"] },
      { text: " fill · " },
      { keys: ["Space"] },
      { text: "+drag" },
    ]);
  });

  it("allows brackets as keys", () => {
    expect(parseHint("[Ctrl+[] [Ctrl+]] order")).toEqual([
      { keys: ["Ctrl", "["] },
      { text: " " },
      { keys: ["Ctrl", "]"] },
      { text: " order" },
    ]);
  });

  it("keeps an unclosed bracket as text", () => {
    expect(parseHint("a [b")).toEqual([{ text: "a [b" }]);
  });

  it("parses every hint in the tables", () => {
    for (const hint of [...Object.values(CONTROL_HINTS), ...Object.values(WHY)]) {
      for (const part of parseHint(hint)) {
        if ("text" in part) expect(part.text).not.toMatch(/[[\]]/);
        else expect(part.keys.every((k) => k.length > 0)).toBe(true);
      }
    }
  });
});
