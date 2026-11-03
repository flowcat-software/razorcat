// Projects (PLAN PR2): Rust writes and reads the `.rct` file (project.rs); the page gives it the
// document to save, and takes back the one opened. A file's id is new each time it opens, so
// the document's are put right as it comes back.

import type { Doc } from "./doc";

/** A file the project opened: its id now, its length, and its name. */
export interface OpenedFile {
  id: string;
  frames: number;
  name: string;
}

/**
 * Project document `saved` (its JSON) showing `files`, opened in its order: with their ids now,
 * and the names of any whose length changed since it was saved (their clips may be off). Null
 * if it isn't a document of that many files.
 */
export function openedDoc(
  saved: string,
  files: readonly OpenedFile[],
): { doc: Doc; changed: string[] } | null {
  let doc: Doc;
  try {
    doc = JSON.parse(saved) as Doc;
  } catch {
    return null;
  }
  if (!Array.isArray(doc?.clips) || doc.sources?.length !== files.length) return null;
  const ids = new Map(doc.sources.map((s, i) => [s.id, files[i].id]));
  const changed = files.filter((f, i) => f.frames !== doc.sources[i].frames).map((f) => f.name);
  return {
    doc: {
      ...doc,
      sources: files.map((f) => ({ id: f.id, frames: f.frames })),
      clips: doc.clips.map((c) => ({ ...c, source: ids.get(c.source) ?? c.source })),
    },
    changed,
  };
}

/**
 * A project's view (PLAN PR6): the playhead, and the timeline's zoom and scroll (or fitted). Saved
 * beside the document, not in it: moving the playhead or zooming isn't an edit.
 */
export interface SavedView {
  playhead: number;
  /** Pixels per frame, and the frame at the left edge (timelineView.ts's `View`). */
  zoom: number;
  scroll: number;
  /** Fitted: it opens fitted to the window, whatever its width. */
  fitted: boolean;
}

/** The view saved with a project (`text`, its JSON), or null if there's none or it's damaged. */
export function savedView(text: string | null | undefined): SavedView | null {
  if (!text) return null;
  let v: Partial<Record<keyof SavedView, unknown>>;
  try {
    v = JSON.parse(text) as typeof v;
  } catch {
    return null;
  }
  const { playhead, zoom, scroll, fitted } = v ?? {};
  const ok =
    Number.isInteger(playhead) &&
    (playhead as number) >= 0 &&
    typeof zoom === "number" &&
    Number.isFinite(zoom) &&
    zoom > 0 &&
    typeof scroll === "number" &&
    Number.isFinite(scroll) &&
    typeof fitted === "boolean";
  return ok ? { playhead: playhead as number, zoom, scroll, fitted } : null;
}
