// Turns a results/run-*.json into Markdown tables for internal/spikes/0.2-playback.md.
// Usage (PowerShell): node spikes/playback/summarize.mjs [results/run-….json]  (default: newest)

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "results");
const file = process.argv[2] ?? join(dir, readdirSync(dir).filter((f) => f.startsWith("run-")).sort().at(-1));
const r = JSON.parse(readFileSync(file, "utf8"));

const ms = (s) => (s && !s.error ? `${s.latencyMs?.median ?? "–"} / ${s.latencyMs?.max ?? "–"}` : s?.error ? "error" : "–");
const bad = (s) => (s && !s.error ? (s.wrong || s.timeouts ? `**${s.wrong} wrong${s.timeouts ? `, ${s.timeouts} t/o` : ""}**` : "ok") : "–");
const scrub = (s) => (s && !s.error ? `${s.updatesPerSec}/s, lag ${s.lagMsMedian} ms, settle ${s.settleMs}` : s?.error ? "error" : "–");
const play = (s) => (s && !s.error ? `${s.presented}/${s.expectedFrames}${s.stray ? `, ${s.stray} stray` : ""}${s.skippedFrames ? `, ${s.skippedFrames} skipped` : ""}${s.hitches ? `, ${s.hitches} hitch` : ""}` : s?.error ? "error" : "–");
const cuts = (s) => (s && !s.error ? (s.boundaries ?? []).map((b) => (b ? `${b.extraMs}${b.strayBetween?.length ? `+${b.strayBetween.length}s` : ""}${b.firstFrame !== b.wantedFirst ? "!" : ""}` : "?")).join(", ") + (s.stray ? ` (${s.stray} stray)` : "") : s?.error ? "error" : "–");
const mem = (m) => {
  const a = m?.after?.byExe;
  if (!a) return "–";
  const wv = Math.round(a["msedgewebview2.exe"] ?? 0);
  const app = Math.round(a["driveby-playback-spike.exe"] ?? 0);
  const ff = Math.round(a["ffmpeg.exe"] ?? 0);
  return `${wv}${app > 20 ? ` +${app} app` : ""}${ff ? ` +${ff} ff` : ""}`;
};

console.log(`Run ${r.startedAt} · ${r.caps.userAgent.match(/Edg\/[\d.]+/)?.[0]}`);
console.log(`canPlayType: ${JSON.stringify(r.caps.canPlay)}`);
console.log(`VideoDecoder: ${JSON.stringify(r.caps.decoder)}\n`);

const byMedia = new Map();
for (const run of r.runs) {
  if (!byMedia.has(run.media)) byMedia.set(run.media, []);
  byMedia.get(run.media).push(run);
}
for (const [media, runs] of byMedia) {
  const i = runs[0].info;
  console.log(`### ${media}\n\n${i.codec} ${i.size}${i.rotation ? ` rot ${i.rotation}` : ""}, ${Math.round(i.fps * 100) / 100} fps, ${i.frames} frames, GOP ~${i.gop}, ${i.audioTracks} audio · probe ${i.probeMs} ms${i.indexCached ? " (index cached)" : ""}\n`);
  console.log("| Approach | Open | Step → (med/max ms) | Step ← | Random seek | Exact | Scrub slow | Scrub fast | Play 3 s | Cuts (extra ms) | Memory MB (webview) |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const x of runs) {
    if (x.error) {
      console.log(`| ${x.approach} | **${x.error.slice(0, 80)}** |||||||||`);
      continue;
    }
    const exact = [x.stepForward, x.stepBackward, x.randomSeek].filter(Boolean);
    const ex = exact.some((s) => s.error) ? "error" : exact.every((s) => !s.wrong && !s.timeouts) ? "ok" : exact.map(bad).join(" ");
    const px = x.proxy ? ` (proxy ${Math.round(x.proxy.ms / 100) / 10} s${x.proxy.cached ? " cached" : ""}, ${x.proxy.mb} MB)` : "";
    console.log(`| ${x.approach}${px} | ${x.openMs} | ${ms(x.stepForward)} | ${ms(x.stepBackward)} | ${ms(x.randomSeek)} | ${x.approach === "video2" ? "–" : ex} | ${scrub(x.scrubSlow)} | ${scrub(x.scrubFast)} | ${play(x.play)} | ${cuts(x.clips)} | ${mem(x.memory)} |`);
  }
  console.log("");
}
