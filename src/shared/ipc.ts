// Typed IPC surface for the frontend. Always go through this module rather than raw `invoke`
// strings; `bindings.ts` is generated from the Rust commands.
import type { Settings as SettingsWire, SourceInfo as SourceInfoWire } from "./bindings";

export { commands, events } from "./bindings";
export type * from "./bindings";

/**
 * The wire types, tightened to what Rust actually sends:
 * - every field present: the structs are `#[serde(default)]` (so older files load), which
 *   specta renders as optional;
 * - `f64` as `number`: specta types it `number | null` because NaN serializes as null, but
 *   settings and source facts never contain NaN (validation replaces it). Array elements too.
 */
type Complete<T> = T extends readonly (infer U)[]
  ? Complete<NumberNotNull<U>>[]
  : T extends object
    ? { [K in keyof T]-?: Complete<NumberNotNull<Exclude<T[K], undefined>>> }
    : T;
type NumberNotNull<T> = [T] extends [number | null] ? (null extends T ? number : T) : T;

export type Settings = Complete<SettingsWire>;
export type SourceInfo = Complete<SourceInfoWire>;
/** The markup tools' pickers (styles.rs). */
export type StyleSettings = Settings["styles"];
export type NumberPicker = StyleSettings["width"];

/**
 * Sends raw pixels to Rust through the media protocol (not JSON IPC, PLAN §1): an item of
 * markup for the next export (protocol.rs, markup.rs). Vandal's.
 */
export async function uploadPixels(
  url: string,
  rgba: Uint8ClampedArray<ArrayBuffer>,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: rgba,
  });
  if (!res.ok) throw new Error(`Couldn't send the markup (HTTP ${res.status}).`);
}
