import { useState } from "react";
import type { ToggleItem } from "../schema";
import { useSetting } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import type { ControlProps } from "./index";
import { Switch } from "./Switch";

export function Toggle({ item, id, disabled }: ControlProps<ToggleItem>) {
  const [value, setValue] = useSetting(item.path);
  const [asking, setAsking] = useState(false);
  const ask = item.confirmOn;
  return (
    <>
      <Switch
        id={id}
        checked={value}
        disabled={disabled}
        onChange={(on) => (on && ask ? setAsking(true) : setValue(on))}
      />
      {asking && ask && (
        <ConfirmDialog
          title={ask.title}
          confirm={ask.confirm}
          onConfirm={() => {
            setValue(true);
            setAsking(false);
          }}
          onCancel={() => setAsking(false)}
        >
          <p>{ask.body}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
