# Driveby

A small, fast, precise video editor for Windows: trim, cut, split, crop, grow the frame, timed
markup, MP4/GIF export. Tauri 2 (Rust) + React/TS (Vite), the same stack as its sibling app
**Vandal** (`C:\Users\Richard\Desktop\Vandal`).

**Read `internal/PLAN.md` before starting work.** Its Status section says where we are. Work
only on the current phase unless asked. Plan each phase's sub-phases with Richard first, then
build one feature per increment, each one confirmed by him and committed before the next.

`internal/` holds our private notes. It's a separate private git repo and is gitignored here:
commit its changes in `internal/`, never in this repo. If it's missing, ask Richard for it.
`internal/PLAN.md` is read up front. Read the others when needed:

- `internal/decisions.md`: the decisions log. Append to it; search it rather than reading it
  whole.
- `internal/research.md`: other tools.
- `internal/spikes/`: Phase 0 spike briefs and results.
- `internal/mockup/`: UI mockups.

If the plan turns out to be wrong, update `internal/PLAN.md` at the same time (committed in
`internal/`) and add an entry to `internal/decisions.md`.

## Reusing Vandal

Much of Driveby starts as copies of Vandal's files (PLAN §6 lists which). Copy them and adapt;
never import across the two repos, and never change Vandal from here unless Richard asks. Commit
messages needn't say which Vandal file something came from. Vandal's `CLAUDE.md` and
`DEVELOPMENT.md` explain the conventions being copied. Its private notes (`internal/`, e.g.
`decisions.md`) explain why things are the way they are: search them when a copied piece seems
odd.

## Non-negotiables (PLAN §1)

- Every edit lands on a frame. Timeline positions are integer frames, never float seconds.
- Source files are never modified; export renders the project document.
- The preview is the export: the same composition model, and markup rasterized by the same code.
- Rust owns the media. No video or image data over JSON IPC; the webview gets media from a
  custom protocol.
- Nothing for users to install: ffmpeg is a bundled sidecar.

## Conventions (as Vandal)

- All Tauri commands go in `src-tauri/src/commands.rs` with `#[specta::specta]`. TS bindings are
  generated into `src/shared/bindings.ts` on every debug run (commit it). Frontend calls go
  through `src/shared/ipc.ts`, never raw `invoke` strings.
- Tauri capabilities are minimal and per-window.
- Settings: Rust (`settings.rs`) is the source of truth, and every change goes through
  `settings::update`.
- New dependencies follow `DEVELOPMENT.md` › Dependencies (copied from Vandal at scaffold):
  - Check a package while the feature is being planned, not after it's built: advisories,
    maintenance, owner, at least a week old.
  - The commit message says why we need it and that it was checked.
  - An `npm install` that hangs means the version is under `.npmrc`'s 7-day minimum.
- Small, focused commits that explain _why_.
- Rust unit tests stay on pure modules. Test binaries that link the Tauri runtime crash on
  Windows.

## Before calling a task done (once scaffolded)

```
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
npm run lint && npm test && npx tsc --noEmit
npm run security    # if dependencies or lockfiles changed
npm run tauri:dev   # smoke run
```

## Working with Richard (carried over from Vandal)

- **Commits:**
  - Commit once an increment is confirmed. Don't push unless asked.
  - Commits are Richard's alone, as Richard Podsada <rpodsada@gmail.com>.
  - No `Co-Authored-By` or other Claude attribution lines in commits or PRs.
- **Warn before changes that restart the dev app** (Rust, `Cargo.toml`, `tauri.conf.json`); he
  is often using it.
- **Waiting for the dev app:** after a restart, wait for the app's own "ready" log line, not
  cargo's `Running` line (it has ANSI codes). Don't run `cargo test` while `tauri:dev` is
  rebuilding: they share `target/debug`, and the build can break with LNK2019. The fix is to
  stop the app and run `cargo clean -p <crate>`.
- **Tests that drive the desktop:** never act on whatever window is in the foreground. Find the
  target window by its owning process. A test once closed VS Code this way, twice.
- **PowerShell:** run Node tooling from PowerShell, because Git Bash on this machine has an old
  Node 16 first on PATH.
- **Editing files:** never edit source files with Windows PowerShell `Get-Content`/
  `Set-Content`. PowerShell 5.1 reads UTF-8 as Windows-1252 and corrupts non-ASCII text.
- **Synthetic input from PowerShell:**
  - Pass coordinates as `[int]` params.
  - Send arrow keys with `KEYEVENTF_EXTENDEDKEY`.
  - Pass real scan codes; with scan code 0 the webview sees an empty `KeyboardEvent.code`.
