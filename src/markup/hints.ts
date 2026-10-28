// The hint line in the status bar (Vandal's, PLAN 4.6b): one line saying which keys
// and modifiers do something right now. Most specific first: why a key just did
// nothing, for a moment (`sayWhy`); the control under the pointer, or the
// timeline's handle; the modifiers of a drag in progress; then the active tool
// (or typing), what's selected, and, with nothing, the general shortcuts.
//
// Every hint is written here, in one table. Keys go in brackets: "[Ctrl+1…9]"
// shows as key caps; " · " separates the parts. Put the most useful part
// first, since a narrow window cuts the end off. The customizable shortcuts
// (PLAN 3F) go in braces, filled in by `withShortcuts`: "{pen}" is Pen's key
// (or nothing, if it has none), "{swapColors?}" drops its part when there's
// no key, and "{tools}" lists every tool's.

import { create } from "zustand";
import type { ShortcutId, ShortcutKeys } from "./shortcuts";
import { TOOLS, type ToolId } from "./toolStore";

/** Hints for controls, by the id in their `data-hint` attribute. */
export const CONTROL_HINTS = {
  "tool.select": "{select} Select and move markup · [Esc] steps back to Select",
  "tool.pen": "{pen} Draw freehand · [Shift] straight line",
  "tool.highlighter": "{highlighter} Highlight freehand · [Shift] straight line",
  "tool.line": "{line} Draw a line · [Shift] 45° steps",
  "tool.arrow": "{arrow} Draw an arrow · [Shift] 45° steps",
  "tool.rect": "{rect} Draw a rectangle · [Shift] square",
  "tool.ellipse": "{ellipse} Draw an ellipse · [Shift] circle",
  "tool.text": "{text} Click to type, or drag to set a width",
  "tool.redact": "{redact} Blur or pixelate an area · always under the other markup",
  "tool.spotlight": "{spotlight} Darken everything outside a box or ellipse",
  "tool.step": "{step} Click to place numbered or lettered markers · they count up",
  "tool.click":
    "{click} Click to mark where something was clicked · a recording's clicks come as these",
  "tool.callout": "{callout} Drag from what to point at to where the text goes, or click",
  "tool.crop": "{crop} Crop the picture, the same for the whole video · [Enter] done",
  "tool.grow": "[G] Grow the frame: space round the picture, in a colour · [Enter] done",
  undo: "[Ctrl+Z] Undo",
  redo: "[Ctrl+Y] or [Ctrl+Shift+Z] Redo",
  swatch: "[Ctrl+1…9] Pick a color by number · Right-click to change or delete it",
  "swatch.fill":
    "[Shift]+click sets the border · [Ctrl+1…9] fill color · [Ctrl+Shift+1…9] border color · Right-click to change or delete",
  "swatch.box":
    "[Shift]+click sets the background · [Ctrl+1…9] text color · [Ctrl+Shift+1…9] background color · Right-click to change or delete",
  "chip.fill":
    "Choose which color the swatches set · {swapColors?} swaps them · [Shift]+click a swatch sets the border",
  "chip.box":
    "Choose which color the swatches set · {swapColors?} swaps them · [Shift]+click a swatch sets the background",
  "swatch.label":
    "[Shift]+click sets the marker · [Ctrl+1…9] label color · [Ctrl+Shift+1…9] marker color · Right-click to change or delete",
  "chip.label":
    "Choose which color the swatches set · {swapColors?} swaps them · [Shift]+click a swatch sets the marker",
  "swatch.callout":
    "[Shift]+click sets the callout · [Ctrl+1…9] text color · [Ctrl+Shift+1…9] callout color · Right-click to change or delete",
  "chip.callout":
    "Choose which color the swatches set · {swapColors?} swaps them · [Shift]+click a swatch sets the callout",
  "chip.swap": "{swapColors} Swap the two colors",
  colorMenu:
    "[Ctrl+1…9] Pick a color by number · Click for the palette · Right-click to edit the color in use",
  "colorMenu.second":
    "[Ctrl+Shift+1…9] Pick this color by number · Click for the palette · Right-click to edit the color in use",
  customColor:
    "Your custom color · Click it again, or right-click, to change it · [Esc] in the picker puts the old one back",
  width: "[1…0] Pick a width by number · [`] the thinnest",
  "redact.mode":
    "Blur or pixelate what's under the box · for passwords and other secrets, cover them with a filled rectangle: pixelate and blur can sometimes be undone",
  strength: "[1…0] Pick a strength by number · [`] the weakest",
  "redact.text":
    "Find the text in the image, then click or drag across words to redact them · Words found are outlined · Text missed? Drag from empty space for a box",
  "spotlight.shape": "The bright area's shape",
  corner: "[Alt+1…0] Round the corners · [Alt+`] the least round",
  "corner.callout": "Round the box's corners · 0 is square",
  "callout.size": "[1…0] Pick a text size by number · [`] the smallest",
  "callout.width": "[Shift+1…0] Pick the pointer's thickness by number · [Shift+`] the thinnest",
  "callout.end": "The end of the pointer: plain, an arrow or a dot",
  "callout.shape":
    "A box around the text, filled or outlined, or a line under it (over it when the pointer points up)",
  dim: "[1…0] How dark outside · [`] the lightest · shared by every spotlight",
  "step.shape": "The marker's shape",
  "click.look": "How the click mark looks · the moving one, Ripple, spreads as it plays",
  "click.button":
    "[Alt+1…3] The button clicked: left, middle or right, each in its color from Settings › Recording",
  "click.double": "A double-click: a second ring round it",
  "click.doublesOff":
    "Double-clicks are off in Settings › Recording · turn on “Show double-clicks” there, or off “Lock click styles in the editor”",
  "click.syncStyles": "Give every click the style and size shown here · [Ctrl+Z] undoes it",
  "click.setRecordingStyle":
    "Make the selected click's style, size, length and fades Settings › Recording's, for new recordings",
  "click.locked":
    "Locked to Settings › Recording, so placed clicks match recorded ones · turn off “Lock click styles in the editor” there to choose here",
  "step.format": "Numbers or letters · shared by every marker",
  "step.start": "The first marker's label · the others count up from it",
  "step.resetStyles": "Give every marker the style shown here · [Ctrl+Z] undoes it",
  "step.resetNumbering":
    "Drop the labels you typed, so every marker counts up again · [Ctrl+Z] undoes it",
  size: "[1…0] Pick a size by number · [`] the smallest",
  font: "[Alt+1…0] Pick a font by number · [Alt+`] the first · [Alt+↑↓] the previous or next · Type to filter the list",
  fill: "Border only, filled, or border and fill",
  bold: "[Ctrl+B] Bold, also while typing",
  italic: "[Ctrl+I] Italic, also while typing",
  box: "A background box behind the text · [Ctrl+Shift+1…9] background color",
  align: "Align the lines of the text",
  head: "The shape of the arrow heads",
  "ends.one": "Click again to flip the arrow",
  "ends.both": "Heads on both ends",
  // Razorcat's own controls (PLAN 4.6b).
  open: "[Ctrl+O] Open a video in place of the timeline · or drop one on the window",
  file: "[Ctrl+O] Open a video · [Ctrl+Shift+O] add one to the end of the timeline",
  record:
    "Record the screen this window is on · Razorcat steps aside, and the recording opens when you stop",
  recordStop: "Stop recording: the recording opens",
  export: "[Ctrl+E] Export the timeline as MP4",
  exportMenu:
    "Export a GIF, each clip on its own, or the selected clips · and the export's settings",
  settings: "[Ctrl+,] Open Settings",
  number: "Drag left or right to change it · [Shift] faster · Click to type · [Esc] puts it back",
  time: "Drag left or right to change it · [Shift] faster · Click to type a time or a frame number",
  "time.clipsFade":
    "Drag left or right to change the selected clips' fades together · [Shift] all as long · Click to type one length for them all",
  source:
    "The selected clips' files, or with nothing selected the project's · the first file sets the size and rate, and the others are fitted and timed to it",
  "crop.ratio": "Keep the crop to this shape · [Shift] while dragging keeps the shape it has",
  "crop.portrait": "Taller than wide: 9:16 instead of 16:9",
  "crop.reset": "Back to the whole picture · [Ctrl+Z] undoes it",
  "clip.speed":
    "The clip's speed, 10% to 1000% · drag or type · [Enter] keeps it, [Esc] puts it back",
  "clip.duration":
    "How long the clip lasts, by changing its speed: all of its video kept · [Enter] keeps it, [Esc] puts it back",
  "clip.cameraShown":
    "Show the camera from the playhead on, a keyframe there · off, it's left out till a keyframe shows it",
  "clip.cameraSize":
    "The camera's size from the playhead on, a keyframe there · the corner it's nearest stays put · Settings › Recording sets it for new recordings",
  "key.at": "Where the keyframe is · drag or type to move it · the first one stays at the start",
  "key.shown": "Show the camera from these keyframes on · off, it's left out till one shows it",
  "key.size": "The camera's size from these keyframes on · the corner it's nearest stays put",
  "clip.fadeColour":
    "The colour the clip fades from or to · black or white also from the fade handle's right-click",
  "grow.colour": "The colour of the space grown · one for every side, once they meet",
  "grow.reset": "Back to the picture alone · [Ctrl+Z] undoes it",
  "grow.presets": "Grows kept for one click · keep the one shown, or set them up in Settings",
  readout: "The playhead and the timeline's length · Click: timecode or frame numbers",
  start: "[Home] To the start",
  volume:
    "How loud the preview plays · click the speaker to mute · drag or scroll to change · the export isn't changed",
  end: "[End] To the end",
  prevEdit: "[↑] To the cut, range or markup edge before the playhead",
  nextEdit: "[↓] To the cut, range or markup edge after the playhead",
  back: "[←] Back a frame · [Shift+←] a second · held, it keeps going",
  forward: "[→] Forward a frame · [Shift+→] a second · held, it keeps going",
  play: "[Space] Play or pause · [J] [K] [L] back, stop, forward: again for faster",
  split: "[S] Split the clip at the playhead · the markup over it splits too (Settings)",
  range: "[R] A range of two seconds at the playhead · [I] and [O] mark its in and out",
  delete: "[Del] Delete what's selected · the clips after it close up · [Ctrl+Z] undo",
  duplicateClip:
    "[Ctrl+D] Copies straight after · [Ctrl+C] and [Ctrl+V] copy, and paste at the cut nearest the playhead",
  exportClip: "Export the selected clip, or the selected clips as one file or a file each",
  keepRanges: "Keep only the ranges, cutting out everything else · [Ctrl+Z] undoes it",
  removeRanges: "Cut the ranges out · [Ctrl+Z] undoes it",
  snap: "Snapping to cuts, edges and the playhead · [Shift] while dragging turns it off for a moment",
  zoom: "[Ctrl]+wheel Zoom at the pointer · [Ctrl+=] [Ctrl+−] Zoom in and out · [Ctrl+0] Fit",
  resizer: "Drag to make the timeline taller, for more markup lanes · Double-click puts it back",
  timelineScroll:
    "Drag to scroll along the timeline · Click to jump there · [Home] [End] go to its ends",
  // The timeline's handles (Timeline.tsx's hit kinds).
  "timeline.in":
    "Drag to trim the clip's start · the rest ripples along · [Shift] no snapping · Right-click for more",
  "timeline.out":
    "Drag to trim the clip's end · the rest ripples along · [Shift] no snapping · Right-click for more",
  "timeline.move":
    "Drag to move the clip between the others · [Ctrl] or [Shift]+click select more · [Ctrl+[] [Ctrl+]] a place earlier or later · Right-click for more",
  "timeline.rangeA": "Drag the range's start · [Shift] no snapping",
  "timeline.rangeB": "Drag the range's end · [Shift] no snapping",
  "timeline.rangeMove":
    "Drag to move the range · [Shift] no snapping · Right-click to keep or cut ranges",
  "timeline.rangeNew": "Drag to draw a range · or [R], or [I] and [O] at the playhead",
  "timeline.pendingIn": "Drag the in-point · [O] sets the out at the playhead · [Esc] drops it",
  "timeline.markStart": "Drag when it starts · the others selected follow · [Shift] no snapping",
  "timeline.markEnd": "Drag when it ends · the others selected follow · [Shift] no snapping",
  "timeline.markMove":
    "Drag to move it in time, or up or down to another lane · [Alt]+drag a copy · [Ctrl] or [Shift]+click select more · Right-click for fades and order",
  "timeline.fadeIn":
    "Drag right to fade in for longer · several selected fade together, [Shift] all as long",
  "timeline.fadeOut":
    "Drag left to fade out for longer · several selected fade together, [Shift] all as long",
  "timeline.clipFadeIn":
    "Drag right to fade the clip in for longer · several selected fade together, [Shift] all as long · Right-click for the default fade, or from black or white",
  "timeline.clipFadeOut":
    "Drag left to fade the clip out for longer · several selected fade together, [Shift] all as long · Right-click for the default fade, or to black or white",
  "timeline.crossfade":
    "Drag left to crossfade: this clip blends in over the end of the one before, the timeline that much shorter · Right-click to add or remove one",
  "timeline.speaker": "[Shift+M] Mute or unmute all the sound · [M] the selected clips",
  "timeline.key":
    "A camera keyframe: the camera's place, size and shown from here · Drag to move it · [Ctrl] or [Shift]+click select more · Double-click: the playhead there · Right-click: show, hide, size · [Delete] removes it",
  "timeline.firstKey":
    "The first camera keyframe: it sets the camera from the start, so it stays put · Right-click: show, hide, size · Double-click: the playhead there",
  "timeline.keys":
    "Drag to select camera keyframes · [Ctrl] or [Shift] keeps the selection · Move or size the camera in the preview to add one at the playhead",
  "timeline.lanes":
    "Drag to select markup, or clips from their row · [Ctrl] or [Shift] keeps the selection · Right-click to clean up the lanes",
  "timeline.ruler":
    "Click or drag to move the playhead · [Shift] no snapping · [Ctrl]+wheel zoom · wheel scrolls",
} as const;

