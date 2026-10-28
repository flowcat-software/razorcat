import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { MarkupDrawing } from "../markup/MarkupDrawing";
import { MarkupLayer } from "../markup/MarkupLayer";
import { connectMarkup } from "../markup/model/store";
import type { CameraFitting, SourceCamera, SourceInfo } from "../shared/ipc";
import { CameraLayer } from "./CameraLayer";
import { cameraShownAt, keyAt, placeOf } from "./cameraKeys";
import { cameraOnStage, type ShownCamera } from "./cameraPlace";
import { useRecordedCameras } from "./cameraStore";
import { CropOverlay } from "./CropOverlay";
import {
  clipFadeColourAt,
  clipOpacityAt,
  clipStarts,
  crossfadeAt,
  crossfadeMix,
  crossfades,
  type Clip,
  type Doc,
} from "./doc";
import { useDoc } from "./docStore";
import { fitIn, fitRect, videoTransform } from "./fit";
import { growColour, growMode, NO_GROW, outputSize, SIDES } from "./frame";
import { GrowOverlay } from "./GrowOverlay";
import { RedactLayer } from "./RedactLayer";
import type { Player } from "./player";
import { playbackRate, sourceFrame } from "./speed";
import { useTool } from "./toolStore";
import styles from "./EditorApp.module.css";

interface Props {
  /** The timeline's files, first first: the first sets the picture's size (PLAN 4.5e). */
  sources: readonly SourceInfo[];
  /** Drives the videos (player.ts). */
  player: Player;
  /** Each file's proxy, once it's ready (proxy.rs), by its id. */
  proxyUrls: Readonly<Record<string, string | null>>;
  /** The cameras recorded with files, once found (camera.rs), by file id. */
  cameras: Readonly<Record<string, SourceCamera>>;
  /** The cameras still being fitted to their recordings (camera.rs), by file id. */
  fitting: Readonly<Record<string, CameraFitting>>;
  /** The cameras fade with their clips (Settings › Editing). */
  cameraFades: boolean;
  /** A picture can't be shown, even from a converted copy. */
  onError: (message: string) => void;
  /** A file's original can't be played here (its codec): convert it (convert.rs). */
  onUnplayable: (source: SourceInfo) => void;
}

/** Space kept around the picture, in px. */
const MARGIN = 16;

/**
 * The picture: the playhead's file's `<video>` (each file has its own, the others hidden; one of
 * another shape fitted in, the rest black), cropped, with the space grown round it, fitted into
 * the preview (CSS only, so it follows live, also while playing). The crop tool shows the whole
 * picture, ungrown, with the crop box over it; the grow tool, the frame with its handles.
 * Markup sits over the whole frame (Vandal's markup layer, over the whole preview so its handles
 * reach past the frame): what's at the playhead, which the select and markup tools edit. Under
 * it, the clips' fades: black over the whole frame (`ClipFade`); under those, the redactions
 * (RedactLayer.tsx), which work on the picture. Over everything, a recording's camera
 * (CameraLayer.tsx).
 */
