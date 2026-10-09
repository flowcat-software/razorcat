import { useEffect, useRef, type RefObject } from "react";

let pickingFromScreen = false;
/** How many popovers are open. */
let openPopovers = 0;

/** A popover is open: its Enter and Esc come first (the picture tools' keys wait). */
export const isPopoverOpen = () => openPopovers > 0;

/** The eyedropper is picking: the popovers stay open whatever it does to focus or keys. */
export function setPickingFromScreen(on: boolean): void {
  pickingFromScreen = on;
}

/**
 * How the color popovers close while `open` (Vandal's): Enter keeps, Esc cancels (and puts no
 * tool down), and a click elsewhere or the window losing focus does `outside` (keep or cancel).
 */
export function usePopover(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  close: (keep: boolean) => void,
  outside: "keep" | "cancel",
): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    if (!open) return;
    openPopovers++;
    const onDown = (e: PointerEvent) => {
      if (pickingFromScreen || rootRef.current?.contains(e.target as Node)) return;
      closeRef.current(outside === "keep");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (pickingFromScreen) return;
      // A field being typed in applies its text first.
      if (e.key === "Enter" && document.activeElement instanceof HTMLInputElement)
        document.activeElement.blur();
      closeRef.current(e.key === "Enter");
    };
    const onBlur = () => {
      if (!pickingFromScreen) closeRef.current(outside === "keep");
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      openPopovers--;
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, rootRef, outside]);
}
