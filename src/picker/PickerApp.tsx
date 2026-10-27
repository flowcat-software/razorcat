// The recording overlay (PLAN 5b.3; picker.rs): one per monitor, transparent and dimmed, the
// screen live under it. Vandal's overlay, for video: drag an area (Shift: a square), adjust it by
// its edges or the keys, then Enter or the Record bar records it; F records this whole screen;
// W picks a window (a click, or Enter, records it); Esc or a right-click goes back. The
// microphone, the system's sound, clicks and the camera are turned on or off by the bar's
// buttons, or M, S, C and V (Settings › Recording's settings); the camera's bubble shows while
// it's on (camera.rs). One selection over every monitor: starting one here clears the
// others'. Selections are in the monitor's physical pixels, shown in CSS px.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { commands, events, type PickLoad } from "../shared/ipc";
import { Struck } from "../shared/Struck";
import {
  arrowDelta,
  clampPoint,
  cursorFor,
  growRect,
  hitTest,
  moveRect,
  rectFromDrag,
  resizeKeepingShape,
  resizeRect,
  squareFromDrag,
  type Edges,
  type Point,
  type Rect,
} from "./selection";
import { toolbarPlacement, type Size } from "./toolbarPlacement";
import { visiblePart, windowAt } from "./windowPick";
import styles from "./PickerApp.module.css";

const index = Number(getCurrentWebviewWindow().label.replace("pick-", ""));

/** CSS px a pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 3;
/** CSS px around the selection's border that grab it to resize. */
const HANDLE_TOLERANCE = 6;
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

type Drag =
  | { mode: "create"; anchor: Point; moved: boolean }
  | { mode: "move"; start: Point; orig: Rect }
  | { mode: "resize"; start: Point; orig: Rect; edges: Edges };

/** Physical pixel p covers CSS [p/scale, (p+1)/scale): floored, as Vandal's. */
const toPhysical = (css: number, scale: number) => Math.floor(css * scale + 1e-6);