export type ControlHint = keyof typeof CONTROL_HINTS;

/** What a drag in progress is doing, for its modifier hints. */
export type DragHint =
  | "segment"
  | "bend"
  | "square"
  | "circle"
  | "stroke"
  | "text"
  | "callout"
  | "move"
  | "calloutMove"
  | "resize"
  | "rotate"
  | "redactText"
  // The timeline's (PLAN 4.6b).
  | "trim"
  | "clipMove"
  | "markMove"
  | "markCopy"
  | "markEdge"
  | "fade"
  | "crossfade"
  | "range"
  | "scrub"
  | "box"
  | "keyMove";

const DRAG_HINTS: Record<DragHint, string> = {
  segment: "[Shift] 45° steps",
  bend: "[Shift] symmetric arc · Near the straight line it snaps straight · Double-click the handle to straighten",
  square: "[Shift] square",
  circle: "[Shift] circle",
  stroke: "[Shift] straight line",
  text: "Release to type in a box this wide",
  move: "[Shift] straight across or up and down",
  calloutMove: "[Shift] keeps the pointer at 45° steps · Drag the pointer line to move it all",
  callout: "Release where the text goes · the pointer points where you pressed · [Shift] 45° steps",
  resize: "[Shift] keep proportions",
  rotate: "Snaps to 45° steps near them",
  redactText: "Release to redact the selected text · [Esc] cancel",
  trim: "[Shift] no snapping · the clips after it ripple along",
  clipMove: "Let go between two clips to move it there",
  markMove:
    "[Shift] no snapping · Up or down: another lane · Let go on a busy lane for a new one, above or below by the pointer",
  markCopy:
    "Let go to place the copy · [Shift] no snapping · Over something on its lane, a new lane, above or below by the pointer",
  markEdge: "[Shift] no snapping · The others selected change by as much, each as far as it can",
  fade: "[Shift] all the same length (several selected) · press and let go of it while dragging",
  crossfade:
    "Left: a longer crossfade, the clips after it moving along · Right: shorter, all the way for none",
  range: "[Shift] no snapping · Ranges stop against each other",
  scrub: "[Shift] no snapping",
  box: "Touching the clip row, it selects clips; else the camera keyframes, touching their lane; else markup · [Ctrl] or [Shift] keeps what was selected",
  keyMove:
    "[Shift] no snapping · Let go on another keyframe to replace it · Never before the first keyframe",
};

