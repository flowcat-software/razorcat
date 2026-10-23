// The edit document (PLAN §3): what the user makes of the source. One magnetic track of clips,
// each a stretch of the source's grid frames, butted together: the timeline is the clips in
// order, with no gaps. The preview and (Phase 2.5) the export both read it. Pure and immutable:
// every edit returns a new document (unchanged parts shared), which is what undo keeps
// (docStore.ts). The mockup's model (mockup/main.html), ported.
//
// Ranges (marked frames, to keep or remove) are stored against the video under them: pieces of
// clips' source frames. Their places on the timeline are worked out from that (`rangePlaces`),
// so trimming, deleting or moving clips carries them along (the mockup's anchoring):
// - A piece names one clip, never a lineage: the same source frames can show in two clips
//   (extend one half of a split over the other's frames), and a lineage then matched both. A
//   split hands the pieces past the cut to the new clip.
// - Video trimmed away hides that part of a range, it isn't lost: pulling the trim back shows it.
// - A range whose video ends up in separate places (a clip moved out of its middle) becomes one
//   range per place (`separateRanges`).
// - Editing a range directly re-anchors it to what's under it now.
//
// Markup (Phase 4: text, arrows...) is anchored by its start: a source frame of one clip, and how
// long it lasts. Its place on the timeline is worked out from that (`markPlace`), so it follows
// its video as ranges do, with the mockup's rule for trims: video trimmed away under its start
// slides it along to stay in its clip (back where it was when the trim is pulled back). It can
// fade in and out (linear, over whole frames); the fades are kept as set and fitted to its
// length where they're used, so a trim that shortens it shortens them, and pulling the trim back
// gives them back.
//
// The frame (crop, and the space grown round it; frame.ts) is one for the whole project.

import type { NewAnnotation } from "../markup/model/types";
import type { Rect, Size } from "./fit";
import { fullFrame, keepCrop, sameGrow, type Frame, type Grow } from "./frame";

export type ClipId = number;

export interface Clip {
  /** Its number, for good: the timeline names it "Clip {id}". A split's left part keeps it. */
  id: ClipId;
  /** The first source grid frame shown. */
  in: number;
  /** The source grid frame after the last one shown (exclusive). */
  out: number;
  /** Silent, in the preview and the export. Its parts (a split, a copy) are too. */
  muted?: boolean;
}

export type RangeId = number;

/** Part of a range: source frames `in` to `out` (exclusive) of one clip. */
export interface Piece {
  clip: ClipId;
  in: number;
  out: number;
}

/** Marked frames, to keep or remove: the video under it when it was made. */
export interface Range {
  id: RangeId;
  pieces: readonly Piece[];
}

export type MarkId = number;

/**
 * What a piece of markup shows: Vandal's markup object (text, an arrow...), without its id. Its
 * geometry is in output pixels, from the top-left of the whole frame (the grown space included).
 */
export type MarkObject = NewAnnotation;

/** A piece of markup: what it shows, and when, anchored to the video under its start. */
export interface Mark {
  id: MarkId;
  /** The clip its start is on, and the source frame there. */
  clip: ClipId;
  at: number;
  /** How many frames it lasts. */
  length: number;
  /** Its lane on the timeline, from the top. The top lane's markup is drawn over the others. */
  lane: number;
  object: MarkObject;
  /** How many frames it fades in over, from its start, and out over, to its end (none if not set). */
  fadeIn?: number;
  fadeOut?: number;
}

/**
 * How opaque markup with `fades` (fitted to it), `length` frames long, is on its frame `u` (from
 * 0): fading in, u / fade-in, so its first frame is clear; fading out, (length − u) / fade-out,
 * so its last is one step from clear. The mockup's ramps, and ffmpeg's `fade` frame for frame,
 * so the preview and the export agree.
 */
export function markOpacity(
  fades: { fadeIn: number; fadeOut: number },
  length: number,
  u: number,
): number {
  let a = 1;
  if (u < fades.fadeIn) a = u / fades.fadeIn;
  if (u >= length - fades.fadeOut) a = Math.min(a, (length - u) / fades.fadeOut);
  return Math.max(0, Math.min(1, a));
}

/** A piece of markup's fades, fitted to `length` frames: the fade-in first, the fade-out in what's left. */
export function markFades(
  m: { fadeIn?: number; fadeOut?: number },
  length: number,
): { fadeIn: number; fadeOut: number } {
  const fadeIn = Math.max(0, Math.min(length, m.fadeIn ?? 0));
  return { fadeIn, fadeOut: Math.max(0, Math.min(length - fadeIn, m.fadeOut ?? 0)) };
}

/** What each kind of markup is called. */
export const MARK_NAMES: Record<MarkObject["kind"], string> = {
  text: "Text",
  callout: "Callout",
  arrow: "Arrow",
  line: "Line",
  rect: "Rectangle",
  ellipse: "Ellipse",
  highlighter: "Highlighter",
  pen: "Pen",
  step: "Step",
  redact: "Redact",
  spotlight: "Spotlight",
};

/** What markup's bar on the timeline says: its text's first line, else what it is. */
export function markLabel(o: MarkObject): string {
  const text = o.kind === "text" || o.kind === "callout" ? o.text.trim().split("\n")[0] : "";
  return text || MARK_NAMES[o.kind];
}

