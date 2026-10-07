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
  return facts;
}
