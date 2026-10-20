import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { duplicateSelection } from "../markup/objectActions";
import type { SourceInfo, ThumbsInfo } from "../shared/ipc";
import type { Player } from "./player";
import { ThumbStrip } from "./thumbs";
import { Peaks, waveHeight } from "./wave";
import { timecode, needsHours } from "./timecode";
import {
  clipAt,
  clipLength,
  clipStarts,
  LANES,
  moveSlot,
  markLabel,
  rangeRoom,
  shownMarks,
  shownRanges,
  total,
  type Clip,
  type ClipId,
  type Doc,
  type MarkId,
  type RangeId,
  type ShownMark,
  type ShownRange,
} from "./doc";
import { useDoc } from "./docStore";
import { deleteSelected, splitAtPlayhead } from "./edits";
import { exportClip } from "./exports";
import { Menu, type MenuItems } from "./Menu";
import { markTargets, rangeTargets, scrubTargets, snap, trimTargets } from "./snap";
import { useTimeline } from "./timelineStore";
import { FRAME_TICKS, HEADER, fOf, ticks, xOf, zoomAnchor, type View } from "./timelineView";
import styles from "./EditorApp.module.css";

interface Props {
  source: SourceInfo;
  player: Player;
  /** The ruler labels frames, as the readout does (else timecode). */
  inFrames: boolean;
  /** The clip's thumbnails, once they're being made. */
  thumbs: ThumbsInfo | null;
  /** Where its waveform is, once it's made. */
  waveUrl: string | null;
}

// The mockup's geometry (mockup/main.html): the ruler, the markup lanes, the clip track.
const RULER = 30;
/** The strip along the ruler's top: ranges' bars; drag on it to draw one. */
const RANGE_STRIP = 11;
const LANE_TOP = RULER + 8;
const LANE_H = 24;
/** A lane's top, and its height with the gap after it. */
const laneY = (lane: number) => LANE_TOP + lane * (LANE_H + 4);
const CLIP_TOP = laneY(LANES) + 4;
const CLIP_H = 76;
/** The clip's label row, above its thumbnails. */
const LABEL_H = 18;
/** The waveform's band, below them. */
const WAVE_H = 20;
const THUMB_TOP = CLIP_TOP + LABEL_H;
const THUMB_H = CLIP_H - LABEL_H - WAVE_H;
const WAVE_MID = CLIP_TOP + CLIP_H - WAVE_H / 2;
const CLIP_GAP = 0.5;
const CLIP_RADIUS = 8;
/** How near (px, either side) a clip's edge the pointer grabs it. */
const EDGE_HIT = 7;
/** How far (px) the pointer must move before a title bar's press becomes a drag. */
const DRAG_PX = 3;
/** How long the pointer rests on a handle before its tooltip shows. */
const TIP_DELAY = 600;

const TOKENS = [
  "accent",
  "text-2",
  "text-3",
  "tl-bg",
  "tl-lane",
  "clip",
  "border",
  "playhead",
  "snap",
  "range",
  "range-edge",
  "mark",
];

type Edge = "in" | "out";

/**
 * What the pointer is on: a clip's edge (trims it) or title bar (moves it); a range's edge
 * (resizes it) or bar (moves it); the empty range strip (draws one); the pending in-point;
 * markup's edge (when it starts or ends) or bar (moves it, along or to another lane).
 */
type Hit =
  | { kind: Edge | "move"; clip: Clip }
  | { kind: "rangeA" | "rangeB" | "rangeMove"; range: ShownRange }
  | { kind: "markStart" | "markEnd" | "markMove"; mark: ShownMark }
  | { kind: "rangeNew" | "pendingIn" };

/** What a handle does (the mockup's tooltips). */
const TIPS: Record<Hit["kind"], [string, string]> = {
  in: ["Trim the clip's start", "the rest ripples along · Alt: no snap"],
  out: ["Trim the clip's end", "the rest ripples along · Alt: no snap"],
  move: ["Move the clip", "drag left or right · Ctrl+[ ]"],
  rangeA: ["Range start", "drag"],
  rangeB: ["Range end", "drag"],
  rangeMove: ["Move the range", "drag"],
  rangeNew: ["Draw a range", "drag · or R, or I and O"],
  pendingIn: ["Pending in-point", "drag to adjust · O sets the out"],
  markStart: ["When it starts", "drag"],
  markEnd: ["When it ends", "drag"],
  markMove: ["Move it in time", "drag · up or down: the other lane"],
};

const CURSORS: Record<Hit["kind"], string> = {
  in: "ew-resize",
  out: "ew-resize",
  move: "grab",
  rangeA: "ew-resize",
  rangeB: "ew-resize",
  rangeMove: "grab",
  rangeNew: "crosshair",
  pendingIn: "ew-resize",
  markStart: "ew-resize",
  markEnd: "ew-resize",
  markMove: "grab",
};

/** A trim under way: the edge, where the drag started, and the clip as it was. */
interface Trim {
  id: ClipId;
  edge: Edge;
  x0: number;
  /** Where the clip starts on the timeline (a trim doesn't move it). */
  start: number;
  orig: Clip;
  /** What it may snap to, fixed at the start (`trimTargets`). */
  targets: number[];
}

/**
 * A range drag under way: an edge, the whole range, a new one being drawn (from `from`), or
 * the pending in-point.
 */
interface RangeDrag {
  kind: "a" | "b" | "move" | "new" | "pendingIn";
  /** The range (a new one: once it's a frame long). */
  id: RangeId | null;
  x0: number;
  /** The range as it was (a new one: where the drag started, twice). */
  orig: { a: number; b: number };
}

/**
 * A markup drag under way: an edge or the whole of it, from where, and its place when it
 * started.
 */
interface MarkDrag {
  kind: "start" | "end" | "move";
  id: MarkId;
  x0: number;
  orig: { start: number; end: number; lane: number };
  /** The playhead when the drag started: an edge drag moves it, so it snaps to where it was. */
  playhead: number;
}

