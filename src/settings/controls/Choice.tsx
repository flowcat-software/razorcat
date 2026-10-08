import type { ChoiceItem, NumberChoiceItem } from "../schema";
import { useSetting } from "../store";
import type { ControlProps } from "./index";
import { Segmented } from "./Segmented";

/** One value from a fixed list, as joined buttons. */
export function Choice({ item, id, disabled }: ControlProps<ChoiceItem>) {
  const [value, setValue] = useSetting(item.path);
  return (
    <Segmented
      id={id}
      label={item.label}
      options={item.options}
      value={value}
      disabled={disabled}
      onChange={setValue}
    />
  );
}

/** One number from a fixed list, as joined buttons. */
export function NumberChoice({ item, id, disabled }: ControlProps<NumberChoiceItem>) {
  const [value, setValue] = useSetting(item.path);
  return (
    <Segmented
      id={id}
      label={item.label}
      options={item.options.map((o) => ({ value: String(o.value), label: o.label }))}
      value={String(value)}
      disabled={disabled}
      onChange={(v) => setValue(Number(v))}
    />
  );
}
