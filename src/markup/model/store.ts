// The markup's document, as Vandal's markup code sees it: Vandal's document store, adapted. The
// edit (editor/docStore.ts) is what's kept and undone; this is a view of it, the markup showing
// at the playhead, as one of Vandal's documents (annotations back to front, in output pixels),
// and its actions edit the edit:
// - adding an annotation adds markup at the playhead, for two seconds, in a free lane (a
//   duplicate, when its original is, with its fades if Settings say so);
// - moving, resizing or restyling one changes what its markup shows;
// - stacking order is the lanes: the top lane's markup is in front;
// - gestures, undo and redo are the edit's, so a drag on the preview is one undo step there;
// - the selection is the edit's selected markup (what of it is showing);
// - each showing item's opacity at the playhead, as its fades make it (`opacity`); a
//   spotlight's is its hole's, and the darkness has its own (`dark`; editor/spotlights.ts);
// - step markers count up by their start times on the timeline, all of them, not only those
//   showing (`labels`; Richard, 2026-10-21), where Vandal counts in creation order.

import { createStore, useStore } from "zustand";
import {
  freeLane,
  markFades,
  markOpacity,
  shownMarks,
  stackLane,
  type MarkId,
  type MarkObject,
} from "../../editor/doc";
import type { Doc as EditDoc } from "../../editor/doc";
import { darkAt, darkLayer } from "../../editor/spotlights";
import { useDoc as useEdit } from "../../editor/docStore";
import { stepLabel } from "../steps";
import { clickTiming } from "../click";
import { keysTiming } from "../keys";
import { outputSize } from "../../editor/frame";
import type { Player } from "../../editor/player";
import { useToolStore } from "../toolStore";
import type { Reorder } from "./commands";
import {
  DOC_VERSION,
  type Annotation,
  type AnnotationId,
  type Doc,
  type NewAnnotation,
  type StepAnnotation,
} from "./types";

/** How long new markup lasts, in seconds. */
const NEW_MARK_SECONDS = 2;
/** How long `load`'s edit is, in frames. */
const TEST_FRAMES = 1000;

export interface DocState {
  /** The markup showing at the playhead. */
  doc: Doc;
  /** The selected markup, if it's showing. */
  selection: AnnotationId[];
  /** Not null during the edit's gesture (the document then, as far as markup goes: this one). */
  gestureStart: Doc | null;
  /**
   * How opaque each showing item is at the playhead, if it's fading (the rest are opaque); a
   * spotlight's, how open its hole is.
   */
  opacity: Readonly<Record<AnnotationId, number>>;
  /** The spotlights' darkness at the playhead (%), and how far it has faded in; null if none. */
  dark: { dim: number; level: number } | null;
  /** Every step marker's label (`timelineStepLabels`). */
  labels: Readonly<Record<AnnotationId, string>>;

  /**
   * A fresh edit holding just `doc`'s annotations, from the start, as long as an edit with
   * nothing loaded allows (Vandal's tests start this way).
   */
  load: (doc: Doc) => void;
  /**
   * Adds markup showing `annotation`: at the playhead, or, given the markup it copies (`like`),
   * when that is; in a free lane. Its id.
   */
  add: (annotation: NewAnnotation, like?: AnnotationId) => AnnotationId;
  update: (id: AnnotationId, update: (a: Annotation) => Annotation) => void;
  remove: (ids: readonly AnnotationId[]) => void;
  /** Moves markup up or down the lanes (the top lane is in front). */
  reorder: (ids: readonly AnnotationId[], how: Reorder) => void;

  beginGesture: () => void;
  endGesture: () => void;
  cancelGesture: () => void;
  undo: () => void;
  redo: () => void;

  select: (ids: readonly AnnotationId[]) => void;
}

/** The annotation id of markup `id`, and back. */
export const annotationId = (id: MarkId): AnnotationId => `m${id}`;
const markId = (id: AnnotationId): MarkId => Number(id.slice(1));

let player: Player | null = null;

