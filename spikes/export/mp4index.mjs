// Spike 0.3: how fast can the video packet index (what ffprobe -show_packets gives: per frame
// pts, dts, offset, size, keyframe) come from the MP4's own moov box, without reading the file?
// A minimal box walker, enough to time it and check it against ffprobe; the app would use a
// Rust crate or a small parser of its own.
// Usage (PowerShell): node spikes/export/mp4index.mjs <file.mp4> [--check]

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const file = process.argv[2];
const t0 = performance.now();
const fd = openSync(file, "r");
const size = fstatSync(fd).size;
const read = (pos, len) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, pos); return b; };

// top-level boxes: only headers are read, so a moov at the end costs a few seeks
let pos = 0, moov = null;
while (pos < size) {
  const h = read(pos, 16);
  let len = h.readUInt32BE(0); const type = h.toString("latin1", 4, 8);
  let hdr = 8;
  if (len === 1) { len = Number(h.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = size - pos;
  if (type === "moov") { moov = read(pos, len); break; }
  pos += len;
}
closeSync(fd);
const tRead = performance.now();

function* boxes(b, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let len = b.readUInt32BE(p); const type = b.toString("latin1", p + 4, p + 8); let hdr = 8;
    if (len === 1) { len = Number(b.readBigUInt64BE(p + 8)); hdr = 16; }
    yield { type, start: p + hdr, end: p + len };
    p += len;
  }
}
const find = (b, s, e, path) => {
  if (!path.length) return { start: s, end: e };
  for (const x of boxes(b, s, e)) if (x.type === path[0]) { const r = find(b, x.start, x.end, path.slice(1)); if (r) return r; }
  return null;
};

// the video trak: the one whose hdlr is 'vide'
let st = null, timescale = 0;
for (const tr of boxes(moov, 8, moov.length)) {
  if (tr.type !== "trak") continue;
  const hd = find(moov, tr.start, tr.end, ["mdia", "hdlr"]);
  if (moov.toString("latin1", hd.start + 8, hd.start + 12) !== "vide") continue;
  const mdhd = find(moov, tr.start, tr.end, ["mdia", "mdhd"]);
  timescale = moov[mdhd.start] === 1 ? moov.readUInt32BE(mdhd.start + 20) : moov.readUInt32BE(mdhd.start + 12);
  st = find(moov, tr.start, tr.end, ["mdia", "minf", "stbl"]);
  break;
}
const box = (t) => { for (const x of boxes(moov, st.start, st.end)) if (x.type === t) return x; return null; };

// sizes
const stsz = box("stsz"); const fixed = moov.readUInt32BE(stsz.start + 4), n = moov.readUInt32BE(stsz.start + 8);
const sizes = new Uint32Array(n);
for (let i = 0; i < n; i++) sizes[i] = fixed || moov.readUInt32BE(stsz.start + 12 + i * 4);
// decode times (stts) and composition offsets (ctts)
const dts = new Float64Array(n); { const b = box("stts"); let c = moov.readUInt32BE(b.start + 4), i = 0, t = 0; for (let k = 0; k < c; k++) { const cnt = moov.readUInt32BE(b.start + 8 + k * 8), d = moov.readUInt32BE(b.start + 12 + k * 8); for (let j = 0; j < cnt; j++) { dts[i++] = t; t += d; } } }
const pts = Float64Array.from(dts); { const b = box("ctts"); if (b) { const v = moov[b.start]; let c = moov.readUInt32BE(b.start + 4), i = 0; for (let k = 0; k < c; k++) { const cnt = moov.readUInt32BE(b.start + 8 + k * 8); const off = v === 1 ? moov.readInt32BE(b.start + 12 + k * 8) : moov.readUInt32BE(b.start + 12 + k * 8); for (let j = 0; j < cnt; j++) pts[i] += off, i++; } } }
// keyframes (stss): none means every frame is a key
const key = new Uint8Array(n); { const b = box("stss"); if (!b) key.fill(1); else { const c = moov.readUInt32BE(b.start + 4); for (let k = 0; k < c; k++) key[moov.readUInt32BE(b.start + 8 + k * 4) - 1] = 1; } }
// offsets: chunks (stco/co64) and samples per chunk (stsc)
const offsets = new Float64Array(n); {
  const co = box("stco") ?? box("co64"), is64 = !box("stco"), nc = moov.readUInt32BE(co.start + 4);
  const chunk = (k) => (is64 ? Number(moov.readBigUInt64BE(co.start + 8 + k * 8)) : moov.readUInt32BE(co.start + 8 + k * 4));
  const sc = box("stsc"), ns = moov.readUInt32BE(sc.start + 4);
  const runs = Array.from({ length: ns }, (_, k) => [moov.readUInt32BE(sc.start + 8 + k * 12) - 1, moov.readUInt32BE(sc.start + 12 + k * 12)]);
  let s = 0;
  for (let k = 0, r = 0; k < nc && s < n; k++) {
    while (r + 1 < runs.length && runs[r + 1][0] <= k) r++;
    let o = chunk(k);
    for (let j = 0; j < runs[r][1] && s < n; j++) { offsets[s] = o; o += sizes[s]; s++; }
  }
}
const tParse = performance.now();
console.log(`${file}: ${(size / 1048576).toFixed(0)} MB, moov ${(moov.length / 1024).toFixed(0)} KB${pos > size / 2 ? " (at the end)" : ""}`);
console.log(`  ${n} video frames, ${key.reduce((a, b) => a + b, 0)} keyframes, timescale ${timescale}`);
console.log(`  find + read moov ${(tRead - t0).toFixed(1)} ms, parse the index ${(tParse - tRead).toFixed(1)} ms`);

if (process.argv.includes("--check")) {
  const FP = join(dirname(fileURLToPath(import.meta.url)), "..", ".tools", "ffmpeg", "bin", "ffprobe.exe");
  const t1 = performance.now();
  const r = spawnSync(FP, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts,dts,size,pos,flags", "-of", "csv=p=0", file], { maxBuffer: 1 << 30, encoding: "utf8" });
  const t2 = performance.now();
  const lines = r.stdout.trim().split("\n");
  let bad = 0;
  lines.forEach((l, i) => { const [p, d, sz, ps, fl] = l.split(","); if (+sz !== sizes[i] || +ps !== offsets[i] || fl.startsWith("K") !== !!key[i]) bad++; });
  console.log(`  ffprobe: ${(t2 - t1).toFixed(0)} ms for ${lines.length} packets; mismatches in size/offset/key: ${bad}`);
}
