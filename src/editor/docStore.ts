// The edit document's store: the current Doc plus undo/redo history (as Vandal's).
//
// History keeps whole Doc snapshots. Docs are immutable and edits share unchanged parts, so a
// snapshot costs about one array of references.
//
// Every edit is one undo step. A drag is wrapped in beginGesture/endGesture so all its
// intermediate updates become a single step; edits that change nothing add nothing to history.

import { create } from "zustand";
import { deleteClip, moveClip, split, trimClip, wholeSource, type ClipId, type Doc } from "./doc";

/** Oldest steps are dropped beyond this. */
export const HISTORY_LIMIT = 200;

export interface DocState {
  doc: Doc;
  past: Doc[];
  future: Doc[];
  /** The Doc when the current gesture began, or null outside a gesture. */
  gestureStart: Doc | null;
  /** The selected clip. Not part of history; cleared if undo/redo removes it. */
  selected: ClipId | null;

  /** Starts editing a new source, `frames` long: one clip, no history. */
  load: (frames: number) => void;
  /** Splits the clip under timeline frame `f`. False if there was nothing to split. */
  split: (f: number) => boolean;
  /** Deletes clip `id` (ripple). False if it can't (the last clip). */
  remove: (id: ClipId) => boolean;
  /** Moves clip `id` to position `to`. */
  move: (id: ClipId, to: number) => boolean;
  /** Trims clip `id` to source frames `in` to `out` (ripple). */
  trim: (id: ClipId, inF: number, outF: number) => boolean;

  beginGesture: () => void;
  endGesture: () => void;
  /** Abandons the gesture and restores the Doc from before it. */
  cancelGesture: () => void;

  undo: () => void;
  redo: () => void;

  select: (id: ClipId | null) => void;
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
    return true;
  };

  /** The selection, if its clip is gone. */
  const pruneSelection = () => {
    const { doc, selected } = get();
    if (selected !== null && !doc.clips.some((c) => c.id === selected)) set({ selected: null });
  };

  return {
    doc: wholeSource(0),
    past: [],
    future: [],
    gestureStart: null,
    selected: null,

    load: (frames) =>
      set({ doc: wholeSource(frames), past: [], future: [], gestureStart: null, selected: null }),

    split: (f) => apply((doc) => split(doc, f)),
    remove: (id) => {
      const done = apply((doc) => deleteClip(doc, id));
      pruneSelection();
      return done;
    },
    move: (id, to) => apply((doc) => moveClip(doc, id, to)),
    trim: (id, inF, outF) => apply((doc) => trimClip(doc, id, inF, outF)),

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
      pruneSelection();
    },

    undo: () => {
      const s = get();
      if (!canUndo(s)) return;
      set({
        doc: s.past[s.past.length - 1],
        past: s.past.slice(0, -1),
        future: [s.doc, ...s.future],
      });
      pruneSelection();
    },
    redo: () => {
      const s = get();
      if (!canRedo(s)) return;
      set({ doc: s.future[0], past: pushLimited(s.past, s.doc), future: s.future.slice(1) });
      pruneSelection();
    },

    select: (id) => set({ selected: id }),
  };
});

function pushLimited(past: Doc[], doc: Doc): Doc[] {
  const next = [...past, doc];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}
