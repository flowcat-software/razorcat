// Spike SP0, part A (PLAN §7, Clip speed): can ffmpeg show exactly the frames the preview will?
// A clip at speed s = num/den (source frames per timeline frame) shows source frame
// `in + floor(u·s)` on its timeline frame u, for u < ceil((out − in)/s). Each candidate chain
// runs on the barcoded OBS-like test clip (spikes/media, `make-test-media.mjs`), its barcodes read
// straight from the filter's output (no encode), and checked frame for frame. Then the sound:
// `atempo` (pitch kept) or `asetrate` (tape-style), its beeps against where the picture's flashes
// fall, over a long stretch so drift shows.
//
// Run from the repo root: node spikes/speed/frames.mjs  (results in spikes/speed/results/)

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FF = join(here, "..", ".tools", "ffmpeg", "bin", "ffmpeg.exe");
const SRC = join(here, "..", "media", "obs-1080p60-10m.mp4");
const FPS = 60;
const W = 1920, H = 1080;

function ff(args) {
  const t0 = performance.now();
  const r = spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 2 ** 31 });
  if (r.status !== 0) throw new Error(String(r.stderr).trim().split("\n").slice(-3).join(" | "));
  return { out: r.stdout, ms: Math.round(performance.now() - t0) };
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const length = (n, num, den) => Math.ceil((n * den) / num);
const wantFrames = (from, n, num, den) =>
  Array.from({ length: length(n, num, den) }, (_, u) => from + Math.floor((u * num) / den));

// The export's clip chain (export.rs) up to the clip's own frames, pts = frame index at 1/FPS.
const base = (from, out) =>
  `[0:v:0]fps=${FPS}/1,trim=start_pts=${from}:end_pts=${out},setpts=PTS-STARTPTS`;

// Candidates for the speed step, after `base`. L is the clip's timeline length.
const candidates = {
  // Each source frame at the first timeline frame that shows it; fps repeats and drops; tpad
  // holds the last frame to the end; trim cuts at L.
  "setpts-ceil+fps": (num, den, L) =>
    `setpts='ceil(N*${den}/${num})',fps=${FPS}/1,tpad=stop_mode=clone:stop=${L},trim=end_frame=${L},setpts=PTS-STARTPTS`,
  // The same without tpad: does fps alone reach the end?
  "setpts-ceil+fps (no tpad)": (num, den, L) =>
    `setpts='ceil(N*${den}/${num})',fps=${FPS}/1,trim=end_frame=${L}`,
  // The obvious one: scale the timestamps, let fps (round=near) pick.
  "setpts-scale+fps": (num, den, L) =>
    `setpts=PTS*${den}/${num},fps=${FPS}/1,trim=end_frame=${L}`,
};

function readBarcodes(graph) {
  // A row through the middle of the barcode strip (the bottom 1/16), gray, raw.
  const row = Math.round(H - H / 32);
  const { out, ms } = ff(["-i", SRC, "-filter_complex", `${graph},format=gray,crop=${W}:1:0:${row}[o]`, "-map", "[o]", "-f", "rawvideo", "-"]);
  const cell = W / 16, frames = [];
  for (let o = 0; o + W <= out.length; o += W) {
    let n = 0;
    for (let k = 0; k < 16; k++) if (out[o + Math.round(k * cell + cell / 2)] > 128) n |= 1 << k;
    frames.push(n);
  }
  return { frames, ms };
}

function compare(got, want) {
  let wrong = 0;
  const examples = [];
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] !== want[i]) {
      wrong++;
      if (examples.length < 4) examples.push(`u${i}: want ${want[i]} got ${got[i]}`);
    }
  }
  return { frames: got.length, expected: want.length, wrong, examples };
}

// Speeds as ratios: 10%, 33.33%, 50%, 66.67% (2/3), 100%, 150%, 233.33% (7/3), 200%, 1000%.
const SPEEDS = [[1, 10], [3333, 10000], [1, 2], [2, 3], [1, 1], [3, 2], [7, 3], [2, 1], [10, 1]].map(
  ([a, b]) => [a / gcd(a, b), b / gcd(a, b)],
);
const pct = (num, den) => `${+((100 * num) / den).toFixed(2)}%`;

