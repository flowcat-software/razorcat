import type { SourceInfo } from "../shared/ipc";
import { pickCropRatio, resetCrop } from "./cropTool";
import { useDoc } from "./docStore";
import { isCropped, isGrown, outputSize, setCropField, SIDES, type CropField } from "./frame";
import { sourceFacts } from "./format";
import { NumberField } from "./NumberField";
import { CROP_RATIOS, lockedRatio, useTool } from "./toolStore";
import styles from "./EditorApp.module.css";

/**
 * The options bar above the preview (the mockup's): the picked-up tool's options, or, with
 * nothing being edited, the video's facts and its frame (output size, crop, grow).
 */
export function FrameOptions({ source }: { source: SourceInfo | null }) {
  const tool = useTool((s) => s.tool);
  const frame = useDoc((s) => s.doc.frame);
  if (!source) return <div className={styles.optionsBar}>No video open</div>;
  if (tool === "crop") return <CropOptions />;
  const out = outputSize(frame);
  const grow = SIDES.filter((s) => frame.grow[s] > 0)
    .map((s) => `${s} ${frame.grow[s]} px`)
    .join(", ");
  return (
    <div className={styles.optionsBar}>
      <b className={styles.sourceName} title={source.path}>
        {source.name}
      </b>
      <span>{sourceFacts(source).join(" · ")}</span>
      <span className={styles.spacer} />
      <span className={styles.frameSummary}>
        Output {out.width} × {out.height} · Crop:{" "}
        {isCropped(frame) ? `${frame.crop.width} × ${frame.crop.height}` : "none"} · Grow:{" "}
        {isGrown(frame.grow) ? grow : "none"}
      </span>
    </div>
  );
}

const FIELDS: { field: CropField; label: string; name: string }[] = [
  { field: "x", label: "X", name: "Left edge" },
  { field: "y", label: "Y", name: "Top edge" },
  { field: "width", label: "W", name: "Width" },
  { field: "height", label: "H", name: "Height" },
];

/** The crop tool's options (the mockup's): X, Y, W, H, the aspect ratio, Reset. */
function CropOptions() {
  const frame = useDoc((s) => s.doc.frame);
  const ratioId = useTool((s) => s.cropRatio);
  // From the document as it is now: a drag sets several values between renders.
  const set = (field: CropField, value: number) => {
    const doc = useDoc.getState();
    const { crop, source } = doc.doc.frame;
    doc.crop(setCropField(crop, field, value, source, lockedRatio()));
    return useDoc.getState().doc.frame.crop[field];
  };
  return (
    <div className={styles.optionsBar}>
      <b className={styles.optionsTitle}>Crop</b>
      {FIELDS.map(({ field, label, name }) => (
        <NumberField
          key={field}
          label={label}
          name={name}
          value={frame.crop[field]}
          onChange={(v) => set(field, v)}
          unit={field === "height" ? "px" : undefined}
        />
      ))}
      <span className={styles.optionsSep} />
      <span className={styles.field}>
        Aspect
        <span className={styles.chips} role="radiogroup" aria-label="Aspect ratio">
          {CROP_RATIOS.map((r) => (
            <button
              key={r.id}
              type="button"
              role="radio"
              className={styles.chip}
              aria-checked={ratioId === r.id}
              title={r.ratio ? `Keep it ${r.label}` : "Any shape"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickCropRatio(r.id)}
            >
              {r.label}
            </button>
          ))}
        </span>
      </span>
      <span className={styles.optionsSep} />
      <button
        type="button"
        className={styles.chip}
        title="Back to the whole picture"
        disabled={!isCropped(frame)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={resetCrop}
      >
        Reset to full frame
      </button>
      <span className={styles.spacer} />
      <span className={styles.kbd}>
        Shift keeps the shape · arrows nudge, Shift 10 px, Ctrl resizes · Enter: done
      </span>
    </div>
  );
}
