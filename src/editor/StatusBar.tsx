import { hint, HintLine } from "../markup/HintLine";
import { useHintSources } from "../markup/hints";
import { useStyleConfig } from "../markup/styles";
import { SETTINGS_ICON } from "../shared/icons";
import { commands } from "../shared/ipc";
import { useTimeline } from "./timelineStore";
import styles from "./EditorApp.module.css";

/** A message in the status bar (a file that couldn't open), as Vandal's. */
export interface Notice {
  text: string;
  error?: boolean;
  /** A button after the message (a conversion's Cancel). */
  action?: { label: string; run: () => void };
  /** A job's progress (0 to 1), shown as a bar after the message too. */
  progress?: number;
}

/** A message that says something's done shows this long, then fades (as Settings' do). */
const SHOWN_MS = 4000;

/** Each message's own number: a new one, even the same words, shows its full time again. */
const noticeIds = new WeakMap<Notice, number>();
let nextNoticeId = 0;
function noticeId(n: Notice): number {
  let id = noticeIds.get(n);
  if (id === undefined) {
    id = ++nextNoticeId;
    noticeIds.set(n, id);
  }
  return id;
}

interface Props {
  /** The message on the left; "Ready" without one. */
  notice: Notice | null;
  /**
   * The message says something's done: it fades after a moment, then `onFaded`, and the hints
   * are back. Errors, and messages with a button or a bar, stay.
   */
  fades: boolean;
  onFaded: () => void;
  /** No video yet: the timeline's view controls don't apply. */
  empty: boolean;
  /** When the last autosave was written (PLAN PR4), else 0: its mark shows a moment. */
  autosavedAt: number;
  /** A hint too long to fit scrolls when the pointer rests (`appearance.scrollHints`). */
  scrollHints: boolean;
}

/**
 * The bottom row: messages, else the hint line (PLAN 4.6b; why a key did nothing even over a
 * message), snapping, the timeline's zoom, and Settings (Vandal's gear).
 */
export function StatusBar({ notice, fades, onFaded, empty, autosavedAt, scrollHints }: Props) {
  const timeline = useTimeline();
  const slider = Math.round(timeline.slider() * 1000);
  const said = useHintSources((s) => s.said !== null);
  const hints = useStyleConfig((s) => s.showShortcutHints);
  const message = said ? null : notice;
  return (
    <footer className={styles.status}>
      {message || !hints ? (
        <span
          key={message ? noticeId(message) : 0}
          className={
            message?.error ? styles.noticeError : message && fades ? styles.noticeFades : undefined
          }
          style={message && fades ? { animationDelay: `${SHOWN_MS}ms` } : undefined}
          role="status"
          onAnimationEnd={message && fades ? onFaded : undefined}
        >
          {message?.text ?? "Ready"}
        </span>
      ) : (
        <HintLine scroll={scrollHints} />
      )}
      {message?.progress != null && (
        <span
          className={styles.progress}
          role="progressbar"
          aria-label={message.text}
          aria-valuenow={Math.floor(message.progress * 100)}
        >
          <span style={{ width: `${Math.min(1, Math.max(0, message.progress)) * 100}%` }} />
        </span>
      )}
      {message?.action && (
        <button type="button" className={styles.textButton} onClick={message.action.run}>
          {message.action.label}
        </button>
      )}
      <span className={styles.spacer} />
      {/* Its slot is always there, so the hints don't shift as it comes and goes; each autosave
          is a new mark, so it shows again. */}
      <span className={styles.autosaved}>
        {autosavedAt > 0 && (
          <svg key={autosavedAt} viewBox="0 0 24 24" role="img" aria-label="Autosaved">
            <path d="M5 4a1 1 0 0 1 1-1h10l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" />
            <path d="M8.5 12.5l2.5 2.5 4.5-4.5" />
          </svg>
        )}
      </span>
      <button
        type="button"
        className={styles.textButton}
        title="Snapping (hold Shift: off)"
        {...hint("snap")}
        aria-pressed={timeline.snap}
        disabled={empty}
        onMouseDown={(e) => e.preventDefault()}
        onClick={timeline.toggleSnap}
      >
        Snap: {timeline.snap ? "on" : "off"}
      </button>
      <span className={styles.divider} />
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Zoom out (Ctrl+−)"
        title="Zoom out (Ctrl+−)"
        {...hint("zoom")}
        disabled={empty}
        onClick={() => timeline.zoomBy(1 / 1.5)}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M5 12h14" />
        </svg>
      </button>
      <input
        type="range"
        className={styles.zoomSlider}
        aria-label="Timeline zoom (Ctrl+wheel)"
        title="Timeline zoom (Ctrl+wheel)"
        {...hint("zoom")}
        min={0}
        max={1000}
        value={Number.isFinite(slider) ? slider : 0}
        disabled={empty}
        onChange={(e) => timeline.zoomTo(Number(e.target.value) / 1000)}
      />
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Zoom in (Ctrl+=)"
        title="Zoom in (Ctrl+=)"
        {...hint("zoom")}
        disabled={empty}
        onClick={() => timeline.zoomBy(1.5)}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M5 12h14M12 5v14" />
        </svg>
      </button>
      <button
        type="button"
        className={styles.textButton}
        title="Fit the timeline (Ctrl+0)"
        {...hint("zoom")}
        disabled={empty}
        onClick={timeline.fit}
      >
        Fit
      </button>
      <span className={styles.divider} />
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Settings"
        title="Settings (Ctrl+,)"
        {...hint("settings")}
        onClick={() => void commands.openSettings(null)}
      >
        {SETTINGS_ICON}
      </button>
    </footer>
  );
}
