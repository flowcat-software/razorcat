// Development: the preview = export check (PLAN 1.8; check.rs). Over a barcoded test clip
// (`spikes/make-test-media.mjs`), it steps and seeks the preview as the keys do, waits for each
// frame to be on screen, and reads its barcode: the source frame shown. Each must be the frame
// export picks at that grid frame (ffmpeg's `fps` filter, read by Rust). The proxy, which shows
// while stepping fast and scrubbing (and which the thumbnails come from), is checked the same
// way if it's ready by then.
//
// Edited (`--check-edit`), the timeline is cut up first (split four times, a piece deleted,
// another moved to the front), and the file is added again as a second one (PLAN 4.5e: the same
// barcodes), its second half moved to second place, so cuts change files. The steps and seeks
// cross the cuts, and a last pass plays across them, reading every picture presented: none may
// come from anywhere but the next frames of the edit (nothing cut out, nothing out of order).
// Then the edit is exported whole (an input per file); cropped (two
// barcode cells off each side and the top quarter off, odd sizes, which export evens), so the
// export must show the twelve cells between; and cropped and grown (white where the two cells
// were on each side, and on top), so the four outer cells read white. Last, with markup (PLAN
// 4.3c): two solid magenta items, one over a cut, sent as an export sends them; each item's
// corner pixels must be magenta on its frames and, on every other frame, not magenta unless
// the export without them is there too (the picture under them is anything). A third fades in
// and out (4.4c): on each of its frames, its corners must be magenta laid over the export
// without it at the ramp's opacity (`markOpacity`, the preview's).
// Two highlights (PLAN 4.5c), yellow: each pixel under one must be the export without markup
// multiplied by it (towards white as it fades), and one under item 2 must leave it on top.
// Then spotlights (PLAN 4.5g), on their own: two holes in one run of darkness, overlapping, each
// pixel the export without markup darkened by as much as is left of it there. Last, clip fades
// (PLAN 4.7a): the second clip fading in and out, each pixel the unfaded export's at the
// preview's ramp (`clipOpacityAt`), its barcode not read on those frames.
import { commands, uploadPixels, type ExportMark } from "../shared/ipc";
import { clipOpacityAt, clipStarts, markOpacity, total } from "./doc";
import { useDoc } from "./docStore";
import { exportClips, exportFrame } from "./exports";
import { outputSize } from "./frame";
import type { Player } from "./player";
import { fadedAt } from "./spotlights";

/** The barcode: cells along the bottom sixteenth of the picture, least significant on the left. */
const BITS = 16;
/** Frames stepped one by one, from the start (all of a short clip). */
const STEPS = 1500;
/** Frames sought at random. */
const SEEKS = 150;
/** The longest a frame may take to show (ms). */
const PATIENCE = 5000;
/** Playing, how many frames may be dropped between two presented (a slow moment). */
const DROPS = 12;
/** How far (0–255) a faded item's pixel may be from its blend: two lossy encodes differ. */
const FADE_NOISE = 32;

/** The number in a row of RGBA pixels across the barcode: each cell's middle, white = 1. */
export function readBarcode(row: Uint8ClampedArray, width: number): number {
  let n = 0;
  for (let k = 0; k < BITS; k++) {
    const i = Math.floor(((k + 0.5) * width) / BITS) * 4;
    if ((row[i] + row[i + 1] + row[i + 2]) / 3 >= 128) n |= 1 << k;
  }
  return n;
}

/** Frames in random order but the same each run, so a failure can be repeated. */
export function seeded(count: number, frames: number, seed = 1): number[] {
  let s = seed;
  return Array.from({ length: count }, () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) % frames;
  });
}

interface Miss {
  pass: string;
  frame: number;
  expected: number;
  /** What's on screen (by barcode). */
  shown: number;
  /** The player never said the frame was on screen: what's shown is what was there by then. */
  late?: boolean;
  /** Late on the original: what the player saw. */
  times?: ReturnType<Player["originalTimes"]>;
}

/** Waits (by animation frames) until `ready`, or gives up. */
function until(ready: () => boolean, ms = PATIENCE): Promise<boolean> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (ready()) resolve(true);
      else if (performance.now() - t0 > ms) resolve(false);
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

