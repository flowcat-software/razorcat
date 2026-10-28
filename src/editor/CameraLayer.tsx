// A recording's camera in the preview (PLAN 5d.4): its own video, round, on top of everything
// (Richard, 2026-10-27: markup and redactions go under it), where it was left while recording,
// on the finished frame (cameraPlace.ts), at its clip's size (PLAN 5d.6a). Shown while the
// playhead's clip is from a recording with a camera, placed as that clip says; faded with it.
// Dragged, it moves in that clip (PLAN 5d.6b), snapping to the gap from the picture's edges; it's
// picked as markup is (a press selects the camera, its controls in the timeline's options bar). While its camera's still being fitted to it
// (camera.rs: seconds a minute), where it'll be, a ring filling as it's fitted (PLAN 5d.5c).
//
// The camera's file is fitted to its recording (camera.rs), so its time is the recording's: it
// follows the video on screen (the player's, original or proxy), its time and its speed.
// Playing, both play from the browser's one clock (spike 5d.1: under 0.2 ms apart over a
// minute, silent; a video with sound plays by the sound's clock, a little apart); a little off,
// it's played 3% quicker or slower till it's caught up, and only sought again if it's well off
// (a cut that jumps). It waits while the player's video stops a moment at a cut. Paused or
// stepping, it's sought to the picture's time.
// Development builds log how far apart they played, and the frames dropped.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CameraFitting, SourceCamera, SourceInfo } from "../shared/ipc";
import { logLine } from "../shared/log";
import { useStyleConfig } from "../markup/styles";
import { stateOfPlace } from "./cameraKeys";
import { CAMERA_SIZE_NAMES, CAMERA_SIZES, movedPlace, type ShownCamera } from "./cameraPlace";
import { sizeCameraAt, useRecordedCameras } from "./cameraStore";
import { Menu, type MenuItems } from "./Menu";
import { clipAt, clipOpacityAt, type Clip } from "./doc";
import { useDoc } from "./docStore";
import { useTool } from "./toolStore";
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

/** The ring round a camera being fitted: its radius, of the circle's 100 (its stroke's in CSS). */
const RING = 43;

/** How far (CSS px) the pointer goes before a press on the camera is a drag. */
const DRAG_START = 3;
/** How near (CSS px) to an edge's gap a dragged camera snaps to it. */
const PULL = 10;

/** The tools that never pick it: the pen and highlighter draw (as over markup); crop and grow. */
const DRAWS_ALWAYS = new Set(["pen", "highlighter", "crop", "grow"]);

/** A drag of the camera: where it started, on which frame (its keyframe's). */
interface Drag {
  pointer: number;
  x: number;
  y: number;
  f: number;
  shown: ShownCamera;
  moved: boolean;
}

interface Props {
  player: Player;
  /** The files open, with their cameras (by file id). */
  sources: readonly SourceInfo[];
  cameras: Readonly<Record<string, SourceCamera>>;
  /** The cameras still being fitted (where they'll be, how far along), by file id. */
  fitting: Readonly<Record<string, CameraFitting>>;
  /** A clip's camera as the preview shows it on a frame (none: it has none, or it's hidden). */
  cameraOf: (clip: Clip, f: number) => ShownCamera | null;
  /** It fades with its clip (Settings › Editing); else it stays as the clip fades. */
  fades: boolean;
}

