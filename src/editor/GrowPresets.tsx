import { useRef, useState, type RefObject } from "react";
import { boxOf, useMenuPlacement } from "../markup/menuPlacement";
import { usePopover } from "../markup/usePopover";
import { commands, type Settings } from "../shared/ipc";
import { useDoc } from "./docStore";
import { growPreset, isGrown, isPreset, presetGrow, presetSummary } from "./frame";
import { Menu, type MenuItems } from "./Menu";
import markup from "../markup/options.module.css";
import styles from "./EditorApp.module.css";

/**
 * The grow tool's presets (Settings › Editing › Grow presets), in a dropdown: picking one grows
 * the frame to it (sized to the picture as cropped), and the one in use is checked. "Save as
 * preset…" names the grow as it is and adds it; "Edit presets…" opens Settings.
 */
export function GrowPresets({ settings }: { settings: Settings | null }) {
  const frame = useDoc((s) => s.doc.frame);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const presets = settings?.editing.growPresets ?? [];
  const picture = { width: frame.crop.width, height: frame.crop.height };
  const items: MenuItems = [
    ...(presets.length
      ? presets.map((p) => ({
          label: p.name,
          hint: presetSummary(p),
          radio: true,
          checked: isPreset(frame.grow, p, picture),
          run: () => useDoc.getState().grow(presetGrow(p, picture)),
        }))
      : [{ label: "No presets yet", disabled: true, run: () => {} }]),
    "-",
    {
      label: "Save as preset…",
      disabled: !settings || !isGrown(frame.grow),
      title: isGrown(frame.grow) ? "Keep this grow as a preset" : "Grow a side first",
      run: () => setSaving(true),
    },
    { label: "Edit presets…", run: () => void commands.openSettings("editing") },
  ];
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.dropdown}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          if (menu) return setMenu(null);
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 4 });
        }}
      >
        Presets
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {menu && <Menu items={items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      {saving && settings && (
        <SavePreset settings={settings} anchor={buttonRef} onClose={() => setSaving(false)} />
      )}
    </>
  );
}

/**
 * "Save as preset…": a name, under the Presets button; then the grow joins the presets (Rust
 * checks the name). Enter or Save saves; Esc or a click elsewhere drops it.
 */
function SavePreset({
  settings,
  anchor,
  onClose,
}: {
  settings: Settings;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const presets = settings.editing.growPresets;
  const [name, setName] = useState(`Preset ${presets.length + 1}`);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useMenuPlacement(true, rootRef, () => boxOf(anchor.current));

  const save = async () => {
    const preset = growPreset(useDoc.getState().doc.frame.grow, name);
    const result = await commands.updateSettings({
      ...settings,
      editing: { ...settings.editing, growPresets: [...presets, preset] },
    });
    if (result.status === "error") setError(result.error);
    else onClose();
  };
  usePopover(true, rootRef, (keep) => (keep ? void save() : onClose()), "cancel");

  return (
    <div
      ref={rootRef}
      className={`${markup.menu} ${markup.colorMenu}`}
      role="dialog"
      aria-label="Save as preset"
    >
      <label className={styles.presetName}>
        Name
        <input
          autoFocus
          value={name}
          maxLength={40}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
      </label>
      {error && (
        <p className={styles.presetError} role="alert">
          {error}
        </p>
      )}
      <div className={markup.colorActions}>
        <button type="button" className={markup.accentButton} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}
