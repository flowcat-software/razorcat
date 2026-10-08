import { useSyncExternalStore, type ReactNode } from "react";
import type { SourceInfo } from "../shared/ipc";
import { shownRanges, total as docTotal } from "./doc";
import { useDoc } from "./docStore";
import { addRangeAtPlayhead, deleteSelected, seekEdit, splitAtPlayhead } from "./edits";
import { exportClip } from "./exports";
import type { Player, PlayerState } from "./player";
import { needsHours, timecode } from "./timecode";
import styles from "./EditorApp.module.css";

interface Props {
  /** The open video and its player; null before one is open. */
  source: SourceInfo | null;
  player: Player | null;
  /** The readout shows frame numbers (a click switches), as the ruler does. */
  inFrames: boolean;
  onToggleFrames: () => void;
}

const PAUSED: PlayerState = { frame: 0, speed: 0 };
const nothing = () => () => {};
const paused = () => PAUSED;

/** Keeps focus off the transport, so Space and the arrows always reach the player. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

function BarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={styles.barButton}
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

/** The readout: the playhead and the length, as timecode or (a click) frame numbers. */
function Readout({
  source,
  frame,
  inFrames,
  onToggle,
}: {
  source: SourceInfo | null;
  frame: number;
  inFrames: boolean;
  onToggle: () => void;
}) {
  // The edit's length.
  const frames = useDoc((s) => docTotal(s.doc));
  let now = "00:00.00";
  let total = "";
  if (source) {
    const { rateNum: num, rateDen: den } = source;
    const hours = needsHours(frames, num, den);
    now = inFrames ? String(frame) : timecode(frame, num, den, hours);
    total = inFrames ? String(frames - 1) : timecode(frames, num, den, hours);
  }
  return (
    <button
      type="button"
      className={styles.timecode}
      title="Click: timecode / frames"
      disabled={!source}
      onMouseDown={keepFocus}
      onClick={onToggle}
    >
      {now}
      {total && <small>/ {total}</small>}
    </button>
  );
}

/**
 * The bar under the preview: the time readout, the transport and the timeline's edits (the
 * mockup's).
 */
export function TimelineBar({ source, player, inFrames, onToggleFrames }: Props) {
  const { frame, speed } = useSyncExternalStore(
    player?.subscribe ?? nothing,
    player?.getState ?? paused,
  );
  const off = !player;
  const selected = useDoc((s) =>
    s.selectedRange !== null ? "range" : s.selected !== null ? "clip" : null,
  );
  const deletable = useDoc((s) => s.selectedRange !== null || s.doc.clips.length > 1);
  const ranges = useDoc((s) => shownRanges(s.doc).length);
  const clipId = useDoc((s) => s.selected);
  return (
    <div className={styles.timelineBar}>
      <Readout source={source} frame={frame} inFrames={inFrames} onToggle={onToggleFrames} />
      <span className={styles.barDivider} />
      <BarButton label="Start (Home)" disabled={off} onClick={() => player?.seek(0)}>
        <path d="M6 5v14M18 6l-8 6 8 6z" />
      </BarButton>
      <BarButton
        label="Previous edit (↑)"
        disabled={off}
        onClick={() => player && seekEdit(player, -1)}
      >
        <path d="M11 6l-6 6 6 6M19 6l-6 6 6 6" />
      </BarButton>
      <BarButton label="Back one frame (←)" disabled={off} onClick={() => player?.step(-1)}>
        <path d="M15 6l-6 6 6 6" />
      </BarButton>
      {speed === 0 ? (
        <BarButton label="Play (Space)" disabled={off} onClick={() => player?.toggle()}>
          <path d="M7 5l12 7-12 7z" />
        </BarButton>
      ) : (
        <BarButton label="Pause (Space)" disabled={off} onClick={() => player?.toggle()}>
          <path d="M8 5v14M16 5v14" />
        </BarButton>
      )}
      <BarButton label="Forward one frame (→)" disabled={off} onClick={() => player?.step(1)}>
        <path d="M9 6l6 6-6 6" />
      </BarButton>
      <BarButton label="Next edit (↓)" disabled={off} onClick={() => player && seekEdit(player, 1)}>
        <path d="M13 6l6 6-6 6M5 6l6 6-6 6" />
      </BarButton>
      <BarButton label="End (End)" disabled={off} onClick={() => player?.seek(player.frames - 1)}>
        <path d="M18 5v14M6 6l8 6-8 6z" />
      </BarButton>
      {speed !== 0 && speed !== 1 ? (
        <span className={styles.speed}>{speed < 0 ? `◀ ${-speed}×` : `${speed}×`}</span>
      ) : null}
      <span className={styles.barDivider} />
      <button
        type="button"
        className={`${styles.barButton} ${styles.withText}`}
        title="Split at the playhead (S)"
        disabled={off}
        onMouseDown={keepFocus}
        onClick={() => player && splitAtPlayhead(player)}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M12 3v18M8 7l-4 5 4 5M16 7l4 5-4 5" />
        </svg>
        Split <span className={styles.kbd}>S</span>
      </button>
      <button
        type="button"
        className={`${styles.barButton} ${styles.withText}`}
        title="Add a range at the playhead (R); I and O mark its in and out"
        disabled={off}
        onMouseDown={keepFocus}
        onClick={() => player && addRangeAtPlayhead(player)}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M4 6v12M20 6v12M4 12h16" />
        </svg>
        Range <span className={styles.kbd}>R</span>
      </button>
      {selected && (
        <button
          type="button"
          className={`${styles.barButton} ${styles.withText}`}
          title={
            !deletable
              ? "The last clip can't be deleted"
              : selected === "range"
                ? "Delete the range (Delete)"
                : "Delete the clip (Delete)"
          }
          disabled={!deletable}
          onMouseDown={keepFocus}
          onClick={deleteSelected}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
          </svg>
          Delete <span className={styles.kbd}>Del</span>
        </button>
      )}
      {selected === "clip" && clipId !== null && (
        <button
          type="button"
          className={`${styles.barButton} ${styles.withText}`}
          title="Export this clip as MP4"
          onMouseDown={keepFocus}
          onClick={() => exportClip(clipId)}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
          </svg>
          Export clip…
        </button>
      )}
      {ranges > 0 && (
        <>
          <span className={styles.barDivider} />
          <button
            type="button"
            className={`${styles.barButton} ${styles.withText}`}
            title="Keep only the ranges: cut out everything else"
            onMouseDown={keepFocus}
            onClick={() => useDoc.getState().keepRanges()}
          >
            Keep ranges
          </button>
          <button
            type="button"
            className={`${styles.barButton} ${styles.withText}`}
            title="Cut the ranges out"
            onMouseDown={keepFocus}
            onClick={() => useDoc.getState().removeRanges()}
          >
            Remove ranges
          </button>
        </>
      )}
    </div>
  );
}
