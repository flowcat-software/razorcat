import type { CameraSize, SourceInfo } from "../shared/ipc";
import { ColorSwatch } from "../markup/ColorSwatch";
import { hint } from "../markup/HintLine";
import {
  canFade,
  clipFades,
  clipLength,
  clipStarts,
  fadeColours,
  longestSource,
  MARK_NAMES,
  markFades,
  shownMarks,
  shownRanges,
  sourceLength,
  total,
  type Clip,
  type ClipId,
  type MarkId,
  type RangeId,
} from "./doc";
import { useDoc } from "./docStore";
import { CAMERA_SIZE_NAMES, CAMERA_SIZES } from "./cameraPlace";
import { NumberField } from "./NumberField";
import { clipFrame, sourceFrame, videoEnd } from "./speed";
import { useSqueeze } from "./squeeze";
import type { Player } from "./player";
import { needsHours, parseTimecode, timecode } from "./timecode";
import styles from "./EditorApp.module.css";

interface Props {
  source: SourceInfo | null;
  /** Times as frame numbers, as the readout. */
  inFrames: boolean;
  /** Editing where something starts or ends shows that frame. */
  player: Player | null;
  /** Each recording with a camera, by file id: the size it was recorded at. */
  cameraSizes: Readonly<Record<string, CameraSize>>;
}

/** How fast the fade fields drag, against the others: fades are short (Richard). */
const FADE_GAIN = 0.5;

/** A colour picked from a swatch, one undo step (Esc puts it back). */
const ONE_STEP = {
  onOpen: () => useDoc.getState().beginGesture(),
  onClose: (keep: boolean) =>
    keep ? useDoc.getState().endGesture() : useDoc.getState().cancelGesture(),
};

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

/** A clip's camera: shown or not (PLAN 5d.6c), and its size (5d.6a), Small, Medium or Large. */
function CameraOptions({
  size,
  shown,
  onPick,
  onShow,
}: {
  size: CameraSize;
  shown: boolean;
  onPick: (size: CameraSize) => void;
  onShow: (shown: boolean) => void;
}) {
  return (
    <>
      <span className={styles.optionsSep} />
      <span className={styles.field}>
        <span className={styles.optionsWord}>Camera</span>
        <button
          type="button"
          className={styles.toggle}
          aria-pressed={shown}
          {...hint("clip.cameraShown")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onShow(!shown)}
        >
          Show
        </button>
        <span className={styles.chips} role="radiogroup" aria-label="Camera size">
          {CAMERA_SIZES.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              className={styles.toggle}
              aria-checked={size === k}
              {...hint("clip.cameraSize")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(k)}
            >
              {CAMERA_SIZE_NAMES[k]}
            </button>
          ))}
        </span>
      </span>
    </>
  );
}

/**
 * The timeline's options bar (the mockup's): the timing of what's selected on the timeline (a
 * clip's In, Out and Length, in the source's time), or what can be done; the edit's summary on
 * the right.
 */
