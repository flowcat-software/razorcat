import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MarkupLayer } from "../markup/MarkupLayer";
import { connectMarkup } from "../markup/model/store";
import type { SourceInfo } from "../shared/ipc";
import { CropOverlay } from "./CropOverlay";
import { useDoc } from "./docStore";
import { fitRect, videoTransform } from "./fit";
import { growColour, growMode, NO_GROW, outputSize, SIDES } from "./frame";
import { GrowOverlay } from "./GrowOverlay";
import type { Player } from "./player";
import { useTool } from "./toolStore";
import styles from "./EditorApp.module.css";

interface Props {
  source: SourceInfo;
  /** Drives the video (player.ts). */
  player: Player;
  /** The proxy, once it's ready (proxy.rs). */
  proxyUrl: string | null;
  /** The picture can't be shown, even from a converted copy. */
  onError: (message: string) => void;
  /** The original can't be played here (its codec): convert it (convert.rs). */
  onUnplayable: () => void;
}

/** Space kept around the picture, in px. */
const MARGIN = 16;

/**
 * The picture: the source's `<video>`, cropped, with the space grown round it, fitted into the
 * preview (CSS only, so it follows live, also while playing). The crop tool shows the whole
 * picture, ungrown, with the crop box over it; the grow tool, the frame with its handles.
 * Markup sits over the whole frame (Vandal's markup layer, over the whole preview so its handles
 * reach past the frame): what's at the playhead, which the select and markup tools edit.
 */
export function Preview({ source, player, proxyUrl, onError, onUnplayable }: Props) {
  const areaRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const proxyRef = useRef<HTMLVideoElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  /**
   * The video's own size, rotated already if WebView2 honours the file's rotation flag; with the
   * URL it was measured for, so a new file starts unmeasured.
   */
  const [measured, setMeasured] = useState<{ url: string; width: number; height: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => setArea({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The player drives the video; a new file is a new element (keyed by URL).
  useEffect(() => {
    player.attach(videoRef.current);
    return () => player.attach(null);
  }, [player, source.url]);

  useEffect(() => {
    player.attachProxy(proxyRef.current);
    return () => player.attachProxy(null);
  }, [player, proxyUrl]);

  // The markup shows what's at the playhead.
  useEffect(() => connectMarkup(player), [player]);

  const unplayable = () =>
    source.converted
      ? onError(`The preview can't play ${source.name}, even converted.`)
      : onUnplayable();

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
  const natural = measured?.url === source.url ? measured : null;
  const transform = natural ? videoTransform(natural, source, picture) : null;

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
                // No picture: the video's codec can't be played, though its audio may (no error
                // is raised then).
                if (width === 0) unplayable();
                else setMeasured({ url: source.url, width, height });
              }}
              onError={unplayable}
            />
            {proxyUrl && (
              // Already upright and the picture's shape: it fills the picture.
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
        </div>
      </div>
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
