import { spawnSync } from "node:child_process";
const FF = "spikes/.tools/ffmpeg/bin/ffmpeg.exe", SRC = "spikes/media/obs-1080p60-10m.mp4";
const W = 1920, row = Math.round(1080 - 1080 / 32);
for (const [num, den, p] of [[2, 3, 1], [2, 3, 2], [1, 10, 7], [3, 2, 1], [7, 3, 2], [3333, 10000, 9999]]) {
  const from = 601, n = 301, L = Math.ceil((n * den - p) / num);
  const g = `[0:v:0]fps=60/1,trim=start_pts=${from}:end_pts=${from + n},setpts=PTS-STARTPTS,setpts='max(0,ceil((N*${den}-${p})/${num}))',fps=60/1,trim=end_frame=${L},format=gray,crop=${W}:1:0:${row}[o]`;
  const r = spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-i", SRC, "-filter_complex", g, "-map", "[o]", "-f", "rawvideo", "-"], { maxBuffer: 2 ** 31 });
  const b = r.stdout, got = [];
  for (let o = 0; o + W <= b.length; o += W) { let v = 0; for (let k = 0; k < 16; k++) if (b[o + Math.round(k * W / 16 + W / 32)] > 128) v |= 1 << k; got.push(v); }
  let wrong = 0;
  for (let u = 0; u < L; u++) if (got[u] !== from + Math.floor((u * num + p) / den)) wrong++;
  console.log(`${num}/${den} phase ${p}: ${got.length}/${L} frames, ${wrong} wrong`);
}
