import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useDoc } from "../editor/docStore";
import { ColorPicker } from "./ColorPicker";
import { boxOf, useMenuPlacement } from "./menuPlacement";
import { usePopover } from "./usePopover";
import styles from "./options.module.css";

interface Props {
  /** "#rrggbb". */
  value: string;
  /** For screen readers and the tooltip ("Top colour"). */
  name: string;
  /** Apply a colour (live, while the picker is open). */
  onPick: (hex: string) => void;
}

/**
 * A colour in the options bar: a swatch that opens Vandal's picker (without its presets). Colours
 * apply as they're picked, and the whole visit is one undo step: Done, Enter or a click elsewhere
 * keeps it, Esc puts it back.
 */
export function ColorSwatch({ value, name, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useMenuPlacement(open, menuRef, () => boxOf(swatchRef.current));
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  });

  const show = () => {
    useDoc.getState().beginGesture();
    setOpen(true);
  };
  const close = (keep: boolean) => {
    // Esc: back to the colour before, and no undo step.
    if (!keep) useDoc.getState().cancelGesture();
    setOpen(false);
  };
  usePopover(open, rootRef, close, "keep");
  // Gone while open (the tool put down): what was picked stays, as one step.
  useEffect(() => {
    if (!open) return;
    return () => useDoc.getState().endGesture();
  }, [open]);

  return (
    <div ref={rootRef} className={styles.dropdownRoot}>
      <button
        ref={swatchRef}
        type="button"
        className={styles.swatch}
        style={{ background: value } as CSSProperties}
        aria-label={name}
        title={name}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? close(true) : show())}
      />
      {open && (
        <div
          ref={menuRef}
          className={`${styles.menu} ${styles.colorMenu}`}
          role="dialog"
          aria-label={name}
        >
          <ColorPicker value={value} onChange={(c) => onPickRef.current(c)} />
          <div className={styles.colorActions}>
            <button type="button" className={styles.accentButton} onClick={() => close(true)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
