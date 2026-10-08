import type { SourceInfo } from "../shared/ipc";
import { clipLength, total } from "./doc";
import { useDoc } from "./docStore";
import { needsHours, timecode } from "./timecode";
import styles from "./EditorApp.module.css";

interface Props {
  source: SourceInfo | null;
  /** Times as frame numbers, as the readout. */
  inFrames: boolean;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span className={styles.field}>
      {label} <span className={styles.valueBox}>{value}</span>
    </span>
  );
}

/**
 * The timeline's options bar (the mockup's): the timing of what's selected on the timeline (a
 * clip's In, Out and Length, in the source's time), or what can be done; the edit's summary on
 * the right.
 */
export function TimelineOptions({ source, inFrames }: Props) {
  const doc = useDoc((s) => s.doc);
  const selected = useDoc((s) => s.doc.clips.find((c) => c.id === s.selected) ?? null);
  if (!source) {
    return (
      <div className={styles.timelineOptions}>
        Open a video, then split with S, mark ranges with R, and trim by dragging a clip&apos;s
        edge.
      </div>
    );
  }
  const { rateNum: num, rateDen: den } = source;
  const length = total(doc);
  const hours = needsHours(Math.max(length, doc.sourceFrames), num, den);
  const fmt = (f: number) => (inFrames ? String(f) : timecode(f, num, den, hours));
  const clips = doc.clips.length;
  return (
    <div className={styles.timelineOptions}>
      {selected ? (
        <>
          <b>Clip {selected.id}</b>
          <Field label="In" value={fmt(selected.in)} />
          <Field label="Out" value={fmt(selected.out)} />
          <Field label="Length" value={fmt(clipLength(selected))} />
          <span>of the source&apos;s {fmt(doc.sourceFrames)}</span>
        </>
      ) : (
        <span>
          Drag a clip&apos;s edge to trim it · its title bar to move it · <b>S</b> splits
        </span>
      )}
      <span className={styles.spacer} />
      <span className={styles.summary}>
        {clips} {clips === 1 ? "clip" : "clips"} · {fmt(length)}
      </span>
    </div>
  );
}
