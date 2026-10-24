import { useLayoutEffect, type RefObject } from "react";

/** What `squeeze` needs of a bar: its widths, and the attribute its CSS reads. */
interface Bar {
  scrollWidth: number;
  clientWidth: number;
  dataset: DOMStringMap;
}

/**
 * Sets the bar's `data-fit` to the least squeeze, from 0 (none) to `steps`, at which its
 * content fits its width (`steps` if none does), and returns it. Each step is a style in the
 * bar's CSS (labels dropped, buttons narrower...); every child must keep its width
 * (`flex-shrink: 0`) so that overflowing shows in `scrollWidth`.
 */
export function squeeze(bar: Bar, steps: number): number {
  let step = 0;
  for (; step <= steps; step++) {
    bar.dataset.fit = String(step);
    if (bar.scrollWidth <= bar.clientWidth) break;
  }
  return Math.min(step, steps);
}

/**
 * Keeps a bar squeezed just enough to fit (`squeeze`) as the window resizes and as buttons come
 * and go. It runs before the frame is painted, so the bar never shows cut off.
 */
export function useSqueeze(ref: RefObject<HTMLElement | null>, steps: number) {
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const fit = () => squeeze(bar, steps);
    fit();
    const resized = new ResizeObserver(fit);
    resized.observe(bar);
    // Buttons that appear with a selection; the text that changes (the readout) doesn't count.
    const changed = new MutationObserver(fit);
    changed.observe(bar, { childList: true, subtree: true });
    return () => {
      resized.disconnect();
      changed.disconnect();
    };
  }, [ref, steps]);
}