/**
 * Runs the check on the open source; `progress` gets a line for the status bar. Returns the
 * summary (the report is kept by Rust, in the temp folder).
 */
export async function checkFrames(
  player: Player,
  /** The picture as shown, and the degrees clockwise the stored one is turned to show it. */
  shown: { width: number; height: number; rotation: number },
  progress: (text: string) => void,
  /** Another file was opened (or the page is going): stop. */
  stopped: () => boolean,
  /** Cut the timeline up first, and play across the cuts. */
  edited: boolean,
) {
  const t0 = performance.now();
  if (edited) {
    // Five clips; the second deleted, the fourth moved to the front.
    const doc = useDoc.getState();
    const n = total(doc.doc);
    for (const at of [0.2, 0.35, 0.6, 0.8]) doc.split(Math.round(n * at));
    const clips = useDoc.getState().doc.clips;
    doc.remove(clips[1].id);
    doc.move(clips[3].id, 0);
    // The second file: on the end once Rust has it, then split, its second half second.
    progress("Checking frames: adding the second file…");
    const added = await commands.frameCheckAdd();
    if (added.status === "error") throw new Error(added.error);
    const second = () => useDoc.getState().doc.sources[1]?.id;
    if (!(await until(() => !!second() && player.loaded(second()!), 30_000))) {
      throw new Error("the second file didn't load");
    }
    const now = useDoc.getState().doc;
    const last = now.clips[now.clips.length - 1];
    const from = clipStarts(now)[now.clips.length - 1];
    doc.split(from + Math.round((last.out - last.in) / 2));
    const split = useDoc.getState().doc.clips;
    doc.move(split[split.length - 1].id, 1);
  }
  progress("Checking frames: reading what export picks…");
  const got = await commands.frameCheckExpected();
  if (got.status === "error") throw new Error(got.error);
  const bySource = got.data;
  /** What export shows at timeline frame `k`. */
  const want = (k: number) => bySource[player.sourceFrame(k)];
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  // Upright, as the preview shows it: the preview turns the original with CSS (the proxy is
  // made upright), and the barcode is along the bottom of the upright picture.
  const read = (video: HTMLVideoElement) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const sideways = shown.rotation % 180 === 90;
    const upright = vw > vh === shown.width > shown.height;
    const turn = sideways && !upright ? shown.rotation : 0;
    const [w, h] = turn ? [vh, vw] : [vw, vh];
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    g.setTransform(1, 0, 0, 1, w / 2, h / 2);
    g.rotate((turn * Math.PI) / 180);
    g.drawImage(video, -vw / 2, -vh / 2, vw, vh);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return readBarcode(g.getImageData(0, Math.floor(h - h / 32), w, 1).data, w);
  };

  const misses: Miss[] = [];
  /** `covered`: frames the original couldn't show, which the proxy did. */
  const passes: { pass: string; checked: number; misses: number; covered: number }[] = [];
  const pass = async (name: string, frames: number[], go: (k: number, i: number) => void) => {
    // The proxy passes read the proxy; the others whatever is on top (the original, or the proxy
    // covering a frame the original can't show).
    const onProxy = name.startsWith("proxy");
    const which = () => (onProxy ? (player.shows("proxy") ? "proxy" : null) : player.onScreen());
    let checked = 0;
    let missed = 0;
    let covered = 0;
    for (let i = 0; i < frames.length; i++) {
      if (stopped()) throw new Error("stopped");
      const k = frames[i];
      go(k, i);
      const late = !(await until(() => which() !== null));
      const on = which() ?? (onProxy ? "proxy" : "original");
      if (!onProxy && on === "proxy") covered++;
      const shown = read(player.video(on)!);
      checked++;
      const expected = want(k);
      if (expected !== undefined && (late || shown !== expected)) {
        missed++;
        misses.push({
          pass: name,
          frame: k,
          expected,
          shown,
          ...(late && { late, times: player.originalTimes() }),
        });
      }
      if (i % 25 === 0) progress(`Checking frames: ${name} ${i + 1}/${frames.length}…`);
    }
    passes.push({ pass: name, checked, misses: missed, covered });
  };

  const n = player.frames;
  const steps = Array.from({ length: Math.min(n, STEPS) }, (_, i) => i);
  const seeks = seeded(SEEKS, n);
  // As the arrow keys: a single step waits for the original; held, the proxy keeps up.
  await pass("step", steps, (k) => (k === 0 ? player.seek(0, false) : player.step(1)));
  await pass("seek", seeks, (k) => player.seek(k, false));
  if (player.video("proxy")) {
    await pass("proxy step", steps, (k) => (k === 0 ? player.seek(0) : player.step(1, true)));
    await pass("proxy seek", seeks, (k) => player.seek(k));
  }

  // Playing across the cuts: from a second before each of the first three to a second after,
  // every picture presented, in order; and the longest pause between two, at a cut.
  let gap = 0;
  if (edited) {
    const videos = player.originals();
    const second = Math.round(player.fps);
    const cuts = clipStarts(useDoc.getState().doc).slice(1, 4);
    let played = 0;
    let wrong = 0;
    for (const cut of cuts) {
      progress(`Checking frames: playing across the cut at frame ${cut}…`);
      const from = Math.max(0, cut - second);
      const last = Math.min(n - 1, cut + second);
      player.seek(from, false);
      await until(() => player.onScreen() !== null);
      const seen: { shown: number; at: number }[] = [];
      let recording = true;
      // Each file's video, counted only while it's the one on screen (the next is loaded
      // ahead, hidden).
      const watch = (video: HTMLVideoElement) => {
        const onFrame = (now: number) => {
          if (!recording) return;
          if (player.video("original") === video) seen.push({ shown: read(video), at: now });
          video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
      };
      videos.forEach(watch);
      player.toggle();
      await until(() => player.getState().frame >= last || player.getState().speed === 0, 30_000);
      recording = false;
      player.pause();
      // Each picture must be the edit's frame at the playhead's place or a little after it.
      let t = from;
      for (let i = 0; i < seen.length; i++) {
        const upTo = Math.min(last, t + DROPS);
        let j = t;
        while (j <= upTo && want(j) !== seen[i].shown) j++;
        if (j > upTo) {
          wrong++;
          misses.push({ pass: "play", frame: t, expected: want(t), shown: seen[i].shown });
          continue;
        }
        t = j;
        if (i > 0) gap = Math.max(gap, seen[i].at - seen[i - 1].at);
      }
      played += seen.length;
    }
    passes.push({ pass: "play", checked: played, misses: wrong, covered: 0 });

    // Export = preview: the edit exported (as Export does), every frame of it.
    progress("Checking frames: exporting the edit…");
    const exportPass = async (
      pass: string,
      cells: number,
      expect: (k: number) => number,
      marks: ExportMark[] = [],
      probes: { x: number; y: number }[] = [],
      /** Frames whose barcode isn't read (faded too dark to). */
      unread: (k: number) => boolean = () => false,
    ) => {
      const { doc } = useDoc.getState();
      const exported = await commands.frameCheckExport(
        exportClips(doc),
        exportFrame(doc),
        marks,
        probes,
        cells,
      );
      if (exported.status === "error") throw new Error(exported.error);
      const shownFrames = exported.data.barcodes;
      let wrong = 0;
      for (let k = 0; k < Math.max(n, shownFrames.length); k++) {
        if (unread(k) || shownFrames[k] === expect(k)) continue;
        wrong++;
        misses.push({ pass, frame: k, expected: expect(k), shown: shownFrames[k] ?? -1 });
      }
      passes.push({ pass, checked: n, misses: wrong, covered: 0 });
      return exported.data.probes;
    };
    await exportPass("export", BITS, want);

    // Cropped: cells 2 to 13 left, the top quarter gone; odd sizes and an odd top.
    progress("Checking frames: exporting the edit cropped…");
    const { width, height } = shown;
    const top = Math.round(height / 4) + 1;
    useDoc.getState().crop({
      x: Math.round((width * 2) / BITS),
      y: top,
      width: Math.round((width * 12) / BITS) + 1,
      height: height - top,
    });
    await exportPass("export cropped", 12, (k) => (want(k) >> 2) & 0xfff);

    // Grown back to the width in white, an odd pixel more on the right and on top (both made
    // even): the outer two cells each side read 1.
    progress("Checking frames: exporting the edit cropped and grown…");
    const crop = useDoc.getState().doc.frame.crop;
    useDoc.getState().grow({
      top: 101,
      bottom: 0,
      left: crop.x,
      right: width - crop.x - crop.width + 1,
      colour: "#ffffff",
      colours: {},
    });
    await exportPass("export grown", BITS, (k) => (want(k) & 0x3ffc) | 0xc003);
    useDoc.getState().crop({ x: 0, y: 0, width, height });
    useDoc.getState().grow({ ...useDoc.getState().doc.frame.grow, top: 0, left: 0, right: 0 });

    // Markup: three items, at even places and sizes (whole 4:2:0 blocks, so the corners keep
    // their colour), one from 5 frames before the first cut to 5 after it; and two highlights
    // (PLAN 4.5c), yellow, multiplied in: the first under the second item, a little longer, so
    // the item must stay on top; the second fading in and out, towards white.
    progress("Checking frames: exporting the edit with markup…");
    const even = (v: number) => Math.round(v / 2) * 2;
    const cut = clipStarts(useDoc.getState().doc)[1];
    const size = { width: even(width / 10), height: even(height / 10) };
    const still = { fadeIn: 0, fadeOut: 0, layer: { kind: "item" } } as const;
    const lit = (m: ExportMark) => m.layer.kind === "highlight";
    const marks: ExportMark[] = [
      {
        id: 1,
        x: even(width / 4),
        y: even(height / 3),
        ...size,
        start: cut - 5,
        end: cut + 5,
        ...still,
      },
      { id: 2, x: even(width * 0.6), y: even(height / 5), ...size, start: 10, end: 20, ...still },
      {
        id: 3,
        x: even(width * 0.6),
        y: even(height * 0.6),
        ...size,
        start: 40,
        end: 52,
        fadeIn: 4,
        fadeOut: 4,
        layer: { kind: "item" },
      },
      {
        id: 4,
        x: even(width * 0.6),
        y: even(height / 5),
        ...size,
        start: 5,
        end: 25,
        ...still,
        layer: { kind: "highlight" },
      },
      {
        id: 5,
        x: even(width / 4),
        y: even(height * 0.6),
        ...size,
        start: 60,
        end: 72,
        fadeIn: 4,
        fadeOut: 4,
        layer: { kind: "highlight" },
      },
    ];
    const MAGENTA = [255, 0, 255];
    const YELLOW = [255, 255, 0];
    const probes = marks.flatMap((m) => [
      { x: m.x, y: m.y },
      { x: m.x + m.width - 1, y: m.y + m.height - 1 },
    ]);
    const bare = await exportPass("export unmarked", BITS, want, [], probes);
    for (const m of marks) {
      const pixels = new Uint8ClampedArray(m.width * m.height * 4);
      const [r, g, b] = lit(m) ? YELLOW : MAGENTA;
      for (let i = 0; i < pixels.length; i += 4) pixels.set([r, g, b, 255], i);
      await uploadPixels(`http://media.localhost/markup/${m.id}`, pixels);
    }
    const marked = await exportPass("export marked", BITS, want, marks, probes);
    // Highlights first (beneath), then the rest, back to front, as the export lays them.
    const layered = [...marks.filter(lit), ...marks.filter((m) => !lit(m))];
    let wrongMarks = 0;
    for (let k = 0; k < n; k++) {
      probes.forEach((at, p) => {
        const [r, g, b] = marked[k]?.slice(p * 3, p * 3 + 3) ?? [];
        const [r0, g0, b0] = bare[k]?.slice(p * 3, p * 3 + 3) ?? [];
        // What should be there: the export without markup, then each item over the probe on
        // this frame, at its opacity: a highlight multiplied in, an item laid over.
        let want3 = [r0, g0, b0];
        let covered = false;
        let solid = false;
        for (const m of layered) {
          const inside =
            m.x <= at.x && at.x < m.x + m.width && m.y <= at.y && at.y < m.y + m.height;
          if (!inside || k < m.start || k >= m.end) continue;
          covered = true;
          const a = markOpacity(m, m.end - m.start, k - m.start);
          want3 = lit(m)
            ? want3.map((c, i) => c * (1 - a + (a * YELLOW[i]) / 255))
            : want3.map((c, i) => a * MAGENTA[i] + (1 - a) * c);
          solid = !lit(m) && a === 1;
        }
        // Magenta, more or less (an encode's colour at a block's corner wanders a little).
        const magenta = (r: number, g: number, b: number) => r > 180 && g < 80 && b > 180;
        const near = (c: number[]) =>
          Math.max(Math.abs(r - c[0]), Math.abs(g - c[1]), Math.abs(b - c[2])) <= FADE_NOISE;
        // Nothing over it: not magenta where the export without markup isn't, or close to it (a
        // pixel of two encodes can differ a little anywhere: the encoder spends its bits
        // differently; purple in the picture can pass for magenta). An item on top: magenta.
        // Otherwise (a highlight, a fade): what's worked out, within the encodes' noise.
        const right = !covered
          ? !magenta(r, g, b) || magenta(r0, g0, b0) || near([r0, g0, b0])
          : solid
            ? magenta(r, g, b)
            : near(want3);
        if (right) return;
        wrongMarks++;
        const m = marks[Math.floor(p / 2)];
        const rgb = (c: number[]) =>
          (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]);
        misses.push({
          pass: `markup ${m.id} ${p % 2 ? "end" : "start"} corner`,
          frame: k,
          expected: solid ? 1 : rgb(want3),
          shown: (r << 16) | (g << 8) | b,
        });
      });
    }
    passes.push({ pass: "markup", checked: n * probes.length, misses: wrongMarks, covered: 0 });

    // Spotlights: one run of darkness, 40% (light enough for the barcode to read), frames 80 to
    // 110, fading in and out over 4; a hole from its start to 100, closing over its last 4 as the
    // second goes on; the second from 90 to its end, opening over its first 4.
    progress("Checking frames: exporting the edit with spotlights…");
    const DIM = 40;
    const hole = (id: number, x: number, start: number, end: number, fadeIn: number) => ({
      id,
      x,
      y: even(height / 3),
      ...size,
      start,
      end,
      fadeIn,
      fadeOut: 4 - fadeIn,
      layer: { kind: "hole" } as const,
    });
    const holes = [hole(6, even(width / 4), 80, 100, 0), hole(7, even(width * 0.6), 90, 110, 4)];
    const run = { start: 80, end: 110, fadeIn: 4, fadeOut: 4 };
    const spotlit: ExportMark[] = [
      ...holes,
      {
        id: 0,
        x: 0,
        y: 0,
        ...outputSize(useDoc.getState().doc.frame),
        ...run,
        layer: { kind: "dark", dim: DIM },
      },
    ];
    // Each hole's corners, and a pixel in the dark outside them.
    const spots = [
      ...holes.flatMap((m) => [
        { x: m.x, y: m.y },
        { x: m.x + m.width - 1, y: m.y + m.height - 1 },
      ]),
      { x: even(width * 0.4), y: even(height / 6) },
    ];
    const plain = await exportPass("export unspotlit", BITS, want, [], spots);
    for (const m of holes) {
      const pixels = new Uint8ClampedArray(m.width * m.height * 4);
      for (let i = 0; i < pixels.length; i += 4) pixels.set([0, 0, 0, 255], i);
      await uploadPixels(`http://media.localhost/markup/${m.id}`, pixels);
    }
    const shaded = await exportPass("export spotlit", BITS, want, spotlit, spots);
    let wrongSpots = 0;
    for (let k = 0; k < n; k++) {
      spots.forEach((at, p) => {
        const got = shaded[k]?.slice(p * 3, p * 3 + 3) ?? [];
        const under = plain[k]?.slice(p * 3, p * 3 + 3) ?? [];
        // What's left of the darkness here: none in an open hole.
        let left = (DIM / 100) * fadedAt(run, k);
        for (const m of holes) {
          const inside =
            m.x <= at.x && at.x < m.x + m.width && m.y <= at.y && at.y < m.y + m.height;
          if (inside) left *= 1 - fadedAt(m, k);
        }
        const want3 = [...under].map((c) => c * (1 - left));
        // Off the run: not darkened (two encodes of the same picture can differ a lot in a
        // saturated corner, but not all its channels by the darkness at once). On it: as worked
        // out, within the encodes' noise.
        const darkened =
          [...under].some((c) => c >= 64) &&
          [...under].every((c, i) => c < 64 || got[i] <= c * (1 - DIM / 100) + FADE_NOISE / 4);
        const right =
          k < run.start || k >= run.end
            ? !darkened
            : want3.every((c, i) => Math.abs(got[i] - c) <= FADE_NOISE);
        if (right) return;
        wrongSpots++;
        const rgb = (c: number[]) =>
          (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]);
        misses.push({
          pass:
            p < 4 ? `spotlight ${holes[p >> 1].id} ${p % 2 ? "end" : "start"} corner` : "the dark",
          frame: k,
          expected: rgb(want3),
          shown: rgb([...got]),
        });
      });
    }
    passes.push({ pass: "spotlights", checked: n * spots.length, misses: wrongSpots, covered: 0 });

    // Clip fades: the second clip fading in from black over 6 frames and out over 8.
    progress("Checking frames: exporting the edit with a clip faded…");
    const fadedClip = useDoc.getState().doc.clips[1].id;
    useDoc.getState().setClipFades(fadedClip, { fadeIn: 6 });
    useDoc.getState().setClipFades(fadedClip, { fadeOut: 8 });
    const fadedDoc = useDoc.getState().doc;
    const shows = (k: number) => clipOpacityAt(fadedDoc, k);
    const dimmed = await exportPass(
      "export clip faded",
      BITS,
      want,
      [],
      spots,
      (k) => shows(k) < 1,
    );
    let wrongFades = 0;
    for (let k = 0; k < n; k++) {
      spots.forEach((_, p) => {
        const got = dimmed[k]?.slice(p * 3, p * 3 + 3) ?? [];
        const want3 = [...(plain[k]?.slice(p * 3, p * 3 + 3) ?? [])].map((c) => c * shows(k));
        // A fade darkens every channel by as much: wrong when all the bright ones are off (two
        // encodes of a saturated corner can differ a lot in one channel, faded or not).
        const near = (i: number) => Math.abs(got[i] - want3[i]) <= FADE_NOISE;
        const bright = [0, 1, 2].filter((i) => Math.max(got[i], want3[i]) >= 64);
        if (bright.length ? bright.some(near) : [0, 1, 2].every(near)) return;
        wrongFades++;
        const rgb = (c: number[]) =>
          (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]);
        misses.push({
          pass: `clip fade, probe ${p}`,
          frame: k,
          expected: rgb(want3),
          shown: rgb([...got]),
        });
      });
    }
    passes.push({ pass: "clip fades", checked: n * spots.length, misses: wrongFades, covered: 0 });
    useDoc.getState().clipRemoveFades([fadedClip], "both");
  }

  const wrongs = misses.length;
  const summary =
    `${bySource.length} frames${edited ? `, edited to ${n} over two files` : ""}: ` +
    passes
      .map(
        (p) =>
          `${p.pass} ${p.checked - p.misses}/${p.checked}` +
          (p.covered ? ` (${p.covered} by the proxy)` : ""),
      )
      .join(", ") +
    (player.video("proxy") ? "" : ", no proxy to check") +
    (gap ? `, longest pause playing ${gap.toFixed(0)} ms` : "") +
    (wrongs ? `; ${wrongs} wrong` : "; all match") +
    ` in ${((performance.now() - t0) / 1000).toFixed(0)} s`;
  const report = JSON.stringify({ frames: n, edited, passes, misses }, null, 1);
  await commands.frameCheckReport(summary, report);
  return summary;
}
