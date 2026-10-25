// Development: the reverse check (PLAN §7, Clip speed SP8). `razorcat --check-reverse <file>`
// opens a barcoded test clip (`spikes/make-test-media.mjs`), trims it to 10 s and reverses it,
// then reads the preview's barcodes as frameCheck.ts does: seeking while it plays by seeking (no
// render yet), then once its render is ready, seeking and stepping on it, and playing it, each
// picture presented. Every frame must be the one the document says (speed.ts's `sourceFrame`).
// Then the same at −50%, which the same render covers. Reported as the frame check's are.

import { commands } from "../shared/ipc";
import { useDoc } from "./docStore";
import { readBarcode, until } from "./frameCheck";
import type { Player } from "./player";
import { readyFor } from "./reverse";
import { sourceFrame, speed } from "./speed";

/** How long a render may take (ms). */
const RENDER_PATIENCE = 180_000;
/** How long each play pass plays (ms). */
const PLAY_MS = 3000;

interface Pass {
  pass: string;
  checked: number;
  misses: number;
  /** Played: the pictures out of order (later in the source than the one before). */
  backward?: number;
  /** Where it was read from: the render's deck, or the file's (seeking). */
  decks: string[];
  examples: string[];
}

export async function checkReverse(
  player: Player,
  progress: (text: string) => void,
  stopped: () => boolean,
): Promise<string> {
  const store = () => useDoc.getState();
  const id = store().doc.clips[0].id;
  const fps = player.fps;
  // 10 s from 20 s in: not on a keyframe, short to render.
  store().trim(id, Math.round(20 * fps) + 7, Math.round(30 * fps) + 7);
  store().reverse([id]);
  const clip = () => store().doc.clips[0];
  const want = (k: number) => sourceFrame(clip(), clip().in + k);

  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  const read = (video: HTMLVideoElement) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    g.drawImage(video, 0, 0, w, h);
    return readBarcode(g.getImageData(0, Math.floor(h - h / 32), w, 1).data, w);
  };
  const shown = () => {
    const on = player.onScreen();
    return on && read(player.video(on)!);
  };
  const deck = () => (player.getState().source?.startsWith("reverse:") ? "render" : "file");
  const passes: Pass[] = [];

  const seekPass = async (name: string, frames: number[]) => {
    const p: Pass = { pass: name, checked: 0, misses: 0, decks: [], examples: [] };
    for (const k of frames) {
      if (stopped()) throw new Error("stopped");
      player.seek(k, false);
      const late = !(await until(() => player.onScreen() !== null));
      const got = shown();
      p.checked++;
      if (!p.decks.includes(deck())) p.decks.push(deck());
      if (late || got !== want(k)) {
        p.misses++;
        if (p.examples.length < 5)
          p.examples.push(`frame ${k}: want ${want(k)} got ${got}${late ? " (late)" : ""}`);
      }
    }
    passes.push(p);
  };

  const playPass = async (name: string) => {
    const p: Pass = { pass: name, checked: 0, misses: 0, backward: 0, decks: [], examples: [] };
    player.seek(0, false);
    await until(() => player.onScreen() !== null);
    player.toggle();
    const t0 = performance.now();
    let last = Infinity;
    await until(() => {
      const on = player.getState().speed > 0 ? "original" : null;
      if (on) {
        const v = player.video(on);
        if (v && v.readyState >= 2) {
          const got = read(v);
          const f = player.getState().frame;
          p.checked++;
          if (!p.decks.includes(deck())) p.decks.push(deck());
          // The playhead follows the picture, a frame or two behind or ahead at most.
          const near = [f - 2, f - 1, f, f + 1, f + 2].some((x) => x >= 0 && want(x) === got);
          if (!near) {
            p.misses++;
            if (p.examples.length < 5)
              p.examples.push(`frame ${f}: want about ${want(f)} got ${got}`);
          }
          if (got > last) p.backward!++;
          last = got;
        }
      }
      return performance.now() - t0 > PLAY_MS || player.getState().speed === 0;
    }, PLAY_MS + 1000);
    player.pause();
    passes.push(p);
  };

  const n = () => player.frames;
  const seeds = (count: number) =>
    Array.from({ length: count }, (_, i) => Math.floor((((i * 7919) % 997) / 997) * n()));

  progress("Reverse check: seeking before the render is ready…");
  await seekPass("seek, by seeking", seeds(20));
  progress("Reverse check: waiting for the render…");
  if (!(await until(() => !!readyFor(clip()), RENDER_PATIENCE))) throw new Error("no render");
  // The player takes the render up.
  await until(() => {
    player.seek(0, false);
    return deck() === "render";
  }, 10_000);
  progress("Reverse check: on the render…");
  await seekPass(
    "step",
    Array.from({ length: 120 }, (_, i) => i),
  );
  await seekPass("seek", seeds(60));
  await playPass("play");

  progress("Reverse check: at −50%…");
  store().setSpeed([id], speed(1, 2));
  await until(() => player.frames === clip().out - clip().in, 5000);
  await until(() => !!readyFor(clip()), 10_000);
  await seekPass("seek at −50%", seeds(60));
  await playPass("play at −50%");
  while (store().past.length) store().undo();

  const misses = passes.reduce((m, p) => m + p.misses, 0);
  const backward = passes.reduce((m, p) => m + (p.backward ?? 0), 0);
  const checked = passes.reduce((m, p) => m + p.checked, 0);
  const summary = `${checked} pictures, ${misses} wrong, ${backward} out of order`;
  await commands.frameCheckReport(`Reverse check: ${summary}`, JSON.stringify(passes, null, 2));
  return summary;
}
