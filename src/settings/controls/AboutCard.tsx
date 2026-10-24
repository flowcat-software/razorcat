import { useEffect, useState } from "react";
import { getName } from "@tauri-apps/api/app";
import logo from "../../../assets/razorcat-icon-tray.png";
import pkg from "../../../package.json";
import { commands, type MediaTools } from "../../shared/ipc";
import type { AboutItem } from "../schema";
import type { ControlProps } from "./index";
import styles from "./controls.module.css";

/**
 * The version, with the build number and commit for `npm run build:local` builds:
 * "0.1.0+8 (2cf53f9, modified)". Dev builds show package.json's.
 */
function versionLabel(): string {
  const { VITE_BUILD_VERSION, VITE_BUILD_COMMIT, VITE_BUILD_MODIFIED } = import.meta.env;
  const version = VITE_BUILD_VERSION || pkg.version;
  const details = [VITE_BUILD_COMMIT, VITE_BUILD_MODIFIED && "modified"].filter(Boolean);
  return details.length ? `${version} (${details.join(", ")})` : version;
}

/** Settings › About: the logo, name and version, what the app is and who made it (a link to their site). */
export function AboutCard({ id }: ControlProps<AboutItem>) {
  // The product name from tauri.conf.json, so a rename is one edit there.
  const [name, setName] = useState("");
  useEffect(() => void getName().then(setName), []);
  // The bundled ffmpeg and gifski, asked for their versions: proof they're there and run.
  const [tools, setTools] = useState<MediaTools | null>(null);
  useEffect(() => void commands.mediaTools().then(setTools), []);
  return (
    <div id={id} className={styles.about}>
      <img className={styles.aboutLogo} src={logo} alt="" />
      <div className={styles.aboutText}>
        <p className={styles.aboutName}>
          {name} <span className={styles.aboutVersion}>{versionLabel()}</span>
        </p>
        <p className={styles.aboutDescription}>A small, fast, precise video editor.</p>
        <p className={styles.aboutMeta}>
          Made by{" "}
          <button
            type="button"
            className={`${styles.aboutLink} ${styles.aboutInlineLink}`}
            onClick={() => void commands.openFlowcatSite()}
          >
            {pkg.author}
          </button>
          <br />
          Copyright © 2026 {pkg.author}
          <br />
          Free software under the GNU GPL v3.0 or later.
        </p>
        {tools && (
          <p className={styles.aboutMeta}>
            Includes FFmpeg {tools.ffmpeg ?? "(missing)"} (GPL) and gifski{" "}
            {tools.gifski ?? "(missing)"} (AGPL)
          </p>
        )}
      </div>
    </div>
  );
}
