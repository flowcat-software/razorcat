// The settings schema: what the settings window shows, declared as data.
//
// To add a setting, add an item to a group in `sections.tsx`. To add a new kind of control,
// add an item type to `Item` below and a component to the registry in `controls/index.ts`
// (TypeScript will insist on both). Vandal's settings have more kinds to copy (toggle, text,
// folder, slider...) when a setting needs one.
import type { ComponentType } from "react";
import type { Settings } from "../shared/ipc";
import type { PathOf } from "./path";

interface BaseItem {
  /** Stable id: used as the React key and the control's DOM id. */
  id: string;
  label: string;
  description?: string;
  /** Extra words that should find this setting in search. */
  keywords?: string[];
  /** Hide the row entirely when false. */
  visible?: (s: Settings) => boolean;
  /** Grey the row out when true (keep it visible so it's discoverable). */
  disabled?: (s: Settings) => boolean;
}

/** One of a fixed set of strings, as joined buttons. */
export interface ChoiceItem extends BaseItem {
  kind: "choice";
  path: PathOf<Settings, string>;
  options: readonly { value: string; label: string }[];
}

/** The accent color: the Windows accent or a preset. */
export interface AccentItem extends BaseItem {
  kind: "accent";
  path: PathOf<Settings, string>;
}

/** The About card: logo, name, version, description, author. */
export interface AboutItem extends BaseItem {
  kind: "about";
}

export type Item = ChoiceItem | AccentItem | AboutItem;
export type ItemKind = Item["kind"];

export interface Group {
  title?: string;
  description?: string;
  items: Item[];
}

export interface Section {
  id: string;
  title: string;
  icon: ComponentType;
  description?: string;
  groups: Group[];
}

/** Does `item` match every word of `query` (case-insensitive)? */
export function matchesQuery(item: Item, section: Section, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [item.label, item.description, section.title, ...(item.keywords ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}
