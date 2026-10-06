// Spike 0.3: export. Renders one edit (three clips reordered, a crop, a grow, two fading PNG
// overlays, audio) with ffmpeg and each candidate encoder, then measures it:
//   exact    every frame by its barcode (synthetic clip), and A/V sync from the beeps
//   speed    wall time for a 30 s edit and a 5 min one (Richard's OBS recording)
//   quality  VMAF against a lossless render, at matched bitrates
//   gif      ffmpeg palettegen/paletteuse against gifski: size, SSIM, time
// Usage (PowerShell, repo root): node spikes/export/run.mjs [exact|speed|quality|gif ...]
// Results: spikes/export/results/*.json (gitignored) and a summary on stdout.
// See internal/spikes/0.3-export.md.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tools = join(here, "..", ".tools");
const FF = join(tools, "ffmpeg", "bin", "ffmpeg.exe");
const FP = join(tools, "ffmpeg", "bin", "ffprobe.exe");
const GIFSKI = join(tools, "gifski", "win", "gifski.exe");
const out = join(here, "out");
const resultsDir = join(here, "results");
mkdirSync(out, { recursive: true });
mkdirSync(resultsDir, { recursive: true });

const SYNTH = join(here, "..", "media", "obs-1080p60-10m.mp4");
const local = join(here, "..", "playback", "media.local.json");
const OBS = existsSync(local)
  ? JSON.parse(readFileSync(local, "utf8")).find((m) => /31m/.test(m.label))?.path
  : null;

function run(cmd, args, opts = {}) {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 30, ...opts });
  const ms = performance.now() - t0;
  if (r.status !== 0) {
    const err = String(r.stderr || "").trim().split("\n").slice(-4).join(" | ");
    return { ok: false, ms, err, stdout: r.stdout };
  }
  return { ok: true, ms, stdout: r.stdout, stderr: String(r.stderr || "") };
}
const ff = (args, opts) => run(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args], opts);

// ---------- the candidates ----------
const ENCODERS = {
  "x264-veryfast": (br) => ["-c:v", "libx264", "-preset", "veryfast", ...(br ? ["-b:v", br, "-maxrate", br, "-bufsize", br] : ["-crf", "20"])],
  "x264-medium": (br) => ["-c:v", "libx264", "-preset", "medium", ...(br ? ["-b:v", br, "-maxrate", br, "-bufsize", br] : ["-crf", "20"])],
  nvenc: (br) => ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", ...(br ? ["-rc", "vbr", "-b:v", br, "-maxrate", br, "-bufsize", br] : ["-rc", "vbr", "-cq", "21", "-b:v", "0"])],
  mf: (br) => ["-c:v", "h264_mf", "-hw_encoding", "1", ...(br ? ["-b:v", br] : ["-rate_control", "quality", "-quality", "70"])],
  amf: (br) => ["-c:v", "h264_amf", ...(br ? ["-b:v", br] : ["-rc", "cqp", "-qp_i", "20", "-qp_p", "22"])],
  qsv: (br) => ["-c:v", "h264_qsv", ...(br ? ["-b:v", br] : ["-global_quality", "22"])],
};

