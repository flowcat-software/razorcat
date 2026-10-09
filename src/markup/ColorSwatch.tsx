import { useEffect, useRef, useState, type CSSProperties } from "react";
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
  /** The picker opened: what follows is one change (the editor's undo step). */
  onOpen?: () => void;
  /** It closed: `keep` what was picked, or (Esc) put the colour back. */
  onClose?: (keep: boolean) => void;
}

/**
 * A colour: a swatch that opens Vandal's picker (without its presets). Colours apply as they're
 * picked; Done, Enter or a click elsewhere keeps the colour, Esc puts it back (the host's
 * `onClose`: the editor makes the visit one undo step).
 */
export function ColorSwatch({ value, name, onPick, onOpen, onClose }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useMenuPlacement(open, menuRef, () => boxOf(swatchRef.current));
  const onPickRef = useRef(onPick);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onPickRef.current = onPick;
    onCloseRef.current = onClose;
  });
  /** How it closed, for the effect below (Esc: not kept). */
  const kept = useRef(true);

  const show = () => {
    kept.current = true;
    onOpen?.();
    setOpen(true);
  };
  const close = (keep: boolean) => {
    kept.current = keep;
    setOpen(false);
  };
  usePopover(open, rootRef, close, "keep");
  // Closed, or gone while open (the tool put down: what was picked stays).
  useEffect(() => {
    if (!open) return;
    return () => onCloseRef.current?.(kept.current);
  }, [open]);

  return (
    <div ref={rootRef} className={styles.dropdownRoot}>
      <button
        ref={swatchRef}
        type="button"
        className={styles.colorSwatch}
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
