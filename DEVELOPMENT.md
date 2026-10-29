# Developing Razorcat

Razorcat is a Tauri 2 app: a Rust core (`src-tauri/`) that owns the media (probing, the bundled
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

The dev build has its own identity (`Razorcat Dev`, `com.razorcat.desktop.dev`), so it runs
alongside an installed copy. Its settings live in `%APPDATA%\com.razorcat.desktop.dev\`.

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
src-tauri\target\debug\razorcat.exe --check-frames spikes\media\phone-h264-vfr.mp4
```

opens the clip, steps and seeks the preview as the keys do (the original, then the proxy if
it's ready), reads the barcode on screen and compares it with ffmpeg's `fps` output at each
grid frame. The result shows in the status bar; the mismatches go to
`%TEMP%\razorcat-check-<file>.json`. Development builds only. Run it after changing the player,
the proxy or the frame grid.

The layout check proves nothing is cut off in the smallest window:

```powershell
src-tauri\target\debug\razorcat.exe --check-layout spikes\media\no-audio-720p30.mp4
```

sets the editor to its minimum size (720 × 480), opens the clip in place of the timeline, and
steps through the editor's states (each tool, grow with every side coloured, clip, range and
markup selections, several selected), measuring each bar (`src/editor/layoutCheck.ts`).
Anything reaching past a bar's edge, text clipped without an ellipsis, or a bar pushed below
the window counts as cut off; text shortened with an ellipsis is listed apart. Same report
file. Run it after adding to a bar; a new state worth checking goes in `checkLayout`. The
bars squeeze to fit through `src/editor/squeeze.ts`.

The retimed export check proves a clip at another speed exports the frames the preview shows,
its sound in sync:

```powershell
cd src-tauri; cargo test retimed_exports -- --ignored --nocapture
```

exports the 10-minute 1080p60 test clip at six speeds (10% to 233%) with the export's own
arguments, pitch kept and tape-style, and reads every frame's barcode against the preview's
mapping (`src/editor/speed.ts`) and each beep against where its second falls. Needs the bundled
ffmpeg and `spikes/media`. Not while `tauri:dev` is rebuilding (they share `target/debug`). Run
it after changing the export's speed chain (`tempo`, the `setpts` in `graph`).

The dev app keeps proxies, converted copies, thumbnails and waveforms in
`%LOCALAPPDATA%\com.razorcat.desktop.dev\proxies\` (Settings › Proxies can move it).

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
- **Licence:** compatible with the GPL-3.0 (MIT, Apache-2.0, BSD, ISC, Zlib, MPL-2.0 and the
  like). A package under a licence the GPL can't take (proprietary, non-commercial, SSPL) is
  out. Programs we only run, like ffmpeg and gifski, stay separate programs: never link
  them as libraries.
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
apply to Razorcat, add it to `ignore` in `src-tauri/deny.toml` with the reason. Yanked crates only
warn: run `cargo update -p <crate>` once the replacement is a week old.

## Media tools

Razorcat runs ffmpeg (decoding, proxies, export) and gifski (GIF export) as Tauri sidecars:
separate programs shipped beside `razorcat.exe` (`bundle.externalBin` in `tauri.conf.json`),
started by `src-tauri/src/sidecar.rs` with no console window. Settings › About shows their
versions, which proves they're there and run.

`npm run fetch-tools` (`scripts/fetch-tools.mjs`) downloads them into `src-tauri/binaries/`
(gitignored), named as Tauri expects (`ffmpeg-x86_64-pc-windows-msvc.exe`), with their licences.
Each download is pinned by URL and SHA-256 and checked, and comes from Razorcat's own
[`tools` release](https://github.com/flowcat-software/razorcat/releases/tag/tools), where it
can't be pruned (it also holds both tools' source, as their licences ask). The archives stay in
`src-tauri/binaries/.cache/`, so a rerun needs no network. Without them the Rust build fails,
naming the missing binary.

- **ffmpeg:** [BtbN's](https://github.com/BtbN/FFmpeg-Builds) GPL build of the n8.1.3 release,
  checked against the release's `checksums.sha256`. Pin a dated `autobuild-…` release, never
  `latest` (it changes daily), and one at least a week old, like any dependency. BtbN prunes old
  autobuilds, which is why ours is on the `tools` release. It's the full build (165 MB) for now; a build with only what
  Razorcat uses comes before the beta.
- **gifski:** the 1.34.0 release, checked against the SHA-256 GitHub records for the asset.

To update one, upload the new archive (and its source) to the `tools` release, change its
`url` and `sha256` in the script, run it, and check About.

## Build an installer

```powershell
npm run build:local
```

This builds a release installer with a build number: a per-user NSIS installer (no admin) in
`src-tauri/target/release/bundle/nsis/`, for example `Razorcat_0.5.0-beta.1+3_x64-setup.exe`. It
includes ffmpeg and gifski beside `razorcat.exe`, and the licences (Razorcat's, ffmpeg's GPL,
gifski's AGPL) in its `licenses` folder. Settings › About shows the same version and the
commit it was built from, for example `0.5.0-beta.1+3 (2cf53f9)`, plus "modified" if there were
uncommitted changes. For just the release exe, without an installer, use
`npm run build:local -- --no-bundle`. Other arguments are passed on to `tauri build` too.

- **The build number (`+3`) is the count of commits since the last release tag** (before the
  first release, the count of all commits). Semver ignores it, so the updater treats the build
  as that release. Nothing in the repo changes. After `release:bump` but before tagging, the
  build is the new version as it is: its release candidate.
- **Digits only:** Windows file versions are numeric, so NSIS writes the number into the exe's
  file version (`0.5.0.3`).
- **No updater signature:** a local installer has no `.sig` unless `TAURI_SIGNING_PRIVATE_KEY`
  is set. Only CI signs releases (see Releasing), and nothing is code-signed for Windows yet.
- **Symbols:** each build's `razorcat.exe` and `razorcat.pdb` are kept in
  `src-tauri/target/release/bundle/symbols/Razorcat_<version>/`, never shipped. Keep the
  folder of any build given to testers: it's what turns their crash dumps into function names.
  Releases carry theirs as `…_symbols.zip`.

## Releasing

`package.json` holds the version, which `tauri.conf.json` reads. `src-tauri/Cargo.toml` and
both lockfiles must match it. Versions follow semver and stay at 0.x for now. Builds for
testers are prereleases of the next version (`0.5.0-beta.1`, `0.5.0-beta.2`...), which sort
before the release itself (`0.5.0`). Every release must have a new, higher number:

- **Tester build during a phase:** the next beta (`0.5.0-beta.4`).
- **Phase done:** the final version (`0.5.0`). Each phase raises the minor version, and the
  going-public release is `1.0.0`.
- **Fix to a final release:** the next patch (`0.5.1`). Don't use a patch number for in-between
  builds: `0.5.1` sorts after `0.5.0`, so it would claim the phase is done and outrank every
  later beta. Local builds get a build number instead (see Build an installer).
- **After 1.0:** major if something users rely on breaks (settings or projects that can't
  migrate, a feature removed, a Windows version dropped), minor for new features, patch for
  fixes only.
- **Never reuse a version, or move or delete a published tag.** If a published release is
  broken, release the next number. A tag whose release is still a draft can be moved (below).
- **Keep the dot in `beta.10`.** It then sorts as a number, after `beta.9`. Without the dot,
  `beta10` sorts as text, before `beta9`.

1. As you work, add changes under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md).
2. Before bumping, check security:
   - `npm run security` passes (the release workflow runs it too and won't build if it fails).
   - Tauri's [security advisories](https://github.com/tauri-apps/tauri/security/advisories)
     and [plugins' advisories](https://github.com/tauri-apps/plugins-workspace/security/advisories)
     have nothing new for Tauri or the plugins we use, the updater included.
3. Bump the version:

   ```powershell
   npm run release:bump -- 0.5.0-beta.2
   ```

   This sets the version in all four files. It also turns `[Unreleased]` into a dated
   `[0.5.0-beta.2]` section and updates the compare links. It refuses a version that isn't
   higher than the current one (the updater only offers higher versions), and it refuses an
   empty `[Unreleased]`.

4. Commit, tag and push. The bump prints the exact commands:

   ```powershell
   git commit -am "Release v0.5.0-beta.2"
   git tag -a v0.5.0-beta.2 -m "Razorcat 0.5.0-beta.2"
   git push origin main v0.5.0-beta.2
   ```

5. The tag starts the **Release** workflow (`.github/workflows/release.yml`). It runs the
   Security checks first, then checks that the tag matches the version files and has
   CHANGELOG notes, and runs the full checks. Then it fetches ffmpeg and gifski
   (`npm run fetch-tools`), builds the installer, attests its build provenance (signed by
   GitHub, checked with `gh attestation verify`), and creates a **draft** release with the
   installer, its updater signature (`…-setup.exe.sig`), `SHA256SUMS.txt`, the build's debug
   symbols (`…_symbols.zip`: `razorcat.exe` and `razorcat.pdb`, for reading crash dumps) and
   that version's CHANGELOG section. Tags with a `-` are marked as prereleases.
6. Download the installer from the draft, install it over the previous version and smoke-test
   it. Check `gh attestation verify <installer> --repo flowcat-software/razorcat` passes and
   that its SHA-256 (`Get-FileHash`) matches the draft's `SHA256SUMS.txt`. Once Razorcat has a
   website, put the SHA-256 there too: it's hosted apart from GitHub, so a swapped installer
   can't come with a matching hash. Then press **Publish release** on GitHub.
7. Publishing starts the **Publish updates** workflow (`.github/workflows/publish-updates.yml`).
   It checks the installer's updater signature against the public key and writes the channel
   manifests to the `update-manifests` branch: `beta.json` gets every release, `stable.json`
   only final ones. Installed copies read them from
   `https://raw.githubusercontent.com/flowcat-software/razorcat/update-manifests/<channel>.json`
   (cached for up to 5 minutes). Check the run is green and the manifest shows the new version.

**Pulling a bad release:** turn it back into a draft on GitHub (or delete it), then run
**Actions › Publish updates › Run workflow**. A manual run sets each channel to the highest
published, signed release, even if that's lower; a publish only ever moves a channel up. Copies
that already installed the bad release keep it (the updater never goes down a version), so
the fix is the next release.

If the workflow fails, fix the problem on `main`, then move the tag and push it again:
`git tag -f -a v… -m "…"` and `git push -f origin v…`. A re-run replaces the files on an
existing draft.

To test the pipeline without releasing, run the workflow by hand (**Actions › Release › Run
workflow**). It runs the same checks and build, and keeps the installer as a workflow artifact
for 14 days. Manual runs sign for the updater too, so they prove the key still works.

### The updater key

Updates are signed with Tauri's updater key (minisign, not Windows code signing), and every
installed copy only accepts updates signed with it. The public key is in `tauri.conf.json`
(`plugins.updater.pubkey`, key ID `07D6AE0731FCCA34`). The private key and its password are
kept by the maintainer and in the `release` environment's secrets
(`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), which only `v*` tags and
`main` can use. The workflow gives them to the installer build step only, and that step reuses
the `dist/` built earlier instead of running Vite again, so no npm script or bundler has the key
in its environment. Never put the key in the repo or a `VITE_` variable.

- **If the key is lost,** installed copies can never update again: users must install a build
  with a new key by hand.
- **If the key leaks,** rotate it: generate a new one (`npx tauri signer generate`) and ship a
  release that carries the new public key but is still signed with the old key, so installed
  copies accept it; sign everything after that with the new key. A leaked key alone can't push
  an update: the manifests and installers also come from this repo.

## Logs and crash reports

Razorcat logs to `%LOCALAPPDATA%\<identifier>\logs\razorcat.log` (`com.razorcat.desktop`, or
`com.razorcat.desktop.dev` for dev builds), the last five runs kept as `razorcat.1.log` and on.
In dev the same lines go to the terminal. A run's log stops at 10 MB with a note saying so
(a runaway error can't fill the disk); crashes and panics are still written after it. The file never holds paths, file names or anything
else that identifies the user or the project (`scrub.rs`). A panic logs its backtrace; a native
crash logs its exception and the module it happened in. Either one writes a small minidump,
`crash-<date>-<time>.dmp`, beside the log, and the newest five are kept.

The webview's own processes are watched too (`webview_crash.rs`): if the page's renderer dies,
the page reloads and says so; if the whole webview goes, Razorcat says so and closes. After a
crash, the next launch's status bar says so, with Show report (the logs folder), which Settings ›
About can also open.

To check the whole path, set `RAZORCAT_CRASH_TEST` to `native`, `panic`, `thread-panic`,
`webview` (the renderer) or `browser` (the whole webview) before starting the app, and it
crashes that way three seconds after startup. `flood` fills the log past its cap, then panics.

## The name

The product name lives in `src-tauri/tauri.conf.json` (`productName`, `identifier`; the dev
build's in `tauri.dev.conf.json`), and the code reads it from there: the window title, and the
settings folder, which Windows derives from the identifier. The crate and package names
(`razorcat`, `razorcat_lib`) and the docs are a find-and-replace.
