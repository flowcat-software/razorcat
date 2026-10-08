// The picture's tool (the command bar's), and its options that aren't part of the edit: not
// undone, and kept while the tool is put down.

import { create } from "zustand";
import type { DragSpeed } from "../shared/ipc";

/** The picture's tools that work so far (grow, text and arrow come in Phases 3.4 and 4). */
export type Tool = "select" | "crop";

/** The crop's aspect ratios (the mockup's), as width / height; "free" holds none. */
export const CROP_RATIOS = [
  { id: "free", label: "Free", ratio: undefined },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:5", label: "4:5", ratio: 4 / 5 },
] as const;

export type CropRatioId = (typeof CROP_RATIOS)[number]["id"];

interface ToolState {
  tool: Tool;
  /** The crop box keeps this shape (picked in the options bar). */
  cropRatio: CropRatioId;
  /** Settings › Editing › Number drag speed. */
  dragSpeed: DragSpeed;
  setTool: (tool: Tool) => void;
  setCropRatio: (id: CropRatioId) => void;
  setDragSpeed: (speed: DragSpeed) => void;
}

export const useTool = create<ToolState>()((set) => ({
  tool: "select",
  cropRatio: "free",
  dragSpeed: "normal",
  setTool: (tool) => set({ tool }),
  setCropRatio: (cropRatio) => set({ cropRatio }),
  setDragSpeed: (dragSpeed) => set({ dragSpeed }),
}));

/** Width / height the crop box is held to, if any. */
export const lockedRatio = (): number | undefined =>
  CROP_RATIOS.find((r) => r.id === useTool.getState().cropRatio)?.ratio;
