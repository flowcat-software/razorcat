import { describe, expect, it } from "vitest";
import { needsHours, parseTimecode, timecode } from "./timecode";

describe("timecode", () => {
  it("counts frames within the second at a whole rate", () => {
    expect(timecode(0, 30, 1)).toBe("00:00.00");
    expect(timecode(29, 30, 1)).toBe("00:00.29");
    expect(timecode(30, 30, 1)).toBe("00:01.00");
    expect(timecode(30 * 75 + 4, 30, 1)).toBe("01:15.04");
  });

  it("keeps to the clock at 29.97", () => {
    // Second 1 starts at frame 30 (29.97 frames in), second 34 at frame 1019 (33.97 x 30).
    expect(timecode(29, 30000, 1001)).toBe("00:00.29");
    expect(timecode(30, 30000, 1001)).toBe("00:01.00");
    expect(timecode(1018, 30000, 1001)).toBe("00:33.28");
    expect(timecode(1019, 30000, 1001)).toBe("00:34.00");
  });

  it("goes past 60 minutes without hours, or shows them", () => {
    expect(timecode(60 * 61 * 30, 30, 1)).toBe("61:00.00");
    expect(timecode(60 * 61 * 30, 30, 1, true)).toBe("1:01:00.00");
    expect(timecode(0, 30, 1, true)).toBe("0:00:00.00");
  });
});

describe("needsHours", () => {
  it("is from an hour", () => {
    expect(needsHours(3600 * 30 - 1, 30, 1)).toBe(false);
    expect(needsHours(3600 * 30, 30, 1)).toBe(true);
  });
});

describe("parseTimecode", () => {
  it("reads back every frame the readout shows, at 30 and 29.97", () => {
    for (const [num, den] of [
      [30, 1],
      [30000, 1001],
      [24, 1],
    ]) {
      for (let n = 0; n < 4000; n += 7) {
        expect(parseTimecode(timecode(n, num, den), num, den)).toBe(n);
        expect(parseTimecode(timecode(n, num, den, true), num, den)).toBe(n);
      }
    }
  });

  it("takes frame numbers, whole seconds, and frames past the second", () => {
    expect(parseTimecode("45", 30, 1)).toBe(45);
    expect(parseTimecode(" 01:05 ", 30, 1)).toBe(65 * 30);
    expect(parseTimecode("00:01.45", 30, 1)).toBe(75);
    expect(parseTimecode("1:00:00.00", 30, 1)).toBe(108000);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "abc", "1:2:3:4", "01.15", "-3", "00:01.", ":05"]) {
      expect(parseTimecode(bad, 30, 1)).toBeNull();
    }
  });
});