export interface Doc {
  clips: readonly Clip[];
  /** The next clip's id. */
  nextId: ClipId;
  /** The source's length in grid frames: how far a trim can pull a clip back out. */
  sourceFrames: number;
  ranges: readonly Range[];
  nextRangeId: RangeId;
  marks: readonly Mark[];
  nextMarkId: MarkId;
  frame: Frame;
  /** All the sound off, in the preview and the export (which then has no audio). */
  muted: boolean;
}

/** A source `frames` long and `size` as shown, whole: one clip, the full frame. */
export function wholeSource(frames: number, size: Size = { width: 0, height: 0 }): Doc {
  return {
    clips: [{ id: 1, in: 0, out: frames }],
    nextId: 2,
    sourceFrames: frames,
    ranges: [],
    nextRangeId: 1,
    marks: [],
    nextMarkId: 1,
    frame: fullFrame(size),
    muted: false,
  };
}

/** Grows the frame by `grow`. The same document if nothing changes. */
export function setGrow(doc: Doc, grow: Grow): Doc {
  if (sameGrow(grow, doc.frame.grow)) return doc;
  return { ...doc, frame: { ...doc.frame, grow } };
}

/** Crops to `crop` (kept to the source). The same document if nothing changes. */
export function setCrop(doc: Doc, crop: Rect): Doc {
  const kept = keepCrop(crop, doc.frame.source);
  const now = doc.frame.crop;
  if (
    kept.x === now.x &&
    kept.y === now.y &&
    kept.width === now.width &&
    kept.height === now.height
  ) {
    return doc;
  }
  return { ...doc, frame: { ...doc.frame, crop: kept } };
}

export const clipLength = (c: Clip) => c.out - c.in;

/** The timeline's length in frames. */
export const total = (doc: Doc) => doc.clips.reduce((n, c) => n + clipLength(c), 0);

/** Where each clip starts on the timeline. */
export function clipStarts(doc: Doc): number[] {
  let t = 0;
  return doc.clips.map((c) => {
    const s = t;
    t += clipLength(c);
    return s;
  });
}

/** The clip under timeline frame `f`: its index, and where it starts. */
export function clipAt(doc: Doc, f: number): { index: number; clip: Clip; start: number } | null {
  let start = 0;
  for (let index = 0; index < doc.clips.length; index++) {
    const clip = doc.clips[index];
    if (f >= start && f < start + clipLength(clip)) return { index, clip, start };
    start += clipLength(clip);
  }
  return null;
}

/** The frames where something starts or ends (cuts, ranges, the timeline's ends), in order. */
export function editPoints(doc: Doc): number[] {
  const points = new Set([...clipStarts(doc), total(doc)]);
  for (const r of shownRanges(doc)) points.add(r.a).add(r.b);
  for (const m of shownMarks(doc)) points.add(m.start).add(m.end);
  return [...points].sort((x, y) => x - y);
}

/**
 * Splits the clip under timeline frame `f` there: the second part is a new clip. Nothing to
 * split at a clip's first frame (it's already a cut) or past the end: the same document. With
 * `splitMarks`, markup over the cut is split there too, a part on each side: cut clean, or, with
 * `fadeCuts`, each part fading at the cut as the whole did at its ends.
 */
export function split(doc: Doc, f: number, splitMarks = true, fadeCuts = false): Doc {
  const at = clipAt(doc, f);
  if (!at || f === at.start) return doc;
  if (splitMarks) doc = cutMarks(doc, f, f, fadeCuts);
  const cut = at.clip.in + (f - at.start);
  const clips = [...doc.clips];
  clips.splice(at.index, 1, { ...at.clip, out: cut }, { ...at.clip, id: doc.nextId, in: cut });
  const ranges = handOver(doc.ranges, at.clip.id, doc.nextId, cut);
  const marks = handMarksOver(doc.marks, at.clip.id, doc.nextId, cut);
  return { ...doc, clips, ranges, marks, nextId: doc.nextId + 1 };
}

/**
 * Trims clip `id` to show source frames `in` to `out` (ripple: the clips after it move along).
 * Kept to the source, and to at least one frame: an `in` past the clip's `out` stops a frame
 * before it, and the other way round. The same document if nothing changes.
 */
export function trimClip(doc: Doc, id: ClipId, inF: number, outF: number): Doc {
  const index = doc.clips.findIndex((c) => c.id === id);
  if (index < 0) return doc;
  const old = doc.clips[index];
  let a = Math.round(Math.max(0, Math.min(doc.sourceFrames - 1, inF)));
  let b = Math.round(Math.max(1, Math.min(doc.sourceFrames, outF)));
  if (b <= a) {
    // Whichever end moved stops a frame short of the other.
    if (a !== old.in) a = b - 1;
    else b = a + 1;
  }
  if (a === old.in && b === old.out) return doc;
  const clips = [...doc.clips];
  clips[index] = { ...old, in: a, out: b };
  return { ...doc, clips };
}

/**
 * Deletes clip `id`; the clips after it close up (ripple). `withRanges`: the ranges and markup
 * on it go too (just the part on it, of a range that reaches other clips); otherwise they're
 * kept, hidden, and come back with the clip (undo). The last clip can't go: the same document.
 */
export function deleteClip(doc: Doc, id: ClipId, withRanges = true): Doc {
  if (doc.clips.length < 2 || !doc.clips.some((c) => c.id === id)) return doc;
  const clips = doc.clips.filter((c) => c.id !== id);
  if (!withRanges) return { ...doc, clips };
  const marks = doc.marks.filter((m) => m.clip !== id);
  const ranges = doc.ranges
    .map((r) =>
      r.pieces.some((p) => p.clip === id)
        ? { ...r, pieces: r.pieces.filter((p) => p.clip !== id) }
        : r,
    )
    .filter((r) => r.pieces.length > 0);
  return { ...doc, clips, ranges, marks };
}

