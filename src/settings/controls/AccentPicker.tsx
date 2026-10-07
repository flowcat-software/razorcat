import { useEffect, useState } from "react";
import { commands, events, type WindowsAccent } from "../../shared/ipc";
import type { AccentItem } from "../schema";
import { useSetting } from "../store";
import type { ControlProps } from "./index";
import styles from "./controls.module.css";

/** Windows 11's accent palette, a few of each hue family. */
const PRESETS = [
  { color: "#1f6fe5", name: "Blue" },
  { color: "#8764b8", name: "Purple" },
  { color: "#c239b3", name: "Pink" },
  { color: "#d13438", name: "Red" },
  { color: "#ca5010", name: "Orange" },
  { color: "#107c10", name: "Green" },
  { color: "#038387", name: "Teal" },
  { color: "#69797e", name: "Graphite" },
];

/**
 * The accent color: the Windows accent (default) or a preset. Vandal's custom color comes with
 * the markup's color picker (Phase 4); a custom color set by hand still shows in the caption.
 */
export function AccentPicker({ item, id, disabled }: ControlProps<AccentItem>) {
  const [accent, setAccent] = useSetting(item.path);
  const [windows, setWindows] = useState<WindowsAccent | null>(null);

  useEffect(() => {
    void commands.windowsAccent().then(setWindows);
    const off = events.windowsAccentChanged.listen(({ payload }) => setWindows(payload));
    return () => void off.then((f) => f());
  }, []);

  const preset = PRESETS.find((p) => p.color === accent);
  const caption =
    accent === "windows"
      ? windows
        ? "Windows accent color"
        : "Windows accent color (not available: using blue)"
      : (preset?.name ?? `Custom ${accent}`);

  return (
    <div className={styles.controlGroup}>
      <div id={id} className={styles.palette} role="radiogroup" aria-label={item.label}>
        <button
          type="button"
          role="radio"
          aria-checked={accent === "windows"}
          className={`${styles.paletteSwatch} ${styles.accentWindows}`}
          style={{ background: windows?.light ?? "#1f6fe5" }}
          title="Windows accent color"
          aria-label="Windows accent color"
          disabled={disabled}
          onClick={() => setAccent("windows")}
        >
          <svg viewBox="0 0 16 16" aria-hidden>
            <path d="M2 3.5l5-.7v4.7H2zM7.8 2.7L14 2v5.5H7.8zM2 8.5h5v4.7l-5-.7zM7.8 8.5H14V14l-6.2-.8z" />
          </svg>
        </button>
        <span className={styles.accentGap} />
        {PRESETS.map((p) => (
          <button
            key={p.color}
            type="button"
            role="radio"
            aria-checked={accent === p.color}
            className={styles.paletteSwatch}
            style={{ background: p.color }}
            title={p.name}
            aria-label={p.name}
            disabled={disabled}
            onClick={() => setAccent(p.color)}
          />
        ))}
      </div>
      <span className={styles.help}>{caption}</span>
    </div>
  );
}
