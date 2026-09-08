// Destination picker section (flow.md D step 5) for the upsert editor, split out of
// ./editor-upsert.ts (move-only). See ./editor.ts for the barrel.
//
// The destination PICKER (multi-destination) chooses where THIS downpipe writes. Defaults to the
// downpipe's current pinned id(s), or "Default" (follow the account default). Loaded async; with a
// single destination there is nothing to choose, so it shows the summary + a link to manage
// destinations. A list-load fault must never block the editor: it falls back to the static
// clarity/summary.

import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { navigate } from "../../lib/nav.ts";
import { destinationClarity, destinationSummary } from "./helpers.ts";
import { tickOrderTracker } from "./tick-order.ts";
import type { EngineClient, Downpipe, StatusReport } from "../../api.ts";

// buildDestinationSection builds the destination field and loads the destination list. It exposes
// getChosenIds(): the ordered fan-out selection (first = primary), empty meaning "follow the
// default". onManageNavigate runs when the single-destination "Manage in Destinations" link is
// clicked (the editor closes its overlay there before navigating).
export function buildDestinationSection(
  engine: EngineClient,
  existing: Downpipe | null,
  status: StatusReport | null,
  editing: boolean,
  onManageNavigate: () => void,
): {
  el: HTMLElement;
  getChosenIds: () => string[];
} {
  // The downpipe's current fan-out selection (ordered; first = primary), back-compat from a legacy
  // single destinationId. Empty = follow the default.
  let chosenEditDestIds: string[] = (existing?.destinationIds && existing.destinationIds.length > 0)
    ? [...existing.destinationIds]
    : existing?.destinationId
      ? [existing.destinationId]
      : [];
  const destHost = h("div");
  const el = h(
    "div",
    { class: "field" },
    h("span", { class: "field__label" }, "Destinations (tick more than one for extra copies)"),
    destHost,
    // Group-level doc link: the destination tickboxes are one fan-out control, so the link
    // explaining primary-versus-replica ordering lives on the group rather than on any single row.
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/backing-up/multiple-destinations#attach-two-or-more-destinations", target: "_blank", rel: "noreferrer noopener" },
      "About multiple destinations",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  destHost.appendChild(h("p", { class: "field__hint", style: "margin:0" }, "Loading destinations…"));
  void engine
    .listDestinations()
    .then((list) => {
      if (list.destinations.length > 1) {
        // Render the CURRENT selection first (in its stored order) so an unrelated edit (a rename, a
        // cadence change) never flips the primary; then the remaining destinations.
        const live = list.destinations.filter((x) => typeof x.id === "string") as Array<{ id: string; label?: string; bucket?: string; isDefault?: boolean }>;
        const ordered = [
          ...chosenEditDestIds.map((id) => live.find((x) => x.id === id)).filter((x): x is typeof live[number] => x !== undefined),
          ...live.filter((x) => !chosenEditDestIds.includes(x.id)),
        ];
        // SEEDED with the stored order, so the existing selection keeps exactly the order it was saved
        // with and this edit screen migrates nothing. Beyond that the tracker reports TICK order, so an
        // operator who unticks and re-ticks can genuinely change which destination is the primary.
        // Reading DOM order here instead left them no way to do that at all: the rows are arranged once,
        // at render, so re-ticking simply reproduced the stored order.
        const trackTickOrder = tickOrderTracker(chosenEditDestIds);
        const summary = h("p", { class: "field__hint", style: "margin:var(--space-1) 0 0" });
        const rows: HTMLElement[] = [];
        const recompute = (): void => {
          const ticked = rows.map((r) => r.querySelector("input") as HTMLInputElement).filter((cb) => cb.checked).map((cb) => cb.value);
          chosenEditDestIds = trackTickOrder(ticked);
          const n = chosenEditDestIds.length;
          summary.textContent = n === 0
            ? "None ticked: uses the default destination (a single copy)."
            : n === 1
              ? "1 destination: a single copy. Tick more for extra copies."
              : `${n} destinations: the first ticked is the primary; the rest each get a copy of every run.`;
        };
        for (const x of ordered) {
          const id = `dp-dest-${x.id}`;
          const cb = h("input", { type: "checkbox", id, value: x.id, ...(chosenEditDestIds.includes(x.id) ? { checked: true } : {}) }) as HTMLInputElement;
          cb.addEventListener("change", recompute);
          rows.push(h("div", { class: "checkbox-row" }, cb, h("label", { for: id }, `${x.label ?? x.bucket ?? x.id}${x.isDefault ? " (default)" : ""}`)));
        }
        recompute();
        destHost.replaceChildren(h("div", { class: "stack-xs" }, ...rows), summary);
      } else {
        destHost.replaceChildren(
          editing
            ? h("div", { class: "field__hint", style: "margin:0; display:flex; flex-wrap:wrap; gap:.4rem .6rem; align-items:baseline" },
                h("span", destinationSummary(status)),
                h("button", { "data-dp": "sources-downpipes.button.navigate-destinations#1", class: "linklike", type: "button", on: { click: () => { onManageNavigate(); navigate("/destinations"); } } }, "Manage in Destinations"))
            : destinationClarity(status),
        );
      }
    })
    .catch(() => {
      // A list-load fault must never block the editor: fall back to the static clarity/summary.
      destHost.replaceChildren(editing ? h("span", { class: "field__hint", style: "margin:0" }, destinationSummary(status)) : destinationClarity(status));
    });

  return { el, getChosenIds: () => chosenEditDestIds };
}
