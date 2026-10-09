import { useState } from "react";
import { ColorSwatch } from "../../markup/ColorSwatch";
import { presetSummary, SIDES, type Side } from "../../editor/frame";
import { commands, type GrowPreset, type GrowUnit } from "../../shared/ipc";
import { getIn } from "../path";
import type { GrowPresetsItem } from "../schema";
import { useSettingsStore } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import type { ControlProps } from "./index";
import { Segmented } from "./Segmented";
import { useDraft } from "./useDraft";
import styles from "./controls.module.css";

/** The most presets (settings.rs's `MAX_GROW_PRESETS`). */
const MAX_PRESETS = 12;

const SIDE_NAMES: Record<Side, string> = {
  top: "Top",
  bottom: "Bottom",
  left: "Left",
  right: "Right",
};

const UNITS = [
  { value: "px", label: "px" },
  { value: "percent", label: "%" },
] as const;

/**
 * Settings › Editing › Grow presets: each preset in a row (its colour, name and sides), edited in
 * place (name, each side in px or %, colour) or deleted; Restore defaults puts back the first
 * three. New ones are saved from the grow tool's options bar. Rust checks every change (names,
 * sizes), and a refusal shows under the list.
 */
export function GrowPresetsEditor({ item, disabled }: ControlProps<GrowPresetsItem>) {
  // Presets are a list, which typed leaf paths don't reach.
  const presets = useSettingsStore((s) => getIn(s.settings!, item.path as never)) as GrowPreset[];
  const trySet = useSettingsStore((s) => s.trySet);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const save = async (next: GrowPreset[]) => {
    setError(await trySet(item.path as never, next as never));
  };
  const change = (i: number, preset: GrowPreset) =>
    void save(presets.map((p, j) => (j === i ? preset : p)));

  return (
    <div className={styles.stack}>
      {presets.length === 0 && (
        <p className={styles.help}>
          No presets: save one from the grow tool&apos;s options bar, or restore the defaults.
        </p>
      )}
      <div className={styles.presetList}>
        {presets.map((p, i) => (
          <PresetRow
            // By position: a rename keeps the row (and its editing).
            key={i}
            preset={p}
            open={editing === i}
            disabled={disabled}
            onOpen={() => setEditing(editing === i ? null : i)}
            onChange={(next) => change(i, next)}
            onDelete={() => {
              setEditing(null);
              void save(presets.filter((_, j) => j !== i));
            }}
          />
        ))}
      </div>
      {error && (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      )}
      <div className={styles.presetFooter}>
        <span className={styles.help}>
          {presets.length} of {MAX_PRESETS}
        </span>
        <button
          type="button"
          className={styles.button}
          disabled={disabled}
          onClick={() => setConfirming(true)}
        >
          Restore defaults
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Restore the grow presets?"
          confirm="Restore"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            setEditing(null);
            void commands.defaultGrowPresets().then((d) => save(d));
          }}
        >
          Your grow presets are replaced with Meme top, Meme bottom and Meme top + bottom.
        </ConfirmDialog>
      )}
    </div>
  );
}

function PresetRow({
  preset,
  open,
  disabled,
  onOpen,
  onChange,
  onDelete,
}: {
  preset: GrowPreset;
  open: boolean;
  disabled: boolean;
  onOpen: () => void;
  onChange: (preset: GrowPreset) => void;
  onDelete: () => void;
}) {
  /** The colour being picked, shown live; saved when the picker closes. */
  const [picking, setPicking] = useState<string | null>(null);
  const colour = picking ?? preset.colour;
  return (
    <div className={styles.preset} data-open={open || undefined}>
      <div className={styles.presetHead}>
        <span className={styles.presetColour} style={{ background: colour }} />
        <span className={styles.presetText}>
          <b>{preset.name}</b>
          <span className={styles.help}>{presetSummary(preset)}</span>
        </span>
        <button
          type="button"
          className={styles.button}
          aria-expanded={open}
          disabled={disabled}
          onClick={onOpen}
        >
          {open ? "Done" : "Edit"}
        </button>
        <button
          type="button"
          className={styles.button}
          aria-label={`Delete ${preset.name}`}
          disabled={disabled}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
      {open && (
        <div className={styles.presetEdit}>
          <NameField value={preset.name} onCommit={(name) => onChange({ ...preset, name })} />
          <div className={styles.presetSides}>
            {SIDES.map((side) => (
              <span key={side} className={styles.presetSide}>
                <span className={styles.presetSideName}>{SIDE_NAMES[side]}</span>
                <AmountField
                  label={SIDE_NAMES[side]}
                  value={preset[side].value}
                  onCommit={(value) => onChange({ ...preset, [side]: { ...preset[side], value } })}
                />
                <Segmented
                  label={`${SIDE_NAMES[side]}: unit`}
                  options={UNITS}
                  value={preset[side].unit}
                  onChange={(unit: GrowUnit) =>
                    onChange({ ...preset, [side]: { ...preset[side], unit } })
                  }
                />
              </span>
            ))}
          </div>
          <span className={styles.presetSide}>
            <span className={styles.presetSideName}>Colour</span>
            <ColorSwatch
              name={`${preset.name}: colour`}
              value={colour}
              onPick={setPicking}
              onClose={(keep) => {
                if (keep && picking && picking !== preset.colour) {
                  onChange({ ...preset, colour: picking });
                }
                setPicking(null);
              }}
            />
          </span>
        </div>
      )}
    </div>
  );
}

/** The preset's name: kept on Enter or leaving the field; Esc puts it back. */
function NameField({ value, onCommit }: { value: string; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useDraft(value);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <label className={styles.presetSide}>
      <span className={styles.presetSideName}>Name</span>
      <input
        className={styles.input}
        value={draft}
        maxLength={40}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(value);
        }}
      />
    </label>
  );
}

/** A side's size: whole numbers, kept on Enter or leaving the field; Esc puts it back. */
function AmountField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useDraft(String(value));
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n) || n === value) setDraft(String(value));
    else onCommit(Math.max(0, Math.round(n)));
  };
  return (
    <input
      className={`${styles.input} ${styles.amount}`}
      inputMode="numeric"
      aria-label={label}
      value={draft}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(String(value));
      }}
    />
  );
}
