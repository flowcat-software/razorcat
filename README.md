<p align="center">
  <img src="assets/razorcat-icon.png" width="128" height="128" alt="Razorcat logo">
</p>

<h1 align="center">Razorcat</h1>

<p align="center">
  <strong>The screencast tool built for speedy workflows.</strong><br>
  Record, mark up and export screencasts for Windows, with way fewer clicks.
</p>

<p align="center">
  <strong>Beta coming soon</strong> · Windows 10 (1903+) and Windows 11 · x64
</p>

---

If you make tutorials, demos or how-to videos regularly, Razorcat is built to save you time doing it.
It's the same approach as [Vandal](https://github.com/flowcat-software/vandal), our screenshot
tool, now for video: shortcut keys for tools and styles, markup that copies its look from one item
to the next, and tools that remember how you like them.

1. **Record.** Press a shortcut and record a region, a window or a whole screen, with your
   microphone, the system's sound, your camera, and your clicks. Or open a recording you already have.
2. **Mark up.** Add arrows, boxes, text, callouts, numbered steps, a spotlight, and redaction; all on a simple intuitive timeline.
3. **Edit.** One track for video, no clutter. Split with a key, trim an edge, or mark stretches to cut,
   and the clips close up behind you. Copy and paste fades, styles, and timing between markup items.
   Every edit lands on an exact frame, your markup follows its video, and any trim can be pulled
   back out later.
4. **Export.** One click: an MP4 or a GIF, straight to your folder with your own file names.

> **Razorcat isn't released yet.** The first beta is on its way.

## Why Razorcat?

We hate useless clicks as much as you do. Everything in Razorcat is designed to cut the work out
of making a screencast, so the twentieth video is as quick, and looks as consistent, as the
first.

- **Shortcuts for frequent actions.** Every tool, every edit and every style: S splits at the
  playhead, J/K/L play, I and O mark a range, number keys set sizes. Edit without hunting
  through menus.
- **Markup you set once.** Every tool remembers its style between sessions, as in Vandal, so
  each new arrow or callout already looks like the last.
- **Change many items at once.** Copy & paste styles, fades or timing to one or more elements
  with keystroke. Select several items on the timeline and move them, stretch their
  timing or change their fades together. Duplicate a whole selection, or Alt-drag it to copy it
  to another place in the video.
- **Presets and controls you choose.** Your colours, widths and fonts in the pickers, and even
  the control itself (buttons, dropdown or slider), for every tool or per tool.
- **The professional feel, without the kitchen sink.** A precise timeline that's simple to
  learn, without a hundred panels. Every edit lands on an exact frame, handles are easy to
  grab, and the preview is the export, frame for frame.
- **One-click export.** MP4 or GIF with hardware encoding support.
  Set a default folder to export in one click. No wall of
  export settings and no clunky wizards to waste your time.
- **Non-destructive editing.** Your camera bubble and click highlights are editable on the
  timeline after recording, not baked into the video. Your recordings are never changed:
  edits live in a project, export makes a new file, any trim or crop can be pulled back out,
  and autosave backs up your work in progress.
- **Quick jobs stay quick.** Trim, crop, split or join a video in a few keystrokes, without
  starting a big editor.
