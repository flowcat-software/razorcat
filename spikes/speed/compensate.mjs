// Spike SP0, part A3 (for SP4): what's left of atempo's lead once a delay cancels it. Each stage at
// tempo t leads by about LEAD/t ms of its output, and a stage's lead is stretched by the stages
// after it (frames.mjs's centroids). Below 0.5 atempo needs a chain: halves then the rest, or
// equal stages. Each way, compensated by the model, against the picture's beeps.
//
// Run from the repo root: node spikes/speed/compensate.mjs

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FF = join(here, "..", ".tools", "ffmpeg", "bin", "ffmpeg.exe");
const SRC = join(here, "..", "media", "obs-1080p60-10m.mp4");
const FPS = 60;
const LEAD = Number(process.env.LEAD ?? 10);

const halves = (s) => {
  const t = [];
  while (s < 0.5) { t.push(0.5); s /= 0.5; }
  return [...t, s];
};
const equal = (s) => {
  const n = s >= 0.5 ? 1 : Math.ceil(Math.log(s) / Math.log(0.5));
  return Array(n).fill(s ** (1 / n));
};
/** The chain's lead, ms of output: each stage's LEAD/t, stretched by the stages after it. */
const stretched = (stages) =>
  stages.reduce((sum, t, i) => sum + (LEAD / t) * stages.slice(i + 1).reduce((p, u) => p / u, 1), 0);
/** Or as measured (MODE=fit): LEAD/s for one stage, CHAIN/s for a chain, s the whole tempo. */
const CHAIN = Number(process.env.CHAIN ?? 13);
const fitted = (stages) => (stages.length > 1 ? CHAIN : LEAD) / stages.reduce((p, t) => p * t, 1);
const lead = process.env.MODE === "fit" ? fitted : stretched;

function centroids(pcm, expected, gap, s) {
  return expected.map((e) => {
    const a = Math.max(0, Math.floor(((e - gap / 2) / 1000) * 48000));
    const b = Math.min(pcm.length, Math.floor(((e + gap / 2) / 1000) * 48000));
    let w = 0, m = 0;
    for (let i = a; i < b; i++) { const v = pcm[i] * pcm[i]; w += v; m += v * i; }
    return (m / w / 48000) * 1000 - (e + 25 / s);
  });
}

const FROM_S = Number(process.env.FROM ?? 30), SECONDS = Number(process.env.SECONDS ?? 120);
console.log(`LEAD ${LEAD} ms a stage${process.env.MODE === "fit" ? `, ${CHAIN} ms a chain (fit)` : ""}`);
console.log("speed    chain    stages  model     left: mean   max");
const SPEEDS = (process.env.SPEEDS ?? "1/10,1/5,1/4,3333/10000,2/5,1/2,2/3,1/1,3/2,2/1,7/3,4/1")
  .split(",")
  .map((x) => x.split("/").map(Number));
for (const [num, den] of SPEEDS) {
  const s = num / den;
  // Where the beeps should be: on the source's whole seconds, exactly (the sound has no frame
  // rounding).
  const expected = [];
  for (let w = Math.floor(FROM_S) + 1; w < FROM_S + SECONDS; w++) expected.push(((w - FROM_S) / s) * 1000);
  for (const [name, chainOf] of [["halves", halves], ["equal", equal]]) {
    const stages = chainOf(s);
    if (name === "equal" && stages.length === 1) continue;
    const model = lead(stages);
    const graph =
      `[0:a:0]atrim=start=${FROM_S}:end=${FROM_S + SECONDS},asetpts=PTS-STARTPTS,` +
      stages.map((t) => `atempo=${t.toFixed(6)}`).join(",") +
      `,adelay=${model.toFixed(3)}:all=1[a]`;
    const r = spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-i", SRC, "-vn", "-filter_complex", graph, "-map", "[a]", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], { maxBuffer: 2 ** 31 });
    if (r.status !== 0) { console.log(name, String(r.stderr)); continue; }
    const pcm = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 1);
    const c = centroids(pcm, expected, 1000 / s, s);
    const mean = c.reduce((a, b) => a + b, 0) / c.length;
    const max = Math.max(...c.map(Math.abs));
    console.log(
      `${+(100 * s).toFixed(2)}%`.padEnd(9), name.padEnd(9), String(stages.length).padEnd(8),
      `${model.toFixed(1)} ms`.padEnd(10), `${mean.toFixed(1)} ms`.padEnd(8), `${max.toFixed(1)} ms`,
    );
  }
}
