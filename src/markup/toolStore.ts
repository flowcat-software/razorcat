// The active tool and what each tool remembers of its style (see styles.ts
// for how the current color and width are worked out).

import { create } from "zustand";
import { useTool } from "../editor/toolStore";
import type {
  AnnotationId,
  CalloutEnd,
  CalloutShape,
  ClickLook,
  KeysLook,
  ArrowEnds,
  ArrowHead,
  RedactMode,
  ShapeFill,
  SpotlightShape,
  StepFormat,
  StepShape,
  TextAlign,
} from "./model/types";

/** Tools built so far; the list grows one tool per increment. */
export const TOOLS = [
  "select",
  "pen",
  "highlighter",
  "line",
  "arrow",
  "rect",
  "ellipse",
  "text",
  "callout",
  "redact",
  "spotlight",
  "step",
  "click",
  "keys",
] as const;
export type ToolId = (typeof TOOLS)[number];

/** A palette: the shared one, or a tool's own. */
export type PaletteKey = ToolId | "shared";

export function isTool(value: string): value is ToolId {
  return (TOOLS as readonly string[]).includes(value);
}

/** The text object being typed into, if any. */
export interface TextEditing {
  id: AnnotationId;
  /** Created by this session: an empty result is dropped without an undo step. */
  isNew: boolean;
}

export interface ToolState {
  tool: ToolId;
  /** The current color of tools on the shared palette (`editor.shareColor`); null = first preset. */
  sharedColor: string | null;
  /** Each tool's own current color, when it isn't shared. */
  colors: Partial<Record<ToolId, string>>;
  /** Each tool's line width, once picked. */
  widths: Partial<Record<ToolId, number>>;
  /** Rectangle and ellipse: border, fill or both. */
  fills: Partial<Record<ToolId, ShapeFill>>;
  /** Rectangle and ellipse: the fill color for "both", once picked. */
  fillColors: Partial<Record<ToolId, string>>;
  /**
   * The last color from the custom picker, kept on the custom swatch: one for
   * the shared palette ("shared"), and one per tool with its own palette.
   */
  customColors: Partial<Record<PaletteKey, string>>;
  /** The same for the chip's second color (PLAN 3D.14): each keeps its own. */
  customSecondColors: Partial<Record<PaletteKey, string>>;
  /** Which color the swatches set when there are two (the chip's top or bottom). */
  colorSlot: "first" | "second";
  arrowHead: ArrowHead;
  arrowEnds: ArrowEnds;
  /** Text: font family and size in pt, once picked. */
  fontFamily: string | null;
  fontSize: number | null;
  textAlign: TextAlign;
  textBold: boolean;
  textItalic: boolean;
  /** Text: draw a box behind it, in this color (null: white until picked). */
  textBackground: boolean;
  textBackgroundColor: string | null;
  /** Redact: solid, pixelate or blur, and each mode's strength once picked. */
  redactMode: RedactMode;
  redactStrengths: Partial<Record<RedactMode, number>>;
  /** Redact selects detected text instead of drawing a box (PLAN 3J). Never remembered. */
  redactText: boolean;
  /** Rectangle and Spotlight: the corner radius once picked (PLAN 3D.17). */
  cornerRadii: Partial<Record<ToolId, number>>;
  /** Spotlight: its shape, and the darkness once picked (%). */
  spotlightShape: SpotlightShape;
  spotlightDim: number | null;
  /** Step markers: the style of the next one (size and label color once picked). */
  stepShape: StepShape;
  stepSize: number | null;
  /** Null: black or white, whichever reads better on the marker. */
  stepTextColor: string | null;
  /** Once picked. */
  stepFont: string | null;
  /** The labels of a document's first marker (after that, its markers say). */
  stepFormat: StepFormat;
  stepStart: number;
  /** Click marks (PLAN 5b.6b): the next one's look, and its size once picked. */
  clickLook: ClickLook;
  clickSize: number | null;
  /** Keys marks (PLAN 5b.6c): the next one's look, and its font size once picked. */
  keysLook: KeysLook;
  keysSize: number | null;
  /**
   * Callouts (PLAN 3E): their own font, size and text style once picked (else
   * the text tool's), and the text color (null: black or white, whichever
   * reads better on the box). The box color, thickness and corner radius are
   * in `colors`, `widths` and `cornerRadii`.
   */
  calloutFont: string | null;
  calloutFontSize: number | null;
  calloutBold: boolean;
  calloutItalic: boolean;
  calloutAlign: TextAlign;
  calloutTextColor: string | null;
  /** The pointer's end (PLAN 3E.2). */
  calloutEnd: CalloutEnd;
  /** A box behind the text, or a line under it (PLAN 3E.3). */
  calloutShape: CalloutShape;
  editing: TextEditing | null;
  /** The step marker whose label is being typed (PLAN 3D.12). */
  labelEditing: AnnotationId | null;
  setTool: (tool: ToolId) => void;
  setEditing: (editing: TextEditing | null) => void;
}

export const useToolStore = create<ToolState>((set) => ({
  tool: "select",
  sharedColor: null,
  colors: {},
  widths: {},
  fills: {},
  fillColors: {},
  customColors: {},
  customSecondColors: {},
  colorSlot: "first",
  arrowHead: "filled",
  arrowEnds: "end",
  fontFamily: null,
  fontSize: null,
  textAlign: "left",
  textBold: false,
  textItalic: false,
  textBackground: false,
  textBackgroundColor: null,
  // Razorcat: blur or pixelate only (PLAN 4.8; a filled rectangle covers solidly).
  redactMode: "blur",
  redactStrengths: {},
  redactText: false,
  cornerRadii: {},
  spotlightShape: "rect",
  spotlightDim: null,
  stepShape: "circle",
  stepSize: null,
  stepTextColor: null,
  stepFont: null,
  stepFormat: "numbers",
  stepStart: 1,
  clickLook: "ring",
  clickSize: null,
  keysLook: "caps",
  keysSize: null,
  calloutFont: null,
  calloutFontSize: null,
  calloutBold: false,
  calloutItalic: false,
  calloutAlign: "left",
  calloutTextColor: null,
  // A dot at the tip (Richard, 2026-10-24).
  calloutEnd: "dot",
  calloutShape: "box",
  editing: null,
  labelEditing: null,
  // The editor's tool (editor/toolStore.ts) is the one picked; this one follows it. Tools
  // Razorcat doesn't have yet are left alone.
  setTool: (tool) => {
    if (tool === "select" || tool === "text") useTool.getState().setTool(tool);
  },
  setEditing: (editing) => set({ editing }),
}));
