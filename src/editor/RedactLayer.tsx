import { useEffect, useLayoutEffect, useRef } from "react";
import { docStore as markupDoc } from "../markup/model/store";
import type { RedactAnnotation } from "../markup/model/types";
import type { SourceInfo } from "../shared/ipc";
import { useDoc } from "./docStore";
import { fitIn, type Rect, type Size } from "./fit";
import { growColour, growMode, outputSize, SIDES, type Frame } from "./frame";
import type { Player } from "./player";
import { blurReach, blurSigma, grownBox, pixelate, redactBox, redactStrength } from "./redactions";
import styles from "./EditorApp.module.css";

interface Props {
  player: Player;
  /** The timeline's files, the first setting the picture's size. */
  sources: readonly SourceInfo[];
  /** The project's frame: the crop, and the space grown round it. */
  frame: Frame;
  /** Screen px per output px, and the stage's size on screen. */
  scale: number;
  width: number;
  height: number;
}

/** What the drawing reads, as rendered last. */
type Latest = Omit<Props, "player">;

/**
 * The redactions at the playhead (PLAN 4.8), over the picture and under the clip fades: each box
 * of the framed picture (the video on screen, a crossfade's incoming clip mixed in, the grown
 * space) drawn again at output size, pixelated or blurred, and laid back over it. Drawn when a
 * picture is presented, so it keeps up with the video, and when the edit or the markup changes.
 * The markup layer has only the boxes, clear, to select and move.
 */
export function RedactLayer(props: Props) {
  const { player } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  const latest = useRef<Latest>(props);
  const redraw = useRef(() => {});

  useEffect(() => {
    let queued = 0;
    const draw = () => {
      cancelAnimationFrame(queued);
      queued = 0;
      if (ref.current) drawRedactions(ref.current, latest.current, player);
    };
    /** Changes that aren't a picture: once, before the next paint. */
    const soon = () => {
      if (!queued) queued = requestAnimationFrame(draw);
    };
    redraw.current = soon;
    const stops = [
      // A picture presented: at once, so the redaction is over that very picture.
      player.onPicture(draw),
      player.subscribe(soon),
      markupDoc.subscribe(soon),
      useDoc.subscribe(soon),
    ];
    soon();
    return () => {
      cancelAnimationFrame(queued);
      for (const stop of stops) stop();
    };
  }, [player]);

  useLayoutEffect(() => {
    latest.current = props;
    redraw.current();
  });

  return <canvas ref={ref} className={styles.redactLayer} />;
}

/** Canvases reused from draw to draw: read back on the CPU (pixelate), or kept on the GPU (blur). */
const read = document.createElement("canvas");
const readG = read.getContext("2d", { willReadFrequently: true })!;
const work = document.createElement("canvas");
const workG = work.getContext("2d")!;
const padded = document.createElement("canvas");
const paddedG = padded.getContext("2d")!;
const blurred = document.createElement("canvas");
const blurredG = blurred.getContext("2d")!;

function sized(c: HTMLCanvasElement, width: number, height: number) {
  if (c.width !== width || c.height !== height) {
    c.width = width;
    c.height = height;
  } else c.getContext("2d")!.clearRect(0, 0, width, height);
}

function drawRedactions(canvas: HTMLCanvasElement, p: Latest, player: Player) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(p.width * dpr));
  const h = Math.max(1, Math.round(p.height * dpr));
  sized(canvas, w, h);
  canvas.style.width = `${p.width}px`;
  canvas.style.height = `${p.height}px`;
  const g = canvas.getContext("2d")!;
  const redactions = markupDoc
    .getState()
    .doc.annotations.filter((a): a is RedactAnnotation => a.kind === "redact");
  const shown = player.shownPicture();
  if (!redactions.length || !shown) return;
  const out = outputSize(p.frame);
  const s = p.scale * dpr;
  for (const a of redactions) {
    const box = redactBox(a.rect, out);
    if (!box) continue;
    const mode = a.mode === "pixelate" ? "pixelate" : "blur";
    const strength = redactStrength(mode, a.strength);
    if (mode === "pixelate") {
      sized(read, box.width, box.height);
      drawFramed(readG, box, p, player);
      const pixels = readG.getImageData(0, 0, box.width, box.height);
      pixelate(pixels.data, box.width, box.height, strength);
      readG.putImageData(pixels, 0, 0);
      g.imageSmoothingEnabled = false;
      g.drawImage(read, box.x * s, box.y * s, box.width * s, box.height * s);
      continue;
    }
    // Blur reads past the box as far as it reaches; at the frame's edge, its edge pixels go on.
    const reach = blurReach(strength);
    const region = grownBox(box, reach, out);
    sized(work, region.width, region.height);
    drawFramed(workG, region, p, player);
    sized(padded, region.width + 2 * reach, region.height + 2 * reach);
    extendEdges(paddedG, work, reach);
    sized(blurred, padded.width, padded.height);
    blurredG.filter = `blur(${blurSigma(strength)}px)`;
    blurredG.drawImage(padded, 0, 0);
    blurredG.filter = "none";
    g.imageSmoothingEnabled = true;
    g.drawImage(
      blurred,
      reach + box.x - region.x,
      reach + box.y - region.y,
      box.width,
      box.height,
      box.x * s,
      box.y * s,
      box.width * s,
      box.height * s,
    );
  }
}

