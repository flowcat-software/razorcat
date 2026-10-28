// Camera keyframes (PLAN 5d.8; Richard, 2026-10-28): frames where the camera's set, its
// position, size and shown or hidden. They're anchored as markup is (a clip, and the clip's frame:
// doc.ts), so they move with their clip and a split hands them to its part; but a trim hides one
// (pulled back, it's there again) where markup is kept inside its clip.
//
// The camera follows the timeline: at any frame, it's as the last keyframe in view at or before
// it says, an earlier clip's too, so one carries on across a cut. An edit to the clips keeps
// each clip's start as it was (`keepCameraStarts`): where its first frame would now show the
// camera otherwise, a keyframe's put there, in view, so a jump is never without one to explain
// it (and deleting it lets the one before carry on).
//
// Its position is a share of the picture (its top-left, across and down) and its size a share
// of the picture's shorter side, so a keyframe means the same on any recording it carries on to.

import type { CameraSize } from "../shared/ipc";
import { CAMERA_SHARES, sizeOfPlace, sizedPlace, type CameraPlace } from "./cameraPlace";
import { clipAt, clipLength, clipStarts, total, type ClipId, type Doc } from "./doc";
import type { Size } from "./fit";

export type KeyId = number;

/** The camera as a keyframe sets it. */
export interface CameraState {
  /** Its top-left, a share of the picture's width and height. */
  x: number;
  y: number;
  size: CameraSize;
  hidden: boolean;
}

export interface CameraKey extends CameraState {
  id: KeyId;
  /** The clip it's on, and the clip's frame (as markup's start). */
  clip: ClipId;
  at: number;
}

/** A keyframe in view, and its frame on the timeline. */
export interface ShownKey {
  key: CameraKey;
  f: number;
}

const shownCache = new WeakMap<Doc, ShownKey[]>();

/** The keyframes in view, in timeline order: on a clip that's there, on a frame it shows. */
export function shownKeys(doc: Doc): ShownKey[] {
  let shown = shownCache.get(doc);
  if (shown) return shown;
  const starts = clipStarts(doc);
  const index = new Map(doc.clips.map((c, i) => [c.id, i]));
  shown = [];
  for (const key of doc.cameraKeys) {
    const i = index.get(key.clip);
    if (i === undefined) continue;
    const c = doc.clips[i];
    if (key.at < c.in || key.at >= c.out) continue;
    shown.push({ key, f: starts[i] + key.at - c.in });
  }
  // Two on a frame (crossfaded clips' overlap): the later made counts.
  shown.sort((a, b) => a.f - b.f || a.key.id - b.key.id);
  shownCache.set(doc, shown);
  return shown;
}

/** The camera at timeline frame `f`: as the last keyframe in view at or before it says. */
export function cameraAt(doc: Doc, f: number): CameraState | null {
  const shown = shownKeys(doc);
  let lo = 0;
  let hi = shown.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (shown[mid].f <= f) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? stateOf(shown[lo - 1].key) : null;
}

/** The keyframe in view on timeline frame `f`, if there's one. */
export function keyAt(doc: Doc, f: number): CameraKey | null {
  const on = shownKeys(doc).filter((k) => k.f === f);
  return on.length ? on[on.length - 1].key : null;
}

function stateOf(k: CameraKey): CameraState {
  return { x: k.x, y: k.y, size: k.size, hidden: k.hidden };
}

export function sameCamera(a: CameraState | null, b: CameraState | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.size === b.size && a.hidden === b.hidden;
}

/**
 * The camera at timeline frame `f` set to `state`: the keyframe there changed, or one added
 * there. The same document if nothing changes, or there's no video there.
 */
export function setCameraAt(doc: Doc, f: number, state: CameraState): Doc {
  const here = keyAt(doc, f);
  if (here) {
    if (sameCamera(stateOf(here), state)) return doc;
    const cameraKeys = doc.cameraKeys.map((k) => (k.id === here.id ? { ...k, ...state } : k));
    return { ...doc, cameraKeys };
  }
  const under = clipAt(doc, f);
  if (!under) return doc;
  return withKey(doc, under.clip.id, under.clip.in + f - under.start, state);
}

