import { useEffect, useState } from "react";
import { getName } from "@tauri-apps/api/app";
import logo from "../../../src-tauri/icons/128x128@2x.png";
import pkg from "../../../package.json";
import type { AboutItem } from "../schema";
import type { ControlProps } from "./index";
import styles from "./controls.module.css";

/** Settings › About: the logo, name and version, what the app is and who made it. */
export function AboutCard({ id }: ControlProps<AboutItem>) {
  // The product name from tauri.conf.json, so a rename is one edit there.
  const [name, setName] = useState("");
  useEffect(() => void getName().then(setName), []);
  return (
    <div id={id} className={styles.about}>
      <img className={styles.aboutLogo} src={logo} alt="" />
      <div className={styles.aboutText}>
        <p className={styles.aboutName}>
          {name} <span className={styles.aboutVersion}>{pkg.version}</span>
        </p>
        <p className={styles.aboutDescription}>A small, fast, precise video editor.</p>
        <p className={styles.aboutMeta}>
          Created by {pkg.author}
          <br />
          Copyright © 2026 {pkg.author}
          <br />
          Free software under the GNU GPL v3.0 or later.
        </p>
      </div>
    </div>
  );
}
