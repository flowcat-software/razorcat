// The settings schema: what the settings window shows, declared as data.
//
// To add a setting, add an item to a group in `sections.tsx`. To add a new kind of control,
// add an item type to `Item` below and a component to the registry in `controls/index.ts`
// (TypeScript will insist on both). Vandal's settings have more kinds to copy (toggle, text...)
// when a setting needs one.
import type { ComponentType } from "react";
import type { ToolId } from "../markup/toolStore";
import type { Settings, NumberPicker } from "../shared/ipc";
import type { PathOf } from "./path";

interface BaseItem {
  /** Stable id: used as the React key and the control's DOM id. */
  id: string;
  label: string;
  description?: string;
  /** Extra words that should find this setting in search. */
  keywords?: string[];
  /** Hide the row entirely when false. */
  visible?: (s: Settings) => boolean;
  /** Grey the row out when true (keep it visible so it's discoverable). */
  disabled?: (s: Settings) => boolean;
  /** A warning bar under the row, when there's something to say (why it's greyed out). */
  note?: (s: Settings) => string | undefined;
}

/** One of a fixed set of strings, as joined buttons. */
export interface ChoiceItem extends BaseItem {
  kind: "choice";
  path: PathOf<Settings, string>;
  options: readonly { value: string; label: string }[];
}

/** A line of text (a file-name template). */
export interface TextItem extends BaseItem {
  kind: "text";
  path: PathOf<Settings, string>;
  placeholder?: string;
  /** What the text gives, shown under the field as it's typed (a file name template's). */
  preview?: (text: string) => Promise<string>;
  /** A file name template: a "Tag reference" link under the field opens the guide to its tags
   *  (a recording's: without the video's name and clips, which it hasn't got). */
  tags?: boolean | "recording";
}

/** One of a fixed set of numbers, as joined buttons. */
export interface NumberChoiceItem extends BaseItem {
  kind: "numberChoice";
  path: PathOf<Settings, number>;
  options: readonly { value: number; label: string }[];
}

/** The accent color: the Windows accent or a preset. */
export interface AccentItem extends BaseItem {
  kind: "accent";
  path: PathOf<Settings, string>;
}

/** One color: a preset, or any color from the picker. */
export interface ColorItem extends BaseItem {
  kind: "color";
  path: PathOf<Settings, string>;
  /** Fixed, or from the settings (a tool's palette). */
  presets:
    | readonly { color: string; name: string }[]
    | ((s: Settings) => readonly { color: string; name: string }[]);
}

/** A number picked as a markup tool's options bar picks it: the control and values `picker`
 *  says (Settings › Markup's). */
export interface PickedNumberItem extends BaseItem {
  kind: "pickedNumber";
  path: PathOf<Settings, number>;
  picker: (s: Settings) => NumberPicker;
  unit: string;
}

/** Which microphone records (Settings › Recording): the default, or one connected. */
export interface MicrophoneItem extends BaseItem {
  kind: "microphone";
  path: PathOf<Settings, string>;
}

/** A number dragged along a slider, `min`–`max` by `step`, shown by `format`. */
export interface SliderItem extends BaseItem {
  kind: "slider";
  path: PathOf<Settings, number>;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
}

/** A whole number typed in, kept to `min`–`max`, with its unit after it. */
export interface NumberItem extends BaseItem {
  kind: "number";
  path: PathOf<Settings, number>;
  min: number;
  max: number;
  unit: string;
}

/** On or off, as a switch. */
export interface ToggleItem extends BaseItem {
  kind: "toggle";
  path: PathOf<Settings, boolean>;
  /** Ask this before turning it on (it changes work elsewhere). */
  confirmOn?: { title: string; body: string; confirm: string };
}

/** A folder: typed (`%VARS%` allowed), browsed for, or opened in Explorer. */
export interface FolderItem extends BaseItem {
  kind: "folder";
  path: PathOf<Settings, string>;
  /** What an empty setting means: the field shows it, and storing it stores empty. */
  defaultFolder?: () => Promise<string>;
  /** Say how much the folder holds, under the field. */
  showSize?: boolean;
}

/** The proxy cache's size limit: asks before a lower limit deletes proxies. */
export interface ProxyLimitItem extends BaseItem {
  kind: "proxyLimit";
  path: PathOf<Settings, number>;
  min: number;
  max: number;
}

/** The grow tool's presets: a list, each edited in place (GrowPresetsEditor.tsx). */
export interface GrowPresetsItem extends BaseItem {
  kind: "growPresets";
  path: string;
}

/** The About card: logo, name, version, description, author. */
export interface AboutItem extends BaseItem {
  kind: "about";
}

/** Settings › About › Debugging: open or clear the logs folder. */
export interface LogsItem extends BaseItem {
  kind: "logs";
}

/** Settings › About › Reset: every setting, or the styles, as installed (asked first). */
export interface ResetItem extends BaseItem {
  kind: "reset";
}

/** A number picker spec (Vandal's): its control type and values. */
export interface NumberPickerItem extends BaseItem {
  kind: "numberPicker";
  /** Picker specs are objects, so these aren't typed leaf paths. */
  path:
    | "styles.width"
    | "styles.fontSize"
    | "styles.pixelate"
    | "styles.blur"
    | "styles.spotlight"
    | "styles.stepSize"
    | "styles.clickSize"
    | "styles.cornerRadius";
  unit: "px" | "pt" | "%";
  /** 0 is always a choice, first in the list or the slider's start. */
  zero?: boolean;
  /** No "Buttons" control. */
  noButtons?: boolean;
  /** Preview the values as lines of that thickness. */
  lines?: boolean;
  /** A note under the editor while any value is below `value` (allowed, but weak). */
  warnBelow?: { value: number; message: string };
}

/** A color palette (Vandal's): up to 10 colors in the user's order. */
export interface PaletteItem extends BaseItem {
  kind: "palette";
  path: PathOf<Settings, string[]>;
}

/** One markup tool's own colors and widths, instead of the shared ones (Vandal's). */
export interface ToolStyleItem extends BaseItem {
  kind: "toolStyle";
  tool: ToolId;
  /** The tool draws lines, so a width override applies. */
  widths: boolean;
  /** How it shows its colors can be chosen (default: yes). */
  colorControl?: boolean;
  /** Custom colors turned on start from the tool's own, not the ones set aside when they
   *  were turned off (clicks: off, their own are what they use). */
  freshPalette?: boolean;
}

/** A tool's fonts (Vandal's): the text tool's, or the step markers'. */
export interface FontPickerItem extends BaseItem {
  kind: "fontPicker";
  path: "styles.font" | "styles.stepFont";
}

export type Item =
  | PickedNumberItem
  | NumberItem
  | ToggleItem
  | ChoiceItem
  | NumberChoiceItem
  | TextItem
  | AccentItem
  | ColorItem
  | SliderItem
  | MicrophoneItem
  | FolderItem
  | ProxyLimitItem
  | GrowPresetsItem
  | NumberPickerItem
  | PaletteItem
  | ToolStyleItem
  | FontPickerItem
  | AboutItem
  | LogsItem
  | ResetItem;
export type ItemKind = Item["kind"];

export interface Group {
  title?: string;
  description?: string;
  items: Item[];
}

export interface Section {
  id: string;
  title: string;
  icon: ComponentType;
  description?: string;
  groups: Group[];
}

/** Does `item` match every word of `query` (case-insensitive)? */
export function matchesQuery(item: Item, section: Section, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [item.label, item.description, section.title, ...(item.keywords ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}
