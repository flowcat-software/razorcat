import { useEffect, useState } from "react";
import type { TextItem } from "../schema";
import { useSetting, useSettingsStore } from "../store";
import type { ControlProps } from "./index";
import { useDraft } from "./useDraft";
import styles from "./controls.module.css";
import { Alert } from "./Alert";
import { TagReference } from "./TagReference";

/** A line of text, kept when you leave the field or press Enter; Escape puts it back. */
export function TextInput({ item, id, disabled }: ControlProps<TextItem>) {
  const [value] = useSetting(item.path);
  const [draft, setDraft] = useDraft(value);
  /** Why the text was refused, shown under the field. */
  const [error, setError] = useState<string | null>(null);
  const trySet = useSettingsStore((s) => s.trySet);
  /** What the draft gives (a file name), as Vandal's preview; refreshed as it's typed. */
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!item.preview) return;
    let stale = false;
    const t = setTimeout(() => {
      void item.preview!(draft || item.placeholder || "").then((p) => !stale && setPreview(p));
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [draft, item]);

  const commit = async (next: string) => {
    if (next === value) return;
    // The field follows what's stored, as Rust normalizes it (an empty template is the
    // default again).
    setError(await trySet(item.path, next));
  };

  return (
    <div className={styles.stack}>
      <input
        id={id}
        className={styles.input}
        value={draft}
        disabled={disabled}
        spellCheck={false}
        placeholder={item.placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit(draft);
          if (e.key === "Escape") {
            setDraft(value);
            setError(null);
          }
        }}
      />
      {(item.tags || (preview && !error)) && (
        <div className={styles.previewLine}>
          <p className={styles.preview}>
            {preview && !error && (
              <>
                Example: <span className={styles.previewValue}>{preview}</span>
              </>
            )}
          </p>
          {item.tags && <TagReference />}
        </div>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}
