// The recording overlay (PLAN 5b.3; picker.rs): one per monitor, transparent and dimmed, the
// screen live under it. Vandal's overlay, for video: drag an area (Shift: a square), adjust it by
// its edges or the keys, then Enter or the Record bar records it; F records this whole screen;
// W picks a window (a click, or Enter, records it); Esc or a right-click goes back. One selection over every monitor: starting one here clears the
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
    void commands.pickLoad(index).then(setLoad);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      void cleared.then((stop) => stop());
      void picked.then((stop) => stop());
    };
  }, []);

  const record = useCallback((rect: Rect | null) => {
    void commands.pickArea(index, rect).then((r) => {
      if (r.status === "error") console.error("[picker]", r.error);
    });
  }, []);
  const cancel = useCallback(() => void commands.pickCancel(), []);

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
      const plainW = e.code === "KeyW" && !e.repeat && !e.ctrlKey && !e.altKey && !e.shiftKey;
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
  picking,
  hasSelection,
  atBottom,
}: {
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
          <Hint keys={["Esc"]} label="back" />
        </>
      ) : hasSelection ? (
        <>
          <Hint keys={["Enter"]} label="record" />
          <Hint keys={["Drag"]} label="adjust" />
          <Hint keys={["Shift"]} label="keep shape" />
          <Hint keys={["←↑↓→"]} label="nudge" />
          <Hint keys={["Ctrl", "←↑↓→"]} label="resize" />
          <Hint keys={["Esc"]} label="cancel" />
        </>
      ) : (
        <>
          <Hint keys={["Drag"]} label="select area" />
          <Hint keys={["Shift"]} label="square" />
          <Hint keys={["W"]} label="window" />
          <Hint keys={["F"]} label="this screen" />
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
