# Developing Driveby

Driveby is a Tauri 2 app: a Rust core (`src-tauri/`) that owns the media (probing, the bundled
ffmpeg, export) and a React + TypeScript UI (`src/`, built with Vite).

[`CLAUDE.md`](CLAUDE.md) has the working conventions (commands, IPC, settings, checks).

## Prerequisites

- Windows 10 1903+ or Windows 11, x64.
- Rust stable (`x86_64-pc-windows-msvc`) and Visual Studio Build Tools with the "Desktop
  development with C++" workload.
- Node LTS and npm 11.12 or later (for `.npmrc`'s `min-release-age` and `allow-git`). Run Node
  tooling from PowerShell. On this machine, Git Bash puts an old Node 16 first on PATH.
- `cargo-deny`, for `npm run security`: `cargo install --locked cargo-deny` (a couple of
  minutes, once).

## Run

```powershell
npm install
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

## The name

The product name may still change. It lives in `src-tauri/tauri.conf.json` (`productName`,
`identifier`; the dev build's in `tauri.dev.conf.json`), and the code reads it from there: the
window title, and the settings folder, which Windows derives from the identifier. The crate and
package names (`driveby`, `driveby_lib`) and the docs are a find-and-replace.
