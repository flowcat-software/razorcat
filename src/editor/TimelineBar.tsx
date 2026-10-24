import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { hint } from "../markup/HintLine";
import type { ControlHint } from "../markup/hints";
import type { SourceInfo } from "../shared/ipc";
import { shownRanges, total as docTotal } from "./doc";
import { useDoc } from "./docStore";
import {
  addRangeAtPlayhead,
  deleteSelected,
  duplicateSelectedClip,
  seekEdit,
  splitAtPlayhead,
} from "./edits";
import { clipsExportItems, exportClip } from "./exports";
import { Menu } from "./Menu";
import { usePlayback } from "./playback";
import type { Player, PlayerState } from "./player";
import { useSqueeze } from "./squeeze";
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

const PAUSED: PlayerState = { frame: 0, speed: 0, source: null };
const nothing = () => () => {};
const paused = () => PAUSED;

/** Keeps focus off the transport, so Space and the arrows always reach the player. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

function BarButton({
  label,
  hintId,
  disabled,
  onClick,
  children,
}: {
  label: string;
  /** Its hint in the status bar (PLAN 4.6b). */
  hintId: ControlHint;
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
      {...hint(hintId)}
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
      {...hint("readout")}
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
 * The preview's sound (PLAN 5a): the speaker mutes it, the slider sets how loud (dragged while
 * muted, it unmutes), a scroll over either 5% a notch. The export isn't changed. In a narrow
 * window the slider gives way (squeeze.ts) and the speaker opens it in a popup, with the mute.
 */
function Volume({ disabled }: { disabled: boolean }) {
  const muted = usePlayback((s) => s.muted);
  /** The popup, where it opens; only in a narrow window. */
  const [popup, setPopup] = useState<{ x: number; y: number } | null>(null);
  const speaker = useRef<HTMLButtonElement>(null);
  return (
    <span className={styles.volume} {...hint("volume")} onWheel={(e) => wheel(e, disabled)}>
      <button
        ref={speaker}
        type="button"
        className={styles.barButton}
        aria-label={muted ? "Unmute playback" : "Mute playback"}
        aria-pressed={muted}
        aria-expanded={popup !== null}
        title={`${muted ? "Unmute" : "Mute"} playback (the export isn't changed)`}
        disabled={disabled}
        onMouseDown={keepFocus}
        onClick={(e) => {
          const bar = e.currentTarget.closest<HTMLElement>("[data-fit]");
          if (Number(bar?.dataset.fit) < 1) return usePlayback.getState().setMuted(!muted);
          if (popup) return setPopup(null);
          const r = e.currentTarget.getBoundingClientRect();
          setPopup({ x: r.left, y: r.bottom + 4 });
        }}
      >
        <Speaker />
      </button>
      <VolumeSlider disabled={disabled} className={styles.volumeInBar} />
      {popup && (
        <VolumePopup
          x={popup.x}
          y={popup.y}
          anchor={speaker}
          disabled={disabled}
          onClose={() => setPopup(null)}
        />
      )}
    </span>
  );
}

/** Sets the volume (unmuting), from the slider or the wheel. */
function setVolume(v: number) {
  const playback = usePlayback.getState();
  playback.setVolume(v);
  if (playback.muted) playback.setMuted(false);
}

/** A scroll over the speaker or the slider: 5% a notch. */
function wheel(e: React.WheelEvent, disabled: boolean) {
  if (disabled || e.deltaY === 0) return;
  setVolume(Math.round(usePlayback.getState().volume * 20 - Math.sign(e.deltaY)) / 20);
}

/** The speaker: struck through when silent, its waves as loud as the volume. */
function Speaker() {
  const volume = usePlayback((s) => s.volume);
  const muted = usePlayback((s) => s.muted);
  const silent = muted || volume === 0;
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" />
      {silent ? (
        <path d="M15.5 9.5l5 5M20.5 9.5l-5 5" />
      ) : (
        <>
          <path d="M15 9.5a3.5 3.5 0 0 1 0 5" />
          {volume > 0.5 && <path d="M17.5 7a7 7 0 0 1 0 10" />}
        </>
      )}
    </svg>
  );
}

