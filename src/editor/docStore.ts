// The edit document's store: the current Doc plus undo/redo history (as Vandal's).
//
// History keeps whole Doc snapshots. Docs are immutable and edits share unchanged parts, so a
// snapshot costs about one array of references.
//
// Every edit is one undo step. A drag is wrapped in beginGesture/endGesture so all its
// intermediate updates become a single step; edits that change nothing add nothing to history.
// Gestures nest: a popover's edits (the speed popover's, its fields dragged too) are one step,
// or all cancelled.
//
// After an edit of the clips, the ranges and markup follow their video (each range kept in one
// place), or, with Settings › Timeline › "Ranges and markup follow their video" off, stay where
// they were on the timeline (where they were when the drag started, for a drag). After any
// edit, a clip with another clip before it now loses its crossfade (`keepCrossfades`).

import { create } from "zustand";
import {
  addMark,
  addRange,
  addSource,
  deleteClips,
  duplicateClips,
  insertClips,
  muteClips,
  packLanes,
  moveClips,
  fadeEnds,
  fadeClipEnds,
  keepCrossfades,
  setCrossfade,
  setClipFades,
  setClipsFades,
  setClipFadeColours,
  deleteClip,
  deleteMarks,
  deleteRange,
  dropMark,
  duplicateClip,
  insertClip,
  keepRanges,
  keepRangesInPlace,
  moveClip,
  muteClip,
  muteTrack,
  removeRanges,
  separateRanges,
  setCrop,
  setGrow,
  setMark,
  setFades,
  setMarkFades,
  placeMarks,
  stepLane,
  settleLanes,
  setMarkObject,
  setRange,
  shownMarks,
  shownRanges,
  split,
  trimClip,
  wholeSource,
  type ClipCopy,
  type ClipId,
  type Doc,
  type MarkId,
  type MarkObject,
  type RangeId,
  type SourceId,
} from "./doc";
import type { Rect, Size } from "./fit";
import type { RecordedInput } from "../shared/ipc";
import { withRecordedClicks, type RecordedClickStyle } from "./recordedInput";
import { restyleClicks, type ClickFrames, type ClickStyle } from "./clickStyles";
import type { Grow } from "./frame";
import { setClipSpeed, setClipsSpeed, type Speed } from "./speed";

/** Oldest steps are dropped beyond this. */
export const HISTORY_LIMIT = 200;

/** Settings › Timeline: how ranges and markup take edits of the clips. */
export interface RangeOptions {
  /** Ranges and markup follow their video (else they keep their place on the timeline). */
  follow: boolean;
  /** Deleting a clip deletes the ranges and markup on it (else they're kept, hidden). */
  deleteWithClip: boolean;
  /** Splitting a clip, or cutting ranges out, splits the markup over the cut. */
  splitMarks: boolean;
  /** ...and each part fades at the cut as the whole did at its ends (else the cut is clean). */
  fadeCuts: boolean;
  /** The fade Apply Default Fades gives markup, in frames. */
  defaultFade: number;
  /** Markup and clips duplicated, Alt-dragged or pasted keep the original's fades (else none). */
  copyFades: boolean;
  /** The fade Apply Default Fades gives clips, in frames (PLAN 4.7a). */
  defaultClipFade: number;
  /** A clip split (or cut by ranges) fades at the cut as the whole did at its ends. */
  fadeClipCuts: boolean;
  /** A clip's speed changed, the markup on it stretches with it (while it follows its video). */
  stretchMarks: boolean;
}

export interface DocState {
  doc: Doc;
  past: Doc[];
  future: Doc[];
  /** The Doc when the current gesture began, or null outside a gesture. */
  gestureStart: Doc | null;
  /**
   * The selected clip, range or markup (one or none). Not part of history; cleared if an edit,
   * undo or redo takes it away.
   */
  selected: ClipId | null;
  /**
   * The selected clips (several at once, PLAN 4.5f), `selected` among them: the one a single
   * clip's action (a trim, a split) takes.
   */
  selectedClips: readonly ClipId[];
  selectedRange: RangeId | null;
  /** The selected markup (several at once, as Vandal's selection). */
  selectedMarks: readonly MarkId[];
  /** I pressed, O not yet: the in-point of the range to come, a timeline frame. */
  pendingIn: number | null;
  options: RangeOptions;

