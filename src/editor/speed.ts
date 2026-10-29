// Clip speed (PLAN §7, Clip speed): a clip shown faster or slower than its source.
//
// A clip's speed is a ratio of whole numbers, never a float, so every edit still lands on a
// frame: `num` source frames to every `den` of the clip's own (2/1 is 200%, 1/2 is 50%). A clip's
// frames are its source's grid frames at its speed: frame v shows source frame
// floor((v·num + phase)/den), the phase a whole number fixed when the speed is set, so the clip's
// first frame stays on the source frame it showed. At 100% (no phase) they're the source's
// frames themselves. Everything in the document that names a clip's frames (its `in` and `out`,
// ranges' pieces, markup's anchor) counts in these, so trims, splits, ranges and markup work at
// any speed as at 100%, and a split's right part shows exactly the frames it did (SP0). Only a
// speed change converts them (`setClipSpeed`), and only reading the media needs source frames
// (`sourceFrame`: the preview and the export).
//
// Markup on a clip whose speed changes keeps its start on its video. Its length and fades scale
// with the speed (`stretchMarks`), or stay in timeline frames (Settings › Timeline, on by default;
// 2026-10-24). Ranges mark video, so they always scale with it. Fades and crossfades are in
// timeline frames, and stay.

import type { Clip, ClipId, Doc } from "./doc";

/** A clip's speed: `num` source frames to every `den` of its own, in lowest terms. */
export interface Speed {
  num: number;
  den: number;
}

export const NORMAL_SPEED: Speed = { num: 1, den: 1 };

/** The slowest and fastest a clip can go, in percent (PLAN §7). */
export const MIN_SPEED_PERCENT = 10;
export const MAX_SPEED_PERCENT = 1000;

/** What a clip's speed is read from. */
type Timed = { speed?: Speed; phase?: number };

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** floor((a·b + c) / d), exact for whole numbers of any size (d > 0). */
function floorDiv(a: number, b: number, c: number, d: number): number {
  const p = a * b;
  // Exact in doubles while the sum is: floor(n/d) can't then round up to the next whole number.
  if (Math.abs(p) + Math.abs(c) <= Number.MAX_SAFE_INTEGER) return Math.floor((p + c) / d);
  const n = BigInt(a) * BigInt(b) + BigInt(c);
  const q = n / BigInt(d);
  return Number(n % BigInt(d) !== 0n && n < 0n ? q - 1n : q);
}

/** ceil((a·b + c) / d), as `floorDiv`. */
const ceilDiv = (a: number, b: number, c: number, d: number) => -floorDiv(-a, b, -c, d);

