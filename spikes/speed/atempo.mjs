// Spike SP0, part A2: where atempo (and rubberband, for comparison) puts a click. A 1 ms click
// at 2 s of a 10 s 48 kHz tone-free track; out, its peak should be at 2/s seconds. The shift is
// constant per chain (frames.mjs found it), so this finds it per tempo, and whether starting
// the input early and trimming the output after cancels it.
//
// Run from the repo root: node spikes/speed/atempo.mjs

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FF = join(here, "..", ".tools", "ffmpeg", "bin", "ffmpeg.exe");

function pcmOf(graph) {
  const r = spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", graph, "-ac", "1", "-f", "s16le", "-"], { maxBuffer: 2 ** 31 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 1);
}
const peakMs = (pcm) => {
  let best = 0, at = 0;
  for (let i = 0; i < pcm.length; i++) if (Math.abs(pcm[i]) > best) { best = Math.abs(pcm[i]); at = i; }
  return (at / 48000) * 1000;
};

function chain(s) {
  const parts = [];
  while (s < 0.5) { parts.push("atempo=0.5"); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(6)}`);
  return parts.join(",");
}

const CLICK = "aevalsrc=exprs='if(between(t,2,2.001),0.9,0)':s=48000:d=10";
console.log("tempo    stages  atempo shift   rubberband shift   length (want)");
for (const s of [0.1, 0.25, 1 / 3, 0.5, 2 / 3, 0.9, 1, 1.5, 2, 7 / 3, 4, 10]) {
  const want = 2000 / s;
  const a = pcmOf(`${CLICK},${chain(s)}`);
  let rb = "n/a";
  try { rb = (peakMs(pcmOf(`${CLICK},rubberband=tempo=${s.toFixed(6)}`)) - want).toFixed(2); } catch {}
  console.log(
    s.toFixed(3).padEnd(8), String(chain(s).split(",").length).padEnd(7),
    `${(peakMs(a) - want).toFixed(2)} ms`.padEnd(14), `${rb} ms`.padEnd(18),
    `${((a.length / 48000) * 1000).toFixed(1)} (${(10000 / s).toFixed(1)})`,
  );
}