export function Preview({
  sources,
  player,
  proxyUrls,
  cameras,
  fitting,
  cameraFades,
  onError,
  onUnplayable,
}: Props) {
  const source = sources[0];
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const onScreen = useSyncExternalStore(player.subscribe, () => player.getState().source);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => setArea({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The markup shows what's at the playhead.
  useEffect(() => connectMarkup(player), [player]);

  const frame = useDoc((s) => s.doc.frame);
  const recorded = useRecordedCameras((s) => s.cameras);
  const tool = useTool((s) => s.tool);
  const held = useTool((s) => s.held);
  const cropping = tool === "crop";
  const whole = { x: 0, y: 0, width: source.width, height: source.height };
  // What shows: the crop and the grow, or the whole picture alone to crop it.
  const shown = cropping ? whole : frame.crop;
  const grow = cropping ? NO_GROW : frame.grow;
  const out = cropping ? whole : outputSize(frame);
  const fitted = fitRect(area, out, MARGIN);
  // A grow handle held: the picture stays put at its scale, the frame grows round it.
  const scale = held?.scale ?? (out.width > 0 ? fitted.width / out.width : 0);
  const inner = {
    x: grow.left * scale,
    y: grow.top * scale,
    width: shown.width * scale,
    height: shown.height * scale,
  };
  const stage = held
    ? {
        x: held.x - inner.x,
        y: held.y - inner.y,
        width: out.width * scale,
        height: out.height * scale,
      }
    : fitted;
  // The whole picture at that scale, placed so the crop fills its place (inner).
  const picture = {
    left: -shown.x * scale,
    top: -shown.y * scale,
    width: source.width * scale,
    height: source.height * scale,
  };
  // A clip's camera on the finished frame at timeline frame `f` (being fitted, where it'll
  // be): as the keyframes say (PLAN 5d.8), faded at them (5d.9), or before any, as it was
  // recorded; hidden, none. Paused on a keyframe, as that keyframe sets it, whole: a fade starts
  // there with the old place, so it's what's being changed that shows to drag or resize.
  const cameraOf = (clip: Clip, f: number): ShownCamera | null => {
    const s = sources.find((x) => x.id === clip.source);
    const rec = recorded[clip.source];
    if (!s || !rec) return null;
    const { doc } = useDoc.getState();
    const { fade } = useRecordedCameras.getState();
    const key = player.getState().speed === 0 ? keyAt(doc, f) : null;
    const { state, opacity } = (key && { state: key, opacity: 1 }) ??
      cameraShownAt(doc, f, fade) ?? { state: rec.state, opacity: 1 };
    if (state.hidden) return null;
    const place = placeOf(state, s);
    const shownAt = { ...picture, left: inner.x + picture.left, top: inner.y + picture.top };
    return {
      square: cameraOnStage(place, s, source, shownAt, {
        width: stage.width,
        height: stage.height,
      }),
      state,
      place,
      picture: s,
      scale: s.width > 0 ? fitIn(s, source, shownAt).width / s.width : 0,
      opacity,
    };
  };
  const one = growMode(grow) === "one";
  // The grown sides (one colour: the frame's background).
  const sides = one
    ? []
    : SIDES.filter((s) => grow[s] > 0).map((s) => ({
        side: s,
        colour: growColour(grow, s),
        rect: {
          left: s === "right" ? inner.x + inner.width : 0,
          top: s === "bottom" ? inner.y + inner.height : 0,
          width: s === "left" || s === "right" ? grow[s] * scale : stage.width,
          height: s === "top" || s === "bottom" ? grow[s] * scale : stage.height,
        },
      }));

  return (
    <div ref={areaRef} className={styles.previewArea}>
      <div
        className={styles.stage}
        style={{
          left: stage.x,
          top: stage.y,
          width: stage.width,
          height: stage.height,
          background: one ? grow.colour : undefined,
        }}
      >
        {sides.map(({ side, colour, rect }) => (
          <div key={side} className={styles.growSide} style={{ ...rect, background: colour }} />
        ))}
        <div
          className={styles.window}
          style={{ left: inner.x, top: inner.y, width: inner.width, height: inner.height }}
        >
          <div className={styles.picture} style={picture}>
            {sources.map((s) => (
              <Deck
                key={s.id}
                source={s}
                box={fitIn(s, source, picture)}
                shown={s.id === onScreen}
                player={player}
                proxyUrl={proxyUrls[s.id] ?? null}
                onError={onError}
                onUnplayable={onUnplayable}
              />
            ))}
            <CrossfadeMix sources={sources} first={source} picture={picture} player={player} />
          </div>
        </div>
        {!cropping && (
          <RedactLayer
            player={player}
            sources={sources}
            frame={frame}
            scale={scale}
            width={stage.width}
            height={stage.height}
          />
        )}
        {!cropping && <ClipFade player={player} />}
      </div>
      {/* Every item, out of sight, for the export to draw from. */}
      <MarkupDrawing />
      {!cropping && (
        <MarkupLayer
          width={area.width}
          height={area.height}
          scale={scale}
          offset={{ x: stage.x, y: stage.y }}
          interactive={tool !== "grow"}
          // Resized boxes snap to the frame's edges, and the picture's in a grown frame.
          snapTo={{
            x: [0, grow.left, grow.left + shown.width, out.width],
            y: [0, grow.top, grow.top + shown.height, out.height],
          }}
        />
      )}
      {!cropping && (
        <div
          className={styles.cameraLayer}
          style={{ left: stage.x, top: stage.y, width: stage.width, height: stage.height }}
        >
          <CameraLayer
            player={player}
            sources={sources}
            cameras={cameras}
            fitting={fitting}
            cameraOf={cameraOf}
            fades={cameraFades}
          />
        </div>
      )}
      {tool === "grow" && (
        <div
          className={styles.overStage}
          style={{ left: stage.x, top: stage.y, width: stage.width, height: stage.height }}
        >
          <GrowOverlay
            grow={grow}
            picture={inner}
            scale={scale}
            at={{ x: stage.x + inner.x, y: stage.y + inner.y }}
          />
        </div>
      )}
      {cropping && (
        // Over the stage, not in it: the handles reach past the picture's edges.
        <div
          className={styles.overStage}
          style={{ left: stage.x, top: stage.y, width: stage.width, height: stage.height }}
        >
          <CropOverlay crop={frame.crop} source={source} scale={scale} />
        </div>
      )}
    </div>
  );
}

/**
 * The clips' fades (PLAN 4.7a): black (or the fade's colour, 4.7c) over the whole frame, as opaque as the picture under the
 * playhead is faded (`clipOpacityAt`, the export's ramp), and the sound as loud as the picture
 * shows (in a crossfade, the outgoing clip's as much as it's left: `CrossfadeMix`). Set straight
 * on the element as the playhead moves, not re-rendered.
 */
function ClipFade({ player }: { player: Player }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => {
      const { doc } = useDoc.getState();
      const { frame } = player.getState();
      const shows = clipOpacityAt(doc, frame);
      if (ref.current) {
        ref.current.style.opacity = String(1 - shows);
        ref.current.style.background = clipFadeColourAt(doc, frame);
      }
      const xf = crossfadeAt(doc, frame);
      player.setLevel(shows * (xf ? 1 - crossfadeMix(xf.k, xf.length) : 1));
    };
    update();
    const stopPlayer = player.subscribe(update);
    const stopDoc = useDoc.subscribe(update);
    return () => {
      stopPlayer();
      stopDoc();
      player.setLevel(1);
    };
  }, [player]);
  return <div ref={ref} className={styles.clipFade} />;
}

