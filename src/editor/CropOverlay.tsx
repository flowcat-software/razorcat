import { useRef, useState, type PointerEvent } from "react";
import { dragCrop, drawCrop, type Handle } from "./cropGeometry";
import { useDoc } from "./docStore";
import type { Point, Rect, Size } from "./fit";
import { lockedRatio, useTool } from "./toolStore";
import styles from "./EditorApp.module.css";

interface Props {
  /** The crop, in source px. */
  crop: Rect;
  /** The whole source picture, which the box can cover. */
  source: Size;
  /** CSS px per source px. */
  scale: number;
}

const CURSORS: Record<Handle | "new", string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
  move: "move",
  new: "crosshair",
};

const EDGES: Handle[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

/** Below this many CSS px, a press outside the box is a click, not a new box. */
const DRAW_THRESHOLD = 4;

/**
 * The crop tool's box over the whole picture (Vandal's): the rest dimmed, a rule-of-thirds grid,
 * corner brackets. Drag an edge or corner to resize (Shift keeps its shape), inside to move,
 * outside to draw a new box (Shift: square); a ratio picked in the options bar holds throughout.
 * While the box is the whole picture, which can't move, a drag inside draws a new one too;
 * Ctrl+drag always does. The crop changes as you drag, one undo step a drag; double-click puts
 * the tool down.
 */
export function CropOverlay({ crop, source, scale }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<Handle | "new" | null>(null);
  const whole =
    crop.x === 0 && crop.y === 0 && crop.width === source.width && crop.height === source.height;

  const toSource = (clientX: number, clientY: number): Point => {
    const r = rootRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pressed = ((e.target as HTMLElement)
      .closest("[data-handle]")
      ?.getAttribute("data-handle") ?? "new") as Handle | "new";
    const handle = e.ctrlKey || (whole && pressed === "move") ? "new" : pressed;
    const start = toSource(e.clientX, e.clientY);
    const startRect = crop;
    const ratio = lockedRatio();
    const client = { x: e.clientX, y: e.clientY };
    const root = e.currentTarget;
    root.setPointerCapture(e.pointerId);
    setDragging(handle);
    const doc = useDoc.getState();
    doc.beginGesture();

    const onMove = (m: globalThis.PointerEvent) => {
      const p = toSource(m.clientX, m.clientY);
      if (handle === "new") {
        if (Math.hypot(m.clientX - client.x, m.clientY - client.y) < DRAW_THRESHOLD) return;
        // A picked ratio holds; otherwise Shift draws a square.
        doc.crop(drawCrop(start, p, source, ratio ?? (m.shiftKey ? 1 : undefined)));
      } else {
        doc.crop(
          dragCrop(
            startRect,
            handle,
            p.x - start.x,
            p.y - start.y,
            source,
            // A picked ratio holds; otherwise Shift keeps the box's own.
            ratio ?? (m.shiftKey ? startRect.width / startRect.height : undefined),
          ),
        );
      }
    };
    const onUp = () => {
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onUp);
      setDragging(null);
      useDoc.getState().endGesture();
    };
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
  };

  const css = (r: Rect) => ({
    left: r.x * scale,
    top: r.y * scale,
    width: r.width * scale,
    height: r.height * scale,
  });
  // The picture round the box, dimmed: above, below, left, right.
  const c = crop;
  const dims: Rect[] = [
    { x: 0, y: 0, width: source.width, height: c.y },
    { x: 0, y: c.y + c.height, width: source.width, height: source.height - c.y - c.height },
    { x: 0, y: c.y, width: c.x, height: c.height },
    { x: c.x + c.width, y: c.y, width: source.width - c.x - c.width, height: c.height },
  ];

  return (
    <div
      ref={rootRef}
      className={styles.cropOverlay}
      style={{ cursor: dragging ? CURSORS[dragging] : "crosshair" }}
      onPointerDown={onPointerDown}
    >
      {dims.map((r, i) => (
        <div key={i} className={styles.cropDim} style={css(r)} />
      ))}
      <div
        className={styles.cropBox}
        data-handle="move"
        style={{ ...css(crop), cursor: whole ? "crosshair" : undefined }}
        onDoubleClick={() => useTool.getState().setTool("select")}
      >
        <span className={styles.cropThirds} />
        {(["nw", "ne", "sw", "se"] as const).map((k) => (
          <span key={k} className={`${styles.cropCorner} ${styles[`corner_${k}`]}`} />
        ))}
        {EDGES.map((h) => (
          <span
            key={h}
            data-handle={h}
            className={`${styles.cropHandle} ${styles[`handle_${h}`]}`}
            style={{ cursor: dragging ? undefined : CURSORS[h] }}
          />
        ))}
        <span className={styles.cropSize}>
          {crop.width} × {crop.height}
        </span>
      </div>
    </div>
  );
}
