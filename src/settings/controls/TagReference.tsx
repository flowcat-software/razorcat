import { useEffect, useRef, useState } from "react";
import styles from "./controls.module.css";

/** The file-name tags (names.rs), one guide for every template field. */
const TAGS: readonly {
  tags: string;
  gives: string;
  example: string;
  clipOnly?: boolean;
  /** Not for recordings: they haven't a video name or clips. */
  videoOnly?: boolean;
}[] = [
  { tags: "{name}", gives: "The video's name", example: "trip", videoOnly: true },
  { tags: "{yyyy} {MM} {dd}", gives: "Today's year, month and day", example: "2026 10 24" },
  {
    tags: "{HH} {mm} {ss}",
    gives: "The time: hour (24-hour), minute, second",
    example: "09 30 05",
  },
  {
    tags: "{n}",
    gives: "A number one higher than the highest already in the folder",
    example: "1, 2, 3…",
  },
  { tags: "{nn} {nnn}…", gives: "The same, with zeros in front", example: "01, 001" },
  {
    tags: "{c}",
    gives: "The clip's number",
    example: "1, 2, 3…",
    clipOnly: true,
    videoOnly: true,
  },
  {
    tags: "{cc} {ccc}…",
    gives: "The same, with zeros in front",
    example: "01, 001",
    clipOnly: true,
    videoOnly: true,
  },
];

/**
 * A "Tag reference" link that opens the guide to file-name tags over the window (a native modal
 * `<dialog>`: Esc or a click outside closes it). A recording's (`recording`) has fewer.
 */
export function TagReference({ recording = false }: { recording?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={styles.linkButton} onClick={() => setOpen(true)}>
        Tag reference
      </button>
      {open && <TagDialog recording={recording} onClose={() => setOpen(false)} />}
    </>
  );
}

function TagDialog({ recording, onClose }: { recording: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`${styles.dialog} ${styles.tagDialog}`}
      aria-labelledby="tag-reference-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A click on the backdrop lands on the dialog itself, outside its box.
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const inside =
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom;
        if (e.target === e.currentTarget && !inside) onClose();
      }}
    >
      <h2 id="tag-reference-title" className={styles.dialogTitle}>
        File name tags
      </h2>
      <div className={styles.dialogBody}>
        <p>
          Tags in a file name template are filled in when you {recording ? "record" : "export"}.
          Everything else is kept as typed.
        </p>
        <table className={styles.tagTable}>
          <thead>
            <tr>
              <th>Tag</th>
              <th>Gives</th>
              <th>Example</th>
            </tr>
          </thead>
          <tbody>
            {TAGS.filter((t) => !(recording && t.videoOnly)).map((t) => (
              <tr key={t.tags}>
                <td>
                  <code>{t.tags}</code>
                </td>
                <td>
                  {t.gives}
                  {t.clipOnly && <span className={styles.tagNote}> (clip file names only)</span>}
                </td>
                <td>{t.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          For example,{" "}
          {recording ? (
            <>
              <code>{"Take {nn}"}</code> gives Take 01, then Take 02.
            </>
          ) : (
            <>
              <code>{"{name}-edit-{nn}"}</code> gives trip-edit-01, then trip-edit-02.
            </>
          )}{" "}
          <code>{"{n}"}</code> counts only files whose names fit the template, so with the date in
          it, each day starts counting again at 1.
        </p>
      </div>
      <div className={styles.dialogButtons}>
        <button
          type="button"
          className={`${styles.button} ${styles.primaryButton}`}
          autoFocus
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </dialog>
  );
}
