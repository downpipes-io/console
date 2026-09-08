// The integration GRID: the one work surface of the Integrations screen, one logo tile per destination, grouped
// by category. It is the deliberate twin of the IdP provider grid (screens/idp-connections/grid.ts): it reuses
// the SAME .idp-grid / .idp-tile CSS and the SAME three tile states, so the two screens read as one family (the
// owner's ask was "align with the IdP grid"). The only additions are the category section headers, the teal
// "Auto-parses" tag, and the small connected-summary strip.
//
// Three states, exactly as the IdP grid derives them, but from the destination config rather than IdP
// connections (the coordinator computes them, see integrations.ts):
//   live        this destination is configured AND enabled  -> the animated "Active" tile
//   configured  configured but currently disabled            -> a quiet ringed tile, "Off"
//   available   not set up yet                               -> a plain tile, "Add" (or "Owner" for a non-owner)
//
// THE GATE IS THREE-VALUED, NOT TWO. A tile's corner chip states whether the reader may set this destination
// up, and until it read that gate as a boolean: allowed, or "Owner". There is a third state and it
// is the COMMON one on a fresh load. app.ts paints the screen and resolves the identity in parallel, so every
// gate on the first paint runs with caller() still null and fails closed (screens/common.ts canDo/canCap,
// which is the correct thing for a GATE to do). The grid then printed that fail-closed default as the
// SETTLED FACT "Owner", on all 40 tiles at once, to an operator who is in fact the owner: a refusal asserted
// where the truth was "not read yet", with no reason and no remedy, and it self-cleared a few hundred
// milliseconds later when the identity landed and the screen re-rendered. Every sibling gate in this console
// already keeps the two apart (notifications gateReason, common.ts gateReason/capGateReason, the credentials
// and security-centre predicates all carry a null-caller branch that says the engine has not reported the
// role); this grid was the one surface that did not, which is why an owner-driven run read 0 Add chips of 40.
//
// So ManageGate carries "unresolved" beside "allowed" and "refused", the chip reads "Checking" rather than
// "Owner", and the accessible action word is "checking your permissions" rather than "owner only". The gate
// itself is UNCHANGED and still fails closed: nothing is enabled here that was not enabled before.
//
// House rules: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { blindGateRemedy } from "../../lib/identity-remedy.ts";
import { integrationMark } from "./marks.ts";
import type { Vendor, Category } from "./catalogue.ts";

export type TileState = "live" | "configured" | "available";

// ManageGate is the three-valued answer to "may this reader set this destination up".
//   allowed     the resolved caller holds the capability this vendor needs
//   refused     the resolved caller does not hold it (the honest role refusal)
//   unresolved  no identity report has arrived, so the question is not answered yet
export type ManageGate = "allowed" | "refused" | "unresolved";

export interface IntegrationTile {
  // Unique within the screen: a vendor name can recur across categories (Datadog is a SIEM push AND a metrics
  // push; Splunk is SIEM, Observability and On-Call), so the id carries the category to keep each tile distinct.
  id: string;
  vendor: Vendor;
  state: TileState;
}

export function tileId(v: Vendor): string {
  return `${v.category}::${v.name}`;
}

// A grouped view for the sectioned render.
export interface TileGroup {
  category: Category;
  tiles: IntegrationTile[];
}

// cornerChip is the bottom-corner status, mirroring the IdP grid: "Active" (live, teal dot), "Off" (configured
// but disabled), "Add" (available), "Owner" when a resolved caller may not set it up, and "Checking" while no
// identity report has arrived. The last of those is the repair: "Owner" is a claim about the reader's role and
// it must not be printed from a gate that has not read one.
function cornerChip(state: TileState, gate: ManageGate): HTMLElement {
  if (state === "live") {
    return h("span", { class: "integration-chip integration-chip--active" }, h("span", { class: "integration-chip__dot" }), "Active");
  }
  if (state === "configured") {
    return h("span", { class: "integration-chip integration-chip--off" }, "Off");
  }
  if (gate === "unresolved") {
    return h("span", { class: "integration-chip integration-chip--pending", title: blindGateRemedy() }, "Checking");
  }
  if (gate === "refused") {
    return h("span", { class: "integration-chip integration-chip--owner" }, "Owner");
  }
  return h("span", { class: "integration-chip integration-chip--add" }, "Add");
}

// tileAction is the action word the accessible label ends on, and it says the same thing the chip does. An
// unresolved gate reports the state ("checking your permissions"), never a refusal, so a screen reader and a
// sighted reader are told the same true thing at the same moment.
function tileAction(state: TileState, gate: ManageGate): string {
  if (state !== "available") return "manage";
  if (gate === "unresolved") return "checking your permissions";
  return gate === "refused" ? "owner only" : "add";
}

