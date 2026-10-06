// Approach A: a <video> element playing the source from media://, with
// requestVideoFrameCallback for which frame is on screen.
//
// `twin`: two elements taking turns at clip boundaries: the next clip's first frame is
// seeked to in the hidden one while the visible one plays.

import { type Clip, type Media, type Player, type Presented, type Shown, readBarcode } from "./common";

const SHOW_TIMEOUT = 5000;

function makeVideo(url: string): HTMLVideoElement {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.crossOrigin = "anonymous";
  v.src = url;
  return v;
}

/** Resolves on the next frame the element presents, or null after `ms`. */
function presented(v: HTMLVideoElement, ms = SHOW_TIMEOUT) {
  return new Promise<VideoFrameCallbackMetadata | null>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      resolve(null);
    }, ms);
    v.requestVideoFrameCallback((_now, meta) => {
      if (done) return;
      clearTimeout(timer);
      resolve(meta);
    });
  });
}

export class VideoPlayer implements Player {
  readonly el = document.createElement("div");
  private a: HTMLVideoElement;
  private b: HTMLVideoElement | null = null;
  private timeouts = 0;
  private error: string | null = null;

  constructor(
    private m: Media,
    private twin = false,
  ) {
    this.a = makeVideo(m.url);
    this.el.append(this.a);
    for (const v of [this.a]) v.onerror = () => (this.error = v.error?.message ?? "error");
    if (twin) {
      this.b = makeVideo(m.url);
      this.b.style.opacity = "0";
      this.el.append(this.b);
    }
  }

  private seekTime(n: number) {
    // The middle of the frame, so rounding can't land on a neighbour.
    return this.m.timeOf(n) + 0.5 / this.m.fps;
  }

  private read(v: HTMLVideoElement) {
    return this.m.entry.barcode ? readBarcode(v) : null;
  }

  async open() {
    const first = presented(this.a, 15000);
    const loaded = new Promise<void>((res, rej) => {
      this.a.addEventListener("loadeddata", () => res(), { once: true });
      this.a.addEventListener("error", () => rej(new Error(this.a.error?.message || "video error")), {
        once: true,
      });
    });
    await loaded;
    if (!(await first)) {
      // Some builds only present on the first seek.
      const meta = presented(this.a);
      this.a.currentTime = this.seekTime(0);
      if (!(await meta)) throw new Error("no frame presented");
    }
  }

  async show(n: number): Promise<Shown> {
    const v = this.a;
    const t0 = performance.now();
    const p = presented(v);
    v.currentTime = this.seekTime(n);
    const meta = await p;
    const ms = performance.now() - t0;
    if (!meta) {
      this.timeouts++;
      return { ms, n: -1, read: null, timedOut: true };
    }
    return { ms, n: this.m.frameAt(meta.mediaTime), read: this.read(v) };
  }

  async play(clips: Clip[], report: (p: Presented) => void): Promise<void> {
    return this.twin && this.b ? this.playTwin(clips, report) : this.playOne(clips, report);
  }

  private async playOne(clips: Clip[], report: (p: Presented) => void) {
    const v = this.a;
    await this.show(clips[0].in);
    let k = 0;
    await new Promise<void>((resolve) => {
      const total = clips.reduce((s, c) => s + c.out - c.in, 0);
      const guard = setTimeout(finish, (total / this.m.fps) * 2000 + 5000);
      function finish() {
        clearTimeout(guard);
        v.pause();
        resolve();
      }
      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        const n = this.m.frameAt(meta.mediaTime);
        report({ n, read: this.read(v), t: performance.now() });
        if (n >= clips[k].out - 1 && n < clips[k].out + 30) {
          k++;
          if (k >= clips.length) return finish();
          v.currentTime = this.seekTime(clips[k].in);
        }
        v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
      void v.play();
    });
  }

  private async playTwin(clips: Clip[], report: (p: Presented) => void) {
    let cur = this.a;
    let next = this.b!;
    // Prepare: current at clip 0, the other at clip 1.
    await this.show(clips[0].in);
    const prep = async (v: HTMLVideoElement, k: number) => {
      if (k >= clips.length) return;
      const p = presented(v);
      v.currentTime = this.seekTime(clips[k].in);
      await p;
    };
    await prep(next, 1);
    let k = 0;
    await new Promise<void>((resolve) => {
      const total = clips.reduce((s, c) => s + c.out - c.in, 0);
      const guard = setTimeout(finish, (total / this.m.fps) * 2000 + 5000);
      function finish() {
        clearTimeout(guard);
        cur.pause();
        next.pause();
        resolve();
      }
      const onFrame = (v: HTMLVideoElement) => (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (v !== cur) return;
        const n = this.m.frameAt(meta.mediaTime);
        report({ n, read: this.read(v), t: performance.now() });
        if (n >= clips[k].out - 1) {
          k++;
          if (k >= clips.length) return finish();
          // Swap: start the prepared one, show it, park the old one at the clip after.
          const old = cur;
          cur = next;
          next = old;
          void cur.play();
          cur.style.opacity = "1";
          old.style.opacity = "0";
          old.pause();
          // Its prepared frame is on screen now; rVFC won't fire for it.
          report({ n: clips[k].in, read: this.read(cur), t: performance.now() });
          cur.requestVideoFrameCallback(onFrame(cur));
          void prep(old, k + 1);
          return;
        }
        v.requestVideoFrameCallback(onFrame(v));
      };
      cur.requestVideoFrameCallback(onFrame(cur));
      void cur.play();
    });
    this.a.style.opacity = "1";
    this.b!.style.opacity = "0";
  }

  async close() {
    for (const v of [this.a, this.b]) {
      if (!v) continue;
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    this.el.remove();
  }

  notes() {
    const q = this.a.getVideoPlaybackQuality();
    return {
      timeouts: this.timeouts,
      error: this.error,
      droppedFrames: q.droppedVideoFrames,
      totalFrames: q.totalVideoFrames,
    };
  }
}
