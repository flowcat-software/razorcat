import { useEffect, useState } from "react";
import { shownMarks } from "./doc";
import { useDoc } from "./docStore";
import type { Player } from "./player";
import styles from "./EditorApp.module.css";

/**
 * A stand-in for markup on the preview until Phase 4.2 draws it: what's on at the playhead, its
 * text in a box at the top of the frame (lane 0 first). The selected one is outlined.
 */
export function MarkStandIn({ player }: { player: Player }) {
  const [frame, setFrame] = useState(() => player.getState().frame);
  useEffect(() => {
    const stop = player.subscribe(() => setFrame(player.getState().frame));
    return () => {
      stop();
    };
  }, [player]);
  const doc = useDoc((s) => s.doc);
  const selected = useDoc((s) => s.selectedMark);
  const on = shownMarks(doc)
    .filter((m) => m.start <= frame && frame < m.end)
    .sort((a, b) => a.lane - b.lane);
  if (on.length === 0) return null;
  const texts = new Map(doc.marks.map((m) => [m.id, m.text]));
  return (
    <div className={styles.markStandIn}>
      {on.map((m) => (
        <span key={m.id} data-selected={m.id === selected || undefined}>
          {texts.get(m.id)}
        </span>
      ))}
    </div>
  );
}
