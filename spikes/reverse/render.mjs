// Spike SP7 (PLAN §7, Clip speed: reverse): the reversed render. A clip's source range, reversed
// in chunks (ffmpeg's `reverse` holds every frame of what it reverses in memory), each chunk
// encoded on its own and joined by stream copy; the sound reversed apart, as PCM, and encoded
// once. Then checked: every frame's barcode against the source grid backward, each beep against
// where its second falls backward, the time, the size, and ffmpeg's memory per chunk.
//
// Run from the repo root: node spikes/reverse/render.mjs  (needs spikes/media; makes a 4K clip
// there the first time). Env: SECONDS (the range, 20), CHUNK (frames, 120), PRESET (veryfast),
// CRF (16).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FF = join(here, "..", ".tools", "ffmpeg", "bin", "ffmpeg.exe");
const MEDIA = join(here, "..", "media");
const WORK = join(here, "results", "work");
const SECONDS = Number(process.env.SECONDS ?? 20);
const CHUNK = Number(process.env.CHUNK ?? 120);
const PRESET = process.env.PRESET ?? "veryfast";
const CRF = process.env.CRF ?? "16";

function ff(args, opts = {}) {
  const t0 = performance.now();
  const r = spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    maxBuffer: 2 ** 31,
    ...opts,
  });
  if (r.status !== 0) throw new Error(String(r.stderr).trim().split("\n").slice(-3).join(" | "));
  const rss = /maxrss=(\d+)KiB/.exec(String(r.stderr));
  return { out: r.stdout, ms: performance.now() - t0, rss: rss ? Number(rss[1]) / 1024 : null };
}

