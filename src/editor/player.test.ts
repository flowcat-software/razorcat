import { beforeAll, describe, expect, it, vi } from "vitest";
import { Player } from "./player";

/** Just enough of a `<video>` for the player to attach it. */
const fakeVideo = () =>
  ({
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback: () => 0,
    style: {},
    play: () => Promise.resolve(),
    pause() {},
  }) as unknown as HTMLVideoElement;

describe("the player's videos", () => {
  // The browser the player expects: frames never come, frame times never arrive.
  beforeAll(() => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("fetch", () => new Promise(() => {}));
  });

  // React runs the Preview's effects (attach) before the editor's (addSource): release builds
  // never played, as only StrictMode's second run in dev attached the video.
  it("attaches a video mounted before its file was added", () => {
    const player = new Player(30);
    const video = fakeVideo();
    player.attach("a", video);
    expect(player.originals()).toEqual([]);
    player.addSource("a", "frames-a");
    expect(player.originals()).toEqual([video]);
  });

  it("forgets a video unmounted before its file was added", () => {
    const player = new Player(30);
    player.attach("a", fakeVideo());
    player.attach("a", null);
    player.addSource("a", "frames-a");
    expect(player.originals()).toEqual([]);
  });
});

describe("the player's frames at another speed", () => {
  beforeAll(() => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("fetch", () => new Promise(() => {}));
  });

  // A clip's frames are its source's at its speed (speed.ts): the player shows the source frame.
  it("shows each timeline frame's source frame", () => {
    const player = new Player(30);
    player.setEdit({
      clips: [
        { source: "a", in: 0, out: 10 },
        { source: "a", in: 50, out: 60, speed: { num: 2, den: 1 } },
        { source: "a", in: 0, out: 6, speed: { num: 1, den: 3 }, phase: 1 },
      ],
      muted: false,
    });
    expect(player.frames).toBe(26);
    expect([9, 10, 11, 19].map((t) => player.sourceFrame(t))).toEqual([9, 100, 102, 118]);
    // At a third, phase 1: floor((v + 1) / 3).
    expect([20, 21, 22, 23, 25].map((t) => player.sourceFrame(t))).toEqual([0, 0, 1, 1, 2]);
  });

  it("shows a reversed clip's frames back to front", () => {
    const player = new Player(30);
    // Source frames 300 to 309 of 1000, backward: stream frames 690 to 699.
    player.setEdit({ clips: [{ source: "a", in: 690, out: 700, mirror: 1000 }], muted: false });
    expect([0, 1, 9].map((t) => player.sourceFrame(t))).toEqual([309, 308, 300]);
  });
});
