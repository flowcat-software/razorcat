import { useEffect, useRef, useState } from "react";
import { commands } from "../../shared/ipc";
import { fileSize } from "../../shared/fileSize";
import type { ProxyLimitItem } from "../schema";
import { useSetting } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import type { ControlProps } from "./index";
import { useDraft } from "./useDraft";
import styles from "./controls.module.css";

/** What a lower limit would delete, while the question is asked. */
interface Asking {
  limit: number;
  files: number;
  bytes: number;
}

/**
 * The cache's size limit: a slider (Vandal's) that commits once it settles, with how much the
 * cache holds now. A lower limit that would delete proxies asks first.
 */
export function ProxyLimit({ item, id, disabled }: ControlProps<ProxyLimitItem>) {
  const [value, setStored] = useSetting(item.path);
  const [draft, setDraft] = useDraft(value);
  const [used, setUsed] = useState<number | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // How much the cache holds, read again whenever the stored limit changes (it may trim).
  useEffect(() => {
    let gone = false;
    void commands.proxyCache(value).then((r) => !gone && setUsed(r.bytes ?? 0));
    return () => {
      gone = true;
    };
  }, [value]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const settle = async (next: number) => {
    if (next >= value) return setStored(next);
    const r = await commands.proxyCache(next);
    if (r.dropping > 0) setAsking({ limit: next, files: r.dropping, bytes: r.droppingBytes ?? 0 });
    else setStored(next);
  };

  const change = (next: number) => {
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void settle(next), 200);
  };

  const pct = ((draft - item.min) / (item.max - item.min)) * 100;
  return (
    <div className={styles.sliderWrap}>
      {used !== null && (
        <span className={styles.help}>{used > 0 ? `${fileSize(used)} used` : "None used"}</span>
      )}
      <span className={styles.sliderValue}>{draft} GB</span>
      <input
        id={id}
        type="range"
        className={styles.slider}
        style={{ ["--fill" as string]: `${pct}%` }}
        min={item.min}
        max={item.max}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(e) => change(Number(e.target.value))}
      />
      {asking && (
        <ConfirmDialog
          title={`Lower the limit to ${asking.limit} GB?`}
          confirm="Delete and lower"
          onConfirm={() => {
            setStored(asking.limit);
            setAsking(null);
          }}
          onCancel={() => {
            setDraft(value);
            setAsking(null);
          }}
        >
          <p>
            {asking.files === 1
              ? `This deletes 1 proxy (${fileSize(asking.bytes)}), the one used longest ago.`
              : `This deletes ${asking.files} proxies (${fileSize(asking.bytes)}), the ones used longest ago.`}
          </p>
          <p>Your videos aren't touched. A proxy is made again when its video is next opened.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