/** Redact with its Detect text toggle on and words found (PLAN 3J). */
const REDACT_TEXT =
  "Drag across text to redact it · Click a word · Triple-click a line · Drag from empty space for a box";

/** Over a word that's already redacted (PLAN 3J.5). */
const UNREDACT =
  "Click to unredact: the whole redaction outlined goes · [Ctrl] select it instead · [Ctrl+Z] undo";

/** The color keys, naming both colors only when there are two. */
function colorKeys(tool: ToolId, twoColors: boolean): string {
  if (tool === "step") return "[Ctrl+1…9] label color · [Ctrl+Shift+1…9] marker color";
  if (tool === "callout") return "[Ctrl+1…9] text color · [Ctrl+Shift+1…9] callout color";
  if (tool === "text") {
    return twoColors
      ? "[Ctrl+1…9] text color · [Ctrl+Shift+1…9] background color"
      : "[Ctrl+1…9] text color";
  }
  return twoColors ? "[Ctrl+1…9] fill color · [Ctrl+Shift+1…9] border color" : "[Ctrl+1…9] color";
}

function toolHint(tool: Exclude<ToolId, "select">, twoColors: boolean): string {
  const colors = colorKeys(tool, twoColors);
  switch (tool) {
    case "pen":
    case "highlighter":
      return `[Shift] straight line · [1…0] width · ${colors}`;
    case "line":
    case "arrow":
      return `[Shift] 45° steps · [1…0] width · ${colors}`;
    case "rect":
      return `[Shift] square · [1…0] width · [Alt+1…0] corners · ${colors}`;
    case "ellipse":
      return `[Shift] circle · [1…0] width · ${colors}`;
    case "text":
      return `Click to type, drag to set a width · [1…0] size · [Alt+1…0] font · ${colors}`;
    case "redact":
      return "Drag over what to hide · [1…0] strength";
    case "spotlight":
      return "Drag the area to keep bright · [Shift] square or circle · [1…0] darkness · [Alt+1…0] corners";
    case "step":
      return `Click to place the next marker · [1…0] size · [Alt+1…0] font · ${colors}`;
    case "click":
      return `Click to mark a click there · [Alt+1…3] left, middle, right · [1…0] size`;
    case "callout":
      return `Drag from what to point at to where the text goes · [1…0] size · [Shift+1…0] thickness · [Alt+1…0] font · ${colors}`;
  }
}

