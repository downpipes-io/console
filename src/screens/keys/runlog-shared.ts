// Shared pieces for the three attended RUNLOG actions (re-sign, floor reset, relink), split out so each
// action's own leaf (runlog-resign.ts, runlog-floor.ts, runlog-relink.ts) stays focused on its own route and
// evidence. There is no free-text destination or downpipe field anywhere in this family: every picker here
// is built from a list the engine already serves, so an action can only ever name something the console
// lists.

import type { EngineClient } from "../../api.ts";
import { h } from "../../lib/dom.ts";

export const DEFAULT_DESTINATION_LABEL = "Default destination";

// A destination or downpipe a picker can offer: value is the id the engine route takes ("" for the default
// destination), label is what the select shows (an annotated form for the estate's default), and matchName
// is the plain name an Owner types to confirm an action (never the annotated label, so the typed value is
// never "Acme backups (default)").
export interface PickerOption { value: string; label: string; matchName: string }

export const DEFAULT_DESTINATION_OPTION: PickerOption = { value: "", label: DEFAULT_DESTINATION_LABEL, matchName: DEFAULT_DESTINATION_LABEL };

// loadDestinationOptions lists every destination engine.listDestinations() already knows (the same source
// the Destinations screen reads), plus "Default destination" first.
export async function loadDestinationOptions(engine: EngineClient): Promise<PickerOption[]> {
  try {
    const list = await engine.listDestinations();
    const known = list.destinations
      .filter((d): d is typeof d & { id: string } => typeof d.id === "string")
      .map((d) => {
        const name = d.label ?? d.id;
        return { value: d.id, label: d.isDefault ? `${name} (default)` : name, matchName: name };
      });
    return [DEFAULT_DESTINATION_OPTION, ...known];
  } catch {
    return [DEFAULT_DESTINATION_OPTION];
  }
}

// loadDownpipeOptions lists every downpipe engine.listDownpipes() already knows (the same source the
// Downpipes screen reads). There is no default downpipe: the caller supplies its own placeholder.
export async function loadDownpipeOptions(engine: EngineClient): Promise<PickerOption[]> {
  try {
    const list = await engine.listDownpipes();
    return list.map((d) => ({ value: d.config.id, label: d.config.name, matchName: d.config.name }));
  } catch {
    return [];
  }
}

// buildPicker fills the caller's own <select> (the caller creates it, so each picker carries its own literal
// data-dp hook), loads its options asynchronously (a plain text option stands in until the load resolves),
// and returns the element plus a `selected()` reader. `placeholder` is
// the option shown while loading and the fallback when the load returns nothing; `initialValue` pre-selects
// a known value once the real options land, when the loaded list actually offers it.
export function buildPicker(select: HTMLSelectElement, load: () => Promise<PickerOption[]>, placeholder: PickerOption, initialValue?: string): { select: HTMLSelectElement; selected: () => PickerOption } {
  select.replaceChildren(h("option", { value: placeholder.value }, placeholder.label));
  let options: PickerOption[] = [placeholder];
  void load().then((loaded) => {
    options = loaded.length > 0 ? loaded : [placeholder];
    select.replaceChildren(...options.map((o) => h("option", { value: o.value }, o.label)));
    if (initialValue !== undefined && options.some((o) => o.value === initialValue)) select.value = initialValue;
  });
  const selected = (): PickerOption => options.find((o) => o.value === select.value) ?? options[0] ?? placeholder;
  return { select, selected };
}
