// The player: the open source's `<video>`, driven in timeline frames, with its proxy.
//
// The playhead is a timeline frame. The edit (`setEdit`: the document's clips) maps it to a
// source grid frame: frame t in a clip starting at `start` is source frame `in + t - start`.
// Showing frame t seeks the original to the middle of that source frame's picture
// (`FrameTimes.seek`), so it lands on exactly that picture; while playing, each picture the
// original presents (`requestVideoFrameCallback`) moves the playhead to the frame showing it. At a
// clip's last frame, playing pauses, seeks to the next clip's first and plays on, so nothing cut
// out ever shows.
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
//
// Some frames the original can't show by seeking: in open-GOP video (x265's default), the few
// frames before a keyframe are decoded after it, and WebView2's decoder, seeking there, starts at
// the keyframe and shows that instead (the frame check, frameCheck.ts, found them). When the
// original settles on another picture than the playhead's, the proxy, which has every frame,
// shows instead.

import { frameAt, parseFrameTimes, type FrameTimes } from "./frameTimes";

export interface PlayerState {
  /** The playhead: the timeline frame shown (or being sought to). */
  frame: number;
  /** Playing speed: 0 paused, 1 forward, 2/4/8 faster (L again), negative backward (J). */
  speed: number;
}

/** A clip as played: where it starts on the timeline, and the source frames it shows. */
interface Span {
  start: number;
  in: number;
  out: number;
}

/** The speeds J and L step through. */
const FASTEST = 8;
/** How long the original may stay on another picture after a seek before the proxy covers it. */
const SETTLE_MS = 150;

/** One `<video>` and its seeks, coalesced; and the time of the picture it has on screen. */
class Seeker {
  private seeking = false;
  private queued: number | null = null;
  /** The media time of the picture on screen; NaN before the first. */
  shownTime = NaN;
  /** When the last seek finished (`performance.now()`). */
  settledAt = 0;
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
    else {
      this.settledAt = performance.now();
      this.changed();
    }
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
  /** The edit: the clips in timeline order. */
  private spans: Span[];
  private length: number;
  /** Playing forward: the clip playing. */
  private playing = 0;
  /** Playing forward, at a cut: the seek to the next clip is under way; play on once it's done. */
  private crossing = false;

  constructor(
    /** The source's grid frames. */
    sourceFrames: number,
    /** Frames per second. */
    readonly fps: number,
    private readonly framesUrl: string,
  ) {
    this.spans = [{ start: 0, in: 0, out: sourceFrames }];
    this.length = sourceFrames;
  }

  /** The timeline's length, in frames. */
  get frames() {
    return this.length;
  }

  /** The edit changed: plays its clips from now on (pausing, and keeping the playhead in it). */
  setEdit(clips: readonly { in: number; out: number }[]) {
    let start = 0;
    this.spans = clips.map((c) => {
      const span = { start, in: c.in, out: c.out };
      start += c.out - c.in;
      return span;
    });
    this.length = start;
    this.stop();
    this.set({ frame: this.clamp(this.state.frame) });
    this.listeners.forEach((fn) => fn());
    this.show(this.state.frame);
  }

  /** The clip under timeline frame `t` (clamped to the timeline). */
  private spanIndex(t: number) {
    let i = 0;
    while (
      i < this.spans.length - 1 &&
      t >= this.spans[i].start + this.spans[i].out - this.spans[i].in
    )
      i++;
    return i;
  }

