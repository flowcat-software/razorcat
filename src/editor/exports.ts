// Export, as the buttons, menus and Ctrl+E invoke it: the document's clips to Rust (export.rs),
// which asks where to save, renders, and reports progress (`ExportProgress`, `ExportEnded`).
// The markup goes first, each item drawn and its pixels sent (drawMarks.ts, markup.rs), and the
// spotlights' darkness on each run of them (spotlights.ts) and the redactions (PLAN 4.8b), which
// Rust makes.
import { drawMarks } from "../markup/drawMarks";
import { playheadFrame } from "../markup/model/store";
import { commands, uploadPixels, type ExportMark } from "../shared/ipc";
import {
  clipLength,
  clipStarts,
  crossfades,
  fadeColours,
  fadesOf,
  markFades,
  shownMarks,
  type ClipId,
  type Doc,
} from "./doc";
import { useDoc } from "./docStore";
import { isNormal, sourceFrame, speedOf, videoEnd } from "./speed";
import { darkLayer } from "./spotlights";
import { redactBox, redactStrength } from "./redactions";
import { growColour, outputSize, type Side } from "./frame";
import { checkMarkup } from "./markupCheck";
import type { MenuItems } from "./Menu";

export type ExportFormat = "mp4" | "gif";

/**
 * The clips as export reads them (`ids` of them, or all), in timeline order: their numbers, files
 * and source frames, their speed if not 100% (PLAN §7, Clip speed), whether they're heard (the track's mute mutes them all), where they start
 * on the timeline (which the markup's frames count on), their fades as they take effect (PLAN
 * 4.7a) and their colours (4.7c), and their crossfades with the clip before (4.7b), if that one's exported with them.
 */
export function exportClips(doc: Doc, ids?: readonly ClipId[]) {
  const starts = clipStarts(doc);
  const xf = crossfades(doc);
  const picked = (i: number) => !ids || ids.includes(doc.clips[i].id);
  return doc.clips.flatMap((c, i) =>
    picked(i)
      ? [
          {
            id: c.id,
            source: c.source,
            // Its source frames (at another speed, those its video spans), and its speed then.
            in: sourceFrame(c, c.in),
            out: videoEnd(c),
            speed: isNormal(speedOf(c))
              ? null
              : { ...speedOf(c), phase: c.phase ?? 0, first: c.in, length: clipLength(c) },
            muted: doc.muted || !!c.muted,
            start: starts[i],
            ...fadesOf(doc, i),
            fadeInColour: fadeColours(c).fadeIn,
            fadeOutColour: fadeColours(c).fadeOut,
            crossfade: i > 0 && picked(i - 1) ? xf[i] : 0,
          },
        ]
      : [],
  );
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
  const dark = darkLayer(doc);
  const items = drawn.map(({ id, x, y, width, height, start, end, layer }): ExportMark => {
    const mark = doc.marks.find((m) => m.id === id);
    // A hole's fades are its own but where the darkness's are (spotlights.ts).
    const hole = layer === "hole" ? dark?.holes.get(id) : undefined;
    const fades = hole ?? markFades(mark ?? {}, end - start);
    const { fadeIn, fadeOut } = fades;
    return { id, x, y, width, height, start, end, fadeIn, fadeOut, layer: { kind: layer } };
  });
  const frame = outputSize(doc.frame);
  const runs = (dark?.runs ?? []).map((r): ExportMark => ({
    id: 0,
    x: 0,
    y: 0,
    ...frame,
    ...r,
    layer: { kind: "dark", dim: dark?.dim ?? 0 },
  }));
  return [...redactions(doc), ...items, ...runs];
}

/** The redactions (PLAN 4.8b): each box, as the preview cuts it, and how it hides what's under. */
function redactions(doc: Doc): ExportMark[] {
  const frame = outputSize(doc.frame);
  return shownMarks(doc).flatMap((m): ExportMark[] => {
    const o = doc.marks.find((k) => k.id === m.id)?.object;
    if (o?.kind !== "redact") return [];
    const box = redactBox(o.rect, frame);
    if (!box) return [];
    const mode = o.mode === "pixelate" ? "pixelate" : "blur";
    const { id, start, end } = m;
    const strength = redactStrength(mode, o.strength);
    return [
      { id, ...box, start, end, fadeIn: 0, fadeOut: 0, layer: { kind: "redact", mode, strength } },
    ];
  });
}

/** Told when an export can't start here, before Rust has it (the editor's status bar). */
let failed: (message: string) => void = () => {};

export function onExportFailed(report: (message: string) => void) {
  failed = report;
}

/** Run before every export: the first one asks about a default folder (the editor's). */
let beforeExport: () => Promise<void> = () => Promise.resolve();

export function onBeforeExport(ask: () => Promise<void>) {
  beforeExport = ask;
}

/**
 * A folder setting as a person reads it: under the profile, from there (`Videos\Razorcat`);
 * elsewhere, as it is.
 */
export function folderLabel(setting: string): string {
  const profile = /^%USERPROFILE%\\/i;
  return profile.test(setting) ? setting.replace(profile, "") : setting;
}

/** Runs `start` with the markup sent; if it can't be, says why. */
function withMarkup(doc: Doc, start: (marks: ExportMark[]) => Promise<unknown>) {
  beforeExport()
    .then(() => sendMarkup(doc))
    .then(start)
    .catch((e: unknown) => {
      console.error("[export] markup:", e);
      failed(`The export couldn't start: ${e instanceof Error ? e.message : String(e)}`);
    });
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
  const clips = exportClips(doc, [id]);
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

/**
 * Clips `ids` as one file, joined in timeline order (PLAN 4.5f3), named as the timeline's export
 * (one clip: as that clip's).
 */
export function exportClipsJoined(ids: readonly ClipId[], format: ExportFormat = "mp4") {
  const { doc } = useDoc.getState();
  const clips = exportClips(doc, ids);
  if (!clips.length) return;
  const one = clips.length === 1 ? clips[0].id : null;
  withMarkup(doc, (marks) => commands.export(clips, exportFrame(doc), marks, one, format));
}

/** Clips `ids` each as its own file, into a folder (PLAN 4.5f3). */
export function exportEachOf(ids: readonly ClipId[], format: ExportFormat = "mp4") {
  const { doc } = useDoc.getState();
  const clips = exportClips(doc, ids);
  if (!clips.length) return;
  withMarkup(doc, (marks) => commands.exportEach(clips, exportFrame(doc), marks, format));
}

/**
 * The export menu's items for several selected clips (the timeline's right-click menu and its
 * toolbar): as one file, joined, or a file each; `prefix` starts each label.
 */
export function clipsExportItems(ids: readonly ClipId[], prefix = "Export clips"): MenuItems {
  const formats = ["mp4", "gif"] as const;
  return [
    ...formats.map((f) => ({
      label: `${prefix} as one ${f.toUpperCase()}…`,
      run: () => exportClipsJoined(ids, f),
    })),
    "-",
    ...formats.map((f) => ({
      label: `${prefix} as separate ${f.toUpperCase()}s…`,
      run: () => exportEachOf(ids, f),
    })),
  ];
}

/** A GIF this big (bytes) gets a word about its size. */
export const LARGE_GIF = 10 * 1024 * 1024;

export { fileSize } from "../shared/fileSize";
