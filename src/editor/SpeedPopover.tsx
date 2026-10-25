import { useEffect, useRef, type PointerEvent } from "react";
import { useMenuPlacement } from "../markup/menuPlacement";
import { usePopover } from "../markup/usePopover";
import type { SourceInfo } from "../shared/ipc";
import { clipLength, longestSource, total, type Clip } from "./doc";
import { useDoc } from "./docStore";
import { NumberField } from "./NumberField";
import {
  NORMAL_SPEED,
  sameSpeed,
  sourceFrame,
  SPEED_PRESETS,
  speedFromPercent,
  speedOf,
  speedPercent,
  videoEnd,
} from "./speed";
import { closeSpeed, useSpeedPopover, type Point } from "./speedStore";
import { needsHours, parseTimecode, timecode } from "./timecode";
import markup from "../markup/options.module.css";
import styles from "./EditorApp.module.css";

/** The Speed field's input, which has the cursor when the popover opens. */
const SPEED_FIELD = "clip-speed";
/** How close to the window's edge it can be moved (px). */
const MARGIN = 8;

interface Props {
  source: SourceInfo | null;
  /** Times as frame numbers, as the readout. */
  inFrames: boolean;
}

/**
 * A clip's speed (PLAN §7, Clip speed), as Premiere's and Resolve's: a percent, or the duration
 * that speed gives it (its video all kept, where the options bar's Length trims), linked; the
 * usual speeds a click away. Its fields drag as the options bar's do; its title bar moves it.
 * Everything changed while it's open is one undo step: Enter, OK, × or a click elsewhere keeps
 * it (Richard), Esc puts it all back. Closed, the timeline has the keys again (Space plays).
 */
export function SpeedPopover({ source, inFrames }: Props) {
  const at = useSpeedPopover((s) => s.at);
  const clip = useDoc((s) => (at ? s.doc.clips.find((c) => c.id === at.clip) : undefined));
  if (!at || !clip || !source) return null;
  // Opened anew (another clip, or again), its own gesture.
  return (
    <Panel
      key={`${at.clip}:${at.x}:${at.y}`}
      clip={clip}
      at={at}
      source={source}
      inFrames={inFrames}
    />
  );
}

function Panel({
  clip,
  at,
  source,
  inFrames,
}: {
  clip: Clip;
  at: Point;
  source: SourceInfo;
  inFrames: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closed = useRef(false);
  const doc = useDoc((s) => s.doc);
  /** Moved by its title bar: it stays where it was put (placed by hand, not below the clip). */
  const moved = useRef(false);
  useMenuPlacement(true, rootRef, () =>
    moved.current ? null : { left: at.x, top: at.y, width: 0, height: 0 },
  );

  // Its title bar moves it, kept inside the window (Richard).
  const onTitleDown = (e: PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (e.button !== 0 || !root || (e.target as Element).closest("button")) return;
    e.preventDefault();
    const bar = e.currentTarget;
    bar.setPointerCapture(e.pointerId);
    const r = root.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const onMove = (m: globalThis.PointerEvent) => {
      moved.current = true;
      const left = Math.max(MARGIN, Math.min(innerWidth - r.width - MARGIN, m.clientX - dx));
      const top = Math.max(MARGIN, Math.min(innerHeight - r.height - MARGIN, m.clientY - dy));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
    };
    const onUp = () => {
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      bar.removeEventListener("pointercancel", onUp);
    };
    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
    bar.addEventListener("pointercancel", onUp);
  };

  // One undo step for all of it, from opening to closing. (Its cleanup ends the step if it goes
  // some other way: the clip deleted, a new file opened.)
  useEffect(() => {
    useDoc.getState().beginGesture();
    const field = document.getElementById(SPEED_FIELD);
    if (field instanceof HTMLInputElement) {
      field.focus();
      field.select();
    }
    return () => {
      if (!closed.current) useDoc.getState().endGesture();
    };
  }, []);
  const close = (keep: boolean) => {
    if (closed.current) return;
    closed.current = true;
    const store = useDoc.getState();
    if (keep) store.endGesture();
    else store.cancelGesture();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    closeSpeed();
  };
  usePopover(true, rootRef, close, "keep");

  const { rateNum: num, rateDen: den } = source;
  const hours = needsHours(Math.max(total(doc), longestSource(doc)), num, den);
  const fmt = (f: number) => (inFrames ? String(f) : timecode(f, num, den, hours));
  const time = {
    hint: "time" as const,
    format: fmt,
    parse: (text: string) => parseTimecode(text, num, den),
    width: inFrames ? 64 : hours ? 92 : 76,
  };
  const now = speedOf(clip);
  const id = clip.id;
  const clipNow = () => useDoc.getState().doc.clips.find((c) => c.id === id);
  const setSpeed = (percent: number) => {
    useDoc.getState().setSpeed([id], speedFromPercent(percent));
    const c = clipNow();
    return c ? speedPercent(speedOf(c)) : percent;
  };
  const setDuration = (v: number) => {
    useDoc.getState().setDuration(id, Math.max(1, v));
    const c = clipNow();
    return c ? clipLength(c) : v;
  };
  // Its video's length at 100%: the source frames it shows.
  const natural = videoEnd(clip) - sourceFrame(clip, clip.in);

  return (
    <div
      ref={rootRef}
      className={`${markup.menu} ${markup.colorMenu} ${styles.speedPopover}`}
      role="dialog"
      aria-label={`Clip ${id}'s speed`}
    >
      <div className={styles.speedTitleBar} onPointerDown={onTitleDown}>
        <b>Clip {id} speed</b>
        <button
          type="button"
          className={styles.speedClose}
          aria-label="Close"
          title="Close, keeping the changes · Esc puts them back"
          onClick={() => close(true)}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className={styles.speedFields}>
        <NumberField
          label="Speed"
          value={speedPercent(now)}
          onChange={(v) => setSpeed(v)}
          format={(v) => `${+v.toFixed(2)}%`}
          parse={(text) => {
            const n = Number(text.replace("%", ""));
            return text.trim() !== "" && Number.isFinite(n) ? n : null;
          }}
          decimals={2}
          width={time.width}
          hint="clip.speed"
          inputId={SPEED_FIELD}
        />
        <NumberField
          label="Duration"
          value={clipLength(clip)}
          onChange={(v) => setDuration(v)}
          {...time}
          hint="clip.duration"
        />
      </div>
      <div className={styles.speedPresetRow} role="group" aria-label="Usual speeds">
        {SPEED_PRESETS.map((p) => {
          const s = speedFromPercent(p);
          return (
            <button
              key={p}
              type="button"
              className={markup.ghostButton}
              aria-pressed={sameSpeed(s, now)}
              onClick={() => useDoc.getState().setSpeed([id], s)}
            >
              {p}%
            </button>
          );
        })}
      </div>
      <span className={markup.colorCaption}>
        {fmt(natural)} at 100% · this keeps all of the clip, where Length trims it
      </span>
      <div className={markup.colorActions}>
        <button
          type="button"
          className={markup.ghostButton}
          disabled={sameSpeed(now, NORMAL_SPEED)}
          onClick={() => useDoc.getState().setSpeed([id], NORMAL_SPEED)}
        >
          Reset
        </button>
        <span className={markup.spacer} />
        <button type="button" className={markup.accentButton} onClick={() => close(true)}>
          OK
        </button>
      </div>
    </div>
  );
}
