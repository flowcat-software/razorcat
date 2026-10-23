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
}

interface Props {
  /** The message on the left; "Ready" without one. */
  notice: Notice | null;
  /** No video yet: the timeline's view controls don't apply. */
  empty: boolean;
}

/**
 * The bottom row: messages, else the hint line (PLAN 4.6b; why a key did nothing even over a
 * message), snapping, the timeline's zoom, and Settings (Vandal's gear).
 */
export function StatusBar({ notice, empty }: Props) {
  const timeline = useTimeline();
  const slider = Math.round(timeline.slider() * 1000);
  const said = useHintSources((s) => s.said !== null);
  const hints = useStyleConfig((s) => s.showShortcutHints);
  const message = said ? null : notice;
  return (
    <footer className={styles.status}>
      {message || !hints ? (
        <span className={message?.error ? styles.noticeError : undefined} role="status">
          {message?.text ?? "Ready"}
        </span>
      ) : (
        <HintLine />
      )}
      {message?.action && (
        <button type="button" className={styles.textButton} onClick={message.action.run}>
          {message.action.label}
        </button>
      )}
      <span className={styles.spacer} />
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
