// The crop tool's actions and keys (the options bar's and the keyboard's; the box is
// CropOverlay.tsx). Crop changes the document as it goes: there's nothing to apply or cancel,
// and undo takes each change back.

import { useEffect } from "react";
import { isTyping } from "../shared/dom";
import { nudgeCrop } from "./cropGeometry";
import { useDoc } from "./docStore";
import { cropToRatio } from "./frame";
import { CROP_RATIOS, lockedRatio, useTool, type CropRatioId } from "./toolStore";

/** Hold the box to a ratio, refitting it now: the largest of that shape, where it was. */
export function pickCropRatio(id: CropRatioId): void {
  useTool.getState().setCropRatio(id);
  const ratio = CROP_RATIOS.find((r) => r.id === id)?.ratio;
  const doc = useDoc.getState();
  if (ratio) doc.crop(cropToRatio(doc.doc.frame.crop, doc.doc.frame.source, ratio));
}

/** Back to the whole picture, any shape. */
export function resetCrop(): void {
  useTool.getState().setCropRatio("free");
  const { source } = useDoc.getState().doc.frame;
  useDoc.getState().crop({ x: 0, y: 0, ...source });
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * The picture's tool keys: C picks crop up (or puts it down), V the select tool. While cropping,
 * arrows nudge the box (Shift 10 px) and Ctrl+arrows resize it from the bottom-right, as in
 * Vandal, one undo step for as long as the key is held; Enter or Esc put the tool down. The rest
 * (Space, J/K/L, undo) still work. `active`: a video is open.
 */
export function useCropKeys(active: boolean): void {
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
      if (isTyping(e.target) || e.altKey || e.metaKey) return;
      const { tool, setTool } = useTool.getState();
      if (!e.ctrlKey && !e.shiftKey && !e.repeat && (e.code === "KeyC" || e.code === "KeyV")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setTool(e.code === "KeyC" && tool !== "crop" ? "crop" : "select");
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
        return;
      }
      if (!e.ctrlKey && (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Escape")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setTool("select");
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
