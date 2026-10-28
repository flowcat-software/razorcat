import { doublesShown, useClickSettings } from "../markup/clickSettings";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { setDragHint, setHoverHint, type ControlHint, type DragHint } from "../markup/hints";
import { annotationId, docStore as markupDoc } from "../markup/model/store";
import type { Reorder } from "../markup/model/commands";
import { duplicateSelection } from "../markup/objectActions";
import { onAccent } from "../shared/accent";
import { events, type CameraSize, type SourceInfo, type ThumbsInfo } from "../shared/ipc";
import { CAMERA_SIZE_NAMES, CAMERA_SIZES } from "./cameraPlace";
import type { Player } from "./player";
import { ThumbStrip } from "./thumbs";
import { Peaks, waveHeight } from "./wave";
import { timecode, needsHours } from "./timecode";
import {
  clipAt,
  clipFades,
  clipLength,
  crossfades,
  fadesOf,
  canFade,
  fadeColours,
  FADE_BLACK,
  FADE_WHITE,
  clipStarts,
  laneCount,
  longestSource,
  moveGroupSlot,
  packLanes,
  resizeEdges,
  moveSlot,
  markFades,
  markLabel,
  rangeRoom,
  shownMarks,
  shownRanges,
  sourceLength,
  stepLane,
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
import {
  copiedFades,
  copiedMarks,
  copySelectedClip,
  copySelectedMarks,
  deleteSelected,
  duplicateSelectedClip,
  pasteFades,
  pasteStyle,
  pasteTiming,
  splitAtPlayhead,
} from "./edits";
import { clipsExportItems, exportClip } from "./exports";
import { Menu, type MenuItems } from "./Menu";
import { markTargets, rangeTargets, scrubTargets, snap, trimTargets } from "./snap";
import { useTimeline } from "./timelineStore";
import {
  clipFrame,
  formatSpeed,
  isNormal,
  NORMAL_SPEED,
  sourceFrame,
  speedOf,
  videoEnd,
  type Speed,
} from "./speed";
import { TimelineScrollbar } from "./TimelineScrollbar";
import { openSpeed, setSpeedAnchor } from "./speedStore";
import { FRAME_TICKS, HEADER, fOf, ticks, xOf, zoomAnchor, type View } from "./timelineView";
import styles from "./EditorApp.module.css";

interface Props {
  /** The first file: the timeline's rate. */
  source: SourceInfo;
  /** All the timeline's files (PLAN 4.5e). */
  sources: readonly SourceInfo[];
  player: Player;
  /** The ruler labels frames, as the readout does (else timecode). */
  inFrames: boolean;
  /** Each file's thumbnails, once they're being made, by its id. */
  thumbs: Readonly<Record<string, ThumbsInfo>>;
  /** Where each file's waveform is, once it's made, by its id. */
  waves: Readonly<Record<string, string>>;
  /** Each recording with a camera, by file id: the size it was recorded at. */
  cameraSizes: Readonly<Record<string, CameraSize>>;
}

// The mockup's geometry (mockup/main.html): the ruler, the markup lanes, the clip track.
/** Taller than the mockup's 30: below the range strip, a press moves the playhead (Richard). */
const RULER = 42;
/** The strip along the ruler's top: ranges' bars; drag on it to draw one. Tinted, to show it. */
const RANGE_STRIP = 11;
const LANE_TOP = RULER + 8;
/**
 * The markup lanes' area at the timeline's own height: two lanes; more scroll in it (PLAN
 * 4.5b2), so the clips never move as lanes come and go. (Thinner lanes to fit three felt
 * tight: Richard, 2026-10-21.)
 */
const LANES_MIN = 60;
/** The timeline's own height (EditorApp.module.css's .timeline): taller, the lanes get it all. */
export const TIMELINE_H = 232;
const CLIP_H = 76;
/** The clip's label row, above its thumbnails. */
const LABEL_H = 18;
/** A retimed clip's speed badge in that row: its top (from the clip's) and height. */
const BADGE_Y = 3;
const BADGE_H = 14;
/** The waveform's band, below them. */
const WAVE_H = 20;
const THUMB_H = CLIP_H - LABEL_H - WAVE_H;
// The lanes' area and the clip track under it, fitted to the timeline's height (it can be
// dragged taller, EditorApp.tsx) by `fitHeight` at each paint: there's one timeline, and every
// press, drag and wheel lands after a paint.
let LANES_H = LANES_MIN;
let CLIP_TOP = 0;
let THUMB_TOP = 0;
let WAVE_MID = 0;
/** The geometry for a timeline `h` px tall. */
function fitHeight(h: number): void {
  LANES_H = Math.max(LANES_MIN, LANES_MIN + Math.round(h) - TIMELINE_H);
  CLIP_TOP = LANE_TOP + LANES_H + 4;
  THUMB_TOP = CLIP_TOP + LABEL_H;
  WAVE_MID = CLIP_TOP + CLIP_H - WAVE_H / 2;
}
fitHeight(TIMELINE_H);
const CLIP_GAP = 0.5;
const CLIP_RADIUS = 8;
/** How long a new clip's light takes to fade (Richard: briefly). */
const FLASH_MS = 800;
/** How near (px, either side) a clip's edge the pointer grabs it. */
const EDGE_HIT = 7;
/** How far (px) the pointer must move before a title bar's press becomes a drag. */
const DRAG_PX = 3;
/** How long the pointer rests on a handle before its tooltip shows. */
const TIP_DELAY = 600;

const TOKENS = [
  "accent",
  "error-text",
  "text-2",
  "text-3",
  "tl-bg",
  "tl-lane",
  "clip",
  "clip-2",
  "clip-3",
  "clip-4",
  "clip-5",
  "clip-6",
  "border",
  "playhead",
  "snap",
  "range",
  "range-edge",
  "range-strip",
  "mark",
];

type Edge = "in" | "out";

/**
 * What the pointer is on: a clip's edge (trims it), title bar (moves it) or a fade's handle on
 * its top corners (PLAN 4.7a); a range's edge (resizes it) or bar (moves it); the empty range
 * strip (draws one); the pending in-point; markup's edge (when it starts or ends), a fade's
 * handle on its top corners, or its bar (moves it, along or to another lane).
 */
type Hit =
  | { kind: Edge | "move" | "clipFadeIn" | "clipFadeOut" | "crossfade"; clip: Clip }
  | { kind: "rangeA" | "rangeB" | "rangeMove"; range: ShownRange }
  | { kind: "markStart" | "markEnd" | "markMove" | "fadeIn" | "fadeOut"; mark: ShownMark }
  | { kind: "rangeNew" | "pendingIn" };

/** What a handle does (the mockup's tooltips). */
const TIPS: Record<Hit["kind"], [string, string]> = {
  in: ["Trim the clip's start", "the rest ripples along · Shift: no snap"],
  out: ["Trim the clip's end", "the rest ripples along · Shift: no snap"],
  move: ["Move the clip", "drag left or right · Ctrl+[ ]"],
  clipFadeIn: ["Fade in", "drag right for a longer fade · right-click: from black or white"],
  clipFadeOut: ["Fade out", "drag left for a longer fade · right-click: to black or white"],
  crossfade: ["Crossfade", "drag left to blend this clip in over the one before"],
  rangeA: ["Range start", "drag"],
  rangeB: ["Range end", "drag"],
  rangeMove: ["Move the range", "drag"],
  rangeNew: ["Draw a range", "drag · or R, or I and O"],
  pendingIn: ["Pending in-point", "drag to adjust · O sets the out"],
  markStart: ["When it starts", "drag"],
  markEnd: ["When it ends", "drag"],
  markMove: [
    "Move it in time",
    "drag · up or down: another lane · Alt+drag: a copy · Ctrl/Shift+click: select more",
  ],
  fadeIn: ["Fade in", "drag right for a longer fade"],
  fadeOut: ["Fade out", "drag left for a longer fade"],
};

const CURSORS: Record<Hit["kind"], string> = {
  in: "ew-resize",
  out: "ew-resize",
  move: "grab",
  clipFadeIn: "col-resize",
  clipFadeOut: "col-resize",
  crossfade: "col-resize",
  rangeA: "ew-resize",
  rangeB: "ew-resize",
  rangeMove: "grab",
  rangeNew: "crosshair",
  pendingIn: "ew-resize",
  markStart: "ew-resize",
  markEnd: "ew-resize",
  markMove: "grab",
  fadeIn: "col-resize",
  fadeOut: "col-resize",
};

/** How far down a markup bar its fade handles reach (px): below them, its edges trim it. */
const FADE_HIT = 9;
/** How far up the clip row a cut's crossfade handle reaches (px, PLAN 4.7b): above, it trims. */
const CROSSFADE_HIT = 14;

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
  kind: "start" | "end" | "move" | "fadeIn" | "fadeOut";
  id: MarkId;
  x0: number;
  orig: { start: number; end: number; lane: number; fadeIn: number; fadeOut: number };
  /** The playhead when the drag started, to snap to. */
  playhead: number;
  y0: number;
  /**
   * Several selected, moving, resizing or fading with it: each one's place and fades when it
   * started (the grabbed one's too).
   */
  group:
    | { id: MarkId; start: number; end: number; lane: number; fadeIn: number; fadeOut: number }[]
    | null;
  /**
   * Alt-dragged (Richard, 2026-10-23): once it moves, copies are made where they are and
   * placed only on release (`dropCopies`); till then they're drawn faded and dashed where
   * they'd go (`ghost`, their originals' ids), the originals staying put.
   */
  copying: boolean;
  ghost: { id: MarkId; start: number; end: number; lane: number }[] | null;
  /** Dropped on a busy lane, the copy goes below it (else above). */
  below: boolean;
}

/** The markup lanes as drawn: how many, how tall, how far apart, and how far scrolled. */
interface Lanes {
  count: number;
  h: number;
  pitch: number;
  scroll: number;
  /** The furthest they scroll (0: they all fit). */
  max: number;
}

/** The lanes of `doc` scrolled by `scroll` (kept in range). */
function lanesOf(doc: Doc, scroll: number): Lanes {
  const count = laneCount(doc);
  const h = 24;
  const pitch = h + 4;
  const max = Math.max(0, count * pitch - (pitch - h) - LANES_H);
  return { count, h, pitch, max, scroll: Math.max(0, Math.min(max, scroll)) };
}

