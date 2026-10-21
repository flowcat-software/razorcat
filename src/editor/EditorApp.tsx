import { useEffect, useMemo, useRef, useState } from "react";
import { annotationId, docStore as markupDoc } from "../markup/model/store";
import { startToolStylesSync } from "../markup/toolStylesSync";
import { useMarkupKeys } from "../markup/useMarkupKeys";
import { applyStyleSettings, loadFonts } from "../markup/useStyleSettings";
import { isTyping } from "../shared/dom";
import { commands, events, type Settings, type SourceInfo, type ThumbsInfo } from "../shared/ipc";
import { CommandBar } from "./CommandBar";
import { useToolKeys } from "./cropTool";
import { EmptyEditor } from "./EmptyEditor";
import { useDoc } from "./docStore";
import {
  addRangeAtPlayhead,
  copySelectedClip,
  deleteSelected,
  duplicateSelectedClip,
  moveSelected,
  muteSelectedClip,
  muteSound,
  pasteClip,
  rangeIn,
  rangeOut,
  seekEdit,
  splitAtPlayhead,
} from "./edits";
import { LARGE_GIF, exportTimeline, fileSize, onExportFailed } from "./exports";
import { checkFrames } from "./frameCheck";
import { FrameOptions } from "./FrameOptions";
import { Player } from "./player";
import { Preview } from "./Preview";
import { StatusBar, type Notice } from "./StatusBar";
import { Timeline } from "./Timeline";
import { TimelineBar } from "./TimelineBar";
import { TimelineOptions } from "./TimelineOptions";
import { useTimeline } from "./timelineStore";
import { useTool } from "./toolStore";
import styles from "./EditorApp.module.css";

const openVideo = () => void commands.openDialog();

/** Thumbnails are made from proxies: none without them. */
const thumbsOn = (s: Settings) => s.timeline.thumbnails && s.proxies.enabled;

/** Settings › Timeline › Ranges and markup: how they take edits of the clips. */
const rangeOptions = (s: Settings) =>
  useDoc.getState().setOptions({
    follow: s.timeline.rangesFollowVideo,
    deleteWithClip: s.timeline.deleteRangesWithClip,
    splitMarks: s.timeline.splitMarkup,
    fadeCuts: s.timeline.fadeSplitMarkup,
  });

/** The settings the editor's stores keep (ranges, number fields, the markup's styles). */
const applySettings = (s: Settings) => {
  rangeOptions(s);
  applyStyleSettings(s);
  useTool.getState().setDragSpeed(s.editing.numberDragSpeed);
};

/**
 * The transport's and the timeline's keys (mockup's keys table), M and Shift+M only with sound
 * to mute. True if the key was theirs.
 */
