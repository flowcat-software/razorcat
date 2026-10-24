import { useEffect, useRef, type ReactNode } from "react";
import styles from "./controls.module.css";

interface Props {
  title: string;
  children: ReactNode;
  confirm: string;
  /** The cancel button's label: "Cancel" unless said. */
  cancel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** A second answer, between Cancel and the confirm button. */
  other?: { label: string; onClick: () => void };
}

/**
 * A question over the whole window (a native modal `<dialog>`: the page
 * behind is dimmed and inert, Esc cancels). The confirm button has the focus,
 * so Enter answers yes.
 */
export function ConfirmDialog({
  title,
  children,
  confirm,
  cancel = "Cancel",
  onConfirm,
  onCancel,
  other,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id="confirm-title" className={styles.dialogTitle}>
        {title}
      </h2>
      <div className={styles.dialogBody}>{children}</div>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.button} onClick={onCancel}>
          {cancel}
        </button>
        {other && (
          <button type="button" className={styles.button} onClick={other.onClick}>
            {other.label}
          </button>
        )}
        <button
          type="button"
          className={`${styles.button} ${styles.primaryButton}`}
          autoFocus
          onClick={onConfirm}
        >
          {confirm}
        </button>
      </div>
    </dialog>
  );
}