const results = { at: new Date().toISOString(), picture: [], sound: [] };
const log = (...a) => console.log(...a);

// ---------- the picture ----------
// 301 frames from an odd start (frame 601: not on a keyframe or a second).
const FROM = 601, N = 301;
const only = process.argv[2];
for (const [num, den] of only === "sound" ? [] : SPEEDS) {
  const L = length(N, num, den);
  const want = wantFrames(FROM, N, num, den);
  for (const [name, chain] of Object.entries(candidates)) {
    let r;
    try {
      const { frames, ms } = readBarcodes(`${base(FROM, FROM + N)},${chain(num, den, L)}`);
      r = { ...compare(frames, want), ms };
    } catch (e) {
      r = { error: String(e.message) };
    }
    results.picture.push({ speed: pct(num, den), num, den, candidate: name, ...r });
    log(pct(num, den).padEnd(8), name.padEnd(28), r.error ?? `${r.frames}/${r.expected} frames, ${r.wrong} wrong ${r.examples.join("; ")}`);
  }
}

// A split: the left part's first U timeline frames, then the right part from source frame
// in + floor(U·s), against the unsplit clip's frames.
log("\nsplits (the floor rule, no phase):");
for (const [num, den] of SPEEDS) {
  const whole = wantFrames(FROM, N, num, den);
  let moved = 0, at = [];
  for (let U = 1; U < whole.length; U++) {
    const mid = FROM + Math.floor((U * num) / den);
    const right = wantFrames(mid, FROM + N - mid, num, den);
    const joined = [...whole.slice(0, U), ...right];
    const diff = joined.length !== whole.length || joined.some((v, i) => v !== whole[i]);
    if (diff) { moved++; if (at.length < 3) at.push(U); }
  }
  // With a phase: frame u of a clip shows in + floor((u·num + p)/den), p in [0, den). The right
  // part of a cut at U starts at in + floor((U·num + p)/den) with phase (U·num + p) mod den, and
  // lasts ceil(((out − in)·den − p)/num).
  const phased = (from, p, n) =>
    Array.from({ length: Math.ceil((n * den - p) / num) }, (_, u) => from + Math.floor((u * num + p) / den));
  let movedPhase = 0;
  for (let U = 1; U < whole.length; U++) {
    const t = U * num;
    const mid = FROM + Math.floor(t / den);
    const joined = [...whole.slice(0, U), ...phased(mid, t % den, FROM + N - mid)];
    if (joined.length !== whole.length || joined.some((v, i) => v !== whole[i])) movedPhase++;
  }
  results.picture.push({ speed: pct(num, den), split: { cutsTried: whole.length - 1, cutsThatChangeFrames: moved, withPhase: movedPhase } });
  log(pct(num, den).padEnd(8), `${moved} of ${whole.length - 1} cuts change a frame`, at.length ? `(e.g. at u ${at.join(", ")})` : "", `; with a phase: ${movedPhase}`);
}

// ---------- the sound ----------
// The clip's audio from FROM_S for SECONDS of source, sped by s; beep onsets (one per source
// second) against where the source's whole seconds land on the timeline: frame j of the clip
// is on timeline frame ceil(j/s), so second k (j = k·FPS − offset) at time ceil(j/s)/FPS.

