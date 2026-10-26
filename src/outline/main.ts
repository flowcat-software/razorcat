// The marks round an area being recorded (PLAN 5b.3c; recording.rs): its corners, and the rest
// of its monitor dimmed, as the picker left it. Over the whole monitor, left out of the
// recording, clicks through. recording.rs puts the area (the monitor's physical pixels) in
// `window.recordingArea`, and Settings › Recording's marks in `window.recordingMarks` (the
// corners' color or none, how dark the dimming is or 0), before the page loads.
import "./outline.css";

declare global {
  interface Window {
    recordingArea?: { x: number; y: number; width: number; height: number };
    recordingMarks?: { corners: string | null; dim: number };
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
