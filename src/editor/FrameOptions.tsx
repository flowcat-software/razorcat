import { ColorSwatch } from "../markup/ColorSwatch";
import { hint } from "../markup/HintLine";
import { useDoc as useMarkup } from "../markup/model/store";
import { ToolOptions } from "../markup/ToolOptions";
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
import { fileInfo } from "./format";
import { GrowPresets } from "./GrowPresets";
import { NumberField } from "./NumberField";
import { useSqueeze } from "./squeeze";
import { CROP_RATIOS, lockedRatio, MARKUP_TOOLS, ratioLabel, useTool } from "./toolStore";
import styles from "./EditorApp.module.css";

/**
 * The options bar above the preview (the mockup's): the picked-up tool's options (a markup
 * tool's, Vandal's, also for the markup selected on the preview), or, with nothing being edited,
 * the files' facts (the selected clips' files, or the project's: `fileInfo`) and the frame
 * (output size, crop, grow).
 */
export function FrameOptions({
  source,
  sources,
  settings,
}: {
  source: SourceInfo | null;
  /** For the grow presets. */
  settings: Settings | null;
  /** The timeline's files, the first first. */
  sources: readonly SourceInfo[];
}) {
  const tool = useTool((s) => s.tool);
  const frame = useDoc((s) => s.doc.frame);
  const clips = useDoc((s) => s.doc.clips);
  const selectedClips = useDoc((s) => s.selectedClips);
  const markupSelected = useMarkup((s) => s.selection.length > 0);
  if (!source) return <div className={styles.optionsBar}>No video open</div>;
  if (tool === "crop") return <CropOptions />;
  if (tool === "grow") return <GrowOptions settings={settings} />;
  if (MARKUP_TOOLS.includes(tool) || markupSelected) {
    return (
      <div className={`${styles.optionsBar} ${styles.markupOptions}`}>
        <ToolOptions />
      </div>
    );
  }
  const out = outputSize(frame);
  const grow = SIDES.filter((s) => frame.grow[s] > 0)
    .map((s) => `${s} ${frame.grow[s]} px`)
    .join(", ");
  const picked = clips.flatMap((c) => {
    const file = selectedClips.includes(c.id) && sources.find((s) => s.id === c.source);
    return file ? [file] : [];
  });
  const info = fileInfo(sources.length ? sources : [source], picked);
  return (
    <div className={styles.optionsBar}>
      <b className={styles.sourceName} title={info.title} {...hint("source")}>
        {info.name}
      </b>
      <span className={styles.sourceFacts} title={info.title} {...hint("source")}>
        {info.facts.join(" · ")}
      </span>
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

/** Each side's label: its edge, and an arrow out to it, the way it grows (Richard's sketch). */
const SIDE_ICONS: Record<Side, string> = {
  top: "M5 5h14M12 19V8M8 12l4-4 4 4",
  bottom: "M5 19h14M12 5v11M8 12l4 4 4-4",
  left: "M5 5v14M19 12H8M12 8l-4 4 4 4",
  right: "M19 5v14M5 12h11M12 8l4 4-4 4",
};

function SideIcon({ side }: { side: Side }) {
  return (
    <span className={styles.sideIcon} title={SIDE_NAMES[side]}>
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d={SIDE_ICONS[side]} />
      </svg>
    </span>
  );
}

/**
 * The grow tool's options (the mockup's): each side in px, its colour while grown sides don't
 * meet (one colour once they do), Reset.
 */
function GrowOptions({ settings }: { settings: Settings | null }) {
  const grow = useDoc((s) => s.doc.frame.grow);
  const each = growMode(grow) === "each";
  /** Narrow windows: the fields close up, then the title goes (the tool's button is lit). */
  const bar = useSqueeze(3);
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
    <div ref={bar} className={styles.optionsBar}>
      <b className={styles.optionsTitle}>
        Grow <span className={styles.optionsUnit}>(px)</span>
      </b>
      {SIDES.map((side) => (
        <NumberField
          key={side}
          label={<SideIcon side={side} />}
          name={SIDE_NAMES[side]}
          value={grow[side]}
          onChange={(v) => set(side, v)}
          addon={
            each &&
            grow[side] > 0 && (
              <span {...hint("grow.colour")}>
                <ColorSwatch
                  name={`${SIDE_NAMES[side]} colour`}
                  value={growColour(grow, side)}
                  onPick={(v) => colour(side, v)}
                  {...ONE_STEP}
                />
              </span>
            )
          }
        />
      ))}
      {!each && (
        <span className={styles.field} {...hint("grow.colour")}>
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
        {...hint("grow.reset")}
        disabled={!isGrown(grow)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={resetGrow}
      >
        Reset
      </button>
      <span className={styles.optionsSep} />
      <span {...hint("grow.presets")}>
        <GrowPresets settings={settings} />
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
  const portrait = useTool((s) => s.portrait);
  /**
   * Narrow windows: the fields close up, then "Aspect" goes (its buttons say what they are),
   * then the title (the tool's button is lit).
   */
  const bar = useSqueeze(3);
  // From the document as it is now: a drag sets several values between renders.
  const set = (field: CropField, value: number) => {
    const doc = useDoc.getState();
    const { crop, source } = doc.doc.frame;
    doc.crop(setCropField(crop, field, value, source, lockedRatio()));
    return useDoc.getState().doc.frame.crop[field];
  };
  return (
    <div ref={bar} className={styles.optionsBar}>
      <b className={styles.optionsTitle}>
        Crop <span className={styles.optionsUnit}>(px)</span>
      </b>
      {FIELDS.map(({ field, label, name }) => (
        <NumberField
          key={field}
          label={label}
          name={name}
          value={frame.crop[field]}
          onChange={(v) => set(field, v)}
        />
      ))}
      <span className={styles.optionsSep} />
      <span className={styles.field}>
        <span className={styles.optionsWord}>Aspect</span>
        <span className={styles.chips} role="radiogroup" aria-label="Aspect ratio">
          {CROP_RATIOS.map((r) => (
            <button
              key={r.id}
              type="button"
              role="radio"
              className={styles.toggle}
              aria-checked={ratioId === r.id}
              title={r.ratio ? `Keep it ${ratioLabel(r, portrait)}` : "Any shape"}
              {...hint("crop.ratio")}
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
            {...hint("crop.portrait")}
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
        {...hint("crop.reset")}
        disabled={!isCropped(frame)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={resetCrop}
      >
        Reset
      </button>
    </div>
  );
}
