// Export, as the buttons, menus and Ctrl+E invoke it: the document's clips to Rust (export.rs),
// which asks where to save, renders, and reports progress (`ExportProgress`, `ExportEnded`).
// The markup goes first, each item drawn and its pixels sent (drawMarks.ts, markup.rs).
import { drawMarks } from "../markup/drawMarks";
import { playheadFrame } from "../markup/model/store";
import { commands, uploadPixels, type ExportMark } from "../shared/ipc";
import { clipStarts, type ClipId, type Doc } from "./doc";
import { useDoc } from "./docStore";
import { growColour, outputSize, type Side } from "./frame";
import { checkMarkup } from "./markupCheck";

export type ExportFormat = "mp4" | "gif";

/**
 * The clips as export reads them, in timeline order: their numbers, source frames, whether
 * they're heard (the track's mute mutes them all), and where they start on the timeline (which
 * the markup's frames count on).
 */
export function exportClips(doc: Doc) {
  const starts = clipStarts(doc);
  return doc.clips.map((c, i) => ({
    id: c.id,
    in: c.in,
    out: c.out,
    muted: doc.muted || !!c.muted,
    start: starts[i],
  }));
}

/** The project's frame as export reads it: the crop, and each side's grow in its colour. */
export function exportFrame(doc: Doc) {
  const { crop, grow } = doc.frame;
  const side = (s: Side) => ({ size: grow[s], colour: growColour(grow, s) });
  return {
    crop,
    grow: { top: side("top"), bottom: side("bottom"), left: side("left"), right: side("right") },
  };
}

/**
 * The markup, each item drawn and its pixels sent to Rust for the export about to start: the
 * items as the export command names them, back to front. In development, checked against the
 * preview (markupCheck.ts).
 */
async function sendMarkup(doc: Doc): Promise<ExportMark[]> {
  const drawn = await drawMarks(doc);
  await Promise.all(
    drawn.map((m) => uploadPixels(`http://media.localhost/markup/${m.id}`, m.pixels)),
  );
  if (import.meta.env.DEV) {
    void checkMarkup(drawn, playheadFrame(), outputSize(doc.frame)).catch((e: unknown) =>
      console.error("[markup check]", e),
    );
  }
  return drawn.map(({ id, x, y, width, height, start, end }) => ({
    id,
    x,
    y,
    width,
    height,
    start,
    end,
  }));
}

/** Runs `start` with the markup sent; if it can't be, says so in the console. */
function withMarkup(doc: Doc, start: (marks: ExportMark[]) => Promise<unknown>) {
  sendMarkup(doc)
    .then(start)
    .catch((e: unknown) => console.error("[export] markup:", e));
}

/** The whole timeline, as one file (Ctrl+E: MP4). */
export function exportTimeline(format: ExportFormat = "mp4") {
  const { doc } = useDoc.getState();
  withMarkup(doc, (marks) =>
    commands.export(exportClips(doc), exportFrame(doc), marks, null, format),
  );
}

/** One clip, as its own file. */
export function exportClip(id: ClipId, format: ExportFormat = "mp4") {
  const { doc } = useDoc.getState();
  const clips = exportClips(doc).filter((c) => c.id === id);
  if (!clips.length) return;
  withMarkup(doc, (marks) => commands.export(clips, exportFrame(doc), marks, id, format));
}

/** Each clip as its own file, into a folder. */
export function exportEach(format: ExportFormat = "mp4") {
  const { doc } = useDoc.getState();
  withMarkup(doc, (marks) =>
    commands.exportEach(exportClips(doc), exportFrame(doc), marks, format),
  );
}

/** A GIF this big (bytes) gets a word about its size. */
export const LARGE_GIF = 10 * 1024 * 1024;

/** A file size for people: "840 KB", "12.4 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
