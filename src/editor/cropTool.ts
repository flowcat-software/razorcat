// The crop and grow tools' actions, and the picture tools' keys (the options bar's and the
// keyboard's; the boxes are CropOverlay.tsx and GrowOverlay.tsx). They change the document as
// they go: there's nothing to apply or cancel, and undo takes each change back.

import { useEffect } from "react";
import { isPopoverOpen } from "../markup/usePopover";
import { isTyping } from "../shared/dom";
import { nudgeCrop } from "./cropGeometry";
import { useDoc } from "./docStore";
import { cropToRatio } from "./frame";
import { lockedRatio, useTool, type CropRatioId, type Tool } from "./toolStore";

/** Hold the box to a ratio, refitting it now: the largest of that shape, where it was. */
export function pickCropRatio(id: CropRatioId): void {
  useTool.getState().setCropRatio(id);
  refit();
}

/** Turn the ratios between landscape and portrait, refitting a held one. */
export function toggleCropPortrait(): void {
  const t = useTool.getState();
  t.setPortrait(!t.portrait);
  refit();
}

/** The box refitted to the held ratio, if there is one. */
function refit(): void {
  const ratio = lockedRatio();
  const doc = useDoc.getState();
  if (ratio) doc.crop(cropToRatio(doc.doc.frame.crop, doc.doc.frame.source, ratio));
}

/** Back to the whole picture, any shape. */
export function resetCrop(): void {
  useTool.getState().setCropRatio("free");
  const { source } = useDoc.getState().doc.frame;
  useDoc.getState().crop({ x: 0, y: 0, ...source });
}

/** No grow: back to the picture alone (its colours kept for next time). */
export function resetGrow(): void {
  const doc = useDoc.getState();
  const g = doc.doc.frame.grow;
  doc.grow({ ...g, top: 0, bottom: 0, left: 0, right: 0 });
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** The picture's tools by key. */
const TOOL_KEYS: Record<string, Tool> = { KeyV: "select", KeyC: "crop", KeyG: "grow" };

/**
 * The picture's tool keys: C picks crop up (or puts it down), G grow, V the select tool. While
 * cropping, arrows nudge the box (Shift 10 px) and Ctrl+arrows resize it from the bottom-right,
 * as in Vandal, one undo step for as long as the key is held. Enter or Esc put a tool down. The
 * rest (Space, J/K/L, undo) still work. `active`: a video is open.
 */
export function useToolKeys(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    /** The arrow being held, nudging as one undo step. */
    let held: string | null = null;
    const release = () => {
      if (held === null) return;
      held = null;
      useDoc.getState().endGesture();
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || isPopoverOpen() || e.altKey || e.metaKey) return;
      const { tool, setTool } = useTool.getState();
      const picked = TOOL_KEYS[e.code];
      if (picked && !e.ctrlKey && !e.shiftKey && !e.repeat) {
        e.preventDefault();
        e.stopImmediatePropagation();
        // The tool's own key again puts it down.
        setTool(picked === tool ? "select" : picked);
        return;
      }
      if (tool === "select") return;
      if (!e.ctrlKey && (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Escape")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setTool("select");
        return;
      }
      if (tool !== "crop") return;
      const arrow = ARROWS[e.code];
      if (arrow) {
        // Ahead of the transport's (stepping frames).
        e.preventDefault();
        e.stopImmediatePropagation();
        const doc = useDoc.getState();
        if (held !== e.code) {
          release();
          held = e.code;
          doc.beginGesture();
        }
        const step = e.shiftKey ? 10 : 1;
        const { crop, source } = doc.doc.frame;
        doc.crop(
          nudgeCrop(crop, arrow[0] * step, arrow[1] * step, source, e.ctrlKey, lockedRatio()),
        );
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === held) release();
    };
    // Capture: ahead of the editor's own keys.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", release);
    return () => {
      release();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", release);
    };
  }, [active]);
}