- **Free, private and open source.** GPL-3.0, no account, njo subscriptions, no telemetry, no uploads, and no
  admin rights needed. See [License](#license) for how businesses are asked to support it.

### Design philosophy

1. **Speed.** _Get out of the way._ Every click, dialog and setting is friction that compounds
   across a course's worth of videos. Common actions are one keystroke; export is one click.
2. **Simplicity.** _Built for screencasts, and nothing else._ The essentials of a screencast,
   done well. No effect banks, no colour grading, no kitchen sink.
3. **Personalization.** _Your workflow, not ours._ Tools, styles, controls and file names bend
   to fit how you work, and are remembered between sessions.
4. **Precision.** _A professional feel, not a professional's workload._ Simple shouldn't mean
   clunky or approximate. Every edit lands on an exact frame.

### Built for people who make screencasts

- **Educators and course creators:** lessons, course modules, walkthroughs.
- **Technical writers and trainers:** how-to videos and GIFs for docs and onboarding.
- **Content creators:** software tutorials and tips videos.
- **Support teams:** "here's how to do it" videos and answers to tickets.
- **Developers and product people:** feature demos, release videos, bug reproductions.
- **Marketers and sales engineers:** product demos and feature highlights.

## Features

**Recording**

- A region, a window or a whole screen, from the Record button, the tray or a shortcut
  (Win+F11), with a countdown
- Your microphone for a voiceover, and the system's sound
- Your camera in a bubble you can move and resize, recorded separately so you can change it
  afterwards
- Your clicks, shown on the video as markup you can restyle or remove
- A small floating control (time, pause, stop), left out of the recording

**Markup** _(Vandal's tools, on a timeline)_

- Pen, highlighter, line, arrow, rectangle, ellipse, text, callout, numbered steps, spotlight,
  and redact (solid, pixelate or blur)
- Each item shows for a set time, with a fade in and out, on lanes above the clips
- Paste Style, Alt-drag to copy along the timeline, and copy and paste markup with its clips
- Items follow their video when you trim and split
- Single-key tools and number-key styles, your own presets, and per-tool memory, as in Vandal

**Editing**

- Open MP4, MOV, MKV, WebM and GIF: drag and drop, Open, or Explorer's "Open with"
- Several videos on one timeline: join and stitch recordings, in any order
- One magnetic track: split, ripple trim, move clips, and pull a trim back out any time
- Ranges: mark stretches to keep or cut, several at once
- Crop, with ratio presets; grow the frame (space above, below or around, in a colour) for
  captions
- Clip fades and crossfades; clip speed, keeping the sound's pitch
- Undo everything, frame-exact snapping, and zoom down to single frames
- Projects (`.rct`) that open in Razorcat, with autosave and recovery

**Export**

- MP4 (H.264 and AAC) or GIF (through [gifski](https://gif.ski))
- Hardware encoding on NVIDIA, AMD and Intel graphics, with a fallback that always works
- The whole timeline, a single clip, selected clips joined, or each clip as its own file
- Straight to a default folder with file-name templates, or choose each time

## Install

Razorcat isn't released yet. When it is, its installer will be on the
[Releases](https://github.com/flowcat-software/razorcat/releases) page. It installs for your
user account only (no administrator rights), and updates itself when you say so, with every
update signed and checked before it installs.

## Updating

Razorcat checks for updates a minute after it starts and once a day. When there's a new
version, it tells you, and you choose when to install it: **Install** in the notification,
**Restart to update** in the tray menu, or **Install and restart** in **Settings › Updates**.
Razorcat downloads the new version, checks that it was signed by Razorcat's developer, and
restarts into it. Your settings are kept. With unsaved changes, it asks you to save them first,
and nothing installs while you're recording or exporting.

- **Check now** in Settings › Updates checks right away.
- **Check for updates automatically** can be turned off. Razorcat then never checks unless you
  press Check now.
- **Update channel:** Beta gets test versions before each release (the default if you
  installed a beta). Stable gets final releases only.
- You can always update by hand: run a newer installer over the old version.

## Verify your download

Optional, but worth it while the installer isn't code-signed. Either check works:

- **Compare its SHA-256** with the release's `SHA256SUMS.txt`. In PowerShell:

  ```powershell
  Get-FileHash .\Razorcat_<version>_x64-setup.exe
  ```

- **Check its build provenance** with the [GitHub CLI](https://cli.github.com). Every
  installer is built by this repository's release workflow, which signs a record of what it
  built. This proves the file came from that workflow, unchanged:

  ```powershell
  gh attestation verify .\Razorcat_<version>_x64-setup.exe --repo flowcat-software/razorcat
  ```

## Privacy

Razorcat works entirely on your PC. It doesn't collect usage data, and it has no account to
sign into. Your videos, recordings and projects never leave your computer unless you share
them.

Its only network connection is the update check: a minute after it starts and once a day, or
when you press Check now, it downloads a small file from GitHub (`raw.githubusercontent.com`)
that names the latest version. The request carries nothing about you: no ID and no usage data,
only what any download sends (your IP address, and the updater's name and version). An update
you install is downloaded from GitHub Releases. Turn automatic checks off in
**Settings › Updates**.

## Feedback and bug reports

Found a bug or have an idea? [Open an issue on GitHub](https://github.com/flowcat-software/razorcat/issues/new),
or look through the [existing issues](https://github.com/flowcat-software/razorcat/issues)
first. For a bug, please include your Razorcat version (**Settings › About**), your Windows
version, and what you did, what you expected and what happened instead.

Security problems are the exception: please report those privately, as
[SECURITY.md](SECURITY.md) explains.

## Building from source

Razorcat is open source. To build it yourself or to contribute, see
[DEVELOPMENT.md](DEVELOPMENT.md).

## License

Copyright © 2026 [Flowcat Software](https://flowcat.studio).

Razorcat is free software: you can redistribute it and/or modify it under the terms of the
[GNU General Public License](LICENSE) as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version.

Razorcat is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY, without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
General Public License for more details.

### Using Razorcat at work

Razorcat is free to download and use. If you use it at or for a business, we ask that you buy
a commercial licence for the builds we publish. It's an inexpensive one-time purchase that
keeps Razorcat going.

- **Free:** personal use, students, K–12 schools, nonprofits and open-source projects.
- **A licence is asked for:** use at or for a business, including client work, monetized
  channels and paid courses, and by colleges and universities.

This is an honour system. Razorcat never checks for a licence, and nothing is locked without
one. It's a request attached to our official builds, not a restriction on the code: the GPL
still gives everyone the right to build Razorcat from source and use it as the GPL allows.
Prices and how to buy will be on Razorcat's website at launch.

Not using it for work? You can still support Razorcat with a donation (coming soon).

### Third-party software

Razorcat ships two separate programs beside it, each under its own licence (in the `licenses`
folder where Razorcat is installed):

- [FFmpeg](https://ffmpeg.org), under the GNU GPL v3.0 or later.
- [gifski](https://gif.ski), under the GNU AGPL v3.0 or later.

The exact builds Razorcat ships, and their source code, are on the
[tools release](https://github.com/flowcat-software/razorcat/releases/tag/tools).
