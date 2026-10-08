// The clip's thumbnails (thumbs.rs): read from Rust as they're made, kept as bitmaps for the
// timeline to draw. Thumbnail i is grid frame i * step.
import type { ThumbsInfo } from "../shared/ipc";

export class ThumbStrip {
  /** In order from the first: the strip fills in from the start. */
  readonly bitmaps: ImageBitmap[] = [];
  private loading = false;
  /** More were made while loading: load again after. */
  private again = false;
  private closed = false;

  constructor(
    private info: ThumbsInfo,
    /** Some were added: draw again. */
    private readonly added: () => void,
  ) {
    this.more(info);
  }

  get url() {
    return this.info.url;
  }

  /** Grid frames between thumbnails: thumbnail i is frame i * step. */
  get step() {
    return this.info.step;
  }

  /** Rust made more (or all of them). */
  more(info: ThumbsInfo) {
    this.info = info;
    if (this.loading) this.again = true;
    else void this.load();
  }

  close() {
    this.closed = true;
    for (const b of this.bitmaps) b.close();
    this.bitmaps.length = 0;
  }

  private async load() {
    this.loading = true;
    try {
      for (;;) {
        this.again = false;
        const { url, width, height } = this.info;
        const res = await fetch(`${url}/${this.bitmaps.length}`);
        if (this.closed || !res.ok) return;
        const bytes = await res.arrayBuffer();
        const size = width * height * 4;
        const n = Math.floor(bytes.byteLength / size);
        const made = await Promise.all(
          Array.from({ length: n }, (_, i) =>
            createImageBitmap(
              new ImageData(new Uint8ClampedArray(bytes, i * size, size), width, height),
            ),
          ),
        );
        if (this.closed) {
          made.forEach((b) => b.close());
          return;
        }
        this.bitmaps.push(...made);
        if (n) this.added();
        // None left that are made, unless more were meanwhile.
        if (!n && !this.again) return;
      }
    } catch (e) {
      console.warn("thumbnails:", e);
    } finally {
      this.loading = false;
    }
  }
}
