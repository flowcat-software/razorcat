import type { ReactNode } from "react";
import { hint } from "./HintLine";
import { KeysField } from "./KeysField";
import type { KeysAnnotation, KeysLook } from "./model/types";
import { NumberPickerControl } from "./NumberPickerControl";
import { TEXT_SIZE_ICON } from "./pickerIcons";
import { applyStyle, beginStyleDrag, endStyleDrag, type TargetValues } from "./restyle";
import { useStyleConfig } from "./styles";
import styles from "./options.module.css";

const LOOKS: { id: KeysLook; label: string; icon: ReactNode }[] = [
  {
    id: "caps",
    label: "Key caps",
    icon: (
      <>
        <rect x="3" y="7" width="8" height="9" rx="2" />
        <rect x="13" y="7" width="8" height="9" rx="2" />
        <path d="M4 18.5h6M14 18.5h6" fill="none" />
      </>
    ),
  },
  {
    id: "bar",
    label: "Caps on a bar",
    icon: (
      <>
        <rect className={styles.solid} x="1.5" y="5" width="21" height="14" rx="3" opacity="0.3" />
        <rect x="4.5" y="8" width="6.5" height="8" rx="1.5" />
        <rect x="13" y="8" width="6.5" height="8" rx="1.5" />
      </>
    ),
  },
  {
    id: "pill",
    label: "Pill",
    icon: (
      <>
        <rect className={styles.solid} x="1.5" y="7" width="21" height="10" rx="5" opacity="0.3" />
        <path d="M6.5 12h11" />
      </>
    ),
  },
  {
    id: "outline",
    label: "Outlined",
    icon: (
      <>
        <rect x="3" y="7" width="8" height="10" rx="2" fill="none" />
        <rect x="13" y="7" width="8" height="10" rx="2" fill="none" />
      </>
    ),
  },
];

interface Props {
  keys: NonNullable<TargetValues["keys"]>;
  /** The keys mark selected, alone: its keys can be changed. */
  mark: KeysAnnotation | null;
  hints: boolean;
  /** Digit badges on the size picker (a digit is held). */
  showKeys: boolean;
}

/** A keys mark's options (PLAN 5b.6c): its keys, look and size (its colour is with the others). */
export function KeysOptions({ keys, mark, hints, showKeys }: Props) {
  const config = useStyleConfig();
  return (
    <>
      {mark && (
        <div className={styles.section}>
          <KeysField mark={mark} />
        </div>
      )}
      <div className={styles.section}>
        <div className={styles.group} {...hint("keys.look")}>
          {LOOKS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={styles.toggle}
              aria-pressed={keys.look === l.id}
              aria-label={l.label}
              title={l.label}
              onClick={() => applyStyle({ keysLook: l.id })}
            >
              <svg viewBox="0 0 24 24" aria-hidden>
                {l.icon}
              </svg>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.section}>
        <span className={styles.hintArea} {...hint("size")}>
          <NumberPickerControl
            icon={TEXT_SIZE_ICON}
            picker={config.styles.keysSize}
            value={keys.size}
            unit="px"
            label="Keys size"
            showKeys={showKeys}
            hints={hints}
            onPick={(keysSize) => applyStyle({ keysSize })}
            onDragStart={beginStyleDrag}
            onDragEnd={endStyleDrag}
          />
        </span>
      </div>
    </>
  );
}