/** The lane at y (kept to the lanes). */
const laneAt = (y: number) =>
  Math.max(0, Math.min(LANES - 1, Math.floor((y - LANE_TOP) / (LANE_H + 4))));

/**
 * What's at (x, y): on the ruler, ranges and the pending in-point; in the lanes, markup; on the
 * clip track, clips.
 */
function hitAt(doc: Doc, pendingIn: number | null, view: View, x: number, y: number): Hit | null {
  if (x < HEADER) return null;
  if (y < RULER) {
    if (pendingIn !== null && Math.abs(x - xOf(view, pendingIn)) <= EDGE_HIT) {
      return { kind: "pendingIn" };
    }
    const ranges = shownRanges(doc);
    for (const range of ranges) {
      if (Math.abs(x - xOf(view, range.a)) <= EDGE_HIT) return { kind: "rangeA", range };
      if (Math.abs(x - xOf(view, range.b)) <= EDGE_HIT) return { kind: "rangeB", range };
    }
    if (y >= RANGE_STRIP + 2) return null;
    // A range's bar moves it; the empty strip draws a new one.
    const range = ranges.find((r) => x > xOf(view, r.a) && x < xOf(view, r.b));
    return range ? { kind: "rangeMove", range } : { kind: "rangeNew" };
  }
  if (y < CLIP_TOP - 4) {
    // Last drawn on top: found first.
    for (const mark of shownMarks(doc).reverse()) {
      const y0 = laneY(mark.lane);
      if (y < y0 || y > y0 + LANE_H) continue;
      const x0 = xOf(view, mark.start);
      const x1 = xOf(view, mark.end);
      if (x < x0 - EDGE_HIT || x > x1 + EDGE_HIT) continue;
      // A short bar's edges leave a middle to move it by.
      const reach = Math.min(EDGE_HIT, (x1 - x0) / 3);
      if (Math.abs(x - x0) <= reach || (x < x0 && x >= x0 - EDGE_HIT)) {
        return { kind: "markStart", mark };
      }
      if (Math.abs(x - x1) <= reach || (x > x1 && x <= x1 + EDGE_HIT)) {
        return { kind: "markEnd", mark };
      }
      if (x > x0 && x < x1) return { kind: "markMove", mark };
    }
    return null;
  }
  if (y > CLIP_TOP + CLIP_H) return null;
  const starts = clipStarts(doc);
  const last = doc.clips.length - 1;
  // Edges first. The boundary between two clips belongs to whichever side the pointer is on;
  // the timeline's two ends reach outward too.
  for (let i = 0; i <= last; i++) {
    const clip = doc.clips[i];
    const x0 = xOf(view, starts[i]);
    const x1 = xOf(view, starts[i] + clipLength(clip));
    if (Math.abs(x - x0) <= EDGE_HIT && x >= x0 - (i === 0 ? EDGE_HIT : 0)) {
      return { kind: "in", clip };
    }
    if (Math.abs(x - x1) <= EDGE_HIT && x <= x1 + (i === last ? EDGE_HIT : 0)) {
      return { kind: "out", clip };
    }
  }
  if (y >= CLIP_TOP + LABEL_H) return null;
  const under = clipAt(doc, Math.floor(fOf(view, x)));
  return under && { kind: "move", clip: under.clip };
}

/** What a hit is on: its clip, range or markup, for telling hits apart. */
const hitId = (h: Hit) =>
  "clip" in h ? h.clip.id : "range" in h ? -h.range.id : "mark" in h ? 1e6 + h.mark.id : 0;

const sameHit = (a: Hit | null, b: Hit | null) =>
  a === b || (!!a && !!b && a.kind === b.kind && hitId(a) === hitId(b));

/** A change in frames, signed: "+14 frames", "−3 frames". */
const signed = (n: number) =>
  `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)} ${Math.abs(n) === 1 ? "frame" : "frames"}`;

/**
 * Canvas can't read `light-dark()`: each colour token is resolved through a probe element, and
 * read again (with `onChange` called to redraw) when the theme changes.
 */
function useColours(onChange: () => void): () => Record<string, string> {
  const colours = useRef<Record<string, string>>({});
  const stale = useRef(true);
  const [read] = useState(() => () => {
    if (stale.current) {
      const probe = document.createElement("div");
      probe.style.display = "none";
      document.body.append(probe);
      for (const t of TOKENS) {
        probe.style.color = `var(--${t})`;
        colours.current[t] = getComputedStyle(probe).color;
      }
      probe.remove();
      stale.current = false;
    }
    return colours.current;
  });
  useEffect(() => {
    const mark = () => {
      stale.current = true;
      onChange();
    };
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", mark);
    const watch = new MutationObserver(mark);
    watch.observe(document.documentElement, { attributes: true });
    return () => {
      media.removeEventListener("change", mark);
      watch.disconnect();
    };
  }, [onChange]);
  return read;
}

/** A clip as drawn: where it starts on the timeline, and the source frames it shows. */
interface Span {
  start: number;
  in: number;
  out: number;
}

/**
 * A clip's thumbnails, a continuous strip from its start (those not made yet leave the clip's
 * colour). Never a picture from later than where it's drawn: a thumbnail stands for the frames
 * from its own up to the next one's.
 *
 * Zoomed out, a thumbnail is wider than the frames between thumbnails: each place along the strip
 * shows the last thumbnail at or before its frame. Zoomed in, the frames between thumbnails are
 * wider than one: each is drawn at its own frame, and repeated faintly until the next, so the
 * span reads as one picture and it's clear there's no thumbnail for every frame.
 */
