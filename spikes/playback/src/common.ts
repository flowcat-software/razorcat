// Shared pieces: the media's frame map, the barcode reader, the Player interface.

export interface MediaEntry {
  id: number;
  label: string;
  path: string;
  barcode: boolean;
}

/** [pts, dts, pos, size, key], in decode order. */
export type Packet = [number, number, number, number, boolean];

export interface Probe {
  codec: string;
  width: number;
  height: number;
  rotation: number;
  fpsNum: number;
  fpsDen: number;
  tbNum: number;
  tbDen: number;
  duration: number;
  audioTracks: number;
  extradata: number[];
  packets: Packet[];
  probeMs: number;
  indexCached: boolean;
}

export interface Clip {
  in: number; // first frame
  out: number; // one past the last frame
}

/** What a player reports when a frame reaches the screen. */
export interface Presented {
  n: number; // the frame the player believes it showed
  read: number | null; // the barcode, when the media has one
  t: number; // performance.now() at presentation
}

export interface Shown {
  ms: number; // request → on screen
  n: number;
  read: number | null;
  timedOut?: boolean;
}

export interface Player {
  readonly el: HTMLElement;
  open(): Promise<void>;
  show(n: number): Promise<Shown>;
  play(clips: Clip[], report: (p: Presented) => void): Promise<void>;
  close(): Promise<void>;
  /** Anything worth recording about the run (cache sizes, restarts…). */
  notes(): Record<string, unknown>;
}

/** A source's frames in display order. Frame n is the n-th frame shown, VFR or not. */
export class Media {
  readonly fps: number;
  readonly tb: number;
  readonly count: number;
  /** pts (in time base units) of display frame n */
  readonly pts: number[];
  /** decode index of display frame n */
  readonly decodeIndex: number[];
  /** display indices of keyframes */
  readonly keyframes: number[];
  readonly url: string;
  /** Size as displayed (after rotation). */
  readonly width: number;
  readonly height: number;

  constructor(
    readonly entry: MediaEntry,
    readonly probe: Probe,
  ) {
    this.fps = probe.fpsNum / probe.fpsDen;
    this.tb = probe.tbNum / probe.tbDen;
    const order = probe.packets.map((_, i) => i).sort((a, b) => probe.packets[a][0] - probe.packets[b][0]);
    this.pts = order.map((i) => probe.packets[i][0]);
    this.decodeIndex = order;
    this.count = order.length;
    this.keyframes = order.flatMap((d, n) => (probe.packets[d][4] ? [n] : []));
    this.url = `http://media.localhost/file/${entry.id}`;
    const rotated = Math.abs(probe.rotation) === 90;
    this.width = rotated ? probe.height : probe.width;
    this.height = rotated ? probe.width : probe.height;
  }

  /** Seconds from the first frame to frame n. */
  timeOf(n: number): number {
    return (this.pts[n] - this.pts[0]) * this.tb;
  }

  /** The frame on screen at media time t (seconds). */
  frameAt(t: number): number {
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.timeOf(mid) <= t + 1e-4) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

// --- the barcode (make-test-media.mjs): 16 cells along the bottom 1/16, LSB on the left.

const probeCanvas = new OffscreenCanvas(160, 90);
const probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true })!;

export function readBarcode(src: CanvasImageSource): number {
  probeCtx.drawImage(src, 0, 0, 160, 90);
  const row = probeCtx.getImageData(0, 87, 160, 1).data;
  let n = 0;
  for (let k = 0; k < 16; k++) {
    const x = Math.round((k + 0.5) * 10);
    const lum = row[x * 4] * 0.3 + row[x * 4 + 1] * 0.59 + row[x * 4 + 2] * 0.11;
    if (lum > 128) n |= 1 << k;
  }
  return n;
}

export function readBarcodeRgba(buf: Uint8ClampedArray, w: number, h: number): number {
  const y = Math.round(h - h / 32);
  let n = 0;
  for (let k = 0; k < 16; k++) {
    const x = Math.round(((k + 0.5) * w) / 16);
    const i = (y * w + x) * 4;
    const lum = buf[i] * 0.3 + buf[i + 1] * 0.59 + buf[i + 2] * 0.11;
    if (lum > 128) n |= 1 << k;
  }
  return n;
}

export const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fits w×h inside the stage, centred. */
export function fit(w: number, h: number, sw = 960, sh = 540) {
  const s = Math.min(sw / w, sh / h);
  const dw = Math.round(w * s);
  const dh = Math.round(h * s);
  return { x: (sw - dw) >> 1, y: (sh - dh) >> 1, w: dw, h: dh };
}

/** Runs a frame-paced playback loop: calls `frame(i)` for sequence index i on each display
 * refresh, at the media's frame rate, until the sequence ends. */
export function paced(fps: number, total: number, frame: (i: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let last = -1;
    const tick = (now: number) => {
      const i = Math.floor(((now - t0) / 1000) * fps);
      if (i >= total) return resolve();
      if (i !== last) {
        last = i;
        frame(i);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export function sequence(clips: Clip[]): number[] {
  return clips.flatMap((c) => Array.from({ length: c.out - c.in }, (_, k) => c.in + k));
}
