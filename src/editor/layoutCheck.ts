// Development: the layout check (small windows, S4). `razorcat --check-layout <file>` opens a
// video in a window at its smallest, and the page steps through the editor's states (each tool,
// clip, range and markup selections, several selected), measuring every bar: anything that
// reaches past a bar's edge is cut off, and text that's clipped without an ellipsis too.
// Reported as the frame check's are (`frameCheckReport`).

import { commands } from "../shared/ipc";
import type { MarkObject } from "./doc";
import { useDoc } from "./docStore";
import type { Player } from "./player";
import { useTool, type Tool } from "./toolStore";
import styles from "./EditorApp.module.css";

const TOOLS: Tool[] = [
  "select",
  "crop",
  "grow",
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
];

/** The bars measured, by their class. */
const BARS: Record<string, string> = {
  "command bar": styles.commandBar,
  "options bar": styles.optionsBar,
  "timeline bar": styles.timelineBar,
  "timeline options": styles.timelineOptions,
  "status bar": styles.status,
};

interface Finding {
  bar: string;
  /** The element, as a person would name it. */
  what: string;
  /** How far past the edge, px; or how much text is hidden. */
  by: number;
}

interface StateReport {
  state: string;
  cut: Finding[];
  /** Text shortened with an ellipsis: meant to give way, listed to see. */
  shortened: Finding[];
}

/** An element, named by its label, tooltip or text. */
function describe(el: Element): string {
  const name =
    el.getAttribute("aria-label") ??
    el.getAttribute("title") ??
    (el as HTMLInputElement).value ??
    el.textContent ??
    "";
  const text = name.trim().replace(/\s+/g, " ").slice(0, 60);
  return `${el.tagName.toLowerCase()}${text ? ` "${text}"` : ""}`;
}

const shown = (el: Element) => el.getClientRects().length > 0;

/** What's cut off in each bar on screen now. */
export function measure(): Omit<StateReport, "state"> {
  const cut: Finding[] = [];
  const shortened: Finding[] = [];
  for (const [bar, cls] of Object.entries(BARS)) {
    for (const el of document.getElementsByClassName(cls)) {
      const box = el.getBoundingClientRect();
      if (box.bottom > innerHeight + 1)
        cut.push({ bar, what: "the bar itself, below the window", by: box.bottom - innerHeight });
      const reported: Element[] = [];
      for (const child of el.querySelectorAll("*")) {
        if (!shown(child) || reported.some((r) => r.contains(child))) continue;
        // Popups (menus, the volume) aren't the bar's.
        if (getComputedStyle(child).position === "fixed") {
          reported.push(child);
          continue;
        }
        const r = child.getBoundingClientRect();
        const past = Math.max(r.right - box.right, box.left - r.left);
        if (r.width > 0 && past > 1) {
          cut.push({ bar, what: describe(child), by: Math.round(past) });
          reported.push(child);
          continue;
        }
        const style = getComputedStyle(child);
        const hidden = child.scrollWidth - child.clientWidth;
        if (style.overflowX !== "visible" && hidden > 1 && child.clientWidth > 0) {
          const list = style.textOverflow === "ellipsis" ? shortened : cut;
          list.push({ bar, what: describe(child), by: hidden });
          reported.push(child);
        }
      }
    }
  }
  return { cut, shortened };
}

/** Two frames: React has rendered and the bars have squeezed. */
const settle = () =>
  new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

/** A rectangle in the middle of the picture, as markup to select. */
function rect(width: number, height: number): MarkObject {
  return {
    kind: "rect",
    rect: { x: width / 4, y: height / 4, width: width / 2, height: height / 2 },
    rotation: 0,
    fill: "none",
    fillColor: "#e53935",
    style: { color: "#e53935", width: 4, opacity: 1 },
  };
}

/**
 * Steps through the states and reports what's cut off in each; returns the summary. Replaces
 * the timeline (the check opened its own file).
 */
export async function checkLayout(
  player: Player,
  size: { width: number; height: number },
  progress: (text: string) => void,
): Promise<string> {
  const states: StateReport[] = [];
  const at = async (state: string) => {
    progress(`Checking the layout: ${state}…`);
    await settle();
    states.push({ state, ...measure() });
  };
  const doc = () => useDoc.getState();
  const tools = useTool.getState();

  await at("nothing selected");
  for (const t of TOOLS) {
    tools.setTool(t);
    await at(`the ${t} tool`);
  }
  // Grown sides that don't meet: a colour each, grow's widest.
  const grow = doc().doc.frame.grow;
  doc().grow({ ...grow, top: 40, left: 40, right: 40, bottom: 0 });
  tools.setTool("grow");
  await at("the grow tool, each side its colour");
  doc().grow(grow);
  tools.setTool("select");

  const first = doc().doc.clips[0].id;
  doc().select(first);
  await at("a clip");
  doc().setClipFades(first, { fadeIn: 10 });
  doc().setClipFades(first, { fadeOut: 10 });
  await at("a clip with both fades");

  const frames = player.frames;
  const range = doc().addRange(Math.round(frames / 4), Math.round(frames / 2));
  doc().select(first);
  await at("a clip, with ranges");
  if (range !== null) {
    doc().selectRange(range);
    await at("a range");
  }
  doc().select(null);
  doc().setPendingIn(Math.round(frames / 3));
  await at("a range being marked");
  doc().setPendingIn(null);

  doc().split(Math.round(frames / 2));
  doc().selectClips(doc().doc.clips.map((c) => c.id));
  await at("two clips");

  const mark = doc().addMark(rect(size.width, size.height), 0, Math.round(frames / 3), 0);
  if (mark !== null) {
    doc().setMarkFades(mark, { fadeIn: 5 });
    doc().setMarkFades(mark, { fadeOut: 5 });
    doc().selectMarks([mark]);
    await at("a markup item");
    const other = doc().addMark(rect(size.width, size.height), 0, Math.round(frames / 3), 1);
    if (other !== null) {
      doc().selectMarks([mark, other]);
      await at("two markup items");
    }
  }
  doc().selectMarks([]);
  // Its edits undone: the clip as opened (fades left on it would darken the frame).
  while (doc().past.length) doc().undo();

  const report = {
    window: { width: innerWidth, height: innerHeight },
    states: states.filter((s) => s.cut.length || s.shortened.length),
    clear: states.filter((s) => !s.cut.length && !s.shortened.length).map((s) => s.state),
  };
  const bad = states.filter((s) => s.cut.length).length;
  const summary = `${innerWidth}×${innerHeight}: ${states.length} states, ${bad} with something cut off`;
  await commands.frameCheckReport(summary, JSON.stringify(report, null, 2));
  return summary;
}
