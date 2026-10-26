// The recording's floating control (PLAN 5b.2; recording.rs): a red dot, the time recorded, the
// microphone's mute button when it's recorded (5b.4d; Ctrl+Alt+M too), clicks noted or not
// (5b.6a; Ctrl+Alt+C), Pause (5b.5c; Ctrl+Alt+P)
// and Stop (Ctrl+Alt+S), at the top of the monitor being recorded and left out of the
// recording. In the countdown (5b.5b) it says when recording starts, and Stop is Cancel. Dragged
// by anything but its buttons.

import { useEffect, useState } from "react";
import { commands, events } from "../shared/ipc";
import { Struck } from "../shared/Struck";

declare global {
  interface Window {
    /** The microphone is recorded, and the countdown's seconds (recording.rs, before the page
     *  loads). */
    recordingMic?: boolean;
    recordingCountdown?: number;
    /** Clicks noted at the start. */
    recordingClicks?: boolean;
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
  // The window opens as the countdown starts, and the recording after it: the time counts from
  // then, and stands still while paused.
  const countdown = window.recordingCountdown ?? 0;
  const [t0] = useState(() => performance.now() + countdown * 1000);
  const [now, setNow] = useState(() => performance.now());
  const [stopping, setStopping] = useState(false);
  const [muted, setMuted] = useState(false);
  const [clicks, setClicks] = useState(() => window.recordingClicks ?? false);
  const [paused, setPaused] = useState(false);
  /** Pausing or resuming takes a moment (a segment ends, or starts): the button waits for it. */
  const [switching, setSwitching] = useState(false);
  /** Time spent paused before now, and when the pause now began. */
  const [pauses, setPauses] = useState({ total: 0, since: 0 });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    // Muted, or paused, by the keys too: Rust says.
    const offMute = events.micMuted.listen(({ payload }) => setMuted(payload));
    const offNoted = events.clicksNoted.listen(({ payload }) => setClicks(payload));
    const offPause = events.recordingPaused.listen(({ payload }) => {
      const t = performance.now();
      setPauses((p) => {
        if (payload && !p.since) return { ...p, since: t };
        if (!payload && p.since) return { total: p.total + t - p.since, since: 0 };
        return p;
      });
      setPaused(payload);
      setSwitching(false);
    });
    return () => {
      window.clearInterval(timer);
      void offMute.then((f) => f());
      void offNoted.then((f) => f());
      void offPause.then((f) => f());
    };
  }, []);
  const stop = () => {
    setStopping(true);
    void commands.stopRecording();
  };
  const counting = now < t0;
  const { total, since } = pauses;
  const recorded = now - t0 - total - (since ? now - since : 0);
  return (
    <div className={styles.bar} data-tauri-drag-region>
      <span
        className={`${styles.dot} ${paused || counting ? styles.still : ""}`}
        aria-hidden
        data-tauri-drag-region
      />
      <span className={styles.time} role="timer" aria-label="Time recorded" data-tauri-drag-region>
        {counting ? `Starts in ${Math.ceil((t0 - now) / 1000)}` : elapsed(recorded)}
      </span>
      {window.recordingMic && (
        <button
          type="button"
          className={styles.mic}
          aria-pressed={muted}
          data-off={muted || undefined}
          title={muted ? "Unmute the microphone (Ctrl+Alt+M)" : "Mute the microphone (Ctrl+Alt+M)"}
          aria-label="Mute the microphone"
          onClick={() => {
            setMuted(!muted);
            void commands.muteRecording(!muted);
          }}
        >
          <Struck off={muted}>
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" fill="none" />
          </Struck>
        </button>
      )}
      <button
        type="button"
        className={styles.mic}
        aria-pressed={clicks}
        data-off={!clicks || undefined}
        title={clicks ? "Clicks noted (Ctrl+Alt+C)" : "Clicks not noted (Ctrl+Alt+C)"}
        aria-label="Note clicks"
        onClick={() => void commands.noteRecordingClicks(!clicks)}
      >
        {/* A mouse, upright: the slash crosses it, never runs along it. */}
        <Struck off={!clicks}>
          <rect x="6.5" y="3" width="11" height="18" rx="5.5" fill="none" />
          <path d="M12 3v6.5" fill="none" />
        </Struck>
      </button>
      <button
        type="button"
        className={styles.mic}
        aria-pressed={paused}
        title={paused ? "Resume recording (Ctrl+Alt+P)" : "Pause recording (Ctrl+Alt+P)"}
        aria-label={paused ? "Resume recording" : "Pause recording"}
        disabled={counting || switching || stopping}
        onClick={() => {
          setSwitching(true);
          void commands.pauseRecording();
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          {paused ? (
            <path d="M8 5.5v13l10.5-6.5z" />
          ) : (
            <>
              <rect x="6.5" y="5" width="4" height="14" rx="1" />
              <rect x="13.5" y="5" width="4" height="14" rx="1" />
            </>
          )}
        </svg>
      </button>
      <button
        type="button"
        className={styles.stop}
        title={counting ? "Don't record" : "Stop recording and open it (Ctrl+Alt+S)"}
        disabled={stopping}
        onClick={stop}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
        {stopping ? "Stopping…" : counting ? "Cancel" : "Stop"}
      </button>
    </div>
  );
}