/**
 * Where clip `id` belongs when dragged `df` frames from its place in `doc` (the document when
 * the drag started): it passes a clip once its leading edge is past that clip's middle. Not
 * dragged, it stays where it is.
 */
export function moveSlot(doc: Doc, id: ClipId, df: number): number {
  const from = doc.clips.findIndex((c) => c.id === id);
  if (from < 0) return -1;
  const starts = clipStarts(doc);
  const left = starts[from] + df;
  const right = left + clipLength(doc.clips[from]);
  let slot = from;
  doc.clips.forEach((c, j) => {
    const middle = starts[j] + clipLength(c) / 2;
    if (j > from && right > middle) slot++;
    if (j < from && left < middle) slot--;
  });
  return slot;
}

/** A clip as copied (Ctrl+C), for `insertClip`: its source frames and its markup. */
export interface ClipCopy {
  in: number;
  out: number;
  muted?: boolean;
  /** The markup anchored to it. */
  marks: readonly Mark[];
}

/** Clip `id` as a copy, its markup with it (not its ranges); null if there's no such clip. */
export function copyClip(doc: Doc, id: ClipId): ClipCopy | null {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip) return null;
  const marks = doc.marks.filter((m) => m.clip === id);
  return { in: clip.in, out: clip.out, ...(clip.muted && { muted: true }), marks };
}

/**
 * Inserts `copy` as a new clip at position `at` (clamped; the clips from there move along), with
 * copies of its markup (Richard, 2026-10-20).
 */
export function insertClip(doc: Doc, copy: ClipCopy, at: number): Doc {
  const id = doc.nextId;
  const clips = [...doc.clips];
  const clip = { id, in: copy.in, out: copy.out, ...(copy.muted && { muted: true }) };
  clips.splice(Math.max(0, Math.min(clips.length, at)), 0, clip);
  let nextMarkId = doc.nextMarkId;
  const marks = [...doc.marks, ...copy.marks.map((m) => ({ ...m, id: nextMarkId++, clip: id }))];
  return { ...doc, clips, nextId: id + 1, marks, nextMarkId };
}

/** Mutes clip `id`, or unmutes it. The same document if nothing changes. */
export function muteClip(doc: Doc, id: ClipId, muted: boolean): Doc {
  const index = doc.clips.findIndex((c) => c.id === id);
  if (index < 0 || !!doc.clips[index].muted === muted) return doc;
  const clips = [...doc.clips];
  const { id: clipId, in: a, out: b } = clips[index];
  clips[index] = { id: clipId, in: a, out: b, ...(muted && { muted }) };
  return { ...doc, clips };
}

/** Mutes all the sound, or unmutes it. The same document if nothing changes. */
export function muteTrack(doc: Doc, muted: boolean): Doc {
  return doc.muted === muted ? doc : { ...doc, muted };
}

/** Ctrl+D: a copy of clip `id` straight after it. The same document if there's no such clip. */
export function duplicateClip(doc: Doc, id: ClipId): Doc {
  const copy = copyClip(doc, id);
  if (!copy) return doc;
  return insertClip(doc, copy, doc.clips.findIndex((c) => c.id === id) + 1);
}

/**
 * Where Ctrl+V puts a clip: the position of the cut nearest timeline frame `f` (a clip's start,
 * or the timeline's end). From a clip's exact middle, the cut on its right (Richard).
 */
export function pasteSlot(doc: Doc, f: number): number {
  const cuts = [...clipStarts(doc), total(doc)];
  let best = 0;
  cuts.forEach((c, i) => {
    if (Math.abs(c - f) <= Math.abs(cuts[best] - f)) best = i;
  });
  return best;
}

/** Moves clip `id` to position `to` (clamped); the others close up around it. */
export function moveClip(doc: Doc, id: ClipId, to: number): Doc {
  const from = doc.clips.findIndex((c) => c.id === id);
  const at = Math.max(0, Math.min(doc.clips.length - 1, to));
  if (from < 0 || at === from) return doc;
  const clips = [...doc.clips];
  const [clip] = clips.splice(from, 1);
  clips.splice(at, 0, clip);
  return { ...doc, clips };
}

// --- ranges ---

/** A stretch of the timeline: frames `a` to `b` (exclusive). */
export interface Place {
  a: number;
  b: number;
}

/** A range as shown: where it is on the timeline. */
export interface ShownRange extends Place {
  id: RangeId;
}

/**
 * Where a range's video is on the timeline now: its places in order, each with the pieces of
 * video it shows (trimmed to what's shown). None: all trimmed away, or its clips deleted.
 */
