// Local release build with a build number. Run from the repo root:
//
//   npm run build:local                    installer, e.g. Razorcat_0.5.0-beta.1+3_x64-setup.exe
//   npm run build:local -- --no-bundle     just the release exe
//
// The version comes from git (see localBuildVersion): commits since the last release tag, or,
// before the first one, the commit count. Nothing in the repo changes: it reaches Tauri through a
// --config overlay and the About page through VITE_BUILD_* variables.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { localBuildVersion } from "./releaseLib.mjs";

const TARGET = "src-tauri/target";
const OVERLAY = `${TARGET}/local-build.conf.json`;

function fail(message) {
  console.error(`build:local: ${message}`);
  process.exit(1);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const tagged = git("tag", "--list", "v*") !== "";
let build;
try {
  build = tagged
    ? localBuildVersion(
        git("describe", "--tags", "--match", "v*", "--long", "--dirty"),
        pkg.version,
      )
    : {
        // No release yet: the commit count. Digits only, as Windows file versions are numeric.
        version: `${pkg.version}+${git("rev-list", "--count", "HEAD")}`,
        commit: git("rev-parse", "--short", "HEAD"),
        modified: git("status", "--porcelain", "--untracked-files=no") !== "",
        untagged: false,
      };
} catch (e) {
  fail(e.message);
}
const { version, commit, modified, untagged } = build;

console.log(
  `build:local: ${conf.productName} ${version} (${commit}${modified ? ", modified" : ""})`,
);
if (modified) console.warn('build:local: uncommitted changes: About will say "modified"');
if (untagged)
  console.warn(`build:local: v${version} isn't tagged yet; this is its release candidate`);

// Release builds sign the installer for the updater, and Tauri fails without the private key,
// which only CI has. Local installers skip the .sig.
const signUpdates = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY);
const overlay = signUpdates ? { version } : { version, bundle: { createUpdaterArtifacts: false } };
if (!signUpdates) console.log("build:local: no TAURI_SIGNING_PRIVATE_KEY, so no updater .sig");

for (const tool of ["ffmpeg", "gifski"]) {
  if (!existsSync(`src-tauri/binaries/${tool}-x86_64-pc-windows-msvc.exe`)) {
    fail(`${tool} is missing: run npm run fetch-tools first`);
  }
}

mkdirSync(TARGET, { recursive: true });
writeFileSync(OVERLAY, JSON.stringify(overlay, null, 2) + "\n");

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

// The exe and its symbols, kept for reading this build's crash dumps (never shipped).
const symbols = `${TARGET}/release/bundle/symbols/${conf.productName}_${version}`;
mkdirSync(symbols, { recursive: true });
for (const file of ["razorcat.exe", "razorcat.pdb"]) {
  copyFileSync(`${TARGET}/release/${file}`, `${symbols}/${file}`);
}
console.log(`build:local: symbols kept in ${symbols}`);

const output = extra.includes("--no-bundle")
  ? `${TARGET}/release/razorcat.exe`
  : `${TARGET}/release/bundle/nsis/${conf.productName}_${version}_x64-setup.exe`;
if (existsSync(output))
  console.log(`\nbuild:local: ${conf.productName} ${version} built:\n  ${output}`);
else console.warn(`\nbuild:local: done, but ${output} isn't there; check the bundle folder`);
