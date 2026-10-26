import type { ReactNode } from "react";
import { hint } from "./HintLine";
import type { ClickLook } from "./model/types";
import { NumberPickerControl } from "./NumberPickerControl";
import { MARKER_SIZE_ICON } from "./pickerIcons";
import { applyStyle, beginStyleDrag, endStyleDrag, type TargetValues } from "./restyle";
import { useStyleConfig } from "./styles";
import styles from "./options.module.css";

const LOOKS: { id: ClickLook; label: string; icon: ReactNode }[] = [
  {
    id: "ring",
    label: "Ring and dot",
    icon: (
      <>
        <circle cx="12" cy="12" r="8" fill="none" />
        <circle cx="12" cy="12" r="2.5" />
      </>
    ),
  },
  {
    id: "halo",
    label: "Halo",
    icon: <circle cx="12" cy="12" r="7" opacity="0.55" />,
  },
  {
    id: "target",
    label: "Target",
    icon: (
      <>
        <circle cx="12" cy="12" r="5" fill="none" />
        <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" fill="none" />
      </>
    ),
  },
];

interface Props {
  click: NonNullable<TargetValues["click"]>;
  hints: boolean;
  /** Digit badges on the size picker (a digit is held). */
  showKeys: boolean;
}

/** A click mark's options (PLAN 5b.6b): its look and size (its colour is with the others). */
export function ClickOptions({ click, hints, showKeys }: Props) {
  const config = useStyleConfig();
  return (
    <>
      <div className={styles.section}>
        <div className={styles.group} {...hint("click.look")}>
          {LOOKS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={styles.toggle}
              aria-pressed={click.look === l.id}
              aria-label={l.label}
              title={l.label}
              onClick={() => applyStyle({ clickLook: l.id })}
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
            icon={MARKER_SIZE_ICON}
            picker={config.styles.clickSize}
            value={click.size}
            unit="px"
            label="Click size"
            showKeys={showKeys}
            hints={hints}
            onPick={(clickSize) => applyStyle({ clickSize })}
            onDragStart={beginStyleDrag}
            onDragEnd={endStyleDrag}
          />
        </span>
      </div>
    </>
  );
}
