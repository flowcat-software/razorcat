import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { MarkupDrawing } from "../markup/MarkupDrawing";
import { MarkupLayer } from "../markup/MarkupLayer";
import { connectMarkup } from "../markup/model/store";
import type { SourceInfo } from "../shared/ipc";
import { CropOverlay } from "./CropOverlay";
import { clipOpacityAt } from "./doc";
import { useDoc } from "./docStore";
import { fitRect, videoTransform } from "./fit";
import { growColour, growMode, NO_GROW, outputSize, SIDES } from "./frame";
import { GrowOverlay } from "./GrowOverlay";
import type { Player } from "./player";
import { useTool } from "./toolStore";
import styles from "./EditorApp.module.css";

interface Props {
  /** The timeline's files, first first: the first sets the picture's size (PLAN 4.5e). */
  sources: readonly SourceInfo[];
  /** Drives the videos (player.ts). */
  player: Player;
  /** Each file's proxy, once it's ready (proxy.rs), by its id. */
  proxyUrls: Readonly<Record<string, string | null>>;
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
 * it, the clips' fades: black over the whole frame (`ClipFade`).
 */
export function Preview({ sources, player, proxyUrls, onError, onUnplayable }: Props) {
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
          </div>
        </div>
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
 * The clips' fades (PLAN 4.7a): black over the whole frame, as opaque as the picture under the
 * playhead is faded (`clipOpacityAt`, the export's ramp), and the sound as loud as the picture
 * shows. Set straight on the element as the playhead moves, not re-rendered.
 */
function ClipFade({ player }: { player: Player }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => {
      const shows = clipOpacityAt(useDoc.getState().doc, player.getState().frame);
      if (ref.current) ref.current.style.opacity = String(1 - shows);
      player.setLevel(shows);
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

/** Where `s` shows in the picture (`picture`, the first file's): fitted in, centred. */
function fitIn(s: SourceInfo, first: SourceInfo, picture: { width: number; height: number }) {
  if (s === first || s.width <= 0 || s.height <= 0) {
    return { left: 0, top: 0, width: picture.width, height: picture.height };
  }
  const k = Math.min(picture.width / s.width, picture.height / s.height);
  const width = s.width * k;
  const height = s.height * k;
  return { left: (picture.width - width) / 2, top: (picture.height - height) / 2, width, height };
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
