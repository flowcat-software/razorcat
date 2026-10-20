// Local release build with a build number. Run from the repo root:
//
//   npm run build:local                    installer, e.g. Razorcat_0.1.0+8_x64-setup.exe
//   npm run build:local -- --no-bundle     just the release exe
//
// The build number is the commit count (`git rev-list --count HEAD`) until there are release
// tags; Vandal's build-local.mjs counts commits since the last tag, to copy when releases start
// (Phase 5). Nothing in the repo changes: the version reaches Tauri through a --config overlay
// and the About page through VITE_BUILD_* variables.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const TARGET = "src-tauri/target";
const OVERLAY = `${TARGET}/local-build.conf.json`;

function fail(message) {
  console.error(`build:local: ${message}`);
  process.exit(1);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
// Digits only: Windows file versions are numeric, so NSIS writes it into the exe's version.
const version = `${pkg.version}+${git("rev-list", "--count", "HEAD")}`;
const commit = git("rev-parse", "--short", "HEAD");
const modified = git("status", "--porcelain", "--untracked-files=no") !== "";

console.log(
  `build:local: ${conf.productName} ${version} (${commit}${modified ? ", modified" : ""})`,
);
if (modified) console.warn('build:local: uncommitted changes: About will say "modified"');

for (const tool of ["ffmpeg", "gifski"]) {
  if (!existsSync(`src-tauri/binaries/${tool}-x86_64-pc-windows-msvc.exe`)) {
    fail(`${tool} is missing: run npm run fetch-tools first`);
  }
}

mkdirSync(TARGET, { recursive: true });
writeFileSync(OVERLAY, JSON.stringify({ version }, null, 2) + "\n");

const extra = process.argv.slice(2);
// One command string: npm is npm.cmd on Windows, which needs a shell, and Node deprecates
// passing an argument array along with `shell`.
const quote = (arg) => (/^[\w./:=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);
const command = ["npm run tauri -- build --config", OVERLAY, ...extra.map(quote)].join(" ");
const result = spawnSync(command, {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    VITE_BUILD_VERSION: version,
    VITE_BUILD_COMMIT: commit,
    VITE_BUILD_MODIFIED: modified ? "1" : "",
  },
});
if (result.status !== 0) fail(`tauri build failed (exit ${result.status ?? result.signal})`);

const output = extra.includes("--no-bundle")
  ? `${TARGET}/release/razorcat.exe`
  : `${TARGET}/release/bundle/nsis/${conf.productName}_${version}_x64-setup.exe`;
if (existsSync(output))
  console.log(`\nbuild:local: ${conf.productName} ${version} built:\n  ${output}`);
else console.warn(`\nbuild:local: done, but ${output} isn't there; check the bundle folder`);
