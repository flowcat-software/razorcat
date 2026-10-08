import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SourceInfo, ThumbsInfo } from "../shared/ipc";
import type { Player } from "./player";
import { ThumbStrip } from "./thumbs";
import { Peaks, waveHeight } from "./wave";
import { timecode, needsHours } from "./timecode";
import { clipAt, clipLength, clipStarts, total } from "./doc";
import { useDoc } from "./docStore";
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

// The mockup's geometry (mockup/main.html). Markup lanes go between the ruler and the clip track
// in Phase 4.
const RULER = 30;
const CLIP_TOP = RULER + 10;
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

const TOKENS = ["accent", "text-2", "text-3", "tl-bg", "tl-lane", "clip", "border", "playhead"];

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
 * The timeline (the mockup's): the ruler, the document's clips with their thumbnails and
 * waveform, frame ticks once there's room, and the playhead. Click or drag to move the playhead
 * (on a clip, it's selected too); the wheel scrolls, Ctrl+wheel zooms at the pointer.
 */
export function Timeline({ source, player, inFrames, thumbs, waveUrl }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draw = useRef<() => void>(() => {});
  const [redraw] = useState(() => () => draw.current());
  const colours = useColours(redraw);
  const frames = useDoc((s) => total(s.doc));

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
      const { doc, selected } = useDoc.getState();
      const starts = clipStarts(doc);
      g.save();
      g.beginPath();
      g.rect(HEADER, 0, W - HEADER, H);
      g.clip();
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
      g.restore();

      // Track header.
      g.fillStyle = c["tl-bg"];
      g.fillRect(0, 0, HEADER, H);
      g.fillStyle = c["text-2"];
      g.font = "600 11px 'Segoe UI Variable Text', 'Segoe UI', system-ui";
      g.textAlign = "center";
      // The clip track's picture and sound (as the mockup).
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

  // Click or drag: the playhead follows the pointer (scrubbing; the proxy keeps up). On the
  // clip track the clip under the pointer is selected; by its title bar it's dragged to another
  // place, the others sliding aside (one undo step).
  const moving = useRef<number | null>(null);
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, view: useTimeline.getState().view };
  };
  const scrubTo = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, view } = at(e);
    player.seek(Math.floor(fOf(view, Math.max(HEADER, x))));
  };
  /** The clip whose title bar is under the pointer. */
  const titleBar = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y, view } = at(e);
    if (x < HEADER || y < CLIP_TOP || y >= CLIP_TOP + LABEL_H) return null;
    return clipAt(useDoc.getState().doc, Math.floor(fOf(view, x)))?.clip ?? null;
  };

  return (
    <canvas
      ref={canvasRef}
      className={styles.timelineCanvas}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const docState = useDoc.getState();
        const title = titleBar(e);
        if (title) {
          docState.select(title.id);
          docState.beginGesture();
          moving.current = title.id;
          e.currentTarget.style.cursor = "grabbing";
          return;
        }
        const { x, y, view } = at(e);
        if (y >= CLIP_TOP && x >= HEADER) {
          docState.select(clipAt(docState.doc, Math.floor(fOf(view, x)))?.clip.id ?? null);
        }
        scrubTo(e);
      }}
      onPointerMove={(e) => {
        const canvas = e.currentTarget;
        if (moving.current !== null) {
          // The slot: past how many of the other clips' middles the pointer is.
          const { x, view } = at(e);
          const f = fOf(view, x);
          const { doc, move } = useDoc.getState();
          let t = 0;
          let slot = 0;
          for (const c of doc.clips) {
            if (c.id === moving.current) continue;
            if (f > t + clipLength(c) / 2) slot++;
            t += clipLength(c);
          }
          move(moving.current, slot);
          return;
        }
        if (canvas.hasPointerCapture(e.pointerId)) scrubTo(e);
        else canvas.style.cursor = titleBar(e) ? "grab" : "";
      }}
      onPointerUp={(e) => {
        if (moving.current === null) return;
        moving.current = null;
        useDoc.getState().endGesture();
        e.currentTarget.style.cursor = titleBar(e) ? "grab" : "";
      }}
    />
  );
}
