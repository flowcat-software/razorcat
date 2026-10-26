import { useRef, useState, type ReactNode } from "react";
import { hint } from "./HintLine";
import type { ControlHint } from "./hints";
import { boxOf, useMenuPlacement } from "./menuPlacement";
import { usePopover } from "./usePopover";
import styles from "./options.module.css";

/** Two arrows going round: Sync style's. */
const SYNC_ICON = (
  <>
    <path d="M4 12a8 8 0 1 0 2.3-5.7" />
    <path d="M4 4v4h4" />
  </>
);

/**
 * A button that asks `question` in a popover before doing `onConfirm`
 * (Enter confirms, Esc cancels), or does it at once when `question` is null.
 * `extra` goes under the question (a checkbox); `undoable` says Ctrl+Z undoes it.
 */
export function ConfirmButton({
  label,
  hintId,
  disabled,
  question,
  onConfirm,
  icon = SYNC_ICON,
  title,
  extra,
  undoable = true,
}: {
  label: string;
  hintId: ControlHint;
  disabled: boolean;
  question: ReactNode | null;
  onConfirm: () => void;
  icon?: ReactNode;
  title?: string;
  extra?: ReactNode;
  undoable?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useMenuPlacement(confirming, menuRef, () => boxOf(buttonRef.current));
  usePopover(
    confirming,
    rootRef,
    (keep) => {
      setConfirming(false);
      if (keep) onConfirm();
    },
    "cancel",
  );
  return (
    <div ref={rootRef} className={styles.dropdownRoot}>
      <button
        ref={buttonRef}
        type="button"
        className={`${styles.toggle} ${styles.labelled}`}
        title={title}
        {...hint(hintId)}
        disabled={disabled}
        aria-expanded={confirming}
        onClick={() => (question ? setConfirming((c) => !c) : onConfirm())}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          {icon}
        </svg>
        <span>{label}</span>
      </button>
      {confirming && (
        <div ref={menuRef} className={`${styles.menu} ${styles.confirm}`} role="alertdialog">
          <p>
            {question}
            {undoable && " You can undo it with Ctrl+Z."}
          </p>
          {extra}
          <div className={styles.colorActions}>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={styles.accentButton}
              onClick={() => {
                setConfirming(false);
                onConfirm();
              }}
            >
              {label}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