// ---------- the edit ----------
function probe(file) {
  const r = run(FP, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,width,height", "-of", "json", file]);
  const s = JSON.parse(r.stdout).streams[0];
  const [a, b] = s.r_frame_rate.split("/").map(Number);
  return { fps: a / b, w: s.width, h: s.height };
}

/** Two transparent overlays, standing in for the webview's rendered markup. Each is rasterized at
 * its bounding box (not the whole frame) and placed at x, y, as the app would do: a full-frame
 * RGBA overlay costs a frame-sized blend and fade on every frame. */
function overlays(w, h) {
  const font = "C\\:/Windows/Fonts/impact.ttf";
  const bw = Math.round(w * 0.6), bh = Math.round(h * 0.13);
  const make = (name, text, y) => {
    const p = join(out, name);
    if (!existsSync(p))
      ff(["-f", "lavfi", "-i", `color=c=black@0.0:s=${bw}x${bh},format=rgba,drawtext=fontfile='${font}':text='${text}':fontsize=${Math.round(h / 10)}:fontcolor=white:borderw=6:bordercolor=black:x=(w-tw)/2:y=(h-th)/2`, "-frames:v", "1", p]);
    return { path: p, x: Math.round((w - bw) / 2), y };
  };
  return [make(`ov1-${bw}x${bh}.png`, "WAIT FOR IT", Math.round(h * 0.02)), make(`ov2-${bw}x${bh}.png`, "THERE IT IS", Math.round(h * 0.2))];
}

/**
 * The ffmpeg arguments for an edit. Each clip is its own input, seeked accurately to half a frame
 * before its first frame (so rounding can't land on a neighbour), then trimmed by frame count;
 * audio is trimmed by the same half frame and duration. Then concat, crop, pad (grow), and the
 * overlays with alpha fades, enabled by output frame number.
 */
function editArgs(src, { fps, w }, clips, crop, growTop, ovs, ovTimes, grid = null) {
  const args = [];
  clips.forEach(([a]) => args.push("-ss", ((a - 0.5) / fps).toFixed(6), "-i", src));
  const total = clips.reduce((s, [a, b]) => s + b - a, 0);
  // Each overlay PNG is decoded once and repeated in the graph (`-loop 1` re-decodes it every frame).
  ovs.forEach((o) => args.push("-i", o.path));
  const f = [];
  clips.forEach(([a, b], i) => {
    f.push(`[${i}:v:0]trim=end_frame=${b - a},setpts=PTS-STARTPTS[v${i}]`);
    f.push(`[${i}:a:0]atrim=start=${(0.5 / fps).toFixed(6)}:duration=${((b - a) / fps).toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`);
  });
  f.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${clips.length}:v=1:a=1[vc][ac]`);
  const outH = crop.h + growTop;
  // grid: VFR sources are put on the timeline's constant-rate grid (decision B, 2026-10-06)
  f.push(`[vc]${grid ? `fps=${grid},` : ""}crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},pad=${crop.w}:${outH}:0:${growTop}:color=black[g0]`);
  ovTimes.forEach(([s, e, fi, fo], k) => {
    const n = clips.length + k;
    // converted to YUV with alpha once, then repeated: no per-frame RGB conversion
    f.push(`[${n}:v]format=yuva420p,loop=loop=${total - 1}:size=1:start=0,setpts=N/(${fps}*TB),fade=t=in:st=${(s / fps).toFixed(6)}:d=${(fi / fps).toFixed(6)}:alpha=1,fade=t=out:st=${((e - fo) / fps).toFixed(6)}:d=${(fo / fps).toFixed(6)}:alpha=1[o${k}]`);
    f.push(`[g${k}][o${k}]overlay=${ovs[k].x}:${ovs[k].y}:format=yuv420:enable='between(n,${s},${e - 1})'[g${k + 1}]`);
  });
  args.push("-filter_complex", f.join(";"), "-map", `[g${ovTimes.length}]`, "-map", "[ac]");
  return { args, total, outW: crop.w, outH, w };
}

function encode(edit, enc, br, file, extra = []) {
  // Media Foundation, AMF and QSV want NV12 frames
  const pix = ["mf", "amf", "qsv"].includes(enc) ? "nv12" : "yuv420p";
  const a = [...edit.args, ...ENCODERS[enc](br), "-pix_fmt", pix, "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", ...extra, file];
  const r = ff(a);
  return { ...r, mb: r.ok ? statSync(file).size / 1048576 : null };
}

// ---------- checks ----------
/** Reads the 16-bit barcode (synthetic clips) from a row of every frame. */
function readBarcodes(file, row, width) {
  // gray first: a 1-row crop of yuv420p rounds to 0 rows
  const r = ff(["-i", file, "-vf", `format=gray,crop=${width}:1:0:${row}`, "-f", "rawvideo", "-"]);
  const buf = r.stdout, cell = width / 16, frames = [];
  for (let o = 0; o + width <= buf.length; o += width) {
    let n = 0;
    for (let k = 0; k < 16; k++) if (buf[o + Math.round(k * cell + cell / 2)] > 128) n |= 1 << k;
    frames.push(n);
  }
  return frames;
}

/** Beep onsets (1 kHz, 50 ms, at each whole second of the source) in the output audio, in ms. */
function beepOnsets(file) {
  const r = ff(["-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"]);
  const pcm = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 1);
  const win = 48, onsets = [];
  let quiet = 0;
  for (let i = 0; i + win <= pcm.length; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) e = Math.max(e, Math.abs(pcm[j]));
    if (e > 3000) {
      if (quiet >= 100) {
        // refine to the first loud sample
        let j = i; while (j < i + win && Math.abs(pcm[j]) < 3000) j++;
        onsets.push((j / 48000) * 1000);
      }
      quiet = 0;
    } else quiet++;
  }
  return onsets;
}

function checkExact(file, edit, clips, fps) {
  // Output row through the middle of the barcode strip: source strip y in [h*15/16, h) shifted by
  // the crop and the grow.
  const srcH = 1080, stripMid = Math.round(srcH - srcH / 32);
  const row = stripMid - CROP.y + GROW;
  const got = readBarcodes(file, row, edit.outW);
  const want = clips.flatMap(([a, b]) => Array.from({ length: b - a }, (_, i) => a + i));
  let wrong = 0;
  const examples = [];
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] !== want[i]) { wrong++; if (examples.length < 6) examples.push(`#${i}: want ${want[i]} got ${got[i]}`); }
  }
  // A/V: expected beep onsets are output frames whose source frame is a whole second; skip ones
  // within 3 frames of a cut (a clip can start mid-beep).
  const cuts = [];
  let t = 0;
  for (const [a, b] of clips) { cuts.push(t); t += b - a; }
  const expected = [];
  want.forEach((n, i) => { if (n % fps === 0 && !cuts.some((c) => i >= c && i < c + 3)) expected.push((i / fps) * 1000); });
  const onsets = beepOnsets(file);
  const offsets = expected.map((e) => {
    const near = onsets.reduce((best, o) => (Math.abs(o - e) < Math.abs(best - e) ? o : best), Infinity);
    return near - e;
  });
  const abs = offsets.map(Math.abs);
  return {
    frames: got.length, expected: want.length, wrongFrames: wrong, examples,
    beeps: expected.length, avOffsetMs: { mean: +(offsets.reduce((a, b) => a + b, 0) / offsets.length).toFixed(2), maxAbs: +Math.max(...abs).toFixed(2) },
  };
}

