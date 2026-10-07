import { useEffect, useState } from "react";
import { commands, events } from "../shared/ipc";
import { CommandBar } from "./CommandBar";
import { EmptyEditor } from "./EmptyEditor";
import { StatusBar } from "./StatusBar";
import { TimelineBar } from "./TimelineBar";
import styles from "./EditorApp.module.css";

/**
 * The main window (mockup/main.html). Two halves: above the preview, the picture (the command
 * bar's tools and their options); below it, time (the timeline bar, the timeline's options,
 * the timeline). For now it's the empty frame; the file it's asked to open shows in the status
 * bar until Phase 1 opens it.
 */
export function EditorApp() {
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let gone = false;
    // Listen first, then report ready: a file sent in between isn't lost.
    events.openFile
      .listen((e) => setFile(e.payload.path))
      .then((stop) => {
        // Unmounted meanwhile (StrictMode mounts twice): the next mount reports ready instead,
        // so the pending file isn't taken by a page that's gone.
        if (gone) {
          stop();
          return null;
        }
        unlisten = stop;
        return commands.editorReady();
      })
      .then((pending) => {
        if (pending && !gone) setFile(pending);
      });
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  const empty = true;
  return (
    <div className={styles.app}>
      <CommandBar empty={empty} />
      <div className={styles.optionsBar}>{empty && "No video open"}</div>
      <div className={styles.preview}>{empty && <EmptyEditor />}</div>
      <TimelineBar empty={empty} />
      <div className={styles.timelineOptions}>
        {empty &&
          "Open a video, then split with S, mark ranges with R, and trim by dragging a clip's edge."}
      </div>
      <div className={styles.timeline} />
      <StatusBar text={file ? `Asked to open ${file}` : "Ready"} empty={empty} />
    </div>
  );
}
