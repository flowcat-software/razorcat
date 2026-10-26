// The recording's floating control (PLAN 5b.2; recording.rs): a red dot, the time recorded, the
// microphone's mute button when it's recorded (5b.4d; Ctrl+Alt+M too) and Stop, at the top of
// the monitor being recorded and left out of the recording. Dragged by anything but its
// buttons.

import { useEffect, useState } from "react";
import { commands, events } from "../shared/ipc";

declare global {
  interface Window {
    /** The microphone is recorded (recording.rs, before the page loads). */
    recordingMic?: boolean;
  }
}
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
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    // Muted by the key too: Rust says.
    const off = events.micMuted.listen(({ payload }) => setMuted(payload));
    return () => {
      window.clearInterval(timer);
      void off.then((f) => f());
    };
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
      {window.recordingMic && (
        <button
          type="button"
          className={styles.mic}
          aria-pressed={muted}
          title={muted ? "Unmute the microphone (Ctrl+Alt+M)" : "Mute the microphone (Ctrl+Alt+M)"}
          aria-label="Mute the microphone"
          onClick={() => {
            setMuted(!muted);
            void commands.muteRecording(!muted);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" fill="none" />
            {muted && <path d="M4 4l16 16" fill="none" />}
          </svg>
        </button>
      )}
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
