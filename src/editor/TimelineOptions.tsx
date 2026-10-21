import type { SourceInfo } from "../shared/ipc";
import {
  clipLength,
  MARK_NAMES,
  markFades,
  shownMarks,
  shownRanges,
  total,
  type MarkId,
  type RangeId,
} from "./doc";
import { useDoc } from "./docStore";
import { NumberField } from "./NumberField";
import type { Player } from "./player";
import { needsHours, parseTimecode, timecode } from "./timecode";
import styles from "./EditorApp.module.css";

interface Props {
  source: SourceInfo | null;
  /** Times as frame numbers, as the readout. */
  inFrames: boolean;
  /** Editing where something starts or ends shows that frame. */
  player: Player | null;
}

/** How fast the fade fields drag, against the others: fades are short (Richard). */
const FADE_GAIN = 0.5;

/** Markup `id` where it is now. */
const markNow = (id: MarkId) => shownMarks(useDoc.getState().doc).find((m) => m.id === id);
/** Range `id` where it is now. */
const rangeNow = (id: RangeId) => shownRanges(useDoc.getState().doc).find((r) => r.id === id);

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
export function TimelineOptions({ source, inFrames, player }: Props) {
  const doc = useDoc((s) => s.doc);
  const selected = useDoc((s) => s.doc.clips.find((c) => c.id === s.selected) ?? null);
  const selectedRange = useDoc((s) => s.selectedRange);
  const selectedMarks = useDoc((s) => s.selectedMarks);
  const pendingIn = useDoc((s) => s.pendingIn);
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
  // The timing fields (PLAN 4.4d2): typed as the readout shows times (a plain frame number
  // too), dragged a frame at a time when slow, Shift ×10 (a second's worth zoomed through
  // short clips; Richard). Fades, short by nature, drag at half speed.
  const time = {
    format: fmt,
    parse: (text: string) => parseTimecode(text, num, den),
    width: inFrames ? 64 : hours ? 92 : 76,
  };
  const fade = { ...time, gain: FADE_GAIN };
  const seek = (f: number) => player?.seek(Math.max(0, Math.min(length - 1, f)));

  // Markup: From and To move that end (as dragging it), Length moves To; the fades are kept to
  // its length. Each returns the value as kept.
  const markFrom = (id: MarkId, v: number) => {
    const m = markNow(id);
    if (!m) return v;
    const a = Math.max(0, Math.min(m.end - 1, v));
    useDoc.getState().setMark(id, a, m.end, m.lane);
    seek(a);
    return markNow(id)?.start ?? a;
  };
  const markTo = (id: MarkId, v: number) => {
    const m = markNow(id);
    if (!m) return v;
    useDoc.getState().setMark(id, m.start, Math.max(m.start + 1, v), m.lane);
    const end = markNow(id)?.end ?? v;
    seek(end - 1);
    return end;
  };
  const markLength = (id: MarkId, v: number) => {
    const m = markNow(id);
    if (!m) return v;
    useDoc.getState().setMark(id, m.start, m.start + Math.max(1, v), m.lane);
    const now = markNow(id);
    return now ? now.end - now.start : v;
  };
  const markFade = (id: MarkId, which: "fadeIn" | "fadeOut", v: number) => {
    const store = useDoc.getState();
    store.setMarkFades(id, which === "fadeIn" ? { fadeIn: v } : { fadeOut: v });
    const m = markNow(id);
    const kept = useDoc.getState().doc.marks.find((k) => k.id === id);
    return m && kept ? markFades(kept, m.end - m.start)[which] : v;
  };

  // A range: the same, kept off its neighbours (setRange).
  const rangeFrom = (id: RangeId, v: number) => {
    const r = rangeNow(id);
    if (!r) return v;
    useDoc.getState().setRange(id, Math.max(0, Math.min(r.b - 1, v)), r.b);
    const a = rangeNow(id)?.a ?? v;
    seek(a);
    return a;
  };
  const rangeTo = (id: RangeId, v: number) => {
    const r = rangeNow(id);
    if (!r) return v;
    useDoc.getState().setRange(id, r.a, Math.max(r.a + 1, v));
    const b = rangeNow(id)?.b ?? v;
    seek(b - 1);
    return b;
  };
  const rangeLength = (id: RangeId, v: number) => {
    const r = rangeNow(id);
    if (!r) return v;
    useDoc.getState().setRange(id, r.a, r.a + Math.max(1, v));
    const now = rangeNow(id);
    return now ? now.b - now.a : v;
  };
  const clips = doc.clips.length;
  const ranges = shownRanges(doc);
  const range = ranges.find((r) => r.id === selectedRange);
  const marks = shownMarks(doc).filter((m) => selectedMarks.includes(m.id));
  const mark = marks.length === 1 ? marks[0] : null;
  const kept = mark && doc.marks.find((m) => m.id === mark.id);
  const object = kept?.object;
  const fades = mark && markFades(kept ?? {}, mark.end - mark.start);
  return (
    <div className={styles.timelineOptions}>
      {pendingIn !== null ? (
        <>
          <b>Range</b>
          <Field label="In" value={fmt(pendingIn)} />
          <span>O sets the out at the playhead · drag the dashed line to adjust · Esc cancels</span>
        </>
      ) : marks.length > 1 ? (
        <>
          <b>Markup</b>
          <span>{marks.length} selected · Delete removes them</span>
        </>
      ) : mark ? (
        <>
          <b>{object ? MARK_NAMES[object.kind] : "Markup"}</b>
          <NumberField
            label="From"
            value={mark.start}
            onChange={(v) => markFrom(mark.id, v)}
            {...time}
          />
          <NumberField
            label="to"
            name="To"
            value={mark.end}
            onChange={(v) => markTo(mark.id, v)}
            {...time}
          />
          <NumberField
            label="Length"
            value={mark.end - mark.start}
            onChange={(v) => markLength(mark.id, v)}
            {...time}
          />
          <span className={styles.optionsSep} />
          <NumberField
            label="Fade in"
            value={fades?.fadeIn ?? 0}
            onChange={(v) => markFade(mark.id, "fadeIn", v)}
            {...fade}
          />
          <NumberField
            label="out"
            name="Fade out"
            value={fades?.fadeOut ?? 0}
            onChange={(v) => markFade(mark.id, "fadeOut", v)}
            {...fade}
          />
        </>
      ) : range ? (
        <>
          <b>Range</b>
          <NumberField
            label="From"
            value={range.a}
            onChange={(v) => rangeFrom(range.id, v)}
            {...time}
          />
          <NumberField
            label="to"
            name="To"
            value={range.b}
            onChange={(v) => rangeTo(range.id, v)}
            {...time}
          />
          <NumberField
            label="Length"
            value={range.b - range.a}
            onChange={(v) => rangeLength(range.id, v)}
            {...time}
          />
        </>
      ) : selected ? (
        <>
          <b>Clip {selected.id}</b>
          <Field label="In" value={fmt(selected.in)} />
          <Field label="Out" value={fmt(selected.out)} />
          <Field label="Length" value={fmt(clipLength(selected))} />
          <span>of the source&apos;s {fmt(doc.sourceFrames)}</span>
        </>
      ) : (
        <span>
          Drag a clip&apos;s edge to trim it · its title bar to move it · <b>S</b> splits · <b>R</b>{" "}
          or <b>I</b>/<b>O</b> add a range
        </span>
      )}
      <span className={styles.spacer} />
      <span className={styles.summary}>
        {clips} {clips === 1 ? "clip" : "clips"} · {fmt(length)}
        {ranges.length > 0 && ` · ${ranges.length} ${ranges.length === 1 ? "range" : "ranges"}`}
      </span>
    </div>
  );
}