export function rangePlaces(doc: Doc, r: Range): (Place & { pieces: Piece[] })[] {
  const starts = clipStarts(doc);
  const parts: (Place & { piece: Piece })[] = [];
  for (const p of r.pieces) {
    const i = doc.clips.findIndex((c) => c.id === p.clip);
    if (i < 0) continue;
    const c = doc.clips[i];
    const a = Math.max(p.in, c.in);
    const b = Math.min(p.out, c.out);
    if (b > a) {
      parts.push({
        a: starts[i] + a - c.in,
        b: starts[i] + b - c.in,
        piece: { clip: p.clip, in: a, out: b },
      });
    }
  }
  parts.sort((x, y) => x.a - y.a);
  const places: (Place & { pieces: Piece[] })[] = [];
  for (const part of parts) {
    const last = places[places.length - 1];
    if (last && part.a <= last.b) {
      last.b = Math.max(last.b, part.b);
      last.pieces.push(part.piece);
    } else places.push({ a: part.a, b: part.b, pieces: [part.piece] });
  }
  return places;
}

/** The ranges on the timeline, where they are (hidden ones left out). */
export function shownRanges(doc: Doc): ShownRange[] {
  const shown: ShownRange[] = [];
  for (const r of doc.ranges) {
    const [place] = rangePlaces(doc, r);
    if (place) shown.push({ id: r.id, a: place.a, b: place.b });
  }
  return shown;
}

/** The video under timeline frames `a` to `b`, as pieces of clips. */
export function anchor(doc: Doc, a: number, b: number): Piece[] {
  const starts = clipStarts(doc);
  const pieces: Piece[] = [];
  doc.clips.forEach((c, i) => {
    const s = starts[i];
    const from = Math.max(a, s);
    const to = Math.min(b, s + clipLength(c));
    if (to > from) pieces.push({ clip: c.id, in: c.in + from - s, out: c.in + to - s });
  });
  return pieces;
}

/** A place on the timeline, kept to it and at least a frame long; null if there's no room. */
function within(doc: Doc, a: number, b: number): Place | null {
  const lo = Math.max(0, Math.round(Math.min(a, b)));
  const hi = Math.min(total(doc), Math.round(Math.max(a, b)));
  return hi > lo ? { a: lo, b: hi } : null;
}

/**
 * The free stretch of timeline round frames `a` to `b`: from the end of the range before them
 * to the start of the one after (not counting range `exclude`). Ranges never overlap, though
 * they may touch (Richard); one already over `a` to `b` doesn't count.
 */
export function rangeRoom(doc: Doc, a: number, b: number, exclude: RangeId | null): Place {
  let lo = 0;
  let hi = total(doc);
  for (const r of shownRanges(doc)) {
    if (r.id === exclude) continue;
    if (r.b <= a) lo = Math.max(lo, r.b);
    else if (r.a >= b) hi = Math.min(hi, r.a);
  }
  return { a: lo, b: hi };
}

/**
 * Adds a range over timeline frames `a` to `b`, stopping at the next range. The same document
 * if there's nothing there, or `a` is in a range already.
 */
export function addRange(doc: Doc, a: number, b: number): Doc {
  const start = Math.min(a, b);
  if (shownRanges(doc).some((r) => r.a <= start && start < r.b)) return doc;
  const room = rangeRoom(doc, start, start, null);
  const place = within(doc, Math.max(start, room.a), Math.min(Math.max(a, b), room.b));
  if (!place) return doc;
  const range = { id: doc.nextRangeId, pieces: anchor(doc, place.a, place.b) };
  return { ...doc, ranges: [...doc.ranges, range], nextRangeId: doc.nextRangeId + 1 };
}

/**
 * Moves or resizes range `id` to timeline frames `a` to `b`, kept clear of the ranges either
 * side of it: it marks what's there now.
 */
export function setRange(doc: Doc, id: RangeId, a: number, b: number): Doc {
  const index = doc.ranges.findIndex((r) => r.id === id);
  const now = shownRanges(doc).find((r) => r.id === id);
  const room = now ? rangeRoom(doc, now.a, now.b, id) : { a: 0, b: total(doc) };
  const place = within(doc, Math.max(Math.min(a, b), room.a), Math.min(Math.max(a, b), room.b));
  if (index < 0 || !place) return doc;
  if (now && now.a === place.a && now.b === place.b) return doc;
  const ranges = [...doc.ranges];
  ranges[index] = { id, pieces: anchor(doc, place.a, place.b) };
  return { ...doc, ranges };
}

export function deleteRange(doc: Doc, id: RangeId): Doc {
  if (!doc.ranges.some((r) => r.id === id)) return doc;
  return { ...doc, ranges: doc.ranges.filter((r) => r.id !== id) };
}

/** Clip `from` was cut at source frame `at`: the pieces past it now belong to clip `to`. */
function handOver(ranges: readonly Range[], from: ClipId, to: ClipId, at: number): Range[] {
  return ranges.map((r) => {
    if (!r.pieces.some((p) => p.clip === from && p.out > at)) return r;
    const pieces = r.pieces.flatMap((p) => {
      if (p.clip !== from || p.out <= at) return [p];
      if (p.in >= at) return [{ ...p, clip: to }];
      return [
        { ...p, out: at },
        { clip: to, in: at, out: p.out },
      ];
    });
    return { ...r, pieces };
  });
}

/**
 * Each range in one place: a range whose video was moved apart becomes one range per place,
 * each marking just what it shows there. The same document if none was.
 */
export function separateRanges(doc: Doc): Doc {
  let nextRangeId = doc.nextRangeId;
  let changed = false;
  const ranges = doc.ranges.flatMap((r) => {
    const places = rangePlaces(doc, r);
    if (places.length < 2) return [r];
    changed = true;
    return places.map((p, k) => ({ id: k === 0 ? r.id : nextRangeId++, pieces: p.pieces }));
  });
  return changed ? { ...doc, ranges, nextRangeId } : doc;
}

