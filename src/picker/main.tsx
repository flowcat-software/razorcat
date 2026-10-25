import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./picker.css";
import { blockBrowserUi } from "../shared/browserUi";
import { startAppearanceSync } from "../shared/appearance";
import { startLog } from "../shared/log";
import { PickerApp } from "./PickerApp";

startLog("picker");
blockBrowserUi();
startAppearanceSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PickerApp />
  </StrictMode>,
);
