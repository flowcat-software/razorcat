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
