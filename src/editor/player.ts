// The player: the timeline's sources' `<video>`s, driven in timeline frames, with their proxies.
//
// The playhead is a timeline frame. The edit (`setEdit`: the document's clips) maps it to a
// source and a grid frame of it: frame t in a clip starting at `start` is frame `in + t - start`
// of the clip's source. Each source is a deck: its original's `<video>`, its proxy's, and its
// frame times (PLAN 4.5e). The deck of the playhead's clip is on screen (`PlayerState.source`:
// Preview.tsx shows only it); the others wait, hidden.
//
// Showing frame t seeks its deck's original to the middle of that source frame's picture
// (`FrameTimes.seek`), so it lands on exactly that picture; while playing, each picture the
// original presents (`requestVideoFrameCallback`) moves the playhead to the frame showing it. At a
// clip's last frame, playing pauses, seeks to the next clip's first and plays on, so nothing cut
// out ever shows. When the next clip is another source's, its deck was sought there while this
// clip played, so at the cut it only has to be shown and played.
// Seeks are coalesced: while one is under way, only the latest target waits, so holding an arrow
// key never queues up a backlog.
//
// Once a deck's proxy is ready (proxy.rs: small, a keyframe every 10 frames, proxy frame k is
// grid frame k), seeking seeks both. The proxy shows on top until the original has the same
// frame on screen, then the original's full-quality picture takes over. A single step skips the
// proxy (the original's next frame is quick, and the swap would show as a flicker); a held arrow
// key, a jump and scrubbing use it. Playing uses the
// original; playing backward (which `<video>` can't) seeks frame after frame, on the proxy when
// there is one. A muted clip (or track) plays with the original muted; the proxy always is.
//
// Some frames the original can't show by seeking: in open-GOP video (x265's default), the few
// frames before a keyframe are decoded after it, and WebView2's decoder, seeking there, starts at
// the keyframe and shows that instead (the frame check, frameCheck.ts, found them). When the
// original settles on another picture than the playhead's, the proxy, which has every frame,
// shows instead.

import type { SourceId } from "./doc";
import { frameAt, parseFrameTimes, type FrameTimes } from "./frameTimes";

export interface PlayerState {
  /** The playhead: the timeline frame shown (or being sought to). */
  frame: number;
  /** Playing speed: 0 paused, 1 forward, 2/4/8 faster (L again), negative backward (J). */
  speed: number;
  /** The source on screen: the playhead's clip's (or the one peeked at). */
  source: SourceId | null;
}

/** A clip as played: where it starts on the timeline, and the source frames it shows. */
interface Span {
  start: number;
  source: SourceId;
  in: number;
  out: number;
  /** Silent (the clip's mute, or the track's). */
  muted: boolean;
}

/** A source's videos and frame times. */
interface Deck {
  id: SourceId;
  framesUrl: string;
  times: FrameTimes | null;
  original: Seeker | null;
  proxy: Seeker | null;
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
  private state: PlayerState = { frame: 0, speed: 0, source: null };
  private readonly listeners = new Set<() => void>();
  private readonly decks = new Map<SourceId, Deck>();
  private backward = 0;
  /** The last seek skipped the proxy: it stays hidden. */
  private proxyHeld = false;
  private gone = false;
  /** The edit: the clips in timeline order. */
  private spans: Span[] = [];
  private length = 0;
  /** Playing forward: the clip playing. */
  private playing = 0;
  /** Playing forward, at a cut: the seek to the next clip is under way; play on once it's done. */
  private crossing = false;
  /** A source frame shown instead of the playhead's (a trim shows the frame under its handle). */
  private peeked: { source: SourceId; frame: number } | null = null;
  /** The edit's mutes (the track's, then each clip's), to tell a mute alone from an edit. */
  private mutes = "";

  constructor(
    /** Frames per second: the timeline's. */
    readonly fps: number,
  ) {}

  /** The timeline's length, in frames. */
  get frames() {
    return this.length;
  }

  /** A source the edit may show: its frame times are read now (if the player's open). */
  addSource(id: SourceId, framesUrl: string) {
    if (this.decks.has(id)) return;
    this.decks.set(id, { id, framesUrl, times: null, original: null, proxy: null });
    if (!this.gone) this.readTimes(id);
  }