/** Lane `lane`'s top. */
const laneY = (L: Lanes, lane: number) => LANE_TOP + lane * L.pitch - L.scroll;

/** The lane at y: one of them, or a new one above them (-1, over the top) or below. */
const laneAt = (L: Lanes, y: number) =>
  y < LANE_TOP
    ? -1
    : Math.max(-1, Math.min(L.count, Math.floor((y - LANE_TOP + L.scroll) / L.pitch)));

/**
 * The default fade (Settings) for the selected markup, and taking fades away, where the
 * right-click was: on the left edge or fade-in handle, the fade-in; on the right, the fade-out;
 * elsewhere on the bar, both. Remove is greyed when none of it has a fade there.
 */
function fadeItems(kind: Hit["kind"]): MenuItems {
  const ends = fadeEnds(kind);
  const names = { in: "Fade-in", out: "Fade-out", both: "Fades" }[ends];
  const { doc, selectedMarks } = useDoc.getState();
  const faded = shownMarks(doc).some((m) => {
    if (!selectedMarks.includes(m.id)) return false;
    const f = markFades(doc.marks.find((k) => k.id === m.id) ?? {}, m.end - m.start);
    return ends === "in" ? f.fadeIn > 0 : ends === "out" ? f.fadeOut > 0 : f.fadeIn + f.fadeOut > 0;
  });
  const selected = () => useDoc.getState().selectedMarks;
  return [
    {
      label: `Apply Default ${names}`,
      run: () => useDoc.getState().defaultFades(selected(), ends),
    },
    {
      label: `Remove ${names}`,
      disabled: !faded,
      run: () => useDoc.getState().removeFades(selected(), ends),
    },
  ];
}

/** The end a right-click on `kind` gives fades to: an edge's or fade handle's, else both. */
function fadeEnds(kind: Hit["kind"] | undefined): "in" | "out" | "both" {
  if (kind === "markStart" || kind === "fadeIn" || kind === "in" || kind === "clipFadeIn") {
    return "in";
  }
  if (kind === "markEnd" || kind === "fadeOut" || kind === "out" || kind === "clipFadeOut") {
    return "out";
  }
  return "both";
}

/**
 * The selected clips' fades (PLAN 4.7a), as markup's (`fadeItems`): the default clip fade or
 * none, where the right-click was; their colour there, black or white (4.7c; another from the
 * options bar's swatch); and the copied fades.
 */
function clipFadeItems(kind: Hit["kind"] | undefined): MenuItems {
  const ends = fadeEnds(kind);
  const names = { in: "Fade-in", out: "Fade-out", both: "Fades" }[ends];
  const { doc, selectedClips } = useDoc.getState();
  const picked = doc.clips.filter((c) => selectedClips.includes(c.id));
  /** All of them fade from or to `colour` at those ends. */
  const all = (colour: string) =>
    picked.length > 0 &&
    picked.every((c) => {
      const f = fadeColours(c);
      return (ends === "out" || f.fadeIn === colour) && (ends === "in" || f.fadeOut === colour);
    });
  const colourItem = (name: string, colour: string) => ({
    label: `Fade ${ends === "in" ? "from" : "to"} ${name}`,
    radio: true,
    checked: all(colour),
    run: () => useDoc.getState().setClipFadeColours(selected(), colour, ends),
  });
  const faded = doc.clips.some((c) => {
    if (!selectedClips.includes(c.id)) return false;
    const f = clipFades(c);
    return ends === "in" ? f.fadeIn > 0 : ends === "out" ? f.fadeOut > 0 : f.fadeIn + f.fadeOut > 0;
  });
  const selected = () => useDoc.getState().selectedClips;
  return [
    {
      label: `Apply Default ${names}`,
      run: () => useDoc.getState().clipDefaultFades(selected(), ends),
    },
    {
      label: `Remove ${names}`,
      disabled: !faded,
      run: () => useDoc.getState().clipRemoveFades(selected(), ends),
    },
    "-",
    colourItem("Black", FADE_BLACK),
    colourItem("White", FADE_WHITE),
    "-",
    {
      label: "Paste Fades",
      hint: "Ctrl+Shift+F",
      disabled: !copiedFades(),
      run: () => void pasteFades(),
    },
  ];
}

/**
 * The selected markup's arrange items, as the preview's menu has them (ObjectMenu.tsx), each
 * greyed when it would move none of it: front and back with nothing it overlaps above or below.
 */
function arrangeItems(doc: Doc, ids: readonly MarkId[]): MenuItems {
  const shown = shownMarks(doc);
  const picked = shown.filter((m) => ids.includes(m.id));
  const past = (m: ShownMark, dir: -1 | 1) =>
    shown.some(
      (o) => o.id !== m.id && o.start < m.end && m.start < o.end && (o.lane - m.lane) * dir > 0,
    );
  const can: Record<Reorder, boolean> = {
    front: picked.some((m) => past(m, -1)),
    forward: picked.some((m) => stepLane(doc, m.id, -1) !== doc),
    backward: picked.some((m) => stepLane(doc, m.id, 1) !== doc),
    back: picked.some((m) => past(m, 1)),
  };
  const item = (how: Reorder, label: string, hint: string) => ({
    label,
    hint,
    disabled: !can[how],
    run: () => markupDoc.getState().reorder(ids.map(annotationId), how),
  });
  return [
    item("front", "To Front", "Ctrl+Shift+]"),
    item("forward", "Forward", "Ctrl+]"),
    item("backward", "Backward", "Ctrl+["),
    item("back", "To Back", "Ctrl+Shift+["),
  ];
}

/**
 * What's at (x, y): on the ruler, ranges and the pending in-point; in the lanes, markup; on the
 * clip track, clips.
 */
