<p align="center">
  <img src="assets/razorcat-icon.png" width="128" height="128" alt="Razorcat logo">
</p>

<h1 align="center">Razorcat</h1>

<p align="center">
  <strong>The screencast tool built for speedy workflows.</strong><br>
  Record, mark up and export screencasts for Windows, with way fewer clicks.
</p>

<p align="center">
  <strong>Beta</strong> · Windows 10 (1903+) and Windows 11 · x64
</p>

<p align="center">
  <a href="https://github.com/flowcat-software/razorcat/releases"><strong>Download the latest beta</strong></a>
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

> **Razorcat is in beta.** [Download it](https://github.com/flowcat-software/razorcat/releases) and please
> [report anything odd](#feedback-and-bug-reports).

## Contents

- [Why Razorcat?](#why-razorcat)
- [Install](#install)
- [Getting started](#getting-started)
- [Recording](#recording)
- [The editor](#the-editor)
- [Keyboard reference](#keyboard-reference)
- [Features](#features)
- [Updating](#updating)
- [Verify your download](#verify-your-download)
- [Privacy](#privacy)
- [Feedback and bug reports](#feedback-and-bug-reports)
- [Building from source](#building-from-source)
- [License](#license)

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

## Install

1. Download the newest `Razorcat_<version>_x64-setup.exe` from the
   [Releases](https://github.com/flowcat-software/razorcat/releases) page (the one at the top).
2. Run it. Razorcat installs for your user account only, so no administrator rights are
   needed.
3. **Windows SmartScreen will warn you** ("Windows protected your PC"). Beta builds aren't
   code-signed yet, so Windows doesn't recognize them. Click **More info**, then **Run anyway**.
   To check the installer is genuine first, see [Verify your download](#verify-your-download).
4. Razorcat opens, with its icon in the tray. See [Getting started](#getting-started).

From then on, Razorcat updates itself when you say so (see [Updating](#updating)).

Razorcat needs Microsoft Edge WebView2, which is part of Windows 11 and up-to-date Windows 10.
If it's missing, the installer downloads it for you.

## Getting started

1. Open Razorcat from the Start menu. The editor opens, and Razorcat's icon appears in the tray
   (bottom-right, by the clock; it may be under the **^** arrow).
2. **Record:** press **Win+F11** (or **Record** in the editor or the tray), drag over the part of
   the screen you want, and press **Enter**. After a short countdown, Razorcat records. Press
   **Stop** in the small control that floats by your recording (or **Ctrl+Alt+S**).
3. The recording opens on the timeline. Press **Space** to play it, **S** to split it at the
   playhead, and drag the clips' edges to trim them. **Delete** removes a clip you don't want.
4. **Mark it up:** pick a tool from the bar above the picture (or press its key: **A** for an
   arrow, **T** for text), and draw on the picture. Each item gets a bar on the timeline: drag
   its ends to set when it shows.
5. **Export:** press **Ctrl+E** for an MP4, or open the **Export** menu for a GIF, a single
   clip, or each clip as its own file.

The line at the bottom of the editor always says which keys do what for what you're doing, and
every key is listed in **Settings › Keyboard shortcuts** and in the
[Keyboard reference](#keyboard-reference) below.

Closing the editor keeps Razorcat in the tray, so **Win+F11** always works; the first time, it
asks. Click the tray icon to bring the editor back, or right-click it for the menu:

| Tray menu item    | What it does                                                |
| ----------------- | ----------------------------------------------------------- |
| Record            | Same as Win+F11                                             |
| Open editor       | Show the editor                                             |
| Settings          | Open Settings                                               |
| Launch on login   | Start Razorcat with Windows, in the tray (off at first)     |
| Restart to update | Install a new version (shown once one is ready)             |
| Quit Razorcat     | Close Razorcat (asking first, if there are unsaved changes) |

## Recording

Press **Win+F11**, or **Record** in the editor or the tray. The screens dim, and you choose
what to record:

- **Drag** over an area (with Shift, a square), then adjust it with its handles or the arrow
  keys, and press **Enter**.
- **F** records the whole screen under the pointer.
- **W** switches to picking a window: click one to record it.
- **M**, **S**, **C** and **V** turn the microphone, the system's sound, your clicks and your
  camera on or off. The bar under the area shows which are on.
- **Esc** or a right-click cancels.

While it records, a small control shows the time, with **Pause** and **Stop**; it isn't in
the recording. These shortcuts work anywhere while recording, and you can change them in
**Settings › Keyboard shortcuts**:

| Shortcut       | Action                          |
| -------------- | ------------------------------- |
| **Ctrl+Alt+P** | Pause or resume                 |
| **Ctrl+Alt+S** | Stop, and open the recording    |
| **Ctrl+Alt+M** | Mute or unmute the microphone   |
| **Ctrl+Alt+D** | Mute or unmute the system sound |
| **Ctrl+Alt+C** | Note your clicks, or stop       |

When it stops, the recording opens on the timeline. If the timeline already has videos,
Razorcat asks whether to add it or start afresh. Your camera and your clicks arrive as items
on the timeline, not in the picture: move, resize, restyle or delete them like any markup.
Where recordings are saved, and how they're named, is in **Settings › Recording**.

## The editor

The editor has two halves. Above, the **picture**: the tools along the top, their options
under them, and the preview. Below, **time**: the timeline bar (playing, ranges, sound) and
the timeline, with your clips on one track and the markup on lanes above them.

- **Opening videos:** drop files on the editor, use **Open** (Ctrl+O), or right-click a video
  in Explorer › **Open with** › **Razorcat**. MP4, MOV, MKV, WebM and GIF. **Add video**
  (Ctrl+Shift+O) puts another one after the rest, to join recordings.
- **Cutting:** **S** splits at the playhead. Drag a clip's edge to trim it; the clips after it
  move along, so there are never gaps. A trim can always be pulled back out, up to the whole
  recording. Drag a clip by its top to move it.
- **Ranges:** mark stretches with **I** and **O** (or **R** for one at the playhead), as many as
  you like, then **Remove ranges** to cut them out or **Keep ranges** to keep only them.
- **Crop** (C) and **Grow the frame** (G) work on the picture: drag the box's edges, type exact
  sizes, or pick a ratio or a preset (captions above or below, black bars).
- **Speed:** **Ctrl+R** sets the selected clip's speed, by percent or by the length you want.
- **Fades:** select a clip or a markup item and set its fade in and out in the options above
  the timeline; clips can also crossfade into each other.
- **Snapping** lines edges up with the playhead, cuts and other items; hold **Shift** while
  dragging to turn it off, or switch it off in the status bar.
- **Projects:** **Ctrl+S** saves your edits as a project (`.rct`), which opens in Razorcat
  from Explorer. Your videos are never changed. While you work, Razorcat autosaves a copy, and
  after a crash it offers to recover it.

### Marking up

Pick a tool and draw on the picture: arrows, lines, boxes, ellipses, text, callouts, numbered
steps, the pen and highlighter, a spotlight, and redaction (solid, pixelate or blur). Each
item starts at the playhead, with a bar on its lane in the timeline: drag the bar to move it in
time, and its ends to set when it starts and stops.

- **Styles:** the options bar shows the tool's colors, widths, fonts and sizes, and changes the
  selected items too. The number keys pick sizes and Ctrl+number picks colors, as in Vandal.
  Each tool remembers its style.
- **Many at once:** select several items (Ctrl+click or Shift+click, or Ctrl+A for those at
  the playhead), then move them, stretch their timing or change their fades together.
  **Ctrl+C** copies an item; **Ctrl+Shift+V**, **F** and **T** paste its style, fades or
  timing onto the selected ones. **Alt+drag** copies items along the timeline.
- **Redaction:** use **Solid** for anything that must stay unreadable, such as passwords:
  pixelated or blurred text can sometimes be read back with special tools.

### Exporting

**Ctrl+E** exports the whole timeline as an MP4. The **Export** menu has the rest: a GIF, the
selected clip, selected clips joined, or each clip as its own file; a clip's right-click menu
exports just that clip. The first time, Razorcat asks whether exports should go straight to a
folder, named from your templates, or ask where each time. The folder, the file names and
GIF sizes are in **Settings › Export**.

## Keyboard reference

Keys are matched by position, so they work on any keyboard layout. The recording shortcuts
can be changed in **Settings › Keyboard shortcuts**, which also lists all of these.

### Tools

| Keys           | Action              |
| -------------- | ------------------- |
| **V**          | Select              |
| **C**          | Crop                |
| **G**          | Grow the frame      |
| **T**          | Text                |
| **A**          | Arrow               |
| **/** / **\\** | Line                |
| **B**          | Rectangle (box)     |
| **E**          | Ellipse             |
| **Q**          | Callout             |
| **N**          | Step marker         |
| **D**          | Click               |
| **H**          | Highlighter         |
| **P**          | Pen                 |
| **F**          | Spotlight (focus)   |
| **U**          | Redact (blur)       |
| **X**          | Swap the two colors |

### Playing

| Keys                              | Action                          |
| --------------------------------- | ------------------------------- |
| **Space**                         | Play or pause                   |
| **J**                             | Play backward (again: faster)   |
| **K**                             | Pause                           |
| **L**                             | Play forward (again: faster)    |
| **←** / **→**                     | One frame back or forward       |
| **Shift**+**←** / **Shift**+**→** | One second back or forward      |
| **↑** / **↓**                     | The previous or next edit point |
| **Home** / **End**                | The start or the end            |

### Editing

| Keys                                                | Action                                                  |
| --------------------------------------------------- | ------------------------------------------------------- |
| **S**                                               | Split at the playhead                                   |
| **I** / **O**                                       | A range's in or out point                               |
| **R**                                               | A range at the playhead                                 |
| **Del** / **Backspace**                             | Delete what's selected                                  |
| **Esc**                                             | Drop a range's in point, then the selection             |
| **M**                                               | Mute the selected clip                                  |
| **Shift**+**M**                                     | Mute all the sound                                      |
| **Ctrl**+**D**                                      | Duplicate the selected clip                             |
| **Ctrl**+**C** / **Ctrl**+**V**                     | Copy and paste a clip, or markup                        |
| **Ctrl**+**[** / **Ctrl**+**]**                     | Move a clip earlier or later, or markup back or forward |
| **Ctrl**+**Shift**+**[** / **Ctrl**+**Shift**+**]** | To the start or end, or to the back or front            |
| **Ctrl**+**R**                                      | The selected clip's speed                               |
| **Ctrl**+**Shift**+**V**                            | Paste the copied markup's style onto the selected       |
| **Ctrl**+**Shift**+**F**                            | Paste its fades (a clip's too)                          |
| **Ctrl**+**Shift**+**T**                            | Paste its timing                                        |
| **Ctrl**+**Z**                                      | Undo                                                    |
| **Ctrl**+**Y** / **Ctrl**+**Shift**+**Z**           | Redo                                                    |
| **Ctrl**+**0**                                      | Fit the timeline                                        |
| **Ctrl**+**=** / **Ctrl**+**−**                     | Zoom the timeline in or out                             |
| **Shift**+drag                                      | Drag without snapping                                   |
| **Alt**+drag                                        | Drag a copy                                             |
| **Ctrl**+click / **Shift**+click                    | Add to the selection                                    |

### Marking up

| Keys                                          | Action                                                  |
| --------------------------------------------- | ------------------------------------------------------- |
| **1…0**                                       | Line width, text size or strength, by tool              |
| **Shift**+**1…0**                             | A callout's pointer thickness                           |
| **Alt**+**1…0**                               | Font, or corner radius for rectangles and spotlights    |
| `` ` `` / **Shift**+`` ` `` / **Alt**+`` ` `` | The lowest of those (the key left of 1)                 |
| **Alt**+**↑** / **Alt**+**↓**                 | The previous or next font                               |
| **Ctrl**+**1…9**                              | Color (the first, with two)                             |
| **Ctrl**+**Shift**+**1…9**                    | The second color                                        |
| **Ctrl**+**B** / **Ctrl**+**I**               | Bold, italic                                            |
| **Ctrl**+**A**                                | Select the markup at the playhead (again: all of it)    |
| **Ctrl**+**D**                                | Duplicate the selected markup                           |
| **←↑↓→**                                      | Nudge, after a click on the picture (with Shift: 10 px) |
| **Enter**                                     | Edit the selected text, callout or step label           |
| **Esc**                                       | Deselect, then back to Select                           |
| **Shift**+drag                                | Square, circle, 45° lines, straight moves               |

### Cropping

| Keys                | Action                                 |
| ------------------- | -------------------------------------- |
| **←↑↓→**            | Move the crop (with Shift: 10 px)      |
| **Ctrl**+**←↑↓→**   | Resize it from the bottom-right corner |
| **Enter** / **Esc** | Done                                   |

### Files

| Keys                     | Action                      |
| ------------------------ | --------------------------- |
| **Ctrl**+**O**           | Open a video or project     |
| **Ctrl**+**Shift**+**O** | Add a video to the timeline |
| **Ctrl**+**S**           | Save the project            |
| **Ctrl**+**Shift**+**S** | Save the project as         |
| **Ctrl**+**E**           | Export an MP4               |
| **Ctrl**+**,**           | Settings                    |

### Choosing what to record

| Keys                  | Action                                        |
| --------------------- | --------------------------------------------- |
| drag                  | Choose an area (Shift: square)                |
| **F**                 | Record the screen under the pointer           |
| **W**                 | Choose a window instead (again, or Esc: back) |
| **Enter**             | Record                                        |
| **←↑↓→**              | Move the area (with Shift: 10 px)             |
| **Ctrl**+**←↑↓→**     | Resize it                                     |
| **M** / **S**         | Microphone, system sound on or off            |
| **C** / **V**         | Clicks, camera on or off                      |
| **Esc** / right-click | Cancel                                        |

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
