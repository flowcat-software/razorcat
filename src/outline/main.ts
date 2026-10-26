// The marks round an area being recorded (PLAN 5b.3c; recording.rs): its corners, and the rest
// of its monitor dimmed, as the picker left it. Over the whole monitor, left out of the
// recording, clicks through. recording.rs puts the area (the monitor's physical pixels) in
// `window.recordingArea`, and Settings › Recording's marks in `window.recordingMarks` (the
// corners' color or none, how dark the dimming is or 0), before the page loads.
//
// The clicks shown live (PLAN 5b.6f) are drawn here too, with the editor's drawing (click.ts), as
// the recording's will look: Settings › Recording in `window.liveClickStyle`, and each click as
// it's made through `window.liveClick` (recording.rs calls it).
import { drawClick } from "../markup/click";
import { clickSettingsOf, useClickSettings } from "../markup/clickSettings";
import type { ClickAnnotation, ClickButton } from "../markup/model/types";
import "./outline.css";

/** A click, where it is on the monitor (physical px); the same `id` again as it becomes a
 *  double-click. */
interface LiveClick {
  id: number;
  x: number;
  y: number;
  button: ClickButton;
  double: boolean;
}

declare global {
  interface Window {
    recordingArea?: { x: number; y: number; width: number; height: number };
    recordingMarks?: { corners: string | null; dim: number };
    liveClickStyle?: Parameters<typeof clickSettingsOf>[0];
    liveClick?: (click: LiveClick) => void;
  }
}

const a = window.recordingArea;
const marks = window.recordingMarks ?? { corners: "#00ff27", dim: 0.3 };
if (a) {
  const css = (v: number) => `${v / window.devicePixelRatio}px`;
  const area = document.createElement("div");
  area.className = "area";
  Object.assign(area.style, {
    left: css(a.x),
    top: css(a.y),
    width: css(a.width),
    height: css(a.height),
  });
  area.style.setProperty("--dim", String(marks.dim));
  if (marks.corners) area.style.setProperty("--mark", marks.corners);
  for (const corner of marks.corners ? ["nw", "ne", "se", "sw"] : []) {
    const mark = document.createElement("span");
    mark.className = `corner ${corner}`;
    area.append(mark);
  }
  document.body.append(area);
}

if (window.liveClickStyle) {
  // As a recording shows them: its double-clicks as "Show double-clicks" says.
  const settings = { ...clickSettingsOf(window.liveClickStyle), follow: true };
  useClickSettings.setState(settings);
  const canvas = document.createElement("canvas");
  canvas.className = "clicks";
  document.body.append(canvas);
  const g = canvas.getContext("2d")!;
  /** The clicks showing, and when each was made (ms, the animation frames' clock). */
  const shown = new Map<number, LiveClick & { at: number }>();
  let frame = 0;
  const draw = (now: number) => {
    // In the monitor's pixels, as the clicks are (and the recording).
    const w = Math.round(window.innerWidth * window.devicePixelRatio);
    const h = Math.round(window.innerHeight * window.devicePixelRatio);
    if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
    g.clearRect(0, 0, w, h);
    for (const [id, c] of shown) {
      const age = (now - c.at) / 1000;
      if (age >= settings.seconds) {
        shown.delete(id);
        continue;
      }
      // Faded in and out as a click mark is.
      const left = settings.seconds - age;
      const alpha = Math.min(
        settings.fadeIn > 0 ? age / settings.fadeIn : 1,
        settings.fadeOut > 0 ? left / settings.fadeOut : 1,
        1,
      );
      const mark: ClickAnnotation = {
        id: `live${id}`,
        kind: "click",
        x: 0,
        y: 0,
        size: settings.size,
        look: settings.look,
        double: c.double,
        button: c.button,
      } as ClickAnnotation;
      g.save();
      g.globalAlpha = alpha;
      g.translate(c.x, c.y);
      drawClick(g, mark, age);
      g.restore();
    }
    // Only while there's something to draw.
    frame = shown.size ? requestAnimationFrame(draw) : 0;
  };
  window.liveClick = (c) => {
    const kept = shown.get(c.id);
    if (kept) kept.double = c.double;
    else shown.set(c.id, { ...c, at: performance.now() });
    if (!frame) frame = requestAnimationFrame(draw);
  };
}
