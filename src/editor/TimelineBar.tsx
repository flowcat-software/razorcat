import type { ReactNode } from "react";
import styles from "./EditorApp.module.css";

interface Props {
  /** No video yet: nothing to play or edit. */
  empty: boolean;
}

function BarButton({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={styles.barButton}
      aria-label={label}
      title={label}
      disabled={disabled}
    >
      <svg viewBox="0 0 24 24" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

/**
 * The bar under the preview: the time readout, the transport and the timeline's edits (the
 * mockup's; they arrive in Phases 1 and 2).
 */
export function TimelineBar({ empty }: Props) {
  return (
    <div className={styles.timelineBar}>
      <button
        type="button"
        className={styles.timecode}
        title="Click: timecode / frames"
        disabled={empty}
      >
        00:00:00:00
      </button>
      <span className={styles.barDivider} />
      <BarButton label="Start (Home)" disabled={empty}>
        <path d="M6 5v14M18 6l-8 6 8 6z" />
      </BarButton>
      <BarButton label="Previous edit (↑)" disabled={empty}>
        <path d="M11 6l-6 6 6 6M19 6l-6 6 6 6" />
      </BarButton>
      <BarButton label="Back one frame (←)" disabled={empty}>
        <path d="M15 6l-6 6 6 6" />
      </BarButton>
      <BarButton label="Play (Space)" disabled={empty}>
        <path d="M7 5l12 7-12 7z" />
      </BarButton>
      <BarButton label="Forward one frame (→)" disabled={empty}>
        <path d="M9 6l6 6-6 6" />
      </BarButton>
      <BarButton label="Next edit (↓)" disabled={empty}>
        <path d="M13 6l6 6-6 6M5 6l6 6-6 6" />
      </BarButton>
      <BarButton label="End (End)" disabled={empty}>
        <path d="M18 5v14M6 6l8 6-8 6z" />
      </BarButton>
      <span className={styles.barDivider} />
      <button
        type="button"
        className={`${styles.barButton} ${styles.withText}`}
        title="Split at the playhead (S)"
        disabled={empty}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M12 3v18M8 7l-4 5 4 5M16 7l4 5-4 5" />
        </svg>
        Split <span className={styles.kbd}>S</span>
      </button>
      <button
        type="button"
        className={`${styles.barButton} ${styles.withText}`}
        title="Add a range at the playhead (R)"
        disabled={empty}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M4 6v12M20 6v12M4 12h16" />
        </svg>
        Range <span className={styles.kbd}>R</span>
      </button>
    </div>
  );
}
