import { LogicalPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { useRef, useState, type PointerEvent } from "react";
import { hint as hintFor } from "../markup/HintLine";
import type { ControlHint } from "../markup/hints";
import { useDoc } from "./docStore";
import { DRAG_THRESHOLD, dragGain } from "./numberDrag";
import { useTool } from "./toolStore";
import styles from "./EditorApp.module.css";

interface Props {
  /** Shown before it (X, W). */
  label: string;
  /** Its name for screen readers, if the label's too short to say (Width). */
  name?: string;
  value: number;
  /** A new value, typed or dragged to (`dragging`); returns the value as kept (the document
   * keeps it in range). */
  onChange: (value: number, dragging: boolean) => number;
  /** A drag of it ended. */
  onDragEnd?: () => void;
  /** Shown after it (px). */
  unit?: string;
  /** How it shows the value, and reads what's typed (null: not a value); else a whole number. */
  format?: (value: number) => string;
  parse?: (text: string) => number | null;
  /** What Shift multiplies a drag by, and what to call it in the tooltip (else ×10). */
  shift?: { by: number; label: string };
  /** Its width, in px (else 56). */
  width?: number;
  /** How fast a drag changes it, against the usual (0.5: half as fast). */
  gain?: number;
  /** Its hint in the status bar (PLAN 4.6b; else the plain number's). */
  hint?: ControlHint;
}

const readNumber = (text: string) => {
  const n = Number(text);
  return text.trim() !== "" && Number.isFinite(n) ? n : null;
};

/**
 * A number in the options bar, as Resolve's: a click types; press and drag left or right
 * changes it live (right raises it), faster the faster the mouse moves (Settings › Editing ›
 * Number drag speed), Shift ×10. While dragging, the cursor hides and is moved back to where the
 * drag began whenever it strays, so the mouse can keep going past the screen's edge. (Not the
 * pointer lock: WebView2 shows a "press Esc" notice over the page with it.) A drag is one undo
 * step.
 */
/** Px the hidden cursor may stray from where the drag began before it's moved back. */
const RETURN_AFTER = 200;

export function NumberField({
  label,
  name,
  value,
  onChange,
  onDragEnd,
  unit,
  format = String,
  parse = readNumber,
  shift = { by: 10, label: "10× faster" },
  width,
  gain = 1,
  hint = "number",
}: Props) {
  /** What's typed, until Enter or leaving the field sets it (Esc drops it). */
  const [typed, setTyped] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Esc: leaving the field doesn't set what was typed. */
  const dropTyped = useRef(false);

  const commit = () => {
    if (dropTyped.current) {
      dropTyped.current = false;
      setTyped(null);
      return;
    }
    const n = typed === null ? null : parse(typed);
    if (n !== null) onChange(Math.round(n), false);
    setTyped(null);
  };

  const onPointerDown = (e: PointerEvent<HTMLInputElement>) => {
    // Already typing: the press places the caret.
    if (e.button !== 0 || document.activeElement === e.currentTarget) return;
    e.preventDefault();
    const input = e.currentTarget;
    input.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    let lastX = x0;
    let moved = false;
    /** The cursor is being moved back: moves until it's there are its own, not the mouse's. */
    let returning = false;
    let lastT = performance.now();
    // Each step goes from the value as kept, so pushing past a limit costs nothing to come
    // back from; `carry` keeps the fraction a slow drag hasn't made a whole step of yet.
    let current = value;
    let carry = 0;

    const onMove = (m: globalThis.PointerEvent) => {
      if (!moved) {
        if (Math.abs(m.clientX - x0) < DRAG_THRESHOLD) return;
        moved = true;
        setDragging(true);
        document.documentElement.classList.add(styles.hideCursor);
        useDoc.getState().beginGesture();
      }
      if (returning) return;
      const dx = m.clientX - lastX;
      lastX = m.clientX;
      // Strayed far, or at the screen's edge (a field near it has less room than that).
      // (Chromium's `availLeft`: where this screen starts, on a second monitor.)
      const screen = window.screen as Screen & { availLeft?: number };
      const x = m.screenX - (screen.availLeft ?? 0);
      const atEdge = x <= 1 || x >= screen.width - 2;
      if (Math.abs(m.clientX - x0) > RETURN_AFTER || atEdge) {
        // Back to where the drag began, so the screen's edge never stops it (Resolve's).
        returning = true;
        void getCurrentWindow()
          .setCursorPosition(new LogicalPosition(x0, y0))
          .catch(() => {})
          .finally(() => {
            returning = false;
            lastX = x0;
          });
      }
      const now = performance.now();
      const speed = Math.abs(dx) / Math.max(1, now - lastT);
      lastT = now;
      const exact =
        current +
        carry +
        dx * gain * dragGain(speed, useTool.getState().dragSpeed) * (m.shiftKey ? shift.by : 1);
      const want = Math.round(exact);
      if (want === current) {
        carry = exact - current;
        return;
      }
      const kept = onChange(want, true);
      carry = kept === want ? exact - want : 0;
      current = kept;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (moved) {
        document.documentElement.classList.remove(styles.hideCursor);
        setDragging(false);
        useDoc.getState().endGesture();
        onDragEnd?.();
      } else {
        input.focus();
        input.select();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <label className={styles.field} {...hintFor(hint)}>
      {label}
      <input
        className={styles.numberField}
        data-dragging={dragging || undefined}
        inputMode="numeric"
        aria-label={name ?? label}
        title={`Drag left or right to change (Shift: ${shift.label}) · click to type`}
        style={width ? { width } : undefined}
        value={typed ?? format(value)}
        onPointerDown={onPointerDown}
        onChange={(e) => setTyped(e.target.value.replace(/[^\d:.-]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          // Its own keys: the editor's (arrows, Enter, Esc) wait.
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            dropTyped.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      {unit}
    </label>
  );
}
