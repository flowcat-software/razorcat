// A recording's camera in the preview (PLAN 5d.4): its own video, round, on top of everything
// (Richard, 2026-10-27: markup and redactions go under it), where it was left while recording,
// on the finished frame (cameraPlace.ts). Shown while the playhead's clip is from a recording
// with a camera; faded with its clip.
//
// The camera's file is fitted to its recording (camera.rs), so its time is the recording's: it
// follows the video on screen (the player's, original or proxy), its time and its speed.
// Playing, both play from the browser's one clock (spike 5d.1: under 0.2 ms apart over a
// minute, silent; a video with sound plays by the sound's clock, a little apart); a little off,
// it's played 3% quicker or slower till it's caught up, and only sought again if it's well off
// (a cut that jumps). It waits while the player's video stops a moment at a cut. Paused or
// stepping, it's sought to the picture's time.
// Development builds log how far apart they played, and the frames dropped.

import { useEffect, useRef } from "react";
import type { SourceCamera, SourceInfo } from "../shared/ipc";
import { logLine } from "../shared/log";
import type { Square } from "./cameraPlace";
import { clipAt, clipOpacityAt } from "./doc";
import { useDoc } from "./docStore";
import type { Player } from "./player";
import { sourceFrame } from "./speed";
import styles from "./EditorApp.module.css";

/** Playing, how far (s) the camera may be from the picture before it's sought again. */
const FAR_OFF = 0.1;
/**
 * Playing, how far off (s) it's played quicker or slower (by `NUDGE`), and how near is close
 * enough again.
 */
const BEHIND = 0.01;
const NEAR = 0.003;
const NUDGE = 0.03;

interface Props {
  player: Player;
  /** The files open, with their cameras (by file id) and where each shows on the stage. */
  sources: readonly SourceInfo[];
  cameras: Readonly<Record<string, SourceCamera>>;
  places: Readonly<Record<string, Square>>;
  /** It fades with its clip (Settings › Recording); else it stays as the clip fades. */
  fades: boolean;
}

export function CameraLayer({ player, sources, cameras, places, fades }: Props) {
  const videos = useRef(new Map<string, HTMLVideoElement>());
  useEffect(() => {
    /** A stretch of playing, for the log: how far apart, and the camera's frames dropped. */
    let played: { apart: number[]; dropped: number; video: HTMLVideoElement } | null = null;
    const endPlayed = () => {
      if (!played || !import.meta.env.DEV) {
        played = null;
        return;
      }
      const apart = played.apart.map(Math.abs).sort((a, b) => a - b);
      const dropped = played.video.getVideoPlaybackQuality().droppedVideoFrames - played.dropped;
      if (apart.length > 10) {
        const ms = (v: number) => (v * 1000).toFixed(1);
        logLine(
          `[camera] played ${apart.length} pictures: apart median ${ms(apart[apart.length >> 1])} ms, ` +
            `max ${ms(apart[apart.length - 1])} ms; ${dropped} camera frames dropped`,
        );
      }
      played = null;
    };
    const update = () => {
      const { doc } = useDoc.getState();
      const { frame, speed } = player.getState();
      const at = clipAt(doc, frame);
      const on = at && cameras[at.clip.source] ? at.clip.source : null;
      for (const [id, v] of videos.current) {
        const wrap = v.parentElement;
        if (wrap) wrap.style.visibility = id === on ? "visible" : "hidden";
        if (id !== on && !v.paused) v.pause();
      }
      const v = on && videos.current.get(on);
      if (!at || !v) {
        endPlayed();
        return;
      }
      const opacity = fades ? clipOpacityAt(doc, frame) : 1;
      if (v.parentElement) v.parentElement.style.opacity = String(opacity);
      const shown = player.shownPicture();
      const master = shown?.source === on ? shown.video : null;
      // The picture's time; while its video moves on at a cut (seeking), the playhead's.
      const steady = master && !master.seeking && !master.paused;
      const time = steady
        ? master.currentTime
        : player.frameTime(on, sourceFrame(at.clip, at.clip.in + (frame - at.start)));
      if (time === null) return;
      if (speed > 0) {
        // The player's video stops a moment at a cut, moving on, and as it starts: the camera
        // waits with it (not sought: it's where the picture will go on from).
        if (!steady) {
          if (!v.paused) v.pause();
          return;
        }
        const rate = master.playbackRate;
        const apart = v.currentTime - time;
        // Well off (a cut that jumps, or it was stepped): sought.
        if (Math.abs(apart) > FAR_OFF) v.currentTime = time;
        if (v.paused) {
          v.playbackRate = rate;
          void v.play().catch(() => {});
          played ??= {
            apart: [],
            dropped: v.getVideoPlaybackQuality().droppedVideoFrames,
            video: v,
          };
          return;
        }
        // A little off: a little quicker or slower till it's caught up (seeking a playing video
        // stutters). Changed only as it crosses the bounds: each change of rate costs a moment.
        let k = v.playbackRate / rate;
        if (apart > BEHIND) k = 1 - NUDGE;
        else if (apart < -BEHIND) k = 1 + NUDGE;
        else if (Math.abs(apart) < NEAR || Math.abs(k - 1) > NUDGE * 2) k = 1;
        if (Math.abs(v.playbackRate - rate * k) > 1e-6) v.playbackRate = rate * k;
        played?.apart.push(apart);
        return;
      }
      endPlayed();
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - time) > 1e-4) v.currentTime = time;
    };
    update();
    const stopPlayer = player.subscribe(update);
    const stopPicture = player.onPicture(update);
    const stopDoc = useDoc.subscribe(update);
    const all = videos.current;
    return () => {
      stopPlayer();
      stopPicture();
      stopDoc();
      endPlayed();
      for (const v of all.values()) v.pause();
    };
  }, [player, cameras, fades]);

  return (
    <>
      {sources.map((s) => {
        const camera = cameras[s.id];
        const at = places[s.id];
        if (!camera || !at) return null;
        return (
          <div
            key={camera.url}
            className={styles.camera}
            style={{
              left: at.left,
              top: at.top,
              width: at.size,
              height: at.size,
              visibility: "hidden",
            }}
          >
            <video
              ref={(v) => {
                if (v) videos.current.set(s.id, v);
                else videos.current.delete(s.id);
              }}
              src={camera.url}
              preload="auto"
              muted
              playsInline
            />
          </div>
        );
      })}
    </>
  );
}