function drawThumbs(
  g: CanvasRenderingContext2D,
  s: ThumbStrip,
  view: View,
  clip: Span,
  right: number,
) {
  const first = s.bitmaps[0];
  if (!first) return;
  const tw = (THUMB_H * first.width) / first.height;
  const x0 = xOf(view, clip.start);
  /** Timeline x of source frame `f` in this clip. */
  const at = (f: number) => xOf(view, clip.start + f - clip.in);
  const span = s.step * view.zoom;
  if (span <= tw) {
    for (let i = Math.max(0, Math.floor((HEADER - x0) / tw)); x0 + i * tw < right; i++) {
      const f = clip.in + Math.floor((i * tw) / view.zoom);
      if (f >= clip.out) break;
      const bitmap = s.bitmaps[Math.floor(f / s.step)];
      if (!bitmap) continue;
      const l = Math.round(x0 + i * tw);
      g.drawImage(bitmap, l, THUMB_TOP, Math.round(x0 + (i + 1) * tw) - l, THUMB_H);
    }
    return;
  }
  const w = Math.round(tw);
  const leftmost = clip.in + Math.max(0, (HEADER - x0) / view.zoom);
  const last = Math.min(s.bitmaps.length, Math.ceil(clip.out / s.step));
  for (let k = Math.floor(leftmost / s.step); k < last; k++) {
    const l = Math.round(at(Math.max(k * s.step, clip.in)));
    if (l >= right) break;
    const r = Math.round(at(Math.min((k + 1) * s.step, clip.out)));
    g.save();
    g.beginPath();
    g.rect(l, THUMB_TOP, r - l, THUMB_H);
    g.clip();
    g.drawImage(s.bitmaps[k], l, THUMB_TOP, w, THUMB_H);
    g.globalAlpha = 0.3;
    for (let x = l + w; x < r; x += w) g.drawImage(s.bitmaps[k], x, THUMB_TOP, w, THUMB_H);
    g.restore();
  }
}

/**
 * A clip's waveform, in its band at the bottom: a bar per pixel, as tall as the loudest audio in
 * the frames under it (on a dB scale), centred.
 */
function drawWave(
  g: CanvasRenderingContext2D,
  peaks: Peaks,
  view: View,
  clip: Span,
  right: number,
) {
  const half = WAVE_H / 2 - 1;
  /** Source frame at timeline x, in this clip. */
  const at = (x: number) => clip.in + fOf(view, x) - clip.start;
  const end = Math.min(right, xOf(view, clip.start + clip.out - clip.in));
  g.fillStyle = "rgb(255 255 255 / 0.55)";
  g.beginPath();
  for (let x = Math.floor(Math.max(xOf(view, clip.start), HEADER)); x < end; x++) {
    const a = waveHeight(peaks.max(Math.max(clip.in, at(x)), Math.min(clip.out, at(x + 1)))) * half;
    if (a > 0) g.rect(x, WAVE_MID - a, 1, Math.max(1, 2 * a));
  }
  g.fill();
}

/**
 * The timeline (the mockup's): the ruler with the ranges, the document's clips with their thumbnails and
 * waveform, frame ticks once there's room, and the playhead. Click or drag to move the playhead
 * (on a clip, it's selected too); the wheel scrolls, Ctrl+wheel zooms at the pointer.
 */