/** `num/den` in lowest terms. */
export function speed(num: number, den: number): Speed {
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

export const speedOf = (c: Timed): Speed => c.speed ?? NORMAL_SPEED;

const phaseOf = (c: Timed) => c.phase ?? 0;

export const sameSpeed = (a: Speed, b: Speed) => a.num === b.num && a.den === b.den;

export const isNormal = (s: Speed) => s.num === s.den;

/** `s` in percent (not rounded). */
export const speedPercent = (s: Speed) => (100 * s.num) / s.den;

/** `s` as shown: its percent to two decimals at most ("150%", "33.33%"). */
export const formatSpeed = (s: Speed) => `${+speedPercent(s).toFixed(2)}%`;

/** The speeds the options bar's dropdown offers, in percent (PLAN §7). */
export const SPEED_PRESETS = [25, 50, 100, 200, 400];

/** `percent` (to two decimals) as a speed, kept to the limits. */
export function speedFromPercent(percent: number): Speed {
  const p = Math.max(MIN_SPEED_PERCENT, Math.min(MAX_SPEED_PERCENT, percent));
  return speed(Math.round(p * 100), 10000);
}

/** `s` kept to the limits. */
function kept(s: Speed): Speed {
  if (s.num * 100 < MIN_SPEED_PERCENT * s.den) return speedFromPercent(MIN_SPEED_PERCENT);
  if (s.num * 100 > MAX_SPEED_PERCENT * s.den) return speedFromPercent(MAX_SPEED_PERCENT);
  return speed(s.num, s.den);
}

/** WebView2's `playbackRate` limits (SP0: it throws outside them; sound plays at all of them). */
export const MIN_RATE = 0.0625;
export const MAX_RATE = 16;

/**
 * The `playbackRate` that plays clip `c` at `shuttle` (1 playing, 2/4/8 with L): its speed times
 * that, kept to WebView2's limits (at 1000%, L goes no faster than 1.6×).
 */
export function playbackRate(c: Timed, shuttle: number): number {
  const s = speedOf(c);
  return Math.max(MIN_RATE, Math.min(MAX_RATE, (s.num / s.den) * shuttle));
}

/**
 * Where a video's time `time` is in its source, in frames with a fraction: within frame s of the
 * frame times `starts` (each frame's start, s), as far through it as the time is.
 */
export function sourcePosition(starts: ArrayLike<number>, s: number, time: number): number {
  const a = starts[s];
  const b = s + 1 < starts.length ? starts[s + 1] : a + (a - (starts[s - 1] ?? 0) || 1 / 30);
  return s + Math.max(0, Math.min(1, (time - a) / (b - a)));
}

/** The clip's frame showing source position `x` (frames, with a fraction; speed.ts's mapping). */
export function clipFrameAt(c: Timed, x: number): number {
  const s = speedOf(c);
  return Math.floor((x * s.den - phaseOf(c)) / s.num);
}

/** The source frame clip `c` shows on its frame `v`. */
export function sourceFrame(c: Timed, v: number): number {
  const s = speedOf(c);
  return floorDiv(v, s.num, phaseOf(c), s.den);
}

/** The first of clip `c`'s frames that shows source frame `j` (or a later one, if none does). */
export function clipFrame(c: Timed, j: number): number {
  const s = speedOf(c);
  return Math.max(0, ceilDiv(j, s.den, -phaseOf(c), s.num));
}

/** How many frames clip `c` has of a source `frames` long: those showing one of its frames. */
export const retimedLength = (c: Timed, frames: number) => clipFrame(c, frames);

/**
 * The source frame clip `c`'s video ends before (exclusive): where its last frame ends, or, when
 * a fast clip's last frame covers more than its video (a speed change put it there), the end it
 * remembers (`sourceOut`). That counts only while it's within the last frame: a trim or split that
 * moves the clip's end leaves it behind, and the end is the last frame's again.
 */
export function videoEnd(c: Timed & { out: number; sourceOut?: number }): number {
  const s = speedOf(c);
  const p = phaseOf(c);
  const end = ceilDiv(c.out, s.num, p, s.den);
  const kept = c.sourceOut;
  // Within the last frame: (out − 1)·num + phase < kept·den ≤ out·num + phase.
  if (kept !== undefined && kept < end && kept * s.den > (c.out - 1) * s.num + p) return kept;
  return end;
}

/**
 * Clip `id` at speed `to` (kept to the limits), or with `length` instead made that many frames
 * long (as near as the limits allow). Its video stays: its first frame shows the same source
 * frame, and the ranges and markup on it each move to the first frame at or after the point of
 * the video they were on. A length is exact; a speed gives the clip as many frames as cover its
 * video. Markup keeps its length and fades, or with `stretchMarks` they scale too. Cut short at the
 * source's end. The same document if nothing changes.
 */
export function setClipSpeed(
  doc: Doc,
  id: ClipId,
  to: Speed | { length: number },
  stretchMarks = false,
): Doc {
  const index = doc.clips.findIndex((c) => c.id === id);
  if (index < 0) return doc;
  const old = doc.clips[index];
  const was = speedOf(old);
  const frames = old.out - old.in;
  const length = "length" in to ? Math.max(1, Math.round(to.length)) : null;
  // A length L shows the same video at (old speed) × frames / L.
  const wanted = length === null ? (to as Speed) : speed(was.num * frames, was.den * length);
  const next = kept(wanted);
  const exact = length !== null && sameSpeed(next, wanted);
  if (sameSpeed(next, was) && (length === null || length === frames)) return doc;

  // The clip's first source frame j0 on its new first frame, exactly: frame v shows
  // floor((v·num + phase)/den), so v = floor(j0·den/num) with phase j0·den − v·num.
  const j0 = sourceFrame(old, old.in);
  const inF = floorDiv(j0, next.den, 0, next.num);
  const phase = j0 * next.den - inF * next.num;
  const timed: Timed = { speed: next, phase };
  // A point of the old clip's video (its frame v, at the point (v·num + phase)/den of the source)
  // to the first new frame at or after it; the clip's own ends to the new ones.
  const at = (v: number) => {
    const n = BigInt(v) * BigInt(was.num) + BigInt(phaseOf(old));
    // ceil((n/was.den · next.den − phase) / next.num)
    const top = n * BigInt(next.den) - BigInt(phase) * BigInt(was.den);
    const bottom = BigInt(was.den) * BigInt(next.num);
    const q = top / bottom;
    return Number(top % bottom !== 0n && top > 0n ? q + 1n : q);
  };
  const source = doc.sources.find((s) => s.id === old.source);
  const limit = source ? retimedLength(timed, source.frames) : Infinity;
  // Its end on the frame that shows its video's end (`videoEnd`), as its start on its first: so
  // speed after speed never creeps onto frames it didn't show, nor loses any.
  const end = videoEnd(old);
  const outF = Math.min(limit, Math.max(inF + 1, exact ? inF + length! : clipFrame(timed, end)));
  const conv = (v: number) => (v === old.in ? inF : v === old.out ? outF : at(v));

  const clip: Clip = { ...old, in: inF, out: outF, speed: next, phase };
  // Remembered where its last frame covers more than its video.
  if (outF * next.num + phase !== end * next.den) clip.sourceOut = end;
  else delete clip.sourceOut;
  if (!phase) delete clip.phase;
  if (isNormal(next)) delete clip.speed;
  const clips = [...doc.clips];
  clips[index] = clip;
  const ranges = doc.ranges
    .map((r) => {
      if (!r.pieces.some((p) => p.clip === id)) return r;
      const pieces = r.pieces
        .map((p) => (p.clip === id ? { ...p, in: conv(p.in), out: conv(p.out) } : p))
        .filter((p) => p.out > p.in);
      return { ...r, pieces };
    })
    .filter((r) => r.pieces.length > 0);
  // A count of frames (markup's length, a fade) at the new speed: as many as cover as much video.
  const span = (n: number) =>
    floorDiv(2 * n * was.num, next.den, was.den * next.num, 2 * was.den * next.num);
  const fade = (n: number | undefined) => (n ? span(n) || undefined : undefined);
  const marks = doc.marks.map((m) => {
    if (m.clip !== id) return m;
    const moved = { ...m, at: conv(m.at) };
    if (!stretchMarks) return moved;
    return {
      ...moved,
      length: Math.max(1, span(m.length)),
      fadeIn: fade(m.fadeIn),
      fadeOut: fade(m.fadeOut),
    };
  });
  return { ...doc, clips, ranges, marks };
}

/** Clips `ids` at speed `to` (each as `setClipSpeed`), one edit. */
export function setClipsSpeed(
  doc: Doc,
  ids: readonly ClipId[],
  to: Speed,
  stretchMarks = false,
): Doc {
  return ids.reduce((d, id) => setClipSpeed(d, id, to, stretchMarks), doc);
}