/**
 * Ranges kept at their places on the timeline (Settings › Timeline › "Ranges follow their
 * video" off): `after`, an edit of the clips in `before`, with each range that was shown in
 * `before` marking whatever is at its place now (cut short at the timeline's end; gone if
 * nothing's left there). Hidden ones stay as they are.
 */
export function keepRangesInPlace(before: Doc, after: Doc): Doc {
  if (after === before || (before.ranges.length === 0 && before.marks.length === 0)) return after;
  const was = new Map(shownRanges(before).map((r) => [r.id, r]));
  // From `before`'s ranges, so one a drag's step dropped (no room) comes back when there's room
  // again; those the edit deleted (with their clip) stay gone.
  const ranges: Range[] = [];
  for (const old of before.ranges) {
    const now = after.ranges.find((r) => r.id === old.id);
    if (!now) continue;
    const place = was.get(old.id);
    if (!place) {
      ranges.push(now);
      continue;
    }
    const kept = within(after, place.a, place.b);
    if (kept) ranges.push({ id: old.id, pieces: anchor(after, kept.a, kept.b) });
  }
  // Markup the same: each shown one marks whatever is at its place now.
  const marks = after.marks.map((m) => {
    const old = before.marks.find((o) => o.id === m.id);
    const place = old && markPlace(before, old);
    if (!place) return m;
    const start = Math.min(place.start, total(after) - 1);
    const at = anchorAt(after, start);
    return at ? { ...m, ...at, length: Math.max(1, Math.min(m.length, total(after) - start)) } : m;
  });
  return { ...after, ranges, marks };
}

/**
 * Cuts timeline stretches out of the clips (ripple), and clears the ranges. A clip cut in its
 * middle becomes two: the second part a new clip. Nothing left at all: the same document.
 */
function cutOut(doc: Doc, places: readonly Place[], splitMarks: boolean, fadeCuts: boolean): Doc {
  let nextId = doc.nextId;
  let clips: readonly Clip[] = doc.clips;
  let marks = doc.marks;
  let nextMarkId = doc.nextMarkId;
  // From the end, so the earlier places stay where they are.
  for (const { a, b } of [...places].sort((x, y) => y.a - x.a)) {
    if (splitMarks) {
      ({ marks, nextMarkId } = cutMarks({ ...doc, clips, marks, nextMarkId }, a, b, fadeCuts));
    }
    const starts = clipStarts({ ...doc, clips });
    const out: Clip[] = [];
    clips.forEach((c, i) => {
      const s = starts[i];
      const e = s + clipLength(c);
      if (b <= s || a >= e) {
        out.push(c);
        return;
      }
      if (a > s) out.push({ ...c, out: c.in + (a - s) });
      if (b < e) {
        if (a > s) {
          // Cut in its middle: the markup after the cut goes with the second part.
          const cut = c.in + (b - s);
          marks = handMarksOver(marks, c.id, nextId, cut);
          out.push({ ...c, id: nextId++, in: cut });
        } else out.push({ ...c, in: c.in + (b - s) });
      }
    });
    clips = out;
  }
  if (clips.length === 0) return doc;
  return { ...doc, clips, nextId, ranges: [], marks, nextMarkId };
}

/**
 * Removes the ranges' frames (ripple), and the ranges. Not all of it: the same document. With
 * `splitMarks`, markup over a cut is cut there too (`fadeCuts` as for `split`).
 */
export function removeRanges(doc: Doc, splitMarks = true, fadeCuts = false): Doc {
  const shown = shownRanges(doc);
  return shown.length ? cutOut(doc, shown, splitMarks, fadeCuts) : doc;
}

/** Keeps only the ranges' frames (ripple), and clears the ranges. `splitMarks` as above. */
export function keepRanges(doc: Doc, splitMarks = true, fadeCuts = false): Doc {
  const shown = shownRanges(doc).sort((x, y) => x.a - y.a);
  if (!shown.length) return doc;
  const gaps: Place[] = [];
  let t = 0;
  for (const { a, b } of shown) {
    if (a > t) gaps.push({ a: t, b: a });
    t = Math.max(t, b);
  }
  if (t < total(doc)) gaps.push({ a: t, b: total(doc) });
  return gaps.length ? cutOut(doc, gaps, splitMarks, fadeCuts) : { ...doc, ranges: [] };
}

// --- markup ---

/** A piece of markup as shown: where it is on the timeline. */
export interface ShownMark {
  id: MarkId;
  start: number;
  end: number;
  lane: number;
}

/**
 * Where markup `m` is on the timeline now: from its anchor, running on past its clip's end if it's
 * longer. If the video under its start was trimmed away, it slides to stay in its clip: to the
 * clip's new start, or to end with its end. Cut short at the timeline's end. Null while its clip
 * is gone (deleted, the markup kept).
 */
export function markPlace(doc: Doc, m: Mark): { start: number; end: number } | null {
  const i = doc.clips.findIndex((c) => c.id === m.clip);
  if (i < 0) return null;
  const c = doc.clips[i];
  const src = m.at < c.in ? c.in : m.at >= c.out ? Math.max(c.in, c.out - m.length) : m.at;
  const start = clipStarts(doc)[i] + src - c.in;
  return { start, end: Math.min(total(doc), start + m.length) };
}