/** VMAF against the lossless reference. Frames are paired by index, not timestamp: the MKV
 * reference rounds timestamps to whole ms, and pairing by time then matched every third frame
 * of a 30 fps edit with its neighbour (the first runs' scores were wrong for that reason). */
function vmaf(file, ref, fps) {
  const g = `[0:v]setpts=N/(${fps}*TB)[d];[1:v]setpts=N/(${fps}*TB)[r];[d][r]libvmaf=n_threads=16`;
  const r = run(FF, ["-hide_banner", "-i", file, "-i", ref, "-lavfi", g, "-f", "null", "-"], { encoding: "utf8" });
  const m = /VMAF score: ([\d.]+)/.exec(r.stderr || "");
  return m ? +(+m[1]).toFixed(2) : null;
}

// ---------- stages ----------
const CROP = { x: 0, y: 180, w: 1920, h: 900 }; // crop the top (keeps the barcode at the bottom)
const GROW = 160; // a black bar on top
const results = { at: new Date().toISOString() };
const stages = process.argv.slice(2).length ? process.argv.slice(2) : ["exact", "speed", "quality", "gif"];
const log = (...a) => console.log(...a);

if (stages.includes("exact")) {
  log("\n== exact: synthetic 1080p60, three clips reordered, crop, grow, two fading overlays");
  const p = probe(SYNTH), fps = Math.round(p.fps);
  // forward into mid-GOP, far forward, then back; lengths 10 s each
  const clips = [[1234, 1834], [20017, 20617], [7777, 8377]];
  const ovs = overlays(CROP.w, CROP.h + GROW);
  const edit = editArgs(SYNTH, p, clips, CROP, GROW, ovs, [[60, 360, 15, 30], [550, 1200, 20, 20]]);
  results.exact = {};
  for (const enc of Object.keys(ENCODERS)) {
    const file = join(out, `exact-${enc}.mp4`);
    const r = encode(edit, enc, null, file);
    if (!r.ok) { results.exact[enc] = { error: r.err }; log(`  ${enc}: unavailable (${r.err.slice(0, 90)})`); continue; }
    const c = checkExact(file, edit, clips, fps);
    results.exact[enc] = { ms: Math.round(r.ms), mb: +r.mb.toFixed(1), x: +((edit.total / fps) * 1000 / r.ms).toFixed(1), ...c };
    log(`  ${enc}: ${Math.round(r.ms)} ms (${results.exact[enc].x}× real time), ${r.mb.toFixed(1)} MB, frames ${c.frames}/${c.expected}, wrong ${c.wrongFrames}${c.examples.length ? " " + c.examples.join("; ") : ""}, A/V mean ${c.avOffsetMs.mean} ms max ${c.avOffsetMs.maxAbs} ms over ${c.beeps} beeps`);
  }
}

