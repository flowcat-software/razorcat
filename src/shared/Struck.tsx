// An icon struck through when something is off (the recording's toggles: the microphone, system
// sound, clicks, keys). The icon is cut away along the slash, so the slash reads as on top of it
// rather than as part of the drawing, as Windows' own "off" icons do.

import { useId, type ReactNode } from "react";

/** The slash, top-left to bottom-right. */
const SLASH = "M4 4l16 16";

export function Struck({ off, children }: { off: boolean; children: ReactNode }) {
  // An id fit for `url(#…)` (React's ids carry characters it can't take).
  const id = `struck-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      {off && (
        <mask id={id}>
          <rect width="24" height="24" fill="#fff" />
          <path d={SLASH} fill="none" stroke="#000" strokeWidth="6" />
        </mask>
      )}
      <g mask={off ? `url(#${id})` : undefined}>{children}</g>
      {off && <path d={SLASH} fill="none" />}
    </svg>
  );
}
