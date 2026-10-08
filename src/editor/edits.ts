// The timeline's edits, as the keys and buttons invoke them: on the document (docStore.ts) at the
// player's playhead.
import { editPoints } from "./doc";
import { useDoc } from "./docStore";
import type { Player } from "./player";

/** S: splits the clip under the playhead there. */
export function splitAtPlayhead(player: Player) {
  useDoc.getState().split(player.getState().frame);
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
