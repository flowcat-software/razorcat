import type { ReactNode } from "react";
import styles from "./controls.module.css";

/** What an alert says: done, for information, a caution, or something wrong. */
export type AlertTone = "success" | "info" | "warning" | "error";

interface Props {
  tone: AlertTone;
  children: ReactNode;
  /** Fades away after this many ms (a confirmation, like a toast), then `onGone`. */
  fadeAfter?: number;
  onGone?: () => void;
  className?: string;
}

/**
 * Every message in Settings: a tinted bar in its tone's colors, Vandal's look (its field error
 * and warning bars), so validation, notes and confirmations read alike everywhere. Errors are
 * announced at once (`alert`); the rest politely (`status`).
 */
export function Alert({ tone, children, fadeAfter, onGone, className }: Props) {
  const classes = [styles.alert, styles[tone], fadeAfter !== undefined && styles.fadeOut, className]
    .filter(Boolean)
    .join(" ");
  return (
    <p
      className={classes}
      role={tone === "error" ? "alert" : "status"}
      style={fadeAfter !== undefined ? { animationDelay: `${fadeAfter}ms` } : undefined}
      onAnimationEnd={onGone}
    >
      {children}
    </p>
  );
}