/** A 4K60 clip like the OBS one: a barcode of the frame number along the bottom, beeps. */
function make4k() {
  const file = join(MEDIA, "uhd-4k60-30s.mp4");
  if (existsSync(file)) return file;
  const W = 3840, H = 2160, cell = W / 16, bar = H / 16;
  const bits = Array.from({ length: 16 }, (_, k) =>
    `drawbox=x=${k * cell}:y=${H - bar}:w=${cell}:h=${bar}:c=white:t=fill:enable='bitand(n,${1 << k})'`,
  ).join(",");
  ff([
    "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=60:d=30`,
    "-f", "lavfi", "-i", "sine=f=1000:r=48000:d=30,volume='if(lt(mod(t,1),0.05),1,0)':eval=frame",
    "-vf", `drawbox=x=0:y=${H - bar}:w=${W}:h=${bar}:c=black:t=fill,${bits}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-g", "120", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", file,
  ]);
  return file;
}

function barcodes(file, W, H) {
  const row = Math.round(H - H / 32);
  const { out } = ff(["-i", file, "-vf", `format=gray,crop=${W}:1:0:${row}`, "-f", "rawvideo", "-"]);
  const cell = W / 16, frames = [];
  for (let o = 0; o + W <= out.length; o += W) {
    let n = 0;
    for (let k = 0; k < 16; k++) if (out[o + Math.round(k * cell + cell / 2)] > 128) n |= 1 << k;
    frames.push(n);
  }
  return frames;
}

/** Beep centroids (s) in mono 48 kHz PCM, one per window around each expected time. */
function centroids(pcm, expected, gap) {
  return expected.map((e) => {
    const a = Math.max(0, Math.floor((e - gap / 2) * 48000));
    const b = Math.min(pcm.length, Math.floor((e + gap / 2) * 48000));
    let w = 0, m = 0;
    for (let i = a; i < b; i++) { const v = pcm[i] * pcm[i]; w += v; m += v * i; }
    return w ? m / w / 48000 : NaN;
  });
}

function render(src, W, H, lo, hi, fps) {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const t0 = performance.now();
  // The chunks, the range's end first: each its frames backward.
  const parts = [];
  let maxRss = 0;
  for (let b = hi; b > lo; b -= CHUNK) {
    const a = Math.max(lo, b - CHUNK);
    const seek = Math.max(0, a / fps - 0.5);
    const part = join(WORK, `part${parts.length}.mp4`);
    const r = ff([
      "-loglevel", "info", "-benchmark", "-ss", seek.toFixed(6), "-i", src, "-an",
      "-vf", `setpts=PTS+(${seek.toFixed(6)})/TB,fps=${fps}/1,trim=start_pts=${a}:end_pts=${b},setpts=PTS-STARTPTS,reverse,format=yuv420p`,
      "-c:v", "libx264", "-preset", PRESET, "-crf", CRF, "-g", "10", "-bf", "0", part,
    ]);
    // -benchmark's maxrss is said at the info level, so this run is louder.
    maxRss = Math.max(maxRss, r.rss ?? 0);
    parts.push(part);
  }
  const list = join(WORK, "parts.txt");
  writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
  const video = join(WORK, "video.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", video]);
  const tVideo = performance.now() - t0;
  // The sound: the range as PCM, reversed here, encoded once.
  const seek = Math.max(0, lo / fps - 0.5);
  const { out } = ff([
    "-ss", seek.toFixed(6), "-i", src, "-vn",
    "-af", `atrim=start=${(lo / fps - seek).toFixed(6)}:duration=${((hi - lo) / fps).toFixed(6)},asetpts=N/SR/TB`,
    "-ac", "2", "-ar", "48000", "-f", "s16le", "-",
  ]);
  const n = out.length / 4;
  const rev = Buffer.alloc(out.length);
  for (let i = 0; i < n; i++) out.copy(rev, (n - 1 - i) * 4, i * 4, i * 4 + 4);
  const pcm = join(WORK, "rev.pcm");
  writeFileSync(pcm, rev);
  const final = join(WORK, "reversed.mp4");
  ff([
    "-i", video, "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", pcm,
    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", final,
  ]);
  return { final, ms: performance.now() - t0, videoMs: tVideo, maxRss, chunks: parts.length };
}

function check(name, src, W, H, fps, lo, hi) {
  const r = render(src, W, H, lo, hi, fps);
  const got = barcodes(r.final, W, H);
  const want = Array.from({ length: hi - lo }, (_, k) => hi - 1 - k);
  let wrong = 0;
  const examples = [];
  for (let k = 0; k < Math.max(got.length, want.length); k++) {
    if (got[k] !== want[k]) {
      wrong++;
      if (examples.length < 4) examples.push(`k${k}: want ${want[k]} got ${got[k]}`);
    }
  }
  // The beeps: source second w (its beep's centroid at w + 0.025) at hi/fps − w − 0.025.
  const { out } = ff(["-i", r.final, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"]);
  const pcm = new Int16Array(out.buffer, out.byteOffset, out.length >> 1);
  const expected = [];
  for (let w = Math.ceil(lo / fps); w + 0.05 <= hi / fps; w++) expected.push(hi / fps - w - 0.025);
  const off = centroids(pcm, expected, 0.9).map((c, i) => (c - expected[i]) * 1000);
  const mean = off.reduce((a, b) => a + b, 0) / off.length;
  const max = Math.max(...off.map(Math.abs));
  const res = {
    name,
    frames: `${hi - lo} (${((hi - lo) / fps).toFixed(1)} s)`,
    chunks: r.chunks,
    seconds: +(r.ms / 1000).toFixed(1),
    videoSeconds: +(r.videoMs / 1000).toFixed(1),
    realtime: +((hi - lo) / fps / (r.ms / 1000)).toFixed(2),
    mb: +(statSync(r.final).size / 1e6).toFixed(1),
    mbPerMinute: +((statSync(r.final).size / 1e6) * (60 * fps) / (hi - lo)).toFixed(0),
    ffmpegMaxRssMb: r.maxRss ? +r.maxRss.toFixed(0) : null,
    framesWrong: wrong,
    examples,
    beeps: off.length,
    soundMeanMs: +mean.toFixed(1),
    soundMaxMs: +max.toFixed(1),
  };
  console.log(res);
  return res;
}

const results = [];
const obs = join(MEDIA, "obs-1080p60-10m.mp4");
// From 2:00, so chunks seek into the middle of a long-GOP file.
results.push(check("1080p60 OBS", obs, 1920, 1080, 60, 7200 + 7, 7200 + 7 + SECONDS * 60));
const uhd = make4k();
results.push(check("4K60 synthetic", uhd, 3840, 2160, 60, 61, 61 + Math.min(SECONDS, 25) * 60));
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(
  join(here, "results", `render-${PRESET}-crf${CRF}-chunk${CHUNK}.json`),
  JSON.stringify(results, null, 2),
);