  /**
   * Starts editing a new source, `frames` long and `size` as shown (named `id`): one clip, no
   * history.
   */
  load: (frames: number, size?: Size, id?: SourceId) => void;
  /** Source `id`, `frames` long, on the end of the timeline (PLAN 4.5e): one undo step. */
  addSource: (id: SourceId, frames: number, at?: number | null) => boolean;
  /** Splits the clip under timeline frame `f`. False if there was nothing to split. */
  split: (f: number) => boolean;
  /** Deletes clip `id` (ripple). False if it can't (the last clip). */
  remove: (id: ClipId) => boolean;
  /** Moves clip `id` to position `to`. */
  move: (id: ClipId, to: number) => boolean;
  /** Trims clip `id` to its frames `in` to `out` (ripple). */
  trim: (id: ClipId, inF: number, outF: number) => boolean;
  /** Clips `ids` at speed `to` (ripple; PLAN §7, Clip speed). */
  setSpeed: (ids: readonly ClipId[], to: Speed) => boolean;
  /** Clip `id` retimed to last `length` frames (ripple). */
  setDuration: (id: ClipId, length: number) => boolean;
  /** A copy of clip `id` straight after it, selected; its id, or null. */
  duplicate: (id: ClipId) => ClipId | null;
  /** Inserts `copy` as a new clip at position `at`, selected; its id. */
  paste: (copy: ClipCopy, at: number) => ClipId | null;
  /** Mutes clip `id`, or unmutes it. */
  muteClip: (id: ClipId, muted: boolean) => boolean;
  /** Several clips at once (PLAN 4.5f): one undo step each. Never every clip. */
  removeClips: (ids: readonly ClipId[]) => boolean;
  /** Copies of clips `ids` after the last of them, selected; their ids. */
  duplicateClips: (ids: readonly ClipId[]) => ClipId[];
  /** Inserts `copies` from position `at` on, selected; their ids. */
  pasteClips: (copies: readonly ClipCopy[], at: number) => ClipId[];
  muteClips: (ids: readonly ClipId[], muted: boolean) => boolean;
  /** Moves clips `ids` together (gathered, in order) to place `at` among the others. */
  moveClips: (ids: readonly ClipId[], at: number) => boolean;
  /** Mutes all the sound, or unmutes it. */
  muteTrack: (muted: boolean) => boolean;
  /** Clip `id` fades in from black over so many frames, or out to it (PLAN 4.7a). */
  setClipFades: (id: ClipId, set: { fadeIn: number } | { fadeOut: number }) => boolean;
  /** Clips `ids` given the default clip fade (Settings) at one end or both. */
  clipDefaultFades: (ids: readonly ClipId[], ends: "both" | "in" | "out") => boolean;
  /** Clips `ids`'s fades removed at one end or both. */
  clipRemoveFades: (ids: readonly ClipId[], ends: "both" | "in" | "out") => boolean;
  /** Clips `ids` fading in and out over these (Paste Fades). */
  setClipsFades: (
    ids: readonly ClipId[],
    fadeIn: number,
    fadeOut: number,
    colours?: { fadeIn?: string; fadeOut?: string },
  ) => boolean;
  /** The selected clips' fades from and to `colour` (4.7c), at an end or both. */
  setClipFadeColours: (
    ids: readonly ClipId[],
    colour: string,
    ends: "both" | "in" | "out",
  ) => boolean;
  /** Clip `id` crossfades with the one before it over so many frames (0: none; PLAN 4.7b). */
  setCrossfade: (id: ClipId, frames: number) => boolean;