/** The markup on the timeline, where it is (hidden markup left out). */
export function shownMarks(doc: Doc): ShownMark[] {
  const shown: ShownMark[] = [];
  for (const m of doc.marks) {
    const place = markPlace(doc, m);
    if (place) shown.push({ id: m.id, lane: m.lane, ...place });
  }
  return shown;
}

/** The video at timeline frame `f`, as an anchor: its clip and source frame. */
function anchorAt(doc: Doc, f: number): { clip: ClipId; at: number } | null {
  const under = clipAt(doc, f);
  return under && { clip: under.clip.id, at: under.clip.in + f - under.start };
}

/**
 * Markup over the edges of timeline frames `a` to `b` is cut there (a split, when they're the
 * same): its parts outside them kept, each anchored to its video, the part between dropped.
 * Markup wholly between them, or clear of them, is left as it is. The part with the start keeps
 * its fade-in, the part with the end its fade-out; at the cut, none, or with `fadeCuts` the
 * fade the whole had at that end (Richard, 2026-10-08).
 */
function cutMarks(doc: Doc, a: number, b: number, fadeCuts = false): Doc {
  let nextMarkId = doc.nextMarkId;
  const marks: Mark[] = [];
  for (const m of doc.marks) {
    const place = markPlace(doc, m);
    const crosses = (f: number) => place !== null && place.start < f && f < place.end;
    if (!place || !(crosses(a) || crosses(b))) {
      marks.push(m);
      continue;
    }
    const parts: Place[] = [];
    if (place.start < a) parts.push({ a: place.start, b: a });
    if (place.end > b) parts.push({ a: b, b: place.end });
    parts.forEach((p, i) => {
      const at = anchorAt(doc, p.a);
      if (!at) return;
      const fadeIn = p.a === place.start || fadeCuts ? (m.fadeIn ?? 0) : 0;
      const fadeOut = p.b === place.end || fadeCuts ? (m.fadeOut ?? 0) : 0;
      const id = i === 0 ? m.id : nextMarkId++;
      marks.push({ ...m, ...at, id, length: p.b - p.a, ...fades(fadeIn, fadeOut) });
    });
  }
  return { ...doc, marks, nextMarkId };
}

/** Fades as a piece of markup keeps them: none left out. */
function fades(fadeIn: number, fadeOut: number): { fadeIn?: number; fadeOut?: number } {
  return { fadeIn: fadeIn || undefined, fadeOut: fadeOut || undefined };
}

/**
 * Markup `id` fades in over `fadeIn` frames, or out over `fadeOut` (whichever is given), kept to
 * whole frames and to what its length leaves after the other. The same document if nothing
 * changes.
 */
export function setMarkFades(
  doc: Doc,
  id: MarkId,
  set: { fadeIn: number } | { fadeOut: number },
): Doc {
  const index = doc.marks.findIndex((m) => m.id === id);
  if (index < 0) return doc;
  const old = doc.marks[index];
  const place = markPlace(doc, old);
  const length = place ? place.end - place.start : old.length;
  const now = markFades(old, length);
  const fit = (v: number, other: number) => Math.max(0, Math.min(length - other, Math.round(v)));
  const next =
    "fadeIn" in set
      ? { fadeIn: fit(set.fadeIn, now.fadeOut), fadeOut: now.fadeOut }
      : { fadeIn: now.fadeIn, fadeOut: fit(set.fadeOut, now.fadeIn) };
  if (next.fadeIn === now.fadeIn && next.fadeOut === now.fadeOut) return doc;
  const marks = [...doc.marks];
  marks[index] = { ...old, ...fades(next.fadeIn, next.fadeOut) };
  return { ...doc, marks };
}

/**
 * Markup `ids` given a fade of `frames` (the default fade, PLAN 4.5d1; 0 removes it) at their
 * start (`in`), end (`out`) or both, as much as each one's length allows: both on an item too
 * short for two, half its length each. The other end's fade is kept when only one is given.
 */
export function fadeEnds(
  doc: Doc,
  ids: readonly MarkId[],
  frames: number,
  ends: "both" | "in" | "out",
): Doc {
  return shownMarks(doc)
    .filter((m) => ids.includes(m.id))
    .reduce((d, m) => {
      if (ends === "in") return setMarkFades(d, m.id, { fadeIn: frames });
      if (ends === "out") return setMarkFades(d, m.id, { fadeOut: frames });
      const half = Math.floor((m.end - m.start) / 2);
      const cleared = setMarkFades(d, m.id, { fadeOut: 0 });
      const faded = setMarkFades(cleared, m.id, { fadeIn: Math.min(frames, half) });
      return setMarkFades(faded, m.id, { fadeOut: frames });
    }, doc);
}

/**
 * Markup `ids` fading in over `fadeIn` frames and out over `fadeOut` (Paste Fades, PLAN 4.5d4),
 * each as far as its length allows: the fade-in first, the fade-out in what's left.
 */
export function setFades(doc: Doc, ids: readonly MarkId[], fadeIn: number, fadeOut: number): Doc {
  return ids.reduce(
    (d, id) =>
      setMarkFades(setMarkFades(setMarkFades(d, id, { fadeOut: 0 }), id, { fadeIn }), id, {
        fadeOut,
      }),
    doc,
  );
}

/** Clip `from` was cut at source frame `at`: markup starting past it now belongs to clip `to`. */
function handMarksOver(marks: readonly Mark[], from: ClipId, to: ClipId, at: number): Mark[] {
  return marks.map((m) => (m.clip === from && m.at >= at ? { ...m, clip: to } : m));
}