const SELECTED =
  "[Del] delete · [Ctrl+D] duplicate · [←↑↓→] nudge, [Shift] 10 px · [Ctrl+[] [Ctrl+]] order · [Shift]+click select multiple";
const TEXT_SELECTED = `[Enter] edit the text · ${SELECTED}`;
const STEP_SELECTED = `[Enter] or double-click to type its own label · ${SELECTED}`;
const CALLOUT_SELECTED = `Drag the text to move it, the pointer line to move it all · Drag the ● handle to point it · [Shift]+drag 45° steps · [Enter] edit the text · ${SELECTED}`;
const LABEL_TYPING = "[Enter] done · [Esc] cancel · Leave it empty to count up again";
const SEGMENT_SELECTED = `Drag the ◆ handle to bend it, double-click it to straighten · ${SELECTED}`;
const TYPING =
  "[Esc] done · [Ctrl+B] bold · [Ctrl+I] italic · [Alt+1…0] font · [Alt+↑↓] previous or next font";
// Razorcat's (PLAN 4.6b): its modes, the timeline's selection, and the keys with nothing
// selected.
const CROP =
  "Drag the edges or corners · [Shift] keeps the shape · [←↑↓→] nudge, [Shift] 10 px, [Ctrl] resizes · [Enter] done · [Ctrl+Z] undoes";
