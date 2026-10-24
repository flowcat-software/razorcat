import { useEffect, useState } from "react";
import { commands } from "../../shared/ipc";
import type { FolderItem } from "../schema";
import { useSetting, useSettingsStore } from "../store";
import type { ControlProps } from "./index";
import { useDraft } from "./useDraft";
import styles from "./controls.module.css";
import { Alert } from "./Alert";

/** A path you can type (env vars like %USERPROFILE% allowed), browse or open (Vandal's). */
export function FolderInput({ item, id, disabled }: ControlProps<FolderItem>) {
  const [stored] = useSetting(item.path);
  const [defaultFolder, setDefaultFolder] = useState("");
  // Empty means the default: the field shows the default's path, as an ordinary value.
  const value = stored || defaultFolder;
  const [draft, setDraft] = useDraft(value);
  /** Why the folder was refused (or couldn't be opened), shown under the field. */
  const [error, setError] = useState<string | null>(null);
  const trySet = useSettingsStore((s) => s.trySet);

  useEffect(() => {
    let gone = false;
    void item.defaultFolder?.().then((p) => !gone && setDefaultFolder(p));
    return () => {
      gone = true;
    };
  }, [item]);

  const commit = async (next: string) => {
    if (next === value) return;
    // Cleared, or the default typed in: stored as the default (empty).
    const store = next.trim() === "" || next.trim() === defaultFolder ? "" : next;
    if (store === "") setDraft(defaultFolder);
    setError(await trySet(item.path, store));
  };

  const browse = async () => {
    const picked = await commands.pickFolder(draft || value);
    if (picked) {
      setDraft(picked);
      void commit(picked);
    }
  };

  const open = async () => {
    const result = await commands.openFolder(value);
    setError(result.status === "error" ? result.error : null);
  };

  return (
    <div className={styles.stack}>
      <div className={styles.folderRow}>
        <input
          id={id}
          className={styles.input}
          value={draft}
          disabled={disabled}
          spellCheck={false}
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
        <button type="button" className={styles.button} disabled={disabled} onClick={browse}>
          Browse…
        </button>
        <button type="button" className={styles.button} disabled={disabled} onClick={open}>
          Open
        </button>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}
