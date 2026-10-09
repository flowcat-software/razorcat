// The markup's style config from the app settings (Vandal's): the host passes each settings
// update in, and the installed fonts are read once.

import { commands, type Settings } from "../shared/ipc";
import { useStyleConfig } from "./styles";

export function applyStyleSettings(s: Settings): void {
  useStyleConfig.setState({
    styles: s.styles,
    shareColor: s.markup.shareColor,
    showShortcutHints: s.markup.showShortcutHints,
    showButtonUnits: s.markup.showButtonUnits,
    drawingToolsSelect: s.markup.drawingToolsSelect,
  });
}

/** The font picker's list (DirectWrite, cached in Rust). */
export function loadFonts(): void {
  void commands.listFonts().then((fonts) => useStyleConfig.setState({ fonts }));
}
