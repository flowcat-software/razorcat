// The timeline's edits, as the keys and buttons invoke them: on the document (docStore.ts) at the
// player's playhead.
import { clipStarts, editPoints } from "./doc";
import { useDoc } from "./docStore";
import type { Player } from "./player";

/** S: splits the clip under the playhead there. */
export function splitAtPlayhead(player: Player) {
  useDoc.getState().split(player.getState().frame);
}

/** Delete: deletes the selected clip; the rest close up (the last clip stays). */
export function deleteSelected() {
  const { selected, remove } = useDoc.getState();
  if (selected !== null) remove(selected);
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

/** ↑ / ↓: the playhead to the previous or next cut (or the timeline's start or end). */
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
