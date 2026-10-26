// The marks round an area being recorded (PLAN 5b.3c; recording.rs): its corners, and the rest
// of its monitor dimmed, as the picker left it. Over the whole monitor, left out of the
// recording, clicks through. recording.rs puts the area (the monitor's physical pixels) in
// `window.recordingArea` before the page loads.
import "./outline.css";

declare global {
  interface Window {
    recordingArea?: { x: number; y: number; width: number; height: number };
  }
}

const a = window.recordingArea;
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
  for (const corner of ["nw", "ne", "se", "sw"]) {
    const mark = document.createElement("span");
    mark.className = `corner ${corner}`;
    area.append(mark);
  }
  document.body.append(area);
}
