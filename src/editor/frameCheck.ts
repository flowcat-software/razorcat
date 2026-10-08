// Development: the preview = export check (PLAN 1.8; check.rs). Over a barcoded test clip
// (`spikes/make-test-media.mjs`), it steps and seeks the preview as the keys do, waits for each
// frame to be on screen, and reads its barcode: the source frame shown. Each must be the frame
// export picks at that grid frame (ffmpeg's `fps` filter, read by Rust). The proxy, which shows
// while stepping fast and scrubbing (and which the thumbnails come from), is checked the same
// way if it's ready by then.
import { commands } from "../shared/ipc";
import type { Player } from "./player";

/** The barcode: cells along the bottom sixteenth of the picture, least significant on the left. */
const BITS = 16;
/** Frames stepped one by one, from the start (all of a short clip). */
const STEPS = 1500;
/** Frames sought at random. */
const SEEKS = 150;
/** The longest a frame may take to show (ms). */
const PATIENCE = 5000;

/** The number in a row of RGBA pixels across the barcode: each cell's middle, white = 1. */
export function readBarcode(row: Uint8ClampedArray, width: number): number {
  let n = 0;
  for (let k = 0; k < BITS; k++) {
    const i = Math.floor(((k + 0.5) * width) / BITS) * 4;
    if ((row[i] + row[i + 1] + row[i + 2]) / 3 >= 128) n |= 1 << k;
  }
  return n;
}

/** Frames in random order but the same each run, so a failure can be repeated. */
export function seeded(count: number, frames: number, seed = 1): number[] {
  let s = seed;
  return Array.from({ length: count }, () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) % frames;
  });
}

interface Miss {
  pass: string;
  frame: number;
  expected: number;
  /** What's on screen (by barcode). */
  shown: number;
  /** The player never said the frame was on screen: what's shown is what was there by then. */
  late?: boolean;
  /** Late on the original: what the player saw. */
  times?: ReturnType<Player["originalTimes"]>;
}

/** Waits (by animation frames) until `ready`, or gives up. */
function until(ready: () => boolean, ms = PATIENCE): Promise<boolean> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (ready()) resolve(true);
      else if (performance.now() - t0 > ms) resolve(false);
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

/**
 * Runs the check on the open source; `progress` gets a line for the status bar. Returns the
 * summary (the report is kept by Rust, in the temp folder).
 */
export async function checkFrames(
  player: Player,
  /** The picture as shown, and the degrees clockwise the stored one is turned to show it. */
  shown: { width: number; height: number; rotation: number },
  progress: (text: string) => void,
  /** Another file was opened (or the page is going): stop. */
  stopped: () => boolean,
) {
  const t0 = performance.now();
  progress("Checking frames: reading what export picks…");
  const got = await commands.frameCheckExpected();
  if (got.status === "error") throw new Error(got.error);
  const expected = got.data;
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  // Upright, as the preview shows it: the preview turns the original with CSS (the proxy is
  // made upright), and the barcode is along the bottom of the upright picture.
  const read = (video: HTMLVideoElement) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const sideways = shown.rotation % 180 === 90;
    const upright = vw > vh === shown.width > shown.height;
    const turn = sideways && !upright ? shown.rotation : 0;
    const [w, h] = turn ? [vh, vw] : [vw, vh];
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    g.setTransform(1, 0, 0, 1, w / 2, h / 2);
    g.rotate((turn * Math.PI) / 180);
    g.drawImage(video, -vw / 2, -vh / 2, vw, vh);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return readBarcode(g.getImageData(0, Math.floor(h - h / 32), w, 1).data, w);
  };

  const misses: Miss[] = [];
  /** `covered`: frames the original couldn't show, which the proxy did. */
  const passes: { pass: string; checked: number; misses: number; covered: number }[] = [];
  const pass = async (name: string, frames: number[], go: (k: number, i: number) => void) => {
    // The proxy passes read the proxy; the others whatever is on top (the original, or the proxy
    // covering a frame the original can't show).
    const onProxy = name.startsWith("proxy");
    const which = () => (onProxy ? (player.shows("proxy") ? "proxy" : null) : player.onScreen());
    let checked = 0;
    let missed = 0;
    let covered = 0;
    for (let i = 0; i < frames.length; i++) {
      if (stopped()) throw new Error("stopped");
      const k = frames[i];
      go(k, i);
      const late = !(await until(() => which() !== null));
      const on = which() ?? (onProxy ? "proxy" : "original");
      if (!onProxy && on === "proxy") covered++;
      const shown = read(player.video(on)!);
      checked++;
      if (k < expected.length && (late || shown !== expected[k])) {
        missed++;
        misses.push({
          pass: name,
          frame: k,
          expected: expected[k],
          shown,
          ...(late && { late, times: player.originalTimes() }),
        });
      }
      if (i % 25 === 0) progress(`Checking frames: ${name} ${i + 1}/${frames.length}…`);
    }
    passes.push({ pass: name, checked, misses: missed, covered });
  };

  const n = player.frames;
  const steps = Array.from({ length: Math.min(n, STEPS) }, (_, i) => i);
  const seeks = seeded(SEEKS, n);
  // As the arrow keys: a single step waits for the original; held, the proxy keeps up.
  await pass("step", steps, (k) => (k === 0 ? player.seek(0, false) : player.step(1)));
  await pass("seek", seeks, (k) => player.seek(k, false));
  if (player.video("proxy")) {
    await pass("proxy step", steps, (k) => (k === 0 ? player.seek(0) : player.step(1, true)));
    await pass("proxy seek", seeks, (k) => player.seek(k));
  }

  const total = misses.length;
  const summary =
    `${n} frames (export has ${expected.length}): ` +
    passes
      .map(
        (p) =>
          `${p.pass} ${p.checked - p.misses}/${p.checked}` +
          (p.covered ? ` (${p.covered} by the proxy)` : ""),
      )
      .join(", ") +
    (player.video("proxy") ? "" : ", no proxy to check") +
    (total ? `; ${total} wrong` : "; all match") +
    ` in ${((performance.now() - t0) / 1000).toFixed(0)} s`;
  const report = JSON.stringify({ frames: n, exported: expected.length, passes, misses }, null, 1);
  await commands.frameCheckReport(summary, report);
  return summary;
}
