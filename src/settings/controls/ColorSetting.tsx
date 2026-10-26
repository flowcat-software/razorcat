import { useRef, useState } from "react";
import { ColorPicker } from "../../markup/ColorPicker";
import { boxOf, useMenuPlacement } from "../../markup/menuPlacement";
import { usePopover } from "../../markup/usePopover";
import markup from "../../markup/options.module.css";
import type { ColorItem } from "../schema";
import { useSetting, useSettingsStore } from "../store";
import type { ControlProps } from "./index";
import styles from "./controls.module.css";

/** One color: a preset, or any color from the picker (as the accent color's). */
export function ColorSetting({ item, id, disabled }: ControlProps<ColorItem>) {
  const [color, setColor] = useSetting(item.path);
  const [editing, setEditing] = useState<string | null>(null);
  const customRef = useRef<HTMLButtonElement>(null);
  const settings = useSettingsStore((s) => s.settings!);
  const presets = typeof item.presets === "function" ? item.presets(settings) : item.presets;

  const preset = presets.find((p) => p.color === color);
  const custom = preset ? null : color;

  return (
    <div className={styles.controlGroup}>
      <div id={id} className={styles.palette} role="radiogroup" aria-label={item.label}>
        {presets.map((p) => (
          <button
            key={p.color}
            type="button"
            role="radio"
            aria-checked={color === p.color}
            className={styles.paletteSwatch}
            style={{ background: p.color }}
            title={p.name}
            aria-label={p.name}
            disabled={disabled}
            onClick={() => setColor(p.color)}
          />
        ))}
        <button
          ref={customRef}
          type="button"
          role="radio"
          aria-checked={!!custom}
          className={markup.customSwatch}
          data-custom={custom ? "" : undefined}
          style={custom ? ({ "--custom": custom } as React.CSSProperties) : undefined}
          title="Custom color"
          aria-label="Custom color"
          disabled={disabled}
          onClick={() => setEditing(color)}
        />
      </div>
      <span className={styles.help}>{preset?.name ?? `Custom ${color}`}</span>
      {editing && (
        <ColorPopover
          label={`Custom ${item.label.toLowerCase()}`}
          color={editing}
          anchor={() => boxOf(customRef.current)}
          onDraft={setEditing}
          onDone={(keep) => {
            if (keep) setColor(editing);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ColorPopover({
  label,
  color,
  anchor,
  onDraft,
  onDone,
}: {
  label: string;
  color: string;
  anchor: () => ReturnType<typeof boxOf>;
  onDraft: (color: string) => void;
  onDone: (keep: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useMenuPlacement(true, ref, anchor);
  // Enter or a click elsewhere keeps; Esc cancels.
  usePopover(true, ref, onDone, "keep");
  return (
    <div
      ref={ref}
      className={`${markup.menu} ${markup.colorMenu}`}
      role="dialog"
      aria-label={label}
    >
      <ColorPicker value={color} onChange={onDraft} />
      <div className={markup.colorActions}>
        <span className={markup.spacer} />
        <button type="button" className={markup.ghostButton} onClick={() => onDone(false)}>
          Cancel
        </button>
        <button type="button" className={markup.accentButton} onClick={() => onDone(true)}>
          Done
        </button>
      </div>
    </div>
  );
}
