# Changelog

All notable changes to Razorcat are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each release's section becomes its release notes.

## [Unreleased]

## [0.5.0-beta.3] - 2026-11-04

### Added

- **Projects open where you left them.** A saved project remembers the playhead's frame and the
  timeline's zoom and scroll, so you can carry on where you were.

### Fixed

- **Clicks in a window recording land where you clicked.** Recording a window left out its title
  bar, so in many apps the highlighted clicks showed up a little below the pointer. Window
  recordings now include the whole window, title bar and all, as the picker shows it.
- **The record key can't leave Razorcat stuck.** If choosing what to record doesn't come up
  within a few seconds, Razorcat now gives up and brings the editor back, rather than leaving
  it minimized and unresponsive. It also writes a small report to the logs folder
  (**Settings › About › Debugging › Open logs folder**) to help find the cause; please attach it if you
  [report it](https://github.com/flowcat-software/razorcat/issues).

## [0.5.0-beta.2] - 2026-10-29

### Added

- **Settings › Keyboard shortcuts lists every shortcut.** Under the recording shortcuts you can
  change, the editor's own keys are all there: the tools, playing, editing, marking up,
  cropping, files and choosing what to record. Search Settings by what a key does ("split",
  "zoom") to find it. The same lists are in the README's
  [Keyboard reference](https://github.com/flowcat-software/razorcat#keyboard-reference).

## [0.5.0-beta.1] - 2026-10-29

The first beta of Razorcat, the screencast tool built for speed: record your screen, mark it
up, edit it on a precise timeline, and export an MP4 or a GIF in one click. Thank you for
testing it. Please [report anything odd](https://github.com/flowcat-software/razorcat/issues).

### Added

- **Recording.** A region, a window or a whole screen, from the Record button, the tray or
  Win+F11, with a countdown. Your microphone, the system's sound, your camera in a bubble and
  your clicks, each one editable on the timeline afterwards, not baked into the video.
- **Markup on a timeline.** Vandal's tools (pen, highlighter, line, arrow, rectangle, ellipse,
  text, callout, numbered steps, spotlight, and redact: solid, pixelate or blur), each shown for
  as long as you choose, with fades. Paste Style, Alt-drag copies, and changing many items at
  once.
- **Editing.** One magnetic track: split, ripple trim, move and join clips, mark ranges to keep
  or cut, crop and grow the frame, clip fades and crossfades, and clip speed. Every edit lands
  on an exact frame, and any trim can be pulled back out.
- **Export.** MP4 (with hardware encoding where your graphics card has it) or GIF, for the whole
  timeline, one clip, or each clip as its own file, straight to a folder with your file names.
- **Projects** (`.rct`) that open in Razorcat, with autosave and recovery after a crash.
- **Updates.** Razorcat checks for new versions a minute after it starts and once a day, and
  installs them when you say so, every update signed and checked first. Turn checks off, or
  switch between Beta and Stable, in **Settings › Updates**.

### Known issues

- **Windows SmartScreen warns about the installer** ("Windows protected your PC"): it isn't
  code-signed yet. Click **More info**, then **Run anyway**. The release's `SHA256SUMS.txt` and
  its build attestation let you check the download (see the README's
  [Verify your download](https://github.com/flowcat-software/razorcat#verify-your-download)).
- **The installer is about 50 MB**, most of it ffmpeg. A smaller build of ffmpeg, with only what
  Razorcat uses, is planned.

[Unreleased]: https://github.com/flowcat-software/razorcat/compare/v0.5.0-beta.3...HEAD
[0.5.0-beta.3]: https://github.com/flowcat-software/razorcat/compare/v0.5.0-beta.2...v0.5.0-beta.3
[0.5.0-beta.2]: https://github.com/flowcat-software/razorcat/compare/v0.5.0-beta.1...v0.5.0-beta.2
[0.5.0-beta.1]: https://github.com/flowcat-software/razorcat/releases/tag/v0.5.0-beta.1
