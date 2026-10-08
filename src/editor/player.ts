// The player: the open source's `<video>`, driven in timeline frames, with its proxy.
//
// The playhead is a timeline frame. Showing frame n seeks the original to the middle of n's
// picture (`FrameTimes.seek`), so it lands on exactly that picture; while playing, each picture
// the original presents (`requestVideoFrameCallback`) moves the playhead to the frame showing it.
// Seeks are coalesced: while one is under way, only the latest target waits, so holding an arrow
// key never queues up a backlog.
//
// Once the proxy is ready (proxy.rs: small, a keyframe every 10 frames, proxy frame k is
// timeline frame k), seeking seeks both. The proxy shows on top until the original has the same
// frame on screen, then the original's full-quality picture takes over. A single step skips the
// proxy (the original's next frame is quick, and the swap would show as a flicker); a held arrow
// key, a jump and scrubbing use it. Playing uses the
// original; playing backward (which `<video>` can't) seeks frame after frame, on the proxy when
// there is one.

import { frameAt, parseFrameTimes, type FrameTimes } from "./frameTimes";

export interface PlayerState {
  /** The playhead: the timeline frame shown (or being sought to). */
  frame: number;
  /** Playing speed: 0 paused, 1 forward, 2/4/8 faster (L again), negative backward (J). */
  speed: number;
}

/** The speeds J and L step through. */
const FASTEST = 8;

/** One `<video>` and its seeks, coalesced; and the time of the picture it has on screen. */
class Seeker {
  private seeking = false;
  private queued: number | null = null;
  /** The media time of the picture on screen; NaN before the first. */
  shownTime = NaN;
  private gone = false;

  constructor(
    readonly video: HTMLVideoElement,
    /** Each picture presented, and each seek finished. */
    private readonly changed: (meta?: VideoFrameCallbackMetadata) => void,
  ) {
    video.addEventListener("seeked", this.onSeeked);
    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (this.gone) return;
      this.shownTime = meta.mediaTime;
      this.changed(meta);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  get busy() {
    return this.seeking;
  }

  seek(time: number) {
    if (this.seeking) {
      this.queued = time;
      return;
    }
    this.seeking = true;
    this.video.currentTime = time;
  }

  private onSeeked = () => {
    this.seeking = false;
    const t = this.queued;
    this.queued = null;
    if (t !== null) this.seek(t);
    else this.changed();
  };

  detach() {
    this.gone = true;
    this.video.removeEventListener("seeked", this.onSeeked);
  }
}

export class Player {
  private state: PlayerState = { frame: 0, speed: 0 };
  private readonly listeners = new Set<() => void>();
  private times: FrameTimes | null = null;
  private original: Seeker | null = null;
  private proxy: Seeker | null = null;
  private backward = 0;
  /** The last seek skipped the proxy: it stays hidden. */
  private proxyHeld = false;
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

  /** The original's `<video>`, as React mounts it (null as it unmounts). */
  attach(video: HTMLVideoElement | null) {
    if (video === (this.original?.video ?? null)) return;
    if (this.original) {
      this.stop();
      this.original.video.removeEventListener("ended", this.onEnded);
      this.original.detach();
    }
    this.original = video && new Seeker(video, this.onOriginal);
    video?.addEventListener("ended", this.onEnded);
    this.show(this.state.frame);
  }

  /** The proxy's `<video>`, once there is one. */
  attachProxy(video: HTMLVideoElement | null) {
    if (video === (this.proxy?.video ?? null)) return;
    this.proxy?.detach();
    this.proxy = video && new Seeker(video, this.paint);
    if (video) video.style.visibility = "hidden";
    this.showProxy(this.state.frame);
  }

  // --- transport ---

  /**
   * Moves the playhead to frame `n` (clamped) and shows it, pausing first. `useProxy` false:
   * the picture waits for the original's frame.
   */
  seek(n: number, useProxy = true) {
    this.stop();
    this.set({ frame: this.clamp(n) });
    this.proxyHeld = !useProxy;
    if (this.proxyHeld && this.proxy) this.proxy.video.style.visibility = "hidden";
    this.show(this.state.frame);
  }