export function CameraLayer({ player, sources, cameras, fitting, cameraOf, fades }: Props) {
  const videos = useRef(new Map<string, HTMLVideoElement>());
  /** Each camera's circle (its video's, or its stand-in's while it's fitted), by file id. */
  const circles = useRef(new Map<string, HTMLDivElement>());
  // The latest, for `update` (the stage's size changes it; it's not re-subscribed for that).
  const shownOf = useRef(cameraOf);
  const updated = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    shownOf.current = cameraOf;
    updated.current();
  });
  const drag = useRef<Drag | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItems } | null>(null);
  useEffect(() => {
    /** Ctrl's held. */
    let ctrl = false;
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
      const camera =
        at && circles.current.has(at.clip.source) ? shownOf.current(at.clip, frame) : null;
      const on = at && camera ? at.clip.source : null;
      for (const [id, circle] of circles.current) {
        circle.style.visibility = id === on ? "visible" : "hidden";
      }
      // Where its clip puts it (each clip has its own size and place).
      const placed = on && circles.current.get(on);
      if (at && placed && camera) {
        const { left, top, size } = camera.square;
        placed.style.left = `${left}px`;
        placed.style.top = `${top}px`;
        placed.style.width = placed.style.height = `${size}px`;
        placed.style.fontSize = `${size * 0.075}px`;
        // Selected: outlined. Picked as markup is (MarkupLayer's `picksObjects`): always
        // with Select; the pen and highlighter draw; the other tools per Settings › Markup's
        // "Drawing tools select", Ctrl flipping it, so they can draw under it.
        placed.classList.toggle(styles.cameraSelected, useDoc.getState().cameraSelected);
        const { tool } = useTool.getState();
        const picks =
          tool === "select" ||
          (!DRAWS_ALWAYS.has(tool) && useStyleConfig.getState().drawingToolsSelect !== ctrl);
        placed.classList.toggle(styles.cameraGrabbable, picks);
      }
      for (const [id, v] of videos.current) {
        if (id !== on && !v.paused) v.pause();
      }
      const circle = on && circles.current.get(on);
      if (circle && camera) {
        circle.style.opacity = String((fades ? clipOpacityAt(doc, frame) : 1) * camera.opacity);
      }
      const v = on && videos.current.get(on);
      if (!at || !v) {
        endPlayed();
        return;
      }
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
    updated.current = update;
    const stopPlayer = player.subscribe(update);
    const stopPicture = player.onPicture(update);
    const stopDoc = useDoc.subscribe(update);
    const stopTool = useTool.subscribe(update);
    const stopStyles = useStyleConfig.subscribe(update);
    const stopFade = useRecordedCameras.subscribe(update);
    // Ctrl held flips whether a drawing tool picks it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Control" || ctrl === (e.type === "keydown")) return;
      ctrl = e.type === "keydown";
      update();
    };
    const letCtrlGo = () => {
      ctrl = false;
      update();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", letCtrlGo);
    const all = videos.current;
    return () => {
      stopPlayer();
      stopPicture();
      stopDoc();
      stopTool();
      stopStyles();
      stopFade();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", letCtrlGo);
      updated.current = () => {};
      endPlayed();
      for (const v of all.values()) v.pause();
    };
  }, [player, cameras, fitting, fades]);

  /** Keeps `id`'s circle, to show and fade. */
  const circle = (id: string) => (el: HTMLDivElement | null) => {
    if (el) circles.current.set(id, el);
    else circles.current.delete(id);
  };

  // Dragging it (PLAN 5d.6b): the camera's keyframe at the playhead moved, or one added there
  // (5d.8); the camera selected by the press. One undo step.
  const press = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const store = useDoc.getState();
    const f = player.getState().frame;
    const at = clipAt(store.doc, f);
    const shown = at && shownOf.current(at.clip, f);
    if (!at || !shown) return;
    e.preventDefault();
    e.stopPropagation();
    if (!store.cameraSelected) store.selectCamera();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, f, shown, moved: false };
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_START) return;
      d.moved = true;
      useDoc.getState().beginGesture();
    }
    const { place, picture, scale, state } = d.shown;
    if (scale <= 0) return;
    const to = movedPlace(place, dx / scale, dy / scale, picture, PULL / scale);
    useDoc.getState().setCamera(d.f, stateOfPlace(to, picture, state.size, false));
  };
  const letGo = (e: React.PointerEvent<HTMLDivElement>, keep: boolean) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) return;
    if (keep) useDoc.getState().endGesture();
    else useDoc.getState().cancelGesture();
  };
  // Right-clicked: its size at the playhead (a keyframe there). Shown or hidden is the options
  // bar's: hidden, there'd be nothing to right-click to show it again (Richard).
  const sizes = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const f = player.getState().frame;
    const at = clipAt(useDoc.getState().doc, f);
    const shown = at && shownOf.current(at.clip, f);
    if (!at || !shown) return;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: CAMERA_SIZES.map((k) => ({
        label: CAMERA_SIZE_NAMES[k],
        radio: true,
        checked: shown.state.size === k,
        run: () => {
          const to = sizeCameraAt(useDoc.getState().doc, f, at.clip, k);
          if (to) useDoc.getState().setCamera(f, to);
        },
      })),
    });
  };
  const grab = {
    onContextMenu: sizes,
    onPointerDown: press,
    onPointerMove: move,
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => letGo(e, true),
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => letGo(e, false),
  };

  return (
    <>
      {sources.map((s) => {
        const camera = cameras[s.id];
        const waiting = fitting[s.id];
        if (!camera && !waiting) return null;
        // Placed and shown by `update`, as the playhead's clip says.
        const square = { visibility: "hidden" as const };
        if (!camera) {
          // Being fitted: a ring filling round the inside of where it'll be, from the top.
          const done = Math.round(Math.min(1, Math.max(0, waiting.progress ?? 0)) * 100);
          return (
            <div
              key={`fitting-${s.id}`}
              ref={circle(s.id)}
              className={`${styles.camera} ${styles.cameraFitting}`}
              style={square}
              {...grab}
              role="progressbar"
              aria-label="Processing camera footage"
              aria-valuenow={done}
            >
              <svg className={styles.cameraFittingRing} viewBox="0 0 100 100" aria-hidden>
                <circle className={styles.cameraFittingTrack} cx="50" cy="50" r={RING} />
                {done > 0 && (
                  <circle
                    className={styles.cameraFittingDoneRing}
                    cx="50"
                    cy="50"
                    r={RING}
                    pathLength={100}
                    strokeDasharray={`${done} 100`}
                  />
                )}
              </svg>
              <div className={styles.cameraFittingText}>
                <span>Processing camera footage</span>
                <span className={styles.cameraFittingDone}>{done}%</span>
              </div>
            </div>
          );
        }
        return (
          <div
            key={camera.url}
            ref={circle(s.id)}
            className={styles.camera}
            style={square}
            {...grab}
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
      {menu &&
        createPortal(
          <Menu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />,
          document.body,
        )}
    </>
  );
}
