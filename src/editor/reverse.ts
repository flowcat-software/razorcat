// Reversed renders (PLAN §7, Clip speed SP8): what the edit's reversed clips need, and how they
// play from them.
//
// A reversed clip's frames count through its source mirrored (speed.ts). Rust renders the
// stretch of the source it shows, plus a margin each side, back to front (reverse.rs): render
// frame k is source frame `to − 1 − k`, which is the clip's stream frame `mirror − to + k`. So a
// clip plays from a ready render forward, as a clip of another file (`playedClip`), with the
// forward mapping and every path built for it, in the preview and the export. Till its render is
// ready it plays by seeking (player.ts's soft play).
//
// Renders are asked for once the edit settles (`startReversals`), only where no render made or
// being made covers a clip's video: a trim or split within the margin needs none. One no clip
// needs any more is stopped.

import { create } from "zustand";
import { commands, events, type Reversed, type SourceInfo } from "../shared/ipc";
import type { ClipId, Doc, SourceId } from "./doc";
import { useDoc } from "./docStore";
import { isReversed, speedOf, videoEnd, videoStart, type Speed } from "./speed";

export interface Render extends Reversed {
  /** How far it's made, 0 to 1. */
  done: number;
}

interface ReverseState {
  /** The renders asked for, by id. */
  renders: Readonly<Record<string, Render>>;
  /** Why the last one failed, for the status bar (cleared once said). */
  failed: string | null;
  /** An export waits for renders (`waitForRenders`). */
  exportWaiting: boolean;
}

export const useReverse = create<ReverseState>(() => ({
  renders: {},
  failed: null,
  exportWaiting: false,
}));

/** How much more than a clip's video a render covers, each side, in seconds. */
const MARGIN_S = 2;
/** How long the edit must stay put before a render is asked for (a trim being dragged). */
const SETTLE_MS = 500;

/** The deck (player.ts) and export input a render plays as. */
export const deckOf = (id: string) => `reverse:${id}`;

/** What a clip as played needs: its file, frames, speed and direction. */
interface Timed {
  source: SourceId;
  in: number;
  out: number;
  speed?: Speed;
  phase?: number;
  sourceOut?: number;
  mirror?: number;
}

/** Whether render `r` covers clip `c`'s video. */
const covers = (r: Render, c: Timed) =>
  r.source === c.source && r.from <= videoStart(c) && videoEnd(c) <= r.to;

/** The ready render reversed clip `c` plays from, if there is one. */
export function readyFor(c: Timed, renders = useReverse.getState().renders): Render | null {
  if (!isReversed(c)) return null;
  return Object.values(renders).find((r) => r.ready && covers(r, c)) ?? null;
}

/**
 * Clip `c` as it plays: a reversed clip with a ready render, a forward clip of that render (its
 * frames renumbered so its phase stays below its speed's numerator, as a speed change leaves
 * it); else itself.
 */
export function playedClip<C extends Timed>(c: C, renders = useReverse.getState().renders): C {
  const r = readyFor(c, renders);
  if (!r) return c;
  const s = speedOf(c);
  // Render frame k is stream frame k + off.
  const off = c.mirror! - r.to;
  const p = (c.phase ?? 0) - off * s.den;
  const q = -Math.floor(p / s.num);
  const played: C = { ...c, source: deckOf(r.id), in: c.in - q, out: c.out - q };
  delete played.mirror;
  delete played.phase;
  delete played.sourceOut;
  const phase = p + q * s.num;
  if (phase) played.phase = phase;
  if (c.sourceOut !== undefined) played.sourceOut = c.sourceOut - off;
  return played;
}

/** The ready renders as files the preview shows, each in the shape of its source. */
export function renderSources(
  sources: readonly SourceInfo[],
  renders: Readonly<Record<string, Render>>,
): SourceInfo[] {
  return Object.values(renders).flatMap((r) => {
    const s = sources.find((k) => k.id === r.source);
    if (!r.ready || !s) return [];
    return [
      {
        ...s,
        id: deckOf(r.id),
        url: r.url,
        framesUrl: r.framesUrl,
        proxyUrl: null,
        // Made upright, the picture's shape.
        rotation: 0,
        converted: false,
        frames: r.to - r.from,
        thumbs: null,
        waveUrl: null,
      },
    ];
  });
}

/** The reversed clips' videos, as stretches of their sources: what renders must cover. */
function needed(doc: Doc) {
  return doc.clips
    .filter(isReversed)
    .map((c) => ({ id: c.id, clip: c, from: videoStart(c), to: videoEnd(c) }));
}

/** A reversed clip named by a render, for the status bar: the first one it covers. */
export function clipOf(r: Render, doc: Doc): number | null {
  return doc.clips.find((c) => isReversed(c) && covers(r, c))?.id ?? null;
}

/** Whether a stretch declined (cancelled or failed) covers clip `c`'s video. */
const isDeclined = (c: Timed) =>
  declined.some((d) => d.source === c.source && d.from <= videoStart(c) && videoEnd(c) <= d.to);

