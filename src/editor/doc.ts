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

export interface Doc {
  clips: readonly Clip[];
  /** The next clip's id. */
  nextId: ClipId;
  /** The source's length in grid frames: how far a trim can pull a clip back out. */
  sourceFrames: number;
  ranges: readonly Range[];
  nextRangeId: RangeId;
}

/** A source `frames` long, whole: one clip. */
export function wholeSource(frames: number): Doc {
  return {
    clips: [{ id: 1, in: 0, out: frames }],
    nextId: 2,
    sourceFrames: frames,
    ranges: [],
    nextRangeId: 1,
  };
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
  return [...points].sort((x, y) => x - y);
}

/**
 * Splits the clip under timeline frame `f` there: the second part is a new clip. Nothing to
 * split at a clip's first frame (it's already a cut) or past the end: the same document.
 */
export function split(doc: Doc, f: number): Doc {
  const at = clipAt(doc, f);
  if (!at || f === at.start) return doc;
  const cut = at.clip.in + (f - at.start);
  const clips = [...doc.clips];
  clips.splice(
    at.index,
    1,
    { ...at.clip, out: cut },
    { id: doc.nextId, in: cut, out: at.clip.out },
  );
  const ranges = handOver(doc.ranges, at.clip.id, doc.nextId, cut);
  return { ...doc, clips, ranges, nextId: doc.nextId + 1 };
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
 * Deletes clip `id`; the clips after it close up (ripple). `withRanges`: the ranges on it go
 * too (just the part on it, of a range that reaches other clips); otherwise they're kept,
 * hidden, and come back with the clip (undo). The last clip can't go: the same document.
 */
export function deleteClip(doc: Doc, id: ClipId, withRanges = true): Doc {
  if (doc.clips.length < 2 || !doc.clips.some((c) => c.id === id)) return doc;
  const clips = doc.clips.filter((c) => c.id !== id);
  if (!withRanges) return { ...doc, clips };
  const ranges = doc.ranges
    .map((r) =>
      r.pieces.some((p) => p.clip === id)
        ? { ...r, pieces: r.pieces.filter((p) => p.clip !== id) }
        : r,
    )
    .filter((r) => r.pieces.length > 0);
  return { ...doc, clips, ranges };
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
  if (after === before || before.ranges.length === 0) return after;
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
  return { ...after, ranges };
}

/**
 * Cuts timeline stretches out of the clips (ripple), and clears the ranges. A clip cut in its
 * middle becomes two: the second part a new clip. Nothing left at all: the same document.
 */
function cutOut(doc: Doc, places: readonly Place[]): Doc {
  let nextId = doc.nextId;
  let clips: readonly Clip[] = doc.clips;
  // From the end, so the earlier places stay where they are.
  for (const { a, b } of [...places].sort((x, y) => y.a - x.a)) {
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
        if (a > s) out.push({ id: nextId++, in: c.in + (b - s), out: c.out });
        else out.push({ ...c, in: c.in + (b - s) });
      }
    });
    clips = out;
  }
  if (clips.length === 0) return doc;
  return { ...doc, clips, nextId, ranges: [] };
}

/** Removes the ranges' frames (ripple), and the ranges. Not all of it: the same document. */
export function removeRanges(doc: Doc): Doc {
  const shown = shownRanges(doc);
  return shown.length ? cutOut(doc, shown) : doc;
}

/** Keeps only the ranges' frames (ripple), and clears the ranges. */
export function keepRanges(doc: Doc): Doc {
  const shown = shownRanges(doc).sort((x, y) => x.a - y.a);
  if (!shown.length) return doc;
  const gaps: Place[] = [];
  let t = 0;
  for (const { a, b } of shown) {
    if (a > t) gaps.push({ a: t, b: a });
    t = Math.max(t, b);
  }
  if (t < total(doc)) gaps.push({ a: t, b: total(doc) });
  return gaps.length ? cutOut(doc, gaps) : { ...doc, ranges: [] };
}
