import { useEffect, useRef } from "react";
import styles from "./EditorApp.module.css";

/** A menu item: what it says, its key (shown on the right), and what it does. */
export interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

/** Items, with "-" for a divider. */
export type MenuItems = (MenuItem | "-")[];

interface Props {
  items: MenuItems;
  /** Where its top-left goes (viewport pixels); kept on screen. */
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * A popup menu (the mockup's): a press outside it, Escape, or picking an item closes it.
 */
export function Menu({ items, x, y, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      // Kept on screen.
      const r = el.getBoundingClientRect();
      el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
      el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
    }
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    // Capture: before the press does anything else (the timeline would scrub).
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [x, y, onClose]);
  return (
    <div ref={ref} className={styles.menu} role="menu" style={{ left: x, top: y }}>
      {items.map((it, i) =>
        it === "-" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <small>{it.hint}</small>}
          </button>
        ),
      )}
    </div>
  );
}
