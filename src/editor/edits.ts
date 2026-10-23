// The timeline's edits, as the keys and buttons invoke them: on the document (docStore.ts) at the
// player's playhead.
import { annotationId, docStore as markupDoc } from "../markup/model/store";
import { stylePatchFor } from "../markup/pasteStyle";
import { patchAnnotation } from "../markup/restyle";
import type { Annotation } from "../markup/model/types";
import {
  clipStarts,
  copyClip,
  editPoints,
  freeLane,
  markFades,
  pasteSlot,
  shownMarks,
  shownRanges,
  total,
  type ClipCopy,
  type ClipId,
  type MarkId,
  type MarkObject,
} from "./doc";
import { useDoc } from "./docStore";
import type { Player } from "./player";
import { useTimeline } from "./timelineStore";

/** S: splits the clip under the playhead there. */
export function splitAtPlayhead(player: Player) {
  useDoc.getState().split(player.getState().frame);
}

/**
 * Delete: deletes the selected markup or range, or the selected clip (the rest close up; the
 * last clip stays).
 */
export function deleteSelected() {
  const { selected, selectedRange, selectedMarks, remove, removeRange, removeMarks } =
    useDoc.getState();
  if (selectedMarks.length) removeMarks(selectedMarks);
  else if (selectedRange !== null) removeRange(selectedRange);
  else if (selected !== null) remove(selected);
}

/**
 * R: adds a range of 2 seconds from the playhead (less at the end), selected. Nothing with the
 * playhead on or in a range already.
 */
export function addRangeAtPlayhead(player: Player) {
  const f = player.getState().frame;
  const { doc, addRange } = useDoc.getState();
  // On or in a range already: nothing, rather than another range over it (Richard).
  if (shownRanges(doc).some((r) => r.a <= f && f <= r.b)) return;
  addRange(f, f + Math.round(2 * player.fps));
}

/** I: a pending in-point at the playhead; O makes the range, Esc drops it. */
export function rangeIn(player: Player) {
  useDoc.getState().setPendingIn(player.getState().frame);
}

/**
 * O: a range from the pending in-point (or the start, without one) through the playhead's
 * frame. Nothing if the playhead is before the in-point.
 */
export function rangeOut(player: Player) {
  const { pendingIn, addRange, setPendingIn } = useDoc.getState();
  const f = player.getState().frame;
  const a = pendingIn ?? 0;
  if (f < a) return;
  addRange(a, f + 1);
  setPendingIn(null);
}

/**
 * Ctrl+[ / Ctrl+]: moves the selected clip one place earlier or later; with Shift, to the start
 * or the end. The playhead goes to its new start.
 */
export function moveSelected(player: Player, to: -1 | 1 | "first" | "last") {
  const { doc, selected, move } = useDoc.getState();
  const from = doc.clips.findIndex((c) => c.id === selected);
  if (from < 0) return;
  const at = to === "first" ? 0 : to === "last" ? doc.clips.length - 1 : from + to;
  if (!move(doc.clips[from].id, at)) return;
  const now = useDoc.getState().doc;
  player.seek(clipStarts(now)[now.clips.findIndex((c) => c.id === selected)]);
}

/** A new clip (a duplicate or a paste): lit up for a moment, in view, the playhead at its start. */
function showNewClip(player: Player, id: ClipId) {
  const { doc } = useDoc.getState();
  const start = clipStarts(doc)[doc.clips.findIndex((c) => c.id === id)];
  player.seek(start);
  // The view's length, before the next paint updates it, so it can scroll to the new clip.
  const view = useTimeline.getState();
  view.setSize(view.width, total(doc));
  view.follow(start);
  view.flashClip(id);
}

/** M: mutes the selected clip, or unmutes it. False with no clip selected. */
export function muteSelectedClip(): boolean {
  const { doc, selected, muteClip } = useDoc.getState();
  const clip = doc.clips.find((c) => c.id === selected);
  return !!clip && muteClip(clip.id, !clip.muted);
}

/** Shift+M: mutes all the sound, or unmutes it. */
export function muteSound() {
  const { doc, muteTrack } = useDoc.getState();
  muteTrack(!doc.muted);
}

/** Ctrl+D: a copy of the selected clip straight after it, selected. */
export function duplicateSelectedClip(player: Player): boolean {
  const { selected, duplicate } = useDoc.getState();
  const id = selected === null ? null : duplicate(selected);
  if (id === null) return false;
  showNewClip(player, id);
  return true;
}

