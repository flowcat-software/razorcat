// Spike SP0, part B (PLAN §7, Clip speed): `<video>` at clip speeds in Chromium. Edge's build is
// the WebView2 runtime's (both 155.0.4283.62 on 2026-10-24), so headless Edge with its own
// throwaway profile stands in for WebView2; SP3 confirms in the app. Measured:
// - which `playbackRate`s are allowed;
// - whether sound plays at each rate, and its pitch with `preservesPitch` on and off (a 440 Hz
//   tone through Web Audio into a silent output: nothing is heard);
// - `requestVideoFrameCallback` while playing fast: pictures a second, whether the media clock
//   keeps the rate, how far apart the pictures shown are, frames dropped.
//
// Run from the repo root: node spikes/speed/playback.mjs  (results in spikes/speed/results/)

import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FF = join(here, "..", ".tools", "ffmpeg", "bin", "ffmpeg.exe");
const MEDIA = join(here, "..", "media");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const HEADED = process.env.SPIKE_HEADED === "1";

// The tone: 20 s, 720p30, a steady 440 Hz.
const TONE = join(MEDIA, "tone-440-720p30.mp4");
if (!existsSync(TONE)) {
  const r = spawnSync(FF, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=20",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=20",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", TONE,
  ]);
  if (r.status !== 0) throw new Error(String(r.stderr));
}

