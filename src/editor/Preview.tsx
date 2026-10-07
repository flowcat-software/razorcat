import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SourceInfo } from "../shared/ipc";
import { fitRect, videoTransform } from "./fit";
import type { Player } from "./player";
import styles from "./EditorApp.module.css";

interface Props {
  source: SourceInfo;
  /** Drives the video (player.ts). */
  player: Player;
  /** The picture can't be shown (a codec WebView2 can't play). */
  onError: (message: string) => void;
}

/** Space kept around the picture, in px. */
const MARGIN = 16;

/**
 * The picture: the source's `<video>`, fitted into the preview at its shape as shown. The stage
 * (the fitted box) is where crop, grow and markup will sit later (Phases 3-4).
 */
export function Preview({ source, player, onError }: Props) {
  const areaRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
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

  const stage = fitRect(area, { width: source.width, height: source.height }, MARGIN);
  const natural = measured?.url === source.url ? measured : null;
  const transform = natural ? videoTransform(natural, source, stage) : null;

  return (
    <div ref={areaRef} className={styles.previewArea}>
      <div
        className={styles.stage}
        style={{ left: stage.x, top: stage.y, width: stage.width, height: stage.height }}
      >
        <video
          key={source.url}
          ref={videoRef}
          className={styles.video}
          src={source.url}
          preload="auto"
          style={
            transform
              ? { width: transform.width, height: transform.height, transform: transform.css }
              : { visibility: "hidden" }
          }
          onLoadedMetadata={(e) =>
            setMeasured({
              url: source.url,
              width: e.currentTarget.videoWidth,
              height: e.currentTarget.videoHeight,
            })
          }
          onError={() =>
            onError(
              `The preview can't play ${source.name} (${source.codec}). Converting it on open comes soon.`,
            )
          }
        />
      </div>
    </div>
  );
}
