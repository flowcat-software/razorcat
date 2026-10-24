// The editor's actions in the log (PLAN C1), so a crash report shows what led up to it. Every
// edit of the document is a named method of the store (`split`, `trim`, `addMark`...): each is
// wrapped once to log its name and the document's counts when it changed something. A drag is
// one line at its end. Never the arguments: they hold text and places.

import { logLine } from "../shared/log";
import type { Doc } from "./doc";
import { useDoc, type DocState } from "./docStore";
import { useTool } from "./toolStore";

/** Methods that only select, or set what isn't the document; and gestures, logged as drags. */
const QUIET = new Set([
  "select",
  "selectClips",
  "selectRange",
  "selectMarks",
  "setPendingIn",
  "setOptions",
  "beginGesture",
]);

const counts = (doc: Doc) =>
  `${doc.clips.length} clips, ${doc.marks.length} markup, ${doc.ranges.length} ranges, ` +
  `${doc.sources.length} files`;

/** Starts logging the editor's edits and tool changes. Once, at startup. */
export function logActions() {
  // The first edit of the drag under way, logged when it ends.
  let drag: string | null = null;
  const wrapped: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(useDoc.getState())) {
    if (typeof method !== "function" || QUIET.has(name)) continue;
    wrapped[name] = (...args: unknown[]) => {
      const before = useDoc.getState();
      const result: unknown = (method as (...a: unknown[]) => unknown)(...args);
      const after = useDoc.getState();
      if (name === "endGesture") {
        if (drag && after.doc !== before.gestureStart) {
          logLine(`[edit] ${drag} (drag) · ${counts(after.doc)}`);
        }
        drag = null;
      } else if (name === "cancelGesture") {
        if (drag) logLine(`[edit] ${drag} (drag cancelled)`);
        drag = null;
      } else if (after.doc !== before.doc) {
        if (before.gestureStart) drag ??= name;
        else logLine(`[edit] ${name} · ${counts(after.doc)}`);
      }
      return result;
    };
  }
  useDoc.setState(wrapped as Partial<DocState>);
  useTool.subscribe((s, prev) => {
    if (s.tool !== prev.tool) logLine(`[tool] ${s.tool}`);
  });
}
