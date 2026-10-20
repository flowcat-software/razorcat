// The timeline's edits, as the keys and buttons invoke them: on the document (docStore.ts) at the
// player's playhead.
import {
  clipStarts,
  copyClip,
  editPoints,
  pasteSlot,
  shownRanges,
  total,
  type ClipCopy,
  type ClipId,
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

/** Ctrl+D: a copy of the selected clip straight after it, selected. */
export function duplicateSelectedClip(player: Player): boolean {
  const { selected, duplicate } = useDoc.getState();
  const id = selected === null ? null : duplicate(selected);
  if (id === null) return false;
  showNewClip(player, id);
  return true;
}

/** The clip Ctrl+C copied (the app's own clipboard: clips don't go to Windows'). */
let copied: ClipCopy | null = null;

/** Ctrl+C: copies the selected clip and its markup. False with no clip selected. */
export function copySelectedClip(): boolean {
  const { doc, selected } = useDoc.getState();
  const copy = selected === null ? null : copyClip(doc, selected);
  if (!copy) return false;
  copied = copy;
  return true;
}

/** Ctrl+V: the copied clip at the cut nearest the playhead, selected. False with none copied. */
export function pasteClip(player: Player): boolean {
  if (!copied) return false;
  const { doc, paste } = useDoc.getState();
  const id = paste(copied, pasteSlot(doc, player.getState().frame));
  if (id === null) return false;
  showNewClip(player, id);
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
