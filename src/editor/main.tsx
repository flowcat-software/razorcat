import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import { blockBrowserUi } from "../shared/browserUi";
import { startAppearanceSync } from "../shared/appearance";
import { startLog } from "../shared/log";
import { logActions } from "./actionLog";
import { EditorApp } from "./EditorApp";

startLog("editor");
logActions();
blockBrowserUi();
startAppearanceSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EditorApp />
  </StrictMode>,
);