  /** The source grid frame at timeline frame `t`. */
  sourceFrame(t: number) {
    const span = this.spans[this.spanIndex(t)];
    return Math.min(span.out - 1, span.in + Math.max(0, t - span.start));
  }

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
      this.playing = this.spanIndex(this.state.frame);
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
    this.crossing = false;
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
    this.original?.seek(this.times.seek[this.sourceFrame(n)]);
    this.showProxy(n);
  }

  private showProxy(n: number) {
    const p = this.proxy;
    if (!p) return;
    // The proxy can end a frame short of the grid.
    const f = this.sourceFrame(n);
    const last = Number.isFinite(p.video.duration) ? this.proxyFrame(p.video.duration) - 1 : f;
    p.seek((Math.min(f, last) + 0.5) / this.fps);
    this.paint();
  }

  /**
   * The proxy frame starting at time `t` (proxy frame k starts at k / fps). Rounded to the
   * nearest: the video reports times to the microsecond, so frame 1 at 30 fps is 0.033333 s,
   * a hair before 1 / 30.
   */
  private proxyFrame(t: number) {
    return Math.round(t * this.fps);
  }

  /** Whether the original has the playhead's picture on screen. */
  private originalShowsFrame() {
    const o = this.original;
    if (!o || !this.times || o.busy) return false;
    return Math.abs(o.shownTime - this.times.start[this.sourceFrame(this.state.frame)]) < 1e-3;
  }

  /** The original has finished seeking a while ago, and shows another picture than the playhead's. */
  private originalMissed() {
    const o = this.original;
    if (!o || !this.times || o.busy) return false;
    return performance.now() - o.settledAt >= SETTLE_MS && !this.originalShowsFrame();
  }

  /**
   * Puts the proxy on top while it's nearer the playhead than the original; after a single step
   * (held), only if the original can't show the frame.
   */
  private paint = () => {
    const p = this.proxy;
    if (!p) return;
    const proxyShowsFrame =
      !p.busy && this.proxyFrame(p.shownTime) === this.sourceFrame(this.state.frame);
    let on: boolean;
    if (this.state.speed > 0 || this.originalShowsFrame()) on = false;
    else if (proxyShowsFrame && (!this.proxyHeld || this.originalMissed())) on = true;
    else if (this.proxyHeld) on = false;
    else return;
    p.video.style.visibility = on ? "visible" : "hidden";
  };

  private onOriginal = (meta?: VideoFrameCallbackMetadata) => {
    if (meta && this.times) {
      if (this.state.speed > 0) this.played(meta.mediaTime);
      else if (import.meta.env.DEV && !this.original?.busy && this.state.speed === 0) {
        this.check(meta);
      }
    }
    if (!meta && this.crossing && this.state.speed > 0) {
      // At a cut: the next clip's first picture is ready; play on.
      this.crossing = false;
      void this.original?.video.play().catch((e: unknown) => {
        console.error("[player] play:", e);
        this.stop();
      });
    }
    // A seek finished: if the original is still on another picture once it's settled, the proxy
    // covers it.
    if (!meta) setTimeout(() => !this.gone && this.paint(), SETTLE_MS);
    this.paint();
  };

  /**
   * Playing forward, the original presented the picture at `time`: the playhead follows it, and
   * at the clip's last frame (or past it, playing fast), playing moves to the next clip.
   */
  private played(time: number) {
    if (this.crossing || !this.times) return;
    const span = this.spans[this.playing];
    const s = frameAt(this.times.start, time);
    if (s >= span.in && s < span.out) this.set({ frame: span.start + s - span.in });
    // The picture covers the clip's last frame (a picture can cover several, VFR).
    if (time >= this.times.start[span.out - 1] - 1e-3) this.cut();
  }

  /** Playing reached the end of a clip: on to the next one, or stop at the timeline's end. */
  private cut() {
    const o = this.original;
    const next = this.spans[this.playing + 1];
    if (!o || !this.times) return;
    o.video.pause();
    if (!next) {
      this.stop();
      this.set({ frame: this.frames - 1 });
      return;
    }
    this.playing++;
    this.crossing = true;
    o.seek(this.times.seek[next.in]);
  }

  // --- development: the preview = export check (frameCheck.ts) ---

  /** Which video is on top with the playhead's frame, if either is yet. */
  onScreen(): "original" | "proxy" | null {
    if (this.originalShowsFrame()) return "original";
    const p = this.proxy;
    return p?.video.style.visibility === "visible" && this.shows("proxy") ? "proxy" : null;
  }

  /** Whether `which` video has the playhead's frame on screen, its seeks done. */
  shows(which: "original" | "proxy") {
    if (which === "original") return this.originalShowsFrame();
    const p = this.proxy;
    return !!p && !p.busy && this.proxyFrame(p.shownTime) === this.sourceFrame(this.state.frame);
  }

  video(which: "original" | "proxy") {
    return (which === "original" ? this.original : this.proxy)?.video;
  }

  /** The original: the time of the picture on screen, the one wanted, and whether it's seeking. */
  originalTimes() {
    return {
      shown: this.original?.shownTime,
      want: this.times?.start[this.sourceFrame(this.state.frame)],
      seeking: this.original?.busy,
    };
  }

  /** The source ran out while playing (a clip that ends where the source does). */
  private onEnded = () => {
    if (this.state.speed > 0 && !this.crossing) this.cut();
    this.paint();
  };

  /** Development: paused, the original's picture must be the playhead's. */
  private check(meta: VideoFrameCallbackMetadata) {
    const want = this.times!.start[this.sourceFrame(this.state.frame)];
    if (Math.abs(meta.mediaTime - want) > 1e-3) {
      console.warn(
        `[player] frame ${this.state.frame} wants the picture at ${want.toFixed(6)} s; ` +
          `showing ${meta.mediaTime.toFixed(6)} s`,
      );
    }
  }
}