export function TimelineOptions({ source, inFrames, player, cameraSizes }: Props) {
  const doc = useDoc((s) => s.doc);
  const selected = useDoc((s) => s.doc.clips.find((c) => c.id === s.selected) ?? null);
  const selectedRange = useDoc((s) => s.selectedRange);
  const selectedMarks = useDoc((s) => s.selectedMarks);
  const selectedClips = useDoc((s) => s.selectedClips);
  const pendingIn = useDoc((s) => s.pendingIn);
  /** Narrow windows: the summary gives way, then the text, then the spacing. */
  const bar = useSqueeze(2);
  if (!source) {
    return (
      <div ref={bar} className={styles.timelineOptions}>
        <span className={styles.optionsText}>
          Open a video, then split with S, mark ranges with R, and trim by dragging a clip&apos;s
          edge.
        </span>
      </div>
    );
  }
  const { rateNum: num, rateDen: den } = source;
  const length = total(doc);
  const hours = needsHours(Math.max(length, longestSource(doc)), num, den);
  const fmt = (f: number) => (inFrames ? String(f) : timecode(f, num, den, hours));
  // The timing fields (PLAN 4.4d2): typed as the readout shows times (a plain frame number
  // too), dragged a frame at a time when slow, Shift ×10 (a second's worth zoomed through
  // short clips; Richard). Fades, short by nature, drag at half speed.
  const time = {
    hint: "time" as const,
    format: fmt,
    parse: (text: string) => parseTimecode(text, num, den),
    width: inFrames ? 64 : hours ? 92 : 76,
  };
  const fade = { ...time, gain: FADE_GAIN };
  // Several clips selected, Shift makes their fades all as long, as on their handles.
  const severalClips = selectedClips.length > 1;
  const clipFadeField = severalClips
    ? {
        ...fade,
        hint: "time.clipsFade" as const,
        shift: { by: 1, label: "all the selected clips as long", live: true },
      }
    : fade;
  // Dragging an edge's field shows its frame, the playhead staying put (as dragging the edge
  // does); letting go shows the playhead's again.
  const peek = (f: number, dragging: boolean) => {
    if (dragging) player?.peekAt(Math.max(0, Math.min(length - 1, f)));
  };
  const unpeek = () => player?.peek(null);

  // Markup: From and To move that end (as dragging it), Length moves To; the fades are kept to
  // its length. Each returns the value as kept.
  const markFrom = (id: MarkId, v: number, dragging: boolean) => {
    const m = markNow(id);
    if (!m) return v;
    const a = Math.max(0, Math.min(m.end - 1, v));
    useDoc.getState().setMark(id, a, m.end, m.lane);
    const start = markNow(id)?.start ?? a;
    peek(start, dragging);
    return start;
  };
  const markTo = (id: MarkId, v: number, dragging: boolean) => {
    const m = markNow(id);
    if (!m) return v;
    useDoc.getState().setMark(id, m.start, Math.max(m.start + 1, v), m.lane);
    const end = markNow(id)?.end ?? v;
    peek(end - 1, dragging);
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

  // A clip: In and Out trim it (as dragging its edge, the frame at that end shown), Length
  // moves its Out. In and Out are its file's frames (at another speed, where its video starts
  // and ends in the file: speed.ts); Length is its frames on the timeline.
  const clipTrim = (id: ClipId, inF: (c: Clip) => number, outF: (c: Clip) => number) => {
    const c = useDoc.getState().doc.clips.find((k) => k.id === id);
    if (c) useDoc.getState().trim(id, inF(c), outF(c));
    const doc = useDoc.getState().doc;
    const i = doc.clips.findIndex((k) => k.id === id);
    return { clip: doc.clips[i], start: clipStarts(doc)[i] };
  };
  const clipIn = (id: ClipId, v: number, dragging: boolean) => {
    const { clip, start } = clipTrim(
      id,
      (c) => clipFrame(c, v),
      (c) => c.out,
    );
    if (!clip) return v;
    peek(start, dragging);
    return sourceFrame(clip, clip.in);
  };
  const clipOut = (id: ClipId, v: number, dragging: boolean) => {
    const { clip, start } = clipTrim(
      id,
      (c) => c.in,
      (c) => clipFrame(c, v),
    );
    if (!clip) return v;
    peek(start + clipLength(clip) - 1, dragging);
    return videoEnd(clip);
  };
  const clipLengthTo = (id: ClipId, v: number) => {
    const { clip } = clipTrim(
      id,
      (c) => c.in,
      (c) => c.in + Math.max(1, v),
    );
    return clip ? clipLength(clip) : v;
  };

  // A clip's fades (PLAN 4.7a), kept to its length as markup's are. With several clips selected,
  // theirs change with it as dragging its handle does: by as much, each as far as it can; with
  // Shift, or typed, each as long as it.
  const clipFade = (
    id: ClipId,
    which: "fadeIn" | "fadeOut",
    v: number,
    dragging: boolean,
    same: boolean,
  ) => {
    const store = useDoc.getState();
    const before = store.gestureStart ?? store.doc;
    const group = store.selectedClips.includes(id) ? store.selectedClips : [id];
    const set = (n: number) => (which === "fadeIn" ? { fadeIn: n } : { fadeOut: n });
    const fadeOf = (doc: typeof before, k: ClipId) => {
      const clip = doc.clips.find((c) => c.id === k);
      return clip ? clipFades(clip)[which] : 0;
    };
    // Typed: one undo step for them all (a drag is one already).
    if (!dragging) store.beginGesture();
    store.setClipFades(id, set(v));
    const own = fadeOf(useDoc.getState().doc, id);
    const by = own - fadeOf(before, id);
    for (const k of group) {
      if (k !== id) store.setClipFades(k, set(same || !dragging ? own : fadeOf(before, k) + by));
    }
    if (!dragging) store.endGesture();
    return own;
  };

  // A range: the same, kept off its neighbours (setRange).
  const rangeFrom = (id: RangeId, v: number, dragging: boolean) => {
    const r = rangeNow(id);
    if (!r) return v;
    useDoc.getState().setRange(id, Math.max(0, Math.min(r.b - 1, v)), r.b);
    const a = rangeNow(id)?.a ?? v;
    peek(a, dragging);
    return a;
  };
  const rangeTo = (id: RangeId, v: number, dragging: boolean) => {
    const r = rangeNow(id);
    if (!r) return v;
    useDoc.getState().setRange(id, r.a, Math.max(r.a + 1, v));
    const b = rangeNow(id)?.b ?? v;
    peek(b - 1, dragging);
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
  /** The clips selected whose recordings have cameras. */
  const withCamera = () =>
    doc.clips
      .filter(
        (c) => (c.id === selected?.id || selectedClips.includes(c.id)) && cameraSizes[c.source],
      )
      .map((c) => c.id);
  const ranges = shownRanges(doc);
  const range = ranges.find((r) => r.id === selectedRange);
  const marks = shownMarks(doc).filter((m) => selectedMarks.includes(m.id));
  const mark = marks.length === 1 ? marks[0] : null;
  const kept = mark && doc.marks.find((m) => m.id === mark.id);
  const object = kept?.object;
  const fades = mark && markFades(kept ?? {}, mark.end - mark.start);
  return (
    <div ref={bar} className={styles.timelineOptions}>
      {pendingIn !== null ? (
        <>
          <b>Range</b>
          <Field label="In" value={fmt(pendingIn)} />
          <span className={styles.optionsText}>
            O sets the out at the playhead · drag the dashed line to adjust · Esc cancels
          </span>
        </>
      ) : marks.length > 1 ? (
        <>
          <b>Markup</b>
          <span className={styles.optionsText}>
            {marks.length} selected · drag one to move them all · Ctrl or Shift+click adds or takes
            one out · Delete removes them
          </span>
        </>
      ) : mark ? (
        <>
          <b>{object ? MARK_NAMES[object.kind] : "Markup"}</b>
          <NumberField
            label="From"
            value={mark.start}
            onChange={(v, dragging) => markFrom(mark.id, v, dragging)}
            onDragEnd={unpeek}
            {...time}
          />
          <NumberField
            label="to"
            name="To"
            value={mark.end}
            onChange={(v, dragging) => markTo(mark.id, v, dragging)}
            onDragEnd={unpeek}
            {...time}
          />
          <NumberField
            label="Length"
            value={mark.end - mark.start}
            onChange={(v) => markLength(mark.id, v)}
            {...time}
          />
          {/* A redaction doesn't fade (PLAN 4.8). */}
          {(!object || canFade(object)) && (
            <>
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
          )}
        </>
      ) : range ? (
        <>
          <b>Range</b>
          <NumberField
            label="From"
            value={range.a}
            onChange={(v, dragging) => rangeFrom(range.id, v, dragging)}
            onDragEnd={unpeek}
            {...time}
          />
          <NumberField
            label="to"
            name="To"
            value={range.b}
            onChange={(v, dragging) => rangeTo(range.id, v, dragging)}
            onDragEnd={unpeek}
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
          <NumberField
            label="In"
            value={sourceFrame(selected, selected.in)}
            onChange={(v, dragging) => clipIn(selected.id, v, dragging)}
            onDragEnd={unpeek}
            {...time}
          />
          <NumberField
            label="Out"
            value={videoEnd(selected)}
            onChange={(v, dragging) => clipOut(selected.id, v, dragging)}
            onDragEnd={unpeek}
            {...time}
          />
          <NumberField
            label="Length"
            value={clipLength(selected)}
            onChange={(v) => clipLengthTo(selected.id, v)}
            about={`Of the source's ${fmt(sourceLength(doc, selected))}`}
            {...time}
          />
          <span className={styles.optionsSep} />
          <NumberField
            label="Fade in"
            value={clipFades(selected).fadeIn}
            onChange={(v, dragging, shift) => clipFade(selected.id, "fadeIn", v, dragging, shift)}
            {...clipFadeField}
            addon={
              clipFades(selected).fadeIn > 0 && (
                <span {...hint("clip.fadeColour")}>
                  <ColorSwatch
                    name="Fade-in colour"
                    value={fadeColours(selected).fadeIn}
                    onPick={(v) => useDoc.getState().setClipFadeColours([selected.id], v, "in")}
                    {...ONE_STEP}
                  />
                </span>
              )
            }
          />
          <NumberField
            label="out"
            name="Fade out"
            value={clipFades(selected).fadeOut}
            onChange={(v, dragging, shift) => clipFade(selected.id, "fadeOut", v, dragging, shift)}
            {...clipFadeField}
            addon={
              clipFades(selected).fadeOut > 0 && (
                <span {...hint("clip.fadeColour")}>
                  <ColorSwatch
                    name="Fade-out colour"
                    value={fadeColours(selected).fadeOut}
                    onPick={(v) => useDoc.getState().setClipFadeColours([selected.id], v, "out")}
                    {...ONE_STEP}
                  />
                </span>
              )
            }
          />
          {cameraSizes[selected.source] && (
            <CameraOptions
              size={selected.cameraSize ?? cameraSizes[selected.source]}
              shown={!selected.cameraHidden}
              // With several selected, the ones with cameras (as their fades).
              onPick={(size) => useDoc.getState().setCameraSize(withCamera(), size)}
              onShow={(shown) => useDoc.getState().setCameraHidden(withCamera(), !shown)}
            />
          )}
        </>
      ) : (
        <span className={styles.optionsText}>
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