/**
 * A crossfade's incoming clip (PLAN 4.7b), over the outgoing one the player shows: a second video
 * of each file (the outgoing clip is often from the same one), in the picture as its deck is,
 * on black (fitted in, the rest black, as the export pads it), as opaque as it's mixed in
 * (`crossfadeMix`, the export's `xfade`), its sound as loud. Set straight on the elements as the
 * playhead moves.
 *
 * Paused or stepping, it's sought to the exact frame. Playing, it's made ready a second ahead:
 * sought to the incoming clip's first frame and held there, so the crossfade only has to start
 * it; then it plays along, sought again only if it falls well behind (seeking a playing video
 * stutters). At the crossfade's end the player moves its own video on to the incoming clip,
 * which takes a seek when both are from one file: till its picture's there, this one stays on
 * top, all of it, playing on (Richard, 2026-10-23: playing across a crossfade stuttered).
 */
function CrossfadeMix({
  sources,
  first,
  picture,
  player,
}: {
  sources: readonly SourceInfo[];
  first: SourceInfo;
  picture: { width: number; height: number };
  player: Player;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const videos = useRef(new Map<string, HTMLVideoElement>());
  useEffect(() => {
    /** The video showing (its file), and the clip it's playing or held ready for. */
    let on: string | null = null;
    let ready: { source: string; time: number } | null = null;
    let handing: { source: string } | null = null;
    const show = (source: string | null, opacity: number) => {
      if (wrap.current) wrap.current.style.opacity = String(opacity);
      // For what's drawn from the picture (RedactLayer.tsx).
      const video = source && videos.current.get(source);
      player.setMix(video && opacity > 0 ? { source, video, opacity } : null);
      if (source === on) return;
      on = source;
      for (const [id, v] of videos.current) {
        const deck = v.parentElement;
        if (deck) deck.style.visibility = id === source ? "visible" : "hidden";
      }
    };
    const pauseOthers = (keep: string | null) => {
      for (const [id, v] of videos.current) if (id !== keep && !v.paused) v.pause();
    };
    const update = () => {
      const { doc } = useDoc.getState();
      const { frame, speed } = player.getState();
      const fps = player.fps;
      const at = crossfadeAt(doc, frame);
      const v = at && videos.current.get(at.clip.source);
      const time = at && player.frameTime(at.clip.source, sourceFrame(at.clip, at.clip.in + at.k));
      if (at && v && time !== null) {
        handing = null;
        pauseOthers(at.clip.source);
        const mix = crossfadeMix(at.k, at.length);
        show(at.clip.source, mix);
        if (speed > 0) {
          // Started from where it was held ready, or sought if it's well off.
          const off = Math.abs(v.currentTime - time);
          if (v.paused ? off > 1.5 / fps : off > 0.25) v.currentTime = time;
          v.playbackRate = playbackRate(at.clip, speed);
          v.preservesPitch = player.keepPitch;
          v.muted = doc.muted || !!at.clip.muted;
          v.volume = mix * player.gain;
          if (v.paused) void v.play().catch(() => {});
          ready = { source: at.clip.source, time };
        } else {
          if (!v.paused) v.pause();
          v.muted = true;
          if (ready?.source !== at.clip.source || ready.time !== time) v.currentTime = time;
          ready = { source: at.clip.source, time };
        }
        return;
      }
      // Just past a crossfade, playing, its video playing: on top till the player's own video
      // shows the clip (it's moving on to it, `crossing`).
      if (speed > 0 && on && player.crossingCut && (handing || ready?.source === on)) {
        const h = videos.current.get(on);
        if (h && !h.paused) {
          handing = { source: on };
          h.volume = player.gain;
          show(on, 1);
          return;
        }
      }
      handing = null;
      show(null, 0);
      // Playing towards a crossfade: its video held at the incoming clip's first frame.
      const next = speed > 0 ? upcoming(doc, frame, fps) : null;
      const nv = next && videos.current.get(next.source);
      const nt = next && player.frameTime(next.source, sourceFrame(next, next.in));
      pauseOthers(null);
      if (next && nv && nt !== null && (ready?.source !== next.source || ready.time !== nt)) {
        nv.muted = true;
        nv.currentTime = nt;
        ready = { source: next.source, time: nt };
      }
    };
    update();
    const stopPlayer = player.subscribe(update);
    const stopDoc = useDoc.subscribe(update);
    const all = videos.current;
    return () => {
      stopPlayer();
      stopDoc();
      for (const v of all.values()) v.pause();
      player.setMix(null);
    };
  }, [player]);
  return (
    <div ref={wrap} className={styles.crossfadeMix} style={{ opacity: 0 }}>
      {sources.map((s) => (
        <MixVideo
          key={s.id}
          source={s}
          box={fitIn(s, first, picture)}
          onVideo={(v) => {
            if (!v) {
              videos.current.delete(s.id);
              return;
            }
            videos.current.set(s.id, v);
            // Its pictures, while it's mixed in, change what's drawn from the picture (once per
            // video: the ref is called again on every render).
            if (presenting.has(v)) return;
            presenting.add(v);
            const presented = () => {
              if (!v.isConnected) {
                presenting.delete(v);
                return;
              }
              if (player.mix?.video === v) player.pictured();
              v.requestVideoFrameCallback(presented);
            };
            v.requestVideoFrameCallback(presented);
          }}
        />
      ))}
    </div>
  );
}

/** The crossfade videos whose pictures are being watched (`CrossfadeMix`). */
const presenting = new WeakSet<HTMLVideoElement>();

/** The incoming clip of the next crossfade within a second after timeline frame `f`, if any. */
function upcoming(doc: Doc, f: number, fps: number) {
  const xf = crossfades(doc);
  const starts = clipStarts(doc);
  const i = starts.findIndex((s, k) => xf[k] > 0 && s > f && s - f <= fps);
  return i < 0 ? null : doc.clips[i];
}

/** One file's video for `CrossfadeMix`: placed and turned as its deck's is (`Deck`). */
function MixVideo({
  source,
  box,
  onVideo,
}: {
  source: SourceInfo;
  box: { left: number; top: number; width: number; height: number };
  onVideo: (v: HTMLVideoElement | null) => void;
}) {
  const [measured, setMeasured] = useState<{ url: string; width: number; height: number } | null>(
    null,
  );
  const natural = measured?.url === source.url ? measured : null;
  const transform = natural ? videoTransform(natural, source, box) : null;
  return (
    // Shown by `CrossfadeMix`, straight on the element.
    <div className={styles.deck} style={{ ...box, visibility: "hidden" }}>
      <video
        key={source.url}
        ref={onVideo}
        className={styles.video}
        src={source.url}
        crossOrigin="anonymous"
        preload="auto"
        muted
        style={
          transform
            ? { width: transform.width, height: transform.height, transform: transform.css }
            : { visibility: "hidden" }
        }
        onLoadedMetadata={(e) => {
          const { videoWidth: width, videoHeight: height } = e.currentTarget;
          if (width > 0) setMeasured({ url: source.url, width, height });
        }}
      />
    </div>
  );
}

interface DeckProps {
  source: SourceInfo;
  /** Its place in the picture. */
  box: { left: number; top: number; width: number; height: number };
  /** The playhead's file: on screen (the others wait, hidden). */
  shown: boolean;
  player: Player;
  proxyUrl: string | null;
  onError: (message: string) => void;
  onUnplayable: (source: SourceInfo) => void;
}

/** One file's videos: its original, and its proxy once it's ready, in its place. */
function Deck({ source, box, shown, player, proxyUrl, onError, onUnplayable }: DeckProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const proxyRef = useRef<HTMLVideoElement>(null);
  /**
   * The video's own size, rotated already if WebView2 honours the file's rotation flag; with the
   * URL it was measured for, so a new file starts unmeasured.
   */
  const [measured, setMeasured] = useState<{ url: string; width: number; height: number } | null>(
    null,
  );

  // The player drives the video; a converted file is a new element (keyed by URL).
  useEffect(() => {
    player.attach(source.id, videoRef.current);
    return () => player.attach(source.id, null);
  }, [player, source.id, source.url]);

  useEffect(() => {
    player.attachProxy(source.id, proxyRef.current);
    return () => player.attachProxy(source.id, null);
  }, [player, source.id, proxyUrl]);

  const unplayable = () =>
    source.converted
      ? onError(`The preview can't play ${source.name}, even converted.`)
      : onUnplayable(source);

  const natural = measured?.url === source.url ? measured : null;
  const transform = natural ? videoTransform(natural, source, box) : null;
  return (
    <div className={styles.deck} style={{ ...box, visibility: shown ? undefined : "hidden" }}>
      <video
        key={source.url}
        ref={videoRef}
        className={styles.video}
        src={source.url}
        // Its pixels readable (the frame check, frameCheck.ts): protocol.rs allows it.
        crossOrigin="anonymous"
        preload="auto"
        style={
          transform
            ? { width: transform.width, height: transform.height, transform: transform.css }
            : { visibility: "hidden" }
        }
        onLoadedMetadata={(e) => {
          const { videoWidth: width, videoHeight: height } = e.currentTarget;
          // No picture: the video's codec can't be played, though its audio may (no error is
          // raised then).
          if (width === 0) unplayable();
          else setMeasured({ url: source.url, width, height });
        }}
        onError={unplayable}
      />
      {proxyUrl && (
        // Already upright and the file's shape: it fills its place.
        <video
          key={proxyUrl}
          ref={proxyRef}
          className={styles.proxy}
          src={proxyUrl}
          crossOrigin="anonymous"
          preload="auto"
          muted
        />
      )}
    </div>
  );
}
