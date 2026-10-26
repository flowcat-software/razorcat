import { useEffect, useState } from "react";
import { Dropdown } from "../../markup/Dropdown";
import markup from "../../markup/options.module.css";
import { commands, type Microphones } from "../../shared/ipc";
import type { MicrophoneItem } from "../schema";
import { useSetting } from "../store";
import type { ControlProps } from "./index";

/**
 * Which microphone records: the default one (named, as it changes with Windows) or one of those
 * connected, listed again whenever the window comes back (one may have been plugged in). One
 * chosen but not connected says so: the default is used then (recording.rs).
 */
export function MicrophonePicker({ item, id, disabled }: ControlProps<MicrophoneItem>) {
  const [value, setValue] = useSetting(item.path);
  const [mics, setMics] = useState<Microphones | null>(null);

  useEffect(() => {
    let gone = false;
    const list = () => void commands.microphones().then((m) => !gone && setMics(m));
    list();
    window.addEventListener("focus", list);
    return () => {
      gone = true;
      window.removeEventListener("focus", list);
    };
  }, []);

  const byDefault = `Default (${mics?.default ?? "none connected"})`;
  const chosen = mics?.devices.find((d) => d.id === value);
  let label = byDefault;
  if (value && chosen) label = chosen.name;
  else if (value && mics) label = "Not connected: using the default";

  return (
    // The editor's options-bar dropdown, in the context it's styled for (as Vandal's).
    <div className={markup.options}>
      <Dropdown
        id={id}
        className={markup.dropdown}
        title={item.label}
        disabled={disabled}
        // Settings' controls sit at the right edge of their row.
        align="end"
        button={<span>{label}</span>}
      >
        {(close) =>
          [{ id: "", name: byDefault }, ...(mics?.devices ?? [])].map((d) => (
            <button
              key={d.id}
              type="button"
              role="menuitemradio"
              aria-checked={d.id === value}
              className={markup.menuRow}
              onClick={() => {
                setValue(d.id);
                close();
              }}
            >
              <span className={markup.menuLabel}>{d.name}</span>
            </button>
          ))
        }
      </Dropdown>
    </div>
  );
}
