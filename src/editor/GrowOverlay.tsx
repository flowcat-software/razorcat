import { useState, type PointerEvent } from "react";
import { useDoc } from "./docStore";
import type { Point } from "./fit";
import { growSide, type Grow, type Side } from "./frame";
import { useTool } from "./toolStore";
import styles from "./EditorApp.module.css";

interface Props {
  grow: Grow;
  /** The picture's place in the frame (CSS px from its top-left), and its size. */
  picture: { x: number; y: number; width: number; height: number };
  /** CSS px per source px. */
  scale: number;
  /** Where the picture is in the preview: kept there while a handle is dragged. */
  at: Point;
}

const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

/**
 * The grow tool's handles (the mockup's): a bar on each side of the frame, dragged out to grow
 * that side (Shift: the opposite side too, by as much) or in to shrink it; the picture's edge
 * dashed. While a handle is held, the picture stays where it is on screen and the frame grows
 * round it, so the handle stays under the pointer; it's fitted again on letting go. A drag is
 * one undo step; double-click puts the tool down.
 */
export function GrowOverlay({ grow, picture, scale, at }: Props) {
  const [held, setHeld] = useState<Side | null>(null);

  const onPointerDown = (side: Side) => (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const start = grow;
    const from = side === "top" || side === "bottom" ? e.clientY : e.clientX;
    // Out is up for the top, left for the left.
    const out = side === "top" || side === "left" ? -1 : 1;
    setHeld(side);
    useTool.getState().holdView({ scale, ...at });
    const doc = useDoc.getState();
    doc.beginGesture();

    const onMove = (m: globalThis.PointerEvent) => {
      const to = side === "top" || side === "bottom" ? m.clientY : m.clientX;
      const by = ((to - from) * out) / scale;
      let g = growSide(start, side, start[side] + by);
      if (m.shiftKey) g = growSide(g, OPPOSITE[side], start[OPPOSITE[side]] + by);
      doc.grow(g);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setHeld(null);
      useTool.getState().holdView(null);
      useDoc.getState().endGesture();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return (
    <div className={styles.growOverlay} onDoubleClick={() => useTool.getState().setTool("select")}>
      <div
        className={styles.growPicture}
        style={{ left: picture.x, top: picture.y, width: picture.width, height: picture.height }}
      />
      {(["top", "bottom", "left", "right"] as const).map((side) => (
        <span
          key={side}
          className={`${styles.growHandle} ${styles[`grow_${side}`]}`}
          data-held={held === side || undefined}
          title={`Drag to grow the ${side} (Shift: the ${OPPOSITE[side]} too)`}
          onPointerDown={onPointerDown(side)}
        />
      ))}
    </div>
  );
}