/** A keyframe added on clip `clip`'s frame `at`. */
function withKey(doc: Doc, clip: ClipId, at: number, state: CameraState): Doc {
  const key: CameraKey = { id: doc.nextKeyId, clip, at, ...state };
  return { ...doc, cameraKeys: [...doc.cameraKeys, key], nextKeyId: doc.nextKeyId + 1 };
}

/** The bubble moved while recording (PLAN 5d.7): on the recording's frame `at`, to `state`. */
export interface CameraMove {
  at: number;
  state: CameraState;
}

/**
 * Clip `clip`'s camera as it was recorded, once: on its first frame (PLAN 5d.8: it never
 * inherits), then a keyframe at each of the bubble's `moves` in it (PLAN 5d.7; on one frame, the
 * last; none where it's as it was).
 */
export function startCamera(
  doc: Doc,
  clip: ClipId,
  state: CameraState,
  moves: readonly CameraMove[] = [],
): Doc {
  const c = doc.clips.find((x) => x.id === clip);
  if (!c || doc.cameraKeys.some((k) => k.clip === clip && k.at === c.in)) return doc;
  const keys = new Map([[c.in, state]]);
  for (const m of [...moves].sort((a, b) => a.at - b.at)) {
    keys.set(Math.min(c.out - 1, Math.max(c.in, m.at)), m.state);
  }
  let was: CameraState | null = null;
  for (const [at, s] of keys) {
    if (sameCamera(was, s)) continue;
    doc = withKey(doc, clip, at, s);
    was = s;
  }
  return doc;
}

/** Keyframes `ids` set as `to` says, from each. The same document if none changes. */
export function restyleKeys(
  doc: Doc,
  ids: readonly KeyId[],
  to: (key: CameraKey) => CameraState,
): Doc {
  let changed = false;
  const cameraKeys = doc.cameraKeys.map((k) => {
    if (!ids.includes(k.id)) return k;
    const state = to(k);
    if (sameCamera(stateOf(k), state)) return k;
    changed = true;
    return { ...k, ...state };
  });
  return changed ? { ...doc, cameraKeys } : doc;
}

/**
 * The first keyframe in view, which is pinned: it sets the camera from the start, so it's never
 * moved or deleted (Richard, 2026-10-28). Its settings still change.
 */
export function firstKey(doc: Doc): ShownKey | null {
  return shownKeys(doc)[0] ?? null;
}

/** Keyframes `ids` deleted, but never the first (`firstKey`). The same document if none are. */
export function deleteKeys(doc: Doc, ids: readonly KeyId[]): Doc {
  const pinned = firstKey(doc)?.key.id;
  const cameraKeys = doc.cameraKeys.filter((k) => k.id === pinned || !ids.includes(k.id));
  return cameraKeys.length === doc.cameraKeys.length ? doc : { ...doc, cameraKeys };
}

/** Keyframes `ids` that can move: those in view, but not the first. */
function movable(doc: Doc, ids: readonly KeyId[]): ShownKey[] {
  const pinned = firstKey(doc)?.key.id;
  return shownKeys(doc).filter((k) => k.key.id !== pinned && ids.includes(k.key.id));
}

/**
 * How far keyframes `ids` can move of the `by` frames asked: as far as they go, after the first
 * keyframe and before the timeline's end.
 */
export function keyShift(doc: Doc, ids: readonly KeyId[], by: number): number {
  const moving = movable(doc, ids);
  if (!moving.length) return 0;
  const lo = (firstKey(doc)?.f ?? -1) + 1 - moving[0].f;
  const hi = total(doc) - 1 - moving[moving.length - 1].f;
  return Math.max(lo, Math.min(hi, by));
}

/**
 * Keyframes `ids` moved `by` frames along the timeline, as far as they go (`keyShift`): each onto
 * the clip there, at its frame. One already where one lands is replaced (PLAN 5d.8c). The same
 * document if they don't move.
 */
export function moveKeys(doc: Doc, ids: readonly KeyId[], by: number): Doc {
  const shift = keyShift(doc, ids, by);
  if (!shift) return doc;
  const moved = new Map<KeyId, CameraKey>();
  for (const { key, f } of movable(doc, ids)) {
    const under = clipAt(doc, f + shift);
    if (under)
      moved.set(key.id, {
        ...key,
        clip: under.clip.id,
        at: under.clip.in + f + shift - under.start,
      });
  }
  const landed = new Set([...moved.values()].map((k) => keyFrame(doc, k)));
  const covered = new Set(
    shownKeys(doc)
      .filter((k) => !moved.has(k.key.id) && landed.has(k.f))
      .map((k) => k.key.id),
  );
  const cameraKeys = doc.cameraKeys
    .filter((k) => !covered.has(k.id))
    .map((k) => moved.get(k.id) ?? k);
  return { ...doc, cameraKeys };
}