// tileButton renders one destination tile: logo, name, the auto tag (only where the destination auto-parses),
// and the corner status. The whole tile is a button that opens the setup panel; the mark is decorative and the
// visible name is the accessible label, so aria-label spells out the name + category + state + action once.
//
// The CATEGORY is in the label for the same reason it is in tileId above, and it was missing here. A vendor
// name recurs across categories, so the name alone does not identify the control: Datadog's SIEM logs push and
// its OTLP metrics push are two different destinations with two different setup panels, and both announced
// themselves as "Datadog, available, add" (WCAG 2.4.6). A sighted operator is unaffected because the tiles sit
// under visible category headings; someone listing the controls by voice or braille got 39 distinct labels for
// 40 tiles and no way to tell which Datadog they were on. The category is on EVERY tile, not only the colliding
// ones, so the label's shape does not silently change for unrelated tiles when the catalogue gains a vendor.
function tileButton(tile: IntegrationTile, gate: ManageGate, onOpen: (t: IntegrationTile) => void, selected: boolean): HTMLElement {
  const { vendor, state } = tile;
  const action = tileAction(state, gate);
  const btn = h(
    "button",
    { "data-dp": "integrations.button.open",
      class: "idp-tile",
      type: "button",
      // The tile's own id, so the coordinator can hand focus back to THIS tile after a close re-renders the
      // grid. It is the same string tileId() builds, and it is inert: nothing keys behaviour off it.
      "data-tile": tile.id,
      "data-state": state,
      "data-selected": selected ? "true" : "false",
      "aria-label": `${vendor.name}, ${vendor.category}, ${state === "live" ? "active" : state === "configured" ? "configured, off" : "available"}, ${action}`,
    },
    h("span", { class: "idp-tile__logo" }, integrationMark(vendor.mark, vendor.name, 34)),
    h("span", { class: "idp-tile__name" }, vendor.name),
  ) as HTMLButtonElement;
  if (vendor.auto) {
    btn.appendChild(h("span", { class: "integration-autotag", title: "Reads our format natively, no field mapping" }, "Auto-parses"));
  }
  btn.appendChild(cornerChip(state, gate));
  btn.addEventListener("click", () => onOpen(tile));
  return btn;
}

// renderIntegrationGrid builds the whole sectioned grid: one section per category (a header with the count and,
// where any tile auto-parses, a quiet teal "N auto-parse" note), each holding an .idp-grid of tiles.
export function renderIntegrationGrid(
  groups: TileGroup[],
  // Per-VENDOR gate, not one flag for the whole grid: a notify tile gates on notify.config, an owner-only
  // SIEM/OTLP/pull tile on owner, so the corner chip ("Add" vs "Owner") and the aria action ("add" vs
  // "owner only") tell the truth for each tile the caller actually can or cannot set up. A single grid-wide
  // flag over-promised every tile as addable; the panel already gated per vendor, so this aligns the
  // grid's promise with the panel's gate. Three-valued, so a gate that has read no identity
  // yet reports that rather than printing a role refusal it cannot back (see ManageGate above).
  gateFor: (v: Vendor) => ManageGate,
  onOpen: (t: IntegrationTile) => void,
  selectedId: string | null,
): HTMLElement {
  const root = h("div", { class: "integration-sections" });
  // Anchor the tour "?"s on SINGLE, viewport-sized instances (never the whole multi-section grid, which is
  // taller than the viewport and cannot be spotlighted): integrations-grid on the FIRST category section, and
  // the auto-parse note on the FIRST group that carries one. Inert data attributes, no behaviour.
  let gridAnchored = false;
  let autoAnchored = false;
  for (const group of groups) {
    const autos = group.tiles.filter((t) => t.vendor.auto).length;
    const head = h(
      "div",
      { class: "integration-grp-head" },
      h("h2", { class: "integration-grp-title" }, group.category),
      h("span", { class: "integration-grp-count" }, String(group.tiles.length)),
    );
    if (autos > 0) {
      head.appendChild(h("span", { class: "integration-grp-auto", ...(autoAnchored ? {} : { dataset: { tourId: "integrations-autoparse" } }) }, h("span", { class: "integration-grp-auto__dot" }), `${autos} auto-parse`));
      autoAnchored = true;
    }
    const grid = h("div", { class: "idp-grid", role: "list", "aria-label": group.category });
    for (const tile of group.tiles) {
      grid.appendChild(tileButton(tile, gateFor(tile.vendor), onOpen, tile.id === selectedId));
    }
    root.appendChild(h("section", { class: "integration-grp", ...(gridAnchored ? {} : { dataset: { tourId: "integrations-grid" } }) }, head, grid));
    gridAnchored = true;
  }
  return root;
}

// focusTile moves keyboard focus to the tile carrying this id inside a rendered grid, and reports whether it
// found one. Used by the coordinator to return focus to the tile a detail panel was opened from.
//
// It walks the rendered tiles and compares the attribute rather than composing a CSS attribute selector,
// because a tile id embeds the category verbatim ("SIEM::Datadog") and a selector would have to quote and
// escape it. Returning a boolean rather than throwing lets the caller decide: there is no honest fallback
// target here, and stealing focus to some OTHER tile would be worse than leaving it where it is.
export function focusTile(root: HTMLElement, id: string): boolean {
  for (const el of root.querySelectorAll(".idp-tile")) {
    if (el.getAttribute("data-tile") === id) {
      (el as HTMLElement).focus();
      return true;
    }
  }
  return false;
}

// connectedSummary is the small strip above the grid: the destinations that are live right now, each a chip with
// its logo, so an owner sees "what is on" at a glance before scanning the catalogue. Empty when nothing is live.
export function connectedSummary(tiles: IntegrationTile[]): HTMLElement | null {
  const live = tiles.filter((t) => t.state === "live");
  if (live.length === 0) return null;
  const chips = h("div", { class: "integration-connected__chips" });
  for (const t of live) {
    chips.appendChild(
      h("span", { class: "integration-connected__chip" },
        h("span", { class: "integration-chip__dot" }),
        h("span", { class: "integration-connected__mk" }, integrationMark(t.vendor.mark, t.vendor.name, 16)),
        t.vendor.name),
    );
  }
  return h("div", { class: "integration-connected", dataset: { tourId: "integrations-active" } },
    h("span", { class: "integration-connected__lbl" }, h("b", {}, String(live.length)), ` connected`),
    chips,
  );
}
