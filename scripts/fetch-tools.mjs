// Downloads the media tools Driveby bundles as sidecars (ffmpeg and gifski) into
// src-tauri/binaries/, named as Tauri's `bundle.externalBin` expects. Each download is pinned by
// URL and SHA-256, so every machine (and later CI) builds with the same bytes; the binaries stay
// out of git. Run once after cloning, and again when a pin changes: `npm run fetch-tools`.
//
// Pins (DEVELOPMENT.md › Media tools):
// - ffmpeg: BtbN's GPL build of the n8.1.3 release (autobuild-2026-09-26-13-03), the checksum
//   from that release's checksums.sha256. BtbN prunes old autobuilds, so the archive is kept in
//   the download cache (src-tauri/binaries/.cache/) once fetched.
// - gifski 1.34.0 (2025-07-13), the checksum GitHub records for the release asset.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "src-tauri", "binaries");
const CACHE = join(BIN, ".cache");
/** Tauri's sidecar names end in the target triple. */
const TRIPLE = "x86_64-pc-windows-msvc";
/** Windows' own tar (bsdtar): reads zip and tar.xz. Git Bash's tar can't do zip. */
const TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

const TOOLS = [
  {
    name: "ffmpeg",
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-26-13-03/ffmpeg-n8.1.3-win64-gpl-8.1.zip",
    sha256: "d20ef03f0f4161453b9f46a72471eb5370f56b6410fe8bca14a4b0220c6c924a",
    exe: "ffmpeg-n8.1.3-win64-gpl-8.1/bin/ffmpeg.exe",
    license: "ffmpeg-n8.1.3-win64-gpl-8.1/LICENSE.txt",
  },
  {
    name: "gifski",
    url: "https://github.com/ImageOptim/gifski/releases/download/1.34.0/gifski-1.34.0.tar.xz",
    sha256: "b9b6591aa163123d737353d9c8581efdf3234d28eeaa45329b31da905cd5a996",
    exe: "win/gifski.exe",
    license: "LICENSE",
  },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function archive(tool) {
  const file = join(CACHE, tool.url.split("/").pop());
  if (existsSync(file) && sha256(readFileSync(file)) === tool.sha256) return file;
  console.log(`${tool.name}: downloading ${tool.url}`);
  const res = await fetch(tool.url);
  if (!res.ok) throw new Error(`${tool.name}: HTTP ${res.status} for ${tool.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== tool.sha256) {
    throw new Error(`${tool.name}: checksum mismatch (expected ${tool.sha256}, got ${got})`);
  }
  writeFileSync(file, buf);
  return file;
}

mkdirSync(CACHE, { recursive: true });
for (const tool of TOOLS) {
  const exe = join(BIN, `${tool.name}-${TRIPLE}.exe`);
  const stamp = join(BIN, `${tool.name}.sha256`);
  // Already unpacked from this pin.
  if (existsSync(exe) && existsSync(stamp) && readFileSync(stamp, "utf8") === tool.sha256) {
    console.log(`${tool.name}: up to date`);
    continue;
  }
  const file = await archive(tool);
  const tmp = join(CACHE, `${tool.name}-unpack`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  execFileSync(TAR, ["-xf", file, "-C", tmp, tool.exe, tool.license]);
  copyFileSync(join(tmp, tool.exe), exe);
  copyFileSync(join(tmp, tool.license), join(BIN, `${tool.name}-LICENSE.txt`));
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync(stamp, tool.sha256);
  console.log(`${tool.name}: ${exe}`);
}
