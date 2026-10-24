import { useState } from "react";
import { commands } from "../../shared/ipc";
import type { LogsItem } from "../schema";
import { ConfirmDialog } from "./ConfirmDialog";
import type { ControlProps } from "./index";
import styles from "./controls.module.css";

/**
 * Settings › About › Debugging: opens the folder of logs and crash reports (to send one), or
 * clears it, after asking.
 */
export function LogButtons({ id, disabled }: ControlProps<LogsItem>) {
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const clear = () => {
    setAsking(false);
    commands
      .clearLogs()
      .then((r) =>
        setMessage(
          r.status === "ok"
            ? { text: "Logs and crash reports cleared.", error: false }
            : { text: r.error, error: true },
        ),
      )
      .catch((e: unknown) => setMessage({ text: String(e), error: true }));
  };
  return (
    <div id={id} className={styles.stack}>
      <div className={styles.buttonRow}>
        <button
          type="button"
          className={styles.button}
          disabled={disabled}
          onClick={() => void commands.openLogsFolder()}
        >
          Open logs folder
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={disabled}
          onClick={() => {
            setMessage(null);
            setAsking(true);
          }}
        >
          Clear logs
        </button>
      </div>
      {message && (
        <p className={message.error ? styles.fieldError : styles.aboutMeta} role="status">
          {message.text}
        </p>
      )}
      {asking && (
        <ConfirmDialog
          title="Clear logs?"
          confirm="Clear"
          onConfirm={clear}
          onCancel={() => setAsking(false)}
        >
          The logs and crash reports are deleted, and this session's log starts again.
        </ConfirmDialog>
      )}
    </div>
  );
}
