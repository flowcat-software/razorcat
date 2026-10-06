// Approach B: WebCodecs. The packet index comes from Rust (ffprobe); packet bytes are fetched
// by range from media://; a VideoDecoder decodes; outputs are scaled to preview size as
// ImageBitmaps and kept in an LRU cache, so stepping back within a decoded GOP is free.
//
// Not handled (spike): rotation, GIF.

import {
  type Clip,
  type Media,
  type Player,
  type Presented,
  type Shown,
  fit,
  nextFrame,
  paced,
  readBarcode,
  sequence,
  sleep,
} from "./common";

const CACHE = 300;
const LOOKAHEAD = 4; // packets fed past the last needed one, to push out reordered frames
const FORWARD_RUN = 30;

const hex2 = (b: number) => b.toString(16).padStart(2, "0");

/** The codec string WebCodecs wants, from avcC / hvcC extradata. */
export function codecString(codec: string, ed: number[]): string {
  if (codec === "h264") return `avc1.${hex2(ed[1])}${hex2(ed[2])}${hex2(ed[3])}`;
  if (codec === "hevc") {
    const space = ["", "A", "B", "C"][ed[1] >> 6];
    const tier = (ed[1] >> 5) & 1 ? "H" : "L";
    const profile = ed[1] & 0x1f;
    let compat = ((ed[2] << 24) | (ed[3] << 16) | (ed[4] << 8) | ed[5]) >>> 0;
    let rev = 0;
    for (let i = 0; i < 32; i++) {
      rev = (rev << 1) | (compat & 1);
      compat >>>= 1;
    }
    const cons = ed.slice(6, 12);
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    const c = cons.map((b) => "." + b.toString(16)).join("");
    return `hvc1.${space}${profile}.${(rev >>> 0).toString(16)}.${tier}${ed[12]}${c}`;
  }
  throw new Error(`codec ${codec} not handled`);
}

export class CodecPlayer implements Player {
  readonly el = document.createElement("canvas");
  private ctx = this.el.getContext("2d")!;
  private decoder!: VideoDecoder;
  private config!: VideoDecoderConfig;
  private cache = new Map<number, ImageBitmap>();
  private usToN = new Map<number, number>();
  private keyAt: number[] = []; // decode index → decode index of the keyframe at or before it
  private fed = -1; // last decode index fed since the decoder was (re)configured
  private waiters = new Map<number, Array<() => void>>();
  private bitmaps = new Set<Promise<void>>();
  private last = -1;
  private resets = 0;
  private flushes = 0;
  private fetchedMB = 0;
  private decoded = 0;
  private size: { w: number; h: number };
  private error: string | null = null;

  constructor(private m: Media) {
    this.el.width = 960;
    this.el.height = 540;
    const f = fit(m.width, m.height);
    this.size = { w: f.w, h: f.h };
    const p = m.probe.packets;
    let key = 0;
    this.keyAt = p.map((pk, i) => (pk[4] ? (key = i) : key));
    m.pts.forEach((pts, n) => this.usToN.set(Math.round(pts * m.tb * 1e6), n));
  }

  private makeDecoder() {
    this.decoder?.state !== "closed" && this.decoder?.close();
    this.decoder = new VideoDecoder({
      output: (f) => this.output(f),
      error: (e) => (this.error = e.message),
    });
    this.decoder.configure(this.config);
    this.fed = -1;
  }

  async open() {
    const pr = this.m.probe;
    this.config = {
      codec: codecString(pr.codec, pr.extradata),
      description: new Uint8Array(pr.extradata),
      codedWidth: pr.width,
      codedHeight: pr.height,
      hardwareAcceleration: "prefer-hardware",
      optimizeForLatency: true,
    };
    const sup = await VideoDecoder.isConfigSupported(this.config);
    if (!sup.supported) throw new Error(`decoder config not supported: ${this.config.codec}`);
    this.makeDecoder();
    await this.show(0);
  }

  private output(frame: VideoFrame) {
    this.decoded++;
    const n = this.usToN.get(frame.timestamp);
    if (n === undefined || this.cache.has(n)) {
      frame.close();
      return;
    }
    const p = createImageBitmap(frame, {
      resizeWidth: this.size.w,
      resizeHeight: this.size.h,
      resizeQuality: "low",
    })
      .then((bm) => {
        this.put(n, bm);
        for (const w of this.waiters.get(n) ?? []) w();
        this.waiters.delete(n);
      })
      .finally(() => {
        frame.close();
        this.bitmaps.delete(p);
      });
    this.bitmaps.add(p);
  }

  private put(n: number, bm: ImageBitmap) {
    this.cache.set(n, bm);
    while (this.cache.size > CACHE) {
      const [old, obm] = this.cache.entries().next().value!;
      this.cache.delete(old);
      obm.close();
    }
  }

  private get(n: number) {
    const bm = this.cache.get(n);
    if (bm) {
      // LRU: move to the back.
      this.cache.delete(n);
      this.cache.set(n, bm);
    }
    return bm;
  }

