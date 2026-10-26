// The countdown before a recording starts (PLAN 5b.5b; recording.rs): big numbers in the middle
// of what's to be recorded, a second each. Over its whole monitor, never taking the keys or the
// pointer, and left out of the recording (which starts after it anyway). recording.rs puts the
// seconds and the place (the monitor's physical pixels) in `window.countdown` before the page
// loads, and closes it when the time's up.
import "./countdown.css";

declare global {
  interface Window {
    countdown?: { seconds: number; x: number; y: number; width: number; height: number };
  }
}

const c = window.countdown;
if (c) {
  const css = (v: number) => `${v / window.devicePixelRatio}px`;
  const place = document.createElement("div");
  place.className = "place";
  Object.assign(place.style, {
    left: css(c.x),
    top: css(c.y),
    width: css(c.width),
    height: css(c.height),
  });
  const number = document.createElement("div");
  number.className = "number";
  place.append(number);
  document.body.append(place);

  const t0 = performance.now();
  let shown = 0;
  const tick = () => {
    const left = Math.max(1, c.seconds - Math.floor((performance.now() - t0) / 1000));
    if (left !== shown) {
      shown = left;
      number.textContent = String(left);
      // Each number pops in afresh.
      number.classList.remove("pop");
      void number.offsetWidth;
      number.classList.add("pop");
    }
    requestAnimationFrame(tick);
  };
  tick();
}