  /** Adds a range over timeline frames `a` to `b` and selects it; its id, or null. */
  addRange: (a: number, b: number) => RangeId | null;
  /** Moves or resizes range `id` to timeline frames `a` to `b`. */
  setRange: (id: RangeId, a: number, b: number) => boolean;
  removeRange: (id: RangeId) => boolean;
  /** Keep only the ranges' frames, or cut them out (ripple); the ranges go. */
  keepRanges: () => boolean;
  removeRanges: () => boolean;
  setPendingIn: (f: number | null) => void;

  /** Adds markup showing `object` at timeline frame `start`, `length` frames long; its id. */
  addMark: (object: MarkObject, start: number, length: number, lane: number) => MarkId | null;
  /** A recording's clicks as click marks on clip `clip` (PLAN 5b.6b): one undo step. */
  addRecordedClicks: (
    clip: ClipId,
    input: RecordedInput,
    fps: number,
    size: Size,
    style: RecordedClickStyle,
  ) => boolean;
  /** Every click mark in `style`, and with `timing` that long and fading so (PLAN 5b.6h): one
   *  undo step. */
  restyleClicks: (style: ClickStyle, timing?: ClickFrames) => boolean;
  /** Moves or resizes markup `id` to timeline frames `start` to `end`, in `lane`. */
  setMark: (id: MarkId, start: number, end: number, lane: number) => boolean;
  /** Markup `id` shows `object` now (moved, resized or restyled on the preview). */
  setMarkObject: (id: MarkId, object: MarkObject) => boolean;
  /**
   * Markup moved together (a drag of several): each to its place, from where all of them were
   * when the gesture began, as one block (`placeMarks`).
   */
  placeMarks: (
    places: readonly { id: MarkId; start: number; end: number; lane: number }[],
  ) => boolean;
  /** Markup `ids` given the default fade (Settings) at one end or both: `fadeEnds`. */
  defaultFades: (ids: readonly MarkId[], ends: "both" | "in" | "out") => boolean;
  /** Markup `ids` fading in and out over these (`setFades`: Paste Fades). */
  setFades: (ids: readonly MarkId[], fadeIn: number, fadeOut: number) => boolean;
  /** Markup `ids`'s fades removed at one end or both. */
  removeFades: (ids: readonly MarkId[], ends: "both" | "in" | "out") => boolean;
  /** Markup dragged to `start`–`end` and dropped on `lane` (`dropMark`: between busy lanes). */
  dropMark: (id: MarkId, start: number, end: number, lane: number, below: boolean) => boolean;
  /** Markup a lane up (-1, forward) or down (1, backward): see `stepLane`. */
  stepMark: (id: MarkId, dir: -1 | 1) => boolean;
  /** Markup `id` fades in over so many frames, or out. */
  setMarkFades: (id: MarkId, set: { fadeIn: number } | { fadeOut: number }) => boolean;
  /**
   * Several markup items' edges dragged together (`resizeEdges`): each to its place, in its
   * lane, which they fit without settling.
   */
  resizeMarks: (
    places: readonly { id: MarkId; start: number; end: number; lane: number }[],
  ) => boolean;
  /** Clean up timeline: the markup's lanes closed up as far as they go (`packLanes`). */
  packLanes: () => boolean;
  removeMark: (id: MarkId) => boolean;
  removeMarks: (ids: readonly MarkId[]) => boolean;

  /** Crops to `crop` (kept to the source). */
  crop: (crop: Rect) => boolean;
  /** Grows the frame by `grow`. */
  grow: (grow: Grow) => boolean;

  beginGesture: () => void;
  endGesture: () => void;
  /** Abandons the gesture and restores the Doc from before it. */
  cancelGesture: () => void;

  undo: () => void;
  redo: () => void;

  select: (id: ClipId | null) => void;
  /** Selects clips `ids`; the last is `selected`. */
  selectClips: (ids: readonly ClipId[]) => void;
  selectRange: (id: RangeId | null) => void;
  selectMarks: (ids: readonly MarkId[]) => void;
  setOptions: (options: RangeOptions) => void;
}

export function canUndo(s: DocState): boolean {
  return s.past.length > 0 && s.gestureStart === null;
}

export function canRedo(s: DocState): boolean {
  return s.future.length > 0 && s.gestureStart === null;
}

