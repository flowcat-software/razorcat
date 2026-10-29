// The shortcuts that can't be changed, for Settings › Keyboard shortcuts: a cheat sheet, as
// Vandal's. Kept in step with the keys themselves: `EditorApp.tsx` (`transportKey` and its
// Ctrl keys), `cropTool.ts` (the tools, crop), `useMarkupKeys.ts` (styles, nudging),
// `PickerApp.tsx` (choosing what to record) and `Timeline.tsx` (dragging). The README's
// Keyboard reference has the same lists.

/** One line: its key combinations (alternatives), and what they do. */
export interface KeyEntry {
  /** "Ctrl+Shift+Z"; lowercase words are mouse actions ("Alt+drag"). */
  keys: string[];
  what: string;
}

export const TOOL_KEYS: KeyEntry[] = [
  { keys: ["V"], what: "Select" },
  { keys: ["C"], what: "Crop" },
  { keys: ["G"], what: "Grow the frame" },
  { keys: ["T"], what: "Text" },
  { keys: ["A"], what: "Arrow" },
  { keys: ["/", "\\"], what: "Line" },
  { keys: ["B"], what: "Rectangle (box)" },
  { keys: ["E"], what: "Ellipse" },
  { keys: ["Q"], what: "Callout" },
  { keys: ["N"], what: "Step marker" },
  { keys: ["D"], what: "Click" },
  { keys: ["H"], what: "Highlighter" },
  { keys: ["P"], what: "Pen" },
  { keys: ["F"], what: "Spotlight (focus)" },
  { keys: ["U"], what: "Redact (blur)" },
  { keys: ["X"], what: "Swap the two colors" },
];

export const PLAYBACK_KEYS: KeyEntry[] = [
  { keys: ["Space"], what: "Play or pause" },
  { keys: ["J"], what: "Play backward (again: faster)" },
  { keys: ["K"], what: "Pause" },
  { keys: ["L"], what: "Play forward (again: faster)" },
  { keys: ["←", "→"], what: "One frame back or forward" },
  { keys: ["Shift+←", "Shift+→"], what: "One second back or forward" },
  { keys: ["↑", "↓"], what: "The previous or next edit point" },
  { keys: ["Home", "End"], what: "The start or the end" },
];

export const TIMELINE_KEYS: KeyEntry[] = [
  { keys: ["S"], what: "Split at the playhead" },
  { keys: ["I", "O"], what: "A range's in or out point" },
  { keys: ["R"], what: "A range at the playhead" },
  { keys: ["Del", "Backspace"], what: "Delete what's selected" },
  { keys: ["Esc"], what: "Drop a range's in point, then the selection" },
  { keys: ["M"], what: "Mute the selected clip" },
  { keys: ["Shift+M"], what: "Mute all the sound" },
  { keys: ["Ctrl+D"], what: "Duplicate the selected clip" },
  { keys: ["Ctrl+C", "Ctrl+V"], what: "Copy and paste a clip, or markup" },
  { keys: ["Ctrl+[", "Ctrl+]"], what: "Move a clip earlier or later, or markup back or forward" },
  { keys: ["Ctrl+Shift+[", "Ctrl+Shift+]"], what: "To the start or end, or to the back or front" },
  { keys: ["Ctrl+R"], what: "The selected clip's speed" },
  { keys: ["Ctrl+Shift+V"], what: "Paste the copied markup's style onto the selected" },
  { keys: ["Ctrl+Shift+F"], what: "Paste its fades (a clip's too)" },
  { keys: ["Ctrl+Shift+T"], what: "Paste its timing" },
  { keys: ["Ctrl+Z"], what: "Undo" },
  { keys: ["Ctrl+Y", "Ctrl+Shift+Z"], what: "Redo" },
  { keys: ["Ctrl+0"], what: "Fit the timeline" },
  { keys: ["Ctrl+=", "Ctrl+−"], what: "Zoom the timeline in or out" },
  { keys: ["Shift+drag"], what: "Drag without snapping" },
  { keys: ["Alt+drag"], what: "Drag a copy" },
  { keys: ["Ctrl+click", "Shift+click"], what: "Add to the selection" },
];

export const MARKUP_KEYS: KeyEntry[] = [
  { keys: ["1…0"], what: "Line width, text size or strength, by tool" },
  { keys: ["Shift+1…0"], what: "A callout's pointer thickness" },
  { keys: ["Alt+1…0"], what: "Font, or corner radius for rectangles and spotlights" },
  { keys: ["`", "Shift+`", "Alt+`"], what: "The lowest of those (the key left of 1)" },
  { keys: ["Alt+↑", "Alt+↓"], what: "The previous or next font" },
  { keys: ["Ctrl+1…9"], what: "Color (the first, with two)" },
  { keys: ["Ctrl+Shift+1…9"], what: "The second color" },
  { keys: ["Ctrl+B", "Ctrl+I"], what: "Bold, italic" },
  { keys: ["Ctrl+A"], what: "Select the markup at the playhead (again: all of it)" },
  { keys: ["Ctrl+D"], what: "Duplicate the selected markup" },
  { keys: ["←↑↓→"], what: "Nudge, after a click on the picture (with Shift: 10 px)" },
  { keys: ["Enter"], what: "Edit the selected text, callout or step label" },
  { keys: ["Esc"], what: "Deselect, then back to Select" },
  { keys: ["Shift+drag"], what: "Square, circle, 45° lines, straight moves" },
];

export const CROP_KEYS: KeyEntry[] = [
  { keys: ["←↑↓→"], what: "Move the crop (with Shift: 10 px)" },
  { keys: ["Ctrl+←↑↓→"], what: "Resize it from the bottom-right corner" },
  { keys: ["Enter", "Esc"], what: "Done" },
];

export const FILE_KEYS: KeyEntry[] = [
  { keys: ["Ctrl+O"], what: "Open a video or project" },
  { keys: ["Ctrl+Shift+O"], what: "Add a video to the timeline" },
  { keys: ["Ctrl+S"], what: "Save the project" },
  { keys: ["Ctrl+Shift+S"], what: "Save the project as" },
  { keys: ["Ctrl+E"], what: "Export an MP4" },
  { keys: ["Ctrl+,"], what: "Settings" },
];

export const PICK_KEYS: KeyEntry[] = [
  { keys: ["drag"], what: "Choose an area (Shift: square)" },
  { keys: ["F"], what: "Record the screen under the pointer" },
  { keys: ["W"], what: "Choose a window instead (again, or Esc: back)" },
  { keys: ["Enter"], what: "Record" },
  { keys: ["←↑↓→"], what: "Move the area (with Shift: 10 px)" },
  { keys: ["Ctrl+←↑↓→"], what: "Resize it" },
  { keys: ["M", "S"], what: "Microphone, system sound on or off" },
  { keys: ["C", "V"], what: "Clicks, camera on or off" },
  { keys: ["Esc", "right-click"], what: "Cancel" },
];
