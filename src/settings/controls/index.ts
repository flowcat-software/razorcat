// Control registry: one component per item kind. Adding a kind to `Item` in schema.ts without
// registering it here is a type error.
import type { ComponentType } from "react";
import type { Item, ItemKind } from "../schema";
import { AboutCard } from "./AboutCard";
import { AccentPicker } from "./AccentPicker";
import { Choice, NumberChoice } from "./Choice";
import { ColorSetting } from "./ColorSetting";
import { FolderInput } from "./FolderInput";
import { FontPickerSetting } from "./FontPickerEditor";
import { GrowPresetsEditor } from "./GrowPresetsEditor";
import { LogButtons } from "./LogButtons";
import { MicrophonePicker } from "./MicrophonePicker";
import { NumberInput } from "./NumberInput";
import { NumberPickerSetting } from "./NumberPickerEditor";
import { PaletteSetting } from "./PaletteEditor";
import { PickedNumber } from "./PickedNumber";
import { ProxyLimit } from "./ProxyLimit";
import { Slider } from "./Slider";
import { TextInput } from "./TextInput";
import { Toggle } from "./Toggle";
import { ToolStyleSetting } from "./ToolStyleEditor";

export interface ControlProps<I extends Item> {
  item: I;
  /** DOM id for the control, so the row's label can point at it. */
  id: string;
  disabled: boolean;
}

interface ControlDef<I extends Item> {
  component: ComponentType<ControlProps<I>>;
  /**
   * `inline`: control to the right of the label. `stacked`: full width below.
   * `bare`: the control alone, its label only for search.
   */
  layout: "inline" | "stacked" | "bare";
}

type Registry = { [K in ItemKind]: ControlDef<Extract<Item, { kind: K }>> };

export const controls: Registry = {
  toggle: { component: Toggle, layout: "inline" },
  choice: { component: Choice, layout: "inline" },
  numberChoice: { component: NumberChoice, layout: "inline" },
  number: { component: NumberInput, layout: "inline" },
  pickedNumber: { component: PickedNumber, layout: "inline" },
  text: { component: TextInput, layout: "stacked" },
  accent: { component: AccentPicker, layout: "stacked" },
  color: { component: ColorSetting, layout: "stacked" },
  slider: { component: Slider, layout: "inline" },
  microphone: { component: MicrophonePicker, layout: "inline" },
  folder: { component: FolderInput, layout: "stacked" },
  proxyLimit: { component: ProxyLimit, layout: "inline" },
  growPresets: { component: GrowPresetsEditor, layout: "stacked" },
  numberPicker: { component: NumberPickerSetting, layout: "stacked" },
  palette: { component: PaletteSetting, layout: "stacked" },
  toolStyle: { component: ToolStyleSetting, layout: "stacked" },
  fontPicker: { component: FontPickerSetting, layout: "stacked" },
  about: { component: AboutCard, layout: "bare" },
  logs: { component: LogButtons, layout: "stacked" },
};