/**
 * Adds markup showing `object` at timeline frame `start`, `length` frames long (less at the end),
 * in `lane`. The same document if there's no video there.
 */
export function addMark(
  doc: Doc,
  object: MarkObject,
  start: number,
  length: number,
  lane: number,
): Doc {
  const f = Math.max(0, Math.min(total(doc) - 1, Math.round(start)));
  const at = anchorAt(doc, f);
  if (!at) return doc;
  const mark: Mark = {
    id: doc.nextMarkId,
    ...at,
    length: Math.max(1, Math.min(Math.round(length), total(doc) - f)),
    lane: keptLane(doc, lane),
    object,
  };
  return { ...doc, marks: [...doc.marks, mark], nextMarkId: doc.nextMarkId + 1 };
}

/**
 * Moves or resizes markup `id` to timeline frames `start` to `end` in `lane`: it's anchored to
 * what's under its start now. Kept to the timeline and to a frame at least. The same document if
 * nothing changes.
 */
export function setMark(doc: Doc, id: MarkId, start: number, end: number, lane: number): Doc {
  const index = doc.marks.findIndex((m) => m.id === id);
  if (index < 0) return doc;
  const length = total(doc);
  const a = Math.max(0, Math.min(length - 1, Math.round(start)));
  const b = Math.max(a + 1, Math.min(length, Math.round(end)));
  const at = anchorAt(doc, a);
  if (!at) return doc;
  const old = doc.marks[index];
  const l = keptLane(doc, lane);
  const now = markPlace(doc, old);
  if (now && now.start === a && now.end === b && old.lane === l) return doc;
  const marks = [...doc.marks];
  marks[index] = { ...old, ...at, length: b - a, lane: l };
  return { ...doc, marks };
}

/** Markup `id` shows `object` now. The same document if it's the same object. */
export function setMarkObject(doc: Doc, id: MarkId, object: MarkObject): Doc {
  const index = doc.marks.findIndex((m) => m.id === id);
  if (index < 0 || doc.marks[index].object === object) return doc;
  const marks = [...doc.marks];
  marks[index] = { ...marks[index], object };
  return { ...doc, marks };
}

/** Deletes markup `ids`. The same document if none of them is there. */
export function deleteMarks(doc: Doc, ids: readonly MarkId[]): Doc {
  const marks = doc.marks.filter((m) => !ids.includes(m.id));
  return marks.length === doc.marks.length ? doc : { ...doc, marks };
}

export function deleteMark(doc: Doc, id: MarkId): Doc {
  return deleteMarks(doc, [id]);
}

/**
 * The lane for new markup from `start` to `end`: in front of all it overlaps, as a drawing's
 * newest stroke is. The top lane if there's room there then, else a new one above it (Richard,
 * 2026-10-21: in a new lane at the bottom, what was just drawn went behind the rest).
 */
export function freeLane(doc: Doc, start: number, end: number): number {
  const busy = shownMarks(doc).some((m) => m.lane === 0 && m.start < end && m.end > start);
  return busy ? -1 : 0;
}

// --- lanes ---
//
// Markup lanes grow as they're needed and close up when emptied, and two items in a lane never
// overlap in time (Richard, 2026-10-21: with two fixed lanes, a third item at a busy moment
// stacked over another, out of reach). The upper lane's markup is in front. `settleLanes` keeps
// it so after every edit (docStore.ts).

/** How many lanes the markup takes: one more than the lowest it's in, and one at least. */
export function laneCount(doc: Doc): number {
  return Math.max(1, ...shownMarks(doc).map((m) => m.lane + 1));
}

/** A lane markup can be put in: one of the lanes, or a new one above them (-1) or below. */
function keptLane(doc: Doc, lane: number): number {
  return Math.max(-1, Math.min(laneCount(doc), Math.round(lane)));
}

/**
 * The markup with no two items in a lane overlapping in time, and no empty lanes: each item
 * keeps its lane if there's room, else goes down a lane until there is (a new one at the
 * bottom if need be). The earlier items, then the older, keep theirs; `yielding` (what was
 * just moved or added) gives way to everything else. Then the lanes close up over empty ones
 * (a new lane above, -1, becomes the first). Hidden markup keeps its lane. The same document if
 * nothing moves.
 */
export function settleLanes(doc: Doc, yielding: readonly MarkId[] = []): Doc {
  const gives = new Set(yielding);
  const order = shownMarks(doc).sort(
    (a, b) =>
      Number(gives.has(a.id)) - Number(gives.has(b.id)) ||
      a.lane - b.lane ||
      a.start - b.start ||
      a.id - b.id,
  );
  const taken = new Map<number, ShownMark[]>();
  const placed = new Map<MarkId, number>();
  for (const m of order) {
    let lane = m.lane;
    while ((taken.get(lane) ?? []).some((t) => t.start < m.end && m.start < t.end)) lane++;
    taken.set(lane, [...(taken.get(lane) ?? []), m]);
    placed.set(m.id, lane);
  }
  const rank = new Map([...taken.keys()].sort((a, b) => a - b).map((lane, i) => [lane, i]));
  let changed = false;
  const marks = doc.marks.map((m) => {
    const lane = placed.get(m.id);
    if (lane === undefined || rank.get(lane) === m.lane) return m;
    changed = true;
    return { ...m, lane: rank.get(lane)! };
  });
  return changed ? { ...doc, marks } : doc;
}