export function PickerApp() {
  const [scale, setScale] = useState(window.devicePixelRatio);
  const [size, setSize] = useState<Size>(() => screenSize());
  const [selection, setSelection] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const barRef = useRef<HTMLDivElement>(null);
  const [barSize, setBarSize] = useState<Size | null>(null);
  const [load, setLoad] = useState<PickLoad | null>(null);
  // Window mode (key W), shared by every overlay through Rust: the window under the pointer, as
  // an index into `load.windows`.
  const [picking, setPicking] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  /** The window a click started on; it's picked if the click ends there too. */
  const pressedWindow = useRef<number | null>(null);
  const [mic, setMic] = useState(false);
  const [system, setSystem] = useState(false);
  /** Clicks highlighted (Settings › Recording; the control's button while recording). */
  const [clicks, setClicks] = useState(false);
  /** The camera recorded, its bubble shown. */
  const [camera, setCamera] = useState(false);

  // The window is sized to its monitor after it's made: follow it.
  useEffect(() => {
    const measure = () => {
      setScale(window.devicePixelRatio);
      setSize(screenSize());
    };
    window.addEventListener("resize", measure);
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    const cleared = events.pickClear.listen(({ payload }) => {
      if (payload.except !== index) {
        setSelection(null);
        setDrag(null);
      }
    });
    const picked = events.pickWindow.listen(({ payload }) => {
      setPicking(payload.picking);
      setHovered(payload.hovered);
      if (payload.picking) {
        setSelection(null);
        setDrag(null);
      }
    });
    const settings = events.settingsChanged.listen(({ payload }) => {
      setMic(!!payload.recording?.microphone);
      setSystem(!!payload.recording?.systemSound);
      setClicks(!!payload.recording?.clicks);
      setCamera(!!payload.recording?.camera);
    });
    void commands.pickLoad(index).then((l) => {
      setLoad(l);
      if (l) {
        setMic(l.microphone);
        setSystem(l.systemSound);
        setClicks(l.clicks);
        setCamera(l.camera);
      }
    });
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      void cleared.then((stop) => stop());
      void picked.then((stop) => stop());
      void settings.then((stop) => stop());
    };
  }, []);

  // The camera's bubble follows the selection into its corner (camera.rs), until it's dragged.
  const followed = useRef(false);
  useEffect(() => {
    if (!selection && !followed.current) return;
    followed.current = true;
    void commands.pickSelection(index, selection);
  }, [selection]);

  const record = useCallback((rect: Rect | null) => {
    void commands.pickArea(index, rect).then((r) => {
      if (r.status === "error") console.error("[picker]", r.error);
    });
  }, []);
  const cancel = useCallback(() => void commands.pickCancel(), []);
  const toggleMic = useCallback(() => {
    setMic((on) => {
      void commands.setRecordSound(!on, null, null, null);
      return !on;
    });
  }, []);
  const toggleSystem = useCallback(() => {
    setSystem((on) => {
      void commands.setRecordSound(null, !on, null, null);
      return !on;
    });
  }, []);
  const toggleClicks = useCallback(() => {
    setClicks((on) => {
      void commands.setRecordSound(null, null, !on, null);
      return !on;
    });
  }, []);
  const toggleCamera = useCallback(() => {
    setCamera((on) => {
      void commands.setRecordSound(null, null, null, !on);
      return !on;
    });
  }, []);

  /** Window mode on or off, and the window under the pointer, on every overlay. */
  const setWindowPick = useCallback((on: boolean, w: number | null) => {
    setPicking(on);
    setHovered(w);
    void commands.pickWindowChanged(on, w);
  }, []);
  /** The window under a monitor-local point. */
  const windowUnder = useCallback(
    (p: Point) => (load ? windowAt(load.windows, { x: p.x + load.x, y: p.y + load.y }) : null),
    [load],
  );
  const pickWindow = useCallback((w: number) => {
    void commands.pickWindow(w).then((r) => {
      if (r.status === "error") console.error("[picker]", r.error);
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const plain = !e.repeat && !e.ctrlKey && !e.altKey && !e.shiftKey;
      const plainW = plain && e.code === "KeyW";
      if (plain && e.code === "KeyM") return toggleMic();
      if (plain && e.code === "KeyS") return toggleSystem();
      if (plain && e.code === "KeyC") return toggleClicks();
      if (plain && e.code === "KeyV") return toggleCamera();
      if (picking) {
        // Esc / W go back to selecting an area; Enter records the window lit.
        if (e.key === "Escape" || plainW) return setWindowPick(false, null);
        if (e.key === "Enter") {
          if (hovered !== null) pickWindow(hovered);
          return;
        }
      }
      if (e.key === "Escape") return cancel();
      if (e.key === "Enter") {
        if (selection) record(selection);
        return;
      }
      if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.altKey) return record(null);
      if (plainW && !picking) {
        setSelection(null);
        setDrag(null);
        setWindowPick(true, pointer ? windowUnder(pointer) : null);
        return;
      }
      const delta = arrowDelta(e.key, e.shiftKey ? 10 : 1);
      if (delta && selection && !drag) {
        e.preventDefault();
        setSelection(
          e.ctrlKey
            ? growRect(selection, delta.x, delta.y, size)
            : moveRect(selection, delta.x, delta.y, size),
        );
      }
    };
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, [
    selection,
    drag,
    size,
    record,
    cancel,
    picking,
    hovered,
    pointer,
    setWindowPick,
    windowUnder,
    pickWindow,
    toggleMic,
    toggleSystem,
    toggleClicks,
    toggleCamera,
  ]);

  const toLocal = (e: PointerEvent): Point =>
    clampPoint({ x: toPhysical(e.clientX, scale), y: toPhysical(e.clientY, scale) }, size);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || barRef.current?.contains(e.target as Node)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (picking) {
      pressedWindow.current = windowUnder(toLocal(e));
      return;
    }
    const p = toLocal(e);
    const hit = selection ? hitTest(selection, p, HANDLE_TOLERANCE * scale) : null;
    if (selection && hit?.kind === "edge") {
      setDrag({ mode: "resize", start: p, orig: selection, edges: hit.edges });
    } else if (selection && hit?.kind === "inside") {
      setDrag({ mode: "move", start: p, orig: selection });
    } else {
      setDrag({ mode: "create", anchor: p, moved: false });
      setSelection(null);
      void commands.pickStarted(index);
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = toLocal(e);
    setPointer(p);
    if (picking) {
      const w = windowUnder(p);
      if (w !== hovered) setWindowPick(true, w);
      return;
    }
    if (!drag) return;
    switch (drag.mode) {
      case "create": {
        const threshold = DRAG_THRESHOLD * scale;
        const moved =
          drag.moved ||
          Math.abs(p.x - drag.anchor.x) >= threshold ||
          Math.abs(p.y - drag.anchor.y) >= threshold;
        if (moved) {
          if (!drag.moved) setDrag({ ...drag, moved: true });
          setSelection(
            e.shiftKey ? squareFromDrag(drag.anchor, p, size) : rectFromDrag(drag.anchor, p, size),
          );
        }
        break;
      }
      case "move": {
        const dx = p.x - drag.start.x;
        const dy = p.y - drag.start.y;
        // Shift: along one axis only.
        const across = Math.abs(dx) >= Math.abs(dy);
        setSelection(
          e.shiftKey
            ? moveRect(drag.orig, across ? dx : 0, across ? 0 : dy, size)
            : moveRect(drag.orig, dx, dy, size),
        );
        break;
      }
      case "resize":
        setSelection(
          (e.shiftKey ? resizeKeepingShape : resizeRect)(
            drag.orig,
            drag.edges,
            p.x - drag.start.x,
            p.y - drag.start.y,
            size,
          ),
        );
        break;
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (picking) {
      // Picked on release, so the release can't land on the window below.
      const w = pressedWindow.current;
      pressedWindow.current = null;
      if (e.button === 0 && w !== null && w === windowUnder(toLocal(e))) pickWindow(w);
      return;
    }
    if (drag?.mode === "create" && !drag.moved) setSelection(null);
    setDrag(null);
  };

  const creating = drag?.mode === "create";
  const barShown = !!selection && !creating;
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!barShown || !el) return;
    const measure = () => setBarSize({ width: el.offsetWidth, height: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [barShown]);

  const css = (v: number) => v / scale;
  let cursor = picking ? "default" : "crosshair";
  if (drag?.mode === "move") cursor = "move";
  else if (drag?.mode === "resize") cursor = cursorFor({ kind: "edge", edges: drag.edges });
  else if (!drag && selection && pointer)
    cursor = cursorFor(hitTest(selection, pointer, HANDLE_TOLERANCE * scale));

  const placement =
    barShown && barSize
      ? toolbarPlacement(
          {
            x: css(selection.x),
            y: css(selection.y),
            width: css(selection.width),
            height: css(selection.height),
          },
          barSize,
          { width: css(size.width), height: css(size.height) },
        )
      : null;

  // The window lit: its part on this monitor, and the whole of it in this monitor's pixels (it
  // may run off the edges).
  const lit = picking && load && hovered !== null ? load.windows[hovered] : undefined;
  const windowShown = lit && load ? visiblePart(lit, { x: load.x, y: load.y, ...size }) : null;
  const windowRect = lit && load && { ...lit, x: lit.x - load.x, y: lit.y - load.y };

  return (
    <div
      className={styles.root}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => !drag && setPointer(null)}
      onDoubleClick={() => {
        if (!picking && selection && pointer && hitTest(selection, pointer, 0)?.kind === "inside") {
          record(selection);
        }
      }}
    >
      {!selection && !windowShown && <div className={styles.dimAll} />}
      {windowRect && windowShown && (
        <>
          <div
            className={`${styles.selection} ${styles.window}`}
            style={{
              left: css(windowRect.x),
              top: css(windowRect.y),
              width: css(windowRect.width),
              height: css(windowRect.height),
            }}
          />
          <span
            className={styles.windowSize}
            style={{ left: css(windowShown.x) + 8, top: css(windowShown.y) + 8 }}
          >
            {windowRect.width & ~1} × {windowRect.height & ~1}
          </span>
        </>
      )}
      {selection && (
        <div
          className={styles.selection}
          style={{
            left: css(selection.x),
            top: css(selection.y),
            width: css(selection.width),
            height: css(selection.height),
          }}
        >
          {!creating &&
            HANDLES.map((h) => <span key={h} className={`${styles.handle} ${styles[h]}`} />)}
          <span className={css(selection.y) < 32 ? styles.sizeInside : styles.sizeAbove}>
            {selection.width & ~1} × {selection.height & ~1}
          </span>
        </div>
      )}
      {barShown && (
        <div
          ref={barRef}
          className={styles.bar}
          // Off screen until measured, so it never flashes in the wrong place.
          style={{ left: placement?.x ?? -10000, top: placement?.y ?? -10000 }}
        >
          <button
            type="button"
            className={styles.mic}
            aria-pressed={mic}
            title={mic ? "Microphone on (M)" : "Microphone off (M)"}
            aria-label="Record the microphone"
            onClick={toggleMic}
          >
            <MicIcon on={mic} />
          </button>
          <button
            type="button"
            className={styles.mic}
            aria-pressed={system}
            title={system ? "System sound on (S)" : "System sound off (S)"}
            aria-label="Record system sound"
            onClick={toggleSystem}
          >
            <SpeakerIcon on={system} />
          </button>
          <button
            type="button"
            className={styles.mic}
            aria-pressed={clicks}
            title={clicks ? "Highlighting clicks (C)" : "Not highlighting clicks (C)"}
            aria-label="Highlight clicks in video"
            onClick={toggleClicks}
          >
            <MouseIcon on={clicks} />
          </button>
          <button
            type="button"
            className={styles.mic}
            aria-pressed={camera}
            title={camera ? "Camera on (V)" : "Camera off (V)"}
            aria-label="Record the camera"
            onClick={toggleCamera}
          >
            <CameraIcon on={camera} />
          </button>
          <button type="button" className={styles.record} onClick={() => record(selection)}>
            <span className={styles.dot} aria-hidden />
            Record
          </button>
          <button type="button" className={styles.cancel} onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
      {focused && !drag && (
        <HintBar
          mic={mic}
          system={system}
          clicks={clicks}
          camera={camera}
          picking={picking}
          hasSelection={!!selection}
          atBottom={!!selection && css(selection.y) < 72}
        />
      )}
    </div>
  );
}

/** The monitor's size in physical pixels: the window covers it. */
function screenSize(): Size {
  return {
    width: Math.round(window.innerWidth * window.devicePixelRatio),
    height: Math.round(window.innerHeight * window.devicePixelRatio),
  };
}

function HintBar({
  mic,
  system,
  clicks,
  camera,
  picking,
  hasSelection,
  atBottom,
}: {
  mic: boolean;
  system: boolean;
  clicks: boolean;
  camera: boolean;
  picking: boolean;
  hasSelection: boolean;
  atBottom: boolean;
}) {
  return (
    <div className={`${styles.hint} ${atBottom ? styles.hintBottom : ""}`}>
      {picking ? (
        <>
          <Hint keys={["Click"]} label="record window" />
          <Hint keys={["W"]} label="select area" />
          <Hint keys={["F"]} label="this screen" />
          <Hint keys={["M"]} label={mic ? "mic on" : "mic off"} />
          <Hint keys={["S"]} label={system ? "sound on" : "sound off"} />
          <Hint keys={["C"]} label={clicks ? "clicks on" : "clicks off"} />
          <Hint keys={["V"]} label={camera ? "camera on" : "camera off"} />
          <Hint keys={["Esc"]} label="back" />
        </>
      ) : hasSelection ? (
        <>
          <Hint keys={["Enter"]} label="record" />
          <Hint keys={["Drag"]} label="adjust" />
          <Hint keys={["Shift"]} label="keep shape" />
          <Hint keys={["←↑↓→"]} label="nudge" />
          <Hint keys={["Ctrl", "←↑↓→"]} label="resize" />
          <Hint keys={["M"]} label={mic ? "mic on" : "mic off"} />
          <Hint keys={["S"]} label={system ? "sound on" : "sound off"} />
          <Hint keys={["C"]} label={clicks ? "clicks on" : "clicks off"} />
          <Hint keys={["V"]} label={camera ? "camera on" : "camera off"} />
          <Hint keys={["Esc"]} label="cancel" />
        </>
      ) : (
        <>
          <Hint keys={["Drag"]} label="select area" />
          <Hint keys={["Shift"]} label="square" />
          <Hint keys={["W"]} label="window" />
          <Hint keys={["F"]} label="this screen" />
          <Hint keys={["M"]} label={mic ? "mic on" : "mic off"} />
          <Hint keys={["S"]} label={system ? "sound on" : "sound off"} />
          <Hint keys={["C"]} label={clicks ? "clicks on" : "clicks off"} />
          <Hint keys={["V"]} label={camera ? "camera on" : "camera off"} />
          <Hint keys={["Esc"]} label="cancel" />
        </>
      )}
    </div>
  );
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className={styles.hintItem}>
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
      {label}
    </span>
  );
}

/** A microphone; off, struck through. */
function MicIcon({ on }: { on: boolean }) {
  return (
    <Struck off={!on}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" fill="none" />
    </Struck>
  );
}

/** A video camera; off, struck through. */
function CameraIcon({ on }: { on: boolean }) {
  return (
    <Struck off={!on}>
      <rect x="3" y="7" width="12" height="10" rx="2" fill="none" />
      <path d="M15 10.5l6-3.5v10l-6-3.5z" fill="none" />
    </Struck>
  );
}

/** A mouse, upright (as the control's: the slash crosses it); off, struck through. */
function MouseIcon({ on }: { on: boolean }) {
  return (
    <Struck off={!on}>
      <rect x="6.5" y="3" width="11" height="18" rx="5.5" fill="none" />
      <path d="M12 3v6.5" fill="none" />
    </Struck>
  );
}

/** A speaker, its sound waves; off, struck through. */
function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <Struck off={!on}>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" />
    </Struck>
  );
}