  /**
   * The edit changed: plays its clips from now on (pausing, and keeping the playhead in it). A
   * mute alone doesn't pause: the sound goes or comes back as it plays.
   */
  setEdit(edit: {
    clips: readonly { source: SourceId; in: number; out: number; muted?: boolean }[];
    muted: boolean;
  }) {
    const mutes = [edit.muted, ...edit.clips.map((c) => !!c.muted)].join();
    const onlyMuted =
      mutes !== this.mutes &&
      edit.clips.length === this.spans.length &&
      edit.clips.every((c, i) => {
        const s = this.spans[i];
        return c.source === s.source && c.in === s.in && c.out === s.out;
      });
    this.mutes = mutes;
    if (onlyMuted) {
      edit.clips.forEach((c, i) => (this.spans[i].muted = edit.muted || !!c.muted));
      const v = this.deckOf(this.spans[this.playing])?.original?.video;
      if (v && this.state.speed > 0) v.muted = this.spans[this.playing].muted;
      return;
    }
    let start = 0;
    this.spans = edit.clips.map((c) => {
      const span = {
        start,
        source: c.source,
        in: c.in,
        out: c.out,
        muted: edit.muted || !!c.muted,
      };
      start += c.out - c.in;
      return span;
    });
    this.length = start;
    this.stop();
    this.set({ frame: this.clamp(this.state.frame) });
    this.listeners.forEach((fn) => fn());
    this.show(this.state.frame);
  }

