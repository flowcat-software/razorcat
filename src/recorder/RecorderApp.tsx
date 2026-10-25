// The recording's floating control (PLAN 5b.2; recording.rs): a red dot, the time recorded and
// Stop, at the top of the monitor being recorded and left out of the recording. Dragged by
// anything but Stop.

import { useEffect, useState } from "react";
import { commands } from "../shared/ipc";
import styles from "./RecorderApp.module.css";

/** `ms` as m:ss, or h:mm:ss past an hour. */
export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

export function RecorderApp() {
  // The window opens as the recording starts: the time counts from here.
  const [t0] = useState(() => performance.now());
  const [now, setNow] = useState(t0);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const stop = () => {
    setStopping(true);
    void commands.stopRecording();
  };
  return (
    <div className={styles.bar} data-tauri-drag-region>
      <span className={styles.dot} aria-hidden data-tauri-drag-region />
      <span className={styles.time} role="timer" aria-label="Time recorded" data-tauri-drag-region>
        {elapsed(now - t0)}
      </span>
      <button
        type="button"
        className={styles.stop}
        title="Stop recording and open it"
        disabled={stopping}
        onClick={stop}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
        {stopping ? "Stopping…" : "Stop"}
      </button>
    </div>
  );
}
