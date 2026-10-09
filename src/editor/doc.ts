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
// slides it along to stay in its clip (back where it was when the trim is pulled back).
//
// The frame (crop, and the space grown round it; frame.ts) is one for the whole project.

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

/** What a piece of markup is (Phase 4.5 adds Vandal's other tools). */
export type MarkKind = "text";

/** A piece of markup: what it is, and when, anchored to the video under its start. */
export interface Mark {
  id: MarkId;
  kind: MarkKind;
  /** The clip its start is on, and the source frame there. */
  clip: ClipId;
  at: number;
  /** How many frames it lasts. */
  length: number;
  /** Its lane on the timeline, from the top. */
  lane: number;
  /** What it says (a stand-in for its look until Phase 4.2). */
  text: string;
}

/** The markup lanes above the clips (the mockup's). */
export const LANES = 2;

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
 * `splitMarks`, markup over the cut is split there too, a part on each side.
 */
export function split(doc: Doc, f: number, splitMarks = true): Doc {
  const at = clipAt(doc, f);
  if (!at || f === at.start) return doc;
  if (splitMarks) doc = cutMarks(doc, f, f);
  const cut = at.clip.in + (f - at.start);
  const clips = [...doc.clips];
  clips.splice(
    at.index,
    1,
    { ...at.clip, out: cut },
    { id: doc.nextId, in: cut, out: at.clip.out },
  );
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

/** Adds a range over timeline frames `a` to `b`. The same document if there's nothing there. */
export function addRange(doc: Doc, a: number, b: number): Doc {
  const place = within(doc, a, b);
  if (!place) return doc;
  const range = { id: doc.nextRangeId, pieces: anchor(doc, place.a, place.b) };
  return { ...doc, ranges: [...doc.ranges, range], nextRangeId: doc.nextRangeId + 1 };
}

/** Moves or resizes range `id` to timeline frames `a` to `b`: it marks what's there now. */
export function setRange(doc: Doc, id: RangeId, a: number, b: number): Doc {
  const index = doc.ranges.findIndex((r) => r.id === id);
  const place = within(doc, a, b);
  if (index < 0 || !place) return doc;
  const now = shownRanges(doc).find((r) => r.id === id);
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
function cutOut(doc: Doc, places: readonly Place[], splitMarks: boolean): Doc {
  let nextId = doc.nextId;
  let clips: readonly Clip[] = doc.clips;
  let marks = doc.marks;
  let nextMarkId = doc.nextMarkId;
  // From the end, so the earlier places stay where they are.
  for (const { a, b } of [...places].sort((x, y) => y.a - x.a)) {
    if (splitMarks) ({ marks, nextMarkId } = cutMarks({ ...doc, clips, marks, nextMarkId }, a, b));
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
          out.push({ id: nextId++, in: cut, out: c.out });
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
 * `splitMarks`, markup over a cut is cut there too.
 */
export function removeRanges(doc: Doc, splitMarks = true): Doc {
  const shown = shownRanges(doc);
  return shown.length ? cutOut(doc, shown, splitMarks) : doc;
}

/** Keeps only the ranges' frames (ripple), and clears the ranges. `splitMarks` as above. */
export function keepRanges(doc: Doc, splitMarks = true): Doc {
  const shown = shownRanges(doc).sort((x, y) => x.a - y.a);
  if (!shown.length) return doc;
  const gaps: Place[] = [];
  let t = 0;
  for (const { a, b } of shown) {
    if (a > t) gaps.push({ a: t, b: a });
    t = Math.max(t, b);
  }
  if (t < total(doc)) gaps.push({ a: t, b: total(doc) });
  return gaps.length ? cutOut(doc, gaps, splitMarks) : { ...doc, ranges: [] };
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
 * Markup wholly between them, or clear of them, is left as it is.
 */
function cutMarks(doc: Doc, a: number, b: number): Doc {
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
      if (at) marks.push({ ...m, ...at, id: i === 0 ? m.id : nextMarkId++, length: p.b - p.a });
    });
  }
  return { ...doc, marks, nextMarkId };
}

/** Clip `from` was cut at source frame `at`: markup starting past it now belongs to clip `to`. */
function handMarksOver(marks: readonly Mark[], from: ClipId, to: ClipId, at: number): Mark[] {
  return marks.map((m) => (m.clip === from && m.at >= at ? { ...m, clip: to } : m));
}

/**
 * Adds markup of `kind` at timeline frame `start`, `length` frames long (less at the end), in
 * `lane`. The same document if there's no video there.
 */
export function addMark(
  doc: Doc,
  kind: MarkKind,
  text: string,
  start: number,
  length: number,
  lane: number,
): Doc {
  const f = Math.max(0, Math.min(total(doc) - 1, Math.round(start)));
  const at = anchorAt(doc, f);
  if (!at) return doc;
  const mark: Mark = {
    id: doc.nextMarkId,
    kind,
    ...at,
    length: Math.max(1, Math.min(Math.round(length), total(doc) - f)),
    lane: Math.max(0, Math.min(LANES - 1, lane)),
    text,
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
  const l = Math.max(0, Math.min(LANES - 1, lane));
  const now = markPlace(doc, old);
  if (now && now.start === a && now.end === b && old.lane === l) return doc;
  const marks = [...doc.marks];
  marks[index] = { ...old, ...at, length: b - a, lane: l };
  return { ...doc, marks };
}

export function deleteMark(doc: Doc, id: MarkId): Doc {
  if (!doc.marks.some((m) => m.id === id)) return doc;
  return { ...doc, marks: doc.marks.filter((m) => m.id !== id) };
}

/**
 * The lane for new markup from `start` to `end`: the first with nothing there, else the first.
 */
export function freeLane(doc: Doc, start: number, end: number): number {
  const shown = shownMarks(doc);
  for (let lane = 0; lane < LANES; lane++) {
    if (!shown.some((m) => m.lane === lane && m.start < end && m.end > start)) return lane;
  }
  return 0;
}
