import { describe, expect, it } from "vitest";
import { keyNameOf, pressOf, withPress } from "./KeysField";
import { keysLayout, keysText, keysTiming } from "./keys";

/** Every character 10 px wide. */
const measure = (t: string) => t.length * 10;

describe("keysLayout", () => {
  it("lays the keys out in a row, centred, with a + between keys and a , between presses", () => {
    const l = keysLayout(
      {
        presses: [
          ["Ctrl", "C"],
          ["Ctrl", "V"],
        ],
        size: 20,
        look: "outline",
      },
      measure,
    );
    expect(l.pieces.map((p) => p.kind)).toEqual([
      "key",
      "plus",
      "key",
      "comma",
      "key",
      "plus",
      "key",
    ]);
    // Centred: as far left as right.
    const first = l.pieces[0];
    const last = l.pieces[l.pieces.length - 1];
    expect(first.x).toBeCloseTo(-(last.x + last.width));
    // "C" alone is no narrower than its key is tall.
    expect(l.pieces[2].width).toBeCloseTo(l.keyHeight);
  });

  it("puts a pill's keys in one line of text, padded", () => {
    const l = keysLayout({ presses: [["Ctrl", "S"]], size: 10, look: "pill" }, measure);
    expect(l.pieces).toEqual([{ kind: "text", text: "Ctrl + S", x: -40, width: 80 }]);
    expect(l.width).toBeGreaterThan(80);
  });

  it("pads a bar round its caps", () => {
    const caps = keysLayout({ presses: [["Esc"]], size: 10, look: "outline" }, measure);
    const bar = keysLayout({ presses: [["Esc"]], size: 10, look: "bar" }, measure);
    expect(bar.height).toBeGreaterThan(caps.height);
  });
});

describe("keysText", () => {
  it("reads as the keys are pressed", () => {
    expect(
      keysText([
        ["Ctrl", "C"],
        ["Ctrl", "V"],
      ]),
    ).toBe("Ctrl + C, Ctrl + V");
  });
});

describe("keysTiming", () => {
  it("shows a moment, at once, fading out", () => {
    expect(keysTiming(30)).toEqual({ length: 45, fadeIn: 0, fadeOut: 9 });
    expect(keysTiming(30, 3)).toMatchObject({ length: 90 });
  });
});

const key = (
  code: string,
  key: string,
  mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {},
) => ({
  code,
  key,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

describe("the keys field", () => {
  it("names keys as a recording does", () => {
    expect(keyNameOf({ code: "KeyS", key: "s" })).toBe("S");
    expect(keyNameOf({ code: "Digit4", key: "$" })).toBe("4");
    expect(keyNameOf({ code: "F5", key: "F5" })).toBe("F5");
    expect(keyNameOf({ code: "Numpad7", key: "7" })).toBe("Num 7");
    expect(keyNameOf({ code: "Escape", key: "Escape" })).toBe("Esc");
    expect(keyNameOf({ code: "ArrowLeft", key: "ArrowLeft" })).toBe("←");
    expect(keyNameOf({ code: "Minus", key: "-" })).toBe("-");
    expect(keyNameOf({ code: "ShiftLeft", key: "Shift" })).toBeNull();
  });

  it("puts the modifiers first, in Windows' order", () => {
    expect(pressOf(key("KeyS", "S", { shift: true, ctrl: true }))).toEqual(["Ctrl", "Shift", "S"]);
    expect(pressOf(key("ControlLeft", "Control", { ctrl: true }))).toBeNull();
  });

  it("replaces the keys with the first press, then adds each one after", () => {
    const one = withPress([["Ctrl", "C"]], ["Ctrl", "S"], true);
    expect(one).toEqual([["Ctrl", "S"]]);
    expect(withPress(one, ["Enter"], false)).toEqual([["Ctrl", "S"], ["Enter"]]);
  });
});
