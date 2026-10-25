// The edit document (PLAN §3): what the user makes of the sources. One magnetic track of clips,
// each a stretch of one source's grid frames, butted together: the timeline is the clips in
// order, with no gaps. The first source sets the timeline's frame rate and size; one added later
// is gridded at that rate (Rust) and fitted into the frame (PLAN 4.5e). The preview and (Phase 2.5) the export both read it. Pure and immutable:
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
// A clip can fade in from black and out to black (PLAN 4.7a), its sound with it: kept and
// fitted the same way, and the same ramps. Markup isn't faded with it. Each fade can be to
// another colour (4.7c, white say): kept with the clip whatever the fade's length, so a drag
// to nothing and back keeps it; Remove Fades takes it away.
//
// A clip can crossfade with the one before it (PLAN 4.7b): it overlaps that clip's last frames,
// its own first ones blending in over them, so the timeline is that much shorter (only frames
// that are shown are used: a cut usually hides something). Kept as set, and fitted where it's
// used (`crossfades`). It belongs to the cut: a clip that gets another one before it (moved,
// or its neighbour deleted) loses it (`keepCrossfades`). At a crossfaded end, the clip's own
// fade doesn't apply.
//
// The frame (crop, and the space grown round it; frame.ts) is one for the whole project.
//
// A clip can play faster or slower than its source (speed.ts). Its frames are then its source's
// at its speed, and everything above that names a clip's frames (`in`, `out`, ranges' pieces,
// markup's anchor) counts in those: at 100%, the source's grid frames.

import { translateAnnotation } from "../markup/geometry";
import type { Annotation, NewAnnotation } from "../markup/model/types";
import type { Rect, Size } from "./fit";
import { fullFrame, keepCrop, sameGrow, type Frame, type Grow } from "./frame";
import { retimedLength, type Speed } from "./speed";

export type ClipId = number;

/** A source file, as the page names it (`SourceInfo.id`, which stays when it's converted). */
export type SourceId = string;

/** A source in the edit: its id and its length in grid frames (how far a trim can pull out). */
export interface SourceRef {
  id: SourceId;
  frames: number;
}

export interface Clip {
  /** Its number, for good: the timeline names it "Clip {id}". A split's left part keeps it. */
  id: ClipId;
  /** The file it shows. */
  source: SourceId;
  /** The first of its frames shown: its source's grid frames at its speed (speed.ts). */
  in: number;
  /** The frame after the last one shown (exclusive). */
  out: number;
  /**
   * How fast it plays its source (100% if not set), where its frames fall on it, and where its
   * video ends if its last frame covers more (speed.ts).
   */
  speed?: Speed;
  phase?: number;
  sourceOut?: number;
  /** Silent, in the preview and the export. Its parts (a split, a copy) are too. */
  muted?: boolean;
  /** How many frames it fades in from black over, and out to black over (none if not set). */
  fadeIn?: number;
  fadeOut?: number;
  /** The colour it fades in from, and out to ("#rrggbb"; black if not set). */
  fadeInColour?: string;
  fadeOutColour?: string;
  /** How many frames it crossfades with the clip before it over (none if not set). */
  crossfade?: number;
}

export type RangeId = number;

/** Part of a range: frames `in` to `out` (exclusive) of one clip. */
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
 * A crop or grow that moves the picture in the frame moves the markup with it (`withFrame`), so
 * it stays over what it marked (Richard, 2026-10-23).
 */
export type MarkObject = NewAnnotation;

