// Export, as the buttons, menus and Ctrl+E invoke it: the document's clips to Rust (export.rs),
// which asks where to save, renders, and reports progress (`ExportProgress`, `ExportEnded`).
import { commands } from "../shared/ipc";
import type { ClipId, Doc } from "./doc";
import { useDoc } from "./docStore";

/** The clips as export reads them: their numbers and source frames, in timeline order. */
export const exportClips = (doc: Doc) => doc.clips.map((c) => ({ id: c.id, in: c.in, out: c.out }));

/** The whole timeline, as one MP4 (Ctrl+E). */
export function exportTimeline() {
  void commands.exportMp4(exportClips(useDoc.getState().doc), null);
}

/** One clip, as its own MP4. */
export function exportClip(id: ClipId) {
  const clips = exportClips(useDoc.getState().doc).filter((c) => c.id === id);
  if (clips.length) void commands.exportMp4(clips, id);
}

/** Each clip as its own MP4, into a folder. */
export function exportEach() {
  void commands.exportEachMp4(exportClips(useDoc.getState().doc));
}
