import { useEffect, useState } from "react";
import { commands, events, type SourceInfo } from "../shared/ipc";
import { CommandBar } from "./CommandBar";
import { EmptyEditor } from "./EmptyEditor";
import { formatRate, sourceFacts } from "./format";
import { StatusBar, type Notice } from "./StatusBar";
import { TimelineBar } from "./TimelineBar";
import styles from "./EditorApp.module.css";

const openVideo = () => void commands.openDialog();

/**
 * The main window (mockup/main.html). Two halves: above the preview, the picture (the command
 * bar's tools and their options); below it, time (the timeline bar, the timeline's options,
 * the timeline). Files open from the Open dialog, a drop, "Open with" or a second launch; Rust
 * reads them and sends `SourceOpened` (or `OpenFailed`).
 */
export function EditorApp() {
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    const stops: (() => void)[] = [];
    let gone = false;
    // Listen first, then report ready: a file opened in between isn't missed.
    void Promise.all([
      // Rust's f64s arrive typed `number | null` (see ipc.ts): `SourceInfo` is what's sent.
      events.sourceOpened.listen(({ payload }) => {
        setSource(payload as SourceInfo);
        setNotice(null);
      }),
      events.openFailed.listen(({ payload }) => setNotice({ text: payload.message, error: true })),
    ])
      .then((unlisten) => {
        // Unmounted meanwhile (StrictMode mounts twice): stop listening, and leave reporting
        // ready to the next mount, so a waiting file isn't opened into a page that's gone.
        if (gone) {
          unlisten.forEach((stop) => stop());
          return null;
        }
        stops.push(...unlisten);
        return commands.editorReady();
      })
      .then((open) => {
        if (open && !gone) setSource(open as SourceInfo);
      });
    return () => {
      gone = true;
      stops.forEach((stop) => stop());
    };
  }, []);

  // Ctrl+O opens a video, Ctrl+, opens Settings (as in Vandal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      if (e.code === "KeyO") {
        e.preventDefault();
        openVideo();
      } else if (e.code === "Comma") {
        e.preventDefault();
        void commands.openSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const empty = source === null;
  // Controls stay disabled until the increment that makes them work: the transport (1.4), the
  // timeline's zoom (1.7), editing and export (Phase 2), the picture's tools (Phases 3-4).
  const notYet = true;
  return (
    <div className={styles.app}>
      <CommandBar empty={empty || notYet} onOpen={openVideo} />
      <div className={styles.optionsBar}>
        {source ? (
          <>
            <b className={styles.sourceName} title={source.path}>
              {source.name}
            </b>
            <span>{sourceFacts(source).join(" · ")}</span>
          </>
        ) : (
          "No video open"
        )}
      </div>
      <div className={styles.preview}>
        {source ? (
          <p className={styles.message}>The picture arrives in Phase 1.3.</p>
        ) : (
          <EmptyEditor onOpen={openVideo} />
        )}
      </div>
      <TimelineBar empty={empty || notYet} />
      <div className={styles.timelineOptions}>
        {source
          ? `${source.frames} frames at ${formatRate(source.rateNum, source.rateDen)}`
          : "Open a video, then split with S, mark ranges with R, and trim by dragging a clip's edge."}
      </div>
      <div className={styles.timeline} />
      <StatusBar notice={notice} empty={empty || notYet} />
    </div>
  );
}
