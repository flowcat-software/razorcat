import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import { blockBrowserUi } from "../shared/browserUi";
import { startAppearanceSync } from "../shared/appearance";
import { startLog } from "../shared/log";
import { RecorderApp } from "./RecorderApp";

startLog("recorder");
blockBrowserUi();
startAppearanceSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RecorderApp />
  </StrictMode>,
);
