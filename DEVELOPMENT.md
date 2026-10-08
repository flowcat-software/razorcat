# Developing Driveby

Driveby is a Tauri 2 app: a Rust core (`src-tauri/`) that owns the media (probing, the bundled
ffmpeg, export) and a React + TypeScript UI (`src/`, built with Vite).

[`CLAUDE.md`](CLAUDE.md) has the working conventions (commands, IPC, settings, checks).

## Prerequisites

- Windows 10 1903+ or Windows 11, x64.
- Rust stable (`x86_64-pc-windows-msvc`) and Visual Studio Build Tools with the "Desktop
  development with C++" workload.
- Node LTS and npm 11.12 or later (for `.npmrc`'s `min-release-age` and `allow-git`). Run Node
  tooling from PowerShell. In Git Bash, an nvm default other than `system` puts a different Node
  first on PATH (`nvm alias default system` fixes it).
- `cargo-deny`, for `npm run security`: `cargo install --locked cargo-deny` (a couple of
  minutes, once).

## Run

```powershell
npm install
npm run fetch-tools   # once: the bundled ffmpeg and gifski (see Media tools)
npm run tauri:dev
```

The dev build has its own identity (`Driveby Dev`, `com.driveby.desktop.dev`), so it runs
alongside an installed copy. Its settings live in `%APPDATA%\com.driveby.desktop.dev\`.

## Checks

Run all of these before calling a change done:

```powershell
cd src-tauri; cargo fmt; cargo clippy --all-targets -- -D warnings; cargo test; cd ..
npm run lint; npm test; npx tsc --noEmit
npm run security    # known advisories (npm audit, cargo deny); a few seconds
```

## Test media and the frame check

`node spikes/make-test-media.mjs` (PowerShell, repo root; needs `spikes/.tools/ffmpeg`) writes
synthetic clips to `spikes/media/` (gitignored): CFR and VFR, an upright HEVC stored sideways,
MKV, GIF, a 10-minute 1080p60. Each burns in its frame number and a 16-bit barcode of it along
the bottom, and beeps on whole seconds.

The frame check proves the preview shows the frame export will: with the dev app running,

```powershell
src-tauri\target\debug\driveby.exe --check-frames spikes\media\phone-h264-vfr.mp4
```

opens the clip, steps and seeks the preview as the keys do (the original, then the proxy if
it's ready), reads the barcode on screen and compares it with ffmpeg's `fps` output at each
grid frame. The result shows in the status bar; the mismatches go to
`%TEMP%\driveby-check-<file>.json`. Development builds only. Run it after changing the player,
the proxy or the frame grid.

The dev app keeps proxies, converted copies, thumbnails and waveforms in
`%LOCALAPPDATA%\com.driveby.desktop.dev\proxies\` (Settings › Proxies can move it).

## Dependencies

Every package we add can run code on our machines and in users' hands, so new ones get checked
before they're used. `.npmrc` and `src-tauri/deny.toml` enforce part of this.

**Before adding or upgrading a package** (npm or cargo):

- **Check it while planning the feature, not after building it.** A package that fails here
  means choosing another before any code depends on it.
- **Advisories:** search the [GitHub Advisory Database](https://github.com/advisories) and, for
  crates, [RustSec](https://rustsec.org/advisories/).
- **Maintenance and owner:** recent releases, an active repository, and the same owner as before.
  A package that changed hands recently is a reason to wait or look elsewhere.
- **Prefer what we already have.** Many Windows features only need another feature flag on the
  `windows` crate, not a new crate.
- **Age:** don't take a version published in the last 7 days. npm enforces this
  (`min-release-age`): ranges and `@latest` quietly pick the newest version that's a week old.
  **If `npm install pkg@<exact version>` hangs, the version is probably too new**: npm 11.12 loops
  instead of failing. Wait, or, if the fix is needed now, add `--min-release-age=0` to that one
  command and say why in the commit.
- **Review the lockfile diff** (`package-lock.json`, `src-tauri/Cargo.lock`): new transitive
  packages, git or non-registry sources, install scripts (`"hasInstallScript": true`).
- **Note the check in the commit message**, next to why we need the package.

`.npmrc` also turns off install scripts (`ignore-scripts`; no dependency needs one) and git
dependencies (`allow-git=none`). If a package ever needs its install script, that's a decision
to record, not a reason to turn the setting off.

When `npm run security` fails with nothing changed on our side, a new advisory has been
published against something we use. Upgrade it (once the fix is a week old), or, if it doesn't
apply to Driveby, add it to `ignore` in `src-tauri/deny.toml` with the reason. Yanked crates only
warn: run `cargo update -p <crate>` once the replacement is a week old.

## Media tools

Driveby runs ffmpeg (decoding, proxies, export) and gifski (GIF export) as Tauri sidecars:
separate programs shipped beside `driveby.exe` (`bundle.externalBin` in `tauri.conf.json`),
started by `src-tauri/src/sidecar.rs` with no console window. Settings › About shows their
versions, which proves they're there and run.

`npm run fetch-tools` (`scripts/fetch-tools.mjs`) downloads them into `src-tauri/binaries/`
(gitignored), named as Tauri expects (`ffmpeg-x86_64-pc-windows-msvc.exe`), with their licences.
Each download is pinned by URL and SHA-256 and checked; the archives stay in
`src-tauri/binaries/.cache/`, so a rerun needs no network. Without them the Rust build fails,
naming the missing binary.

- **ffmpeg:** [BtbN's](https://github.com/BtbN/FFmpeg-Builds) GPL build of the n8.1.3 release,
  checked against the release's `checksums.sha256`. Pin a dated `autobuild-…` release, never
  `latest` (it changes daily), and one at least a week old, like any dependency. BtbN prunes old
  autobuilds: the cache keeps ours. It's the full build (165 MB) for now; a build with only what
  Driveby uses comes before the beta.
- **gifski:** the 1.34.0 release, checked against the SHA-256 GitHub records for the asset.

To update one, change its `url` and `sha256` in the script, run it, and check About.

## Build an installer

```powershell
npm run build:local
```

This builds a release installer with a build number: a per-user NSIS installer (no admin) in
`src-tauri/target/release/bundle/nsis/`, for example `Driveby_0.1.0+8_x64-setup.exe`. It
includes ffmpeg and gifski beside `driveby.exe`, and the licences (Driveby's, ffmpeg's GPL,
gifski's AGPL) in its `licenses` folder. Settings › About shows the same version and the
commit it was built from, for example `0.1.0+8 (2cf53f9)`, plus "modified" if there were
uncommitted changes. For just the release exe, without an installer, use
`npm run build:local -- --no-bundle`. Other arguments are passed on to `tauri build` too.

- **The build number (`+8`) is the commit count** for now: every new commit gives the next
  build a higher number, and nothing in the repo changes. Once there are release tags, it
  becomes the count since the last one, as in Vandal.
- **Digits only:** Windows file versions are numeric, so NSIS writes the number into the exe's
  file version (`0.1.0.8`).
- The installer has no updater and isn't code-signed yet: those come with releases.

## The name

The product name may still change. It lives in `src-tauri/tauri.conf.json` (`productName`,
`identifier`; the dev build's in `tauri.dev.conf.json`), and the code reads it from there: the
window title, and the settings folder, which Windows derives from the identifier. The crate and
package names (`driveby`, `driveby_lib`) and the docs are a find-and-replace.