function VolumeSlider({ disabled, className }: { disabled: boolean; className?: string }) {
  const volume = usePlayback((s) => s.volume);
  const muted = usePlayback((s) => s.muted);
  return (
    <input
      type="range"
      className={`${styles.volumeSlider} ${className ?? ""}`}
      data-muted={muted || undefined}
      aria-label="Playback volume"
      title={`Playback volume: ${Math.round(volume * 100)}% (the export isn't changed)`}
      min={0}
      max={100}
      value={Math.round(volume * 100)}
      disabled={disabled}
      tabIndex={-1}
      onChange={(e) => setVolume(Number(e.currentTarget.value) / 100)}
      // Let go, the keys are the player's again (Space, the arrows).
      onPointerUp={(e) => e.currentTarget.blur()}
    />
  );
}

/**
 * The volume in a narrow window: the mute, the slider and how loud. A press outside it (not on
 * the speaker, which closes it itself), Escape, or leaving the window closes it.
 */
function VolumePopup({
  x,
  y,
  anchor,
  disabled,
  onClose,
}: {
  x: number;
  y: number;
  anchor: React.RefObject<HTMLElement | null>;
  disabled: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const volume = usePlayback((s) => s.volume);
  const muted = usePlayback((s) => s.muted);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      // Kept on screen.
      const r = el.getBoundingClientRect();
      el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    }
    const away = (e: PointerEvent) => {
      const at = e.target as Node;
      if (!ref.current?.contains(at) && !anchor.current?.contains(at)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [x, anchor, onClose]);
  return (
    <div
      ref={ref}
      className={styles.volumePopup}
      style={{ left: x, top: y }}
      onWheel={(e) => wheel(e, disabled)}
    >
      <button
        type="button"
        className={styles.barButton}
        aria-label={muted ? "Unmute playback" : "Mute playback"}
        aria-pressed={muted}
        title={`${muted ? "Unmute" : "Mute"} playback (the export isn't changed)`}
        disabled={disabled}
        onMouseDown={keepFocus}
        onClick={() => usePlayback.getState().setMuted(!muted)}
      >
        <Speaker />
      </button>
      <VolumeSlider disabled={disabled} />
      <span className={styles.volumeValue}>{muted ? "Muted" : `${Math.round(volume * 100)}%`}</span>
    </div>
  );
}

/**
 * The bar under the preview: the time readout, the transport and the timeline's edits (the
 * mockup's). In a narrow window it squeezes (squeeze.ts): the volume slider moves into a popup,
 * then the edit buttons drop their labels and then close up, then the readout drops the length.
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
  const picked = useDoc((s) => s.selectedClips);
  /** Several clips selected (PLAN 4.5f): the buttons act on them all. */
  const several = picked.length > 1;
  const deletesAll = useDoc((s) => s.selectedClips.length >= s.doc.clips.length);
  /** The Export… button's menu (the clip or clips, as MP4 or GIF), where it opens. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const bar = useSqueeze(4);
  return (
    <div ref={bar} className={styles.timelineBar}>
      <Readout source={source} frame={frame} inFrames={inFrames} onToggle={onToggleFrames} />
      <span className={styles.barDivider} />
      <BarButton label="Start (Home)" hintId="start" disabled={off} onClick={() => player?.seek(0)}>
        <path d="M6 5v14M18 6l-8 6 8 6z" />
      </BarButton>
      <BarButton
        label="Previous edit (↑)"
        hintId="prevEdit"
        disabled={off}
        onClick={() => player && seekEdit(player, -1)}
      >
        <path d="M11 6l-6 6 6 6M19 6l-6 6 6 6" />
      </BarButton>
      <BarButton
        label="Back one frame (←)"
        hintId="back"
        disabled={off}
        onClick={() => player?.step(-1)}
      >
        <path d="M15 6l-6 6 6 6" />
      </BarButton>
      {speed === 0 ? (
        <BarButton
          label="Play (Space)"
          hintId="play"
          disabled={off}
          onClick={() => player?.toggle()}
        >
          <path d="M7 5l12 7-12 7z" />
        </BarButton>
      ) : (
        <BarButton
          label="Pause (Space)"
          hintId="play"
          disabled={off}
          onClick={() => player?.toggle()}
        >
          <path d="M8 5v14M16 5v14" />
        </BarButton>
      )}
      <BarButton
        label="Forward one frame (→)"
        hintId="forward"
        disabled={off}
        onClick={() => player?.step(1)}
      >
        <path d="M9 6l6 6-6 6" />
      </BarButton>
      <BarButton
        label="Next edit (↓)"
        hintId="nextEdit"
        disabled={off}
        onClick={() => player && seekEdit(player, 1)}
      >
        <path d="M13 6l6 6-6 6M5 6l6 6-6 6" />
      </BarButton>
      <BarButton
        label="End (End)"
        hintId="end"
        disabled={off}
        onClick={() => player?.seek(player.frames - 1)}
      >
        <path d="M18 5v14M6 6l8 6-8 6z" />
      </BarButton>
      {speed !== 0 && speed !== 1 ? (
        <span className={styles.speed}>{speed < 0 ? `◀ ${-speed}×` : `${speed}×`}</span>
      ) : null}
      <Volume disabled={off} />
      <span className={styles.barDivider} />
      <button
        type="button"
        className={`${styles.barButton} ${styles.withText}`}
        title="Split at the playhead (S)"
        {...hint("split")}
        disabled={off}
        onMouseDown={keepFocus}
        onClick={() => player && splitAtPlayhead(player)}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M12 3v18M8 7l-4 5 4 5M16 7l4 5-4 5" />
        </svg>
        <span className={styles.barLabel}>Split</span>
      </button>
      <button
        type="button"
        className={`${styles.barButton} ${styles.withText}`}
        title="Add a range at the playhead (R); I and O mark its in and out"
        {...hint("range")}
        disabled={off}
        onMouseDown={keepFocus}
        onClick={() => player && addRangeAtPlayhead(player)}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M4 6v12M20 6v12M4 12h16" />
        </svg>
        <span className={styles.barLabel}>Range</span>
      </button>
      {selected && (
        <button
          type="button"
          className={`${styles.barButton} ${styles.withText}`}
          title={
            !deletable || (selected === "clip" && deletesAll)
              ? "The timeline keeps at least one clip"
              : selected === "range"
                ? "Delete the range (Delete)"
                : several
                  ? "Delete the selected clips (Delete)"
                  : "Delete the clip (Delete)"
          }
          {...hint("delete")}
          disabled={!deletable || (selected === "clip" && deletesAll)}
          onMouseDown={keepFocus}
          onClick={deleteSelected}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
          </svg>
          <span className={styles.barLabel}>Delete</span>
        </button>
      )}
      {selected === "clip" && (
        <button
          type="button"
          className={`${styles.barButton} ${styles.withText}`}
          title={
            several
              ? "Put copies of the selected clips after the last of them (Ctrl+D); Ctrl+C and Ctrl+V copy them and paste them at the cut nearest the playhead"
              : "Put a copy of the clip straight after it (Ctrl+D); Ctrl+C and Ctrl+V copy it and paste it at the cut nearest the playhead"
          }
          {...hint("duplicateClip")}
          disabled={off}
          onMouseDown={keepFocus}
          onClick={() => player && duplicateSelectedClip(player)}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M9 9h11v11H9zM5 15V4h11" />
          </svg>
          <span className={styles.barLabel}>Duplicate</span>
        </button>
      )}
      {selected === "clip" && clipId !== null && (
        <button
          type="button"
          className={`${styles.barButton} ${styles.withText}`}
          title={
            several
              ? "Export the selected clips, as one file or a file each (MP4 or GIF)"
              : "Export this clip (MP4 or GIF)"
          }
          {...hint("exportClip")}
          aria-expanded={menu !== null}
          onMouseDown={keepFocus}
          onClick={(e) => {
            if (menu) return setMenu(null);
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4 });
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
          </svg>
          <span className={styles.barLabel}>Export…</span>
        </button>
      )}
      {menu && clipId !== null && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            several
              ? clipsExportItems(picked, "Clips")
              : [
                  { label: "Clip as MP4…", run: () => exportClip(clipId, "mp4") },
                  { label: "Clip as GIF…", run: () => exportClip(clipId, "gif") },
                ]
          }
        />
      )}
      {ranges > 0 && (
        <>
          <span className={styles.barDivider} />
          <button
            type="button"
            className={`${styles.barButton} ${styles.withText}`}
            title="Keep only the ranges: cut out everything else"
            {...hint("keepRanges")}
            onMouseDown={keepFocus}
            onClick={() => useDoc.getState().keepRanges()}
          >
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M4 6v12M20 6v12" />
              <rect x="8" y="9" width="8" height="6" rx="1" fill="currentColor" opacity="0.45" />
            </svg>
            <span className={styles.barLabel}>Keep ranges</span>
          </button>
          <button
            type="button"
            className={`${styles.barButton} ${styles.withText}`}
            title="Cut the ranges out"
            {...hint("removeRanges")}
            onMouseDown={keepFocus}
            onClick={() => useDoc.getState().removeRanges()}
          >
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M4 6v12M20 6v12M9 9l6 6M15 9l-6 6" />
            </svg>
            <span className={styles.barLabel}>Remove ranges</span>
          </button>
        </>
      )}
    </div>
  );
}