/** A piece of markup: what it shows, and when, anchored to the video under its start. */
export interface Mark {
  id: MarkId;
  /** The clip its start is on, and the clip's frame there. */
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
 * 0): fading in, u / fade-in, so its first frame is clear; fading out, (length − 1 − u) /
 * fade-out, so its last is clear too (Richard, 2026-10-23: the mockup's ramp stopped a step
 * short, and the last frame wasn't quite gone). The export's `ramps` (export.rs) frame for
 * frame, so the preview and the export agree.
 */
export function markOpacity(
  fades: { fadeIn: number; fadeOut: number },
  length: number,
  u: number,
): number {
  let a = 1;
  if (u < fades.fadeIn) a = u / fades.fadeIn;
  if (u >= length - fades.fadeOut) a = Math.min(a, (length - 1 - u) / fades.fadeOut);
  return Math.max(0, Math.min(1, a));
}

/** Whether markup of this kind fades: all but redactions (PLAN 4.8, for now). */
export const canFade = (o: MarkObject) => o.kind !== "redact";

/** A piece of markup's fades, fitted to `length` frames: the fade-in first, the fade-out in what's left. */
export function markFades(
  m: { fadeIn?: number; fadeOut?: number },
  length: number,
): { fadeIn: number; fadeOut: number } {
  const fadeIn = Math.max(0, Math.min(length, m.fadeIn ?? 0));
  return { fadeIn, fadeOut: Math.max(0, Math.min(length - fadeIn, m.fadeOut ?? 0)) };
}

/** Clip `c`'s fades as kept, fitted to its length (crossfades aside: `fadesOf`). */
export const clipFades = (c: Clip) => markFades(c, clipLength(c));

/**
 * The fades of clip `index` as they take effect: none at an end it crossfades at, the rest fitted
 * to what the crossfades leave.
 */
export function fadesOf(doc: Doc, index: number): { fadeIn: number; fadeOut: number } {
  const c = doc.clips[index];
  if (!c) return { fadeIn: 0, fadeOut: 0 };
  const xf = crossfades(doc);
  const head = xf[index];
  const tail = xf[index + 1] ?? 0;
  return markFades(
    { fadeIn: head ? 0 : c.fadeIn, fadeOut: tail ? 0 : c.fadeOut },
    clipLength(c) - head - tail,
  );
}

/**
 * How much of the picture shows on timeline frame `f` (0 to 1): the fades of the clip under it,
 * the ramps markup's are (`markOpacity`). 1 off the timeline.
 */
export function clipOpacityAt(doc: Doc, f: number): number {
  const at = clipAt(doc, f);
  if (!at) return 1;
  return markOpacity(fadesOf(doc, at.index), clipLength(at.clip), f - at.start);
}

/** A fade's colour when none is set, and the other the fade menu offers. */
export const FADE_BLACK = "#000000";
export const FADE_WHITE = "#ffffff";

/** The colours clip `c` fades in from and out to (4.7c). */
export function fadeColours(c: Clip): { fadeIn: string; fadeOut: string } {
  return { fadeIn: c.fadeInColour ?? FADE_BLACK, fadeOut: c.fadeOutColour ?? FADE_BLACK };
}

/**
 * The colour the picture fades to on timeline frame `f`: the fade-in's in the first half of the
 * clip under it, else the fade-out's (on a frame with no fade, it doesn't show).
 */
export function clipFadeColourAt(doc: Doc, f: number): string {
  const at = clipAt(doc, f);
  if (!at) return FADE_BLACK;
  const colours = fadeColours(at.clip);
  return f - at.start < fadesOf(doc, at.index).fadeIn ? colours.fadeIn : colours.fadeOut;
}

/** `c` fading from and to these colours (black left out). */
function withFadeColours(c: Clip, fadeIn: string, fadeOut: string): Clip {
  const next: Clip = { ...c, fadeInColour: fadeIn, fadeOutColour: fadeOut };
  if (fadeIn.toLowerCase() === FADE_BLACK) delete next.fadeInColour;
  if (fadeOut.toLowerCase() === FADE_BLACK) delete next.fadeOutColour;
  return next;
}

/**
 * Clips `ids` fading in from, out to, or both, `colour` (4.7c). The same document if nothing
 * changes.
 */
export function setClipFadeColours(
  doc: Doc,
  ids: readonly ClipId[],
  colour: string,
  ends: "both" | "in" | "out",
): Doc {
  let changed = false;
  const clips = doc.clips.map((c) => {
    if (!ids.includes(c.id)) return c;
    const now = fadeColours(c);
    const next = withFadeColours(
      c,
      ends === "out" ? now.fadeIn : colour,
      ends === "in" ? now.fadeOut : colour,
    );
    const after = fadeColours(next);
    if (after.fadeIn === now.fadeIn && after.fadeOut === now.fadeOut) return c;
    changed = true;
    return next;
  });
  return changed ? { ...doc, clips } : doc;
}

/**
 * Each clip's crossfade with the one before it (PLAN 4.7b), as it takes effect: none for the
 * first; else as set, kept to whole frames, to the frames of the clip before that its own
 * crossfade leaves, and to all but a frame of the clip's own (so each clip has frames that are
 * its alone, to play: the player's spans).
 */
export function crossfades(doc: Doc): number[] {
  const out: number[] = [];
  doc.clips.forEach((c, i) => {
    if (i === 0 || !c.crossfade) {
      out.push(0);
      return;
    }
    const room = Math.min(clipLength(doc.clips[i - 1]) - out[i - 1], clipLength(c) - 1);
    out.push(Math.max(0, Math.min(Math.round(c.crossfade), room)));
  });
  return out;
}

/**
 * How much of the incoming clip shows on frame `k` (from 0) of a crossfade `length` frames long:
 * k / length, ffmpeg's `xfade` frame for frame (its first frame the outgoing clip's alone).
 */
export const crossfadeMix = (k: number, length: number) => k / length;

/**
 * The crossfade at timeline frame `f`, if one's there: the incoming clip (its index), and how
 * far into it `f` is (`k`) of how long (`length`).
 */
export function crossfadeAt(
  doc: Doc,
  f: number,
): { index: number; clip: Clip; k: number; length: number } | null {
  const xf = crossfades(doc);
  const starts = clipStarts(doc);
  for (let index = 1; index < doc.clips.length; index++) {
    const length = xf[index];
    if (length && f >= starts[index] && f < starts[index] + length) {
      return { index, clip: doc.clips[index], k: f - starts[index], length };
    }
  }
  return null;
}

/**
 * The clips as the player plays them: each from its first frame after its crossfade (the
 * outgoing clip plays through the crossfade, the incoming one shown over it), so they meet end
 * to end along the timeline.
 */
export function playedClips(doc: Doc): Clip[] {
  const xf = crossfades(doc);
  return doc.clips.map((c, i) => (xf[i] ? { ...c, in: c.in + xf[i] } : c));
}

/**
 * Clip `id` crossfades with the clip before it over `frames` (0: none), kept as `crossfades`
 * keeps it. The same document if nothing changes (or it's the first clip).
 */
export function setCrossfade(doc: Doc, id: ClipId, frames: number): Doc {
  const index = doc.clips.findIndex((c) => c.id === id);
  if (index < 1) return doc;
  const now = crossfades(doc)[index];
  const tried = crossfades(withCrossfadeAt(doc, index, Math.max(0, Math.round(frames))))[index];
  if (tried === now && (tried > 0 || !doc.clips[index].crossfade)) return doc;
  return withCrossfadeAt(doc, index, tried);
}

function withCrossfadeAt(doc: Doc, index: number, frames: number): Doc {
  const clips = [...doc.clips];
  clips[index] = withCrossfade(clips[index], frames);
  return { ...doc, clips };
}

/** `c` crossfading over `frames` (0: not at all, left out). */
function withCrossfade(c: Clip, frames: number): Clip {
  const next: Clip = { ...c, crossfade: frames };
  if (!frames) delete next.crossfade;
  return next;
}

/**
 * The crossfades through an edit (`after`, made from `previous`; in a drag, `start` is the
 * document when it began): a clip keeps its crossfade while the clip before it is the one it
 * was (or a part of it that ends where it did: a split, a cut), and loses it when another comes
 * before it (moved, deleted, inserted). One that lost it to an earlier step of the same drag
 * gets it back once the clip before it is the one it was. The same document if none changes.
 */
export function keepCrossfades(start: Doc, previous: Doc, after: Doc): Doc {
  if (after === previous) return after;
  const before = (d: Doc, id: ClipId) => {
    const i = d.clips.findIndex((c) => c.id === id);
    return i > 0 ? d.clips[i - 1] : null;
  };
  const same = (a: Clip | null, b: Clip | null) =>
    !!a && !!b && (a.id === b.id || (a.source === b.source && a.out === b.out));
  let changed = false;
  const clips = after.clips.map((c, i) => {
    const prev = i > 0 ? after.clips[i - 1] : null;
    const was = start.clips.find((s) => s.id === c.id);
    let crossfade = c.crossfade ?? 0;
    if (!same(prev, before(start, c.id)) && !same(prev, before(previous, c.id))) crossfade = 0;
    else if (
      !crossfade &&
      was?.crossfade &&
      same(prev, before(start, c.id)) &&
      !same(prev, before(previous, c.id))
    ) {
      crossfade = was.crossfade;
    }
    if (crossfade === (c.crossfade ?? 0)) return c;
    changed = true;
    return withCrossfade(c, crossfade);
  });
  return changed ? { ...after, clips } : after;
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
  /** The files the clips show, first first: the first sets the rate and the frame's size. */
  sources: readonly SourceRef[];
  ranges: readonly Range[];
  nextRangeId: RangeId;
  marks: readonly Mark[];
  nextMarkId: MarkId;
  frame: Frame;
  /** All the sound off, in the preview and the export (which then has no audio). */
  muted: boolean;
}

/** A source `frames` long and `size` as shown, whole: one clip, the full frame. */
export function wholeSource(
  frames: number,
  size: Size = { width: 0, height: 0 },
  id: SourceId = "source",
): Doc {
  return {
    clips: [{ id: 1, source: id, in: 0, out: frames }],
    nextId: 2,
    sources: [{ id, frames }],
    ranges: [],
    nextRangeId: 1,
    marks: [],
    nextMarkId: 1,
    frame: fullFrame(size),
    muted: false,
  };
}

/**
 * Source `id`, `frames` long, added to the timeline whole, as a clip of its own (PLAN 4.5e):
 * before clip `at` (its index; dropped onto a cut), else on the end.
 */
export function addSource(doc: Doc, id: SourceId, frames: number, at?: number | null): Doc {
  if (frames < 1) return doc;
  const sources = doc.sources.some((s) => s.id === id)
    ? doc.sources
    : [...doc.sources, { id, frames }];
  const clip = { id: doc.nextId, source: id, in: 0, out: frames };
  const k = at == null ? doc.clips.length : Math.max(0, Math.min(doc.clips.length, at));
  const clips = [...doc.clips.slice(0, k), clip, ...doc.clips.slice(k)];
  return { ...doc, sources, clips, nextId: doc.nextId + 1 };
}

/** The longest source's length: how long a timecode can get by pulling clips out. */
export function longestSource(doc: Doc): number {
  return Math.max(0, ...doc.sources.map((s) => s.frames));
}

/**
 * The length of the source `clip` shows, in the clip's frames (its grid frames at the clip's
 * speed): how far it can be pulled out.
 */
export function sourceLength(doc: Doc, clip: Clip): number {
  const source = doc.sources.find((s) => s.id === clip.source);
  return source ? retimedLength(clip, source.frames) : clip.out;
}

/** Grows the frame by `grow`. The same document if nothing changes. */
export function setGrow(doc: Doc, grow: Grow): Doc {
  if (sameGrow(grow, doc.frame.grow)) return doc;
  return withFrame(doc, { ...doc.frame, grow });
}

/** Where the source picture's top-left is in the frame (off it, up and left, if cropped). */
const pictureOrigin = (f: Frame) => ({ x: f.grow.left - f.crop.x, y: f.grow.top - f.crop.y });

/**
 * `doc` in `frame`, its markup moved as far as the picture moves in the frame: cropping 280 px
 * off the top moves it 280 px up, growing the left 100 px moves it 100 px right.
 */
function withFrame(doc: Doc, frame: Frame): Doc {
  const was = pictureOrigin(doc.frame);
  const now = pictureOrigin(frame);
  const dx = now.x - was.x;
  const dy = now.y - was.y;
  if (!dx && !dy) return { ...doc, frame };
  const marks = doc.marks.map((m) => ({ ...m, object: movedObject(m.object, dx, dy) }));
  return { ...doc, frame, marks };
}

/** Markup's object moved by (dx, dy), a callout's tip with it. */
function movedObject(o: MarkObject, dx: number, dy: number): MarkObject {
  const moved: Partial<Annotation> = translateAnnotation({ ...o, id: "" } as Annotation, dx, dy);
  delete moved.id;
  return moved as MarkObject;
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
  return withFrame(doc, { ...doc.frame, crop: kept });
}

export const clipLength = (c: Clip) => c.out - c.in;

/** The timeline's length in frames: the clips', less their crossfades. */
export function total(doc: Doc): number {
  const xf = crossfades(doc);
  return doc.clips.reduce((n, c, i) => n + clipLength(c) - xf[i], 0);
}

/** Where each clip starts on the timeline: over the end of the one before, if it crossfades. */
export function clipStarts(doc: Doc): number[] {
  const xf = crossfades(doc);
  let t = 0;
  return doc.clips.map((c, i) => {
    const s = t - xf[i];
    t = s + clipLength(c);
    return s;
  });
}

/**
 * The clip under timeline frame `f`: its index, and where it starts. In a crossfade, the
 * outgoing clip (it plays through it).
 */
export function clipAt(doc: Doc, f: number): { index: number; clip: Clip; start: number } | null {
  const starts = clipStarts(doc);
  for (let index = 0; index < doc.clips.length; index++) {
    const clip = doc.clips[index];
    const start = starts[index];
    if (f >= start && f < start + clipLength(clip)) return { index, clip, start };
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
 * Clip `c` cut in two at its frame `at`: the part before keeps its fade-in, the part after
 * its fade-out (and its id, `id`); at the cut, none, or with `fadeCuts` the fade the whole had
 * at that end. Their colours go with them.
 */
function cutClip(c: Clip, at: number, id: ClipId, fadeCuts: boolean): [Clip, Clip] {
  const colours = fadeColours(c);
  const cutColour = (colour: string) => (fadeCuts ? colour : FADE_BLACK);
  return [
    withFadeColours(
      withFades({ ...c, out: at }, c.fadeIn ?? 0, fadeCuts ? (c.fadeOut ?? 0) : 0),
      colours.fadeIn,
      cutColour(colours.fadeOut),
    ),
    withFadeColours(
      withCrossfade(
        withFades({ ...c, id, in: at }, fadeCuts ? (c.fadeIn ?? 0) : 0, c.fadeOut ?? 0),
        0,
      ),
      cutColour(colours.fadeIn),
      colours.fadeOut,
    ),
  ];
}

/** `c` fading over these (none left out). */
function withFades(c: Clip, fadeIn: number, fadeOut: number): Clip {
  const next = { ...c, ...fades(fadeIn, fadeOut) };
  if (!next.fadeIn) delete next.fadeIn;
  if (!next.fadeOut) delete next.fadeOut;
  return next;
}

/**
 * Splits the clip under timeline frame `f` there: the second part is a new clip. Nothing to
 * split at a clip's first frame (it's already a cut) or past the end: the same document. With
 * `splitMarks`, markup over the cut is split there too, a part on each side: cut clean, or, with
 * `fadeCuts`, each part fading at the cut as the whole did at its ends. The clip's own fades
 * the same way, with `fadeClipCuts` (`cutClip`).
 */
export function split(
  doc: Doc,
  f: number,
  splitMarks = true,
  fadeCuts = false,
  fadeClipCuts = false,
): Doc {
  const at = clipAt(doc, f);
  if (!at || f === at.start || inCrossfade(doc, f)) return doc;
  if (splitMarks) doc = cutMarks(doc, f, f, fadeCuts);
  const cut = at.clip.in + (f - at.start);
  const clips = [...doc.clips];
  clips.splice(at.index, 1, ...cutClip(at.clip, cut, doc.nextId, fadeClipCuts));
  const ranges = handOver(doc.ranges, at.clip.id, doc.nextId, cut);
  const marks = handMarksOver(doc.marks, at.clip.id, doc.nextId, cut);
  return { ...doc, clips, ranges, marks, nextId: doc.nextId + 1 };
}

/**
 * Whether a cut at timeline frame `f` would land in a crossfade (or on its end, which would
 * leave the incoming clip's first part nothing of its own): nothing splits there.
 */
export function inCrossfade(doc: Doc, f: number): boolean {
  const xf = crossfades(doc);
  const starts = clipStarts(doc);
  return xf.some((n, i) => n > 0 && f > starts[i] && f <= starts[i] + n);
}

/**
 * Trims clip `id` to show its frames `in` to `out` (ripple: the clips after it move along).
 * Kept to the source, and to at least one frame: an `in` past the clip's `out` stops a frame
 * before it, and the other way round. The same document if nothing changes.
 */
export function trimClip(doc: Doc, id: ClipId, inF: number, outF: number): Doc {
  const index = doc.clips.findIndex((c) => c.id === id);
  if (index < 0) return doc;
  const old = doc.clips[index];
  const frames = sourceLength(doc, old);
  let a = Math.round(Math.max(0, Math.min(frames - 1, inF)));
  let b = Math.round(Math.max(1, Math.min(frames, outF)));
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
 * Deletes clips `ids` (each as `deleteClip`), one edit. Not all of them: the same document (the
 * timeline keeps a clip).
 */
export function deleteClips(doc: Doc, ids: readonly ClipId[], withRanges = true): Doc {
  if (doc.clips.every((c) => ids.includes(c.id))) return doc;
  return ids.reduce((d, id) => deleteClip(d, id, withRanges), doc);
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

/**
 * Where clips `ids` belong, gathered in their order, when clip `grab` (one of them) is dragged
 * `df` frames in `doc` (the document when the drag started; PLAN 4.5f2): their place among the
 * other clips. The block passes a clip once its leading edge is past that clip's middle, as one
 * clip does (`moveSlot`).
 */
export function moveGroupSlot(doc: Doc, ids: readonly ClipId[], grab: ClipId, df: number): number {
  const g = doc.clips.findIndex((c) => c.id === grab);
  if (g < 0) return -1;
  const starts = clipStarts(doc);
  const picked = (c: Clip) => ids.includes(c.id);
  const length = (cs: readonly Clip[]) => cs.reduce((n, c) => n + clipLength(c), 0);
  // The block's edges: the grabbed clip where it's dragged, the picked ones before it in front.
  const left = starts[g] - length(doc.clips.slice(0, g).filter(picked)) + df;
  const right = left + length(doc.clips.filter(picked));
  let slot = doc.clips.slice(0, g).filter((c) => !picked(c)).length;
  doc.clips.forEach((c, j) => {
    if (picked(c)) return;
    const middle = starts[j] + clipLength(c) / 2;
    if (j > g && right > middle) slot++;
    if (j < g && left < middle) slot--;
  });
  return slot;
}

/**
 * Moves clips `ids` together, gathered in their order, to place `at` among the other clips
 * (clamped); the rest close up. The same document if nothing moves.
 */
export function moveClips(doc: Doc, ids: readonly ClipId[], at: number): Doc {
  const group = doc.clips.filter((c) => ids.includes(c.id));
  if (!group.length) return doc;
  const rest = doc.clips.filter((c) => !ids.includes(c.id));
  const k = Math.max(0, Math.min(rest.length, at));
  const clips = [...rest.slice(0, k), ...group, ...rest.slice(k)];
  return clips.every((c, i) => c === doc.clips[i]) ? doc : { ...doc, clips };
}

/** A clip as copied (Ctrl+C), for `insertClip`: its frames, its speed and its markup. */
export interface ClipCopy {
  source: SourceId;
  in: number;
  out: number;
  speed?: Speed;
  phase?: number;
  sourceOut?: number;
  muted?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  fadeInColour?: string;
  fadeOutColour?: string;
  /** The markup anchored to it. */
  marks: readonly Mark[];
}

/** Clip `id` as a copy, its markup with it (not its ranges); null if there's no such clip. */
export function copyClip(doc: Doc, id: ClipId): ClipCopy | null {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip) return null;
  const marks = doc.marks.filter((m) => m.clip === id);
  const { source, in: a, out: b, speed, phase, sourceOut, muted } = clip;
  return {
    source,
    in: a,
    out: b,
    ...(speed && { speed }),
    ...(phase && { phase }),
    ...(sourceOut !== undefined && { sourceOut }),
    ...(muted && { muted: true }),
    ...fades(clip.fadeIn ?? 0, clip.fadeOut ?? 0),
    ...(clip.fadeInColour && { fadeInColour: clip.fadeInColour }),
    ...(clip.fadeOutColour && { fadeOutColour: clip.fadeOutColour }),
    marks,
  };
}

/**
 * Inserts `copy` as a new clip at position `at` (clamped; the clips from there move along), with
 * copies of its markup (Richard, 2026-10-20), and its fades if `keepFades`.
 */
export function insertClip(doc: Doc, copy: ClipCopy, at: number, keepFades = true): Doc {
  const id = doc.nextId;
  const clips = [...doc.clips];
  const clip = {
    id,
    source: copy.source,
    in: copy.in,
    out: copy.out,
    ...(copy.speed && { speed: copy.speed }),
    ...(copy.phase && { phase: copy.phase }),
    ...(copy.sourceOut !== undefined && { sourceOut: copy.sourceOut }),
    ...(copy.muted && { muted: true }),
    ...(keepFades && fades(copy.fadeIn ?? 0, copy.fadeOut ?? 0)),
    ...(keepFades && copy.fadeInColour && { fadeInColour: copy.fadeInColour }),
    ...(keepFades && copy.fadeOutColour && { fadeOutColour: copy.fadeOutColour }),
  };
  clips.splice(Math.max(0, Math.min(clips.length, at)), 0, clip);
  let nextMarkId = doc.nextMarkId;
  const marks = [...doc.marks, ...copy.marks.map((m) => ({ ...m, id: nextMarkId++, clip: id }))];
  return { ...doc, clips, nextId: id + 1, marks, nextMarkId };
}

/** Inserts `copies` as new clips from position `at` on, in order (`insertClip` each). */
export function insertClips(
  doc: Doc,
  copies: readonly ClipCopy[],
  at: number,
  keepFades = true,
): Doc {
  return copies.reduce((d, copy, k) => insertClip(d, copy, at + k, keepFades), doc);
}

/** Clips `ids` in timeline order, as copies (`copyClip`). */
export function copyClips(doc: Doc, ids: readonly ClipId[]): ClipCopy[] {
  return doc.clips.filter((c) => ids.includes(c.id)).map((c) => copyClip(doc, c.id)!);
}

/**
 * Ctrl+D with several selected: copies of clips `ids`, in timeline order, straight after the last
 * of them. The same document if there are none.
 */
export function duplicateClips(doc: Doc, ids: readonly ClipId[], keepFades = true): Doc {
  const copies = copyClips(doc, ids);
  if (!copies.length) return doc;
  const last = Math.max(...doc.clips.flatMap((c, i) => (ids.includes(c.id) ? [i] : [])));
  return insertClips(doc, copies, last + 1, keepFades);
}

/** Mutes clips `ids`, or unmutes them. */
export function muteClips(doc: Doc, ids: readonly ClipId[], muted: boolean): Doc {
  return ids.reduce((d, id) => muteClip(d, id, muted), doc);
}

/** Mutes clip `id`, or unmutes it. The same document if nothing changes. */
export function muteClip(doc: Doc, id: ClipId, muted: boolean): Doc {
  const index = doc.clips.findIndex((c) => c.id === id);
  if (index < 0 || !!doc.clips[index].muted === muted) return doc;
  const clips = [...doc.clips];
  const next: Clip = { ...clips[index] };
  if (muted) next.muted = true;
  else delete next.muted;
  clips[index] = next;
  return { ...doc, clips };
}

/**
 * Clip `id` fades in over `fadeIn` frames, or out over `fadeOut` (whichever is given), kept to
 * whole frames and to what its length leaves after the other, as markup's (`setMarkFades`). The
 * same document if nothing changes.
 */
export function setClipFades(
  doc: Doc,
  id: ClipId,
  set: { fadeIn: number } | { fadeOut: number },
): Doc {
  const index = doc.clips.findIndex((c) => c.id === id);
  if (index < 0) return doc;
  const old = doc.clips[index];
  const length = clipLength(old);
  const now = clipFades(old);
  const fit = (v: number, other: number) => Math.max(0, Math.min(length - other, Math.round(v)));
  const next =
    "fadeIn" in set
      ? { fadeIn: fit(set.fadeIn, now.fadeOut), fadeOut: now.fadeOut }
      : { fadeIn: now.fadeIn, fadeOut: fit(set.fadeOut, now.fadeIn) };
  if (next.fadeIn === now.fadeIn && next.fadeOut === now.fadeOut) return doc;
  const clips = [...doc.clips];
  clips[index] = withFades(old, next.fadeIn, next.fadeOut);
  return { ...doc, clips };
}

/**
 * Clips `ids` given a fade of `frames` (the default clip fade; 0 removes it, and its colour) at
 * their start, end or both, as markup's (`fadeEnds`).
 */
export function fadeClipEnds(
  doc: Doc,
  ids: readonly ClipId[],
  frames: number,
  ends: "both" | "in" | "out",
): Doc {
  if (frames <= 0) doc = setClipFadeColours(doc, ids, FADE_BLACK, ends);
  return doc.clips
    .filter((c) => ids.includes(c.id))
    .reduce((d, c) => {
      if (ends === "in") return setClipFades(d, c.id, { fadeIn: frames });
      if (ends === "out") return setClipFades(d, c.id, { fadeOut: frames });
      const half = Math.floor(clipLength(c) / 2);
      const cleared = setClipFades(d, c.id, { fadeOut: 0 });
      const faded = setClipFades(cleared, c.id, { fadeIn: Math.min(frames, half) });
      return setClipFades(faded, c.id, { fadeOut: frames });
    }, doc);
}

/**
 * Clips `ids` fading in over `fadeIn` frames and out over `fadeOut` (Paste Fades), as markup's,
 * from and to `colours` (black if not given: markup's fades have none).
 */
export function setClipsFades(
  doc: Doc,
  ids: readonly ClipId[],
  fadeIn: number,
  fadeOut: number,
  colours: { fadeIn?: string; fadeOut?: string } = {},
): Doc {
  const faded = ids.reduce(
    (d, id) =>
      setClipFades(setClipFades(setClipFades(d, id, { fadeOut: 0 }), id, { fadeIn }), id, {
        fadeOut,
      }),
    doc,
  );
  const coloured = setClipFadeColours(faded, ids, colours.fadeIn ?? FADE_BLACK, "in");
  return setClipFadeColours(coloured, ids, colours.fadeOut ?? FADE_BLACK, "out");
}

/** Mutes all the sound, or unmutes it. The same document if nothing changes. */
export function muteTrack(doc: Doc, muted: boolean): Doc {
  return doc.muted === muted ? doc : { ...doc, muted };
}

/** Ctrl+D: a copy of clip `id` straight after it. The same document if there's no such clip. */
export function duplicateClip(doc: Doc, id: ClipId, keepFades = true): Doc {
  const copy = copyClip(doc, id);
  if (!copy) return doc;
  return insertClip(doc, copy, doc.clips.findIndex((c) => c.id === id) + 1, keepFades);
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

/** Clip `from` was cut at its frame `at`: the pieces past it now belong to clip `to`. */
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
 * middle becomes two: the second part a new clip. A crossfade a stretch reaches into goes
 * (PLAN 4.7b), and the stretch takes in as much more of what comes after it, which that moves
 * along. Nothing left at all: the same document.
 */
function cutOut(
  doc: Doc,
  places: readonly Place[],
  splitMarks: boolean,
  fadeCuts: boolean,
  fadeClipCuts: boolean,
): Doc {
  let nextId = doc.nextId;
  let clips: readonly Clip[] = doc.clips;
  let marks = doc.marks;
  let nextMarkId = doc.nextMarkId;
  // From the end, so the earlier places stay where they are.
  for (const place of [...places].sort((x, y) => y.a - x.a)) {
    const { a } = place;
    let { b } = place;
    const xf = crossfades({ ...doc, clips });
    const xs = clipStarts({ ...doc, clips });
    clips = clips.map((c, i) => {
      if (!xf[i] || a >= xs[i] + xf[i] || b <= xs[i]) return c;
      b += xf[i];
      return withCrossfade(c, 0);
    });
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
      if (a > s && b < e) {
        // Cut out of its middle: two parts (`cutClip`), the markup after the cut going with
        // the second.
        const cut = c.in + (b - s);
        const [left, right] = cutClip(c, cut, nextId, fadeClipCuts);
        marks = handMarksOver(marks, c.id, nextId++, cut);
        out.push({ ...left, out: c.in + (a - s) }, right);
      } else if (a > s) out.push({ ...c, out: c.in + (a - s) });
      else if (b < e) out.push({ ...c, in: c.in + (b - s) });
    });
    clips = out;
  }
  if (clips.length === 0) return doc;
  return { ...doc, clips, nextId, ranges: [], marks, nextMarkId };
}

/**
 * Removes the ranges' frames (ripple), and the ranges. Not all of it: the same document. With
 * `splitMarks`, markup over a cut is cut there too (`fadeCuts` and `fadeClipCuts` as for
 * `split`).
 */
export function removeRanges(
  doc: Doc,
  splitMarks = true,
  fadeCuts = false,
  fadeClipCuts = false,
): Doc {
  const shown = shownRanges(doc);
  return shown.length ? cutOut(doc, shown, splitMarks, fadeCuts, fadeClipCuts) : doc;
}

/** Keeps only the ranges' frames (ripple), and clears the ranges. `splitMarks` as above. */
export function keepRanges(
  doc: Doc,
  splitMarks = true,
  fadeCuts = false,
  fadeClipCuts = false,
): Doc {
  const shown = shownRanges(doc).sort((x, y) => x.a - y.a);
  if (!shown.length) return doc;
  const gaps: Place[] = [];
  let t = 0;
  for (const { a, b } of shown) {
    if (a > t) gaps.push({ a: t, b: a });
    t = Math.max(t, b);
  }
  if (t < total(doc)) gaps.push({ a: t, b: total(doc) });
  return gaps.length
    ? cutOut(doc, gaps, splitMarks, fadeCuts, fadeClipCuts)
    : { ...doc, ranges: [] };
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

/** The video at timeline frame `f`, as an anchor: its clip and the clip's frame. */
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
  if (index < 0 || !canFade(doc.marks[index].object)) return doc;
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

/** Clip `from` was cut at its frame `at`: markup starting past it now belongs to clip `to`. */
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
 * Several markup items' starts (or ends) moved `df` frames together, as one is dragged (Richard,
 * 2026-10-23): each goes as far towards that as it can, stopped by the item next to it in its
 * lane, the timeline's start or end, or a frame's length, the rest going on. Their places, from
 * where they are in `doc` (the document when the drag started).
 */
export function resizeEdges(
  doc: Doc,
  ids: readonly MarkId[],
  edge: "start" | "end",
  df: number,
): { id: MarkId; start: number; end: number; lane: number }[] {
  const shown = shownMarks(doc);
  const length = total(doc);
  return shown
    .filter((m) => ids.includes(m.id))
    .map(({ id, start, end, lane }) => {
      const others = shown.filter((o) => o.id !== id && o.lane === lane);
      if (edge === "start") {
        const lo = Math.max(0, ...others.filter((o) => o.end <= start).map((o) => o.end));
        return { id, start: Math.max(lo, Math.min(end - 1, start + df)), end, lane };
      }
      const hi = Math.min(length, ...others.filter((o) => o.start >= end).map((o) => o.start));
      return { id, start, end: Math.min(hi, Math.max(start + 1, end + df)), lane };
    });
}

/**
 * Clean up timeline (Richard, 2026-10-23): the lanes closed up as far as they go. Each item,
 * the front lanes' first, goes up to the first lane below everything it overlaps in time that's
 * in front of it, so nothing changes its frames, or its order front to back against what it
 * overlaps, and nothing goes down. Hidden markup keeps its lane. The same document if nothing
 * moves.
 */
export function packLanes(doc: Doc): Doc {
  const order = shownMarks(doc).sort((a, b) => a.lane - b.lane || a.start - b.start);
  const placed: { start: number; end: number; lane: number }[] = [];
  const lanes = new Map<MarkId, number>();
  for (const m of order) {
    const over = placed.filter((p) => p.start < m.end && m.start < p.end);
    const lane = over.length ? Math.max(...over.map((p) => p.lane)) + 1 : 0;
    placed.push({ start: m.start, end: m.end, lane });
    lanes.set(m.id, lane);
  }
  let changed = false;
  const marks = doc.marks.map((m) => {
    const lane = lanes.get(m.id);
    if (lane === undefined || lane === m.lane) return m;
    changed = true;
    return { ...m, lane };
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