/** A piece of markup as copied: what it shows, and where and how it fades on the timeline. */
export interface MarkCopy {
  object: MarkObject;
  start: number;
  end: number;
  fadeIn: number;
  fadeOut: number;
}

/**
 * What Ctrl+C copied last, a clip or markup (the app's own clipboard: neither goes to
 * Windows'). Markup is kept top lane first; its first is what Paste Style takes.
 */
let copied: { clip: ClipCopy } | { marks: MarkCopy[] } | null = null;

/** Ctrl+C: copies the selected clip and its markup. False with no clip selected. */
export function copySelectedClip(): boolean {
  const { doc, selected } = useDoc.getState();
  const copy = selected === null ? null : copyClip(doc, selected);
  if (!copy) return false;
  copied = { clip: copy };
  return true;
}

/** Ctrl+C: copies the selected markup (PLAN 4.5d3). False with none selected. */
export function copySelectedMarks(): boolean {
  const { doc, selectedMarks } = useDoc.getState();
  const marks = shownMarks(doc)
    .filter((m) => selectedMarks.includes(m.id))
    .sort((a, b) => a.lane - b.lane || a.start - b.start)
    .map((m): MarkCopy => {
      const kept = doc.marks.find((k) => k.id === m.id)!;
      return {
        object: kept.object,
        start: m.start,
        end: m.end,
        ...markFades(kept, m.end - m.start),
      };
    });
  if (!marks.length) return false;
  copied = { marks };
  return true;
}

/** The markup copied last, if markup was. */
export function copiedMarks(): readonly MarkCopy[] | null {
  return copied && "marks" in copied ? copied.marks : null;
}

/**
 * Ctrl+V: the copied clip at the cut nearest the playhead, or the copied markup from the
 * playhead on (as far apart as it was, in front of what's there), selected. False with nothing
 * copied.
 */
export function pasteClip(player: Player): boolean {
  if (!copied) return false;
  if ("marks" in copied) return pasteMarks(copied.marks, player.getState().frame);
  const { doc, paste } = useDoc.getState();
  const id = paste(copied.clip, pasteSlot(doc, player.getState().frame));
  if (id === null) return false;
  showNewClip(player, id);
  return true;
}

/** `marks` added from frame `at` on, one undo step: the lowest first, so each ends up in front. */
function pasteMarks(marks: readonly MarkCopy[], at: number): boolean {
  const store = useDoc.getState();
  const from = Math.min(...marks.map((m) => m.start));
  const ids: MarkId[] = [];
  store.beginGesture();
  for (const m of [...marks].reverse()) {
    const start = at + m.start - from;
    const length = m.end - m.start;
    const lane = freeLane(useDoc.getState().doc, start, start + length);
    const id = store.addMark(m.object, start, length, lane);
    if (id === null) continue;
    store.setMarkFades(id, { fadeIn: m.fadeIn });
    store.setMarkFades(id, { fadeOut: m.fadeOut });
    ids.push(id);
  }
  store.endGesture();
  store.selectMarks(ids);
  return ids.length > 0;
}

/**
 * Ctrl+Shift+V: the copied markup's style (its first item's) onto the selected markup, one undo
 * step (`stylePatchFor`). False with no markup copied or none selected.
 */
export function pasteStyle(): boolean {
  const marks = copiedMarks();
  const { selectedMarks, beginGesture, endGesture } = useDoc.getState();
  if (!marks || !selectedMarks.length) return false;
  const source = { ...marks[0].object, id: "copied" } as Annotation;
  beginGesture();
  for (const id of selectedMarks) {
    markupDoc
      .getState()
      .update(annotationId(id), (a) => patchAnnotation(a, stylePatchFor(source, a)));
  }
  endGesture();
  return true;
}

/** ↑ / ↓: the playhead to the previous or next edit point (a cut, a range's edge, an end). */
export function seekEdit(player: Player, direction: -1 | 1) {
  const now = player.getState().frame;
  const points = editPoints(useDoc.getState().doc);
  const before = points.filter((f) => f < now);
  const to =
    direction < 0
      ? (before[before.length - 1] ?? 0)
      : (points.find((f) => f > now) ?? player.frames - 1);
  player.seek(Math.min(to, player.frames - 1));
}
