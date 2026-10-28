import { useEffect, useMemo, useRef, useState } from "react";
import { hint } from "../markup/HintLine";
import { sayWhy, useHintSources } from "../markup/hints";
import { clickTiming } from "../markup/click";
import { annotationId, docStore as markupDoc, timelineFps } from "../markup/model/store";
import { forgetToolMemory } from "../markup/toolMemory";
import { startToolStylesSync } from "../markup/toolStylesSync";
import { useMarkupKeys } from "../markup/useMarkupKeys";
import { clickSettingsOf, useClickSettings, type ClickSettings } from "../markup/clickSettings";
import { applyStyleSettings, loadFonts } from "../markup/useStyleSettings";
import { ConfirmDialog } from "../settings/controls/ConfirmDialog";
import { isTyping } from "../shared/dom";
import {
  commands,
  events,
  type CheckFrames,
  type Settings,
  type CameraFitting,
  type SourceCamera,
  type SourceInfo,
  type ThumbsInfo,
} from "../shared/ipc";
import { recordedCamera } from "./cameraKeys";
import { useRecordedCameras, type RecordedCamera } from "./cameraStore";
import { CommandBar } from "./CommandBar";
import { useToolKeys } from "./cropTool";
import { EmptyEditor } from "./EmptyEditor";
import { playedClips, total, type ClipId, type Doc } from "./doc";
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
import {
  LARGE_GIF,
  exportTimeline,
  fileSize,
  folderLabel,
  onBeforeExport,
  onExportFailed,
} from "./exports";
import { checkFrames } from "./frameCheck";
import { checkLayout } from "./layoutCheck";
import { FrameOptions } from "./FrameOptions";
import { playbackGain, usePlayback } from "./playback";
import { Player } from "./player";
import { Preview } from "./Preview";
import { StatusBar, type Notice } from "./StatusBar";
import { TIMELINE_H, Timeline } from "./Timeline";
import { TimelineBar } from "./TimelineBar";
import { openSpeed } from "./speedStore";
import { SpeedPopover } from "./SpeedPopover";
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

/** The edit as the player plays it: each clip from after its crossfade (`playedClips`). */
const played = (doc: Doc) => ({ clips: playedClips(doc), muted: doc.muted });

/** Settings › Timeline › Ranges and markup: how they take edits of the clips. */
const rangeOptions = (s: Settings) =>
  useDoc.getState().setOptions({
    follow: s.timeline.rangesFollowVideo,
    deleteWithClip: s.timeline.deleteRangesWithClip,
    splitMarks: s.timeline.splitMarkup,
    fadeCuts: s.timeline.fadeSplitMarkup,
    defaultFade: s.timeline.defaultMarkupFade,
    copyFades: s.timeline.copiesKeepFades,
    defaultClipFade: s.timeline.defaultClipFade,
    fadeClipCuts: s.timeline.fadeSplitClips,
    stretchMarks: s.timeline.markupStretchesWithSpeed,
  });

/** How long the playback volume rests before it's kept in the settings (ms). */
const PLAYBACK_SAVE_MS = 600;

/** The settings the editor's stores keep (ranges, number fields, the markup's styles). */
const applySettings = (s: Settings) => {
  rangeOptions(s);
  applyStyleSettings(s);
  const was = useClickSettings.getState();
  const now = clickSettingsOf(s.recording);
  useClickSettings.setState(now);
  // Locked (PLAN 5b.6h): as the lock is turned on (Settings asked first), and while it's on,
  // every click takes Recording's style and timing, as one undo step.
  if (now.follow && (!was.follow || !sameClickStyle(was, now))) {
    useDoc
      .getState()
      .restyleClicks({ look: now.look, size: now.size }, clickTiming(timelineFps(), now));
  }
  useTool.getState().setDragSpeed(s.editing.numberDragSpeed);
};

/** Recording's clicks look and last the same in `a` and `b` (their colours aside). */
const sameClickStyle = (a: ClickSettings, b: ClickSettings) =>
  a.look === b.look &&
  a.size === b.size &&
  a.seconds === b.seconds &&
  a.fadeIn === b.fadeIn &&
  a.fadeOut === b.fadeOut;

/**
 * The transport's and the timeline's keys (mockup's keys table), M and Shift+M only with sound
 * to mute. True if the key was theirs.
 */