function hitAt(
  doc: Doc,
  pendingIn: number | null,
  view: View,
  L: Lanes,
  x: number,
  y: number,
): Hit | null {
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
    if (y < LANE_TOP || y >= LANE_TOP + LANES_H) return null;
    // Last drawn on top: found first.
    for (const mark of shownMarks(doc).reverse()) {
      const y0 = laneY(L, mark.lane);
      if (y < y0 || y > y0 + L.h) continue;
      const x0 = xOf(view, mark.start);
      const x1 = xOf(view, mark.end);
      if (x < x0 - EDGE_HIT || x > x1 + EDGE_HIT) continue;
      // Its top corners: the fades' handles (the fade-out's first, so a bar all fade-in can
      // still get a fade-out). A redaction has none (PLAN 4.8).
      const kept = doc.marks.find((k) => k.id === mark.id);
      if (y <= y0 + FADE_HIT && kept && canFade(kept.object)) {
        const f = markFades(kept, mark.end - mark.start);
        if (Math.abs(x - xOf(view, mark.end - f.fadeOut)) <= EDGE_HIT) {
          return { kind: "fadeOut", mark };
        }
        if (Math.abs(x - xOf(view, mark.start + f.fadeIn)) <= EDGE_HIT) {
          return { kind: "fadeIn", mark };
        }
      }
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
  // Its top corners: the fades' handles (the fade-out's first, as markup's), each on its own
  // clip's side of a cut, the timeline's two ends reaching outward.
  // None at an end that crossfades (PLAN 4.7b): the crossfade is that end's.
  const xf = crossfades(doc);
  if (y <= CLIP_TOP + FADE_HIT) {
    for (let i = 0; i <= last; i++) {
      const clip = doc.clips[i];
      const x0 = xOf(view, starts[i]);
      const x1 = xOf(view, starts[i] + clipLength(clip));
      const f = fadesOf(doc, i);
      const out = xOf(view, starts[i] + clipLength(clip) - f.fadeOut);
      if (!xf[i + 1] && Math.abs(x - out) <= EDGE_HIT && x <= x1 + (i === last ? EDGE_HIT : 0)) {
        return { kind: "clipFadeOut", clip };
      }
      const into = xOf(view, starts[i] + f.fadeIn);
      if (!xf[i] && Math.abs(x - into) <= EDGE_HIT && x >= x0 - (i === 0 ? EDGE_HIT : 0)) {
        return { kind: "clipFadeIn", clip };
      }
    }
  }
  // Along the clip row's foot: each cut's crossfade handle, where the clip after it starts (on
  // the cut, with none), and the crossfade's band.
  if (y >= CLIP_TOP + CLIP_H - CROSSFADE_HIT) {
    for (let i = 1; i <= last; i++) {
      const hx = xOf(view, starts[i]);
      const end = xOf(view, starts[i] + xf[i]);
      if (x >= hx - EDGE_HIT && x <= Math.max(hx + EDGE_HIT, end - EDGE_HIT)) {
        return { kind: "crossfade", clip: doc.clips[i] };
      }
    }
  }
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

/** Each file's clip colour, in the order they were added, round again after the last. */
const CLIP_COLOURS = ["clip", "clip-2", "clip-3", "clip-4", "clip-5", "clip-6"];

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
/** A clip as drawn: where it starts, its frames, and its speed (speed.ts). */
interface Span {
  start: number;
  in: number;
  out: number;
  speed?: Speed;
  phase?: number;
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
  /** Timeline x of the clip's frame `f`. */
  const at = (f: number) => xOf(view, clip.start + f - clip.in);
  // The thumbnails are of source frames, every `step`: at another speed, a source frame shows on
  // its own frames of the clip (speed.ts), so a thumbnail spans more or fewer of them.
  const rate = speedOf(clip);
  const span = (s.step * view.zoom * rate.den) / rate.num;
  if (span <= tw) {
    for (let i = Math.max(0, Math.floor((HEADER - x0) / tw)); x0 + i * tw < right; i++) {
      const f = clip.in + Math.floor((i * tw) / view.zoom);
      if (f >= clip.out) break;
      const bitmap = s.bitmaps[Math.floor(sourceFrame(clip, f) / s.step)];
      if (!bitmap) continue;
      const l = Math.round(x0 + i * tw);
      g.drawImage(bitmap, l, THUMB_TOP, Math.round(x0 + (i + 1) * tw) - l, THUMB_H);
    }
    return;
  }
  const w = Math.round(tw);
  const leftmost = clip.in + Math.max(0, Math.floor((HEADER - x0) / view.zoom));
  const last = Math.min(s.bitmaps.length, Math.ceil(videoEnd(clip) / s.step));
  for (let k = Math.floor(sourceFrame(clip, leftmost) / s.step); k < last; k++) {
    const a = Math.max(clipFrame(clip, k * s.step), clip.in);
    const b = Math.min(clipFrame(clip, (k + 1) * s.step), clip.out);
    if (b <= a) continue;
    const l = Math.round(at(a));
    if (l >= right) break;
    const r = Math.round(at(b));
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

/** A speaker centred on `x`, `y`, with sound coming out of it, or crossed out (muted). */
function drawSpeaker(g: CanvasRenderingContext2D, x: number, y: number, crossed: boolean) {
  g.beginPath();
  g.moveTo(x - 6, y - 2.5);
  g.lineTo(x - 3, y - 2.5);
  g.lineTo(x + 0.5, y - 5.5);
  g.lineTo(x + 0.5, y + 5.5);
  g.lineTo(x - 3, y + 2.5);
  g.lineTo(x - 6, y + 2.5);
  g.closePath();
  g.fill();
  g.lineWidth = 1.4;
  g.lineCap = "round";
  g.beginPath();
  if (crossed) {
    g.moveTo(x + 3, y - 2.5);
    g.lineTo(x + 8, y + 2.5);
    g.moveTo(x + 8, y - 2.5);
    g.lineTo(x + 3, y + 2.5);
  } else {
    g.arc(x + 0.5, y, 3.5, -0.9, 0.9);
    g.moveTo(x + 0.5 + 6.5 * Math.cos(-0.9), y + 6.5 * Math.sin(-0.9));
    g.arc(x + 0.5, y, 6.5, -0.9, 0.9);
  }
  g.stroke();
  g.lineWidth = 1;
  g.lineCap = "butt";
}

/** Whether (`x`, `y`) is on the track header's speaker, which mutes all the sound. */
const onSpeaker = (x: number, y: number) =>
  x < HEADER && y >= CLIP_TOP + CLIP_H - WAVE_H && y <= CLIP_TOP + CLIP_H;

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
  // Where timeline x is in the source, in frames with a fraction (at another speed, as far
  // through its source as its frames go: speed.ts), kept to the clip's video.
  const rate = speedOf(clip);
  const first = sourceFrame(clip, clip.in);
  const last = videoEnd(clip);
  const at = (x: number) => {
    const v = clip.in + fOf(view, x) - clip.start;
    const src = (v * rate.num + (clip.phase ?? 0)) / rate.den;
    return Math.max(first, Math.min(last, src));
  };
  const end = Math.min(right, xOf(view, clip.start + clip.out - clip.in));
  g.fillStyle = "rgb(255 255 255 / 0.55)";
  g.beginPath();
  for (let x = Math.floor(Math.max(xOf(view, clip.start), HEADER)); x < end; x++) {
    const a = waveHeight(peaks.max(at(x), at(x + 1))) * half;
    if (a > 0) g.rect(x, WAVE_MID - a, 1, Math.max(1, 2 * a));
  }
  g.fill();
}

/**
 * The timeline (the mockup's): the ruler with the ranges, the document's clips with their thumbnails and
 * waveform, frame ticks once there's room, and the playhead. Click or drag to move the playhead
 * (on a clip, it's selected too); the wheel scrolls, Ctrl+wheel zooms at the pointer.
 */
export function Timeline({ source, sources, player, inFrames, thumbs, waves, cameraSizes }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** A button is held down on the timeline (a scrub, a drag). */
  const pressed = useRef(false);
  /** Where each retimed clip's speed badge is drawn (canvas x), for a click to open its speed. */
  const badges = useRef(new Map<ClipId, { x: number; w: number }>());
  const draw = useRef<() => void>(() => {});
  const [redraw] = useState(() => () => draw.current());

  // Files dragged over the window (PLAN 4.5e5): over the clip row, the nearest cut (or the
  // start, or the end) is where they'd go in.
  useEffect(() => {
    const off = events.dropHover.listen(({ payload: { x, y, over } }) => {
      const canvas = canvasRef.current;
      let at: number | null = null;
      if (over && canvas && x !== null && y !== null) {
        const r = canvas.getBoundingClientRect();
        const px = x - r.left;
        const py = y - r.top;
        const { doc } = useDoc.getState();
        if (
          doc.clips.length &&
          px >= HEADER &&
          px <= r.width &&
          py >= CLIP_TOP - 12 &&
          py <= CLIP_TOP + CLIP_H + 12
        ) {
          const { view } = useTimeline.getState();
          const bounds = [...clipStarts(doc), total(doc)];
          let best = Infinity;
          bounds.forEach((f, k) => {
            const d = Math.abs(xOf(view, f) - px);
            if (d < best) {
              best = d;
              at = k;
            }
          });
        }
      }
      if (at !== useTimeline.getState().dropAt) {
        useTimeline.getState().setDropAt(at);
        redraw();
      }
    });
    return () => void off.then((f) => f());
  }, [redraw]);
  const colours = useColours(redraw);
  const frames = useDoc((s) => total(s.doc));
  /** The edge or title bar under the pointer (not dragging). */
  const hover = useRef<Hit | null>(null);
  const trim = useRef<Trim | null>(null);
  /** A clip being moved by its title bar: from where, in the document as the drag started. */
  const moving = useRef<{
    id: ClipId;
    x0: number;
    start: Doc;
    /** Several selected, moving with it (PLAN 4.5f2). */
    group: readonly ClipId[] | null;
  } | null>(null);
  /** A range (or the pending in-point) being dragged. */
  const ranging = useRef<RangeDrag | null>(null);
  /** Markup being dragged. */
  const marking = useRef<MarkDrag | null>(null);
  /** A crossfade being dragged (PLAN 4.7b): its incoming clip, from where, and its length then. */
  const crossfading = useRef<{ id: ClipId; x0: number; orig: number } | null>(null);
  /**
   * A clip's fade being dragged (PLAN 4.7a): which, from where, its length then, and (several
   * selected) theirs.
   */
  const clipFading = useRef<{
    id: ClipId;
    fadeIn: boolean;
    x0: number;
    orig: number;
    group: { id: ClipId; fadeIn: number; fadeOut: number }[] | null;
  } | null>(null);

  // Shift pressed or let go while dragging markup takes effect at once: snapping goes off or on,
  // and several items' fades switch between keeping their lengths and all one length. The last
  // move again, with Shift as it is now.
  const lastMove = useRef<{ x: number; y: number; id: number; alt: boolean } | null>(null);
  useEffect(() => {
    const onShift = (e: KeyboardEvent) => {
      const d = marking.current ?? clipFading.current;
      const last = lastMove.current;
      const canvas = canvasRef.current;
      if (e.key !== "Shift" || e.repeat || !d || !last || !canvas) return;
      canvas.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: last.x,
          clientY: last.y,
          pointerId: last.id,
          shiftKey: e.type === "keydown",
          altKey: last.alt,
        }),
      );
    };
    window.addEventListener("keydown", onShift);
    window.addEventListener("keyup", onShift);
    return () => {
      window.removeEventListener("keydown", onShift);
      window.removeEventListener("keyup", onShift);
    };
  }, []);
  /**
   * A box being dragged from an empty spot, selecting what it touches (with Ctrl or Shift, added
   * to what was selected): the clips if it reaches the clip row, else the markup (PLAN 4.5f).
   * Until the pointer moves, a click, which moves the playhead there.
   */
  const boxing = useRef<{
    x0: number;
    y0: number;
    x: number;
    y: number;
    kept: readonly MarkId[];
    keptClips: readonly ClipId[];
    moved: boolean;
  } | null>(null);
  /** How far the markup lanes are scrolled (px), and the selection last kept in view. */
  const laneScroll = useRef(0);
  const shownSelection = useRef<readonly MarkId[]>([]);
  /**
   * The lanes now: scrolled as they were, unless one item was just selected (on the preview,
   * say) whose lane is out of view, which scrolls it in.
   */
  const lanes = () => {
    const { doc, selectedMarks } = useDoc.getState();
    let L = lanesOf(doc, laneScroll.current);
    if (selectedMarks !== shownSelection.current) {
      shownSelection.current = selectedMarks;
      const m =
        selectedMarks.length === 1 && shownMarks(doc).find((k) => k.id === selectedMarks[0]);
      if (m) {
        const top = m.lane * L.pitch;
        if (top < L.scroll) L = lanesOf(doc, top);
        else if (top + L.h > L.scroll + LANES_H) L = lanesOf(doc, top + L.h - LANES_H);
      }
    }
    laneScroll.current = L.scroll;
    return L;
  };
  /** Where a drag snapped to: the guide is drawn there. */
  const guide = useRef<number | null>(null);
  const readout = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const tipFor = useRef<string | null>(null);
  const tipTimer = useRef(0);
  /** A clip's right-click menu, where it was opened. */
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItems } | null>(null);
  /** Any file has sound: the track's speaker shows. */
  const audio = sources.some((s) => s.audioTracks > 0);

  // The thumbnails: a strip per file, loaded as Rust makes them.
  const strips = useRef(new Map<string, ThumbStrip>());
  useEffect(() => {
    const now = strips.current;
    for (const [id, s] of now) {
      if (thumbs[id]?.url !== s.url) {
        s.close();
        now.delete(id);
      }
    }
    for (const [id, info] of Object.entries(thumbs)) {
      const s = now.get(id);
      if (s) s.more(info);
      else now.set(id, new ThumbStrip(info, redraw));
    }
    redraw();
  }, [thumbs, redraw]);
  useEffect(() => {
    const now = strips.current;
    return () => {
      now.forEach((s) => s.close());
      now.clear();
    };
  }, []);

  // The waveforms: each read once it's made.
  const peaks = useRef(new Map<string, { url: string; peaks: Peaks | null }>());
  useEffect(() => {
    const now = peaks.current;
    for (const [id, p] of now) if (waves[id] !== p.url) now.delete(id);
    let gone = false;
    for (const [id, url] of Object.entries(waves)) {
      if (now.has(id)) continue;
      const entry: { url: string; peaks: Peaks | null } = { url, peaks: null };
      now.set(id, entry);
      fetch(url)
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(res.statusText))))
        .then((bytes) => {
          if (gone) return;
          entry.peaks = new Peaks(new Uint8Array(bytes));
          redraw();
        })
        .catch((e: unknown) => {
          if (now.get(id) === entry) now.delete(id);
          console.warn("waveform:", e);
        });
    }
    redraw();
    return () => {
      gone = true;
      // Unfinished reads start again with the next.
      for (const [id, p] of now) if (!p.peaks) now.delete(id);
    };
  }, [waves, redraw]);

  // Where a clip is, for its speed popover opened from the keyboard (Ctrl+R): below its label
  // row, from its start or the timeline's left edge if it's scrolled past that.
  useEffect(() => {
    setSpeedAnchor((id) => {
      const canvas = canvasRef.current;
      const { doc } = useDoc.getState();
      const i = doc.clips.findIndex((c) => c.id === id);
      if (!canvas || i < 0) return null;
      const r = canvas.getBoundingClientRect();
      const { view } = useTimeline.getState();
      const x0 = xOf(view, clipStarts(doc)[i]);
      const x = Math.max(HEADER, Math.min(r.width - 40, x0 + 9));
      return { x: r.left + x, y: r.top + CLIP_TOP + LABEL_H };
    });
    return () => setSpeedAnchor(() => null);
  }, []);

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
      fitHeight(H);
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
      badges.current.clear();
      g.fillStyle = c["tl-bg"];
      g.fillRect(0, 0, W, H);
      g.font = "11px 'Segoe UI Variable Text', 'Segoe UI', system-ui";
      g.textBaseline = "middle";
      g.fillStyle = c["tl-lane"];
      g.fillRect(HEADER, CLIP_TOP, W, CLIP_H);
      // The lanes, scrolled; one item newly selected (on the preview, say) is scrolled into view.
      const L = lanes();
      g.save();
      g.beginPath();
      g.rect(HEADER, LANE_TOP, W - HEADER, LANES_H);
      g.clip();
      for (let lane = 0; lane < L.count; lane++) g.fillRect(HEADER, laneY(L, lane), W, L.h);
      g.restore();

      // The range strip along the ruler's top: where ranges are drawn.
      g.fillStyle = c["range-strip"];
      g.fillRect(HEADER, 0, W - HEADER, RANGE_STRIP);

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
      const { doc, selectedClips, selectedRange, selectedMarks, pendingIn } = useDoc.getState();
      const starts = clipStarts(doc);
      const { flash } = useTimeline.getState();
      const now = performance.now();
      let flashing = false;
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
      const xf = crossfades(doc);
      doc.clips.forEach((clip, i) => {
        const span = {
          start: starts[i],
          in: clip.in,
          out: clip.out,
          speed: clip.speed,
          phase: clip.phase,
        };
        const len = clipLength(clip);
        const x0 = xOf(view, span.start);
        const x1 = xOf(view, span.start + len);
        if (x1 <= HEADER || x0 >= W) return;
        g.save();
        g.beginPath();
        g.roundRect(x0 + CLIP_GAP, CLIP_TOP, x1 - x0 - 2 * CLIP_GAP, CLIP_H, CLIP_RADIUS);
        g.clip();
        // Its file's colour (PLAN 4.5e).
        const file = Math.max(
          0,
          doc.sources.findIndex((s) => s.id === clip.source),
        );
        g.fillStyle = c[CLIP_COLOURS[file % CLIP_COLOURS.length]];
        g.fillRect(x0, CLIP_TOP, x1 - x0, CLIP_H);
        const strip = strips.current.get(clip.source);
        if (strip) drawThumbs(g, strip, view, span, Math.min(x1, W));
        // A muted clip's waveform is faint, and a crossed-out speaker says why.
        const silent = doc.muted || !!clip.muted;
        const wave = peaks.current.get(clip.source)?.peaks;
        if (wave) {
          if (silent) g.globalAlpha = 0.3;
          drawWave(g, wave, view, span, Math.min(x1, W));
          g.globalAlpha = 1;
        }
        // Its fades: a ramp from each top corner it fades at, in its colour (4.7c; black
        // darker than markup's), its slope outlined so it reads on any picture.
        const f = fadesOf(doc, i);
        const colours = fadeColours(clip);
        const fx0 = xOf(view, span.start + f.fadeIn);
        const fx1 = xOf(view, span.start + len - f.fadeOut);
        for (const [edge, fx, on, colour] of [
          [x0, fx0, f.fadeIn > 0, colours.fadeIn],
          [x1, fx1, f.fadeOut > 0, colours.fadeOut],
        ] as const) {
          if (!on) continue;
          g.fillStyle = `${colour}73`;
          g.strokeStyle =
            onAccent(colour) === "#ffffff" ? "rgb(255 255 255 / 0.7)" : "rgb(0 0 0 / 0.6)";
          g.beginPath();
          g.moveTo(edge, CLIP_TOP);
          g.lineTo(fx, CLIP_TOP);
          g.lineTo(edge, CLIP_TOP + CLIP_H);
          g.fill();
          g.beginPath();
          g.moveTo(fx, CLIP_TOP);
          g.lineTo(edge, CLIP_TOP + CLIP_H);
          g.stroke();
        }
        const audible = (sources.find((s) => s.id === clip.source)?.audioTracks ?? 0) > 0;
        if (clip.muted && audible && x1 - Math.max(x0, HEADER) > 30) {
          g.fillStyle = g.strokeStyle = "#fff";
          drawSpeaker(g, Math.max(x0, HEADER) + 15, WAVE_MID, true);
        }
        // Its name and length, kept in view as the timeline scrolls. The name is the clip's
        // id, so it stays with the clip as clips move: a reorder or a delete shows. With
        // several files, its file's name after it, if there's room.
        const lx = Math.max(x0, HEADER) + 9;
        let name = `Clip ${clip.id}`;
        if (x1 - lx > 50) {
          g.fillStyle = "#fff";
          g.font = "600 11px 'Segoe UI Variable Text', 'Segoe UI', system-ui";
          const named = sources.length > 1 && sources.find((s) => s.id === clip.source)?.name;
          if (named) {
            const full = `${name} · ${named.replace(/\.[^.]+$/, "")}`;
            if (x1 - lx > g.measureText(full).width + 10) name = full;
          }
          g.fillText(name, lx, CLIP_TOP + 10);
          let w = g.measureText(`${name} `).width;
          // At another speed, a badge saying it after the name (PLAN §7, Clip speed).
          const sp = speedOf(clip);
          if (!isNormal(sp)) {
            g.font = "600 10px 'Segoe UI Variable Text', 'Segoe UI', system-ui";
            const label = formatSpeed(sp);
            const bw = g.measureText(label).width + 8;
            if (x1 - lx > w + bw + 4) {
              g.fillStyle = "rgb(255 255 255 / 0.24)";
              g.beginPath();
              g.roundRect(lx + w, CLIP_TOP + BADGE_Y, bw, BADGE_H, 3);
              g.fill();
              g.fillStyle = "#fff";
              g.fillText(label, lx + w + 4, CLIP_TOP + 10);
              badges.current.set(clip.id, { x: lx + w, w: bw });
              w += bw + 4;
            }
          }
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
        // A new clip (a duplicate or a paste) lights up, fading out, to show where it went.
        if (flash?.id === clip.id && now - flash.at < FLASH_MS) {
          g.globalAlpha = 0.55 * (1 - (now - flash.at) / FLASH_MS) ** 2;
          g.fillStyle = c["accent"];
          g.fillRect(x0, CLIP_TOP, x1 - x0, CLIP_H);
          g.globalAlpha = 1;
          flashing = true;
        }
        g.restore();
        // Its fades' handles: triangles on the top corners, while it's selected, hovered or
        // its fade dragged; outlined, to read on any picture.
        const hv = hover.current;
        if (
          selectedClips.includes(clip.id) ||
          (hv && "clip" in hv && hv.clip.id === clip.id) ||
          clipFading.current?.id === clip.id
        ) {
          g.fillStyle = "#fff";
          g.strokeStyle = "rgb(0 0 0 / 0.6)";
          const ends = [xf[i] ? null : fx0, xf[i + 1] ? null : fx1];
          for (const fx of ends) {
            if (fx === null) continue;
            g.beginPath();
            g.moveTo(fx - 5, CLIP_TOP);
            g.lineTo(fx + 5, CLIP_TOP);
            g.lineTo(fx, CLIP_TOP + 7);
            g.closePath();
            g.fill();
            g.stroke();
          }
        }
        if (selectedClips.includes(clip.id)) {
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

      // Crossfades (PLAN 4.7b): a band over where the clips overlap, crossed out corner to
      // corner (the usual sign of one). Each cut's handle along the foot of the row, while a
      // clip either side of it is selected or hovered, or its crossfade dragged.
      const near = (i: number) => {
        const ids = [doc.clips[i - 1].id, doc.clips[i].id];
        const hv = hover.current;
        return (
          ids.some((id) => selectedClips.includes(id)) ||
          (!!hv && "clip" in hv && ids.includes(hv.clip.id)) ||
          crossfading.current?.id === ids[1]
        );
      };
      for (let i = 1; i < doc.clips.length; i++) {
        const bx0 = xOf(view, starts[i]);
        const bx1 = xOf(view, starts[i] + xf[i]);
        if (bx1 < HEADER - 10 || bx0 > W + 10) continue;
        if (xf[i]) {
          g.fillStyle = "rgb(0 0 0 / 0.35)";
          g.fillRect(bx0, CLIP_TOP, bx1 - bx0, CLIP_H);
          g.strokeStyle = "rgb(255 255 255 / 0.85)";
          g.beginPath();
          g.moveTo(bx0, CLIP_TOP);
          g.lineTo(bx1, CLIP_TOP + CLIP_H);
          g.moveTo(bx0, CLIP_TOP + CLIP_H);
          g.lineTo(bx1, CLIP_TOP);
          g.stroke();
          g.strokeStyle = "rgb(255 255 255 / 0.6)";
          g.strokeRect(bx0 + 0.5, CLIP_TOP + 0.5, bx1 - bx0 - 1, CLIP_H - 1);
        }
        if (xf[i] || near(i)) {
          // A diamond on the foot of the cut, outlined to read on any picture.
          const hy = CLIP_TOP + CLIP_H - 7;
          g.fillStyle = "#fff";
          g.strokeStyle = "rgb(0 0 0 / 0.6)";
          g.beginPath();
          g.moveTo(bx0, hy - 6);
          g.lineTo(bx0 + 6, hy);
          g.lineTo(bx0, hy + 6);
          g.lineTo(bx0 - 6, hy);
          g.closePath();
          g.fill();
          g.stroke();
        }
      }

      // Markup: a bar in its lane, saying what it is (the selected one outlined), within the
      // lanes' area.
      const marks = new Map(doc.marks.map((m) => [m.id, m]));
      g.save();
      g.beginPath();
      g.rect(HEADER, LANE_TOP, W - HEADER, LANES_H);
      g.clip();
      for (const m of shownMarks(doc)) {
        const x0 = xOf(view, m.start);
        const x1 = xOf(view, m.end);
        if (x1 <= HEADER || x0 >= W) continue;
        const y0 = laneY(L, m.lane);
        if (y0 + L.h < LANE_TOP || y0 > LANE_TOP + LANES_H) continue;
        const LANE_H = L.h;
        g.save();
        g.beginPath();
        g.roundRect(x0, y0, Math.max(2, x1 - x0), LANE_H, 4);
        g.clip();
        g.fillStyle = c["mark"];
        g.fillRect(x0, y0, x1 - x0, LANE_H);
        // The fades: a ramp from each corner it fades at (the mockup's).
        const mark = marks.get(m.id);
        const f = markFades(mark ?? {}, m.end - m.start);
        const fx0 = xOf(view, m.start + f.fadeIn);
        const fx1 = xOf(view, m.end - f.fadeOut);
        g.fillStyle = "rgb(0 0 0 / 0.28)";
        if (f.fadeIn) {
          g.beginPath();
          g.moveTo(x0, y0);
          g.lineTo(fx0, y0);
          g.lineTo(x0, y0 + LANE_H);
          g.fill();
        }
        if (f.fadeOut) {
          g.beginPath();
          g.moveTo(x1, y0);
          g.lineTo(fx1, y0);
          g.lineTo(x1, y0 + LANE_H);
          g.fill();
        }
        g.fillStyle = "#fff";
        g.font = "600 11px 'Segoe UI Variable Text', 'Segoe UI', system-ui";
        g.fillText(
          mark ? markLabel(mark.object, doublesShown()) : "",
          Math.max(fx0, HEADER) + 8,
          y0 + LANE_H / 2 + 1,
        );
        g.restore();
        // Its fades' handles: triangles on the top corners, while it's selected, hovered or
        // dragged (none on a redaction, which doesn't fade).
        const h = hover.current;
        if (
          (!mark || canFade(mark.object)) &&
          (selectedMarks.includes(m.id) ||
            (h && "mark" in h && h.mark.id === m.id) ||
            marking.current?.id === m.id)
        ) {
          g.fillStyle = "#fff";
          for (const fx of [fx0, fx1]) {
            g.beginPath();
            g.moveTo(fx - 5, y0);
            g.lineTo(fx + 5, y0);
            g.lineTo(fx, y0 + 7);
            g.fill();
          }
        }
        if (selectedMarks.includes(m.id)) {
          g.strokeStyle = c["accent"];
          g.lineWidth = 2;
          g.beginPath();
          g.roundRect(x0 + 1, y0 + 1, Math.max(2, x1 - x0 - 2), LANE_H - 2, 4);
          g.stroke();
          g.lineWidth = 1;
        }
      }
      // Alt-dragged copies, not placed yet: faded, outlined dashed, where they'd go (a new lane
      // above or below, at the lanes' edge).
      const ghost = marking.current?.ghost;
      for (const p of ghost ?? []) {
        const x0 = xOf(view, p.start);
        const x1 = xOf(view, p.end);
        const y0 = Math.max(LANE_TOP, Math.min(LANE_TOP + LANES_H - L.h, laneY(L, p.lane)));
        const w = Math.max(2, x1 - x0);
        g.globalAlpha = 0.45;
        g.fillStyle = c["mark"];
        g.beginPath();
        g.roundRect(x0, y0, w, L.h, 4);
        g.fill();
        g.globalAlpha = 1;
        g.strokeStyle = "#fff";
        g.lineWidth = 1.5;
        g.setLineDash([4, 3]);
        g.beginPath();
        g.roundRect(x0 + 1, y0 + 1, Math.max(2, w - 2), L.h - 2, 4);
        g.stroke();
        g.setLineDash([]);
        g.lineWidth = 1;
        const kept = marks.get(p.id);
        g.fillStyle = "rgb(255 255 255 / 0.8)";
        g.font = "600 11px 'Segoe UI Variable Text', 'Segoe UI', system-ui";
        g.fillText(
          kept ? markLabel(kept.object, doublesShown()) : "",
          Math.max(x0, HEADER) + 8,
          y0 + L.h / 2 + 1,
        );
      }
      // The selection box being dragged.
      const box = boxing.current;
      if (box?.moved) {
        const bx = Math.min(box.x0, box.x);
        const by = Math.min(box.y0, box.y);
        g.fillStyle = c["accent"];
        g.globalAlpha = 0.15;
        g.fillRect(bx, by, Math.abs(box.x - box.x0), Math.abs(box.y - box.y0));
        g.globalAlpha = 1;
        g.strokeStyle = c["accent"];
        g.strokeRect(bx + 0.5, by + 0.5, Math.abs(box.x - box.x0), Math.abs(box.y - box.y0));
      }
      g.restore();

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

      // Files dragged over the clip row (PLAN 4.5e5): where they'd go in, an accent bar across
      // the row with a "+" on top (unlike the neutral snap guide and the red playhead).
      const dropAt = useTimeline.getState().dropAt;
      if (dropAt !== null) {
        const bounds = [...starts, total(doc)];
        const dx = Math.round(xOf(view, bounds[Math.min(dropAt, bounds.length - 1)]));
        g.fillStyle = c["accent"];
        g.fillRect(dx - 2, CLIP_TOP - 6, 4, CLIP_H + 12);
        g.beginPath();
        g.arc(dx, CLIP_TOP - 6, 9, 0, 2 * Math.PI);
        g.fill();
        g.fillStyle = "#fff";
        g.fillRect(dx - 5, CLIP_TOP - 7, 10, 2);
        g.fillRect(dx - 1, CLIP_TOP - 11, 2, 10);
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
      for (let lane = 0; lane < L.count; lane++) {
        const y = laneY(L, lane) + L.h / 2;
        if (y > LANE_TOP && y < LANE_TOP + LANES_H) g.fillText("T", HEADER / 2, y);
      }
      // More lanes than fit: where in them the view is.
      if (L.max > 0) {
        const all = L.max + LANES_H;
        g.fillStyle = c["text-3"];
        g.fillRect(HEADER - 4, LANE_TOP + (L.scroll / all) * LANES_H, 2, (LANES_H * LANES_H) / all);
        g.fillStyle = c["text-2"];
      }
      g.fillText("▶", HEADER / 2, THUMB_TOP + THUMB_H / 2);
      g.textAlign = "left";
      // The sound's speaker: a click mutes it all (crossed out, in red).
      if (audio) {
        g.fillStyle = g.strokeStyle = doc.muted ? c["error-text"] : c["text-2"];
        drawSpeaker(g, HEADER / 2 - 1, WAVE_MID, doc.muted);
      }

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
      // Until the new clip's light has faded.
      if (flashing) draw.current();
    };
    draw.current = () => {
      if (!queued) queued = requestAnimationFrame(paint);
    };
    draw.current();
    const stopView = useTimeline.subscribe(draw.current);
    const stopDoc = useDoc.subscribe(draw.current);
    // Clicks' labels say "×2" as the click settings show double-clicks (PLAN 5b.6d).
    const stopClicks = useClickSettings.subscribe(draw.current);
    let last = player.getState().frame;
    const stopPlayer = player.subscribe(() => {
      // Playing: the view follows the playhead, a page at a time. Paused, a jump out of view
      // (Home, End, the next cut) brings it back in, centred; not while the pointer drags on
      // the timeline (scrubbing past its edge would move the view under the pointer).
      const { frame, speed } = player.getState();
      if (speed !== 0) useTimeline.getState().follow(frame);
      else if (frame !== last && !pressed.current) useTimeline.getState().reveal(frame);
      last = frame;
      draw.current();
    });
    return () => {
      cancelAnimationFrame(queued);
      stopView();
      stopDoc();
      stopClicks();
      stopPlayer();
    };
  }, [colours, source, sources, audio, player, frames, inFrames]);

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

  // A press on the timeline lasts until it's let go anywhere (released outside it, uncaptured).
  useEffect(() => {
    const up = () => {
      pressed.current = false;
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  // Wheel: Ctrl zooms at the pointer (at the playhead, if the pointer is on it), otherwise it
  // scrolls. Not passive, so the page doesn't.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const t = useTimeline.getState();
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const L = lanes();
      if (e.ctrlKey) {
        const anchor = zoomAnchor(t.view, x, player.getState().frame);
        t.zoomBy(Math.exp(-e.deltaY * 0.0025), anchor);
      } else if (L.max > 0 && y >= LANE_TOP && y < LANE_TOP + LANES_H) {
        // Over the lanes, when they don't all fit: up and down them (sideways still scrolls).
        laneScroll.current = lanesOf(useDoc.getState().doc, L.scroll + e.deltaY * 0.5).scroll;
        if (e.deltaX) t.scrollBy(e.deltaX * 0.8);
        draw.current();
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
  /** The clip whose speed badge is at canvas (x, y), if any. */
  const badgeAt = (x: number, y: number): ClipId | null => {
    if (y < CLIP_TOP + BADGE_Y || y > CLIP_TOP + BADGE_Y + BADGE_H) return null;
    for (const [id, b] of badges.current) if (x >= b.x && x <= b.x + b.w) return id;
    return null;
  };
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, view: useTimeline.getState().view };
  };
  /** Snapping, unless it's off or Shift is held (Richard, 2026-10-23: as Shift keeps lines straight). */
  const snapping = (e: React.PointerEvent) => useTimeline.getState().snap && !e.shiftKey;
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
    const hours = needsHours(Math.max(frames, longestSource(useDoc.getState().doc)), num, den);
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
    player.peek(sourceFrame(clip, t.edge === "in" ? clip.in : clip.out - 1), clip.source);
    const fmt = formatter();
    // In and Out in the file's time, as the options bar's (at another speed: speed.ts).
    const was = t.orig;
    const inF = sourceFrame(clip, clip.in);
    const lines =
      t.edge === "in"
        ? [`In ${fmt(inF)}  ${signed(inF - sourceFrame(was, was.in))}`]
        : [`Out ${fmt(videoEnd(clip))}  ${signed(videoEnd(clip) - videoEnd(was))}`];
    lines.push(`Length ${fmt(clipLength(clip))}`);
    if (t.edge === "in" && clip.in === 0) lines.push("(the source's start)");
    if (t.edge === "out" && clip.out === sourceLength(doc, clip)) lines.push("(the source's end)");
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
      const at = Math.max(0, Math.min(length - 1, s.frame));
      store.setPendingIn(at);
      player.peekAt(at);
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
      // The preview shows the frame at the moving edge, the playhead staying put (as a trim):
      // the range's first frame, or its last (its end is the frame after).
      player.peekAt(f < fixed ? f : f - 1);
    }
    if (d.id === null) d.id = store.addRange(to.a, to.b);
    else store.setRange(d.id, to.a, to.b);
    showReadout(`${fmt(to.a)} → ${fmt(to.b)}\n${fmt(to.b - to.a)}`, e.clientX, e.clientY);
    draw.current();
  };

  /**
   * Moves markup, or moves one of its edges, as the pointer moves. Moving, it can change lane;
   * whichever end lands near something snaps (the start first). Dragging an edge, the preview
   * shows the frame where it starts or ends, the playhead staying put.
   */
  const markTo = (e: React.PointerEvent<HTMLCanvasElement>, d: MarkDrag) => {
    const { x, y, view } = at(e);
    // An Alt+click isn't a copy: nothing until the pointer has moved.
    if (d.copying && !d.ghost && Math.hypot(x - d.x0, y - d.y0) < DRAG_PX) return;
    const store = useDoc.getState();
    const length = total(store.doc);
    // A copy snaps to its original's ends too.
    const targets = markTargets(store.doc, d.playhead, d.copying ? -1 : d.id, store.pendingIn);
    const on = snapping(e);
    const { start, end, lane } = d.orig;
    const len = end - start;
    if (d.kind === "fadeIn" || d.kind === "fadeOut") {
      const df = Math.round((x - d.x0) / view.zoom);
      const fadeIn = d.kind === "fadeIn";
      // A fade-in grows to the right, a fade-out to the left.
      const by = fadeIn ? df : -df;
      const set = (v: number) => (fadeIn ? { fadeIn: v } : { fadeOut: v });
      store.setMarkFades(d.id, set((fadeIn ? d.orig.fadeIn : d.orig.fadeOut) + by));
      const f = markFades(useDoc.getState().doc.marks.find((m) => m.id === d.id) ?? {}, len);
      const own = fadeIn ? f.fadeIn : f.fadeOut;
      const fmt = formatter();
      const name = fadeIn ? "Fade in" : "Fade out";
      if (d.group) {
        // Several selected (Richard, 2026-10-23): theirs change by as much, each as far as it
        // can; with Shift held (it can come and go mid-drag), each the dragged one's length.
        const same = e.shiftKey;
        for (const m of d.group) {
          if (m.id === d.id) continue;
          store.setMarkFades(m.id, set(same ? own : (fadeIn ? m.fadeIn : m.fadeOut) + by));
        }
        showReadout(
          `${name} ${same ? `${fmt(own)} each` : signed(own - (fadeIn ? d.orig.fadeIn : d.orig.fadeOut))}\n${d.group.length} items`,
          e.clientX,
          e.clientY,
        );
      } else showReadout(`${name} ${fmt(own)}`, e.clientX, e.clientY);
      draw.current();
      return;
    }
    const fmt = formatter();
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
      const L = lanes();
      to = { start: a, end: a + len, lane: laneAt(L, y) };
      if (d.copying) {
        const row = (y - LANE_TOP + L.scroll) / L.pitch;
        d.below = row - Math.floor(row) >= 0.5;
        d.ghost = d.group ? groupPlaces(d, d.group, a - start, y) : [{ id: d.id, ...to }];
        const n = d.ghost.length;
        showReadout(
          `${fmt(to.start)} → ${fmt(to.end)}\n${n > 1 ? `${n} copies` : "A copy"}`,
          e.clientX,
          e.clientY,
        );
        draw.current();
        return;
      }
      if (d.group) {
        useDoc.getState().placeMarks(groupPlaces(d, d.group, a - start, y));
        showReadout(
          `${fmt(to.start)} → ${fmt(to.end)}
${d.group.length} items`,
          e.clientX,
          e.clientY,
        );
        draw.current();
        return;
      }
    } else {
      const s = snap(fOf(view, x), targets, view.zoom, on);
      guide.current = s.target;
      if (d.kind === "start") to.start = Math.max(0, Math.min(end - 1, s.frame));
      else to.end = Math.max(start + 1, Math.min(length, s.frame));
      // The preview shows the frame at the moving edge, the playhead staying put (as a trim).
      player.peekAt(d.kind === "start" ? to.start : to.end - 1);
      if (d.group && (d.kind === "start" || d.kind === "end")) {
        // Several selected: theirs follow by as much, each as far as it can (`resizeEdges`).
        const df = d.kind === "start" ? to.start - start : to.end - end;
        const ids = d.group.map((m) => m.id);
        store.resizeMarks(resizeEdges(store.gestureStart ?? store.doc, ids, d.kind, df));
        showReadout(`${signed(df)}\n${d.group.length} items`, e.clientX, e.clientY);
        draw.current();
        return;
      }
    }
    if (d.kind === "move") {
      // Dropped on a busy lane: a new one above it, or below it from its lower half.
      const row = (y - LANE_TOP + lanes().scroll) / lanes().pitch;
      store.dropMark(d.id, to.start, to.end, to.lane, row - Math.floor(row) >= 0.5);
    } else store.setMark(d.id, to.start, to.end, to.lane);
    showReadout(
      `${fmt(to.start)} → ${fmt(to.end)}\n${fmt(to.end - to.start)}`,
      e.clientX,
      e.clientY,
    );
    draw.current();
  };

  /**
   * A clip's fade follows the pointer: a fade-in grows to the right, a fade-out to the left. Several
   * selected change by as much, each as far as it can; with Shift, each the dragged one's length.
   */
  const clipFadeTo = (
    e: React.PointerEvent<HTMLCanvasElement>,
    d: NonNullable<typeof clipFading.current>,
  ) => {
    const { x, view } = at(e);
    const df = Math.round((x - d.x0) / view.zoom);
    const by = d.fadeIn ? df : -df;
    const set = (v: number) => (d.fadeIn ? { fadeIn: v } : { fadeOut: v });
    const store = useDoc.getState();
    store.setClipFades(d.id, set(d.orig + by));
    const clip = useDoc.getState().doc.clips.find((c) => c.id === d.id);
    const own = clip ? clipFades(clip)[d.fadeIn ? "fadeIn" : "fadeOut"] : 0;
    const fmt = formatter();
    const name = d.fadeIn ? "Fade in" : "Fade out";
    if (d.group) {
      const same = e.shiftKey;
      for (const c of d.group) {
        if (c.id === d.id) continue;
        store.setClipFades(c.id, set(same ? own : (d.fadeIn ? c.fadeIn : c.fadeOut) + by));
      }
      showReadout(
        `${name} ${same ? `${fmt(own)} each` : signed(own - d.orig)}\n${d.group.length} clips`,
        e.clientX,
        e.clientY,
      );
    } else showReadout(`${name} ${fmt(own)}`, e.clientX, e.clientY);
    draw.current();
  };

  /**
   * A crossfade follows the pointer: the clip after the cut starts where it is, over the end of
   * the one before (left, longer; right, shorter, to none), as far as the clips let it.
   */
  const crossfadeTo = (
    e: React.PointerEvent<HTMLCanvasElement>,
    d: NonNullable<typeof crossfading.current>,
  ) => {
    const { x, view } = at(e);
    const asked = Math.max(0, d.orig + Math.round((d.x0 - x) / view.zoom));
    useDoc.getState().setCrossfade(d.id, asked);
    const doc = useDoc.getState().doc;
    const now = crossfades(doc)[doc.clips.findIndex((c) => c.id === d.id)] ?? 0;
    const fmt = formatter();
    showReadout(
      now ? `Crossfade ${fmt(now)}${now < asked ? "\n(as long as it goes)" : ""}` : "No crossfade",
      e.clientX,
      e.clientY,
    );
    draw.current();
  };

  /**
   * An Alt-drag let go: copies of what was dragged (with its fades, if Settings say so) placed
   * where its ghost was, as a drop of the originals would be (on a busy lane, a new one above or
   * below), and selected. One undo step with the drag.
   */
  const dropCopies = (d: MarkDrag, ghost: NonNullable<MarkDrag["ghost"]>) => {
    const items = d.group ?? [{ id: d.id, ...d.orig }];
    const placed: { id: MarkId; start: number; end: number; lane: number }[] = [];
    for (const p of ghost) {
      const store = useDoc.getState();
      const kept = store.doc.marks.find((k) => k.id === p.id);
      const own = items.find((m) => m.id === p.id);
      if (!kept || !own) continue;
      const id = store.addMark(kept.object, p.start, p.end - p.start, Math.max(0, p.lane));
      if (id === null) continue;
      if (store.options.copyFades) {
        store.setMarkFades(id, { fadeIn: own.fadeIn });
        store.setMarkFades(id, { fadeOut: own.fadeOut });
      }
      placed.push({ ...p, id });
    }
    const store = useDoc.getState();
    if (placed.length === 1 && !d.group) {
      const [p] = placed;
      store.dropMark(p.id, p.start, p.end, p.lane, d.below);
    } else store.placeMarks(placed);
    store.selectMarks(placed.map((p) => p.id));
  };

  /**
   * Where several selected markup items go, moved together: by `df` frames (kept so all stay on
   * the timeline) and by as many lanes as the pointer has gone up or down (kept so none goes
   * past a new lane above or below), each from its place when the drag started.
   */
  const groupPlaces = (
    d: MarkDrag,
    group: NonNullable<MarkDrag["group"]>,
    df: number,
    y: number,
  ) => {
    const length = total(useDoc.getState().doc);
    const lo = Math.min(...group.map((m) => m.start));
    const hi = Math.max(...group.map((m) => m.end));
    const dt = Math.max(-lo, Math.min(length - hi, df));
    // From a new lane above them all (-1) to a new one below.
    const top = Math.min(...group.map((m) => m.lane));
    const bottom = Math.max(...group.map((m) => m.lane));
    const { gestureStart, doc } = useDoc.getState();
    const rows = Math.round((y - d.y0) / lanes().pitch);
    const dl = Math.max(-1 - top, Math.min(laneCount(gestureStart ?? doc) - bottom, rows));
    return group.map((m) => ({
      id: m.id,
      start: m.start + dt,
      end: m.end + dt,
      lane: m.lane + dl,
    }));
  };

  /**
   * The selection box follows the pointer: the clips it touches are selected if it reaches the
   * clip row, else the markup it touches.
   */
  const boxTo = (
    e: React.PointerEvent<HTMLCanvasElement>,
    box: NonNullable<typeof boxing.current>,
  ) => {
    const { x, y, view } = at(e);
    if (!box.moved && Math.hypot(x - box.x0, y - box.y0) < DRAG_PX) return;
    Object.assign(box, { x, y, moved: true });
    const L = lanes();
    const [x0, x1] = [Math.min(box.x0, x), Math.max(box.x0, x)];
    const [y0, y1] = [Math.min(box.y0, y), Math.max(box.y0, y)];
    const { doc } = useDoc.getState();
    if (y1 >= CLIP_TOP && y0 <= CLIP_TOP + CLIP_H) {
      const starts = clipStarts(doc);
      const touched = doc.clips
        .filter((c, i) => xOf(view, starts[i]) < x1 && xOf(view, starts[i] + clipLength(c)) > x0)
        .map((c) => c.id);
      const ids = [...new Set([...box.keptClips, ...touched])];
      const now = useDoc.getState().selectedClips;
      if (ids.length !== now.length || ids.some((id, i) => id !== now[i])) {
        useDoc.getState().selectClips(ids);
      }
      draw.current();
      return;
    }
    const touched = shownMarks(doc)
      .filter((m) => {
        const top = laneY(L, m.lane);
        return xOf(view, m.start) < x1 && xOf(view, m.end) > x0 && top < y1 && top + L.h > y0;
      })
      .map((m) => m.id);
    const ids = [...new Set([...box.kept, ...touched])];
    const now = useDoc.getState().selectedMarks;
    if (ids.length !== now.length || ids.some((id, i) => id !== now[i])) {
      useDoc.getState().selectMarks(ids);
      // Not scrolled to: the box is where the pointer is.
      shownSelection.current = useDoc.getState().selectedMarks;
    }
    draw.current();
  };

  /** What's being dragged, for the hint line's modifiers (`scrubbing`: the playhead). */
  const dragHintNow = (scrubbing: boolean): DragHint | null => {
    const d = marking.current;
    if (crossfading.current) return "crossfade";
    if (clipFading.current) return "fade";
    if (trim.current) return "trim";
    if (moving.current !== null) return "clipMove";
    if (ranging.current) return "range";
    if (d) {
      if (d.kind === "move") return d.copying ? "markCopy" : "markMove";
      return d.kind === "start" || d.kind === "end" ? "markEdge" : "fade";
    }
    if (boxing.current) return "box";
    return scrubbing ? "scrub" : null;
  };

  /** The drag ended (or was cancelled by the system): one undo step, and back to hovering. */
  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    setDragHint(null);
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
    if (clipFading.current) {
      clipFading.current = null;
      docState.endGesture();
    }
    if (crossfading.current) {
      crossfading.current = null;
      docState.endGesture();
    }
    if (ranging.current) {
      ranging.current = null;
      docState.endGesture();
      player.peek(null);
    }
    if (marking.current) {
      const d = marking.current;
      marking.current = null;
      if (d.ghost && e.type === "pointerup") dropCopies(d, d.ghost);
      docState.endGesture();
      player.peek(null);
    }
    if (boxing.current) {
      // Not dragged: a click on an empty lane, which selects nothing (with Ctrl or Shift, keeps
      // the selection) and moves the playhead there.
      const box = boxing.current;
      boxing.current = null;
      if (!box.moved && e.type === "pointerup") {
        if (!box.kept.length && !box.keptClips.length) docState.select(null);
        scrubTo(e);
      }
    }
    showReadout(null);
    guide.current = null;
    const { x, y, view } = at(e);
    const now = useDoc.getState();
    hover.current = hitAt(now.doc, now.pendingIn, view, lanes(), x, y);
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
      player.peek(
        sourceFrame(hit.clip, hit.kind === "in" ? hit.clip.in : hit.clip.out - 1),
        hit.clip.source,
      );
      return;
    }
    if (hit.kind === "crossfade") {
      docState.beginGesture();
      const index = docState.doc.clips.findIndex((c) => c.id === hit.clip.id);
      crossfading.current = {
        id: hit.clip.id,
        x0: x,
        orig: crossfades(docState.doc)[index] ?? 0,
      };
      return;
    }
    if (hit.kind === "clipFadeIn" || hit.kind === "clipFadeOut") {
      // One of several selected: theirs fade with it.
      if (!docState.selectedClips.includes(hit.clip.id)) docState.select(hit.clip.id);
      docState.beginGesture();
      const picked = useDoc.getState().selectedClips;
      const fadeIn = hit.kind === "clipFadeIn";
      const f = clipFades(hit.clip);
      clipFading.current = {
        id: hit.clip.id,
        fadeIn,
        x0: x,
        orig: fadeIn ? f.fadeIn : f.fadeOut,
        group:
          picked.length > 1
            ? docState.doc.clips
                .filter((c) => picked.includes(c.id))
                .map((c) => ({ id: c.id, ...clipFades(c) }))
            : null,
      };
      return;
    }
    if (hit.kind === "move") {
      // Ctrl or Shift adds it to the selection or takes it out (PLAN 4.5f), nothing dragged; a
      // press on one of several selected keeps them.
      const sel = docState.selectedClips;
      if (e.ctrlKey || e.shiftKey) {
        docState.selectClips(
          sel.includes(hit.clip.id)
            ? sel.filter((id) => id !== hit.clip.id)
            : [...sel, hit.clip.id],
        );
        return;
      }
      if (!sel.includes(hit.clip.id)) docState.select(hit.clip.id);
      docState.beginGesture();
      // One of several selected: they all move, gathered (PLAN 4.5f2).
      const group = useDoc.getState().selectedClips;
      moving.current = {
        id: hit.clip.id,
        x0: x,
        start: docState.doc,
        group: group.length > 1 ? group : null,
      };
      e.currentTarget.style.cursor = "grabbing";
      return;
    }
    if (hit.kind === "pendingIn") {
      ranging.current = { kind: "pendingIn", id: null, x0: x, orig: { a: 0, b: 0 } };
      return;
    }
    if ("mark" in hit) {
      const { mark } = hit;
      // Ctrl or Shift adds it to the selection or takes it out (taken out, there's nothing to
      // drag); a press on one already selected keeps the others, to drag them all.
      const sel = docState.selectedMarks;
      const adding = e.ctrlKey || e.shiftKey;
      if (adding && sel.includes(mark.id)) {
        docState.selectMarks(sel.filter((id) => id !== mark.id));
        return;
      }
      if (adding) docState.selectMarks([...sel, mark.id]);
      else if (!sel.includes(mark.id)) docState.selectMarks([mark.id]);
      docState.beginGesture();
      const kind =
        hit.kind === "markStart"
          ? "start"
          : hit.kind === "markEnd"
            ? "end"
            : hit.kind === "markMove"
              ? "move"
              : hit.kind;
      const fades = markFades(
        docState.doc.marks.find((m) => m.id === mark.id) ?? {},
        mark.end - mark.start,
      );
      const picked = useDoc.getState().selectedMarks;
      // Several selected: moving one moves them all; dragging one's edge or fade drags theirs.
      const group =
        picked.length > 1
          ? shownMarks(docState.doc)
              .filter((m) => picked.includes(m.id))
              .map(({ id, start, end, lane }) => ({
                id,
                start,
                end,
                lane,
                ...markFades(docState.doc.marks.find((k) => k.id === id) ?? {}, end - start),
              }))
          : null;
      const copying = kind === "move" && e.altKey;
      marking.current = {
        kind,
        id: mark.id,
        x0: x,
        y0: at(e).y,
        orig: { start: mark.start, end: mark.end, lane: mark.lane, ...fades },
        playhead: player.getState().frame,
        group,
        copying,
        ghost: null,
        below: false,
      };
      if (kind === "move") e.currentTarget.style.cursor = copying ? "copy" : "grabbing";
      return;
    }
    docState.beginGesture();
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
          pressed.current = true;
          hideTip();
          tipFor.current = null;
          const docState = useDoc.getState();
          const { x, y, view } = at(e);
          if (audio && onSpeaker(x, y)) {
            docState.muteTrack(!docState.doc.muted);
            return;
          }
          // A clip's speed badge: its speed, in the popover below it.
          const badge = badgeAt(x, y);
          if (badge !== null) {
            const r = e.currentTarget.getBoundingClientRect();
            const b = badges.current.get(badge)!;
            docState.select(badge);
            openSpeed(badge, { x: r.left + b.x, y: r.top + CLIP_TOP + BADGE_Y + BADGE_H });
            return;
          }
          e.currentTarget.setPointerCapture(e.pointerId);
          const hit = hitAt(docState.doc, docState.pendingIn, view, lanes(), x, y);
          hover.current = null;
          if (hit) {
            startDrag(e, hit, x);
            draw.current();
            return;
          }
          const adding = e.ctrlKey || e.shiftKey;
          const under =
            y >= CLIP_TOP && y <= CLIP_TOP + CLIP_H
              ? clipAt(docState.doc, Math.floor(fOf(view, x)))
              : null;
          // An empty spot (the lanes', or the clip row's past the clips or below them): a box.
          const lanesSpot = y >= LANE_TOP && y < LANE_TOP + LANES_H;
          if (x >= HEADER && (lanesSpot || (y >= CLIP_TOP && !under))) {
            boxing.current = {
              x0: x,
              y0: y,
              x,
              y,
              kept: adding ? docState.selectedMarks : [],
              keptClips: adding ? docState.selectedClips : [],
              moved: false,
            };
            return;
          }
          if (under && adding) {
            // Ctrl or Shift+click on a clip: added to the selection, or taken out.
            const sel = docState.selectedClips;
            const id = under.clip.id;
            docState.selectClips(sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]);
            draw.current();
            return;
          }
          if (y >= CLIP_TOP && x >= HEADER) {
            docState.select(under?.clip.id ?? null);
          } else if (y >= RULER && x >= HEADER) {
            // An empty lane: nothing selected.
            docState.select(null);
          }
          scrubTo(e);
        }}
        onPointerMove={(e) => {
          const canvas = e.currentTarget;
          // The hint line (PLAN 4.6b): a drag's modifiers while one's under way.
          const drag = dragHintNow(canvas.hasPointerCapture(e.pointerId));
          if (drag) {
            setHoverHint(null);
            setDragHint(drag);
          }
          if (trim.current) {
            trimTo(e, trim.current);
            return;
          }
          if (clipFading.current) {
            lastMove.current = { x: e.clientX, y: e.clientY, id: e.pointerId, alt: e.altKey };
            clipFadeTo(e, clipFading.current);
            return;
          }
          if (crossfading.current) {
            crossfadeTo(e, crossfading.current);
            return;
          }
          if (ranging.current) {
            rangeTo(e, ranging.current);
            return;
          }
          if (marking.current) {
            lastMove.current = { x: e.clientX, y: e.clientY, id: e.pointerId, alt: e.altKey };
            markTo(e, marking.current);
            return;
          }
          if (boxing.current) {
            boxTo(e, boxing.current);
            return;
          }
          if (moving.current !== null) {
            // A click isn't a drag: nothing moves until the pointer has.
            const m = moving.current;
            const { x, view } = at(e);
            if (Math.abs(x - m.x0) < DRAG_PX) return;
            const df = (x - m.x0) / view.zoom;
            if (m.group)
              useDoc.getState().moveClips(m.group, moveGroupSlot(m.start, m.group, m.id, df));
            else useDoc.getState().move(m.id, moveSlot(m.start, m.id, df));
            return;
          }
          if (canvas.hasPointerCapture(e.pointerId)) {
            scrubTo(e);
            return;
          }
          const { x, y, view } = at(e);
          const { doc, pendingIn } = useDoc.getState();
          const hit = hitAt(doc, pendingIn, view, lanes(), x, y);
          if (!sameHit(hit, hover.current)) {
            hover.current = hit;
            draw.current();
          }
          const speaker = audio && onSpeaker(x, y);
          canvas.style.cursor = speaker ? "pointer" : cursorFor(hit);
          canvas.title = speaker
            ? `${doc.muted ? "Unmute the sound" : "Mute all the sound"} (Shift+M)`
            : "";
          // None while a menu is open (its tooltip would read as part of it).
          if (menu) hideTip();
          else hoverTip(hit?.kind ?? null, e.clientX, e.clientY);
          // The hint line: what the handle under the pointer does, or the lanes or ruler.
          setHoverHint(
            speaker
              ? "timeline.speaker"
              : hit
                ? (`timeline.${hit.kind}` as ControlHint)
                : y >= LANE_TOP && y < CLIP_TOP
                  ? "timeline.lanes"
                  : "timeline.ruler",
          );
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          // A handle's tooltip under the menu reads as part of it.
          hideTip();
          const r = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - r.left;
          const y = e.clientY - r.top;
          const docState = useDoc.getState();
          const view = useTimeline.getState().view;
          const hit = hitAt(docState.doc, docState.pendingIn, view, lanes(), x, y);
          if (hit && "mark" in hit) {
            if (!docState.selectedMarks.includes(hit.mark.id)) docState.selectMarks([hit.mark.id]);
            setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                ...fadeItems(hit.kind),
                "-",
                { label: "Copy", hint: "Ctrl+C", run: () => void copySelectedMarks() },
                {
                  label: "Paste Style",
                  hint: "Ctrl+Shift+V",
                  disabled: !copiedMarks(),
                  run: () => void pasteStyle(),
                },
                {
                  label: "Paste Fades",
                  hint: "Ctrl+Shift+F",
                  disabled: !copiedFades(),
                  run: () => void pasteFades(),
                },
                {
                  label: "Paste Timing",
                  hint: "Ctrl+Shift+T",
                  disabled: !copiedMarks(),
                  run: () => void pasteTiming(),
                },
                { label: "Duplicate", hint: "Ctrl+D", run: () => void duplicateSelection() },
                "-",
                ...arrangeItems(useDoc.getState().doc, useDoc.getState().selectedMarks),
                "-",
                { label: "Delete", hint: "Delete", run: deleteSelected },
              ],
            });
            return;
          }
          // A cut's crossfade handle or band (PLAN 4.7b): one of the default length, or none.
          if (hit?.kind === "crossfade") {
            const { id } = hit.clip;
            const index = docState.doc.clips.findIndex((c) => c.id === id);
            const has = (crossfades(docState.doc)[index] ?? 0) > 0;
            setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                {
                  label: has ? "Default Crossfade" : "Add Crossfade",
                  title: "As long as Settings › Timeline › Default clip fade",
                  run: () =>
                    useDoc.getState().setCrossfade(id, useDoc.getState().options.defaultClipFade),
                },
                {
                  label: "Remove Crossfade",
                  disabled: !has,
                  run: () => useDoc.getState().setCrossfade(id, 0),
                },
              ],
            });
            return;
          }
          // A range, anywhere it can be grabbed (its bar or an edge): selected, and its menu.
          if (hit && "range" in hit) {
            const { id } = hit.range;
            docState.selectRange(id);
            setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                {
                  label: "Delete range",
                  hint: "Delete",
                  run: () => useDoc.getState().removeRange(id),
                },
              ],
            });
            return;
          }
          // The markup lanes' empty space: tidying them up.
          if (x >= HEADER && y >= LANE_TOP && y < LANE_TOP + LANES_H) {
            setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                {
                  label: "Clean up timeline",
                  title:
                    "Close up the markup lanes as far as they go, keeping every item's place and order",
                  disabled: packLanes(docState.doc) === docState.doc,
                  run: () => useDoc.getState().packLanes(),
                },
              ],
            });
            return;
          }
          if (x < HEADER || y < CLIP_TOP || y > CLIP_TOP + CLIP_H) return;
          const under = clipAt(docState.doc, Math.floor(fOf(view, x)));
          if (!under) return;
          // On a clip's edge or fade handle: that clip (an edge's pixel can be the next one's).
          const clip = hit && "clip" in hit ? hit.clip : under.clip;
          // On one of several selected: their menu (PLAN 4.5f), what works on them all.
          const group = docState.selectedClips;
          if (group.length > 1 && group.includes(clip.id)) {
            setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                ...clipsExportItems(group),
                "-",
                ...clipFadeItems(hit?.kind),
                "-",
                {
                  label: "Duplicate clips",
                  hint: "Ctrl+D",
                  run: () => duplicateSelectedClip(player),
                },
                { label: "Copy clips", hint: "Ctrl+C", run: copySelectedClip },
                {
                  label: "Delete clips (close the gap)",
                  hint: "Delete",
                  disabled: group.length >= docState.doc.clips.length,
                  run: deleteSelected,
                },
              ],
            });
            return;
          }
          docState.select(clip.id);
          const full = sourceLength(docState.doc, clip);
          const whole = clip.in === 0 && clip.out === full;
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: "Export clip as MP4…", run: () => exportClip(clip.id, "mp4") },
              { label: "Export clip as GIF…", run: () => exportClip(clip.id, "gif") },
              "-",
              ...clipFadeItems(hit?.kind),
              "-",
              { label: "Split at the playhead", hint: "S", run: () => splitAtPlayhead(player) },
              { label: "Duplicate", hint: "Ctrl+D", run: () => duplicateSelectedClip(player) },
              { label: "Copy", hint: "Ctrl+C", run: copySelectedClip },
              {
                label: clip.muted ? "Unmute" : "Mute",
                hint: "M",
                disabled: !sources.some((s) => s.id === clip.source && s.audioTracks > 0),
                run: () => useDoc.getState().muteClip(clip.id, !clip.muted),
              },
              {
                label: "Delete (close the gap)",
                hint: "Delete",
                disabled: docState.doc.clips.length < 2,
                run: deleteSelected,
              },
              "-",
              // Its speed: in the options bar's field (the menu closes first).
              {
                label: "Speed…",
                hint: "Ctrl+R",
                run: () => openSpeed(clip.id, { x: e.clientX, y: e.clientY }),
              },
              {
                label: "Reset Speed",
                disabled: isNormal(speedOf(clip)),
                run: () => useDoc.getState().setSpeed([clip.id], NORMAL_SPEED),
              },
              {
                label: "Restore the full length",
                disabled: whole,
                run: () => useDoc.getState().trim(clip.id, 0, full),
              },
              // Its camera's size (PLAN 5d.6a), as the options bar's.
              ...(cameraSizes[clip.source]
                ? [
                    "-" as const,
                    ...CAMERA_SIZES.map((k) => ({
                      label: `Camera: ${CAMERA_SIZE_NAMES[k]}`,
                      radio: true,
                      checked: (clip.cameraSize ?? cameraSizes[clip.source]) === k,
                      run: () => {
                        const ids = useDoc.getState().selectedClips;
                        const on = ids.includes(clip.id) ? ids : [clip.id];
                        useDoc.getState().setCameraSize(
                          docState.doc.clips
                            .filter((c) => on.includes(c.id) && cameraSizes[c.source])
                            .map((c) => c.id),
                          k,
                        );
                      },
                    })),
                  ]
                : []),
            ],
          });
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          hideTip();
          tipFor.current = null;
          setHoverHint(null);
          if (
            trim.current ||
            ranging.current ||
            marking.current ||
            clipFading.current ||
            crossfading.current ||
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
      <TimelineScrollbar />
    </>
  );
}
