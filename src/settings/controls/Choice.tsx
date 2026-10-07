import type { ChoiceItem } from "../schema";
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
