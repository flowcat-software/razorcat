// Approach C: Rust decodes. Frames are raw RGBA at preview width from media://frame/…,
// decoded by an ffmpeg process that Rust keeps running (frames.rs).

import {
  type Clip,
  type Media,
  type Player,
  type Presented,
  type Shown,
  nextFrame,
  paced,
  readBarcodeRgba,
  sequence,
} from "./common";

interface Frame {
  img: ImageData;
  rustMs: number;
  restarts: number;
}

export class RustPlayer implements Player {
  readonly el = document.createElement("canvas");
  private ctx = this.el.getContext("2d")!;
  private last = -1;
  private restarts = 0;
  private rustMs: number[] = [];
  private fetchMs: number[] = [];

  constructor(
    private m: Media,
    private hw: boolean,
    private width = 960,
  ) {}

  private async fetchFrame(n: number): Promise<Frame> {
    const t0 = performance.now();
    const res = await fetch(`http://media.localhost/frame/${this.m.entry.id}/${n}?w=${this.width}&hw=${this.hw ? 1 : 0}`);
    if (!res.ok) throw new Error(await res.text());
    const w = Number(res.headers.get("x-width"));
    const h = Number(res.headers.get("x-height"));
    const buf = new Uint8ClampedArray(await res.arrayBuffer());
    const rustMs = Number(res.headers.get("x-ms"));
    this.restarts = Number(res.headers.get("x-restarts"));
    this.rustMs.push(rustMs);
    this.fetchMs.push(performance.now() - t0);
    return { img: new ImageData(buf, w, h), rustMs, restarts: this.restarts };
  }

  private draw(f: Frame) {
    if (this.el.width !== f.img.width || this.el.height !== f.img.height) {
      this.el.width = f.img.width;
      this.el.height = f.img.height;
    }
    this.ctx.putImageData(f.img, 0, 0);
  }

  private read(f: Frame) {
    return this.m.entry.barcode ? readBarcodeRgba(f.img.data, f.img.width, f.img.height) : null;
  }

  async open() {
    await fetch("http://media.localhost/reset");
    await this.show(0);
  }

  async show(n: number): Promise<Shown> {
    const t0 = performance.now();
    const f = await this.fetchFrame(n);
    this.draw(f);
    await nextFrame();
    this.last = n;
    return { ms: performance.now() - t0, n, read: this.read(f) };
  }

  async play(clips: Clip[], report: (p: Presented) => void) {
    const seq = sequence(clips);
    await this.show(seq[0]);
    const ready = new Map<number, Frame>();
    let i = 0;
    let playing = true;
    // Fetch ahead, in order, so the decoder session only moves forward.
    const ahead = (async () => {
      let j = 1;
      while (playing && j < seq.length) {
        // Fallen behind the clock: skip to just ahead of it (frames are dropped, not queued).
        if (j <= i) j = i + 3;
        if (j >= seq.length) break;
        if (j - i > 20) {
          await new Promise((r) => setTimeout(r, 2));
          continue;
        }
        ready.set(j, await this.fetchFrame(seq[j]));
        j++;
      }
    })();
    await paced(this.m.fps, seq.length, (idx) => {
      i = idx;
      // Show the newest frame that has arrived (late ones are dropped, as a player would).
      let best = -1;
      for (const k of ready.keys()) if (k <= idx && k > best) best = k;
      if (best < 0) return;
      const f = ready.get(best)!;
      for (const k of [...ready.keys()]) if (k <= best) ready.delete(k);
      this.draw(f);
      report({ n: seq[best], read: this.read(f), t: performance.now() });
    });
    playing = false;
    await ahead;
    this.last = seq[seq.length - 1];
  }

  async close() {
    await fetch("http://media.localhost/reset");
    this.el.remove();
  }

  notes() {
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1] ?? null;
    return {
      ffmpegSessions: this.restarts,
      rustMsMedian: med(this.rustMs),
      fetchMsMedian: med(this.fetchMs),
      frames: this.rustMs.length,
      last: this.last,
    };
  }
}