export const useDoc = create<DocState>()((set, get) => {
  /** How many gestures are open: they nest, and the outermost makes the step (or cancels). */
  let gestures = 0;

  /**
   * Applies a pure edit as one history step (or as part of the current gesture), with the
   * markup's lanes settled after it (`settleLanes`): `yielding`, what it moved or added, gives
   * way to the rest.
   */
  const apply = (edit: (doc: Doc) => Doc, yielding: readonly MarkId[] = []): boolean => {
    const s = get();
    const doc = settleLanes(keepCrossfades(s.gestureStart ?? s.doc, s.doc, edit(s.doc)), yielding);
    if (doc === s.doc) return false;
    if (s.gestureStart) set({ doc });
    else set({ doc, past: pushLimited(s.past, s.doc), future: [] });
    prune();
    return true;
  };

  /** An edit of the clips: the ranges follow their video, or keep their place. */
  const applyClips = (edit: (doc: Doc) => Doc): boolean =>
    apply((doc) => {
      const after = edit(doc);
      if (after === doc) return doc;
      const { options, gestureStart } = get();
      if (options.follow) return separateRanges(after);
      // In a drag, from where the ranges and markup were when it started (a drag's steps only
      // move clips).
      if (!gestureStart) return keepRangesInPlace(doc, after);
      return keepRangesInPlace(gestureStart, {
        ...after,
        ranges: gestureStart.ranges,
        marks: gestureStart.marks,
      });
    });

  /** A clip was added (or not): it's selected; its id. */
  const added = (ok: boolean): ClipId | null => {
    if (!ok) return null;
    const id = get().doc.nextId - 1;
    set({ selected: id, selectedClips: [id], selectedRange: null, selectedMarks: [] });
    return id;
  };

  /** Clips were added (or not): they're selected; their ids. */
  const addedMany = (ok: boolean, n: number): ClipId[] => {
    if (!ok) return [];
    const next = get().doc.nextId;
    const ids = Array.from({ length: n }, (_, k) => next - n + k);
    set({
      selected: ids[n - 1] ?? null,
      selectedClips: ids,
      selectedRange: null,
      selectedMarks: [],
    });
    return ids;
  };

  /** The selection, if what's selected is gone (or hidden). */
  const prune = () => {
    const { doc, selected, selectedClips, selectedRange, selectedMarks } = get();
    if (selectedMarks.length) {
      const shown = new Set(shownMarks(doc).map((m) => m.id));
      const kept = selectedMarks.filter((id) => shown.has(id));
      if (kept.length !== selectedMarks.length) set({ selectedMarks: kept });
    }
    const there = (id: ClipId) => doc.clips.some((c) => c.id === id);
    if (selectedClips.some((id) => !there(id))) {
      const kept = selectedClips.filter(there);
      set({
        selectedClips: kept,
        selected: there(selected!) ? selected : (kept[kept.length - 1] ?? null),
      });
    } else if (selected !== null && !there(selected)) set({ selected: null });
    if (selectedRange !== null && !shownRanges(doc).some((r) => r.id === selectedRange)) {
      set({ selectedRange: null });
    }
  };

  return {
    doc: wholeSource(0),
    past: [],
    future: [],
    gestureStart: null,
    selected: null,
    selectedClips: [],
    selectedRange: null,
    selectedMarks: [],
    pendingIn: null,
    options: {
      follow: true,
      deleteWithClip: true,
      splitMarks: true,
      fadeCuts: false,
      defaultFade: 15,
      copyFades: true,
      defaultClipFade: 15,
      fadeClipCuts: false,
      stretchMarks: true,
    },

    load: (frames, size, id) => {
      gestures = 0;
      set({
        doc: wholeSource(frames, size, id),
        past: [],
        future: [],
        gestureStart: null,
        selected: null,
        selectedClips: [],
        selectedRange: null,
        selectedMarks: [],
        pendingIn: null,
      });
    },

    split: (f) => {
      const { splitMarks, fadeCuts, fadeClipCuts } = get().options;
      return applyClips((doc) => split(doc, f, splitMarks, fadeCuts, fadeClipCuts));
    },
    remove: (id) => applyClips((doc) => deleteClip(doc, id, get().options.deleteWithClip)),
    move: (id, to) => applyClips((doc) => moveClip(doc, id, to)),
    trim: (id, inF, outF) => applyClips((doc) => trimClip(doc, id, inF, outF)),
    setSpeed: (ids, to) => {
      const { follow, stretchMarks } = get().options;
      return applyClips((doc) => setClipsSpeed(doc, ids, to, follow && stretchMarks));
    },
    setDuration: (id, length) => {
      const { follow, stretchMarks } = get().options;
      return applyClips((doc) => setClipSpeed(doc, id, { length }, follow && stretchMarks));
    },
    duplicate: (id) => added(applyClips((doc) => duplicateClip(doc, id, get().options.copyFades))),
    paste: (copy, at) =>
      added(applyClips((doc) => insertClip(doc, copy, at, get().options.copyFades))),
    muteClip: (id, muted) => apply((doc) => muteClip(doc, id, muted)),
    removeClips: (ids) => applyClips((doc) => deleteClips(doc, ids, get().options.deleteWithClip)),
    duplicateClips: (ids) => {
      const n = get().doc.clips.filter((c) => ids.includes(c.id)).length;
      return addedMany(
        applyClips((doc) => duplicateClips(doc, ids, get().options.copyFades)),
        n,
      );
    },
    pasteClips: (copies, at) =>
      addedMany(
        applyClips((doc) => insertClips(doc, copies, at, get().options.copyFades)),
        copies.length,
      ),
    muteClips: (ids, muted) => apply((doc) => muteClips(doc, ids, muted)),
    moveClips: (ids, at) => applyClips((doc) => moveClips(doc, ids, at)),
    muteTrack: (muted) => apply((doc) => muteTrack(doc, muted)),
    setClipFades: (id, set) => apply((doc) => setClipFades(doc, id, set)),
    clipDefaultFades: (ids, ends) =>
      apply((doc) => fadeClipEnds(doc, ids, get().options.defaultClipFade, ends)),
    clipRemoveFades: (ids, ends) => apply((doc) => fadeClipEnds(doc, ids, 0, ends)),
    setClipsFades: (ids, fadeIn, fadeOut, colours) =>
      apply((doc) => setClipsFades(doc, ids, fadeIn, fadeOut, colours)),
    setClipFadeColours: (ids, colour, ends) =>
      apply((doc) => setClipFadeColours(doc, ids, colour, ends)),
    // It moves what comes after: ranges and markup follow, or keep their place.
    setCrossfade: (id, frames) => applyClips((doc) => setCrossfade(doc, id, frames)),

    addRange: (a, b) => {
      const id = get().doc.nextRangeId;
      if (!apply((doc) => addRange(doc, a, b))) return null;
      set({ selected: null, selectedClips: [], selectedRange: id, selectedMarks: [] });
      return id;
    },
    setRange: (id, a, b) => apply((doc) => setRange(doc, id, a, b)),
    removeRange: (id) => apply((doc) => deleteRange(doc, id)),
    keepRanges: () => {
      const { splitMarks, fadeCuts, fadeClipCuts } = get().options;
      return apply((doc) => keepRanges(doc, splitMarks, fadeCuts, fadeClipCuts));
    },
    removeRanges: () => {
      const { splitMarks, fadeCuts, fadeClipCuts } = get().options;
      return apply((doc) => removeRanges(doc, splitMarks, fadeCuts, fadeClipCuts));
    },
    setPendingIn: (f) => set({ pendingIn: f }),

    addMark: (object, start, length, lane) => {
      const id = get().doc.nextMarkId;
      return apply((doc) => addMark(doc, object, start, length, lane), [id]) ? id : null;
    },
    addRecordedClicks: (clip, input, fps, size, style) =>
      apply((doc) => withRecordedClicks(doc, clip, input, fps, size, style)),
    restyleClicks: (style, timing) => apply((doc) => restyleClicks(doc, style, timing)),
    setMark: (id, start, end, lane) => apply((doc) => setMark(doc, id, start, end, lane), [id]),
    setMarkObject: (id, object) => apply((doc) => setMarkObject(doc, id, object)),
    stepMark: (id, dir) => apply((doc) => stepLane(doc, id, dir)),
    addSource: (id, frames, at) => apply((doc) => addSource(doc, id, frames, at)),
    dropMark: (id, start, end, lane, below) =>
      apply((doc) => dropMark(doc, id, start, end, lane, below)),
    defaultFades: (ids, ends) =>
      apply((doc) => fadeEnds(doc, ids, get().options.defaultFade, ends)),
    removeFades: (ids, ends) => apply((doc) => fadeEnds(doc, ids, 0, ends)),
    setFades: (ids, fadeIn, fadeOut) => apply((doc) => setFades(doc, ids, fadeIn, fadeOut)),
    placeMarks: (places) =>
      apply(
        (doc) => {
          // From where they were as the gesture began; markup it added (copies being dragged)
          // as it is now.
          const start = get().gestureStart;
          if (!start) return placeMarks(doc, places);
          const before = new Set(start.marks.map((m) => m.id));
          const added = doc.marks.filter((m) => !before.has(m.id));
          return placeMarks({ ...doc, marks: [...start.marks, ...added] }, places);
        },
        places.map((p) => p.id),
      ),
    setMarkFades: (id, set) => apply((doc) => setMarkFades(doc, id, set)),
    packLanes: () => apply(packLanes),
    resizeMarks: (places) =>
      apply((doc) => places.reduce((d, p) => setMark(d, p.id, p.start, p.end, p.lane), doc)),
    removeMark: (id) => apply((doc) => deleteMarks(doc, [id])),
    removeMarks: (ids) => apply((doc) => deleteMarks(doc, ids)),
    crop: (crop) => apply((doc) => setCrop(doc, crop)),
    grow: (grow) => apply((doc) => setGrow(doc, grow)),

    beginGesture: () => {
      gestures++;
      if (!get().gestureStart) set({ gestureStart: get().doc });
    },
    endGesture: () => {
      // Inside another (a field dragged in the speed popover): the outer one ends it.
      gestures = Math.max(0, gestures - 1);
      if (gestures > 0) return;
      const { gestureStart: start, doc, past } = get();
      if (!start) return;
      if (doc === start) set({ gestureStart: null });
      else set({ gestureStart: null, past: pushLimited(past, start), future: [] });
    },
    cancelGesture: () => {
      gestures = 0;
      const start = get().gestureStart;
      if (!start) return;
      set({ doc: start, gestureStart: null });
      prune();
    },

    undo: () => {
      const s = get();
      if (!canUndo(s)) return;
      set({
        doc: s.past[s.past.length - 1],
        past: s.past.slice(0, -1),
        future: [s.doc, ...s.future],
      });
      prune();
    },
    redo: () => {
      const s = get();
      if (!canRedo(s)) return;
      set({ doc: s.future[0], past: pushLimited(s.past, s.doc), future: s.future.slice(1) });
      prune();
    },

    // One thing selected at a time: either null selects nothing.
    select: (id) =>
      set({
        selected: id,
        selectedClips: id === null ? [] : [id],
        selectedRange: null,
        selectedMarks: [],
      }),
    selectClips: (ids) => {
      const unique = [...new Set(ids)];
      set({
        selected: unique[unique.length - 1] ?? null,
        selectedClips: unique,
        selectedRange: null,
        selectedMarks: [],
      });
    },
    selectRange: (id) =>
      set({ selectedRange: id, selected: null, selectedClips: [], selectedMarks: [] }),
    selectMarks: (ids) =>
      set({
        selectedMarks: [...new Set(ids)],
        selected: null,
        selectedClips: [],
        selectedRange: null,
      }),
    setOptions: (options) => set({ options }),
  };
});

function pushLimited(past: Doc[], doc: Doc): Doc[] {
  const next = [...past, doc];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}