  /**
   * How loud the sound plays, 0 to 1 (a clip's fades, PLAN 4.7a, ramp it with the picture). A
   * muted clip stays silent.
   */
  setLevel(level: number) {
    for (const d of this.decks.values()) if (d.original) d.original.video.volume = level;
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

  private deckOf(span: Span | undefined) {
    return span && this.decks.get(span.source);
  }

  /** The source grid frame at timeline frame `t`, of the clip's source there. */
  sourceFrame(t: number) {
    const span = this.spans[this.spanIndex(t)];
    if (!span) return 0;
    return Math.min(span.out - 1, span.in + Math.max(0, t - span.start));
  }

  /** The source and its frame to show for timeline frame `t`: the playhead's, unless peeked. */
  private target(t: number): { source: SourceId; frame: number } | null {
    if (this.peeked) return this.peeked;
    const span = this.spans[this.spanIndex(t)];
    return span ? { source: span.source, frame: this.sourceFrame(t) } : null;
  }

  /**
   * Shows frame `f` of `source` without moving the playhead (paused; the proxy keeps up), until
   * `peek(null)` goes back to the playhead's frame.
   */
  peek(f: number | null, source?: SourceId) {
    const next = f === null || source === undefined ? null : { source, frame: f };
    if (next?.source === this.peeked?.source && next?.frame === this.peeked?.frame) return;
    this.stop();
    this.peeked = next;
    this.proxyHeld = false;
    this.show(this.state.frame);
  }

  /** Shows what's at timeline frame `t` without moving the playhead (`peek`). */
  peekAt(t: number) {
    const span = this.spans[this.spanIndex(t)];
    if (span) this.peek(this.sourceFrame(t), span.source);
  }

  /** Starts (or, after `close`, restarts: StrictMode mounts twice): reads the frame times. */
  open() {
    this.gone = false;
    for (const id of this.decks.keys()) this.readTimes(id);
  }

  private readTimes(id: SourceId) {
    const deck = this.decks.get(id);
    if (!deck || deck.times) return;
    fetch(deck.framesUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.arrayBuffer();
      })
      .then((bytes) => {
        if (this.gone || deck.times) return;
        deck.times = parseFrameTimes(bytes);
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
    if (
      s.frame === this.state.frame &&
      s.speed === this.state.speed &&
      s.source === this.state.source
    )
      return;
    // Another file on screen: the others' proxies go, or one left showing would stay over it
    // (its deck is hidden, but a child shown in a hidden parent still shows).
    if (s.source !== this.state.source) {
      for (const deck of this.decks.values()) {
        if (deck.id !== s.source && deck.proxy) deck.proxy.video.style.visibility = "hidden";
      }
    }
    this.state = s;
    this.listeners.forEach((fn) => fn());
  }

  /** Source `id`'s original `<video>`, as React mounts it (null as it unmounts). */
  attach(id: SourceId, video: HTMLVideoElement | null) {
    const deck = this.decks.get(id);
    if (!deck || video === (deck.original?.video ?? null)) return;
    if (deck.original) {
      if (this.onScreenDeck() === deck) this.stop();
      deck.original.video.removeEventListener("ended", this.onEnded);
      deck.original.detach();
    }
    deck.original = video && new Seeker(video, (meta) => this.onOriginal(deck, meta));
    video?.addEventListener("ended", this.onEnded);
    this.show(this.state.frame);
  }

  /** Source `id`'s proxy `<video>`, once there is one. */
  attachProxy(id: SourceId, video: HTMLVideoElement | null) {
    const deck = this.decks.get(id);
    if (!deck || video === (deck.proxy?.video ?? null)) return;
    deck.proxy?.detach();
    deck.proxy = video && new Seeker(video, this.paint);
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
    this.peeked = null;
    this.set({ frame: this.clamp(n) });
    this.proxyHeld = !useProxy;
    const proxy = this.onScreenDeck()?.proxy;
    if (this.proxyHeld && proxy) proxy.video.style.visibility = "hidden";
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
    this.stop();
    if (this.peeked !== null) {
      this.peeked = null;
      this.show(this.state.frame);
    }
    if (speed > 0) {
      if (this.state.frame >= this.frames - 1) this.seek(0);
      this.playing = this.spanIndex(this.state.frame);
      const span = this.spans[this.playing];
      const v = this.deckOf(span)?.original?.video;
      if (!span || !v) return;
      v.muted = span.muted;
      v.playbackRate = speed;
      this.set({ speed });
      this.paint();
      this.preload();
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
      if (this.deckOf(this.spans[this.spanIndex(n)])?.proxy) this.showProxy(n);
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
    for (const deck of this.decks.values()) {
      const v = deck.original?.video;
      if (v && !v.paused) v.pause();
    }
    this.set({ speed: 0 });
  }

  private clamp(n: number) {
    return Math.max(0, Math.min(this.frames - 1, Math.round(n)));
  }

  // --- the videos ---

  /** The deck on screen: the playhead's clip's, or the one peeked at. */
  private onScreenDeck() {
    const t = this.target(this.state.frame);
    return t ? this.decks.get(t.source) : undefined;
  }

  /** Seeks the original, and the proxy if there is one, to frame `n`; its deck goes on screen. */
  private show(n: number) {
    const t = this.target(n);
    if (!t) return;
    this.set({ source: t.source });
    const deck = this.decks.get(t.source);
    if (!deck?.times) return;
    deck.original?.seek(deck.times.seek[t.frame]);
    this.showProxy(n);
  }

  private showProxy(n: number) {
    const t = this.target(n);
    const p = t && this.decks.get(t.source)?.proxy;
    if (!t || !p) return;
    this.set({ source: t.source });
    // The proxy can end a frame short of the grid.
    const last = Number.isFinite(p.video.duration)
      ? this.proxyFrame(p.video.duration) - 1
      : t.frame;
    p.seek((Math.min(t.frame, last) + 0.5) / this.fps);
    this.paint();
  }

  /**
   * Playing forward: when the next clip is another source's, seeks its deck to that clip's
   * first frame now, so the cut only has to show it.
   */
  private preload() {
    const now = this.spans[this.playing];
    const next = this.spans[this.playing + 1];
    if (!now || !next || next.source === now.source) return;
    const deck = this.deckOf(next);
    if (deck?.times && deck.original) deck.original.seek(deck.times.seek[next.in]);
  }

  /**
   * The proxy frame starting at time `t` (proxy frame k starts at k / fps). Rounded to the
   * nearest: the video reports times to the microsecond, so frame 1 at 30 fps is 0.033333 s,
   * a hair before 1 / 30.
   */
  private proxyFrame(t: number) {
    return Math.round(t * this.fps);
  }

  /** Whether the deck on screen's original has the playhead's picture on screen. */
  private originalShowsFrame() {
    const t = this.target(this.state.frame);
    const deck = t && this.decks.get(t.source);
    const o = deck?.original;
    if (!t || !o || !deck.times || o.busy) return false;
    return Math.abs(o.shownTime - deck.times.start[t.frame]) < 1e-3;
  }

  /** The original has finished seeking a while ago, and shows another picture than the playhead's. */
  private originalMissed() {
    const o = this.onScreenDeck()?.original;
    if (!o || o.busy) return false;
    return performance.now() - o.settledAt >= SETTLE_MS && !this.originalShowsFrame();
  }

  /**
   * Puts the proxy on top while it's nearer the playhead than the original; after a single step
   * (held), only if the original can't show the frame.
   */
  private paint = () => {
    const t = this.target(this.state.frame);
    const p = t && this.decks.get(t.source)?.proxy;
    if (!t || !p) return;
    const proxyShowsFrame = !p.busy && this.proxyFrame(p.shownTime) === t.frame;
    let on: boolean;
    if (this.state.speed > 0 || this.originalShowsFrame()) on = false;
    else if (proxyShowsFrame && (!this.proxyHeld || this.originalMissed())) on = true;
    else if (this.proxyHeld) on = false;
    else return;
    p.video.style.visibility = on ? "visible" : "hidden";
  };

  private onOriginal(deck: Deck, meta?: VideoFrameCallbackMetadata) {
    const playing = this.state.speed > 0 && this.deckOf(this.spans[this.playing]) === deck;
    if (meta && deck.times) {
      if (playing) this.played(meta.mediaTime);
      else if (
        import.meta.env.DEV &&
        this.state.speed === 0 &&
        !deck.original?.busy &&
        this.onScreenDeck() === deck
      ) {
        this.check(meta);
      }
    }
    if (!meta && this.crossing && playing) {
      // At a cut: the next clip's first picture is ready; play on.
      this.crossing = false;
      void deck.original?.video.play().catch((e: unknown) => {
        console.error("[player] play:", e);
        this.stop();
      });
    }
    // A seek finished: if the original is still on another picture once it's settled, the proxy
    // covers it.
    if (!meta) setTimeout(() => !this.gone && this.paint(), SETTLE_MS);
    this.paint();
  }

  /**
   * Playing forward, the original presented the picture at `time`: the playhead follows it, and
   * at the clip's last frame (or past it, playing fast), playing moves to the next clip.
   */
  private played(time: number) {
    const span = this.spans[this.playing];
    const times = this.deckOf(span)?.times;
    if (this.crossing || !span || !times) return;
    const s = frameAt(times.start, time);
    if (s >= span.in && s < span.out) this.set({ frame: span.start + s - span.in });
    // The picture covers the clip's last frame (a picture can cover several, VFR).
    if (time >= times.start[span.out - 1] - 1e-3) this.cut();
  }

  /**
   * Playing reached the end of a clip: on to the next one (its source's deck on screen), or stop
   * at the timeline's end.
   */
  private cut() {
    const now = this.spans[this.playing];
    const o = this.deckOf(now)?.original;
    const next = this.spans[this.playing + 1];
    if (!o) return;
    o.video.pause();
    if (!next) {
      this.stop();
      this.set({ frame: this.frames - 1 });
      return;
    }
    const deck = this.deckOf(next);
    const v = deck?.original;
    if (!deck?.times || !v) {
      this.stop();
      return;
    }
    this.playing++;
    this.set({ frame: next.start, source: next.source });
    v.video.muted = next.muted;
    v.video.playbackRate = this.state.speed;
    this.preload();
    const ready = !v.busy && Math.abs(v.shownTime - deck.times.start[next.in]) < 1e-3;
    if (next.source !== now.source && ready) {
      // Sought there already, while the last clip played: play on at once.
      void v.video.play().catch((e: unknown) => {
        console.error("[player] play:", e);
        this.stop();
      });
      return;
    }
    this.crossing = true;
    v.seek(deck.times.seek[next.in]);
  }

  // --- development: the preview = export check (frameCheck.ts) ---

  /** Which video is on top with the playhead's frame, if either is yet. */
  onScreen(): "original" | "proxy" | null {
    if (this.originalShowsFrame()) return "original";
    const p = this.onScreenDeck()?.proxy;
    return p?.video.style.visibility === "visible" && this.shows("proxy") ? "proxy" : null;
  }

  /** Whether `which` video has the playhead's frame on screen, its seeks done. */
  shows(which: "original" | "proxy") {
    if (which === "original") return this.originalShowsFrame();
    const t = this.target(this.state.frame);
    const p = t && this.decks.get(t.source)?.proxy;
    return !!t && !!p && !p.busy && this.proxyFrame(p.shownTime) === t.frame;
  }

  /** The deck on screen's `which` video. */
  video(which: "original" | "proxy") {
    const deck = this.onScreenDeck();
    return (which === "original" ? deck?.original : deck?.proxy)?.video;
  }

  /** Every file's original video, attached (playing across files, any may be on screen). */
  originals() {
    return [...this.decks.values()].flatMap((d) => (d.original ? [d.original.video] : []));
  }

  /** Whether `source`'s deck can show its frames: its frame times read, its video attached. */
  loaded(source: SourceId) {
    const deck = this.decks.get(source);
    return !!deck?.times && !!deck.original;
  }

  /** The original: the time of the picture on screen, the one wanted, and whether it's seeking. */
  originalTimes() {
    const t = this.target(this.state.frame);
    const deck = this.onScreenDeck();
    return {
      shown: deck?.original?.shownTime,
      want: t && deck?.times?.start[t.frame],
      seeking: deck?.original?.busy,
    };
  }

  /** A source ran out while playing (a clip that ends where its source does). */
  private onEnded = () => {
    if (this.state.speed > 0 && !this.crossing) this.cut();
    this.paint();
  };

  /** Development: paused, the original's picture must be the playhead's. */
  private check(meta: VideoFrameCallbackMetadata) {
    const t = this.target(this.state.frame);
    const times = t && this.decks.get(t.source)?.times;
    if (!t || !times) return;
    const want = times.start[t.frame];
    if (Math.abs(meta.mediaTime - want) > 1e-3) {
      console.warn(
        `[player] frame ${this.state.frame} wants the picture at ${want.toFixed(6)} s; ` +
          `showing ${meta.mediaTime.toFixed(6)} s`,
      );
    }
  }
}
