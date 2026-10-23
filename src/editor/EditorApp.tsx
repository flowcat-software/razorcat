import { useEffect, useMemo, useRef, useState } from "react";
import { annotationId, docStore as markupDoc } from "../markup/model/store";
import { startToolStylesSync } from "../markup/toolStylesSync";
import { useMarkupKeys } from "../markup/useMarkupKeys";
import { applyStyleSettings, loadFonts } from "../markup/useStyleSettings";
import { ConfirmDialog } from "../settings/controls/ConfirmDialog";
import { isTyping } from "../shared/dom";
import { commands, events, type Settings, type SourceInfo, type ThumbsInfo } from "../shared/ipc";
import { CommandBar } from "./CommandBar";
import { useToolKeys } from "./cropTool";
import { EmptyEditor } from "./EmptyEditor";
import { total } from "./doc";
import { useDoc } from "./docStore";
import {
  addRangeAtPlayhead,
  copySelectedClip,
  copySelectedMarks,
  pasteFades,
  pasteStyle,
  pasteTiming,
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
import { TIMELINE_H, Timeline } from "./Timeline";
import { TimelineBar } from "./TimelineBar";
import { TimelineOptions } from "./TimelineOptions";
import { useTimeline } from "./timelineStore";
import { useTool } from "./toolStore";
import styles from "./EditorApp.module.css";

const openVideo = () => void commands.openDialog(false);
/** The timeline has edits (that undo could take back): replacing it would lose them. */
const edited = () => useDoc.getState().past.length > 0;
/** Add Video (Ctrl+Shift+O): a file on the end of the timeline (PLAN 4.5e). */
const addVideo = () => void commands.openDialog(true);

/** Thumbnails are made from proxies: none without them. */
const thumbsOn = (s: Settings) => s.timeline.thumbnails && s.proxies.enabled;

/** Settings › Timeline › Ranges and markup: how they take edits of the clips. */
const rangeOptions = (s: Settings) =>
  useDoc.getState().setOptions({
    follow: s.timeline.rangesFollowVideo,
    deleteWithClip: s.timeline.deleteRangesWithClip,
    splitMarks: s.timeline.splitMarkup,
    fadeCuts: s.timeline.fadeSplitMarkup,
    defaultFade: s.timeline.defaultMarkupFade,
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
  /** The timeline's files, first first (PLAN 4.5e): the first sets its rate and frame. */
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const source = sources[0] ?? null;
  /** A file has sound, for M and Shift+M to mute. */
  const audio = sources.some((s) => s.audioTracks > 0);
  const [notice, setNotice] = useState<Notice | null>(null);
  /**
   * A question before the timeline is replaced (PLAN 4.5e3): Open with edits on it, or a file
   * dropped on it (add or replace).
   */
  const [asking, setAsking] = useState<{ open: true } | { offered: string } | null>(null);
  /** Open (the button, Ctrl+O): with edits, asks first. */
  const replace = () => (edited() ? setAsking({ open: true }) : openVideo());
  /** Time as frame numbers, not timecode: the readout and the ruler (a click on the readout). */
  const [inFrames, setInFrames] = useState(false);
  /** The timeline's height, the resizer above it dragged (its own, to start). */
  const [timelineH, setTimelineH] = useState(TIMELINE_H);
  /** The source the preview last asked to convert: asked once, however many errors. */
  const convertAsked = useRef<string | null>(null);
  /** An export under way (export.rs): the file being written and how far along, over all. */
  const [exporting, setExporting] = useState<{ name: string; done: number } | null>(null);
  /** A conversion under way (convert.rs): the file and how far along. */
  const [converting, setConverting] = useState<{ name: string; done: number } | null>(null);
  /** Each file's proxy: ready (its URL) or how far along; by the file's id. */
  const [proxies, setProxies] = useState<Record<string, { url?: string; done?: number }>>({});
  /** Settings › General › Show thumbnails (made from proxies, so not without them). */
  const [showThumbs, setShowThumbs] = useState(true);
  /** Development: the source to check (`--check-frames`, check.rs), once it's open. */
  const [checkFor, setCheckFor] = useState<{ source: string; edit: boolean } | null>(null);
  /** The settings, as Rust last sent them (the export menu's toggle reads and sets them). */
  const [settings, setSettings] = useState<Settings | null>(null);
  /** Settings › Timeline › Show waveform. */
  const [showWave, setShowWave] = useState(true);
  /** Each file's waveform once it's made, by its id. */
  const [waves, setWaves] = useState<Record<string, string>>({});
  /** Each file's thumbnails as they're made, by its id. */
  const [thumbs, setThumbs] = useState<Record<string, ThumbsInfo>>({});
  // The player plays at the first file's rate; a new first file is a new player.
  const sourceId = source?.id;
  const fps = source ? source.rateNum / source.rateDen : 0;
  const player = useMemo(() => (sourceId ? new Player(fps) : null), [sourceId, fps]);

  useEffect(() => {
    if (!player) return;
    player.open();
    return () => player.close();
  }, [player]);

  // Each file is a deck of the player's.
  useEffect(() => {
    sources.forEach((s) => player?.addSource(s.id, s.framesUrl));
  }, [player, sources]);

  // A new first file starts a new edit: the whole of it, one clip (and, the page reloaded, the
  // others after it). The same file converted to play here keeps its edit.
  const latest = useRef(sources);
  useEffect(() => {
    latest.current = sources;
  }, [sources]);
  const sourceFrames = source?.frames ?? 0;
  const sourceWidth = source?.width ?? 0;
  const sourceHeight = source?.height ?? 0;
  useEffect(() => {
    if (!sourceId) return;
    const doc = useDoc.getState();
    doc.load(sourceFrames, { width: sourceWidth, height: sourceHeight }, sourceId);
    for (const s of latest.current.slice(1)) doc.addSource(s.id, s.frames);
    useDoc.setState({ past: [], future: [] });
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
        setSources([payload as SourceInfo]);
        setNotice(null);
        setConverting(null);
      }),
      // A file dropped while the timeline has files: add it, or replace them?
      events.openOffered.listen(({ payload }) => setAsking({ offered: payload.name })),
      // One more file, on the end of the timeline (one undo step).
      events.sourceAdded.listen(({ payload }) => {
        const added = payload as SourceInfo;
        setSources((now) => [...now, added]);
        useDoc.getState().addSource(added.id, added.frames);
        setNotice({ text: `Added ${added.name} to the end of the timeline.` });
        setConverting(null);
      }),
      // A file, now playing from a converted copy.
      events.sourceConverted.listen(({ payload }) => {
        const converted = payload as SourceInfo;
        setSources((now) => now.map((s) => (s.id === converted.id ? converted : s)));
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
        setProxies((p) => (p[payload.source]?.url ? p : { ...p, [payload.source]: { done } }));
      }),
      events.proxyReady.listen(({ payload }) =>
        setProxies((p) => ({ ...p, [payload.source]: { url: payload.url } })),
      ),
      events.thumbsUpdate.listen(({ payload }) =>
        setThumbs((t) => ({ ...t, [payload.source]: payload.thumbs })),
      ),
      events.waveReady.listen(({ payload }) =>
        setWaves((w) => ({ ...w, [payload.source]: payload.url })),
      ),
      events.checkFrames.listen(({ payload }) => setCheckFor(payload)),
      events.settingsChanged.listen(({ payload }) => {
        setShowThumbs(thumbsOn(payload as Settings));
        setShowWave((payload as Settings).timeline.waveform);
        applySettings(payload as Settings);
        setSettings(payload as Settings);
      }),
      // Proxies turned off mid-way: the progress goes.
      events.proxyStopped.listen(({ payload }) =>
        setProxies((p) => {
          if (p[payload.source]?.url) return p;
          const rest = { ...p };
          delete rest[payload.source];
          return rest;
        }),
      ),
      events.proxyFailed.listen(({ payload }) => {
        setProxies((p) => {
          const rest = { ...p };
          delete rest[payload.source];
          return rest;
        });
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
        if (open?.length && !gone) setSources(open as SourceInfo[]);
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
      // Ctrl+Shift+V, F and T: the copied markup's style, fades or timing onto the selected
      // markup.
      const pasting = { KeyV: pasteStyle, KeyF: pasteFades, KeyT: pasteTiming }[e.code];
      if (e.shiftKey && pasting && !isTyping(e.target)) {
        if (pasting()) e.preventDefault();
        return;
      }
      // Ctrl+Shift+O: Add Video.
      if (e.shiftKey && e.code === "KeyO") {
        e.preventDefault();
        addVideo();
        return;
      }
      if (e.shiftKey) return;
      // Ctrl+D duplicates the selected clip, Ctrl+C / Ctrl+V copy it and paste it at the cut
      // nearest the playhead, or copy the selected markup and paste it at the playhead (the
      // markup's own keys take Ctrl+D for selected markup).
      if (player && !isTyping(e.target)) {
        const done =
          e.code === "KeyD"
            ? duplicateSelectedClip(player)
            : e.code === "KeyC"
              ? copySelectedClip() || copySelectedMarks()
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
        if (total(useDoc.getState().doc) > 0) exportTimeline("mp4");
      } else if (e.code === "KeyO") {
        e.preventDefault();
        if (edited()) setAsking({ open: true });
        else openVideo();
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
  // Each file's proxy, thumbnails and waveform: as it opened, or as they've come since.
  const proxyUrls = Object.fromEntries(
    sources.map((s) => [s.id, s.proxyUrl ?? proxies[s.id]?.url ?? null]),
  );
  const fileThumbs: Record<string, ThumbsInfo> = {};
  const fileWaves: Record<string, string> = {};
  for (const s of sources) {
    const t = thumbs[s.id] ?? s.thumbs;
    if (t && showThumbs) fileThumbs[s.id] = t;
    const w = s.waveUrl ?? waves[s.id];
    if (w && showWave) fileWaves[s.id] = w;
  }
  // The first file whose proxy is being made, for the status bar.
  const making =
    sources
      .filter((s) => !proxyUrls[s.id] && proxies[s.id])
      .map((s) => ({
        text: `Preparing fast stepping${sources.length > 1 ? ` for ${s.name}` : ""}… ${Math.floor((proxies[s.id].done ?? 0) * 100)}%`,
      }))[0] ?? null;
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
  return (
    <div className={styles.app}>
      <CommandBar
        empty={empty}
        audio={audio}
        exporting={exporting !== null}
        settings={settings}
        onOpen={replace}
        onAdd={addVideo}
      />
      <FrameOptions source={source} settings={settings} />
      <div className={styles.preview}>
        {source ? (
          <Preview
            sources={sources}
            player={player!}
            proxyUrls={proxyUrls}
            onError={(text) => setNotice({ text, error: true })}
            onUnplayable={(s) => {
              if (convertAsked.current === s.url) return;
              convertAsked.current = s.url;
              setConverting({ name: s.name, done: 0 });
              void commands.convertForPreview(s.url);
            }}
          />
        ) : (
          <EmptyEditor onOpen={openVideo} />
        )}
      </div>
      <Resizer height={timelineH} onHeight={setTimelineH} />
      <TimelineBar
        source={source}
        player={player}
        inFrames={inFrames}
        onToggleFrames={() => setInFrames((f) => !f)}
      />
      <TimelineOptions source={source} inFrames={inFrames} player={player} />
      <div className={styles.timeline} style={{ height: timelineH }}>
        {source && player && (
          <Timeline
            source={source}
            sources={sources}
            player={player}
            inFrames={inFrames}
            thumbs={fileThumbs}
            waves={fileWaves}
          />
        )}
      </div>
      <StatusBar notice={exportNotice ?? conversion ?? notice ?? making} empty={empty} />
      {asking && "open" in asking && (
        <ConfirmDialog
          title="Replace the timeline?"
          confirm="Replace"
          onConfirm={() => {
            setAsking(null);
            openVideo();
          }}
          onCancel={() => setAsking(null)}
        >
          <p>Opening a video replaces the timeline, and its edits are lost.</p>
          <p>To put another video after these, use Add Video (Ctrl+Shift+O).</p>
        </ConfirmDialog>
      )}
      {asking && "offered" in asking && (
        <ConfirmDialog
          title="Add to the timeline, or replace it?"
          confirm="Add"
          onConfirm={() => {
            setAsking(null);
            void commands.answerOffer(true);
          }}
          onCancel={() => {
            setAsking(null);
            void commands.answerOffer(null);
          }}
          other={{
            label: "Replace",
            onClick: () => {
              setAsking(null);
              void commands.answerOffer(false);
            },
          }}
        >
          <p>
            Add {asking.offered} after the clips on the timeline, or replace the timeline with it.
          </p>
          {edited() && <p>Replacing loses the timeline&apos;s edits.</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}

/** The least the preview keeps when the timeline is dragged taller (EditorApp.module.css). */
const PREVIEW_MIN = 160;

/**
 * The line between the preview and the timeline: dragged up, the timeline grows (its markup
 * lanes taking the room, Timeline.tsx), down to its own height at least; a double-click puts it
 * back.
 */
function Resizer({ height, onHeight }: { height: number; onHeight: (h: number) => void }) {
  const drag = useRef<{ y: number; h: number; max: number } | null>(null);
  return (
    <div
      className={styles.resizer}
      title="Drag to resize the timeline · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const preview = e.currentTarget.previousElementSibling as HTMLElement | null;
        const room = Math.max(0, (preview?.clientHeight ?? 0) - PREVIEW_MIN);
        drag.current = { y: e.clientY, h: height, max: height + room };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        onHeight(Math.round(Math.max(TIMELINE_H, Math.min(d.max, d.h + d.y - e.clientY))));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => onHeight(TIMELINE_H)}
    />
  );
}