function transportKey(e: KeyboardEvent, player: Player, audio: boolean): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  // M mutes the selected clip, Shift+M all the sound (as Logic's M and modifier+M).
  if (e.code === "KeyM") {
    if (e.repeat) return true;
    if (!audio) sayWhy("mute.silent");
    else if (e.shiftKey) muteSound();
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
/**
 * The clicks Rust noted while file `s` was recorded, as click marks on its clip `clip` (PLAN
 * 5b.6b), at the timeline's rate (`first`, its first file's): asked once, as it opens.
 */
function addRecordedInput(s: SourceInfo, clip: number, first: SourceInfo): void {
  void commands.takeRecordedInput(s.path).then((input) => {
    if (!input?.clicks.length) return;
    // Settings › Recording's look and timing (PLAN 5b.6d).
    const style = useClickSettings.getState();
    useDoc
      .getState()
      .addRecordedClicks(
        clip,
        input,
        first.rateNum / first.rateDen,
        { width: s.width, height: s.height },
        style,
      );
  });
}

export function EditorApp() {
  /** The timeline's files, first first (PLAN 4.5e): the first sets its rate and frame. */
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const source = sources[0] ?? null;
  /** A file has sound, for M and Shift+M to mute. */
  const audio = sources.some((s) => s.audioTracks > 0);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** A screen recording is under way (PLAN 5b; recording.rs). */
  const [recording, setRecording] = useState(false);
  /** Records the screen: the recording goes on the timeline's end (`add`) or replaces it. */
  const startRecording = (add: boolean) =>
    void commands.startRecording(add).then((r) => {
      if (r.status === "error") setNotice({ text: r.error, error: true });
    });
  /** As `startRecording`, the first recording ever asking where recordings go (PLAN 5b.7). */
  const record = (add: boolean) => {
    const s = settingsNow.current;
    if (!s || s.recording.askedFolder) return startRecording(add);
    void commands
      .defaultRecordingFolder()
      .then((fallback) => setAsking({ recordFolder: s.recording.folder || fallback, add }));
  };
  /**
   * The recordings folder question's answer: `folder` (null: as it is) from now on; never asked
   * again. The recording starts once it's stored.
   */
  const answerRecordingFolder = (add: boolean, folder: string | null) => {
    setAsking(null);
    const s = settingsNow.current;
    if (!s) return startRecording(add);
    const recording = { ...s.recording, askedFolder: true, ...(folder ? { folder } : {}) };
    void commands
      .updateSettings({ ...s, recording })
      .catch((e: unknown) => console.error("[recording] folder:", e))
      .finally(() => startRecording(add));
  };
  /**
   * A question before the timeline is replaced (PLAN 4.5e3): Open with edits on it, or a file
   * dropped on it (add or replace).
   */
  const [asking, setAsking] = useState<
    | { open: true }
    | { offered: string[] }
    /** Record: the recording replaces the timeline, or goes on its end. */
    | { record: true }
    /** The first export: save to a default folder? `folder` as the setting holds it. */
    | { folder: string; go: () => void }
    /** The first recording: save recordings to `recordFolder`? Then it starts (`add`). */
    | { recordFolder: string; add: boolean }
    /** The first close: Razorcat stays in the tray. */
    | { tray: true }
    | null
  >(null);
  /**
   * The default-folder question's answer: `folder` to save there from now on, or null for the
   * Save dialog. Either way it's never asked again; the export goes on once it's stored.
   */
  const answerFolder = (question: { go: () => void }, folder: string | null) => {
    setAsking(null);
    const s = settingsNow.current;
    if (!s) return question.go();
    const exported = folder
      ? { ...s.export, askedFolder: true, saveToFolder: true, folder }
      : { ...s.export, askedFolder: true };
    void commands
      .updateSettings({ ...s, export: exported })
      .catch((e: unknown) => console.error("[export] default folder:", e))
      .finally(question.go);
  };
  /** Record (the button, the tray's): Stop while recording; with a timeline, asks first. */
  const recordClicked = () => {
    if (recording) void commands.stopRecording();
    else if (source) setAsking({ record: true });
    else record(false);
  };
  /** Open (the button, Ctrl+O): with edits, asks first. */
  const replace = () => (edited() ? setAsking({ open: true }) : openVideo());
  /** Time as frame numbers, not timecode: the readout and the ruler (a click on the readout). */
  const [inFrames, setInFrames] = useState(false);
  /** The timeline's height, the resizer above it dragged (its own, to start). */
  const [timelineH, setTimelineH] = useState(TIMELINE_H);
  /** The source the preview last asked to convert: asked once, however many errors. */
  const convertAsked = useRef<string | null>(null);
  /**
   * An export under way (export.rs): the file being written and how far along, over all; or,
   * while a recording's camera it needs is still being processed, how far that's got.
   */
  const [exporting, setExporting] = useState<{
    name: string;
    done: number;
    camera?: number | null;
  } | null>(null);
  /** A conversion under way (convert.rs): the file and how far along. */
  const [converting, setConverting] = useState<{ name: string; done: number } | null>(null);
  /** Each file's proxy: ready (its URL) or how far along; by the file's id. */
  const [proxies, setProxies] = useState<Record<string, { url?: string; done?: number }>>({});
  /** Settings › General › Show thumbnails (made from proxies, so not without them). */
  const [showThumbs, setShowThumbs] = useState(true);
  /** Development: the source to check (`--check-frames`, check.rs), once it's open. */
  const [checkFor, setCheckFor] = useState<CheckFrames | null>(null);
  /** The settings, as Rust last sent them (the export menu's toggle reads and sets them). */
  const [settings, setSettings] = useState<Settings | null>(null);
  /** Settings › Timeline › Show waveform. */
  const [showWave, setShowWave] = useState(true);
  /** Each file's waveform once it's made, by its id. */
  const [waves, setWaves] = useState<Record<string, string>>({});
  /** Each recording's camera, as it's found (camera.rs). */
  const [cameras, setCameras] = useState<Record<string, SourceCamera>>({});
  /** Each recording's camera still being fitted to it: where it'll be, and how far along. */
  const [fitting, setFitting] = useState<Record<string, CameraFitting>>({});
  /** Each file's thumbnails as they're made, by its id. */
  const [thumbs, setThumbs] = useState<Record<string, ThumbsInfo>>({});
  /**
   * The files just opened, and their clips: each gets its camera's keyframe on its first frame,
   * and one at each of the bubble's moves, once where it was recorded is known (PLAN 5d.8, 5d.7).
   */
  const unstarted = useRef(new Map<string, ClipId>());
  // Each recording's camera as recorded (fitted or being fitted), for everything that shows it;
  // the same while it stays the same (being fitted, it's told how far along a few times a
  // second). A recording just opened starts there.
  useEffect(() => {
    const recorded: Record<string, RecordedCamera> = {};
    for (const s of sources) {
      const place = cameras[s.id]?.place ?? fitting[s.id]?.place;
      if (!place) continue;
      const picture = { width: s.width, height: s.height };
      const at = { x: place.x ?? 0, y: place.y ?? 0, size: place.size ?? 0 };
      recorded[s.id] = { state: recordedCamera(at, picture), picture };
    }
    const was = useRecordedCameras.getState().cameras;
    if (JSON.stringify(was) !== JSON.stringify(recorded)) {
      useRecordedCameras.setState({ cameras: recorded });
    }
    for (const [id, clip] of unstarted.current) {
      const s = sources.find((x) => x.id === id);
      if (!recorded[id] || !s) continue;
      unstarted.current.delete(id);
      // The bubble's moves while recording (PLAN 5d.7), each on the frame it shows.
      const picture = recorded[id].picture;
      const moves = (cameras[id]?.moves ?? fitting[id]?.moves ?? []).map(({ time, place }) => ({
        at: Math.round(((time ?? 0) * s.rateNum) / s.rateDen),
        state: recordedCamera({ x: place.x ?? 0, y: place.y ?? 0, size: place.size ?? 0 }, picture),
      }));
      useDoc.getState().startCamera(clip, recorded[id].state, moves);
    }
  }, [sources, cameras, fitting]);
  // The player plays at the first file's rate; a new first file is a new player.
  const sourceId = source?.id;
  const fps = source ? source.rateNum / source.rateDen : 0;
  const player = useMemo(() => (sourceId ? new Player(fps) : null), [sourceId, fps]);

  useEffect(() => {
    if (!player) return;
    player.open();
    return () => player.close();
  }, [player]);

  // Settings › Timeline › Keep the sound's pitch: a retimed clip plays so (PLAN §7, Clip speed).
  const keepPitch = settings?.timeline.keepPitch ?? true;
  useEffect(() => {
    player?.setKeepPitch(keepPitch);
  }, [player, keepPitch]);

  // The playback volume (PLAN 5a): the player plays at it.
  useEffect(() => {
    if (!player) return;
    const apply = ({ volume, muted }: { volume: number; muted: boolean }) =>
      player.setGain(playbackGain(volume, muted));
    apply(usePlayback.getState());
    return usePlayback.subscribe(apply);
  }, [player]);

  // ...and is kept in the settings, a moment after it stops changing (not on every step of a
  // drag: each save writes the file and tells every window).
  const settingsNow = useRef(settings);
  useEffect(() => {
    settingsNow.current = settings;
  }, [settings]);
  // The tray's Record (PLAN 5b.8a) does as the button does, as things are when it's asked.
  const recordNow = useRef(recordClicked);
  useEffect(() => {
    recordNow.current = recordClicked;
  });
  useEffect(() => {
    let timer = 0;
    const stop = usePlayback.subscribe(({ volume, muted }) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const s = settingsNow.current;
        if (!s || (s.playback?.volume === volume && s.playback?.muted === muted)) return;
        void commands.updateSettings({ ...s, playback: { volume, muted } });
      }, PLAYBACK_SAVE_MS);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, []);

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
    // A recording's clicks, on its one clip, and its camera's start.
    const first = latest.current[0];
    if (first) addRecordedInput(first, 1, first);
    unstarted.current = new Map(first ? [[first.id, 1]] : []);
    useTool.getState().setTool("select");
    // A portrait video's crop ratios start turned (9:16).
    useTool.getState().setPortrait(sourceHeight > sourceWidth);
  }, [sourceId, sourceFrames, sourceWidth, sourceHeight]);

  // The player plays the edit (after the load above, so never another source's).
  useEffect(() => {
    if (!player) return;
    player.setEdit(played(useDoc.getState().doc));
    return useDoc.subscribe((s, before) => {
      if (s.doc !== before.doc) player.setEdit(played(s.doc));
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

  // The last run crashed, or this page was reloaded after the webview's crash (PLAN C3, C4).
  useEffect(() => {
    void commands.crashNotice().then((text) => {
      if (!text) return;
      setNotice({
        text,
        action: { label: "Show report", run: () => void commands.openLogsFolder() },
      });
    });
  }, []);

  // The first export, ever, asks whether to save to a default folder; whatever the answer, it
  // doesn't ask again (Settings › Export has it from then on).
  useEffect(() => {
    onBeforeExport(async () => {
      const s = settingsNow.current;
      if (!s || s.export.askedFolder || s.export.saveToFolder) return;
      const folder = s.export.folder || (await commands.defaultExportFolder());
      await new Promise<void>((go) => setAsking({ folder, go }));
    });
    return () => onBeforeExport(() => Promise.resolve());
  }, []);

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
        useTimeline.getState().setDropAt(null);
        setNotice(null);
        setConverting(null);
      }),
      // Files dropped while the timeline has files: onto a cut, they go in there (PLAN
      // 4.5e5); elsewhere, add them or replace the timeline's?
      events.openOffered.listen(({ payload }) => {
        const at = useTimeline.getState().dropAt;
        useTimeline.getState().setDropAt(null);
        if (at !== null) void commands.answerOffer(true, at);
        else setAsking({ offered: payload.names });
      }),
      // One more file, on the end of the timeline (one undo step).
      events.sourceAdded.listen(({ payload }) => {
        const added = payload.source as SourceInfo;
        setSources((now) => [...now, added]);
        // Dropped onto a cut, it goes in there, and lights up to show where.
        const id = useDoc.getState().doc.nextId;
        useDoc.getState().addSource(added.id, added.frames, payload.at);
        // A recording's clicks, on its clip, at the timeline's rate, and its camera's start.
        const first = latest.current[0];
        if (first) addRecordedInput(added, id, first);
        unstarted.current.set(added.id, id);
        if (payload.at !== null) useTimeline.getState().flashClip(id);
        setNotice({
          text:
            payload.at === null
              ? `Added ${added.name} to the end of the timeline.`
              : `Added ${added.name} to the timeline.`,
        });
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
        setExporting({ name: payload.name, done: payload.done ?? 0, camera: payload.camera }),
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
      events.recordingChanged.listen(({ payload }) => {
        setRecording(payload.recording);
        if (payload.message) setNotice({ text: payload.message, error: true });
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
      events.cameraReady.listen(({ payload }) => {
        setCameras((c) => ({ ...c, [payload.source]: payload.camera }));
        setFitting((f) => {
          const rest = { ...f };
          delete rest[payload.source];
          return rest;
        });
      }),
      events.cameraFitting.listen(({ payload }) =>
        setFitting((f) => ({ ...f, [payload.source]: payload })),
      ),
      events.checkFrames.listen(({ payload }) => setCheckFor(payload)),
      // Settings › About's resets: the tools as installed too.
      events.toolStylesReset.listen(forgetToolMemory),
      events.recordAsked.listen(() => recordNow.current()),
      // The first close, ever (PLAN 5b.8a): Razorcat stays in the tray, the page says so.
      events.closingToTray.listen(() => setAsking({ tray: true })),
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
          // The playback volume as it was left, once (later changes are the bar's own).
          const { playback } = s as Settings;
          if (playback) usePlayback.setState({ volume: playback.volume, muted: playback.muted });
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

  // Development: the preview = export check, or the layout check, on the source it was asked
  // for.
  const checked = useRef<typeof checkFor>(null);
  useEffect(() => {
    if (!player || !source || checkFor?.source !== source.id || checked.current === checkFor)
      return;
    checked.current = checkFor;
    let gone = false;
    if (checkFor.layout) {
      checkLayout(player, source, (text) => !gone && setNotice({ text }))
        .then((summary) => setNotice({ text: `Layout check: ${summary}` }))
        .catch((e: unknown) => {
          if (!gone) setNotice({ text: `Layout check failed: ${String(e)}`, error: true });
        });
      return () => {
        gone = true;
      };
    }
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
  // and Ctrl+− fit and zoom the timeline; Ctrl+D, C and V duplicate, copy and paste clips; Ctrl+R
  // a clip's speed.
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
      // Ctrl+R: the selected clip's speed, in its popover, as Premiere's and Resolve's key.
      // Ctrl+Shift+R does nothing (reverse is shelved, PLAN §7). Neither reloads the page.
      if (e.code === "KeyR") {
        e.preventDefault();
        if (e.shiftKey) return;
        const id = useDoc.getState().selected;
        if (id === null || !openSpeed(id)) sayWhy("speed.none");
        return;
      }
      // Ctrl+Shift+V, F and T: the copied markup's style, fades or timing onto the selected
      // markup (fades: a copied clip's too, and onto selected clips).
      const pasting = { KeyV: pasteStyle, KeyF: pasteFades, KeyT: pasteTiming }[e.code];
      if (e.shiftKey && pasting && !isTyping(e.target)) {
        if (pasting()) e.preventDefault();
        else sayWhy("pasteOnto.none");
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
        const why = ({ KeyD: "duplicate.none", KeyC: "copy.none", KeyV: "paste.none" } as const)[
          e.code as "KeyD" | "KeyC" | "KeyV"
        ];
        if (why) {
          e.preventDefault();
          sayWhy(why);
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
        else sayWhy("export.none");
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
  // The hint line's mode: no video yet, or the crop or grow tool picked up (PLAN 4.6b).
  const tool = useTool((s) => s.tool);
  useEffect(() => {
    const mode = !source ? "empty" : tool === "crop" ? "crop" : tool === "grow" ? "grow" : null;
    useHintSources.setState({ mode });
  }, [source, tool]);
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
    text:
      exporting.camera != null
        ? `Processing camera footage for ${exporting.name}… ${Math.floor(exporting.camera * 100)}%`
        : `Exporting ${exporting.name}… ${Math.floor(exporting.done * 100)}%`,
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
        recording={recording}
        onRecord={recordClicked}
      />
      <FrameOptions source={source} sources={sources} settings={settings} />
      <div className={styles.preview}>
        {source ? (
          <Preview
            sources={sources}
            player={player!}
            proxyUrls={proxyUrls}
            cameras={cameras}
            fitting={fitting}
            cameraFades={settings?.recording.cameraFades ?? true}
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
      <SpeedPopover source={source} inFrames={inFrames} />
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
      <StatusBar
        notice={exportNotice ?? conversion ?? notice ?? making}
        empty={empty}
        scrollHints={settings?.appearance.scrollHints ?? true}
      />
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
      {asking && "folder" in asking && (
        <ConfirmDialog
          title="Save exports to a folder?"
          confirm="Use this folder"
          cancel="Not now"
          onConfirm={() => answerFolder(asking, asking.folder)}
          onCancel={() => answerFolder(asking, null)}
          other={{
            label: "Change…",
            onClick: () =>
              void commands.pickFolder(asking.folder).then((picked) => {
                if (picked) answerFolder(asking, picked);
              }),
          }}
        >
          <p>
            Exports can go straight to a folder, named from your file-name templates, without asking
            where each time:
          </p>
          <p>
            <strong>{folderLabel(asking.folder)}</strong>
          </p>
          <p>Settings › Export changes this later. Not now keeps the Save dialog.</p>
        </ConfirmDialog>
      )}
      {asking && "tray" in asking && (
        <ConfirmDialog
          title="Razorcat keeps running in the tray"
          confirm="Keep running"
          onConfirm={() => {
            setAsking(null);
            void commands.closedToTray(true);
          }}
          onCancel={() => setAsking(null)}
          other={{
            label: "Quit instead",
            onClick: () => {
              setAsking(null);
              void commands.closedToTray(false);
            },
          }}
        >
          <p>
            Closing the editor hides it, and Razorcat stays in the tray, by the clock, ready to
            record. Click its icon to open the editor again, or use its menu to quit.
          </p>
          <p>Your choice is kept. Settings › General › Tray changes it.</p>
        </ConfirmDialog>
      )}
      {asking && "recordFolder" in asking && (
        <ConfirmDialog
          title="Save recordings to this folder?"
          confirm="Use this folder"
          onConfirm={() => answerRecordingFolder(asking.add, null)}
          onCancel={() => setAsking(null)}
          other={{
            label: "Change…",
            onClick: () =>
              void commands.pickFolder(asking.recordFolder).then((picked) => {
                if (picked) answerRecordingFolder(asking.add, picked);
              }),
          }}
        >
          <p>Your screen recordings will be saved here, and open in Razorcat when you stop:</p>
          <p>
            <strong>{folderLabel(asking.recordFolder)}</strong>
          </p>
          <p>Settings › Recording changes this later.</p>
        </ConfirmDialog>
      )}
      {asking && "record" in asking && (
        <ConfirmDialog
          title="Add the recording to the timeline, or replace it?"
          confirm="Add"
          onConfirm={() => {
            setAsking(null);
            record(true);
          }}
          onCancel={() => setAsking(null)}
          other={{
            label: "Replace",
            onClick: () => {
              setAsking(null);
              record(false);
            },
          }}
        >
          <p>
            When you stop, the recording goes after the clips on the timeline, or replaces the
            timeline.
          </p>
          {edited() && <p>Replacing loses the timeline&apos;s edits.</p>}
        </ConfirmDialog>
      )}
      {asking && "offered" in asking && (
        <ConfirmDialog
          title="Add to the timeline, or replace it?"
          confirm="Add"
          onConfirm={() => {
            setAsking(null);
            void commands.answerOffer(true, null);
          }}
          onCancel={() => {
            setAsking(null);
            void commands.answerOffer(null, null);
          }}
          other={{
            label: "Replace",
            onClick: () => {
              setAsking(null);
              void commands.answerOffer(false, null);
            },
          }}
        >
          <p>
            {asking.offered.length === 1
              ? `Add ${asking.offered[0]} after the clips on the timeline, or replace the timeline with it.`
              : `Add these ${asking.offered.length} videos after the clips on the timeline, or replace the timeline with them (in this order: ${asking.offered.join(", ")}).`}
          </p>
          <p>
            To put {asking.offered.length === 1 ? "it" : "them"} between clips, drop{" "}
            {asking.offered.length === 1 ? "it" : "them"} onto the cut where{" "}
            {asking.offered.length === 1 ? "it goes" : "they go"}.
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
      {...hint("resizer")}
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
