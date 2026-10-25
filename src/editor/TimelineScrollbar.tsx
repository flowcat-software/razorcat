import { useRef } from "react";
import { hint } from "../markup/HintLine";
import { useTimeline } from "./timelineStore";
import { HEADER, scrollRange } from "./timelineView";
import styles from "./EditorApp.module.css";

/** The thumb's least width, px, so a long timeline zoomed far in can still be grabbed. */
const MIN_THUMB = 24;

/**
 * The timeline's scrollbar, along its bottom while zoomed in past fit (Richard, 2026-10-24): the
 * thumb is the part in view; drag it to scroll, or click the track to jump there (and drag on).
 */
export function TimelineScrollbar() {
  const view = useTimeline((s) => s.view);
  const width = useTimeline((s) => s.width);
  const frames = useTimeline((s) => s.frames);
  /** A drag: where it started (px) and the view's scroll then. */
  const drag = useRef<{ x: number; scroll: number } | null>(null);
  const range = scrollRange(view, width, frames);
  if (!range) return null;

  const { lo, hi, visible } = range;
  // Frames along the whole track: every place the view's left edge can be, and a view's worth.
  const span = hi - lo + visible;
  const trackW = width - HEADER;
  const thumbW = Math.max(MIN_THUMB, (visible / span) * trackW);
  // The thumb's travel, kept to the track when it's at its least width.
  const travel = trackW - thumbW;
  // A view zoomed past the limits (zooming at the pointer can) shows at the track's end.
  const left = Math.max(0, Math.min(travel, ((view.scroll - lo) / (hi - lo)) * travel));
  /** Frames a pixel of travel moves the view. */
  const perPx = travel > 0 ? (hi - lo) / travel : 0;

  return (
    <div
      className={styles.timelineScrollbar}
      style={{ left: HEADER }}
      {...hint("timelineScroll")}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
        let scroll = view.scroll;
        // On the track, not the thumb: the thumb's middle jumps there.
        if (x < left || x > left + thumbW) {
          scroll = lo + (x - thumbW / 2) * perPx;
          useTimeline.getState().scrollTo(scroll);
        }
        drag.current = { x: e.clientX, scroll };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) useTimeline.getState().scrollTo(d.scroll + (e.clientX - d.x) * perPx);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <div className={styles.timelineThumb} style={{ left, width: thumbW }} />
    </div>
  );
}
