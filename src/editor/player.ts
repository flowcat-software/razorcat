// The player: the open source's `<video>`, driven in timeline frames.
//
// The playhead is a timeline frame. Showing frame n seeks the video to the middle of n's picture
// (`FrameTimes.seek`), so it lands on exactly that picture; while playing, each picture the video
// presents (`requestVideoFrameCallback`) moves the playhead to the frame showing it. Seeks are
// coalesced: while one is under way, only the latest target waits, so holding an arrow key never
// queues up a backlog. The video can't play backward, so J does it by seeking frame after frame.

import { frameAt, parseFrameTimes, type FrameTimes } from "./frameTimes";

export interface PlayerState {
  /** The playhead: the timeline frame shown (or being sought to). */
  frame: number;
  /**
   * Playing speed: 0 paused, 1 forward, 2/4/8 faster (L again), negative backward (J). Backward
   * is choppy on long recordings until the proxy comes (1.5).
   */
  speed: number;
}

/** The speeds J and L step through. */
const FASTEST = 8;

export class Player {
  private state: PlayerState = { frame: 0, speed: 0 };
  private readonly listeners = new Set<() => void>();
  private video: HTMLVideoElement | null = null;
  private times: FrameTimes | null = null;
  /** A seek under way, and the frame waiting to be sought to after it. */
  private seeking = false;
  private queued: number | null = null;
  /** The frame on screen, from the last presented picture; -1 before the first. */
  private shown = -1;
  private backward = 0;
  private gone = false;

  constructor(
    readonly frames: number,
    /** Frames per second. */
    readonly fps: number,
    private readonly framesUrl: string,
  ) {}

  /** Starts (or, after `close`, restarts: StrictMode mounts twice): reads the frame times. */
  open() {
    this.gone = false;
    if (this.times) return;
    fetch(this.framesUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.arrayBuffer();
      })
      .then((bytes) => {
        if (this.gone || this.times) return;
        this.times = parseFrameTimes(bytes);
        this.show(this.state.frame);
      })
      .catch((e: unknown) => console.error("[player] frame times:", e));
  }

  close() {
    this.gone = true;
    this.stop();
  }

  // --- for React (useSyncExternalStore) ---

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = () => this.state;

  private set(next: Partial<PlayerState>) {
    const s = { ...this.state, ...next };
    if (s.frame === this.state.frame && s.speed === this.state.speed) return;
    this.state = s;
    this.listeners.forEach((fn) => fn());
  }

  /** The `<video>` element, as React mounts it (null as it unmounts). */
  attach = (video: HTMLVideoElement | null) => {
    if (video === this.video) return;
    const old = this.video;
    if (old) {
      this.stop();
      old.removeEventListener("seeked", this.onSeeked);
      old.removeEventListener("ended", this.onEnded);
    }
    this.video = video;
    this.seeking = false;
    this.queued = null;
    if (!video) return;
    video.addEventListener("seeked", this.onSeeked);
    video.addEventListener("ended", this.onEnded);
    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      // A replaced element stops here.
      if (this.video !== video) return;
      this.presented(meta);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    this.show(this.state.frame);
  };

  // --- transport ---

  /** Moves the playhead to frame `n` (clamped) and shows it, pausing first. */
  seek(n: number) {
    this.stop();
    this.set({ frame: this.clamp(n) });
    this.show(this.state.frame);
  }

  step(by: number) {
    this.seek(this.state.frame + by);
  }

  /** Space: play forward from the playhead (from the start if it's at the end), or pause. */
  toggle() {
    if (this.state.speed !== 0) this.pause();
    else this.play(1);
  }

  pause() {
    if (this.state.speed === 0) return;
    this.stop();
    // Settle on the frame that was on screen, exactly.
    this.seek(this.state.frame);
  }

  /** L: play forward, faster each time. */
  faster() {
    const s = this.state.speed;
    this.play(s > 0 ? Math.min(FASTEST, s * 2) : 1);
  }

  /** J: play backward, faster each time. */
  slower() {
    const s = this.state.speed;
    this.play(s < 0 ? Math.max(-FASTEST, s * 2) : -1);
  }

  private play(speed: number) {
    const v = this.video;
    if (!v) return;
    const last = this.frames - 1;
    this.stop();
    if (speed > 0) {
      if (this.state.frame >= last) this.seek(0);
      v.playbackRate = speed;
      this.set({ speed });
      void v.play().catch((e: unknown) => {
        console.error("[player] play:", e);
        this.set({ speed: 0 });
      });
    } else {
      if (this.state.frame <= 0) return;
      this.set({ speed });
      const from = this.state.frame;
      const t0 = performance.now();
      const tick = (now: number) => {
        const n = Math.max(0, from - Math.round(((now - t0) / 1000) * this.fps * -speed));
        this.set({ frame: n });
        this.show(n);
        if (n === 0) {
          this.backward = 0;
          this.set({ speed: 0 });
        } else {
          this.backward = requestAnimationFrame(tick);
        }
      };
      this.backward = requestAnimationFrame(tick);
    }
  }

  /** Stops playing, either way, leaving the playhead where it is. */
  private stop() {
    cancelAnimationFrame(this.backward);
    this.backward = 0;
    if (this.video && !this.video.paused) this.video.pause();
    this.set({ speed: 0 });
  }

  private clamp(n: number) {
    return Math.max(0, Math.min(this.frames - 1, Math.round(n)));
  }

  // --- the video ---

  /** Seeks the video to frame `n`'s picture, or queues it behind the seek under way. */
  private show(n: number) {
    const v = this.video;
    if (!v || !this.times) return;
    if (this.seeking) {
      this.queued = n;
      return;
    }
    this.seeking = true;
    v.currentTime = this.times.seek[n];
  }

  private onSeeked = () => {
    this.seeking = false;
    const n = this.queued;
    this.queued = null;
    if (n !== null) this.show(n);
  };

  private onEnded = () => {
    this.stop();
    this.set({ frame: this.frames - 1 });
  };

  /** Every picture the video presents: while playing forward, it moves the playhead. */
  private presented(meta: VideoFrameCallbackMetadata) {
    if (!this.times) return;
    this.shown = frameAt(this.times.start, meta.mediaTime);
    if (this.state.speed > 0) this.set({ frame: this.shown });
    else if (import.meta.env.DEV && !this.seeking && this.state.speed === 0) this.check(meta);
  }

  /** Development: paused, the picture on screen must be the playhead's. */
  private check(meta: VideoFrameCallbackMetadata) {
    const want = this.times!.start[this.state.frame];
    if (Math.abs(meta.mediaTime - want) > 1e-3) {
      console.warn(
        `[player] frame ${this.state.frame} wants the picture at ${want.toFixed(6)} s; ` +
          `showing ${meta.mediaTime.toFixed(6)} s`,
      );
    }
  }

  /** The frame whose picture is on screen (tests and checks). */
  get shownFrame() {
    return this.shown;
  }
}
