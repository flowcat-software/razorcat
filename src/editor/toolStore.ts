// The picture's tool (the command bar's), and its options that aren't part of the edit: not
// undone, and kept while the tool is put down.

import { create } from "zustand";
import { docStore as markupDoc } from "../markup/model/store";
import { useToolStore as useMarkupTools } from "../markup/toolStore";
import type { DragSpeed } from "../shared/ipc";

/** The picture's tools that work so far. */
export type Tool =
  | "select"
  | "crop"
  | "grow"
  | "pen"
  | "text"
  | "arrow"
  | "line"
  | "rect"
  | "ellipse"
  | "step"
  | "click"
  | "keys"
  | "callout"
  | "highlighter"
  | "redact"
  | "spotlight";

/** A markup tool, as Vandal's markup code names it. */
type MarkupTool =
  | "text"
  | "arrow"
  | "line"
  | "rect"
  | "ellipse"
  | "step"
  | "click"
  | "keys"
  | "callout"
  | "highlighter"
  | "pen"
  | "redact"
  | "spotlight";

/** The tools that are Vandal's markup tools (the markup layer runs them). */
export const MARKUP_TOOLS: readonly Tool[] = [
  "text",
  "arrow",
  "line",
  "rect",
  "ellipse",
  "step",
  "click",
  "keys",
  "callout",
  "highlighter",
  "pen",
  "redact",
  "spotlight",
] satisfies MarkupTool[];
const isMarkupTool = (tool: Tool): tool is MarkupTool => MARKUP_TOOLS.includes(tool);

/**
 * The crop's aspect ratios, landscape, as width / height; "free" holds none. Portrait turns
 * them (16:9 to 9:16, 5:4 to 4:5), as Vandal's do.
 */
export const CROP_RATIOS = [
  { id: "free", label: "Free", ratio: undefined },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "5:4", label: "5:4", ratio: 5 / 4 },
] as const;

/** A ratio's label, turned for portrait (the square and Free stay as they are). */
export const ratioLabel = (r: (typeof CROP_RATIOS)[number], portrait: boolean) =>
  portrait && r.ratio && r.ratio !== 1 ? r.label.split(":").reverse().join(":") : r.label;

export type CropRatioId = (typeof CROP_RATIOS)[number]["id"];

export interface HeldView {
  scale: number;
  x: number;
  y: number;
}

interface ToolState {
  tool: Tool;
  /** The crop box keeps this shape (picked in the options bar). */
  cropRatio: CropRatioId;
  /** The ratios turned taller than wide (9:16); a portrait video starts this way. */
  portrait: boolean;
  /** Settings › Editing › Number drag speed. */
  dragSpeed: DragSpeed;
  /**
   * A grow handle is being dragged: the preview keeps its scale (CSS px per source px) and the
   * picture where it is (its top-left in the preview), so the handle stays under the pointer as
   * the frame grows round it.
   */
  held: HeldView | null;
  setTool: (tool: Tool) => void;
  setCropRatio: (id: CropRatioId) => void;
  setPortrait: (portrait: boolean) => void;
  setDragSpeed: (speed: DragSpeed) => void;
  holdView: (view: HeldView | null) => void;
}

export const useTool = create<ToolState>()((set) => ({
  tool: "select",
  cropRatio: "free",
  portrait: false,
  dragSpeed: "normal",
  held: null,
  // The markup's tool follows: the select tool, or the markup tool picked (which drops the
  // selection, so the options show that tool, as in Vandal).
  setTool: (tool) => {
    const markup = isMarkupTool(tool) ? tool : "select";
    if (markup !== "select") markupDoc.getState().select([]);
    useMarkupTools.setState({ tool: markup, colorSlot: "first" });
    set({ tool });
  },
  setCropRatio: (cropRatio) => set({ cropRatio }),
  setPortrait: (portrait) => set({ portrait }),
  setDragSpeed: (dragSpeed) => set({ dragSpeed }),
  holdView: (held) => set({ held }),
}));

/** Width / height the crop box is held to, if any (turned for portrait). */
export function lockedRatio(): number | undefined {
  const { cropRatio, portrait } = useTool.getState();
  const r = CROP_RATIOS.find((c) => c.id === cropRatio)?.ratio;
  return r && portrait ? 1 / r : r;
}