/**
 * The lane that puts markup `id` in front of everything it overlaps in time (`front`), or
 * behind it all (`back`): above the highest of them or below the lowest, a new lane if need
 * be. Its own lane if nothing overlaps it.
 */
export function stackLane(doc: Doc, id: MarkId, how: "front" | "back"): number {
  const shown = shownMarks(doc);
  const m = shown.find((s) => s.id === id);
  if (!m) return 0;
  const over = shown.filter((s) => s.id !== id && s.start < m.end && m.start < s.end);
  if (!over.length) return m.lane;
  const lanes = over.map((s) => s.lane);
  return how === "front" ? Math.min(...lanes) - 1 : Math.max(...lanes) + 1;
}

/**
 * Several markup items moved together, each to its place (lanes as they were numbered before:
 * -1 a new lane above them all), as one block: if any of them lands on other markup, the block
 * goes down a lane at a time, all of it, until none does, so their order front to back and the
 * lanes between them stay as they were (Richard, 2026-10-21: settled one by one, a group's items
 * got reordered). Settled (`settleLanes`).
 */
export function placeMarks(
  doc: Doc,
  places: readonly { id: MarkId; start: number; end: number; lane: number }[],
): Doc {
  const lanes = new Map(places.map((p) => [p.id, p.lane]));
  const timed = places.reduce((d, p) => setMark(d, p.id, p.start, p.end, 0), doc);
  const shown = shownMarks(timed);
  const group = shown.filter((m) => lanes.has(m.id));
  const rest = shown.filter((m) => !lanes.has(m.id));
  const lands = (k: number) =>
    group.some((g) =>
      rest.some((o) => o.lane === lanes.get(g.id)! + k && o.start < g.end && g.start < o.end),
    );
  let k = 0;
  while (lands(k)) k++;
  const marks = timed.marks.map((m) =>
    lanes.has(m.id) ? { ...m, lane: lanes.get(m.id)! + k } : m,
  );
  return settleLanes({ ...timed, marks }, [...lanes.keys()]);
}

/**
 * Markup `id` a lane up (`-1`, forward) or down (`1`, backward). Into that lane if it's free
 * there; else past what's in it, into the lane beyond if that's free, or a new lane between
 * them, so it passes exactly one lane's worth of what it overlaps. Never a new lane past the
 * top or bottom with nothing to pass. Settled (`settleLanes`); the same document if it can't move.
 */
export function stepLane(doc: Doc, id: MarkId, dir: -1 | 1): Doc {
  const shown = shownMarks(doc);
  const m = shown.find((s) => s.id === id);
  if (!m) return doc;
  const count = laneCount(doc);
  /** A lane there is, with nothing in it overlapping the item. */
  const free = (lane: number) =>
    lane >= 0 &&
    lane < count &&
    !shown.some((s) => s.id !== id && s.lane === lane && s.start < m.end && m.start < s.end);
  const next = m.lane + dir;
  if (next < 0 || next >= count) return doc;
  const into = (lane: number) =>
    settleLanes({ ...doc, marks: doc.marks.map((k) => (k.id === id ? { ...k, lane } : k)) });
  if (free(next)) return into(next);
  const beyond = next + dir;
  if (free(beyond)) return into(beyond);
  // A lane of its own between `next` and `beyond`.
  return insertLane(doc, id, Math.max(next, beyond));
}

/**
 * Markup `id` in a lane of its own at `at`, the lanes from there down making room; then (from
 * the top) each of them goes back up to its own lane if nothing overlapping it is there now, so
 * only what had to make way stays down, in the order it was. Settled.
 */
function insertLane(doc: Doc, id: MarkId, at: number): Doc {
  const shown = shownMarks(doc);
  const lane = new Map(
    shown.map((s) => [s.id, s.id === id ? at : s.lane >= at ? s.lane + 1 : s.lane]),
  );
  for (const s of shown
    .filter((s) => s.id !== id && s.lane >= at)
    .sort((a, b) => a.lane - b.lane)) {
    const clear = shown.every(
      (o) => o.id === s.id || lane.get(o.id) !== s.lane || o.end <= s.start || s.end <= o.start,
    );
    if (clear) lane.set(s.id, s.lane);
  }
  const marks = doc.marks.map((k) => (lane.has(k.id) ? { ...k, lane: lane.get(k.id)! } : k));
  return settleLanes({ ...doc, marks });
}

/**
 * Markup `id` dragged to `start`–`end` and dropped on `lane`: into it if it's free there (or a
 * new lane above or below them all, -1 or past the last); on a busy lane, into a new lane just
 * above it, or just below it with `below` (the pointer in its lower half), as a layer dropped
 * between layers (Richard, 2026-10-21: a busy lane sent it back down, so it couldn't be put
 * between). Settled.
 */
export function dropMark(
  doc: Doc,
  id: MarkId,
  start: number,
  end: number,
  lane: number,
  below: boolean,
): Doc {
  const own = doc.marks.find((m) => m.id === id);
  if (!own) return doc;
  const timed = setMark(doc, id, start, end, own.lane);
  const m = shownMarks(timed).find((s) => s.id === id);
  if (!m) return doc;
  const busy = shownMarks(timed).some(
    (s) => s.id !== id && s.lane === lane && s.start < m.end && m.start < s.end,
  );
  if (!busy) return settleLanes(setMark(timed, id, start, end, lane), [id]);
  return insertLane(timed, id, below ? lane + 1 : lane);
}
