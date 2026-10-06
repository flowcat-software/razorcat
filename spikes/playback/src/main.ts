// The runner: the same measurements for each approach on each media file.
// Results go to spikes/playback/results/run-*.json; internal/spikes/0.2-playback.md says what
// each one means.

import { invoke } from "@tauri-apps/api/core";
import { CodecPlayer, codecString } from "./codecPlayer";
import { type Clip, Media, type MediaEntry, type Player, type Presented, type Probe, type Shown, nextFrame } from "./common";
import { RustPlayer } from "./rustPlayer";
import { VideoPlayer } from "./videoPlayer";

const stage = document.getElementById("stage")!;
const statusEl = document.getElementById("status")!;
const logEl = document.getElementById("log")!;

function log(line: string) {
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
  statusEl.textContent = line;
  void invoke("log_line", { line });
}

const APPROACHES = ["video", "video2", "webcodecs", "rust", "rust-hw", "proxy-gop10", "proxy-intra"] as const;
type Approach = (typeof APPROACHES)[number];

// --- stats

function stats(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, median: r(q(0.5)), p90: r(q(0.9)), max: r(s[s.length - 1]), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
}

/** Frames shown that weren't the one asked for (by barcode when there is one, else by what
 * the player believes it showed). */
function wrong(asked: number[], shown: Shown[]) {
  let bad = 0;
  const examples: string[] = [];
  shown.forEach((s, i) => {
    const got = s.read ?? s.n;
    if (got !== asked[i]) {
      bad++;
      if (examples.length < 5) examples.push(`${asked[i]}→${got}${s.read !== null && s.n !== s.read ? ` (player said ${s.n})` : ""}`);
    }
  });
  return { wrong: bad, examples };
}

async function steps(p: Player, frames: number[]) {
  const shown: Shown[] = [];
  for (const n of frames) shown.push(await p.show(n));
  return {
    latencyMs: stats(shown.map((s) => s.ms)),
    timeouts: shown.filter((s) => s.timedOut).length,
    ...wrong(frames, shown),
  };
}

/** A pointer drag: the target moves `span` frames over `ms`; each new target is shown as soon
 * as the previous show finishes (seeks are coalesced, never queued). */
