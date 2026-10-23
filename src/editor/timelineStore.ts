// The timeline's zoom and scroll, shared by the timeline (wheel, Ctrl+0) and the status bar's
// zoom controls. The geometry is in timelineView.ts.
import { create } from "zustand";
import type { ClipId } from "./doc";
import {
  HEADER,
  clampScroll,
  fitted,
  follow,
  scrolled,
  sliderToZoom,
  zoomAt,
  zoomToSlider,
  type View,
} from "./timelineView";

interface TimelineState {
  view: View;
  /** The timeline's width in CSS pixels, and its length in frames. */
  width: number;
  frames: number;
  /** Fitted: it stays fitted as the window resizes. */
  isFitted: boolean;
  /** A drag is changing the timeline's length (a trim): the view keeps still until it ends. */
  held: boolean;
  /** Snapping (the status bar's toggle; Shift held turns it off for a moment). */
  snap: boolean;
  /** A clip lit up to show where it went (a duplicate or a paste), and when (ms). */
  flash: { id: ClipId; at: number } | null;
  /**
   * Files dragged over the clip row (PLAN 4.5e5): the cut they'd go in at (before clip `k`; the
   * clip count is the end), else null.
   */
  dropAt: number | null;
  /** The timeline was measured, or its length changed (an edit): fitted stays fitted. */
  setSize: (width: number, frames: number) => void;
  /** Holds the view still (a trim starts), or lets it fit the timeline again (it ends). */
  hold: (on: boolean) => void;
  toggleSnap: () => void;
  /** Lights clip `id` up for a moment. */
  flashClip: (id: ClipId) => void;
  setDropAt: (at: number | null) => void;
  fit: () => void;
  /** Zooms by `factor`, about `anchorX` (default: the middle). */
  zoomBy: (factor: number, anchorX?: number) => void;
  /** The slider: 0 to 1. */
  zoomTo: (t: number) => void;
  slider: () => number;
  /** Scrolls by `dx` pixels. */
  scrollBy: (dx: number) => void;
  /** Keeps frame `f` in view. */
  follow: (f: number) => void;
}

export const useTimeline = create<TimelineState>((set, get) => ({
  view: { zoom: 1, scroll: 0 },
  width: 0,
  frames: 0,
  isFitted: true,
  held: false,
  snap: true,
  flash: null,
  dropAt: null,

  setSize: (width, frames) => {
    const s = get();
    if (width === s.width && frames === s.frames) return;
    if (s.held) {
      set({ width, frames });
      return;
    }
    set({
      width,
      frames,
      view: s.isFitted ? fitted(width, frames) : clampScroll(s.view, width, frames),
    });
  },

  hold: (on) => {
    const s = get();
    if (on === s.held) return;
    set({
      held: on,
      view: on
        ? s.view
        : s.isFitted
          ? fitted(s.width, s.frames)
          : clampScroll(s.view, s.width, s.frames),
    });
  },

  toggleSnap: () => set({ snap: !get().snap }),
  flashClip: (id) => set({ flash: { id, at: performance.now() } }),
  setDropAt: (dropAt) => set({ dropAt }),

  fit: () => {
    const { width, frames } = get();
    set({ isFitted: true, view: fitted(width, frames) });
  },

  zoomBy: (factor, anchorX) => {
    const { view, width, frames } = get();
    const x = anchorX ?? (HEADER + width) / 2;
    set({ isFitted: false, view: zoomAt(view, view.zoom * factor, x, width, frames) });
  },

  zoomTo: (t) => {
    const { view, width, frames } = get();
    const zoom = sliderToZoom(t, width, frames);
    set({ isFitted: false, view: zoomAt(view, zoom, (HEADER + width) / 2, width, frames) });
  },

  slider: () => {
    const { view, width, frames } = get();
    return zoomToSlider(view.zoom, width, frames);
  },

  scrollBy: (dx) => {
    const { view, width, frames } = get();
    set({ isFitted: false, view: scrolled(view, dx, width, frames) });
  },

  follow: (f) => {
    const { view, width, frames } = get();
    const next = follow(view, f, width, frames);
    if (next !== view) set({ view: next });
  },
}));
