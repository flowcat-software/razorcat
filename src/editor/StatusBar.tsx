import { SETTINGS_ICON } from "../shared/icons";
import styles from "./EditorApp.module.css";

interface Props {
  /** The hint or message on the left. */
  text: string;
  /** No video yet: the timeline's view controls don't apply. */
  empty: boolean;
}

/** The bottom row: hints, snapping, the timeline's zoom, and Settings (Vandal's gear). */
export function StatusBar({ text, empty }: Props) {
  return (
    <footer className={styles.status}>
      <span>{text}</span>
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
        disabled
      >
        {SETTINGS_ICON}
      </button>
    </footer>
  );
}
