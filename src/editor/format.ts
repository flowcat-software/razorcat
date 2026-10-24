// How the editor writes a source's facts: "1920 × 1080 · 29.97 fps · 3:52 · H.264 · 527 MB".

import type { SourceInfo } from "../shared/ipc";

/** Frames per second, to two decimals without trailing zeros: 30, 29.97, 23.98. */
export function formatRate(num: number, den: number): string {
  return `${Number((num / den).toFixed(2))} fps`;
}

/** A length in seconds as m:ss, or h:mm:ss from an hour. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A file size in KB, MB or GB (1000s, as Explorer's "size" column isn't; close enough). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** The facts the options bar shows for an open source. */
export function sourceFacts(s: SourceInfo): string[] {
  const facts = [
    `${s.width} × ${s.height}`,
    formatRate(s.rateNum, s.rateDen) + (s.variable ? " (variable)" : ""),
    formatDuration(s.duration),
    s.codec,
  ];
  if (s.audioTracks === 0) facts.push("No audio");
  else if (s.audioTracks > 1) facts.push(`${s.audioTracks} audio tracks`);
  facts.push(formatBytes(s.bytes));
  if (s.converted) facts.push("Converted to play here");
  return facts;
}

/** What the options bar says about the files (PLAN 5, the info bar): a name, its tooltip, facts. */
export interface FileInfo {
  name: string;
  title: string;
  facts: string[];
}

/**
 * The options bar's file info for what's selected (Richard, 2026-10-23). Nothing (`picked` the
 * selected clips' files, one per clip, empty): the one file's facts, or with several the
 * project's, which the first file sets. One file: its facts, how many clips, and how it's fitted
 * or timed if it isn't the project's size or rate. Several: how many clips from how many files,
 * and their names.
 */
export function fileInfo(sources: readonly SourceInfo[], picked: readonly SourceInfo[]): FileInfo {
  const first = sources[0];
  const names = (files: readonly SourceInfo[]) => files.map((f) => f.name);
  const files = [...new Set(picked)];
  if (!files.length) {
    if (sources.length <= 1) {
      return { name: first.name, title: first.path, facts: sourceFacts(first) };
    }
    return {
      name: "Project",
      title: names(sources).join("\n"),
      facts: [
        `${first.width} × ${first.height}`,
        formatRate(first.rateNum, first.rateDen),
        `${sources.length} files`,
      ],
    };
  }
  if (files.length > 1) {
    return {
      name: `${picked.length} clips from ${files.length} files`,
      title: names(files).join("\n"),
      facts: [names(files).join(", ")],
    };
  }
  const [file] = files;
  const facts = sourceFacts(file);
  if (file.width !== first.width || file.height !== first.height) {
    facts.push(`fitted into ${first.width} × ${first.height}`);
  }
  if (file.rateNum * first.rateDen !== first.rateNum * file.rateDen) {
    facts.push(`played at ${formatRate(first.rateNum, first.rateDen)}`);
  }
  return {
    name: file.name,
    title: file.path,
    facts: picked.length > 1 ? [`${picked.length} clips`, ...facts] : facts,
  };
}
