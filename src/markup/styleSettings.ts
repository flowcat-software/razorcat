// The markup's style settings (Vandal's `styles.rs`), on the TypeScript side for now: Phase 4.2b
// moves them to Rust (Settings, kept between sessions), and these types to the bindings. Until
// then the palettes are Vandal's defaults (styles.ts) and a saved preset lasts the session.

import { MAX_PRESETS } from "./pickers";
import { useStyleConfig } from "./styles";

/** A number control: a free range, or a list of presets as a stepped slider, a dropdown or buttons. */
export type NumberPicker =
  | { control: "slider"; min: number; max: number }
  | { control: "stepped"; values: number[] }
  | { control: "dropdown"; values: number[] }
  | { control: "buttons"; values: number[] };

export type ColorControl = "swatches" | "dropdown";

export interface FontPicker {
  /** The installed fonts, a custom list, or (step markers) the text tool's. */
  source: "system" | "custom" | "text";
  fonts: string[];
  control: "dropdown" | "stepped";
}

/** A tool's own palette, width picker or colour control, overriding the shared ones. */
export interface ToolStyles {
  palette: string[] | null;
  width: NumberPicker | null;
  colorControl: ColorControl | null;
}

export interface StyleSettings {
  palette: string[];
  colorControl: ColorControl;
  width: NumberPicker;
  font: FontPicker;
  fontSize: NumberPicker;
  pixelate: NumberPicker;
  blur: NumberPicker;
  spotlight: NumberPicker;
  stepSize: NumberPicker;
  cornerRadius: NumberPicker;
  stepFont: FontPicker;
  tools: Partial<Record<string, ToolStyles>>;
}

type Result = { status: "ok"; data: null } | { status: "error"; error: string };

const ok: Result = { status: "ok", data: null };
const error = (message: string): Result => ({ status: "error", error: message });

/** The palette `tool` uses, changed by `edit` (its own, else the shared one). */
function editPalette(tool: string, edit: (palette: string[]) => string[] | string): Result {
  const cfg = useStyleConfig.getState();
  const own = cfg.styles.tools[tool]?.palette;
  const next = edit([...(own ?? cfg.styles.palette)]);
  if (typeof next === "string") return error(next);
  const styles = own
    ? {
        ...cfg.styles,
        tools: { ...cfg.styles.tools, [tool]: { ...cfg.styles.tools[tool]!, palette: next } },
      }
    : { ...cfg.styles, palette: next };
  useStyleConfig.setState({ styles });
  return ok;
}

/** Adds `color` to the presets `tool` uses (the custom picker's "Save as preset"). */
export function addColorPreset(tool: string, color: string): Promise<Result> {
  const c = color.toLowerCase();
  return Promise.resolve(
    editPalette(tool, (p) =>
      p.includes(c)
        ? "That color is already a preset."
        : p.length >= MAX_PRESETS
          ? `The palette is full (${MAX_PRESETS} colors).`
          : [...p, c],
    ),
  );
}

/** Changes (`color` given) or deletes (null) preset `index` of the palette `tool` uses. */
export function editColorPreset(
  tool: string,
  index: number,
  color: string | null,
): Promise<Result> {
  return Promise.resolve(
    editPalette(tool, (p) => {
      if (index >= p.length) return "That preset no longer exists.";
      if (color === null) {
        if (p.length === 1) return "The palette needs at least one color.";
        return p.filter((_, i) => i !== index);
      }
      const c = color.toLowerCase();
      if (p.some((x, i) => i !== index && x === c)) return "That color is already a preset.";
      return p.map((x, i) => (i === index ? c : x));
    }),
  );
}