function transportKey(e: KeyboardEvent, player: Player, audio: boolean): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  // M mutes the selected clip, Shift+M all the sound (as Logic's M and modifier+M).
  if (e.code === "KeyM" && audio) {
    if (e.repeat) return true;
    if (e.shiftKey) muteSound();
    else muteSelectedClip();
    return true;
  }
  const second = Math.round(player.fps);
  switch (e.code) {
    // A single frame waits for the full-quality picture; held down, or a second at a time, the
    // proxy keeps up.
    case "ArrowLeft":
      player.step(e.shiftKey ? -second : -1, e.shiftKey || e.repeat);
      return true;
    case "ArrowRight":
      player.step(e.shiftKey ? second : 1, e.shiftKey || e.repeat);
      return true;
    case "ArrowUp":
      seekEdit(player, -1);
      return true;
    case "ArrowDown":
      seekEdit(player, 1);
      return true;
    case "Home":
      player.seek(0);
      return true;
    case "End":
      player.seek(player.frames - 1);
      return true;
  }
  // Held down, these would flip back and forth (or split again and again).
  if (e.shiftKey || e.repeat) {
    return ["Space", "KeyJ", "KeyK", "KeyL", "KeyS", "KeyR", "KeyI", "KeyO"].includes(e.code);
  }
  switch (e.code) {
    case "KeyS":
      splitAtPlayhead(player);
      return true;
    case "KeyR":
      addRangeAtPlayhead(player);
      return true;
    case "KeyI":
      rangeIn(player);
      return true;
    case "KeyO":
      rangeOut(player);
      return true;
    case "Delete":
    case "Backspace":
      deleteSelected();
      return true;
    case "Escape": {
      // A pending in-point first, then the selection.
      const doc = useDoc.getState();
      if (doc.pendingIn !== null) doc.setPendingIn(null);
      else doc.select(null);
      return true;
    }
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
  /** The video has sound, for M and Shift+M to mute. */
  const audio = (source?.audioTracks ?? 0) > 0;
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Time as frame numbers, not timecode: the readout and the ruler (a click on the readout). */
  const [inFrames, setInFrames] = useState(false);
  /** The source the preview last asked to convert: asked once, however many errors. */
  const convertAsked = useRef<string | null>(null);
  /** An export under way (export.rs): the file being written and how far along, over all. */
  const [exporting, setExporting] = useState<{ name: string; done: number } | null>(null);
  /** A conversion under way (convert.rs): the file and how far along. */
  const [converting, setConverting] = useState<{ name: string; done: number } | null>(null);
  /** The proxy of the open source: ready (its URL) or how far along; keyed by the source. */
  const [proxy, setProxy] = useState<{ source: string; url?: string; done?: number } | null>(null);
  /** Settings › General › Show thumbnails (made from proxies, so not without them). */
  const [showThumbs, setShowThumbs] = useState(true);
  /** Development: the source to check (`--check-frames`, check.rs), once it's open. */
  const [checkFor, setCheckFor] = useState<{ source: string; edit: boolean } | null>(null);
  /** The settings, as Rust last sent them (the export menu's toggle reads and sets them). */
  const [settings, setSettings] = useState<Settings | null>(null);
  /** Settings › Timeline › Show waveform. */
  const [showWave, setShowWave] = useState(true);
  /** The waveform once it's made; keyed by the source. */
  const [wave, setWave] = useState<{ source: string; url: string } | null>(null);
  /** The thumbnails as they're made; keyed by the source. */
  const [thumbs, setThumbs] = useState<{ source: string; thumbs: ThumbsInfo } | null>(null);
  const player = useMemo(
    () => source && new Player(source.frames, source.rateNum / source.rateDen, source.framesUrl),
    [source],
  );

  useEffect(() => {
    if (!player) return;
    player.open();
    return () => player.close();
  }, [player]);

  // A new source starts a new edit: the whole of it, one clip. (The same source converted to
  // play here keeps its edit.)
  const sourceId = source?.id;
  const sourceFrames = source?.frames ?? 0;
  const sourceWidth = source?.width ?? 0;
  const sourceHeight = source?.height ?? 0;
  useEffect(() => {
    if (!sourceId) return;
    useDoc.getState().load(sourceFrames, { width: sourceWidth, height: sourceHeight });
    useTool.getState().setTool("select");
    // A portrait video's crop ratios start turned (9:16).
    useTool.getState().setPortrait(sourceHeight > sourceWidth);
  }, [sourceId, sourceFrames, sourceWidth, sourceHeight]);

  // The player plays the edit (after the load above, so never another source's).
  useEffect(() => {
    if (!player) return;
    player.setEdit(useDoc.getState().doc);
    return useDoc.subscribe((s, before) => {
      if (s.doc !== before.doc) player.setEdit(s.doc);
    });
  }, [player]);

  useEffect(() => {
    if (!player) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
      if (transportKey(e, player, audio)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player, audio]);

  // An export that couldn't start, before Rust had it (its markup couldn't be drawn or sent).
  useEffect(() => {
    onExportFailed((text) => setNotice({ text, error: true }));
    return () => onExportFailed(() => {});
  }, []);

  useEffect(() => {
    const stops: (() => void)[] = [];
    let gone = false;
    // Listen first, then report ready: a file opened in between isn't missed.
    void Promise.all([
      // Rust's f64s arrive typed `number | null` (see ipc.ts): `SourceInfo` is what's sent.
      events.sourceOpened.listen(({ payload }) => {
        setSource(payload as SourceInfo);
        setNotice(null);
        setConverting(null);
      }),
      // The same source, now playing from a converted copy.
      events.sourceConverted.listen(({ payload }) => {
        setSource(payload as SourceInfo);
        setNotice(null);
        setConverting(null);
      }),
      events.convertProgress.listen(({ payload }) =>
        setConverting({ name: payload.name, done: payload.done ?? 0 }),
      ),
      events.convertEnded.listen(({ payload }) => {
        setConverting(null);
        if (payload.message) setNotice({ text: payload.message, error: true });
      }),
      events.exportProgress.listen(({ payload }) =>
        setExporting({ name: payload.name, done: payload.done ?? 0 }),
      ),
      events.exportEnded.listen(({ payload }) => {
        setExporting(null);
        const [first] = payload.files;
        const name = (path: string) => path.split(/[\\/]/).pop() ?? path;
        if (payload.message) setNotice({ text: payload.message, error: true });
        else if (!first) setNotice({ text: "Export cancelled." });
        else {
          const size = fileSize(payload.bytes ?? 0);
          const gif = payload.files.some((f) => f.toLowerCase().endsWith(".gif"));
          const large =
            gif && (payload.bytes ?? 0) > LARGE_GIF
              ? " That's large for a GIF: a lower rate or size in Settings › Export makes it smaller."
              : "";
          setNotice({
            text:
              (payload.files.length > 1
                ? `Exported ${payload.files.length} files (${size}).`
                : `Exported ${name(first)} (${size}).`) + large,
            action: { label: "Show in folder", run: () => void commands.showInFolder(first) },
          });
        }
      }),
      events.openFailed.listen(({ payload }) => {
        setConverting(null);
        setNotice({ text: payload.message, error: true });
      }),
      events.proxyProgress.listen(({ payload }) => {
        const done = payload.done ?? 0;
        setProxy((p) => (p?.url && p.source === payload.source ? p : { ...payload, done }));
      }),
      events.proxyReady.listen(({ payload }) => setProxy(payload)),
      events.thumbsUpdate.listen(({ payload }) => setThumbs(payload)),
      events.waveReady.listen(({ payload }) => setWave(payload)),
      events.checkFrames.listen(({ payload }) => setCheckFor(payload)),
      events.settingsChanged.listen(({ payload }) => {
        setShowThumbs(thumbsOn(payload as Settings));
        setShowWave((payload as Settings).timeline.waveform);
        applySettings(payload as Settings);
        setSettings(payload as Settings);
      }),
      // Proxies turned off mid-way: the progress goes.
      events.proxyStopped.listen(({ payload }) =>
        setProxy((p) => (p?.source === payload.source && !p.url ? null : p)),
      ),
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
        void commands.getSettings().then((s) => {
          if (gone) return;
          setShowThumbs(thumbsOn(s as Settings));
          setShowWave((s as Settings).timeline.waveform);
          applySettings(s as Settings);
          setSettings(s as Settings);
        });
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

  // Development: the preview = export check, on the source it was asked for.
  const checked = useRef<typeof checkFor>(null);
  useEffect(() => {
    if (!player || !source || checkFor?.source !== source.id || checked.current === checkFor)
      return;
    checked.current = checkFor;
    let gone = false;
    checkFrames(
      player,
      source,
      (text) => !gone && setNotice({ text }),
      () => gone,
      checkFor.edit,
    )
      .then((summary) => setNotice({ text: `Frame check: ${summary}` }))
      .catch((e: unknown) => {
        if (!gone) setNotice({ text: `Frame check failed: ${String(e)}`, error: true });
      });
    return () => {
      gone = true;
    };
  }, [player, source, checkFor]);

  // Ctrl+O opens a video, Ctrl+E exports, Ctrl+, opens Settings, Ctrl+Z undoes (as in Vandal); Ctrl+0, Ctrl+=
  // and Ctrl+− fit and zoom the timeline; Ctrl+D, C and V duplicate, copy and paste clips.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.shiftKey && e.code === "KeyZ") {
        e.preventDefault();
        useDoc.getState().redo();
        return;
      }
      // Ctrl+[ / ]: the selected clip one place earlier or later, or the selected markup a lane
      // back or forward; with Shift, to the start or end, or to the back or front.
      if ((e.code === "BracketLeft" || e.code === "BracketRight") && player) {
        e.preventDefault();
        const earlier = e.code === "BracketLeft";
        const { selectedMarks } = useDoc.getState();
        if (selectedMarks.length) {
          const how = e.shiftKey ? (earlier ? "back" : "front") : earlier ? "backward" : "forward";
          markupDoc.getState().reorder(selectedMarks.map(annotationId), how);
        } else moveSelected(player, e.shiftKey ? (earlier ? "first" : "last") : earlier ? -1 : 1);
        return;
      }
      if (e.shiftKey) return;
      // Ctrl+D duplicates the selected clip, Ctrl+C / Ctrl+V copy it and paste it at the cut
      // nearest the playhead (the markup's own keys take Ctrl+D for selected markup).
      if (player && !isTyping(e.target)) {
        const done =
          e.code === "KeyD"
            ? duplicateSelectedClip(player)
            : e.code === "KeyC"
              ? copySelectedClip()
              : e.code === "KeyV" && pasteClip(player);
        if (done) {
          e.preventDefault();
          return;
        }
      }
      const zoom = {
        Digit0: 0,
        Equal: 1.5,
        NumpadAdd: 1.5,
        Minus: 1 / 1.5,
        NumpadSubtract: 1 / 1.5,
      }[e.code];
      if (e.code === "KeyZ" || e.code === "KeyY") {
        // Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y redo (as Vandal).
        e.preventDefault();
        const doc = useDoc.getState();
        if (e.code === "KeyY") doc.redo();
        else doc.undo();
      } else if (e.code === "KeyE") {
        e.preventDefault();
        if (useDoc.getState().doc.sourceFrames > 0) exportTimeline("mp4");
      } else if (e.code === "KeyO") {
        e.preventDefault();
        openVideo();
      } else if (e.code === "Comma") {
        e.preventDefault();
        void commands.openSettings(null);
      } else if (zoom !== undefined) {
        // Ctrl+= and Ctrl+− would zoom the page.
        e.preventDefault();
        if (zoom === 0) useTimeline.getState().fit();
        else useTimeline.getState().zoomBy(zoom);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player]);

  // V, C, G and T pick up the select, crop, grow and text tools; arrows nudge the crop box.
  useToolKeys(source !== null);
  // The markup's own keys (Vandal's: the style digits, Enter to type, nudging...).
  const open = source !== null;
  useMarkupKeys(() => open && useTool.getState().tool !== "crop");

  // The markup tools' styles: the installed fonts, and their memory kept between sessions.
  useEffect(() => {
    loadFonts();
    return startToolStylesSync();
  }, []);

  // Alt pressed and let go on its own (Alt+wheel scrolls the timeline) would reach the window
  // and put it in menu mode, which eats the next input: a Ctrl+wheel zoom did nothing. The page
  // keeps it. Alt+F4 still closes: only Alt's own events are kept.
  useEffect(() => {
    const keep = (e: KeyboardEvent) => {
      if (e.key === "Alt") e.preventDefault();
    };
    window.addEventListener("keydown", keep);
    window.addEventListener("keyup", keep);
    return () => {
      window.removeEventListener("keydown", keep);
      window.removeEventListener("keyup", keep);
    };
  }, []);

  const empty = source === null;
  const mine = source && proxy?.source === source.id ? proxy : null;
  const sourceThumbs = (source && thumbs?.source === source.id && thumbs.thumbs) || source?.thumbs;
  const sourceWave = source?.waveUrl ?? (wave && wave.source === source?.id ? wave.url : null);
  const proxyUrl = source?.proxyUrl ?? mine?.url ?? null;
  // A conversion's progress, with Cancel, comes first; then the proxy's until it's ready, unless
  // there's something to say.
  const exportNotice: Notice | null = exporting && {
    text: `Exporting ${exporting.name}… ${Math.floor(exporting.done * 100)}%`,
    action: { label: "Cancel", run: () => void commands.cancelExport() },
  };
  const conversion: Notice | null = converting && {
    text: `Converting ${converting.name} to play here… ${Math.floor(converting.done * 100)}%`,
    action: {
      label: "Cancel",
      run: () => {
        void commands.cancelConversion();
        setConverting(null);
        // Open it again to convert it after all.
        setNotice({ text: `Stopped converting ${converting.name}.` });
      },
    },
  };
  const making =
    mine && !proxyUrl
      ? { text: `Preparing fast stepping… ${Math.floor((mine.done ?? 0) * 100)}%` }
      : null;
  return (
    <div className={styles.app}>
      <CommandBar
        empty={empty}
        audio={audio}
        exporting={exporting !== null}
        settings={settings}
        onOpen={openVideo}
      />
      <FrameOptions source={source} settings={settings} />
      <div className={styles.preview}>
        {source ? (
          <Preview
            source={source}
            player={player!}
            proxyUrl={proxyUrl}
            onError={(text) => setNotice({ text, error: true })}
            onUnplayable={() => {
              if (convertAsked.current === source.url) return;
              convertAsked.current = source.url;
              setConverting({ name: source.name, done: 0 });
              void commands.convertForPreview(source.url);
            }}
          />
        ) : (
          <EmptyEditor onOpen={openVideo} />
        )}
      </div>
      <TimelineBar
        source={source}
        player={player}
        inFrames={inFrames}
        onToggleFrames={() => setInFrames((f) => !f)}
      />
      <TimelineOptions source={source} inFrames={inFrames} player={player} />
      <div className={styles.timeline}>
        {source && player && (
          <Timeline
            source={source}
            player={player}
            inFrames={inFrames}
            thumbs={(showThumbs && sourceThumbs) || null}
            waveUrl={(showWave && sourceWave) || null}
          />
        )}
      </div>
      <StatusBar notice={exportNotice ?? conversion ?? notice ?? making} empty={empty} />
    </div>
  );
}