  /** Decodes so that display frames [from, to] are in the cache. */
  private async ensure(from: number, to: number) {
    to = Math.min(to, this.m.count - 1);
    const missing: number[] = [];
    for (let n = from; n <= to; n++) if (!this.cache.has(n)) missing.push(n);
    if (!missing.length) return;
    const d = missing.map((n) => this.m.decodeIndex[n]);
    const dMin = Math.min(...d);
    const dMax = Math.max(...d);
    let start: number;
    if (this.fed >= 0 && dMin > this.fed && this.keyAt[dMin] <= this.fed + 1) {
      start = this.fed + 1; // carry on from where the decoder is
    } else {
      if (this.fed >= 0) {
        this.decoder.reset();
        this.decoder.configure(this.config);
        this.resets++;
      }
      start = this.keyAt[dMin];
    }
    const p = this.m.probe.packets;
    const end = Math.min(p.length - 1, dMax + LOOKAHEAD);
    if (end >= start) {
      const base = p[start][2];
      let lo = base;
      let hi = base;
      for (let i = start; i <= end; i++) {
        lo = Math.min(lo, p[i][2]);
        hi = Math.max(hi, p[i][2] + p[i][3]);
      }
      const res = await fetch(this.m.url, { headers: { Range: `bytes=${lo}-${hi - 1}` } });
      const buf = new Uint8Array(await res.arrayBuffer());
      this.fetchedMB += buf.length / 1048576;
      for (let i = start; i <= end; i++) {
        const [pts, , pos, size, key] = p[i];
        this.decoder.decode(
          new EncodedVideoChunk({
            type: key ? "key" : "delta",
            timestamp: Math.round(pts * this.m.tb * 1e6),
            data: buf.subarray(pos - lo, pos - lo + size),
          }),
        );
      }
      this.fed = end;
    }
    // Wait for the missing frames; flush if the decoder holds them back.
    const all = () => missing.every((n) => this.cache.has(n));
    const deadline = performance.now() + 3000;
    while (!all() && performance.now() < deadline) {
      if (this.decoder.decodeQueueSize === 0 && this.bitmaps.size === 0) {
        await sleep(4);
        if (!all() && this.decoder.decodeQueueSize === 0 && this.bitmaps.size === 0) {
          await this.decoder.flush();
          this.flushes++;
          this.fed = -1; // after a flush the next chunk must be a keyframe
          await Promise.all([...this.bitmaps]);
          break;
        }
      } else {
        await sleep(1);
      }
    }
  }

  private draw(n: number) {
    const bm = this.get(n)!;
    const f = fit(bm.width, bm.height);
    this.ctx.fillRect(0, 0, 960, 540);
    this.ctx.drawImage(bm, f.x, f.y, f.w, f.h);
    return bm;
  }

  async show(n: number): Promise<Shown> {
    const t0 = performance.now();
    if (!this.cache.has(n)) {
      if (n > this.last) await this.ensure(n, n + FORWARD_RUN);
      else await this.ensure(n, n);
    }
    this.last = n;
    if (!this.cache.has(n)) return { ms: performance.now() - t0, n: -1, read: null, timedOut: true };
    const bm = this.draw(n);
    await nextFrame();
    const ms = performance.now() - t0;
    return { ms, n, read: this.m.entry.barcode ? readBarcode(bm) : null };
  }

  async play(clips: Clip[], report: (p: Presented) => void) {
    const seq = sequence(clips);
    await this.show(seq[0]);
    let i = 0;
    let playing = true;
    // Decode ahead, one run at a time, staying inside a clip.
    const ahead = (async () => {
      while (playing) {
        let j = i;
        while (j < seq.length && j < i + 60 && this.cache.has(seq[j])) j++;
        if (j >= seq.length || j >= i + 60) {
          await sleep(2);
          continue;
        }
        let k = j;
        while (k + 1 < seq.length && k - j < FORWARD_RUN && seq[k + 1] === seq[k] + 1) k++;
        await this.ensure(seq[j], seq[k]);
      }
    })();
    await paced(this.m.fps, seq.length, (idx) => {
      i = idx;
      const n = seq[idx];
      if (!this.cache.has(n)) return; // late: counted as missing by the runner
      const bm = this.draw(n);
      report({ n, read: this.m.entry.barcode ? readBarcode(bm) : null, t: performance.now() });
    });
    playing = false;
    await ahead;
  }

  async close() {
    if (this.decoder.state !== "closed") this.decoder.close();
    for (const bm of this.cache.values()) bm.close();
    this.cache.clear();
    this.el.remove();
  }

  notes() {
    return {
      codec: this.config?.codec,
      resets: this.resets,
      flushes: this.flushes,
      fetchedMB: Math.round(this.fetchedMB),
      decoded: this.decoded,
      cached: this.cache.size,
      error: this.error,
    };
  }
}