function atempoChain(s) {
  // atempo takes 0.5 to 100; below 0.5, chain halves.
  const parts = [];
  while (s < 0.5) { parts.push("atempo=0.5"); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(6)}`);
  return parts.join(",");
}

function beepOnsets(pcm, minGapMs) {
  const win = 48, onsets = [];
  let quiet = Infinity;
  const needQuiet = Math.max(2, Math.floor(minGapMs * 0.6));
  for (let i = 0; i + win <= pcm.length; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) e = Math.max(e, Math.abs(pcm[j]));
    if (e > 3000) {
      if (quiet >= needQuiet) {
        let j = i;
        while (j < i + win && Math.abs(pcm[j]) < 3000) j++;
        onsets.push((j / 48000) * 1000);
      }
      quiet = 0;
    } else quiet++;
  }
  return onsets;
}

const FROM_S = 30, SECONDS = 120; // source seconds 30 to 150
for (const [num, den] of SPEEDS) {
  const s = num / den;
  const out = FROM_S + SECONDS;
  const L = length(SECONDS * FPS, num, den);
  const expected = [];
  for (let k = 1; k < SECONDS; k++) expected.push((Math.ceil((k * FPS * den) / num) / FPS) * 1000);
  // Beeps 1 s of source apart: 1/s s on the timeline.
  const gap = 1000 / s;
  // From the clip's start, or from PRE seconds of source before it, its output trimmed by
  // timestamp to where the clip starts (PRE/s), to see if that cancels the stretcher's lead.
  const PRE = 0.5;
  const plain = (c) => `[0:a:0]atrim=start=${FROM_S}:end=${out},asetpts=PTS-STARTPTS,${c}[a]`;
  const preRoll = (c) =>
    `[0:a:0]atrim=start=${FROM_S - PRE}:end=${out},asetpts=PTS-STARTPTS,${c},atrim=start=${(PRE / s).toFixed(6)},asetpts=PTS-STARTPTS[a]`;
  const rb = `rubberband=tempo=${s.toFixed(6)}`;
  for (const [mode, graph] of [
    ["atempo (pitch kept)", plain(atempoChain(s))],
    ["atempo, pre-roll", preRoll(atempoChain(s))],
    ["rubberband", plain(rb)],
    ["rubberband, pre-roll", preRoll(rb)],
    ["asetrate (tape)", plain(`asetrate=${(48000 * s).toFixed(4)},aresample=48000`)],
  ]) {
    let r;
    try {
      const { out: buf, ms } = ff([
        "-i", SRC, "-vn", "-filter_complex",
        graph,
        "-map", "[a]", "-ac", "1", "-ar", "48000", "-f", "s16le", "-",
      ]);
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
      const onsets = beepOnsets(pcm, gap);
      const off = expected.map((e) => onsets.reduce((b, o) => (Math.abs(o - e) < Math.abs(b - e) ? o : b), Infinity) - e);
      const abs = off.map(Math.abs);
      const lastTen = off.slice(-10);
      // Each beep's energy centroid against its true centre (25 ms of source in): a smear
      // spreads a beep both ways, a shift moves it.
      const cen = expected.map((e) => {
        const a = Math.max(0, Math.floor(((e - gap / 2) / 1000) * 48000));
        const b = Math.min(pcm.length, Math.floor(((e + gap / 2) / 1000) * 48000));
        let w = 0, m = 0;
        for (let i = a; i < b; i++) { const v = pcm[i] * pcm[i]; w += v; m += v * i; }
        return (m / w / 48000) * 1000 - (e + 25 / s);
      });
      const centroidMs = +(cen.reduce((x, y) => x + y, 0) / cen.length).toFixed(2);
      const centroidMaxMs = +Math.max(...cen.map(Math.abs)).toFixed(2);
      r = {
        ms,
        durationMs: +((pcm.length / 48000) * 1000).toFixed(1),
        pictureMs: +((L / FPS) * 1000).toFixed(1),
        beeps: `${onsets.length} found / ${expected.length + 1} expected`,
        meanMs: +(off.reduce((a, b) => a + b, 0) / off.length).toFixed(2),
        maxAbsMs: +Math.max(...abs).toFixed(2),
        endMeanMs: +(lastTen.reduce((a, b) => a + b, 0) / lastTen.length).toFixed(2),
        centroidMs,
        centroidMaxMs,
      };
    } catch (e) {
      r = { error: String(e.message) };
    }
    results.sound.push({ speed: pct(num, den), mode, ...r });
    log(pct(num, den).padEnd(8), mode.padEnd(22), r.error ?? `${r.beeps}; onset ${r.meanMs} ms (max ${r.maxAbsMs}); centroid ${r.centroidMs} ms (max ${r.centroidMaxMs}); length ${r.durationMs} vs picture ${r.pictureMs} ms (${r.ms} ms)`);
  }
}

const dir = join(here, "results");
mkdirSync(dir, { recursive: true });
const file = join(dir, `frames-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(results, null, 2));
log("\n" + file);
