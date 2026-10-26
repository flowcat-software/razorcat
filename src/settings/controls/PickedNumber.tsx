import { useEffect, useRef } from "react";
import { NumberPickerControl } from "../../markup/NumberPickerControl";
import { MARKER_SIZE_ICON } from "../../markup/pickerIcons";
import markup from "../../markup/options.module.css";
import type { PickedNumberItem } from "../schema";
import { useSetting, useSettingsStore } from "../store";
import type { ControlProps } from "./index";
import { useDraft } from "./useDraft";
import styles from "./controls.module.css";

/**
 * A number picked as a markup tool's options bar picks it (PLAN 5b.6d): the same control, and
 * the same sizes, as Settings › Markup defines for that tool. A slider's drag is one save.
 */
export function PickedNumber({ item, id, disabled }: ControlProps<PickedNumberItem>) {
  const settings = useSettingsStore((s) => s.settings!);
  const [value, setStored] = useSetting(item.path);
  const [draft, setDraft] = useDraft(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const pick = (next: number) => {
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStored(next), 200);
  };
  return (
    <div id={id} className={`${markup.options} ${styles.pickedNumber}`} inert={disabled}>
      <NumberPickerControl
        icon={MARKER_SIZE_ICON}
        picker={item.picker(settings)}
        value={draft}
        unit={item.unit}
        label={item.label}
        showKeys={false}
        hints={false}
        onPick={pick}
        onDragStart={() => {}}
        onDragEnd={() => {}}
      />
    </div>
  );
}
