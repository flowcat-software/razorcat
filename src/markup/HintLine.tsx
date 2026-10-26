import { Fragment, useEffect, useRef } from "react";
import { useDoc as useEdit } from "../editor/docStore";
import { useDoc } from "./model/store";
import { useHintScroll } from "./hintScroll";
import { chooseHint, parseHint, useHintSources, withShortcuts, type ControlHint } from "./hints";
import { colorSlots, styleTarget, targetSections, targetValues } from "./restyle";
import { useStyleConfig } from "./styles";
import { useToolStore } from "./toolStore";
import styles from "./markup.module.css";

/** Marks a control for the hint line: `<button {...hint("copy")}>`. */
export function hint(id: ControlHint): { "data-hint": ControlHint } {
  return { "data-hint": id };
}

/**
 * The status bar's hint line (PLAN 2A.6e; Razorcat 4.6b): the keys that do something right
 * now. Off with `markup.showShortcutHints`, but for why a key did nothing. One too long to fit
 * scrolls to show the rest when the pointer rests (`scroll`; Razorcat).
 */
export function HintLine({ scroll = false }: { scroll?: boolean }) {
  const line = useRef<HTMLSpanElement>(null);
  const { said, hover, drag, mode, overObject, overRedactedWord } = useHintSources();
  // What's selected on the timeline (Razorcat).
  const clips = useEdit((s) => s.selectedClips.length);
  const range = useEdit((s) => s.selectedRange !== null);
  const marks = useEdit((s) => s.selectedMarks.length);
  const pendingIn = useEdit((s) => s.pendingIn !== null);
  const tool = useToolStore((s) => s.tool);
  const typing = useToolStore((s) => s.editing !== null);
  const selected = useDoc((s) => s.selection.length);
  const textSelected = useDoc(
    (s) =>
      s.selection.length === 1 &&
      s.doc.annotations.find((a) => a.id === s.selection[0])?.kind === "text",
  );
  const segmentSelected = useDoc((s) => {
    if (s.selection.length !== 1) return false;
    const kind = s.doc.annotations.find((a) => a.id === s.selection[0])?.kind;
    return kind === "line" || kind === "arrow";
  });
  const stepSelected = useDoc(
    (s) =>
      s.selection.length === 1 &&
      s.doc.annotations.find((a) => a.id === s.selection[0])?.kind === "step",
  );
  const calloutSelected = useDoc((s) => {
    const id = s.selection.length === 1 ? s.selection[0] : null;
    return !!id && s.doc.annotations.find((a) => a.id === id)?.kind === "callout";
  });
  const labelTyping = useToolStore((s) => s.labelEditing !== null);
  // Redact's Detect text (Vandal's) isn't in Razorcat.
  const redactText = false;
  const config = useStyleConfig();
  // For naming the second color only when there is one.
  const doc = useDoc((s) => s.doc);
  const selection = useDoc((s) => s.selection);
  // Selected on the timeline, off the playhead: styled here too.
  const offstage = useDoc((s) => s.offstage);
  const editing = useToolStore((s) => s.editing?.id ?? null);
  useToolStore((s) => s.fills);
  useToolStore((s) => s.textBackground);
  const target = styleTarget(doc, selection, tool, editing, offstage);
  const values = target && targetValues(target, doc);
  const twoColors =
    !!target && !!values && colorSlots(values, targetSections(target)).second !== null;

  // Whatever control is under the pointer, found by its data-hint.
  useEffect(() => {
    const onOver = (e: PointerEvent) => {
      // Dragging across a control (e.g. a slider thumb leaving it) keeps the hint.
      if (e.buttons) return;
      const el = (e.target as Element | null)?.closest?.("[data-hint]");
      const id = (el?.getAttribute("data-hint") ?? null) as ControlHint | null;
      if (useHintSources.getState().hover !== id) useHintSources.setState({ hover: id });
    };
    const onLeave = () => useHintSources.setState({ hover: null });
    window.addEventListener("pointerover", onOver);
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      window.removeEventListener("pointerover", onOver);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, []);

  const text = withShortcuts(
    chooseHint({
      said,
      hover,
      drag,
      mode,
      tool,
      selected,
      textSelected,
      segmentSelected,
      stepSelected,
      calloutSelected,
      labelTyping,
      typing,
      overObject,
      twoColors,
      drawingToolsSelect: config.drawingToolsSelect,
      redactText,
      overRedactedWord,
      timeline: { clips, range, marks, pendingIn },
    }),
    config.shortcuts,
  );
  useHintScroll(line, text, scroll && !said);

  if (!config.showShortcutHints && !said) return null;
  return (
    <span ref={line} className={styles.hintLine} data-said={said ? "" : undefined}>
      {parseHint(text).map((part, i) =>
        "text" in part ? (
          <Fragment key={i}>{part.text}</Fragment>
        ) : (
          <span key={i} className={styles.keys}>
            {part.keys.map((k, j) => (
              <Fragment key={j}>
                {j > 0 && "+"}
                <kbd>{k}</kbd>
              </Fragment>
            ))}
          </span>
        ),
      )}
    </span>
  );
}