export function Timeline({ source, player, inFrames, thumbs, waveUrl }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draw = useRef<() => void>(() => {});
  const [redraw] = useState(() => () => draw.current());
  const colours = useColours(redraw);
  const frames = useDoc((s) => total(s.doc));
  /** The edge or title bar under the pointer (not dragging). */
  const hover = useRef<Hit | null>(null);
  const trim = useRef<Trim | null>(null);
  /** A clip being moved by its title bar: from where, in the document as the drag started. */
  const moving = useRef<{ id: ClipId; x0: number; start: Doc } | null>(null);
  /** A range (or the pending in-point) being dragged. */
  const ranging = useRef<RangeDrag | null>(null);
  /** Markup being dragged. */
  const marking = useRef<MarkDrag | null>(null);
  /** Where a drag snapped to: the guide is drawn there. */
  const guide = useRef<number | null>(null);
  const readout = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const tipFor = useRef<string | null>(null);
  const tipTimer = useRef(0);
  /** A clip's right-click menu, where it was opened. */
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItems } | null>(null);

  // The thumbnails: a strip per source, loaded as Rust makes them.
  const strip = useRef<ThumbStrip | null>(null);
  useEffect(() => {
    const s = strip.current;
    if (thumbs && s?.url === thumbs.url) {
      s.more(thumbs);
      return;
    }
    s?.close();
    strip.current = thumbs && new ThumbStrip(thumbs, redraw);
    redraw();
  }, [thumbs, redraw]);
  useEffect(
    () => () => {
      strip.current?.close();
      strip.current = null;
    },
    [],
  );

  // The waveform: read once it's made.
  const peaks = useRef<Peaks | null>(null);
  useEffect(() => {
    peaks.current = null;
    redraw();
    if (!waveUrl) return;
    let gone = false;
    fetch(waveUrl)
      .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(res.statusText))))
      .then((bytes) => {
        if (gone) return;
        peaks.current = new Peaks(new Uint8Array(bytes));
        redraw();
      })
      .catch((e: unknown) => console.warn("waveform:", e));
    return () => {
      gone = true;
    };
  }, [waveUrl, redraw]);

  // Drawing: on the next animation frame after anything changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let queued = 0;
    const paint = () => {
      queued = 0;
      const c = colours();
      const dpr = devicePixelRatio;
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      // The store must know the size it fits to (in development a reload of its module
      // empties it).
      const store = useTimeline.getState();
      if (store.width !== W || store.frames !== frames) store.setSize(W, frames);
      const { view } = useTimeline.getState();
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      const g = canvas.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = c["tl-bg"];
      g.fillRect(0, 0, W, H);
      g.font = "11px 'Segoe UI Variable Text', 'Segoe UI', system-ui";
      g.textBaseline = "middle";
      g.fillStyle = c["tl-lane"];
      g.fillRect(HEADER, CLIP_TOP, W, CLIP_H);
      for (let lane = 0; lane < LANES; lane++) g.fillRect(HEADER, laneY(lane), W, LANE_H);

      // Ruler: labelled ticks at least 70 px apart, minor ticks between.
      const { rateNum: num, rateDen: den } = source;
      const hours = needsHours(frames, num, den);
      const { major, minor } = ticks(view.zoom, num / den);
      const f0 = Math.floor(fOf(view, HEADER));
      const f1 = Math.ceil(fOf(view, W));
      g.strokeStyle = c["text-3"];
      g.fillStyle = c["text-2"];
      g.lineWidth = 1;
      if (minor) {
        g.beginPath();
        for (let f = Math.max(0, Math.ceil(f0 / minor) * minor); f <= f1; f += minor) {
          const x = Math.round(xOf(view, f)) + 0.5;
          g.moveTo(x, RULER - 5);
          g.lineTo(x, RULER);
        }
        g.stroke();
      }
      g.beginPath();
      const perSecond = Math.round(num / den);
      for (let f = Math.max(0, Math.ceil(f0 / major) * major); f <= f1; f += major) {
        const x = Math.round(xOf(view, f)) + 0.5;
        g.moveTo(x, RULER - 12);
        g.lineTo(x, RULER);
        const tc = timecode(f, num, den, hours);
        // Whole seconds drop the frames.
        const label = inFrames ? String(f) : major < perSecond ? tc : tc.slice(0, -3);
        g.fillText(label, x + 4, RULER - 15);
      }
      g.stroke();

      // Frame ticks along the clip track's top, once there's room.
      if (view.zoom >= FRAME_TICKS) {
        g.strokeStyle = c["border"];
        g.beginPath();
        for (let f = Math.max(0, f0); f <= Math.min(f1, frames); f++) {
          const x = Math.round(xOf(view, f)) + 0.5;
          g.moveTo(x, CLIP_TOP - 4);
          g.lineTo(x, CLIP_TOP);
        }
        g.stroke();
      }

      // The clips, each inset by half a pixel so a cut shows as a 1 px gap, with 8 px corners
      // notching it top and bottom.
      const { doc, selected, selectedRange, selectedMarks, pendingIn } = useDoc.getState();
      const starts = clipStarts(doc);
      g.save();
      g.beginPath();
      g.rect(HEADER, 0, W - HEADER, H);
      g.clip();

      // Ranges: a bar along the ruler's top with the length, a wash down the timeline (under
      // the clips), and lines at the edges (thicker, selected).
      for (const r of shownRanges(doc)) {
        const x0 = Math.round(xOf(view, r.a));
        const x1 = Math.round(xOf(view, r.b));
        if (x1 < HEADER || x0 > W) continue;
        const sel = r.id === selectedRange;
        g.fillStyle = c["range"];
        g.fillRect(x0, 0, x1 - x0, H);
        g.fillStyle = c["range-edge"];
        g.fillRect(x0, 0, x1 - x0, RANGE_STRIP);
        g.fillRect(x0 - (sel ? 1 : 0), 0, sel ? 2 : 1, H);
        g.fillRect(x1 - (sel ? 1 : 0), 0, sel ? 2 : 1, H);
        if (x1 - x0 > 40) {
          g.fillStyle = "#000";
          g.font = "600 10px 'Segoe UI Variable Text', 'Segoe UI', system-ui";
          g.fillText(
            inFrames ? String(r.b - r.a) : timecode(r.b - r.a, num, den, hours),
            Math.max(x0, HEADER) + 4,
            RANGE_STRIP / 2 + 0.5,
          );
        }
      }

      // A pending in-point (I pressed, O not yet): a draft at half strength, its bar fading out
      // to the right; a faint wash shows the range O would make at the playhead.
      if (pendingIn !== null) {
        const x = Math.round(xOf(view, pendingIn));
        const { frame: ph } = player.getState();
        if (ph >= pendingIn) {
          g.globalAlpha = 0.35;
          g.fillStyle = c["range"];
          g.fillRect(x, 0, xOf(view, ph + 1) - x, H);
        }
        g.globalAlpha = 0.6;
        const fade = g.createLinearGradient(x, 0, x + 110, 0);
        fade.addColorStop(0, c["range-edge"]);
        fade.addColorStop(1, "transparent");
        g.fillStyle = fade;
        g.fillRect(x, 0, 110, RANGE_STRIP);
        g.globalAlpha = 0.85;
        g.strokeStyle = c["range-edge"];
        g.setLineDash([4, 3]);
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(x + 0.5, 0);
        g.lineTo(x + 0.5, H);
        g.stroke();
        g.setLineDash([]);
        g.lineWidth = 1;
        g.globalAlpha = 1;
        g.fillStyle = "#000";
        g.font = "600 10px 'Segoe UI Variable Text', 'Segoe UI', system-ui";
        g.fillText("IN", x + 4, RANGE_STRIP / 2 + 0.5);
      }
      doc.clips.forEach((clip, i) => {
        const span = { start: starts[i], in: clip.in, out: clip.out };
        const len = clipLength(clip);
        const x0 = xOf(view, span.start);
        const x1 = xOf(view, span.start + len);
        if (x1 <= HEADER || x0 >= W) return;
        g.save();
        g.beginPath();
        g.roundRect(x0 + CLIP_GAP, CLIP_TOP, x1 - x0 - 2 * CLIP_GAP, CLIP_H, CLIP_RADIUS);
        g.clip();
        g.fillStyle = c["clip"];
        g.fillRect(x0, CLIP_TOP, x1 - x0, CLIP_H);
        if (strip.current) drawThumbs(g, strip.current, view, span, Math.min(x1, W));
        if (peaks.current) drawWave(g, peaks.current, view, span, Math.min(x1, W));
        // Its name and length, kept in view as the timeline scrolls. The name is the clip's
        // id, so it stays with the clip as clips move: a reorder or a delete shows.
        const lx = Math.max(x0, HEADER) + 9;
        const name = `Clip ${clip.id}`;
        if (x1 - lx > 50) {
          g.fillStyle = "#fff";
          g.font = "600 11px 'Segoe UI Variable Text', 'Segoe UI', system-ui";
          g.fillText(name, lx, CLIP_TOP + 10);
          const w = g.measureText(`${name} `).width;
          g.font = "11px 'Segoe UI Variable Text', 'Segoe UI', system-ui";
          g.fillStyle = "rgb(255 255 255 / 0.8)";
          if (x1 - lx > w + 90) {
            g.fillText(
              inFrames ? `${len} frames` : timecode(len, num, den, hours),
              lx + w + 4,
              CLIP_TOP + 10,
            );
          }
        }
        g.restore();
        if (clip.id === selected) {
          g.strokeStyle = c["accent"];
          g.lineWidth = 2;
          g.beginPath();
          g.roundRect(
            x0 + CLIP_GAP + 1,
            CLIP_TOP + 1,
            x1 - x0 - 2 * CLIP_GAP - 2,
            CLIP_H - 2,
            CLIP_RADIUS - 1,
          );
          g.stroke();
          g.lineWidth = 1;
        }
      });

      // Markup: a bar in its lane, saying what it is (the selected one outlined).
      const marks = new Map(doc.marks.map((m) => [m.id, m]));
      for (const m of shownMarks(doc)) {
        const x0 = xOf(view, m.start);
        const x1 = xOf(view, m.end);
        if (x1 <= HEADER || x0 >= W) continue;
        const y0 = laneY(m.lane);
        g.save();
        g.beginPath();
        g.roundRect(x0, y0, Math.max(2, x1 - x0), LANE_H, 4);
        g.clip();
        g.fillStyle = c["mark"];
        g.fillRect(x0, y0, x1 - x0, LANE_H);
        g.fillStyle = "#fff";
        g.font = "600 11px 'Segoe UI Variable Text', 'Segoe UI', system-ui";
        const object = marks.get(m.id)?.object;
        g.fillText(object ? markLabel(object) : "", Math.max(x0, HEADER) + 8, y0 + LANE_H / 2 + 1);
        g.restore();
        if (selectedMarks.includes(m.id)) {
          g.strokeStyle = c["accent"];
          g.lineWidth = 2;
          g.beginPath();
          g.roundRect(x0 + 1, y0 + 1, Math.max(2, x1 - x0 - 2), LANE_H - 2, 4);
          g.stroke();
          g.lineWidth = 1;
        }
      }

      // The hovered or dragged clip edge: white with a dark outline, so it reads on any
      // picture. A line along the edge and a grip on the clip's side of it.
      const t = trim.current;
      const h = hover.current;
      const edge = t
        ? { kind: t.edge, id: t.id }
        : h && (h.kind === "in" || h.kind === "out")
          ? { kind: h.kind, id: h.clip.id }
          : null;
      const ei = edge ? doc.clips.findIndex((cl) => cl.id === edge.id) : -1;
      if (edge && ei >= 0) {
        const isIn = edge.kind === "in";
        const x = Math.round(
          isIn
            ? xOf(view, starts[ei]) + CLIP_GAP
            : xOf(view, starts[ei] + clipLength(doc.clips[ei])) - CLIP_GAP,
        );
        g.fillStyle = "rgb(0 0 0 / 0.7)";
        g.fillRect(x - 2, CLIP_TOP - 4, 4, CLIP_H + 8);
        g.fillStyle = "#fff";
        g.fillRect(x - 1, CLIP_TOP - 3, 2, CLIP_H + 6);
        const gw = 8;
        const gh = 30;
        const gx = isIn ? x : x - gw;
        const gy = CLIP_TOP + (CLIP_H - gh) / 2;
        g.beginPath();
        g.roundRect(gx + 0.5, gy + 0.5, gw - 1, gh - 1, 3);
        g.fill();
        g.strokeStyle = "rgb(0 0 0 / 0.7)";
        g.stroke();
        g.fillStyle = "rgb(0 0 0 / 0.45)";
        for (const dy of [-5, 0, 5]) g.fillRect(gx + 2, gy + gh / 2 + dy - 0.5, gw - 4, 1);
      }

      // The snap guide: a dashed line with a small diamond on the ruler, while a drag is held
      // by a target. Neutral, so it can't be taken for the playhead.
      if (guide.current !== null) {
        const sx = Math.round(xOf(view, guide.current)) + 0.5;
        g.strokeStyle = c["snap"];
        g.globalAlpha = 0.9;
        g.setLineDash([3, 3]);
        g.beginPath();
        g.moveTo(sx, RULER - 2);
        g.lineTo(sx, H);
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = c["snap"];
        g.beginPath();
        g.moveTo(sx, RULER - 9);
        g.lineTo(sx + 4, RULER - 5);
        g.lineTo(sx, RULER - 1);
        g.lineTo(sx - 4, RULER - 5);
        g.fill();
        g.globalAlpha = 1;
      }
      g.restore();

      // Track header.
      g.fillStyle = c["tl-bg"];
      g.fillRect(0, 0, HEADER, H);
      g.fillStyle = c["text-2"];
      g.font = "600 11px 'Segoe UI Variable Text', 'Segoe UI', system-ui";
      g.textAlign = "center";
      // The lanes' markup, and the clip track's picture and sound (as the mockup).
      for (let lane = 0; lane < LANES; lane++)
        g.fillText("T", HEADER / 2, laneY(lane) + LANE_H / 2);
      g.fillText("▶", HEADER / 2, THUMB_TOP + THUMB_H / 2);
      if (source.audioTracks > 0) g.fillText("♪", HEADER / 2, WAVE_MID);
      g.textAlign = "left";

      // Playhead: a line from the ruler down, a marker on the ruler, and the frame it covers
      // tinted once frames are wide enough to see.
      const { frame } = player.getState();
      const px = Math.round(xOf(view, frame)) + 0.5;
      if (px >= HEADER - 6) {
        g.strokeStyle = c["playhead"];
        g.beginPath();
        g.moveTo(px, RULER - 2);
        g.lineTo(px, H);
        g.stroke();
        g.fillStyle = c["playhead"];
        g.beginPath();
        g.moveTo(px - 6, RULER - 12);
        g.lineTo(px + 6, RULER - 12);
        g.lineTo(px + 6, RULER - 6);
        g.lineTo(px, RULER - 1);
        g.lineTo(px - 6, RULER - 6);
        g.fill();
        if (view.zoom >= FRAME_TICKS) {
          g.globalAlpha = 0.15;
          g.fillRect(xOf(view, frame), CLIP_TOP, view.zoom, CLIP_H);
          g.globalAlpha = 1;
        }
      }
    };
    draw.current = () => {
      if (!queued) queued = requestAnimationFrame(paint);
    };
    draw.current();
    const stopView = useTimeline.subscribe(draw.current);
    const stopDoc = useDoc.subscribe(draw.current);
    const stopPlayer = player.subscribe(() => {
      // Playing: the view follows the playhead.
      const { frame, speed } = player.getState();
      if (speed !== 0) useTimeline.getState().follow(frame);
      draw.current();
    });
    return () => {
      cancelAnimationFrame(queued);
      stopView();
      stopDoc();
      stopPlayer();
    };
  }, [colours, source, player, frames, inFrames]);

  // A new source starts fitted.
  useEffect(() => useTimeline.getState().fit(), [source.id]);

  // Size: the store keeps the view fitted (or in range) as the timeline resizes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      useTimeline.getState().setSize(canvas.clientWidth, frames);
      draw.current();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [frames]);

  // Wheel: Ctrl zooms at the pointer (at the playhead, if the pointer is on it), otherwise it
  // scrolls. Not passive, so the page doesn't.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const t = useTimeline.getState();
      const x = e.clientX - canvas.getBoundingClientRect().left;
      if (e.ctrlKey) {
        const anchor = zoomAnchor(t.view, x, player.getState().frame);
        t.zoomBy(Math.exp(-e.deltaY * 0.0025), anchor);
      } else t.scrollBy((e.deltaY + e.deltaX) * 0.8);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [player]);

  // Tooltips: what a handle does, after a rest on it.
  const hideTip = () => {
    clearTimeout(tipTimer.current);
    if (tip.current) tip.current.style.display = "none";
  };
  useEffect(() => () => clearTimeout(tipTimer.current), []);
  /** On every hover move: (re)arms the delay when what's under the pointer changes. */
  const hoverTip = (kind: Hit["kind"] | null, cx: number, cy: number) => {
    if (kind === tipFor.current) return;
    tipFor.current = kind;
    hideTip();
    if (!kind) return;
    tipTimer.current = window.setTimeout(() => {
      const el = tip.current;
      if (!el) return;
      const [main, sub] = TIPS[kind];
      const small = document.createElement("small");
      small.textContent = sub;
      el.replaceChildren(main, small);
      el.style.display = "block";
      el.style.left = `${Math.min(cx + 12, innerWidth - el.offsetWidth - 8)}px`;
      el.style.top = `${cy + 20}px`;
    }, TIP_DELAY);
  };

  /** The drag's readout, above the pointer; null hides it. */
  const showReadout = (text: string | null, cx = 0, cy = 0) => {
    const el = readout.current;
    if (!el) return;
    el.style.display = text === null ? "none" : "block";
    if (text === null) return;
    el.textContent = text;
    el.style.left = `${Math.min(cx + 14, innerWidth - el.offsetWidth - 8)}px`;
    el.style.top = `${Math.max(4, cy - el.offsetHeight - 12)}px`;
  };

  // Click or drag: the playhead follows the pointer (scrubbing; the proxy keeps up), snapping
  // to the clips' starts and the ranges' edges. On the clip track the clip under the pointer is
  // selected. By an edge it's trimmed; by its title bar it's dragged to another place, the
  // others sliding aside. On the ruler's top strip a drag draws a range; a range's bar moves it
  // and its edges resize it. A drag is one undo step.
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, view: useTimeline.getState().view };
  };
  /** Snapping, unless it's off or Alt is held. */
  const snapping = (e: React.PointerEvent) => useTimeline.getState().snap && !e.altKey;
  const scrubTo = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, view } = at(e);
    const f = fOf(view, Math.max(HEADER, x));
    const { doc, pendingIn } = useDoc.getState();
    const s = snap(f, scrubTargets(doc, pendingIn), view.zoom, snapping(e), Math.floor);
    guide.current = s.target;
    player.seek(s.frame);
  };
  const cursorFor = (hit: Hit | null) => (hit ? CURSORS[hit.kind] : "");
  /** Timeline frames as the ruler shows them. */
  const formatter = () => {
    const { rateNum: num, rateDen: den } = source;
    const hours = needsHours(Math.max(frames, useDoc.getState().doc.sourceFrames), num, den);
    return (f: number) => (inFrames ? String(f) : timecode(f, num, den, hours));
  };

  /**
   * Trims as the pointer moves (ripple). An out edge follows the pointer. An in edge stays put
   * and the clip's video slides under it: the frame that was under the pointer becomes the
   * clip's first. The preview shows the frame at the handle.
   */
  const trimTo = (e: React.PointerEvent<HTMLCanvasElement>, t: Trim) => {
    const { x, view } = at(e);
    const df = (x - t.x0) / view.zoom;
    const on = snapping(e);
    const store = useDoc.getState();
    const s =
      t.edge === "out"
        ? snap(t.start + clipLength(t.orig) + df, t.targets, view.zoom, on)
        : snap(t.start + df, t.targets, view.zoom, on);
    if (t.edge === "out") store.trim(t.id, t.orig.in, t.orig.in + s.frame - t.start);
    else store.trim(t.id, t.orig.in + s.frame - t.start, t.orig.out);
    guide.current = s.target;
    draw.current();
    const { doc } = useDoc.getState();
    const clip = doc.clips.find((c) => c.id === t.id);
    if (!clip) return;
    player.peek(t.edge === "in" ? clip.in : clip.out - 1);
    const fmt = formatter();
    const lines =
      t.edge === "in"
        ? [`In ${fmt(clip.in)}  ${signed(clip.in - t.orig.in)}`]
        : [`Out ${fmt(clip.out)}  ${signed(clip.out - t.orig.out)}`];
    lines.push(`Length ${fmt(clipLength(clip))}`);
    if (t.edge === "in" && clip.in === 0) lines.push("(the source's start)");
    if (t.edge === "out" && clip.out === doc.sourceFrames) lines.push("(the source's end)");
    showReadout(lines.join("\n"), e.clientX, e.clientY);
  };

  /** Moves, resizes or draws a range (or moves the pending in-point) as the pointer moves. */
  const rangeTo = (e: React.PointerEvent<HTMLCanvasElement>, d: RangeDrag) => {
    const { x, view } = at(e);
    const store = useDoc.getState();
    const length = total(store.doc);
    const targets = rangeTargets(
      store.doc,
      player.getState().frame,
      d.id,
      d.kind === "pendingIn" ? null : store.pendingIn,
    );
    const on = snapping(e);
    const fmt = formatter();
    if (d.kind === "pendingIn") {
      const s = snap(fOf(view, x), targets, view.zoom, on);
      guide.current = s.target;
      store.setPendingIn(Math.max(0, Math.min(length - 1, s.frame)));
      showReadout(
        `In ${fmt(useDoc.getState().pendingIn ?? 0)}  (O sets the out)`,
        e.clientX,
        e.clientY,
      );
      draw.current();
      return;
    }
    const { a, b } = d.orig;
    // Ranges don't overlap: a drag stops against the ranges either side (Richard).
    const room = rangeRoom(store.doc, a, b, d.id);
    let to: { a: number; b: number };
    if (d.kind === "move") {
      // Whichever edge lands near something snaps, the start first.
      const len = b - a;
      const df = (x - d.x0) / view.zoom;
      let s = snap(a + df, targets, view.zoom, on);
      let start = s.frame;
      if (s.target === null) {
        s = snap(b + df, targets, view.zoom, on);
        start = s.target === null ? Math.round(a + df) : s.frame - len;
      }
      guide.current = s.target;
      start = Math.max(room.a, Math.min(room.b - len, start));
      to = { a: start, b: start + len };
    } else {
      // An edge (or a new range's far end) against the edge that stays: past it, they swap.
      const s = snap(fOf(view, x), targets, view.zoom, on);
      guide.current = s.target;
      const f = Math.max(room.a, Math.min(room.b, s.frame));
      const fixed = d.kind === "a" ? b : a;
      if (f === fixed) {
        draw.current();
        return;
      }
      to = { a: Math.min(f, fixed), b: Math.max(f, fixed) };
    }
    if (d.id === null) d.id = store.addRange(to.a, to.b);
    else store.setRange(d.id, to.a, to.b);
    showReadout(`${fmt(to.a)} → ${fmt(to.b)}\n${fmt(to.b - to.a)}`, e.clientX, e.clientY);
    draw.current();
  };

  /**
   * Moves markup, or moves one of its edges, as the pointer moves. Moving, it can change lane;
   * whichever end lands near something snaps (the start first). Dragging an edge puts the
   * playhead on it, so the preview shows where it starts or ends.
   */
  const markTo = (e: React.PointerEvent<HTMLCanvasElement>, d: MarkDrag) => {
    const { x, y, view } = at(e);
    const store = useDoc.getState();
    const length = total(store.doc);
    const targets = markTargets(store.doc, d.playhead, d.id, store.pendingIn);
    const on = snapping(e);
    const { start, end, lane } = d.orig;
    const len = end - start;
    let to = { start, end, lane };
    if (d.kind === "move") {
      const df = (x - d.x0) / view.zoom;
      let s = snap(start + df, targets, view.zoom, on);
      let a = s.frame;
      if (s.target === null) {
        s = snap(end + df, targets, view.zoom, on);
        a = s.target === null ? Math.round(start + df) : s.frame - len;
      }
      guide.current = s.target;
      a = Math.max(0, Math.min(length - len, a));
      to = { start: a, end: a + len, lane: laneAt(y) };
    } else {
      const s = snap(fOf(view, x), targets, view.zoom, on);
      guide.current = s.target;
      if (d.kind === "start") to.start = Math.max(0, Math.min(end - 1, s.frame));
      else to.end = Math.max(start + 1, Math.min(length, s.frame));
      player.seek(d.kind === "start" ? to.start : to.end - 1);
    }
    store.setMark(d.id, to.start, to.end, to.lane);
    const fmt = formatter();
    showReadout(
      `${fmt(to.start)} → ${fmt(to.end)}\n${fmt(to.end - to.start)}`,
      e.clientX,
      e.clientY,
    );
    draw.current();
  };

  /** The drag ended (or was cancelled by the system): one undo step, and back to hovering. */
  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const docState = useDoc.getState();
    if (trim.current) {
      trim.current = null;
      docState.endGesture();
      useTimeline.getState().hold(false);
      player.peek(null);
    }
    if (moving.current !== null) {
      moving.current = null;
      docState.endGesture();
    }
    if (ranging.current) {
      ranging.current = null;
      docState.endGesture();
    }
    if (marking.current) {
      marking.current = null;
      docState.endGesture();
    }
    showReadout(null);
    guide.current = null;
    const { x, y, view } = at(e);
    const now = useDoc.getState();
    hover.current = hitAt(now.doc, now.pendingIn, view, x, y);
    e.currentTarget.style.cursor = cursorFor(hover.current);
    draw.current();
  };

  /** Starts a drag on what was hit; false if it's not a drag of something (scrub instead). */
  const startDrag = (e: React.PointerEvent<HTMLCanvasElement>, hit: Hit, x: number) => {
    const docState = useDoc.getState();
    if (hit.kind === "in" || hit.kind === "out") {
      const index = docState.doc.clips.findIndex((c) => c.id === hit.clip.id);
      docState.select(hit.clip.id);
      docState.beginGesture();
      useTimeline.getState().hold(true);
      trim.current = {
        id: hit.clip.id,
        edge: hit.kind,
        x0: x,
        start: clipStarts(docState.doc)[index],
        orig: hit.clip,
        targets: trimTargets(docState.doc, index, hit.kind, player.getState().frame),
      };
      player.peek(hit.kind === "in" ? hit.clip.in : hit.clip.out - 1);
      return;
    }
    if (hit.kind === "move") {
      docState.select(hit.clip.id);
      docState.beginGesture();
      moving.current = { id: hit.clip.id, x0: x, start: docState.doc };
      e.currentTarget.style.cursor = "grabbing";
      return;
    }
    if (hit.kind === "pendingIn") {
      ranging.current = { kind: "pendingIn", id: null, x0: x, orig: { a: 0, b: 0 } };
      return;
    }
    docState.beginGesture();
    if ("mark" in hit) {
      const { mark } = hit;
      // Shift adds it to the selection (or takes it out); a press on one already selected keeps
      // the others.
      const sel = docState.selectedMarks;
      if (e.shiftKey) {
        docState.selectMarks(
          sel.includes(mark.id) ? sel.filter((id) => id !== mark.id) : [...sel, mark.id],
        );
      } else if (!sel.includes(mark.id)) docState.selectMarks([mark.id]);
      const kind = hit.kind === "markStart" ? "start" : hit.kind === "markEnd" ? "end" : "move";
      marking.current = {
        kind,
        id: mark.id,
        x0: x,
        orig: { start: mark.start, end: mark.end, lane: mark.lane },
        playhead: player.getState().frame,
      };
      if (kind === "move") e.currentTarget.style.cursor = "grabbing";
      return;
    }
    if (hit.kind === "rangeNew") {
      const { view } = at(e);
      const { doc, pendingIn } = docState;
      const s = snap(
        fOf(view, x),
        rangeTargets(doc, player.getState().frame, null, pendingIn),
        view.zoom,
        snapping(e),
      );
      const f = Math.max(0, Math.min(total(doc), s.frame));
      ranging.current = { kind: "new", id: null, x0: x, orig: { a: f, b: f } };
      return;
    }
    if (!("range" in hit)) return;
    const { range } = hit;
    docState.selectRange(range.id);
    const kind = hit.kind === "rangeA" ? "a" : hit.kind === "rangeB" ? "b" : "move";
    ranging.current = { kind, id: range.id, x0: x, orig: { a: range.a, b: range.b } };
    if (kind === "move") e.currentTarget.style.cursor = "grabbing";
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        className={styles.timelineCanvas}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          hideTip();
          tipFor.current = null;
          e.currentTarget.setPointerCapture(e.pointerId);
          const docState = useDoc.getState();
          const { x, y, view } = at(e);
          const hit = hitAt(docState.doc, docState.pendingIn, view, x, y);
          hover.current = null;
          if (hit) {
            startDrag(e, hit, x);
            draw.current();
            return;
          }
          if (y >= CLIP_TOP && x >= HEADER) {
            docState.select(clipAt(docState.doc, Math.floor(fOf(view, x)))?.clip.id ?? null);
          } else if (y >= RULER && x >= HEADER) {
            // An empty lane: nothing selected.
            docState.select(null);
          }
          scrubTo(e);
        }}
        onPointerMove={(e) => {
          const canvas = e.currentTarget;
          if (trim.current) {
            trimTo(e, trim.current);
            return;
          }
          if (ranging.current) {
            rangeTo(e, ranging.current);
            return;
          }
          if (marking.current) {
            markTo(e, marking.current);
            return;
          }
          if (moving.current !== null) {
            // A click isn't a drag: nothing moves until the pointer has.
            const m = moving.current;
            const { x, view } = at(e);
            if (Math.abs(x - m.x0) < DRAG_PX) return;
            useDoc.getState().move(m.id, moveSlot(m.start, m.id, (x - m.x0) / view.zoom));
            return;
          }
          if (canvas.hasPointerCapture(e.pointerId)) {
            scrubTo(e);
            return;
          }
          const { x, y, view } = at(e);
          const { doc, pendingIn } = useDoc.getState();
          const hit = hitAt(doc, pendingIn, view, x, y);
          if (!sameHit(hit, hover.current)) {
            hover.current = hit;
            draw.current();
          }
          canvas.style.cursor = cursorFor(hit);
          hoverTip(hit?.kind ?? null, e.clientX, e.clientY);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - r.left;
          const y = e.clientY - r.top;
          const docState = useDoc.getState();
          const view = useTimeline.getState().view;
          const hit = hitAt(docState.doc, docState.pendingIn, view, x, y);
          if (hit && "mark" in hit) {
            if (!docState.selectedMarks.includes(hit.mark.id)) docState.selectMarks([hit.mark.id]);
            setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                { label: "Duplicate", hint: "Ctrl+D", run: () => void duplicateSelection() },
                { label: "Delete", hint: "Delete", run: deleteSelected },
              ],
            });
            return;
          }
          if (x < HEADER || y < CLIP_TOP || y > CLIP_TOP + CLIP_H) return;
          const under = clipAt(docState.doc, Math.floor(fOf(view, x)));
          if (!under) return;
          const { clip } = under;
          docState.select(clip.id);
          const whole = clip.in === 0 && clip.out === docState.doc.sourceFrames;
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: "Export clip as MP4…", run: () => exportClip(clip.id, "mp4") },
              { label: "Export clip as GIF…", run: () => exportClip(clip.id, "gif") },
              "-",
              { label: "Split at the playhead", hint: "S", run: () => splitAtPlayhead(player) },
              {
                label: "Delete (close the gap)",
                hint: "Delete",
                disabled: docState.doc.clips.length < 2,
                run: deleteSelected,
              },
              "-",
              {
                label: "Restore the full length",
                disabled: whole,
                run: () => useDoc.getState().trim(clip.id, 0, useDoc.getState().doc.sourceFrames),
              },
            ],
          });
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          hideTip();
          tipFor.current = null;
          if (
            trim.current ||
            ranging.current ||
            marking.current ||
            moving.current !== null ||
            !hover.current
          ) {
            return;
          }
          hover.current = null;
          draw.current();
        }}
      />
      <div ref={readout} className={styles.dragReadout} style={{ display: "none" }} />
      <div ref={tip} className={styles.handleTip} style={{ display: "none" }} />
      {menu && <Menu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </>
  );
}