/** Each markup's annotation, kept while its object is the same (Vandal's code compares them). */
const annotations = new Map<MarkId, { object: MarkObject; annotation: Annotation }>();

/** What markup shows of annotation `a`: all of it but its id. */
function objectOf(a: Annotation): MarkObject {
  const object: Partial<Annotation> = { ...a };
  delete object.id;
  return object as MarkObject;
}

/** Markup `id`'s annotation (the same one while its object is). */
export function annotationOf(id: MarkId, object: MarkObject): Annotation {
  const kept = annotations.get(id);
  if (kept?.object === object) return kept.annotation;
  const annotation = { ...object, id: annotationId(id) } as Annotation;
  annotations.set(id, { object, annotation });
  return annotation;
}

/** The view of the edit now: the markup at the playhead (and any being typed into). */
/**
 * Every step marker's label in edit `doc`: its own if one was typed, else counting up by where
 * they start on the timeline, then in the order they were made (not by lane: a new one goes in
 * whichever lane is free), skipping those with their own. The count's
 * format and first label are the first marker made's (Vandal's: shared). Hidden markers (their
 * clip deleted) count last.
 */
export function timelineStepLabels(doc: EditDoc): Record<AnnotationId, string> {
  const places = new Map(shownMarks(doc).map((m) => [m.id, m]));
  const steps = doc.marks.filter((m) => m.object.kind === "step");
  const labels: Record<AnnotationId, string> = {};
  if (!steps.length) return labels;
  const first = steps[0].object as StepAnnotation;
  const start = (id: MarkId) => places.get(id)?.start ?? Infinity;
  const made = (m: (typeof steps)[number]) => (m.object as StepAnnotation).seq;
  const order = [...steps].sort(
    (a, b) => start(a.id) - start(b.id) || made(a) - made(b) || a.id - b.id,
  );
  let n = first.start;
  for (const m of order) {
    const own = (m.object as StepAnnotation).label;
    labels[annotationId(m.id)] = own ?? stepLabel(n++, first.format);
  }
  return labels;
}

/**
 * Every step marker in the edit, as one of Vandal's documents. Vandal's step actions (the
 * shared format and first label, the next marker's, syncing their style, resetting typed
 * labels) look at the markers in the document they're given: given this, they reach every
 * marker on the timeline, not only those showing at the playhead.
 */
export function stepsDoc(): Doc {
  const edit = useEdit.getState().doc;
  return {
    ...docStore.getState().doc,
    annotations: edit.marks
      .filter((m) => m.object.kind === "step")
      .map((m) => annotationOf(m.id, m.object)),
  };
}

function view(): Pick<
  DocState,
  "doc" | "selection" | "gestureStart" | "opacity" | "dark" | "labels"
> {
  const edit = useEdit.getState();
  const frame = player?.getState().frame ?? 0;
  const editing = useToolStore.getState().editing;
  const typing = editing ? markId(editing.id) : null;
  const objects = new Map(edit.doc.marks.map((m) => [m.id, m.object]));
  const on = shownMarks(edit.doc)
    .filter((m) => (m.start <= frame && frame < m.end) || m.id === typing)
    // Back to front: the bottom lane first.
    .sort((a, b) => b.lane - a.lane || a.start - b.start || a.id - b.id);
  const size = outputSize(edit.doc.frame);
  const doc: Doc = {
    version: DOC_VERSION,
    source: size,
    crop: { x: 0, y: 0, ...size },
    annotations: on.map((m) => annotationOf(m.id, objects.get(m.id)!)),
  };
  const showing = new Set(on.map((m) => m.id));
  const layer = darkLayer(edit.doc);
  const darkNow = layer && darkAt(layer, frame);
  const opacity: Record<AnnotationId, number> = {};
  for (const m of on) {
    const kept = edit.doc.marks.find((k) => k.id === m.id);
    const length = m.end - m.start;
    const a =
      kept?.object.kind === "spotlight"
        ? (darkNow?.holes.get(m.id) ?? 1)
        : kept
          ? markOpacity(markFades(kept, length), length, frame - m.start)
          : 1;
    // Text being typed into shows whole.
    if (a < 1 && m.id !== typing) opacity[annotationId(m.id)] = a;
  }
  return {
    opacity,
    dark: layer && darkNow ? { dim: layer.dim, level: darkNow.level } : null,
    labels: timelineStepLabels(edit.doc),
    doc,
    selection: edit.selectedMarks.filter((id) => showing.has(id)).map(annotationId),
    gestureStart: edit.gestureStart ? doc : null,
  };
}

