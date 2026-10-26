// How clicks look and last (PLAN 5b.6d): Settings › Recording sets a recording's, and with "Lock
// click styles in the editor" on (the default), clicks placed by hand too, their look and size
// locked on the options bar. Off, the click tool is its own (remembered as any tool's), and a
// placed click lasts as long as a recorded one does by default. Every click, recorded or placed,
// is drawn in its button's colour from here, as it is now. The editor keeps this in step with the
// settings (EditorApp's `applySettings`).

import { create } from "zustand";
import type { ClickButton, ClickLook } from "./model/types";

export interface ClickSettings {
  look: ClickLook;
  /** Each button's colour: left, right and middle. */
  color: string;
  colorRight: string;
  colorMiddle: string;
  /** Across (px). */
  size: number;
  /** How long a click shows, and fades in and out over (s). */
  seconds: number;
  fadeIn: number;
  fadeOut: number;
  /** A double-click shows a second ring. */
  double: boolean;
  /** Clicks placed by hand follow these. */
  follow: boolean;
}

/** As Rust's defaults (settings.rs). */
export const DEFAULT_CLICK_SETTINGS: ClickSettings = {
  look: "ripple",
  color: "#ffd60a",
  colorRight: "#ff4fd8",
  colorMiddle: "#4c9aff",
  size: 44,
  seconds: 0.8,
  fadeIn: 0,
  fadeOut: 0.3,
  double: true,
  follow: true,
};

export const useClickSettings = create<ClickSettings>(() => DEFAULT_CLICK_SETTINGS);

/**
 * Double-clicks show their second ring: not while click styles are locked to Settings ›
 * Recording with "Show double-clicks" off there (a recording wouldn't show them, so nor does the
 * editor). As the colours, this is how every click is drawn, as the settings are now.
 */
export function doublesShown(s = useClickSettings.getState()): boolean {
  return s.double || !s.follow;
}

/** Button `b`'s colour (none: the left's), as Settings › Recording has it now. */
export function buttonColor(b: ClickButton | undefined, s = useClickSettings.getState()) {
  return b === "right" ? s.colorRight : b === "middle" ? s.colorMiddle : s.color;
}

/** Settings › Recording's clicks, as the editor takes them (each missing one: the default). */
export function clickSettingsOf(r: {
  clickLook?: ClickLook;
  clickColor?: string;
  clickColorRight?: string;
  clickColorMiddle?: string;
  clickSize?: number | null;
  clickSeconds?: number | null;
  clickFadeIn?: number | null;
  clickFadeOut?: number | null;
  clickDouble?: boolean;
  placedClicksFollow?: boolean;
}): ClickSettings {
  // Rust's f64s arrive typed `number | null` (see ipc.ts); they're always numbers.
  const d = DEFAULT_CLICK_SETTINGS;
  return {
    look: r.clickLook ?? d.look,
    color: r.clickColor ?? d.color,
    colorRight: r.clickColorRight ?? d.colorRight,
    colorMiddle: r.clickColorMiddle ?? d.colorMiddle,
    size: r.clickSize ?? d.size,
    seconds: r.clickSeconds ?? d.seconds,
    fadeIn: r.clickFadeIn ?? d.fadeIn,
    fadeOut: r.clickFadeOut ?? d.fadeOut,
    double: r.clickDouble ?? d.double,
    follow: r.placedClicksFollow ?? d.follow,
  };
}
