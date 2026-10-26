import { useState, type ReactNode } from "react";
import {
  clickCount,
  clickSyncEffect,
  recordingStyleOf,
  type ClickStyle,
} from "../editor/clickStyles";
import { useDoc as useEdit } from "../editor/docStore";
import { doublesShown, useClickSettings } from "./clickSettings";
import { setRecordingClicks, syncClickStyles } from "./clickSync";
import { ConfirmButton } from "./ConfirmButton";
import { Dropdown } from "./Dropdown";
import { hint } from "./HintLine";
import type { ClickButton, ClickLook } from "./model/types";
import { NumberPickerControl } from "./NumberPickerControl";
import { MARKER_SIZE_ICON } from "./pickerIcons";
import { timelineFps } from "./model/store";
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
      {/* Unlocked, clicks can drift apart: ways to bring them in line (PLAN 5b.6h). */}
      {!locked && (
        <div className={styles.section}>
          <SyncClicks style={{ look: click.look, size: click.size }} />
          <SetRecordingStyle />
        </div>
      )}
    </>
  );
}

/**
 * Gives every click the style on show, after asking: it undoes work when they differ. Can also
 * make it Recording's, so new recordings match.
 */
function SyncClicks({ style }: { style: ClickStyle }) {
  const doc = useEdit((s) => s.doc);
  const recorded = useClickSettings();
  const [alsoRecording, setAlsoRecording] = useState(false);
  const effect = clickSyncEffect(doc, style);
  const n = clickCount(doc);
  const recordingHasIt = recorded.look === style.look && recorded.size === style.size;
  return (
    <ConfirmButton
      label="Sync style"
      hintId="click.syncStyles"
      disabled={effect === "none"}
      question={
        effect === "mixed"
          ? `Your clicks have different styles. Give all ${n} of them this style?`
          : n === 1
            ? "Give the click this style?"
            : `Give all ${n} clicks this style?`
      }
      extra={
        !recordingHasIt && (
          <label className={styles.confirmCheck}>
            <input
              type="checkbox"
              checked={alsoRecording}
              onChange={(e) => setAlsoRecording(e.target.checked)}
            />
            Also use it for new recordings
          </label>
        )
      }
      onConfirm={() => {
        syncClickStyles(style);
        if (alsoRecording && !recordingHasIt) void setRecordingClicks(style);
        setAlsoRecording(false);
      }}
    />
  );
}

/** A camcorder: what's recorded. */
const RECORDING_ICON = (
  <>
    <rect x="3" y="6.5" width="12.5" height="11" rx="2" />
    <path d="M15.5 10.5 21 7.5v9l-5.5-3" />
  </>
);

/**
 * Makes the one selected click's style, size, length and fades Settings › Recording's (asked
 * first: a setting can't be undone), so a click adjusted by eye sets how recordings show them.
 */
function SetRecordingStyle() {
  const doc = useEdit((s) => s.doc);
  const selected = useEdit((s) => s.selectedMarks);
  const recorded = useClickSettings();
  const mark =
    selected.length === 1
      ? doc.marks.find((m) => m.id === selected[0] && m.object.kind === "click")
      : undefined;
  const style = mark ? recordingStyleOf(mark, timelineFps()) : null;
  const same =
    style !== null &&
    style.look === recorded.look &&
    style.size === recorded.size &&
    style.seconds === recorded.seconds &&
    style.fadeIn === recorded.fadeIn &&
    style.fadeOut === recorded.fadeOut;
  return (
    <ConfirmButton
      label="Set recording style"
      hintId="click.setRecordingStyle"
      icon={RECORDING_ICON}
      title={
        !style
          ? "Select one click to make its style Settings › Recording's"
          : same
            ? "Settings › Recording's clicks already look and last like this one"
            : undefined
      }
      disabled={!style || same}
      undoable={false}
      question={
        style &&
        "Make this click's style the default for recordings? New recordings' clicks will match its style, size, duration and fades."
      }
      onConfirm={() => style && void setRecordingClicks(style)}
    />
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
