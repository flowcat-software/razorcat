// The Click options bar's ways of bringing clicks in line (PLAN 5b.6h), while their styles
// aren't locked to Settings › Recording: Sync style, and Set recording style.

import { useDoc as useEdit } from "../editor/docStore";
import type { ClickStyle, RecordingClickStyle } from "../editor/clickStyles";
import { commands, type Settings } from "../shared/ipc";
import { useToolStore } from "./toolStore";

/** Sync style: every click mark in `style`, in one undo step. It becomes the tool's too. */
export function syncClickStyles(style: ClickStyle): void {
  useToolStore.setState({ clickLook: style.look, clickSize: style.size });
  useEdit.getState().restyleClicks(style);
}

/**
 * Settings › Recording's clicks look (and, given, last) as `style`: its click style and size,
 * and how long they show and their fades. Rust snaps the size to one the Click tool offers.
 */
export async function setRecordingClicks(style: ClickStyle | RecordingClickStyle): Promise<void> {
  const s = (await commands.getSettings()) as Settings;
  const timing =
    "seconds" in style
      ? { clickSeconds: style.seconds, clickFadeIn: style.fadeIn, clickFadeOut: style.fadeOut }
      : {};
  const result = await commands.updateSettings({
    ...s,
    recording: { ...s.recording, clickLook: style.look, clickSize: style.size, ...timing },
  });
  if (result.status === "error") console.error("[clicks] recording style:", result.error);
}