if (stages.includes("speed") && OBS) {
  log("\n== speed: Richard's OBS recording (1080p30): a 30 s edit and a 5 min one, crop, grow, overlays");
  const p = probe(OBS);
  const ovs = overlays(CROP.w, CROP.h + GROW);
  const cases = {
    "30s": [[3000, 3300], [30000, 30300], [12000, 12300]],
    "5min": [[6000, 15000]],
  };
  results.speed = {};
  for (const [name, clips] of Object.entries(cases)) {
    const edit = editArgs(OBS, p, clips, CROP, GROW, ovs, [[30, 180, 8, 15], [200, 280, 10, 10]]);
    for (const enc of ["x264-veryfast", "x264-medium", "nvenc", "mf"]) {
      const file = join(out, `speed-${name}-${enc}.mp4`);
      const r = encode(edit, enc, null, file);
      const x = r.ok ? +((edit.total / p.fps) * 1000 / r.ms).toFixed(1) : null;
      results.speed[`${name}/${enc}`] = r.ok ? { ms: Math.round(r.ms), x, mb: +r.mb.toFixed(1) } : { error: r.err };
      log(`  ${name} ${enc}: ${r.ok ? `${(r.ms / 1000).toFixed(1)} s (${x}× real time), ${r.mb.toFixed(1)} MB` : r.err}`);
      if (name === "5min") rmSync(file, { force: true });
    }
  }
}

