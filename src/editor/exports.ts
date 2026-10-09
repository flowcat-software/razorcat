// Export, as the buttons, menus and Ctrl+E invoke it: the document's clips to Rust (export.rs),
// which asks where to save, renders, and reports progress (`ExportProgress`, `ExportEnded`).
import { commands } from "../shared/ipc";
import type { ClipId, Doc } from "./doc";
import { useDoc } from "./docStore";
import { growColour, type Side } from "./frame";

export type ExportFormat = "mp4" | "gif";

/** The clips as export reads them: their numbers and source frames, in timeline order. */
export const exportClips = (doc: Doc) => doc.clips.map((c) => ({ id: c.id, in: c.in, out: c.out }));

/** The project's frame as export reads it: the crop, and each side's grow in its colour. */
export function exportFrame(doc: Doc) {
  const { crop, grow } = doc.frame;
  const side = (s: Side) => ({ size: grow[s], colour: growColour(grow, s) });
  return {
    crop,
    grow: { top: side("top"), bottom: side("bottom"), left: side("left"), right: side("right") },
  };
}

/** The whole timeline, as one file (Ctrl+E: MP4). */
export function exportTimeline(format: ExportFormat = "mp4") {
  const { doc } = useDoc.getState();
  void commands.export(exportClips(doc), exportFrame(doc), null, format);
}

/** One clip, as its own file. */
export function exportClip(id: ClipId, format: ExportFormat = "mp4") {
  const { doc } = useDoc.getState();
  const clips = exportClips(doc).filter((c) => c.id === id);
  if (clips.length) void commands.export(clips, exportFrame(doc), id, format);
}

/** Each clip as its own file, into a folder. */
export function exportEach(format: ExportFormat = "mp4") {
  const { doc } = useDoc.getState();
  void commands.exportEach(exportClips(doc), exportFrame(doc), format);
}

/** A GIF this big (bytes) gets a word about its size. */
export const LARGE_GIF = 10 * 1024 * 1024;

/** A file size for people: "840 KB", "12.4 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