const GROW =
  "Drag a side to grow it · [Shift] the opposite side too · Type sizes above · [Enter] done";

/** No video yet: only what gets one. */
const EMPTY = "[Ctrl+O] open a video · or drop video files here · [Ctrl+,] settings";

const IDLE =
  "{tools} tools · [Space] play · [J] [K] [L] shuttle · [←→] a frame · [S] split · [R] range · [Ctrl+Z] undo · [Ctrl+E] export";

const CLIP_SELECTED =
  "[Del] delete · [Ctrl+D] duplicate · [Ctrl+C] copy · [Ctrl+[] [Ctrl+]] a place earlier or later, [Shift] to the start or end · [M] mute · [Esc] deselect";
const CLIPS_SELECTED =
  "Drag one to move them all · [Del] delete · [Ctrl+D] duplicate · [Ctrl+C] copy · [Ctrl+[] [Ctrl+]] move · [M] mute · [Ctrl] or [Shift]+click adds or takes one out";
const RANGE_SELECTED =
  "[Del] delete · Drag it or its edges · Right-click to keep the ranges or cut them out · [Esc] deselect";
const PENDING_IN = "[O] sets the out at the playhead · [Esc] drops the in-point";
const MARKS_SELECTED =
  "[Del] delete · [Ctrl+D] duplicate · [Ctrl+C] copy · [Ctrl+[] [Ctrl+]] a lane back or forward · [Ctrl+Shift+V] [Ctrl+Shift+F] [Ctrl+Shift+T] paste style, fades, timing · [Ctrl+A] again: all of it";

