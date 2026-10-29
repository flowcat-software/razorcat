import { hint } from "../markup/HintLine";
import styles from "./EditorApp.module.css";

/** The preview with no video yet: how to get one. */
export function EmptyEditor({ onOpen }: { onOpen: () => void }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyCard}>
        <p className={styles.emptyTitle}>Open a video or project</p>
        <button type="button" className={styles.button} onClick={onOpen} {...hint("open")}>
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          Open
        </button>
        <p className={styles.emptyHint}>
          Or drop one here: a video (MP4, MOV, MKV, WebM or GIF) or a Razorcat project (.rct).
        </p>
      </div>
    </div>
  );
}
