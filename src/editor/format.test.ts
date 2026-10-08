import { describe, expect, it } from "vitest";
import type { SourceInfo } from "../shared/ipc";
import { formatBytes, formatDuration, formatRate, sourceFacts } from "./format";

describe("formatRate", () => {
  it("drops trailing zeros and rounds NTSC rates", () => {
    expect(formatRate(30, 1)).toBe("30 fps");
    expect(formatRate(30000, 1001)).toBe("29.97 fps");
    expect(formatRate(24000, 1001)).toBe("23.98 fps");
    expect(formatRate(25, 2)).toBe("12.5 fps");
  });
});

describe("formatDuration", () => {
  it("is m:ss under an hour and h:mm:ss from one", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(232.67)).toBe("3:53");
    expect(formatDuration(1873.3)).toBe("31:13");
    expect(formatDuration(3723)).toBe("1:02:03");
  });
});

describe("formatBytes", () => {
  it("picks a unit", () => {
    expect(formatBytes(552_510_642)).toBe("553 MB");
    expect(formatBytes(5_902_612_343)).toBe("5.9 GB");
    expect(formatBytes(120)).toBe("1 KB");
  });
});

describe("sourceFacts", () => {
  const base: SourceInfo = {
    path: "D:\\obs\\IMG_2821.MOV",
    url: "http://media.localhost/source/1",
    framesUrl: "http://media.localhost/frames/1",
    proxyUrl: null,
    name: "IMG_2821.MOV",
    bytes: 58_731_362,
    codec: "H.264",
    width: 1080,
    height: 1920,
    rotation: 90,
    rateNum: 30000,
    rateDen: 1001,
    frames: 785,
    duration: 26.19,
    audioTracks: 1,
    variable: true,
    converted: false,
  };

  it("lists size, rate, length, codec and file size", () => {
    expect(sourceFacts(base)).toEqual([
      "1080 × 1920",
      "29.97 fps (variable)",
      "0:26",
      "H.264",
      "59 MB",
    ]);
  });

  it("says when the preview plays a converted copy", () => {
    expect(sourceFacts({ ...base, converted: true })).toContain("Converted to play here");
  });

  it("mentions audio only when it's unusual", () => {
    expect(sourceFacts({ ...base, audioTracks: 0 })).toContain("No audio");
    expect(sourceFacts({ ...base, audioTracks: 2 })).toContain("2 audio tracks");
  });
});