async function scrub(p: Player, from: number, span: number, ms: number) {
  let target = from;
  let shown = from;
  let busy = false;
  let updates = 0;
  const lags: number[] = [];
  const latencies: number[] = [];
  const pump = async () => {
    busy = true;
    while (shown !== target) {
      const t = target;
      const s = await p.show(t);
      latencies.push(s.ms);
      shown = t;
      updates++;
    }
    busy = false;
  };
  await p.show(from);
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      target = Math.round(from + span * k);
      lags.push(Math.abs(target - shown));
      if (!busy) void pump();
      if (k < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  const settleStart = performance.now();
  while (busy || shown !== target) {
    if (!busy) void pump();
    await nextFrame();
  }
  const framesPerMs = span / ms;
  return {
    spanFrames: span,
    updatesPerSec: Math.round((updates / ms) * 1000 * 10) / 10,
    lagFrames: stats(lags),
    lagMsMedian: Math.round((stats(lags)!.median / framesPerMs) * 10) / 10,
    settleMs: Math.round(performance.now() - settleStart),
    showMs: stats(latencies),
  };
}

async function play(p: Player, m: Media, clips: Clip[]) {
  const ev: Presented[] = [];
  const t0 = performance.now();
  await p.play(clips, (e) => ev.push(e));
  const wall = performance.now() - t0;
  const period = 1000 / m.fps;
  const expected = clips.reduce((s, c) => s + c.out - c.in, 0);
  const id = (e: Presented) => e.read ?? e.n;
  const clipOf = (n: number) => clips.findIndex((c) => n >= c.in && n < c.out);
  const stray = ev.filter((e) => clipOf(id(e)) < 0).map(id);
  let skips = 0;
  let repeats = 0;
  const gaps: number[] = [];
  for (let i = 1; i < ev.length; i++) {
    const a = id(ev[i - 1]);
    const b = id(ev[i]);
    if (clipOf(a) === clipOf(b) && clipOf(a) >= 0) {
      if (b - a > 1) skips += b - a - 1;
      if (b <= a) repeats++;
    }
    gaps.push(ev[i].t - ev[i - 1].t);
  }
  // At each boundary: time from the last frame of clip k to the first of clip k+1, beyond one
  // frame period.
  const boundaries = clips.slice(1).map((c, k) => {
    const lastPrev = ev.findLastIndex((e) => clipOf(id(e)) === k);
    const firstNext = ev.findIndex((e) => clipOf(id(e)) === k + 1);
    if (lastPrev < 0 || firstNext < 0) return null;
    return {
      extraMs: Math.round(ev[firstNext].t - ev[lastPrev].t - period),
      firstFrame: id(ev[firstNext]),
      wantedFirst: c.in,
      strayBetween: ev.slice(lastPrev + 1, firstNext).map(id),
    };
  });
  return {
    expectedFrames: expected,
    presented: ev.length,
    distinct: new Set(ev.map(id)).size,
    stray: stray.length,
    strayExamples: stray.slice(0, 6),
    skippedFrames: skips,
    repeats,
    hitches: gaps.filter((g) => g > period * 1.5).length,
    worstGapMs: Math.round(Math.max(0, ...gaps)),
    wallMs: Math.round(wall),
    idealMs: Math.round(expected * period),
    boundaries,
  };
}

// --- one approach on one media file

function makePlayer(a: Approach, m: Media): Player {
  switch (a) {
    case "video":
    case "proxy-gop10":
    case "proxy-intra":
      return new VideoPlayer(m);
    case "video2":
      return new VideoPlayer(m, true);
    case "webcodecs":
      return new CodecPlayer(m);
    case "rust":
      return new RustPlayer(m, false);
    case "rust-hw":
      return new RustPlayer(m, true);
  }
}

/** Seeded PRNG so every approach gets the same random frames. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

async function suite(a: Approach, m: Media) {
  const N = m.count;
  const fps = m.fps;
  const res: Record<string, unknown> = {};
  const memBefore = await invoke("memory");
  const p = makePlayer(a, m);
  stage.replaceChildren(p.el);
  const t0 = performance.now();
  await p.open();
  res.openMs = Math.round(performance.now() - t0);

  // Positions around a keyframe near 45 %: the hard case is stepping back across it, into the
  // end of the previous GOP.
  const ks = m.keyframes.filter((k) => k > 0);
  const k2 = ks.length ? ks.reduce((best, k) => (Math.abs(k - N * 0.45) < Math.abs(best - N * 0.45) ? k : best)) : Math.floor(N / 2);
  const clampN = (n: number) => Math.max(0, Math.min(N - 1, Math.round(n)));
  const range = (from: number, count: number, step: number) => Array.from({ length: count }, (_, i) => clampN(from + i * step));
  const timed = async <T,>(name: string, f: () => Promise<T>) => {
    try {
      res[name] = await Promise.race([f(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout 120 s")), 120000))]);
    } catch (e) {
      res[name] = { error: String(e) };
    }
    log(`    ${name}: ${JSON.stringify(res[name])}`);
  };

  const onlyClips = a === "video2";
  if (!onlyClips) {
    await timed("stepForward", async () => {
      await p.show(clampN(k2 - 21));
      return steps(p, range(k2 - 20, 40, 1));
    });
    await timed("stepBackward", async () => {
      await p.show(clampN(k2 + 10));
      return steps(p, range(k2 + 9, 40, -1));
    });
    await timed("randomSeek", async () => {
      const r = rng(7);
      return steps(p, Array.from({ length: 25 }, () => clampN(r() * N)));
    });
    await timed("scrubSlow", () => scrub(p, clampN(N * 0.2), Math.min(N * 0.3, 5 * fps), 2000));
    await timed("scrubFast", () => scrub(p, clampN(N * 0.1), Math.min(N * 0.6, 120 * fps), 1500));
    await timed("play", () => play(p, m, [{ in: clampN(N * 0.3), out: clampN(N * 0.3 + Math.min(3 * fps, N * 0.3)) }]));
  }
  // Three 1 s clips: one jumping forward into the middle of a GOP, one back to the start.
  const len = Math.max(2, Math.round(Math.min(fps, N / 8)));
  const clips: Clip[] = [N * 0.15, N * 0.62, N * 0.4].map((s) => ({ in: clampN(s), out: clampN(s) + len }));
  await timed("clips", () => play(p, m, clips));

  res.notes = p.notes();
  res.memory = { before: memBefore, after: await invoke("memory") };
  await p.close();
  return res;
}

// --- capabilities

async function capabilities() {
  const v = document.createElement("video");
  const types: Record<string, string> = {
    avc: 'video/mp4; codecs="avc1.640028"',
    hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
    av1: 'video/mp4; codecs="av01.0.08M.08"',
    vp9: 'video/webm; codecs="vp9"',
    mkv: 'video/x-matroska; codecs="avc1.640028"',
  };
  const canPlay = Object.fromEntries(Object.entries(types).map(([k, t]) => [k, v.canPlayType(t)]));
  const decoder: Record<string, unknown> = {};
  for (const [k, codec] of Object.entries({ avc: "avc1.640028", hevc: "hvc1.1.6.L120.90", av1: "av01.0.08M.08", vp9: "vp09.00.10.08" })) {
    for (const hw of ["prefer-hardware", "prefer-software"] as const) {
      try {
        decoder[`${k}/${hw}`] = (await VideoDecoder.isConfigSupported({ codec, hardwareAcceleration: hw, codedWidth: 1920, codedHeight: 1080 })).supported;
      } catch (e) {
        decoder[`${k}/${hw}`] = String(e);
      }
    }
  }
  return { userAgent: navigator.userAgent, devicePixelRatio, canPlay, decoder };
}

// --- main

async function run() {
  const cfg = await invoke<{ auto: boolean; only: string | null; approaches: string | null; media: MediaEntry[] }>("config");
  const approaches = (cfg.approaches ? cfg.approaches.split(",") : APPROACHES) as Approach[];
  const results: Record<string, unknown> = { startedAt: new Date().toISOString(), caps: await capabilities(), runs: [] };
  log(`caps: ${JSON.stringify(results.caps)}`);
  const runs = results.runs as unknown[];
  for (const entry of cfg.media) {
    if (cfg.only && !cfg.only.split(",").some((o) => entry.label.includes(o))) continue;
    let probe: Probe;
    try {
      probe = await invoke<Probe>("probe_media", { id: entry.id });
    } catch (e) {
      log(`${entry.label}: probe failed: ${e}`);
      continue;
    }
    const m = new Media(entry, probe);
    const info = {
      codec: probe.codec,
      codecString: (() => {
        try {
          return codecString(probe.codec, probe.extradata);
        } catch {
          return null;
        }
      })(),
      size: `${probe.width}x${probe.height}`,
      rotation: probe.rotation,
      fps: m.fps,
      frames: m.count,
      gop: m.keyframes.length > 1 ? Math.round(m.count / m.keyframes.length) : m.count,
      audioTracks: probe.audioTracks,
      probeMs: Math.round(probe.probeMs),
      indexCached: probe.indexCached,
    };
    log(`${entry.label}: ${JSON.stringify(info)}`);
    for (const a of approaches) {
      let media = m;
      const run: Record<string, unknown> = { media: entry.label, approach: a, info };
      try {
        if (a.startsWith("proxy-")) {
          const kind = a.slice("proxy-".length);
          const px = await invoke<{ id: number; ms: number; bytes: number; cached: boolean }>("make_proxy", { id: entry.id, kind });
          run.proxy = { ms: Math.round(px.ms), mb: Math.round(px.bytes / 1048576), cached: px.cached };
          const pe = (await invoke<{ media: MediaEntry[] }>("config")).media.find((e) => e.id === px.id)!;
          media = new Media(pe, await invoke<Probe>("probe_media", { id: px.id }));
        }
        log(`  ${a}…`);
        Object.assign(run, await suite(a, media));
      } catch (e) {
        run.error = String(e);
        log(`  ${a}: ${e}`);
      }
      runs.push(run);
    }
  }
  const path = await invoke<string>("save_results", { json: JSON.stringify(results, null, 2) });
  log(`saved ${path}`);
  if (cfg.auto) await invoke("quit");
}

document.getElementById("run")!.onclick = () => void run();
void invoke<{ auto: boolean }>("config").then((c) => {
  if (c.auto) void run();
  else statusEl.textContent = "ready: press Run";
});
