// The README's Keyboard reference lists every shortcut Settings › Keyboard shortcuts does
// (src/settings/fixedShortcuts.ts), so the two can't drift apart.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as fixed from "../src/settings/fixedShortcuts.ts";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("the README's Keyboard reference", () => {
  it("has every fixed shortcut Settings lists", () => {
    const entries = Object.values(fixed).filter(Array.isArray).flat();
    expect(entries.length).toBeGreaterThan(50);
    // A table row ending in what it does (Prettier pads the cells).
    const missing = entries.filter(
      (e) => !new RegExp(`\\|\\s*${escape(e.what)}\\s*\\|`).test(README),
    );
    expect(missing.map((e) => e.what)).toEqual([]);
  });
});