/** Keyframe `key`'s frame on the timeline (it's on a clip that's there, on a frame it shows). */
function keyFrame(doc: Doc, key: CameraKey): number {
  const i = doc.clips.findIndex((c) => c.id === key.clip);
  return clipStarts(doc)[i] + key.at - doc.clips[i].in;
}

/**
 * The keyframes through an edit to the clips (`after`, made from `before`): each clip with a
 * camera (`hasCamera`, by its file) whose first frame now shows the camera otherwise than it did
 * gets a keyframe there, as it was. Where it was is where its clip was, or for a part split off
 * or a copy, where its frame was in the clip it came from; a clip that's new (a file added) has
 * none. None added if nothing changed (a split). The same document then.
 */
export function keepCameraStarts(
  before: Doc,
  after: Doc,
  hasCamera: (source: string) => boolean,
): Doc {
  if (before === after) return after;
  let doc = after;
  const was = clipStarts(before);
  for (const c of after.clips) {
    if (!hasCamera(c.source)) continue;
    const holds = (p: { in: number; out: number }) => p.in <= c.in && c.in < p.out;
    let i = before.clips.findIndex((p) => p.id === c.id && holds(p));
    if (i < 0) i = before.clips.findIndex((p) => p.source === c.source && holds(p));
    if (i < 0) continue;
    const then = cameraAt(before, was[i] + c.in - before.clips[i].in);
    if (!then) continue;
    const j = doc.clips.findIndex((x) => x.id === c.id);
    if (sameCamera(cameraAt(doc, clipStarts(doc)[j]), then)) continue;
    doc = withKey(doc, c.id, c.in, then);
  }
  return doc;
}

/** A stretch of a clip's camera: from its `from`th frame for `length`, as `state` says. */
export interface CameraStretch {
  from: number;
  length: number;
  state: CameraState;
}

/**
 * Clip `index`'s camera over its frames, stretch by stretch (`fallback` before any keyframe:
 * its recording's as recorded), as the preview shows it.
 */
export function clipCamera(doc: Doc, index: number, fallback: CameraState | null): CameraStretch[] {
  const start = clipStarts(doc)[index];
  const length = clipLength(doc.clips[index]);
  const changes = shownKeys(doc).filter((k) => k.f > start && k.f < start + length);
  const stretches: CameraStretch[] = [];
  let from = 0;
  let state = cameraAt(doc, start) ?? fallback;
  for (const k of changes) {
    const at = k.f - start;
    if (at > from && state) stretches.push({ from, length: at - from, state });
    from = at;
    state = cameraAt(doc, k.f);
  }
  if (state && length > from) stretches.push({ from, length: length - from, state });
  return stretches;
}

/** Where `state` puts the camera on picture `s` (px). */
export function placeOf(state: CameraState, s: Size): CameraPlace {
  return {
    x: Math.round(state.x * s.width),
    y: Math.round(state.y * s.height),
    size: Math.round(Math.min(s.width, s.height) * CAMERA_SHARES[state.size]),
  };
}

/** The camera at `place` on picture `s` (px), at `size`, shown or not. */
export function stateOfPlace(
  place: CameraPlace,
  s: Size,
  size: CameraSize,
  hidden: boolean,
): CameraState {
  return {
    x: s.width > 0 ? place.x / s.width : 0,
    y: s.height > 0 ? place.y / s.height : 0,
    size,
    hidden,
  };
}

/** A recording's camera as it was recorded (its `place` on picture `s`), at the size nearest. */
export function recordedCamera(place: CameraPlace, s: Size): CameraState {
  const size = sizeOfPlace(place, s);
  return stateOfPlace(sizedPlace(place, size, s), s, size, false);
}

/** `state` at `size` on picture `s`: the corner it's nearest kept where it is (5d.6a). */
export function resizedCamera(state: CameraState, size: CameraSize, s: Size): CameraState {
  return stateOfPlace(sizedPlace(placeOf(state, s), size, s), s, size, state.hidden);
}