if (stages.includes("quality") && OBS) {
  log("\n== quality: VMAF against a lossless render of the same 30 s edit (OBS content), matched bitrates");
  const p = probe(OBS);
  const ovs = overlays(CROP.w, CROP.h + GROW);
  const clips = [[3000, 3300], [30000, 30300], [12000, 12300]];
  const edit = editArgs(OBS, p, clips, CROP, GROW, ovs, [[30, 180, 8, 15], [200, 280, 10, 10]]);
  const ref = join(out, "quality-ref.mkv");
  if (!existsSync(ref)) ff([...edit.args, "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "copy", ref].map((a) => (a === "copy" ? "pcm_s16le" : a)));
  results.quality = {};
  for (const br of ["2M", "4M", "8M"]) {
    for (const enc of ["x264-veryfast", "x264-medium", "nvenc", "mf"]) {
      const file = join(out, `q-${br}-${enc}.mp4`);
      const r = encode(edit, enc, br, file);
      if (!r.ok) { results.quality[`${br}/${enc}`] = { error: r.err }; continue; }
      const v = vmaf(file, ref, Math.round(p.fps));
      results.quality[`${br}/${enc}`] = { vmaf: v, mb: +r.mb.toFixed(2), ms: Math.round(r.ms) };
      log(`  ${br} ${enc}: VMAF ${v}, ${r.mb.toFixed(1)} MB`);
    }
  }
}

if (stages.includes("gif") && OBS) {
  log("\n== gif: 6 s of the OBS recording at 640 px wide, ffmpeg palette against gifski");
  const p = probe(OBS);
  const start = (12000 / p.fps).toFixed(3);
  results.gif = {};
  for (const fps of [10, 20, 25]) {
    const src = join(out, `gif-src-${fps}.y4m`);
    ff(["-ss", start, "-t", "6", "-i", OBS, "-vf", `fps=${fps},scale=640:-2:flags=lanczos`, "-pix_fmt", "yuv420p", src]);
    const a = join(out, `gif-ffmpeg-${fps}.gif`);
    const ra = ff(["-i", src, "-vf", "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle", a]);
    const b = join(out, `gif-gifski-${fps}.gif`);
    const rb = run(GIFSKI, ["--quality", "90", "--fps", String(fps), "-o", b, src]);
    const ssim = (gif) => {
      const r = run(FF, ["-hide_banner", "-i", gif, "-i", src, "-lavfi", "[0:v]format=yuv420p,setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
      const m = /All:([\d.]+)/.exec(r.stderr || "");
      return m ? +(+m[1]).toFixed(4) : null;
    };
    const frames = (gif) => Number(String(run(FP, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", gif]).stdout).trim());
    for (const [name, r, file] of [["ffmpeg", ra, a], ["gifski", rb, b]]) {
      if (!r.ok) { results.gif[`${fps}/${name}`] = { error: r.err }; log(`  ${fps} fps ${name}: ${r.err}`); continue; }
      const res = { ms: Math.round(r.ms), kb: Math.round(statSync(file).size / 1024), ssim: ssim(file), frames: frames(file) };
      results.gif[`${fps}/${name}`] = res;
      log(`  ${fps} fps ${name}: ${res.ms} ms, ${res.kb} KB, SSIM ${res.ssim}, ${res.frames} frames`);
    }
  }
}

// The OBS segment is mostly a still screen: every encoder scores ~97 and undershoots its bitrate,
// so quality and GIFs are also measured on real motion, Richard's iPhone clip (1080x1920 after
// rotation). No crop or grow; cuts and overlays only.
const PHONE = existsSync(local) ? JSON.parse(readFileSync(local, "utf8")).find((m) => /iphone/i.test(m.label))?.path : null;
if (stages.includes("phone") && PHONE) {
  log("\n== quality on motion: Richard's iPhone clip, two cuts, overlays, VMAF against lossless");
  const p = { fps: 30, w: 1080, h: 1920 };
  const ovs = overlays(1080, 1920);
  const clips = [[30, 330], [400, 700]];
  const edit = editArgs(PHONE, p, clips, { x: 0, y: 0, w: 1080, h: 1920 }, 0, ovs, [[30, 180, 8, 15], [320, 450, 10, 10]], 30);
  const ref = join(out, "phone-ref-grid.mkv");
  if (!existsSync(ref)) ff([...edit.args, "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", ref]);
  results.phone = {};
  for (const br of ["3M", "6M", "12M"]) {
    for (const enc of ["x264-veryfast", "x264-medium", "nvenc", "mf"]) {
      const file = join(out, `p-${br}-${enc}.mp4`);
      const r = encode(edit, enc, br, file);
      if (!r.ok) { results.phone[`${br}/${enc}`] = { error: r.err }; log(`  ${br} ${enc}: ${r.err}`); continue; }
      const v = vmaf(file, ref, Math.round(p.fps));
      results.phone[`${br}/${enc}`] = { vmaf: v, mb: +r.mb.toFixed(2), ms: Math.round(r.ms) };
      log(`  ${br} ${enc}: VMAF ${v}, ${r.mb.toFixed(1)} MB, ${(r.ms / 1000).toFixed(1)} s`);
    }
  }
  log("\n== gif on motion: 6 s of the iPhone clip at 480 px wide");
  results.phoneGif = {};
  for (const fps of [10, 20, 25]) {
    const src = join(out, `pgif-src-${fps}.y4m`);
    ff(["-ss", "8", "-t", "6", "-i", PHONE, "-vf", `fps=${fps},scale=480:-2:flags=lanczos`, "-pix_fmt", "yuv420p", src]);
    const a = join(out, `pgif-ffmpeg-${fps}.gif`), b = join(out, `pgif-gifski-${fps}.gif`);
    const ra = ff(["-i", src, "-vf", "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle", a]);
    const rb = run(GIFSKI, ["--quality", "90", "--fps", String(fps), "-o", b, src]);
    const c = join(out, `pgif-gifski100-${fps}.gif`);
    const rc = run(GIFSKI, ["--quality", "100", "--fps", String(fps), "-o", c, src]);
    for (const [name, r, file] of [["ffmpeg", ra, a], ["gifski", rb, b], ["gifski-q100", rc, c]]) {
      if (!r.ok) { log(`  ${fps} fps ${name}: ${r.err}`); continue; }
      const m = /All:([\d.]+)/.exec(run(FF, ["-hide_banner", "-i", file, "-i", src, "-lavfi", "[0:v]format=yuv420p,setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" }).stderr || "");
      const res = { ms: Math.round(r.ms), kb: Math.round(statSync(file).size / 1024), ssim: m ? +(+m[1]).toFixed(4) : null };
      results.phoneGif[`${fps}/${name}`] = res;
      log(`  ${fps} fps ${name}: ${res.ms} ms, ${res.kb} KB, SSIM ${res.ssim}`);
    }
  }
}

const f = join(resultsDir, `run-${Date.now()}.json`);
writeFileSync(f, JSON.stringify(results, null, 2));
log(`\nsaved ${f}`);
