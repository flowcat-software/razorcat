import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SourceInfo } from "../shared/ipc";
import { CropOverlay } from "./CropOverlay";
import { useDoc } from "./docStore";
import { fitRect, videoTransform } from "./fit";
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
 * The picture: the source's `<video>`, fitted into the preview at its shape as shown, cropped
 * (CSS only, so it follows live, also while playing). The crop tool shows the whole picture with
 * the crop box over it. The stage (the fitted box) is where grow and markup will sit (Phases
 * 3.4 and 4).
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

  const unplayable = () =>
    source.converted
      ? onError(`The preview can't play ${source.name}, even converted.`)
      : onUnplayable();

  const frame = useDoc((s) => s.doc.frame);
  const cropping = useTool((s) => s.tool === "crop");
  const whole = { x: 0, y: 0, width: source.width, height: source.height };
  // What shows: the crop, or the whole picture to crop it.
  const shown = cropping ? whole : frame.crop;
  const stage = fitRect(area, shown, MARGIN);
  const scale = shown.width > 0 ? stage.width / shown.width : 0;
  // The whole picture at that scale, placed so the crop fills the stage.
  const picture = {
    left: -shown.x * scale,
    top: -shown.y * scale,
    width: source.width * scale,
    height: source.height * scale,
  };
  const natural = measured?.url === source.url ? measured : null;
  const transform = natural ? videoTransform(natural, source, picture) : null;

  return (
    <div ref={areaRef} className={styles.previewArea}>
      <div
        className={styles.stage}
        style={{ left: stage.x, top: stage.y, width: stage.width, height: stage.height }}
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
      {cropping && (
        // Over the stage, not in it: the handles reach past the picture's edges.
        <div
          className={styles.cropArea}
          style={{ left: stage.x, top: stage.y, width: stage.width, height: stage.height }}
        >
          <CropOverlay crop={frame.crop} source={source} scale={scale} />
        </div>
      )}
    </div>
  );
}