/** Swaps in a new view if anything in it changed (so Vandal's code sees the same doc otherwise). */
function refresh() {
  const s = docStore.getState();
  const next = view();
  const same =
    next.doc.source.width === s.doc.source.width &&
    next.doc.source.height === s.doc.source.height &&
    next.doc.annotations.length === s.doc.annotations.length &&
    next.doc.annotations.every((a, i) => a === s.doc.annotations[i]);
  const sameSelection =
    next.selection.length === s.selection.length &&
    next.selection.every((id, i) => id === s.selection[i]);
  const sameOpacity =
    Object.keys(next.opacity).length === Object.keys(s.opacity).length &&
    Object.entries(next.opacity).every(([id, a]) => s.opacity[id] === a);
  const sameDark =
    next.dark === s.dark ||
    (next.dark !== null &&
      s.dark !== null &&
      next.dark.dim === s.dark.dim &&
      next.dark.level === s.dark.level);
  const sameLabels =
    Object.keys(next.labels).length === Object.keys(s.labels).length &&
    Object.entries(next.labels).every(([id, l]) => s.labels[id] === l);
  if (
    same &&
    sameSelection &&
    sameOpacity &&
    sameDark &&
    sameLabels &&
    !next.gestureStart === !s.gestureStart
  )
    return;
  docStore.setState({
    dark: sameDark ? s.dark : next.dark,
    labels: sameLabels ? s.labels : next.labels,
    opacity: sameOpacity ? s.opacity : next.opacity,
    doc: same ? s.doc : next.doc,
    selection: sameSelection ? s.selection : next.selection,
    gestureStart: next.gestureStart && (same ? s.doc : next.doc),
  });
}

