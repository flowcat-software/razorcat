import type { ReactNode } from "react";
import { doublesShown, useClickSettings } from "./clickSettings";
import { Dropdown } from "./Dropdown";
import { hint } from "./HintLine";
import type { ClickButton, ClickLook } from "./model/types";
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
  {
    id: "ripple",
    label: "Ripple",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" fill="none" opacity="0.45" />
        <circle cx="12" cy="12" r="5.5" fill="none" />
        <circle className={styles.solid} cx="12" cy="12" r="1.8" />
      </>
    ),
  },
];

/** The buttons a click can show, in Alt+1–3's order: a mouse's, left to right. */
export const BUTTONS: { id: ClickButton; label: string; icon: ReactNode }[] = [
  { id: "left", label: "Left click", icon: mouse("M12 4v6H6.5V9a5.5 5.5 0 0 1 5.5-5.5z") },
  { id: "middle", label: "Middle click", icon: mouse("M10.5 5h3v5h-3z") },
  { id: "right", label: "Right click", icon: mouse("M12 4v6h5.5V9A5.5 5.5 0 0 0 12 3.5z") },
];

/** A mouse, upright, the part `fill` drawn solid (the button). */
function mouse(fill: string): ReactNode {
  return (
    <>
      <rect x="6.5" y="3.5" width="11" height="17" rx="5.5" fill="none" />
      <path d="M6.5 10h11M12 3.5V10" fill="none" />
      <path className={styles.solid} d={fill} />
    </>
  );
}

/** Why there's no double-click to be had. */
const DOUBLES_OFF =
  "Double-clicks are off in Settings › Recording, and click styles are locked to it";

export const LOCKED_TO_RECORDING =
  "Locked to Settings › Recording: turn off “Lock click styles in the editor” there to change it here";

interface Props {
  click: NonNullable<TargetValues["click"]>;
  /** The look and size follow Settings › Recording (PLAN 5b.6d): shown, not changed here. */
  locked: boolean;
  hints: boolean;
  /** Digit badges on the size picker (a digit is held). */
  showKeys: boolean;
  /** Alt+digit badges on the buttons (Alt is held). */
  showButtonKeys: boolean;
}

/** "×2": a double-click (Richard: rings looked like the click styles). */
const DOUBLE_ICON = (
  <text
    className={styles.solid}
    x="12"
    y="18.5"
    textAnchor="middle"
    fontSize="18"
    fontWeight="700"
    stroke="none"
  >
    ×2
  </text>
);

/**
 * A click mark's options (PLAN 5b.6b): the button it shows (5b.6d: drawn in that button's colour
 * from Settings › Recording), whether it's a double-click, its look and its size.
 */
export function ClickOptions({ click, locked, hints, showKeys, showButtonKeys }: Props) {
  const config = useStyleConfig();
  const doubles = useClickSettings(doublesShown);
  return (
    <>
      <div className={styles.section}>
        <div className={styles.group} {...hint("click.button")}>
          {BUTTONS.map((b, i) => (
            <button
              key={b.id}
              type="button"
              className={styles.toggle}
              aria-pressed={click.button === b.id}
              aria-label={b.label}
              title={`${b.label} (Alt+${i + 1})`}
              onClick={() => applyStyle({ clickButton: b.id })}
            >
              <svg viewBox="0 0 24 24" aria-hidden>
                {b.icon}
              </svg>
              {showButtonKeys && <span className={styles.badge}>{i + 1}</span>}
            </button>
          ))}
        </div>
        {/* With the buttons: what the click was (Richard). Off, and not to be had, while a
            recording wouldn't show double-clicks (PLAN 5b.6d). */}
        <button
          type="button"
          className={styles.toggle}
          aria-pressed={click.double}
          aria-label="Double-click"
          title={doubles ? "Double-click: a second ring round it" : DOUBLES_OFF}
          disabled={!doubles}
          {...hint(doubles ? "click.double" : "click.doublesOff")}
          onClick={() => applyStyle({ clickDouble: !click.double })}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            {DOUBLE_ICON}
          </svg>
        </button>
      </div>
      <div className={styles.section}>
        <span
          className={locked ? styles.locked : undefined}
          title={locked ? LOCKED_TO_RECORDING : undefined}
          {...hint(locked ? "click.locked" : "click.look")}
        >
          <LookPicker look={click.look} disabled={locked} />
        </span>
      </div>
      <div
        className={`${styles.section} ${locked ? styles.locked : ""}`}
        title={locked ? LOCKED_TO_RECORDING : undefined}
      >
        <span
          className={styles.hintArea}
          {...hint(locked ? "click.locked" : "size")}
          inert={locked}
        >
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

/** The click style, in a menu with names: the round icons alone looked alike (Richard). */
function LookPicker({ look, disabled }: { look: ClickLook; disabled: boolean }) {
  const current = LOOKS.find((l) => l.id === look) ?? LOOKS[0];
  return (
    <Dropdown
      className={styles.dropdown}
      // Locked, why: its own title is the one shown, not the group's round it.
      title={disabled ? `Click style: ${LOCKED_TO_RECORDING}` : "Click style"}
      disabled={disabled}
      button={
        <>
          <svg className={styles.headIcon} viewBox="0 0 24 24" aria-hidden>
            {current.icon}
          </svg>
          <span>{current.label}</span>
        </>
      }
    >
      {(close) =>
        LOOKS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="menuitemradio"
            aria-checked={l.id === look}
            className={styles.menuRow}
            onClick={() => {
              applyStyle({ clickLook: l.id });
              close();
            }}
          >
            <svg className={styles.headIcon} viewBox="0 0 24 24" aria-hidden>
              {l.icon}
            </svg>
            <span className={styles.menuLabel}>{l.label}</span>
          </button>
        ))
      }
    </Dropdown>
  );
}
