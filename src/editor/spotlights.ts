// The spotlights on the timeline (PLAN 4.5g). As in Vandal they cut holes in one dark layer, all
// as dark as each other (the last one made's, should they differ). On video the darkness is there
// on each unbroken stretch with a spotlight showing (a run). It fades in with the spotlights that
// start its run and out with those that end it, whose holes open and close with it; a spotlight
// coming or going in the middle of a run fades its hole instead, the darkness staying (Richard,
// 2026-10-23). The preview (markup/model/store.ts) and the export (exports.ts) both go by this.

import { markFades, markOpacity, shownMarks, type Doc, type MarkId } from "./doc";

/** Where something is on the timeline, frames `start` to `end` (exclusive), and its fades. */
export interface Faded {
  start: number;
  end: number;
  fadeIn: number;
  fadeOut: number;
}

export interface DarkLayer {
  /** How dark, in %. */
  dim: number;
  /** The runs, in order. */
  runs: Faded[];
  /** Each spotlight showing's hole: where it is, and its fades (none where it shares a run's). */
  holes: Map<MarkId, Faded>;
}

/** The spotlights' dark layer in `doc`; null if none shows. */
export function darkLayer(doc: Doc): DarkLayer | null {
  const spots = doc.marks.filter((m) => m.object.kind === "spotlight");
  const places = new Map(shownMarks(doc).map((m) => [m.id, m]));
  const shown = spots
    .flatMap((m) => {
      const place = places.get(m.id);
      if (!place) return [];
      const { start, end } = place;
      return [{ id: m.id, start, end, ...markFades(m, end - start) }];
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!shown.length) return null;
  const last = spots.reduce((a, b) => (b.id > a.id ? b : a)).object;
  const runs: Faded[] = [];
  const holes = new Map<MarkId, Faded>();
  let run: typeof shown = [];
  const close = () => {
    const start = run[0].start;
    const end = Math.max(...run.map((s) => s.end));
    const fades = markFades(
      {
        fadeIn: Math.max(...run.filter((s) => s.start === start).map((s) => s.fadeIn)),
        fadeOut: Math.max(...run.filter((s) => s.end === end).map((s) => s.fadeOut)),
      },
      end - start,
    );
    runs.push({ start, end, ...fades });
    for (const s of run) {
      holes.set(s.id, {
        start: s.start,
        end: s.end,
        fadeIn: s.start === start ? 0 : s.fadeIn,
        fadeOut: s.end === end ? 0 : s.fadeOut,
      });
    }
  };
  for (const s of shown) {
    // A gap ends a run; touching, the next spotlight carries it on.
    if (run.length && s.start > Math.max(...run.map((r) => r.end))) {
      close();
      run = [];
    }
    run.push(s);
  }
  close();
  return { dim: last.kind === "spotlight" ? last.dim : 0, runs, holes };
}

/** How opaque `f` is at timeline frame `frame` (0 off it). */
export function fadedAt(f: Faded, frame: number): number {
  if (frame < f.start || frame >= f.end) return 0;
  return markOpacity(f, f.end - f.start, frame - f.start);
}

/**
 * The dark layer at timeline frame `frame`: how far its darkness has faded in (0–1), and how open
 * each hole showing is. Null with no run there.
 */
export function darkAt(
  layer: DarkLayer,
  frame: number,
): { level: number; holes: Map<MarkId, number> } | null {
  const run = layer.runs.find((r) => r.start <= frame && frame < r.end);
  if (!run) return null;
  const holes = new Map<MarkId, number>();
  for (const [id, hole] of layer.holes) {
    if (hole.start <= frame && frame < hole.end) holes.set(id, fadedAt(hole, frame));
  }
  return { level: fadedAt(run, frame), holes };
}