/**
 * Why a key did nothing (Richard, 2026-10-08), said for a moment (`sayWhy`). Keys go in
 * brackets, as above.
 */
export const WHY = {
  "split.cut": "Nothing to split: the playhead is on a cut",
  "split.start": "Nothing to split at the very start",
  "split.crossfade":
    "Nothing splits in a crossfade: move the playhead out of it, or remove it first",
  "range.on":
    "No new range: the playhead is on one already · drag its edges, or move the playhead off it",
  "out.early": "No range: the playhead is before the in-point · move it later, or [I] again",
  "delete.none": "Nothing selected to delete",
  "delete.last": "The timeline keeps at least one clip",
  "mute.none": "Select a clip to mute it · [Shift+M] mutes all the sound",
  "mute.silent": "There's no sound to mute",
  "duplicate.none": "Select a clip or markup to duplicate it",
  "copy.none": "Select clips or markup to copy them",
  "paste.none": "Nothing copied yet · [Ctrl+C] copies the selected clips or markup",
  "pasteOnto.none":
    "Copy markup first ([Ctrl+C]), then select the markup to paste its style, fades or timing onto · fades: a clip's too, onto clips",
  "order.none": "Select a clip or markup to move it",
  "speed.none": "Select a clip to change its speed",
  "order.end": "It's as far as it goes",
  "export.none": "Open a video first",
} as const;

export type WhyHint = keyof typeof WHY;

export interface HintState {
  /** Why a key did nothing, for a moment. */
  said: WhyHint | null;
  hover: ControlHint | null;
  drag: DragHint | null;
  /** A host mode instead of a tool (the editor's crop, or no image yet). */
  mode: HostMode | null;
  tool: ToolId;
  selected: number;
  /** The one selected object is text. */
  textSelected: boolean;
  /** The one selected object is a line or an arrow (it can bend). */
  segmentSelected: boolean;
  /** The one selected object is a step marker. */
  stepSelected: boolean;
  /** The one selected object is a callout. */
  calloutSelected: boolean;
  /** A step marker's label is being typed. */
  labelTyping: boolean;
  typing: boolean;
  /** The pointer is over an object on the canvas. */
  overObject: boolean;
  /** What's being styled has a second color: border and fill, or text on a box. */
  twoColors: boolean;
  /** `editor.drawingToolsSelect`. */
  drawingToolsSelect: boolean;
  /** Redact selects text (its Detect text toggle is on and words were found). */
  redactText: boolean;
  /** The pointer is over a word that's already redacted. */
  overRedactedWord: boolean;
  /** On the timeline (Razorcat): what's selected there, and an in-point waiting for its out. */
  timeline: { clips: number; range: boolean; marks: number; pendingIn: boolean };
}

/** The hint to show, in the table's bracket format. */
export function chooseHint(s: HintState): string {
  if (s.said) return WHY[s.said];
  if (s.hover) return CONTROL_HINTS[s.hover];
  if (s.drag) return DRAG_HINTS[s.drag];
  if (s.mode === "crop") return CROP;
  if (s.mode === "grow") return GROW;
  if (s.mode === "empty") return EMPTY;
  if (s.typing)
    return `${TYPING} · ${colorKeys(s.tool === "callout" || s.calloutSelected ? "callout" : "text", s.twoColors)}`;
  if (s.labelTyping) return LABEL_TYPING;
  // With Select or the step tool (which selects what it places).
  if (s.selected === 1 && s.stepSelected && (s.tool === "select" || s.tool === "step"))
    return STEP_SELECTED;
  // With Select or the callout tool (which selects what it makes).
  if (s.selected === 1 && s.calloutSelected && (s.tool === "select" || s.tool === "callout"))
    return CALLOUT_SELECTED;
  if (s.tool === "select") {
    if (s.selected === 1 && s.textSelected) return TEXT_SELECTED;
    if (s.selected === 1 && s.segmentSelected) return SEGMENT_SELECTED;
    if (s.selected) return SELECTED;
    const t = s.timeline;
    if (t.pendingIn) return PENDING_IN;
    if (t.marks) return MARKS_SELECTED;
    if (t.range) return RANGE_SELECTED;
    if (t.clips > 1) return CLIPS_SELECTED;
    if (t.clips) return CLIP_SELECTED;
    return IDLE;
  }
  if (s.tool === "redact" && s.redactText && s.overRedactedWord) return UNREDACT;
  const tool = s.tool === "redact" && s.redactText ? REDACT_TEXT : toolHint(s.tool, s.twoColors);
  if (s.tool === "pen" || s.tool === "highlighter") return tool;
  // Over an object, say what a press does and how to get the other behavior.
  if (s.overObject) {
    return s.drawingToolsSelect
      ? `Press to select or move it · [Ctrl] draw over it · ${tool}`
      : `[Ctrl] select or move it · ${tool}`;
  }
  return tool;
}