const local = join(here, "..", "playback", "media.local.json");
const files = {
  "tone.mp4": TONE,
  "obs-synth.mp4": join(MEDIA, "obs-1080p60-10m.mp4"),
};
if (existsSync(local)) {
  const real = JSON.parse(readFileSync(local, "utf8")).find((m) => m.label === "obs 1080p30 31m");
  if (real && existsSync(real.path)) files["obs-real.mp4"] = real.path;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>speed spike</title><body>
<script>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (el, ev) => new Promise((r) => el.addEventListener(ev, r, { once: true }));
async function load(src) {
  const v = document.createElement("video");
  v.preload = "auto"; v.src = src; v.width = 640; document.body.append(v);
  await once(v, "loadeddata");
  return v;
}
async function seekTo(v, t) { v.currentTime = t; await once(v, "seeked"); }

window.rates = async () => {
  const v = await load("/tone.mp4");
  const out = {};
  for (const r of [-1, 0, 0.01, 0.05, 0.0625, 0.07, 0.1, 0.25, 4, 10, 16, 16.1, 32]) {
    try { v.playbackRate = r; out[r] = v.playbackRate === r ? "ok" : "became " + v.playbackRate; }
    catch (e) { out[r] = e.name; }
  }
  v.remove();
  return out;
};

window.audio = async () => {
  const v = await load("/tone.mp4");
  const ctx = new AudioContext();
  await ctx.resume();
  const an = ctx.createAnalyser();
  an.fftSize = 32768;
  const mute = ctx.createGain(); mute.gain.value = 0;
  ctx.createMediaElementSource(v).connect(an); an.connect(mute); mute.connect(ctx.destination);
  const bins = new Float32Array(an.frequencyBinCount), wave = new Float32Array(an.fftSize);
  const out = [];
  for (const pp of [true, false]) {
    for (const r of [0.0625, 0.1, 0.2, 0.25, 0.3, 0.5, 1, 2, 3, 4, 4.5, 5, 8, 16]) {
      v.preservesPitch = pp; v.playbackRate = r;
      await seekTo(v, 1);
      await v.play();
      await sleep(900);
      an.getFloatFrequencyData(bins); an.getFloatTimeDomainData(wave);
      v.pause();
      let peak = 0;
      for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
      let e = 0; for (const s of wave) e += s * s;
      const rms = Math.sqrt(e / wave.length);
      out.push({ preservesPitch: pp, rate: r, rmsDb: +(20 * Math.log10(rms + 1e-12)).toFixed(1),
        peakHz: +((peak * ctx.sampleRate) / an.fftSize).toFixed(1) });
    }
  }
  v.remove(); await ctx.close();
  return out;
};

// preservesPitch = false on a fresh element, set before it loads, and set again after play.
window.pitchOff = async () => {
  const out = [];
  for (const when of ["before load", "after play"]) {
    for (const r of [0.5, 2, 3]) {
      const v = document.createElement("video");
      if (when === "before load") v.preservesPitch = false;
      v.src = "/tone.mp4"; document.body.append(v);
      await once(v, "loadeddata");
      const ctx = new AudioContext(); await ctx.resume();
      const an = ctx.createAnalyser(); an.fftSize = 32768;
      const mute = ctx.createGain(); mute.gain.value = 0;
      ctx.createMediaElementSource(v).connect(an); an.connect(mute); mute.connect(ctx.destination);
      v.playbackRate = r;
      await v.play();
      if (when === "after play") { await sleep(300); v.preservesPitch = false; }
      await sleep(900);
      const bins = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(bins);
      let peak = 0; for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
      out.push({ when, rate: r, preservesPitch: v.preservesPitch, peakHz: +((peak * ctx.sampleRate) / an.fftSize).toFixed(1) });
      v.pause(); v.remove(); await ctx.close();
    }
  }
  return out;
};

window.frames = async (src, fps, start, rates, seconds) => {
  const v = await load(src);
  const out = [];
  for (const r of rates) {
    await seekTo(v, start);
    v.playbackRate = r;
    const seen = [];
    let going = true;
    const cb = (now, m) => { seen.push({ now, media: m.mediaTime, presented: m.presentedFrames }); if (going) v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb);
    const q0 = v.getVideoPlaybackQuality();
    const t0 = performance.now();
    await v.play();
    await sleep(seconds * 1000);
    going = false; v.pause();
    const q1 = v.getVideoPlaybackQuality();
    const wall = (performance.now() - t0) / 1000;
    const s = seen.slice(2); // past the start-up
    const span = (s.at(-1).now - s[0].now) / 1000;
    const steps = s.slice(1).map((x, i) => Math.round((x.media - s[i].media) * fps));
    steps.sort((a, b) => a - b);
    out.push({
      rate: r,
      picturesPerSecond: +(s.length / span).toFixed(1),
      keptRate: +(((s.at(-1).media - s[0].media) / span) / r).toFixed(3),
      stepMedian: steps[steps.length >> 1], stepMax: steps.at(-1),
      dropped: q1.droppedVideoFrames - q0.droppedVideoFrames,
      decoded: q1.totalVideoFrames - q0.totalVideoFrames,
      wall: +wall.toFixed(2),
      startMs: Math.round(seen[0] ? seen[0].now - t0 : -1),
    });
  }
  v.remove();
  return out;
};
window.ready = true;
</script>`;

// ---------- the server ----------
const server = createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  if (name === "") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGE); }
  const path = files[name];
  if (!path) { res.writeHead(404); return res.end(); }
  const size = statSync(path).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (!m) {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": size, "accept-ranges": "bytes" });
    return createReadStream(path).pipe(res);
  }
  const a = m[1] ? +m[1] : 0, b = m[2] ? +m[2] : size - 1;
  res.writeHead(206, { "content-type": "video/mp4", "content-length": b - a + 1, "content-range": `bytes ${a}-${b}/${size}`, "accept-ranges": "bytes" });
  createReadStream(path, { start: a, end: b }).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

// ---------- Edge, its own profile, closed when done ----------
const profile = join(tmpdir(), `razorcat-speed-spike-${Date.now()}`);
const PORT = 9300 + Math.floor(Math.random() * 600);
const edge = spawn(EDGE, [
  ...(HEADED ? ["--window-position=0,0", "--window-size=800,600"] : ["--headless=new"]),
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  "--no-first-run", "--no-default-browser-check", "--mute-audio",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-features=CalculateNativeWinOcclusion", "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
  url,
], { stdio: "ignore" });
const quit = () => { try { spawnSync("taskkill", ["/T", "/F", "/PID", String(edge.pid)]); } catch {} server.close(); };
process.on("exit", quit);

let target;
for (let i = 0; i < 100 && !target; i++) {
  await new Promise((r) => setTimeout(r, 200));
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page" && t.url.startsWith(url));
  } catch {}
}
if (!target) { console.error("Edge didn't come up"); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
async function evaluate(expr) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  const m = await new Promise((r) => pending.set(id, r));
  if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400));
  return m.result.result.value;
}
while (!(await evaluate("window.ready === true"))) await new Promise((r) => setTimeout(r, 100));

const results = { at: new Date().toISOString(), headed: HEADED, userAgent: await evaluate("navigator.userAgent") };
console.log(results.userAgent);
results.rates = await evaluate("rates()");
console.log("rates:", results.rates);
results.audio = await evaluate("audio()");
console.table(results.audio);
results.pitchOff = await evaluate("pitchOff()");
console.table(results.pitchOff);
if (process.env.SPIKE_ONLY === "pitch") { quit(); process.exit(0); }
const RATES = [1, 2, 4, 8, 10, 16];
results.frames = {};
for (const [name, fps, start] of [["obs-synth.mp4", 60, 120], ["obs-real.mp4", 30, 300], ["tone.mp4", 30, 1]]) {
  if (!files[name]) continue;
  results.frames[name] = await evaluate(`frames("/${name}", ${fps}, ${start}, ${JSON.stringify(RATES)}, 3)`);
  console.log(name);
  console.table(results.frames[name]);
}
const dir = join(here, "results");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `playback-${HEADED ? "headed" : "headless"}-${Date.now()}.json`), JSON.stringify(results, null, 2));
ws.close();
quit();
process.exit(0);
