import { ColorSwatch } from "../markup/ColorSwatch";
import type { Settings, SourceInfo } from "../shared/ipc";
import { pickCropRatio, resetCrop, resetGrow, toggleCropPortrait } from "./cropTool";
import { useDoc } from "./docStore";
import {
  colourGrow,
  growColour,
  growMode,
  growSide,
  isCropped,
  isGrown,
  outputSize,
  setCropField,
  SIDES,
  type CropField,
  type Side,
} from "./frame";
import { sourceFacts } from "./format";
import { GrowPresets } from "./GrowPresets";
import { NumberField } from "./NumberField";
import { CROP_RATIOS, lockedRatio, ratioLabel, useTool } from "./toolStore";
import styles from "./EditorApp.module.css";

/**
 * The options bar above the preview (the mockup's): the picked-up tool's options, or, with
 * nothing being edited, the video's facts and its frame (output size, crop, grow).
 */
export function FrameOptions({
  source,
  settings,
}: {
  source: SourceInfo | null;
  /** For the grow presets. */
  settings: Settings | null;
}) {
  const tool = useTool((s) => s.tool);
  const frame = useDoc((s) => s.doc.frame);
  if (!source) return <div className={styles.optionsBar}>No video open</div>;
  if (tool === "crop") return <CropOptions />;
  if (tool === "grow") return <GrowOptions settings={settings} />;
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

/** A visit to the colour picker is one undo step; Esc puts the colour back. */
const ONE_STEP = {
  onOpen: () => useDoc.getState().beginGesture(),
  onClose: (keep: boolean) =>
    keep ? useDoc.getState().endGesture() : useDoc.getState().cancelGesture(),
};

const SIDE_NAMES: Record<Side, string> = {
  top: "Top",
  bottom: "Bottom",
  left: "Left",
  right: "Right",
};

/**
 * The grow tool's options (the mockup's): each side in px, its colour while grown sides don't
 * meet (one colour once they do), Reset.
 */
function GrowOptions({ settings }: { settings: Settings | null }) {
  const grow = useDoc((s) => s.doc.frame.grow);
  const each = growMode(grow) === "each";
  // From the document as it is now: a drag sets several values between renders.
  const set = (side: Side, value: number) => {
    const doc = useDoc.getState();
    doc.grow(growSide(doc.doc.frame.grow, side, value));
    return useDoc.getState().doc.frame.grow[side];
  };
  const colour = (side: Side | null, value: string) => {
    const doc = useDoc.getState();
    doc.grow(colourGrow(doc.doc.frame.grow, side, value));
  };
  return (
    <div className={styles.optionsBar}>
      <b className={styles.optionsTitle}>Grow</b>
      {SIDES.map((side) => (
        <span key={side} className={styles.field}>
          <NumberField
            label={SIDE_NAMES[side]}
            value={grow[side]}
            onChange={(v) => set(side, v)}
            unit="px"
          />
          {each && grow[side] > 0 && (
            <ColorSwatch
              name={`${SIDE_NAMES[side]} colour`}
              value={growColour(grow, side)}
              onPick={(v) => colour(side, v)}
              {...ONE_STEP}
            />
          )}
        </span>
      ))}
      {!each && (
        <span className={styles.field}>
          Colour
          <ColorSwatch
            name="Colour"
            value={grow.colour}
            onPick={(v) => colour(null, v)}
            {...ONE_STEP}
          />
        </span>
      )}
      <span className={styles.optionsSep} />
      <button
        type="button"
        className={styles.ghostButton}
        title="Back to the picture alone"
        disabled={!isGrown(grow)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={resetGrow}
      >
        Reset
      </button>
      <span className={styles.optionsSep} />
      <GrowPresets settings={settings} />
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
  const portrait = useTool((s) => s.portrait);
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
              className={styles.toggle}
              aria-checked={ratioId === r.id}
              title={r.ratio ? `Keep it ${ratioLabel(r, portrait)}` : "Any shape"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickCropRatio(r.id)}
            >
              {ratioLabel(r, portrait)}
            </button>
          ))}
          <button
            type="button"
            className={styles.toggle}
            aria-pressed={portrait}
            aria-label="Portrait"
            title="Portrait: taller than wide (9:16 instead of 16:9)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleCropPortrait}
          >
            <svg viewBox="0 0 24 24" className={styles.toggleIcon} aria-hidden>
              <rect x="7" y="3" width="10" height="18" rx="1.5" />
            </svg>
          </button>
        </span>
      </span>
      <span className={styles.optionsSep} />
      <button
        type="button"
        className={styles.ghostButton}
        title="Back to the whole picture"
        disabled={!isCropped(frame)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={resetCrop}
      >
        Reset
      </button>
      <span className={styles.spacer} />
      <span className={styles.kbd}>
        Shift keeps the shape · arrows nudge, Shift 10 px, Ctrl resizes · Enter: done
      </span>
    </div>
  );
}