export const docStore = createStore<DocState>()(() => ({
  doc: {
    version: DOC_VERSION,
    source: { width: 1, height: 1 },
    crop: { x: 0, y: 0, width: 1, height: 1 },
    annotations: [],
  },
  selection: [],
  gestureStart: null,
  opacity: {},
  dark: null,
  labels: {},

  load: (doc) => {
    const edit = useEdit.getState();
    edit.load(TEST_FRAMES, doc.source);
    for (const a of doc.annotations) useEdit.getState().addMark(objectOf(a), 0, TEST_FRAMES, 0);
    useEdit.setState({ past: [], future: [] });
  },
  add: (annotation, like) => {
    const edit = useEdit.getState();
    const original = like && shownMarks(edit.doc).find((m) => m.id === markId(like));
    const frame = original ? original.start : (player?.getState().frame ?? 0);
    const fps = player?.fps ?? 30;
    // A click or keys mark is a moment, fading, as a recording's are (PLAN 5b.6b-c).
    const timed = original
      ? null
      : annotation.kind === "click"
        ? { fadeIn: 0, ...clickTiming(fps) }
        : annotation.kind === "keys"
          ? keysTiming(fps)
          : null;
    const length = original
      ? original.end - original.start
      : (timed?.length ?? Math.round(NEW_MARK_SECONDS * fps));
    player?.pause();
    const id = edit.addMark(annotation, frame, length, freeLane(edit.doc, frame, frame + length));
    if (id === null) return "";
    if (timed?.fadeIn) useEdit.getState().setMarkFades(id, { fadeIn: timed.fadeIn });
    if (timed?.fadeOut) useEdit.getState().setMarkFades(id, { fadeOut: timed.fadeOut });
    const kept = original && edit.doc.marks.find((m) => m.id === original.id);
    if (kept && edit.options.copyFades) {
      const fades = markFades(kept, length);
      useEdit.getState().setMarkFades(id, { fadeIn: fades.fadeIn });
      useEdit.getState().setMarkFades(id, { fadeOut: fades.fadeOut });
    }
    return annotationId(id);
  },
  update: (id, update) => {
    const edit = useEdit.getState();
    const m = edit.doc.marks.find((x) => x.id === markId(id));
    if (!m) return;
    const before = annotationOf(m.id, m.object);
    const after = update(before);
    if (after === before) return;
    if (after.id !== before.id || after.kind !== before.kind) {
      throw new Error("an update can't change an annotation's id or kind");
    }
    const object = objectOf(after);
    // The updated annotation is the one shown, as Vandal's store would keep it.
    annotations.set(m.id, { object, annotation: after });
    edit.setMarkObject(m.id, object);
  },
  remove: (ids) => {
    useEdit.getState().removeMarks(ids.map(markId));
  },
  reorder: (ids, how) => {
    const edit = useEdit.getState();
    const places = new Map(shownMarks(edit.doc).map((m) => [m.id, m]));
    const own = !edit.gestureStart;
    if (own) edit.beginGesture();
    // The leading item first (the top one forward, the bottom one backward).
    const up = how === "front" || how === "forward";
    const moving = ids
      .flatMap((id) => places.get(markId(id)) ?? [])
      .sort((a, b) => (up ? a.lane - b.lane : b.lane - a.lane));
    for (const m of moving) {
      // In front of or behind all it overlaps (a new lane if need be), or a lane up or down.
      if (how === "forward" || how === "backward") edit.stepMark(m.id, up ? -1 : 1);
      else edit.setMark(m.id, m.start, m.end, stackLane(useEdit.getState().doc, m.id, how));
    }
    if (own) edit.endGesture();
  },

  beginGesture: () => useEdit.getState().beginGesture(),
  endGesture: () => useEdit.getState().endGesture(),
  cancelGesture: () => useEdit.getState().cancelGesture(),
  undo: () => useEdit.getState().undo(),
  redo: () => useEdit.getState().redo(),

  select: (ids) => useEdit.getState().selectMarks(ids.map(markId)),
}));

/** Selects all the markup on the timeline, showing at the playhead or not. */
export function selectAllMarkup(): void {
  const edit = useEdit.getState();
  edit.selectMarks(shownMarks(edit.doc).map((m) => m.id));
}

/**
 * Every spotlight in the edit, showing at the playhead or not: their darkness is shared (Vandal's,
 * PLAN 3D.7), so changing it reaches them all.
 */
export function allSpotlights(): Annotation[] {
  return useEdit
    .getState()
    .doc.marks.filter((m) => m.object.kind === "spotlight")
    .map((m) => annotationOf(m.id, m.object));
}

/**
 * All the selected markup as annotations, showing at the playhead or not (selected on the
 * timeline): what duplicating copies.
 */
export function selectedAnnotations(): Annotation[] {
  const edit = useEdit.getState();
  const shown = new Set(shownMarks(edit.doc).map((m) => m.id));
  return edit.doc.marks
    .filter((m) => edit.selectedMarks.includes(m.id) && shown.has(m.id))
    .map((m) => annotationOf(m.id, m.object));
}

// The view follows the edit.
useEdit.subscribe(refresh);

/**
 * The markup shows what's at `p`'s playhead, follows it (and what's being typed into), and adds
 * markup there. (The tools are subscribed to here, not as the module loads: toolStore.ts imports
 * this module.)
 */
/** The playhead, whose markup shows. */
export const playheadFrame = () => player?.getState().frame ?? 0;

export function connectMarkup(p: Player): () => void {
  player = p;
  annotations.clear();
  refresh();
  const stops = [
    p.subscribe(refresh),
    useToolStore.subscribe((s, before) => {
      if (s.editing !== before.editing) refresh();
    }),
  ];
  return () => {
    stops.forEach((stop) => stop());
    if (player === p) player = null;
  };
}

export function useDoc<T>(selector: (s: DocState) => T): T {
  return useStore(docStore, selector);
}
