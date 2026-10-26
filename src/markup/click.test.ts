import { afterEach, describe, expect, it } from "vitest";
import { clickReach, clickTiming, placedClickTimes } from "./click";
import {
  DEFAULT_CLICK_SETTINGS,
  buttonColor,
  doublesShown,
  clickSettingsOf,
  useClickSettings,
} from "./clickSettings";
import type { ClickAnnotation } from "./model/types";
import { patchAnnotation } from "./restyle";
import { useToolStore } from "./toolStore";
import { toolClickStyle } from "./styles";

afterEach(() => useClickSettings.setState(DEFAULT_CLICK_SETTINGS));

describe("clickTiming", () => {
  it("is the length and fades in frames, the fades fitted to it", () => {
    expect(clickTiming(30, { seconds: 0.8, fadeIn: 0.1, fadeOut: 0.3 })).toEqual({
      length: 24,
      fadeIn: 3,
      fadeOut: 9,
    });
    // Fades longer than the click: the fade-in first, the fade-out what's left.
    expect(clickTiming(30, { seconds: 0.5, fadeIn: 0.4, fadeOut: 1 })).toEqual({
      length: 15,
      fadeIn: 12,
      fadeOut: 3,
    });
  });
});

describe("placed clicks", () => {
  const recorded = {
    ...DEFAULT_CLICK_SETTINGS,
    seconds: 2,
    size: 60,
    color: "#00d5ff",
    look: "halo" as const,
  };

  it("look and last as Settings › Recording says while they follow it", () => {
    useClickSettings.setState(recorded);
    useToolStore.setState({ clickLook: "target" });
    expect(placedClickTimes().seconds).toBe(2);
    expect(toolClickStyle()).toEqual({ look: "halo", size: 60, button: "left", double: false });
  });

  it("are the tool's own, timed as a recorded click by default, when they don't", () => {
    useClickSettings.setState({ ...recorded, follow: false });
    useToolStore.setState({ clickLook: "target" });
    expect(placedClickTimes().seconds).toBe(DEFAULT_CLICK_SETTINGS.seconds);
    expect(toolClickStyle().look).toBe("target");
  });
});

describe("clickSettingsOf", () => {
  it("takes Settings › Recording's, the defaults for any missing", () => {
    expect(clickSettingsOf({ clickLook: "ripple", clickSeconds: 1.5 })).toEqual({
      ...DEFAULT_CLICK_SETTINGS,
      look: "ripple",
      seconds: 1.5,
    });
  });
});

describe("clickReach", () => {
  it("takes in a double-click's second ring, and a ripple's spread", () => {
    expect(clickReach({ size: 40, double: false, look: "ring" })).toBe(20);
    expect(clickReach({ size: 40, double: true, look: "ring" })).toBeCloseTo(28.8);
    expect(clickReach({ size: 40, double: false, look: "ripple" })).toBeCloseTo(26);
  });
});

describe("a click's button", () => {
  const mark: ClickAnnotation = {
    id: "m1",
    kind: "click",
    x: 0,
    y: 0,
    size: 44,
    look: "ring",
    double: false,
    button: "left",
  };

  it("is drawn in that button's colour from Settings › Recording, as it is now", () => {
    expect(buttonColor("right")).toBe(DEFAULT_CLICK_SETTINGS.colorRight);
    // None (made before there was a choice): the left's.
    expect(buttonColor(undefined)).toBe(DEFAULT_CLICK_SETTINGS.color);
    useClickSettings.setState({ colorRight: "#123456" });
    expect(buttonColor("right")).toBe("#123456");
  });

  it("changes, and its double-click with it, as asked; never a colour", () => {
    expect(patchAnnotation(mark, { clickButton: "middle", clickDouble: true })).toMatchObject({
      button: "middle",
      double: true,
    });
    expect(patchAnnotation(mark, { color: "#000000" })).toEqual(mark);
  });
});

describe("double-clicks", () => {
  it("aren't shown, nor placed, while styles are locked to a recording that doesn't show them", () => {
    useToolStore.setState({ clickDouble: true });
    useClickSettings.setState({ follow: true, double: false });
    expect(doublesShown()).toBe(false);
    expect(toolClickStyle().double).toBe(false);
    expect(clickReach({ size: 40, double: true, look: "ring" })).toBe(20);
    // Unlocked, the tool's own say.
    useClickSettings.setState({ follow: false });
    expect(doublesShown()).toBe(true);
    expect(toolClickStyle().double).toBe(true);
    useToolStore.setState({ clickDouble: false });
  });
});
