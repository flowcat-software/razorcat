// The preview's sound (PLAN 5a): how loud it plays, and whether it's muted, from the timeline
// bar's speaker and slider. The preview's only: the export isn't changed (the track's own mute,
// the red speaker on the timeline, is an edit, and mutes the export too). Kept in the settings
// (`playback`), so it's as it was next time; read from them once, at the start.

import { create } from "zustand";

interface PlaybackState {
  /** The slider, 0 to 1. */
  volume: number;
  muted: boolean;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
}

export const usePlayback = create<PlaybackState>()((set) => ({
  volume: 1,
  muted: false,
  setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)) }),
  setMuted: (muted) => set({ muted }),
}));

/**
 * How loud the sound plays for the slider at `volume`: on a curve, so the slider's travel is
 * spread over what's heard (loudness goes by the log of the level: a straight line puts most of
 * the change in its bottom quarter).
 */
export const playbackGain = (volume: number, muted: boolean) => (muted ? 0 : volume ** 2);