/** `src` drawn `by` px in from `g`'s edges, its edge rows and columns stretched out to them. */
function extendEdges(g: CanvasRenderingContext2D, src: HTMLCanvasElement, by: number) {
  const { width: w, height: h } = src;
  g.imageSmoothingEnabled = false;
  g.drawImage(src, by, by);
  // Sides, then corners: [source x, y, w, h] stretched to [x, y, w, h].
  const strips: [number, number, number, number, number, number, number, number][] = [
    [0, 0, w, 1, by, 0, w, by],
    [0, h - 1, w, 1, by, by + h, w, by],
    [0, 0, 1, h, 0, by, by, h],
    [w - 1, 0, 1, h, by + w, by, by, h],
    [0, 0, 1, 1, 0, 0, by, by],
    [w - 1, 0, 1, 1, by + w, 0, by, by],
    [0, h - 1, 1, 1, 0, by + h, by, by],
    [w - 1, h - 1, 1, 1, by + w, by + h, by, by],
  ];
  for (const [sx, sy, sw, sh, dx, dy, dw, dh] of strips) {
    if (dw > 0 && dh > 0) g.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  }
}

/**
 * The framed picture's `region` (output px) drawn into `g` at 1:1, as the preview stacks it: the
 * grown space, then through the crop the picture (the video on top, upright; another file's
 * fitted in on black), then a crossfade's incoming clip, on black, as opaque as it's mixed in.
 */
function drawFramed(g: CanvasRenderingContext2D, region: Rect, p: Latest, player: Player) {
  const { crop, grow } = p.frame;
  const out = outputSize(p.frame);
  const first = p.sources[0];
  const shown = player.shownPicture();
  if (!first || !shown) return;
  g.save();
  g.setTransform(1, 0, 0, 1, -region.x, -region.y);
  // The grown space, as Preview.tsx lays it out.
  const inner = { x: grow.left, y: grow.top, width: crop.width, height: crop.height };
  g.fillStyle = growMode(grow) === "one" ? grow.colour : "#000";
  g.fillRect(0, 0, out.width, out.height);
  if (growMode(grow) !== "one") {
    for (const side of SIDES.filter((s) => grow[s] > 0)) {
      g.fillStyle = growColour(grow, side);
      g.fillRect(
        side === "right" ? inner.x + inner.width : 0,
        side === "bottom" ? inner.y + inner.height : 0,
        side === "left" || side === "right" ? grow[side] : out.width,
        side === "top" || side === "bottom" ? grow[side] : out.height,
      );
    }
  }
  // The picture, through the crop.
  g.beginPath();
  g.rect(inner.x, inner.y, inner.width, inner.height);
  g.clip();
  g.fillStyle = "#000";
  g.fillRect(inner.x, inner.y, inner.width, inner.height);
  g.translate(grow.left - crop.x, grow.top - crop.y);
  const picture = { width: first.width, height: first.height };
  const source = (id: string) => p.sources.find((s) => s.id === id);
  const on = source(shown.source);
  if (on) drawVideo(g, shown.video, shown.proxy, on, fitIn(on, first, picture));
  const mix = player.mix;
  const mixed = mix && source(mix.source);
  if (mix && mixed) {
    g.globalAlpha = mix.opacity;
    g.fillRect(0, 0, picture.width, picture.height);
    drawVideo(g, mix.video, false, mixed, fitIn(mixed, first, picture));
    g.globalAlpha = 1;
  }
  g.restore();
}

/**
 * A file's video drawn upright into `box`: the proxy is already; an original stored sideways
 * (WebView2 not honouring its rotation) is turned about the box's centre, as `videoTransform`
 * turns it on screen.
 */
function drawVideo(
  g: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  proxy: boolean,
  source: Size & { rotation: number },
  box: { left: number; top: number; width: number; height: number },
) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const sideways = source.rotation % 180 === 90;
  const turn = !proxy && sideways && vw !== vh && vw > vh !== source.width > source.height;
  if (!turn) {
    g.drawImage(video, box.left, box.top, box.width, box.height);
    return;
  }
  g.save();
  g.translate(box.left + box.width / 2, box.top + box.height / 2);
  g.rotate((source.rotation * Math.PI) / 180);
  g.drawImage(video, -box.height / 2, -box.width / 2, box.height, box.width);
  g.restore();
}
