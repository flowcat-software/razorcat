// A keys mark's keys (PLAN 5b.6c), taken from the keyboard as Settings' shortcut fields take
// theirs: click the field (or place a mark), then press them. The first press replaces what was
// there, each one after is added ("Ctrl + C, Ctrl + V"); a click anywhere else is done. While it
// listens, every key is its: the editor's and the markup's keys stand aside (isCapturingKeys).

import Konva from "konva";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { hint } from "./HintLine";
import { docStore } from "./model/store";
import type { AnnotationId, KeysAnnotation } from "./model/types";
import styles from "./options.module.css";

/** The keys mark taking keys now, if one is. */
const useCapture = create<{ id: AnnotationId | null }>(() => ({ id: null }));

/** Starts taking keys for mark `id` (a keys mark just placed). */
export function captureKeys(id: AnnotationId): void {
  useCapture.setState({ id });
}

/** Whether a keys field is taking the keys: other key handlers leave them be. */
export function isCapturingKeys(): boolean {
  return useCapture.getState().id !== null;
}

/** The most presses one mark keeps (the latest). */
const MOST = 6;

/** Keys every layout names the same, as the recording names them (input.rs). */
const NAMES: Record<string, string> = {
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  ArrowLeft: "←",
  ArrowUp: "↑",
  ArrowRight: "→",
  ArrowDown: "↓",
  PrintScreen: "PrtScn",
  CapsLock: "Caps Lock",
};

const MODIFIERS = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/** A key's name, as a recording's keys are named; null for a modifier alone. */
export function keyNameOf(e: { code: string; key: string }): string | null {
  if (MODIFIERS.test(e.code)) return null;
  const letter = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit(\d)$/.exec(e.code)?.[1];
  if (letter) return letter;
  if (/^F\d{1,2}$/.test(e.code)) return e.code;
  const num = /^Numpad(\d)$/.exec(e.code)?.[1];
  if (num) return `Num ${num}`;
  if (NAMES[e.code]) return NAMES[e.code];
  // Another key: as the layout has it ("-", "[", ";").
  return e.key.length === 1 ? e.key.toUpperCase() : e.key || null;
}

/** The keys of a press: the modifiers held, in Windows' order, then the key. */
export function pressOf(e: {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string[] | null {
  const name = keyNameOf(e);
  if (!name) return null;
  const mods: [boolean, string][] = [
    [e.ctrlKey, "Ctrl"],
    [e.altKey, "Alt"],
    [e.shiftKey, "Shift"],
    [e.metaKey, "Win"],
  ];
  return [...mods.filter(([on]) => on).map(([, m]) => m), name];
}

/** `presses` with `press` pressed: replacing them if it's the first since the field started. */
export function withPress(presses: string[][], press: string[], first: boolean): string[][] {
  return first ? [press] : [...presses, press].slice(-MOST);
}

/** Whether press `e` is on a markup item (an annotation on the preview's stage). */
function onMarkup(e: PointerEvent): boolean {
  const stage = Konva.stages.find((s) => s.content.contains(e.target as Node));
  if (!stage) return false;
  stage.setPointersPositions(e);
  const at = stage.getPointerPosition();
  const shape = at && stage.getIntersection(at);
  return !!shape && (shape.hasName("annotation") || !!shape.findAncestor(".annotation"));
}

/** The press `down` starts goes nowhere: its pointer and mouse events, up to its click. */
function swallowClick(down: PointerEvent): void {
  const events = ["pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu"];
  const eat = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    // A click follows the left button only; the right ends with its menu.
    if (e.type === "click" || e.type === "contextmenu") done();
  };
  const done = () => {
    window.clearTimeout(timer);
    for (const t of events) window.removeEventListener(t, eat, true);
  };
  eat(down);
  for (const t of events) window.addEventListener(t, eat, true);
  // A press with no click (dragged off the window): don't eat the next one too.
  const timer = window.setTimeout(done, 1500);
}

export function KeysField({ mark }: { mark: KeysAnnotation }) {
  const capturing = useCapture((s) => s.id === mark.id);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!capturing) return;
    const id = mark.id;
    ref.current?.focus();
    const store = docStore.getState();
    // One undo step for all the keys taken.
    const own = !store.gestureStart;
    if (own) store.beginGesture();
    let first = true;
    const add = (press: string[] | null) => {
      if (!press) return;
      docStore
        .getState()
        .update(id, (a) =>
          a.kind === "keys" ? { ...a, presses: withPress(a.presses, press, first) } : a,
        );
      first = false;
    };
    const stop = () => useCapture.setState({ id: null });
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) add(pressOf(e));
    };
    // Windows sends Print Screen's release only.
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "PrintScreen") add(pressOf(e));
    };
    // A click elsewhere is done, and only that (Richard: it placed another mark, or selected).
    // A press on markup still selects or drags it: the mark itself, to move it after its keys.
    const away = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      if (!onMarkup(e)) swallowClick(e);
      stop();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("blur", stop);
      if (own) docStore.getState().endGesture();
      if (useCapture.getState().id === id) stop();
    };
  }, [capturing, mark.id]);

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      className={styles.keysField}
      data-capturing={capturing || undefined}
      aria-label="Keys shown"
      aria-pressed={capturing}
      onClick={() => useCapture.setState({ id: capturing ? null : mark.id })}
      {...hint("keys.field")}
    >
      {mark.presses.map((press, i) => (
        <span key={i} className={styles.keysPress}>
          {i > 0 && <span className={styles.keysComma}>,</span>}
          {press.map((k, j) => (
            <span key={j} className={styles.keysPress}>
              {j > 0 && <span className={styles.keysPlus}>+</span>}
              <kbd className={styles.keycap}>{k}</kbd>
            </span>
          ))}
        </span>
      ))}
      {capturing && <span className={styles.keysPrompt}>Press keys…</span>}
    </div>
  );
}