/** Fill in the customizable shortcuts' keys (see the top of this file). */
export function withShortcuts(hint: string, keys: ShortcutKeys): string {
  return hint
    .split(" · ")
    .flatMap((part) => {
      let dropped = false;
      const filled = part.replace(/\{(\w+)(\?)?\} ?/g, (_, id: string, optional?: string) => {
        if (id === "tools") {
          const all = TOOLS.map((t) => keys[t]).filter(Boolean);
          return all.map((k) => `[${k}] `).join("");
        }
        const key = keys[id as ShortcutId];
        if (key) return `[${key}] `;
        if (optional) dropped = true;
        return "";
      });
      return dropped || !filled.trim() ? [] : [filled.trimEnd()];
    })
    .join(" · ");
}

/** A hint split into text and key caps (each cap one key, e.g. ["Ctrl", "1…9"]). */
export type HintPart = { text: string } | { keys: string[] };

export function parseHint(hint: string): HintPart[] {
  const parts: HintPart[] = [];
  let text = "";
  let i = 0;
  while (i < hint.length) {
    if (hint[i] !== "[") {
      text += hint[i++];
      continue;
    }
    // A "]" closes the caps unless it is itself a key: "[Ctrl+]]".
    let end = i + 1;
    while (end < hint.length && !(hint[end] === "]" && end > i + 1 && hint[end - 1] !== "+")) end++;
    if (end >= hint.length) {
      text += hint.slice(i);
      break;
    }
    if (text) parts.push({ text });
    text = "";
    parts.push({ keys: hint.slice(i + 1, end).split(/\+(?=.)/) });
    i = end + 1;
  }
  if (text) parts.push({ text });
  return parts;
}

/** Modes a host adds beside the tools. */
export type HostMode = "crop" | "grow" | "empty";

interface HintSources {
  said: WhyHint | null;
  hover: ControlHint | null;
  drag: DragHint | null;
  mode: HostMode | null;
  overObject: boolean;
  overRedactedWord: boolean;
}

/** What the canvas and the pointer report; the rest comes from the stores. */
export const useHintSources = create<HintSources>(() => ({
  said: null,
  hover: null,
  drag: null,
  mode: null,
  overObject: false,
  overRedactedWord: false,
}));

/** How long the line says why a key did nothing (ms). */
const SAY_FOR = 4000;
let sayTimer: ReturnType<typeof setTimeout> | undefined;

/** Says why a key did nothing, for a moment (PLAN 4.6b). */
export function sayWhy(said: WhyHint): void {
  clearTimeout(sayTimer);
  useHintSources.setState({ said });
  sayTimer = setTimeout(() => useHintSources.setState({ said: null }), SAY_FOR);
}

/** What the pointer is over that has a hint (a timeline handle, set by the timeline). */
export function setHoverHint(hover: ControlHint | null): void {
  if (useHintSources.getState().hover !== hover) useHintSources.setState({ hover });
}

export function setDragHint(drag: DragHint | null): void {
  if (useHintSources.getState().drag !== drag) useHintSources.setState({ drag });
}

export function setOverRedactedWord(overRedactedWord: boolean): void {
  if (useHintSources.getState().overRedactedWord !== overRedactedWord)
    useHintSources.setState({ overRedactedWord });
}

export function setOverObject(overObject: boolean): void {
  if (useHintSources.getState().overObject !== overObject) useHintSources.setState({ overObject });
}
