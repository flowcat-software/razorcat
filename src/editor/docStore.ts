// The edit document's store: the current Doc plus undo/redo history (as Vandal's).
//
// History keeps whole Doc snapshots. Docs are immutable and edits share unchanged parts, so a
// snapshot costs about one array of references.
//
// Every edit is one undo step. A drag is wrapped in beginGesture/endGesture so all its
// intermediate updates become a single step; edits that change nothing add nothing to history.
//
// After an edit of the clips, the ranges follow their video (each kept in one place), or, with
// Settings › Timeline › "Ranges follow their video" off, stay where they were on the timeline
// (where they were when the drag started, for a drag).

import { create } from "zustand";
import {
  addRange,
  deleteClip,
  deleteRange,
  keepRanges,
  keepRangesInPlace,
  moveClip,
  removeRanges,
  separateRanges,
  setCrop,
  setRange,
  shownRanges,
  split,
  trimClip,
  wholeSource,
  type ClipId,
  type Doc,
  type RangeId,
} from "./doc";
import type { Rect, Size } from "./fit";

/** Oldest steps are dropped beyond this. */
export const HISTORY_LIMIT = 200;

/** Settings › Timeline: how ranges take edits of the clips. */
export interface RangeOptions {
  /** Ranges follow their video (else they keep their place on the timeline). */
  follow: boolean;
  /** Deleting a clip deletes the ranges on it (else they're kept, hidden). */
  deleteWithClip: boolean;
}

export interface DocState {
  doc: Doc;
  past: Doc[];
  future: Doc[];
  /** The Doc when the current gesture began, or null outside a gesture. */
  gestureStart: Doc | null;
  /**
   * The selected clip, or range (one or neither). Not part of history; cleared if an edit,
   * undo or redo takes it away.
   */
  selected: ClipId | null;
  selectedRange: RangeId | null;
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

  /** Adds a range over timeline frames `a` to `b` and selects it; its id, or null. */
  addRange: (a: number, b: number) => RangeId | null;
  /** Moves or resizes range `id` to timeline frames `a` to `b`. */
  setRange: (id: RangeId, a: number, b: number) => boolean;
  removeRange: (id: RangeId) => boolean;
  /** Keep only the ranges' frames, or cut them out (ripple); the ranges go. */
  keepRanges: () => boolean;
  removeRanges: () => boolean;
  setPendingIn: (f: number | null) => void;

  /** Crops to `crop` (kept to the source). */
  crop: (crop: Rect) => boolean;

  beginGesture: () => void;
  endGesture: () => void;
  /** Abandons the gesture and restores the Doc from before it. */
  cancelGesture: () => void;

  undo: () => void;
  redo: () => void;

  select: (id: ClipId | null) => void;
  selectRange: (id: RangeId | null) => void;
  setOptions: (options: RangeOptions) => void;
}

export function canUndo(s: DocState): boolean {
  return s.past.length > 0 && s.gestureStart === null;
}

export function canRedo(s: DocState): boolean {
  return s.future.length > 0 && s.gestureStart === null;
}

export const useDoc = create<DocState>()((set, get) => {
  /** Applies a pure edit as one history step (or as part of the current gesture). */
  const apply = (edit: (doc: Doc) => Doc): boolean => {
    const s = get();
    const doc = edit(s.doc);
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
      // In a drag, from where the ranges were when it started (a drag's steps only move clips).
      if (!gestureStart) return keepRangesInPlace(doc, after);
      return keepRangesInPlace(gestureStart, { ...after, ranges: gestureStart.ranges });
    });

  /** The selection, if what's selected is gone (or hidden). */
  const prune = () => {
    const { doc, selected, selectedRange } = get();
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
    pendingIn: null,
    options: { follow: true, deleteWithClip: true },

    load: (frames, size) =>
      set({
        doc: wholeSource(frames, size),
        past: [],
        future: [],
        gestureStart: null,
        selected: null,
        selectedRange: null,
        pendingIn: null,
      }),

    split: (f) => applyClips((doc) => split(doc, f)),
    remove: (id) => applyClips((doc) => deleteClip(doc, id, get().options.deleteWithClip)),
    move: (id, to) => applyClips((doc) => moveClip(doc, id, to)),
    trim: (id, inF, outF) => applyClips((doc) => trimClip(doc, id, inF, outF)),

    addRange: (a, b) => {
      const id = get().doc.nextRangeId;
      if (!apply((doc) => addRange(doc, a, b))) return null;
      set({ selected: null, selectedRange: id });
      return id;
    },
    setRange: (id, a, b) => apply((doc) => setRange(doc, id, a, b)),
    removeRange: (id) => apply((doc) => deleteRange(doc, id)),
    keepRanges: () => apply(keepRanges),
    removeRanges: () => apply(removeRanges),
    setPendingIn: (f) => set({ pendingIn: f }),
    crop: (crop) => apply((doc) => setCrop(doc, crop)),

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
    select: (id) => set({ selected: id, selectedRange: null }),
    selectRange: (id) => set({ selectedRange: id, selected: null }),
    setOptions: (options) => set({ options }),
  };
});

function pushLimited(past: Doc[], doc: Doc): Doc[] {
  const next = [...past, doc];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}
