// The countdown before a recording starts (PLAN 5b.5b; recording.rs): big numbers in the middle
// of what's to be recorded, a second each. Over its whole monitor, never taking the keys or the
// pointer, and left out of the recording (which starts after it anyway). recording.rs puts the
// seconds and the place (the monitor's physical pixels) in `window.countdown` before the page
// loads, starts it (`startCountdown`) once it has, as it starts its own count, and closes it when
// the time's up. Counted from its own loading, the page lagged Rust's count.
import "./countdown.css";

declare global {
  interface Window {
    countdown?: { seconds: number; x: number; y: number; width: number; height: number };
    startCountdown?: () => void;
  }
}

/** If Rust's start doesn't come, the page starts itself after this (ms). */
const UNSTARTED = 2500;

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

  let t0 = 0;
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
  const start = () => {
    if (t0) return;
    t0 = performance.now();
    tick();
  };
  window.startCountdown = start;
  setTimeout(start, UNSTARTED);
}
