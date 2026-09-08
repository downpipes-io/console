// The destination fan-out picker (3-2-1): the "where this goes" control shared by the create
// wizard's name step and the Sources bulk-protect tier. Split out of ./editor-wizard-panels.ts as a
// LEAF (imports lib/dom only) so the Sources screen can reuse it without pulling the wizard's module
// graph in (which would cycle through the editor). Behaviour is the verbatim moved panel: with more
// than one destination it is a MULTI-select, tick the destinations a downpipe is copied to, the first
// ticked is the primary, the rest are replicas; leaving all unticked follows the default (a single
// copy). With one destination or none it degrades to the caller's one-line summary.

import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { tickOrderTracker } from "./tick-order.ts";

// destinationFanout renders the picker. The ordered tick selection (TICK order; the first ticked is
// the primary) is reported through setChosenDestinationIds; the caller owns the ids it sends as
// destinationIds.
export function destinationFanout(ctx: {
  destinations: Array<{ id?: string; label?: string; bucket?: string; isDefault?: boolean }>;
  destLine: string;
  setChosenDestinationIds: (ids: string[]) => void;
}): HTMLElement {
  const { destinations, destLine, setChosenDestinationIds } = ctx;
  if (destinations.length <= 1) return h("p", { class: "field__hint", style: "margin:0 0 var(--space-2)" }, destLine);
  const summary = h("p", { class: "field__hint", style: "margin:var(--space-1) 0 0" });
  const rows: HTMLElement[] = [];
  // Preserve tick ORDER (first ticked = primary). The checkboxes are read in list order purely to see
  // WHICH are ticked; the tracker is what decides the ORDER they are reported in. Reporting the DOM
  // order directly would hand index 0 (the primary the run seals to) to whichever destination happens
  // to be listed first, which is the opposite of what the summary below promises.
  const trackTickOrder = tickOrderTracker();
  const recompute = (): void => {
    const ticked = rows.map((r) => r.querySelector("input") as HTMLInputElement).filter((cb) => cb.checked).map((cb) => cb.value);
    const ids = trackTickOrder(ticked);
    setChosenDestinationIds(ids);
    const n = ids.length;
    summary.textContent = n === 0
      ? "None ticked: this source uses the default destination (a single copy)."
      : n === 1
        ? "1 destination: a single copy. Tick more to keep extra copies (the source in more than one place)."
        : `${n} destinations: the first ticked is the primary; the rest each get a copy of every run.`;
  };
  for (const x of destinations) {
    if (!x.id) continue;
    const id = `wiz-dest-${x.id}`;
    const cb = h("input", { type: "checkbox", id, value: x.id }) as HTMLInputElement;
    cb.addEventListener("change", recompute);
    rows.push(h("div", { class: "checkbox-row" }, cb, h("label", { for: id }, `${x.label ?? x.bucket ?? x.id}${x.isDefault ? " (default)" : ""}`)));
  }
  recompute();
  return h("div", { class: "field", style: "margin:0 0 var(--space-2)" },
    h("span", { class: "field__label" }, "Destinations (tick more than one for extra copies)"),
    h("div", { class: "stack-xs" }, ...rows),
    summary,
    // Group-level doc link: the destination tickboxes are one fan-out control, so the link
    // explaining primary-versus-replica ordering lives on the group rather than on any single row.
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/backing-up/multiple-destinations#attach-two-or-more-destinations", target: "_blank", rel: "noreferrer noopener" },
      "About multiple destinations",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ));
}
