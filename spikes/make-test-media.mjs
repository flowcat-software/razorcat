// Generates synthetic test clips for the Phase 0 spikes into spikes/media/.
//
// Every clip burns in its frame number and time, so a seek or step can be checked by eye, and
// a barcode of it, so the playback harness can check by itself: if the player says frame 1234,
// the picture must say 1234. Whole seconds flash a white bar in step with a 1 kHz beep, to
// check A/V sync after cuts.
//
// Real clips (OBS recordings and an iPhone clip in D:\obs on Richard's machine) cover real
// encoders; these cover the cases on demand and are reproducible.
//
// Usage (PowerShell, from the repo root):  node spikes/make-test-media.mjs [name ...]
// Needs spikes/.tools/ffmpeg (BtbN's GPL build); see internal/spikes/0.2-playback.md.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ffmpeg = join(here, ".tools", "ffmpeg", "bin", "ffmpeg.exe");
const out = join(here, "media");

// drawtext needs a font file; ':' must be escaped inside a filter graph.
const font = "C\\:/Windows/Fonts/consola.ttf";

// A 16-bit barcode of the frame number along the bottom edge, for the playback harness to
// read: 16 cells, least significant bit on the left, white = 1, on a black strip. Cells are
// large so compression can't blur them. Drawn before any frame dropping (VFR clips), so it
// holds the source frame number.
export const BARCODE = { bits: 16, strip: 1 / 16 };
function barcode() {
  let f = `drawbox=x=0:y=ih-ih/16:w=iw:h=ih/16:color=black:t=fill`;
  for (let k = 0; k < BARCODE.bits; k++) {
    f +=
      `,drawbox=x=${k}*iw/16:y=ih-ih/16:w=iw/16:h=ih/16:color=white:t=fill:` +
      `enable='mod(floor(n/${2 ** k}),2)'`;
  }
  return f;
}

// The picture: a moving test pattern, the frame number and time, a flash on whole seconds,
// and the barcode.
function picture(w, h, fps, seconds) {
  const size = Math.round(Math.min(w, h) / 10);
  return (
    `testsrc2=size=${w}x${h}:rate=${fps}:duration=${seconds},${barcode()},` +
    `drawbox=x=0:y=0:w=iw:h=ih/12:color=white:t=fill:enable='lt(mod(n,${fps}),3)',` +
    `drawtext=fontfile='${font}':fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.8:` +
    `boxborderw=12:x=(w-tw)/2:y=h/2-th:text='frame %{frame_num}',` +
    `drawtext=fontfile='${font}':fontsize=${Math.round(size * 0.6)}:fontcolor=yellow:box=1:` +
    `boxcolor=black@0.8:boxborderw=10:x=(w-tw)/2:y=h/2+th:text='t %{pts}'`
  );
}

// The sound: a 50 ms 1 kHz beep at each whole second.
function beeps(seconds) {
  return `aevalsrc=exprs='if(lt(mod(t,1),0.05),0.5*sin(2*PI*1000*t),0)':s=48000:d=${seconds}`;
}

const lavfi = (graph) => ["-f", "lavfi", "-i", graph];

const clips = {
  // An OBS-like recording: 1080p60, long GOP (x264's default keyint 250, as OBS's "auto"),
  // B-frames, AAC. The case that scrubs slowly.
  "obs-1080p60-10m.mp4": () => [
    ...lavfi(picture(1920, 1080, 60, 600)),
    ...lavfi(beeps(600)),
    ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", "250", "-bf", "2"],
    ...["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest"],
  ],

  // A phone-like clip, H.264 (Android): 30 fps nominal but variable. Frames are dropped
  // unevenly from a 60 fps source, so intervals vary between 1/60 s and 1/20 s. The burned-in
  // number is the source frame, so gaps in it show which frames are missing.
  "phone-h264-vfr.mp4": () => [
    ...lavfi(`${picture(1920, 1080, 60, 30)},select='not(eq(mod(n,5),1))*not(eq(mod(n,7),3))'`),
    ...lavfi(beeps(30)),
    ...["-fps_mode", "vfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20"],
    ...["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest"],
  ],

  // A phone-like clip, HEVC (iPhone): VFR as above, tagged hvc1. Drawn portrait, stored
  // turned clockwise into landscape with a rotation flag (the rotate pass below), as a phone
  // does: it only looks upright if the player honours the flag.
  "phone-hevc-vfr-rotated.mp4": () => [
    ...lavfi(
      `${picture(1080, 1920, 60, 30)},select='not(eq(mod(n,5),1))*not(eq(mod(n,7),3))',` +
        `transpose=clock`,
    ),
    ...lavfi(beeps(30)),
    ...["-fps_mode", "vfr", "-c:v", "libx265", "-preset", "fast", "-crf", "24", "-tag:v", "hvc1"],
    ...["-x265-params", "log-level=error"],
    ...["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest"],
  ],

  // MKV, which opens by remuxing to MP4.
  "short-h264.mkv": () => [
    ...lavfi(picture(1280, 720, 30, 20)),
    ...lavfi(beeps(20)),
    ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"],
    ...["-c:a", "aac", "-shortest"],
  ],

  // No audio track: the app must show no audio UI and export none.
  "no-audio-720p30.mp4": () => [
    ...lavfi(picture(1280, 720, 30, 15)),
    ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"],
  ],

  // A GIF in.
  "small.gif": () => [
    ...lavfi(`${picture(480, 270, 15, 5)},split[a][b];[a]palettegen[p];[b][p]paletteuse`),
  ],
};

// Clips that get a second pass: a display rotation added without re-encoding.
const rotate = { "phone-hevc-vfr-rotated.mp4": 90 };

function run(args) {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status})`);
}

if (!existsSync(ffmpeg)) {
  console.error(`No ffmpeg at ${ffmpeg}. See internal/spikes/0.2-playback.md › Setup.`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });

const wanted = process.argv.slice(2);
for (const name of wanted.length ? wanted : Object.keys(clips)) {
  if (!clips[name]) throw new Error(`Unknown clip ${name}`);
  const dest = join(out, name);
  const started = Date.now();
  process.stdout.write(`${name} … `);
  // Written to a temporary name first, so an interrupted run never leaves a half clip.
  const tmp = join(out, `tmp-${name}`);
  run([...clips[name](), tmp]);
  if (rotate[name] !== undefined) {
    run(["-display_rotation", String(rotate[name]), "-i", tmp, "-c", "copy", dest]);
    rmSync(tmp);
  } else {
    renameSync(tmp, dest);
  }
  console.log(`${((Date.now() - started) / 1000).toFixed(1)} s`);
}
