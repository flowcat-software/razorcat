import { SETTINGS_ICON } from "../shared/icons";
import { commands } from "../shared/ipc";
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

/** The bottom row: messages, snapping, the timeline's zoom, and Settings (Vandal's gear). */
export function StatusBar({ notice, empty }: Props) {
  return (
    <footer className={styles.status}>
      <span className={notice?.error ? styles.noticeError : undefined} role="status">
        {notice?.text ?? "Ready"}
      </span>
      {notice?.action && (
        <button type="button" className={styles.textButton} onClick={notice.action.run}>
          {notice.action.label}
        </button>
      )}
      <span className={styles.spacer} />
      <button
        type="button"
        className={styles.textButton}
        title="Snapping (hold Alt: off)"
        disabled={empty}
      >
        Snap: on
      </button>
      <span className={styles.divider} />
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Zoom out (Ctrl+−)"
        title="Zoom out (Ctrl+−)"
        disabled={empty}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M5 12h14" />
        </svg>
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Zoom in (Ctrl+=)"
        title="Zoom in (Ctrl+=)"
        disabled={empty}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M5 12h14M12 5v14" />
        </svg>
      </button>
      <button
        type="button"
        className={styles.textButton}
        title="Fit the timeline (Ctrl+0)"
        disabled={empty}
      >
        Fit
      </button>
      <span className={styles.divider} />
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Settings"
        title="Settings (Ctrl+,)"
        onClick={() => void commands.openSettings()}
      >
        {SETTINGS_ICON}
      </button>
    </footer>
  );
}
