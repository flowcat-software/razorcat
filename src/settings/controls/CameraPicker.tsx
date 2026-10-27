import { useEffect, useState } from "react";
import { Dropdown } from "../../markup/Dropdown";
import markup from "../../markup/options.module.css";
import { commands, type Camera } from "../../shared/ipc";
import type { CameraItem } from "../schema";
import { useSetting } from "../store";
import type { ControlProps } from "./index";

/**
 * Which camera records: the first connected (named), or one by name, listed again whenever the
 * window comes back (one may have been plugged in). One chosen but not connected says so: the
 * first is used then (camera.rs). As the microphone's picker.
 */
export function CameraPicker({ item, id, disabled }: ControlProps<CameraItem>) {
  const [value, setValue] = useSetting(item.path);
  const [cameras, setCameras] = useState<Camera[] | null>(null);

  useEffect(() => {
    let gone = false;
    const list = () => void commands.cameras().then((c) => !gone && setCameras(c));
    list();
    window.addEventListener("focus", list);
    return () => {
      gone = true;
      window.removeEventListener("focus", list);
    };
  }, []);

  const first = `First connected (${cameras?.[0]?.name ?? "none connected"})`;
  const chosen = cameras?.find((c) => c.name === value);
  let label = first;
  if (value && chosen) label = chosen.name;
  else if (value && cameras) label = "Not connected: using the first";

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
          [
            { value: "", name: first },
            ...(cameras ?? []).map((c) => ({ value: c.name, name: c.name })),
          ].map((c) => (
            <button
              key={c.value}
              type="button"
              role="menuitemradio"
              aria-checked={c.value === value}
              className={markup.menuRow}
              onClick={() => {
                setValue(c.value);
                close();
              }}
            >
              <span className={markup.menuLabel}>{c.name}</span>
            </button>
          ))
        }
      </Dropdown>
    </div>
  );
}
