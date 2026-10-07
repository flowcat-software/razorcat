import { useEffect, useMemo, useState } from "react";
import { commands, events, type SourceInfo } from "../shared/ipc";
import { CommandBar } from "./CommandBar";
import { EmptyEditor } from "./EmptyEditor";
import { formatRate, sourceFacts } from "./format";
import { Player } from "./player";
import { Preview } from "./Preview";
import { StatusBar, type Notice } from "./StatusBar";
import { TimelineBar } from "./TimelineBar";
import styles from "./EditorApp.module.css";

const openVideo = () => void commands.openDialog();

/** The transport's keys (mockup's keys table). True if the key was the player's. */
function transportKey(e: KeyboardEvent, player: Player): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  const second = Math.round(player.fps);
  switch (e.code) {
    case "ArrowLeft":
      player.step(e.shiftKey ? -second : -1);
      return true;
    case "ArrowRight":
      player.step(e.shiftKey ? second : 1);
      return true;
    case "Home":
      player.seek(0);
      return true;
    case "End":
      player.seek(player.frames - 1);
      return true;
  }
  // Held down, these would flip back and forth.
  if (e.shiftKey || e.repeat) return ["Space", "KeyJ", "KeyK", "KeyL"].includes(e.code);
  switch (e.code) {
    case "Space":
      player.toggle();
      return true;
    case "KeyK":
      player.pause();
      return true;
    case "KeyJ":
      player.slower();
      return true;
    case "KeyL":
      player.faster();
      return true;
  }
  return false;
}

/**
 * The main window (mockup/main.html). Two halves: above the preview, the picture (the command
 * bar's tools and their options); below it, time (the timeline bar, the timeline's options,
 * the timeline). Files open from the Open dialog, a drop, "Open with" or a second launch; Rust
 * reads them and sends `SourceOpened` (or `OpenFailed`).
 */
export function EditorApp() {
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** The proxy of the open source: ready (its URL) or how far along; keyed by the source. */
  const [proxy, setProxy] = useState<{ source: string; url?: string; done?: number } | null>(null);
  const player = useMemo(
    () => source && new Player(source.frames, source.rateNum / source.rateDen, source.framesUrl),
    [source],
  );

  useEffect(() => {
    if (!player) return;
    player.open();
    return () => player.close();
  }, [player]);

  useEffect(() => {
    if (!player) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
      if (transportKey(e, player)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player]);

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
      events.proxyProgress.listen(({ payload }) => {
        const done = payload.done ?? 0;
        setProxy((p) => (p?.url && p.source === payload.source ? p : { ...payload, done }));
      }),
      events.proxyReady.listen(({ payload }) => setProxy(payload)),
      events.proxyFailed.listen(({ payload }) => {
        setProxy(null);
        setNotice({ text: payload.message, error: true });
      }),
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
  const mine = source && proxy?.source === source.url ? proxy : null;
  const proxyUrl = source?.proxyUrl ?? mine?.url ?? null;
  // The proxy's progress shows until it's ready, unless there's something to say.
  const making =
    mine && !proxyUrl
      ? { text: `Preparing fast stepping… ${Math.floor((mine.done ?? 0) * 100)}%` }
      : null;
  // Controls stay disabled until the increment that makes them work: the timeline's zoom (1.7),
  // editing and export (Phase 2), the picture's tools (Phases 3-4).
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
          <Preview
            source={source}
            player={player!}
            proxyUrl={proxyUrl}
            onError={(text) => setNotice({ text, error: true })}
          />
        ) : (
          <EmptyEditor onOpen={openVideo} />
        )}
      </div>
      <TimelineBar source={source} player={player} noEdits={notYet} />
      <div className={styles.timelineOptions}>
        {source
          ? `${source.frames} frames at ${formatRate(source.rateNum, source.rateDen)}`
          : "Open a video, then split with S, mark ranges with R, and trim by dragging a clip's edge."}
      </div>
      <div className={styles.timeline} />
      <StatusBar notice={notice ?? making} empty={empty || notYet} />
    </div>
  );
}