  /** Steps `by` frames: on the original alone unless `useProxy` (a held key). */
  step(by: number, useProxy = false) {
    this.seek(this.state.frame + by, useProxy);
  }

  /** Space: play forward from the playhead (from the start if it's at the end), or pause. */
  toggle() {
    if (this.state.speed !== 0) this.pause();
    else this.play(1);
  }

  pause() {
    if (this.state.speed === 0) return;
    this.stop();
    // Settle on the frame that was on screen, exactly (it's the original's already).
    this.seek(this.state.frame, false);
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
    const v = this.original?.video;
    if (!v) return;
    this.stop();
    if (speed > 0) {
      if (this.state.frame >= this.frames - 1) this.seek(0);
      v.playbackRate = speed;
      this.set({ speed });
      this.paint();
      void v.play().catch((e: unknown) => {
        console.error("[player] play:", e);
        this.set({ speed: 0 });
      });
      return;
    }
    if (this.state.frame <= 0) return;
    this.set({ speed });
    this.proxyHeld = false;
    const from = this.state.frame;
    const t0 = performance.now();
    const tick = (now: number) => {
      const n = Math.max(0, from - Math.round(((now - t0) / 1000) * this.fps * -speed));
      this.set({ frame: n });
      // The proxy alone, if there is one: the original catches up when it stops.
      if (this.proxy) this.showProxy(n);
      else this.show(n);
      if (n === 0) this.pause();
      else this.backward = requestAnimationFrame(tick);
    };
    this.backward = requestAnimationFrame(tick);
  }

  /** Stops playing, either way, leaving the playhead where it is. */
  private stop() {
    cancelAnimationFrame(this.backward);
    this.backward = 0;
    const v = this.original?.video;
    if (v && !v.paused) v.pause();
    this.set({ speed: 0 });
  }

  private clamp(n: number) {
    return Math.max(0, Math.min(this.frames - 1, Math.round(n)));
  }

  // --- the videos ---

  /** Seeks the original, and the proxy if there is one, to frame `n`. */
  private show(n: number) {
    if (!this.times) return;
    this.original?.seek(this.times.seek[n]);
    this.showProxy(n);
  }

  private showProxy(n: number) {
    const p = this.proxy;
    if (!p) return;
    // The proxy can end a frame short of the grid.
    const last = Number.isFinite(p.video.duration)
      ? Math.floor(p.video.duration * this.fps - 0.5)
      : n;
    p.seek((Math.min(n, last) + 0.5) / this.fps);
    this.paint();
  }

  /** Whether the original has the playhead's picture on screen. */
  private originalShowsFrame() {
    const o = this.original;
    if (!o || !this.times || o.busy) return false;
    return Math.abs(o.shownTime - this.times.start[this.state.frame]) < 1e-3;
  }

  /** Puts the proxy on top while it's nearer the playhead than the original. */
  private paint = () => {
    const p = this.proxy;
    if (!p) return;
    const k = Math.round(p.shownTime * this.fps - 0.5);
    const proxyShowsFrame = !p.busy && k === this.state.frame;
    let on: boolean;
    if (this.state.speed > 0 || this.proxyHeld || this.originalShowsFrame()) on = false;
    else if (proxyShowsFrame) on = true;
    else return;
    p.video.style.visibility = on ? "visible" : "hidden";
  };

  private onOriginal = (meta?: VideoFrameCallbackMetadata) => {
    if (meta && this.times) {
      const n = frameAt(this.times.start, meta.mediaTime);
      if (this.state.speed > 0) this.set({ frame: n });
      else if (import.meta.env.DEV && !this.original?.busy && this.state.speed === 0) {
        this.check(meta);
      }
    }
    this.paint();
  };

  private onEnded = () => {
    this.stop();
    this.set({ frame: this.frames - 1 });
    this.paint();
  };

  /** Development: paused, the original's picture must be the playhead's. */
  private check(meta: VideoFrameCallbackMetadata) {
    const want = this.times!.start[this.state.frame];
    if (Math.abs(meta.mediaTime - want) > 1e-3) {
      console.warn(
        `[player] frame ${this.state.frame} wants the picture at ${want.toFixed(6)} s; ` +
          `showing ${meta.mediaTime.toFixed(6)} s`,
      );
    }
  }
}
