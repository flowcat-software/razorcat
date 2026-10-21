// The edit document's store: the current Doc plus undo/redo history (as Vandal's).
//
// History keeps whole Doc snapshots. Docs are immutable and edits share unchanged parts, so a
// snapshot costs about one array of references.
//
// Every edit is one undo step. A drag is wrapped in beginGesture/endGesture so all its
// intermediate updates become a single step; edits that change nothing add nothing to history.
//
// After an edit of the clips, the ranges and markup follow their video (each range kept in one
// place), or, with Settings › Timeline › "Ranges and markup follow their video" off, stay where
// they were on the timeline (where they were when the drag started, for a drag).

import { create } from "zustand";
import {
  addMark,
  addRange,
  fadeEnds,
  deleteClip,
  deleteMarks,
  deleteRange,
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
} from "./doc";
import type { Rect, Size } from "./fit";
import type { Grow } from "./frame";

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
  selectedRange: RangeId | null;
  /** The selected markup (several at once, as Vandal's selection). */
  selectedMarks: readonly MarkId[];
  /** I pressed, O not yet: the in-point of the range to come, a timeline frame. */
  pendingIn: number | null;
  options: RangeOptions;

  /** Starts editing a new source, `frames` long and `size` as shown: one clip, no history. */
  load: (frames: number, size?: Size) => void;
  /** Splits the clip under timeline frame `f`. False if there was nothing to split. */
  split: (f: number) => boolean;
  /** Deletes clip `id` (ripple). False if it can't (the last clip). */
  remove: (id: ClipId) => boolean;
  /** Moves clip `id` to position `to`. */
  move: (id: ClipId, to: number) => boolean;
  /** Trims clip `id` to source frames `in` to `out` (ripple). */
  trim: (id: ClipId, inF: number, outF: number) => boolean;
  /** A copy of clip `id` straight after it, selected; its id, or null. */
  duplicate: (id: ClipId) => ClipId | null;
  /** Inserts `copy` as a new clip at position `at`, selected; its id. */
  paste: (copy: ClipCopy, at: number) => ClipId | null;
  /** Mutes clip `id`, or unmutes it. */
  muteClip: (id: ClipId, muted: boolean) => boolean;
  /** Mutes all the sound, or unmutes it. */
  muteTrack: (muted: boolean) => boolean;

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
  /** Markup `ids`'s fades removed at one end or both. */
  removeFades: (ids: readonly MarkId[], ends: "both" | "in" | "out") => boolean;
  /** Markup a lane up (-1, forward) or down (1, backward): see `stepLane`. */
  stepMark: (id: MarkId, dir: -1 | 1) => boolean;
  /** Markup `id` fades in over so many frames, or out. */
  setMarkFades: (id: MarkId, set: { fadeIn: number } | { fadeOut: number }) => boolean;
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
  /**
   * Applies a pure edit as one history step (or as part of the current gesture), with the
   * markup's lanes settled after it (`settleLanes`): `yielding`, what it moved or added, gives
   * way to the rest.
   */
  const apply = (edit: (doc: Doc) => Doc, yielding: readonly MarkId[] = []): boolean => {
    const s = get();
    const doc = settleLanes(edit(s.doc), yielding);
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
    set({ selected: id, selectedRange: null, selectedMarks: [] });
    return id;
  };

  /** The selection, if what's selected is gone (or hidden). */
  const prune = () => {
    const { doc, selected, selectedRange, selectedMarks } = get();
    if (selectedMarks.length) {
      const shown = new Set(shownMarks(doc).map((m) => m.id));
      const kept = selectedMarks.filter((id) => shown.has(id));
      if (kept.length !== selectedMarks.length) set({ selectedMarks: kept });
    }
    if (selected !== null && !doc.clips.some((c) => c.id === selected)) set({ selected: null });
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
    selectedRange: null,
    selectedMarks: [],
    pendingIn: null,
    options: {
      follow: true,
      deleteWithClip: true,
      splitMarks: true,
      fadeCuts: false,
      defaultFade: 15,
    },

    load: (frames, size) =>
      set({
        doc: wholeSource(frames, size),
        past: [],
        future: [],
        gestureStart: null,
        selected: null,
        selectedRange: null,
        selectedMarks: [],
        pendingIn: null,
      }),

    split: (f) => {
      const { splitMarks, fadeCuts } = get().options;
      return applyClips((doc) => split(doc, f, splitMarks, fadeCuts));
    },
    remove: (id) => applyClips((doc) => deleteClip(doc, id, get().options.deleteWithClip)),
    move: (id, to) => applyClips((doc) => moveClip(doc, id, to)),
    trim: (id, inF, outF) => applyClips((doc) => trimClip(doc, id, inF, outF)),
    duplicate: (id) => added(applyClips((doc) => duplicateClip(doc, id))),
    paste: (copy, at) => added(applyClips((doc) => insertClip(doc, copy, at))),
    muteClip: (id, muted) => apply((doc) => muteClip(doc, id, muted)),
    muteTrack: (muted) => apply((doc) => muteTrack(doc, muted)),

    addRange: (a, b) => {
      const id = get().doc.nextRangeId;
      if (!apply((doc) => addRange(doc, a, b))) return null;
      set({ selected: null, selectedRange: id, selectedMarks: [] });
      return id;
    },
    setRange: (id, a, b) => apply((doc) => setRange(doc, id, a, b)),
    removeRange: (id) => apply((doc) => deleteRange(doc, id)),
    keepRanges: () => {
      const { splitMarks, fadeCuts } = get().options;
      return apply((doc) => keepRanges(doc, splitMarks, fadeCuts));
    },
    removeRanges: () => {
      const { splitMarks, fadeCuts } = get().options;
      return apply((doc) => removeRanges(doc, splitMarks, fadeCuts));
    },
    setPendingIn: (f) => set({ pendingIn: f }),

    addMark: (object, start, length, lane) => {
      const id = get().doc.nextMarkId;
      return apply((doc) => addMark(doc, object, start, length, lane), [id]) ? id : null;
    },
    setMark: (id, start, end, lane) => apply((doc) => setMark(doc, id, start, end, lane), [id]),
    setMarkObject: (id, object) => apply((doc) => setMarkObject(doc, id, object)),
    stepMark: (id, dir) => apply((doc) => stepLane(doc, id, dir)),
    defaultFades: (ids, ends) =>
      apply((doc) => fadeEnds(doc, ids, get().options.defaultFade, ends)),
    removeFades: (ids, ends) => apply((doc) => fadeEnds(doc, ids, 0, ends)),
    placeMarks: (places) =>
      apply(
        (doc) => {
          const start = get().gestureStart;
          return placeMarks(start ? { ...doc, marks: start.marks } : doc, places);
        },
        places.map((p) => p.id),
      ),
    setMarkFades: (id, set) => apply((doc) => setMarkFades(doc, id, set)),
    removeMark: (id) => apply((doc) => deleteMarks(doc, [id])),
    removeMarks: (ids) => apply((doc) => deleteMarks(doc, ids)),
    crop: (crop) => apply((doc) => setCrop(doc, crop)),
    grow: (grow) => apply((doc) => setGrow(doc, grow)),

    beginGesture: () => {
      if (!get().gestureStart) set({ gestureStart: get().doc });
    },
    endGesture: () => {
      const { gestureStart: start, doc, past } = get();
      if (!start) return;
      if (doc === start) set({ gestureStart: null });
      else set({ gestureStart: null, past: pushLimited(past, start), future: [] });
    },
    cancelGesture: () => {
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
    select: (id) => set({ selected: id, selectedRange: null, selectedMarks: [] }),
    selectRange: (id) => set({ selectedRange: id, selected: null, selectedMarks: [] }),
    selectMarks: (ids) =>
      set({ selectedMarks: [...new Set(ids)], selected: null, selectedRange: null }),
    setOptions: (options) => set({ options }),
  };
});

function pushLimited(past: Doc[], doc: Doc): Doc[] {
  const next = [...past, doc];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}
