import { describe, expect, it } from "vitest";
import type { SourceInfo } from "../shared/ipc";
import { fileInfo, formatDuration, formatRate, sourceFacts } from "./format";

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

describe("sourceFacts", () => {
  const base: SourceInfo = {
    id: "http://media.localhost/source/1",
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
    thumbs: null,
    waveUrl: null,
  };

  it("lists size, rate, length, codec and file size", () => {
    expect(sourceFacts(base)).toEqual([
      "1080 × 1920",
      "29.97 fps (variable)",
      "0:26",
      "H.264",
      "56.0 MB",
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

describe("fileInfo", () => {
  const file = (name: string, width: number, height: number, rateNum = 30): SourceInfo =>
    ({
      id: name,
      name,
      path: `C:\\v\\${name}`,
      url: "",
      framesUrl: "",
      bytes: 6e6,
      codec: "H.264",
      width,
      height,
      rotation: 0,
      rateNum,
      rateDen: 1,
      frames: 300,
      duration: 10,
      audioTracks: 1,
      variable: false,
      converted: false,
      thumbs: null,
      waveUrl: null,
    }) as SourceInfo;
  const a = file("a.mp4", 1920, 1080);
  const b = file("b.mp4", 720, 1280, 24);

  it("with nothing selected, gives the one file, or the project of several", () => {
    expect(fileInfo([a], [])).toMatchObject({ name: "a.mp4", facts: sourceFacts(a) });
    expect(fileInfo([a, b], [])).toEqual({
      name: "Project",
      title: "a.mp4\nb.mp4",
      facts: ["1920 × 1080", "30 fps", "2 files"],
    });
  });

  it("follows the selected clips' files, saying how another file is fitted and timed", () => {
    expect(fileInfo([a, b], [a]).name).toBe("a.mp4");
    expect(fileInfo([a, b], [a, a]).facts[0]).toBe("2 clips");
    const other = fileInfo([a, b], [b]).facts;
    expect(other).toContain("fitted into 1920 × 1080");
    expect(other).toContain("played at 30 fps");
    expect(fileInfo([a, b], [a, b, a])).toEqual({
      name: "3 clips from 2 files",
      title: "a.mp4\nb.mp4",
      facts: ["a.mp4, b.mp4"],
    });
  });
});
