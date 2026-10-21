import type { NumberItem } from "../schema";
import { useSetting } from "../store";
import type { ControlProps } from "./index";
import { useDraft } from "./useDraft";
import styles from "./controls.module.css";

/**
 * A whole number, kept when you leave the field or press Enter (to its range; anything else
 * puts it back); Escape puts it back.
 */
export function NumberInput({ item, id, disabled }: ControlProps<NumberItem>) {
  const [value, setStored] = useSetting(item.path);
  const [draft, setDraft] = useDraft(String(value));

  const commit = () => {
    const n = Math.round(Number(draft));
    if (draft.trim() === "" || !Number.isFinite(n)) return setDraft(String(value));
    const kept = Math.max(item.min, Math.min(item.max, n));
    setDraft(String(kept));
    if (kept !== value) setStored(kept);
  };

  return (
    <span className={styles.numberRow}>
      <input
        id={id}
        className={`${styles.input} ${styles.numberInput}`}
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(String(value));
        }}
      />
      <span className={styles.help}>{item.unit}</span>
    </span>
  );
}