/**
 * Resolves once clips `ids` of `doc` (or all) that are reversed have their renders ready (PLAN §7,
 * Clip speed SP10: the export reads them); fails if one won't be made (stopped, or failed).
 */
export function waitForRenders(doc: Doc, ids?: readonly ClipId[]): Promise<void> {
  const pending = () =>
    doc.clips.filter((c) => (!ids || ids.includes(c.id)) && isReversed(c) && !readyFor(c));
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const done = () => {
      stop();
      useReverse.setState({ exportWaiting: false });
    };
    const check = () => {
      const left = pending();
      if (!left.length) {
        done();
        resolve();
        return true;
      }
      const stuck = left.find(isDeclined);
      if (!stuck) return false;
      done();
      reject(
        new Error(
          `clip ${stuck.id} isn't reversed yet (its reversing stopped). Reverse it again to export it.`,
        ),
      );
      return true;
    };
    if (check()) return;
    useReverse.setState({ exportWaiting: true });
    stop = useReverse.subscribe(() => void check());
  });
}

/** Stops render `id` (the status bar's Cancel): its clips play by seeking. */
export function cancelRender(id: string) {
  const r = useReverse.getState().renders[id];
  if (!r || r.ready) return;
  declined.push(r);
  void commands.cancelReverse(id);
  // An export waiting for it hears that it won't come.
  useReverse.setState({});
}

interface Stretch {
  source: SourceId;
  from: number;
  to: number;
}
const key = (s: Stretch) => `${s.source} ${s.from} ${s.to}`;
/** Stretches not to ask for again: cancelled, or failed. Forgotten when another clip is reversed. */
const declined: Stretch[] = [];

/**
 * Keeps the renders up with the edit: asks for what its reversed clips need once it settles,
 * stops what none needs, and follows Rust's progress. `rateOf` is a file's frames per second.
 * Returns the stop.
 */
export function startReversals(rateOf: (source: SourceId) => number | null): () => void {
  let timer = 0;
  let reversedClips = new Set<number>();
  let gone = false;
  const set = (fn: (r: Readonly<Record<string, Render>>) => Record<string, Render>) =>
    useReverse.setState((s) => ({ renders: fn(s.renders) }));

  const settle = () => {
    timer = 0;
    const { doc } = useDoc.getState();
    const { renders } = useReverse.getState();
    const needs = needed(doc);
    // Another clip reversed: what was cancelled may be wanted now.
    if (needs.some((n) => !reversedClips.has(n.id))) declined.length = 0;
    reversedClips = new Set(needs.map((n) => n.id));
    for (const n of needs) {
      if (Object.values(renders).some((r) => covers(r, n.clip))) continue;
      const fps = rateOf(n.clip.source);
      const frames = doc.sources.find((s) => s.id === n.clip.source)?.frames;
      if (!fps || frames === undefined) continue;
      const margin = Math.round(MARGIN_S * fps);
      const from = Math.max(0, n.from - margin);
      const to = Math.min(frames, n.to + margin);
      const source = n.clip.source;
      if (declined.some((d) => d.source === source && d.from <= n.from && n.to <= d.to)) continue;
      // Asked for already, its answer on the way.
      const k = key({ source, from, to });
      if (asking.has(k)) continue;
      asking.add(k);
      void commands.reverseRender(n.clip.source, from, to).then((res) => {
        asking.delete(k);
        if (gone) return;
        if (res.status === "error") {
          declined.push({ source, from, to });
          useReverse.setState({ failed: res.error });
          return;
        }
        set((rs) => ({ ...rs, [res.data.id]: { ...res.data, done: res.data.ready ? 1 : 0 } }));
      });
    }
    // Those still being made that no clip needs.
    for (const r of Object.values(useReverse.getState().renders)) {
      if (!r.ready && !needs.some((n) => covers(r, n.clip))) void commands.cancelReverse(r.id);
    }
  };
  const asking = new Set<string>();
  const later = () => {
    clearTimeout(timer);
    timer = window.setTimeout(settle, SETTLE_MS);
  };
  const stopDoc = useDoc.subscribe((s, before) => {
    if (s.doc !== before.doc) later();
  });
  // Asked for at once when the page opens on an edit.
  settle();
  const listening = Promise.all([
    events.reverseProgress.listen(({ payload }) =>
      set((rs) => {
        const r = rs[payload.id];
        return r && !r.ready ? { ...rs, [payload.id]: { ...r, done: payload.done ?? 0 } } : rs;
      }),
    ),
    events.reverseReady.listen(({ payload }) =>
      set((rs) => ({ ...rs, [payload.render.id]: { ...payload.render, done: 1 } })),
    ),
    events.reverseEnded.listen(({ payload }) => {
      const r = useReverse.getState().renders[payload.id];
      if (r && payload.message) declined.push(r);
      set((rs) => {
        const rest = { ...rs };
        delete rest[payload.id];
        return rest;
      });
      if (payload.message) useReverse.setState({ failed: payload.message });
    }),
  ]);
  return () => {
    gone = true;
    clearTimeout(timer);
    stopDoc();
    void listening.then((stops) => stops.forEach((stop) => stop()));
  };
}
