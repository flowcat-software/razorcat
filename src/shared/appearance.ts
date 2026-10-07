// Light / dark and the accent color. Until the settings window exists (scaffold 0.1d) both
// follow Windows: theme.css does light/dark from the system, and this sets the Windows accent
// and keeps it in step while the window is open.

import { onAccent } from "./accent";
import { commands, events, type WindowsAccent } from "./ipc";

function applyAccent(shades: WindowsAccent | null): void {
  const style = document.documentElement.style;
  if (!shades) {
    // theme.css's own accent (our blue).
    style.removeProperty("--accent");
    style.removeProperty("--on-accent");
    return;
  }
  style.setProperty("--accent", `light-dark(${shades.light}, ${shades.dark})`);
  style.setProperty(
    "--on-accent",
    `light-dark(${onAccent(shades.light)}, ${onAccent(shades.dark)})`,
  );
}

/** Follow the Windows accent in this window. */
export function startAppearanceSync(): void {
  void events.windowsAccentChanged.listen(({ payload }) => applyAccent(payload));
  void commands.windowsAccent().then(applyAccent);
}
