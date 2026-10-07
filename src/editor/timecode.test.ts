import { describe, expect, it } from "vitest";
import { needsHours, timecode } from "./timecode";

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
