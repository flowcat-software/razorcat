# Razorcat

A small, fast, precise video editor for Windows: trim, cut, split, crop, grow the frame, timed
markup, MP4/GIF export. Tauri 2 (Rust) + React/TS (Vite), the same stack as its sibling app
[Vandal](https://github.com/flowcat-software/vandal).

## Private notes (`internal/`)

The maintainers keep private notes in `internal/`: a separate private git repo, gitignored
here. Commit its changes in `internal/`, never in this repo. If it's there:

- **Read `internal/maintainer.md` first:** how work is planned, confirmed and committed.
- **Read `internal/PLAN.md` before starting work.** Its Status section says where things are.
  Work only on the current phase unless asked.
- `internal/local.md`: this machine's setup (where Vandal is checked out, the demo site).
- `internal/decisions.md`: the decisions log. Append to it; search it rather than reading it
  whole.
- `internal/research.md`: other tools. `internal/spikes/`: Phase 0 spike briefs and results.
  `internal/mockup/`: UI mockups.

If the plan turns out to be wrong, update `internal/PLAN.md` at the same time (committed in
`internal/`) and add an entry to `internal/decisions.md`.

Code comments cite these notes (`PLAN 5d.8`, `decisions.md`). Without them, the code and its
comments still say what it does and why.

## Reusing Vandal

Much of Razorcat starts as copies of Vandal's files. Copy them and adapt; never import across
the two repos, and never change Vandal from here unless asked. Commit messages needn't say which
Vandal file something came from. Vandal's `CLAUDE.md` and `DEVELOPMENT.md` explain the
conventions being copied.

## Non-negotiables

- Every edit lands on a frame. Timeline positions are integer frames, never float seconds.
- Source files are never modified; export renders the project document.
- The preview is the export: the same composition model, and markup rasterized by the same code.
- Rust owns the media. No video or image data over JSON IPC; the webview gets media from a
  custom protocol.
- Nothing for users to install: ffmpeg is a bundled sidecar.
- ffmpeg and gifski stay separate programs, never linked as libraries.

## Conventions (as Vandal)

- All Tauri commands go in `src-tauri/src/commands.rs` with `#[specta::specta]`. TS bindings are
  generated into `src/shared/bindings.ts` on every debug run (commit it). Frontend calls go
  through `src/shared/ipc.ts`, never raw `invoke` strings.
- Tauri capabilities are minimal and per-window.
- Settings: Rust (`settings.rs`) is the source of truth, and every change goes through
  `settings::update`.
- New dependencies follow `DEVELOPMENT.md` › Dependencies:
  - Check a package while the feature is being planned, not after it's built: advisories,
    maintenance, owner, at least a week old, and a licence compatible with the GPL.
  - The commit message says why we need it and that it was checked.
  - An `npm install` that hangs means the version is under `.npmrc`'s 7-day minimum.
- Small, focused commits that explain _why_. No AI attribution lines (`Co-Authored-By` or
  similar) in commits or PRs.
- Code comments explain the code, not who asked for it: no names.
- Rust unit tests stay on pure modules. Test binaries that link the Tauri runtime crash on
  Windows.

## Before calling a task done

```
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
npm run lint && npm test && npx tsc --noEmit
npm run security    # if dependencies or lockfiles changed
npm run tauri:dev   # smoke run
```

## Working on Windows

- **Waiting for the dev app:** after a restart, wait for the app's own "ready" log line, not
  cargo's `Running` line (it has ANSI codes). Don't run `cargo test` while `tauri:dev` is
  rebuilding: they share `target/debug`, and the build can break with LNK2019. The fix is to
  stop the app and run `cargo clean -p razorcat`.
- **Tests that drive the desktop:** never act on whatever window is in the foreground. Find the
  target window by its owning process.
- **Node:** run Node tooling from PowerShell, and check `node --version` in other shells.
- **Editing files:** never edit source files with Windows PowerShell `Get-Content`/
  `Set-Content`. PowerShell 5.1 reads UTF-8 as Windows-1252 and corrupts non-ASCII text.
- **Synthetic input from PowerShell:**
  - Pass coordinates as `[int]` params.
  - Send arrow keys with `KEYEVENTF_EXTENDEDKEY`.
  - Pass real scan codes; with scan code 0 the webview sees an empty `KeyboardEvent.code`.
