import { canRedo, canUndo, useDoc } from "./docStore";
import styles from "./EditorApp.module.css";

interface Props {
  /** No video yet: only Open works. */
  empty: boolean;
  /** The picture's tools and export aren't built yet (Phases 2.5-4). */
  notYet: boolean;
  onOpen: () => void;
}

/** The tools that work on the picture, by the mockup; they arrive in Phases 3 and 4. */
const TOOLS = [
  { id: "select", label: "Select (V)", icon: <path d="M5 3l14 8-6 2-3 6z" /> },
  {
    id: "crop",
    label: "Crop (C)",
    icon: (
      <>
        <path d="M6 2v16h16" />
        <path d="M2 6h16v16" />
      </>
    ),
  },
  {
    id: "grow",
    label: "Grow the frame (G)",
    icon: (
      <>
        <rect x="7" y="7" width="10" height="10" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      </>
    ),
  },
  { id: "text", label: "Text (T)", icon: <path d="M5 6V4h14v2M12 4v16M9 20h6" /> },
  { id: "arrow", label: "Arrow (A)", icon: <path d="M5 19L19 5M10 5h9v9" /> },
];

/** The editor's top row: the picture's tools on the left, file actions on the right. */
export function CommandBar({ empty, notYet, onOpen }: Props) {
  const undoable = useDoc(canUndo);
  const redoable = useDoc(canRedo);
  return (
    <div className={styles.commandBar}>
      <div className={styles.tools}>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={styles.tool}
            aria-label={t.label}
            aria-pressed={!empty && !notYet && t.id === "select"}
            title={t.label}
            disabled={empty || notYet}
          >
            <svg viewBox="0 0 24 24" aria-hidden>
              {t.icon}
            </svg>
          </button>
        ))}
        <span className={styles.toolbarDivider} />
        <button
          type="button"
          className={styles.tool}
          aria-label="Undo (Ctrl+Z)"
          title="Undo (Ctrl+Z)"
          disabled={empty || !undoable}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useDoc.getState().undo()}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M9 14L4 9l5-5" />
            <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.tool}
          aria-label="Redo (Ctrl+Y)"
          title="Redo (Ctrl+Y)"
          disabled={empty || !redoable}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useDoc.getState().redo()}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M15 14l5-5-5-5" />
            <path d="M20 9H9a5 5 0 0 0 0 10h3" />
          </svg>
        </button>
      </div>
      <span className={styles.spacer} />
      <button
        type="button"
        className={styles.button}
        aria-label="Open (Ctrl+O)"
        title="Open (Ctrl+O)"
        onClick={onOpen}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span className={styles.label}>Open</span>
      </button>
      <div className={styles.split}>
        <button
          type="button"
          className={styles.splitMain}
          aria-label="Export the timeline (Ctrl+E)"
          title="Export the timeline (Ctrl+E)"
          disabled={empty || notYet}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
          </svg>
          <span className={styles.label}>Export MP4</span>
        </button>
        <button
          type="button"
          className={styles.splitMore}
          aria-label="Export options"
          title="Export options"
          disabled={empty || notYet}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
