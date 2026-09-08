// Overview (IA screen 1) technical builder: buildOverview assembles the full technical
// dashboard body from the independently-resolved data (the protection lead, the fleet
// banner, the status tiles, the two-column fleet + side region, and a quiet link to the
// cost projection). Pure given the data + callbacks, so a poll re-runs it on fresh data
// and swaps the result atomically. Moved verbatim out of overview.ts for size. House
// rules: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { recordUnhandled } from "../../lib/client-diag/ring.ts";
import { faultClassForError, errorClassForError } from "../../lib/client-diag/classify.ts";
import type { DataTableState } from "../../components/data-table.ts";
import {
  ICON_CHEVRON_RIGHT,
  ICON_COSTS,
} from "../../lib/icons.ts";
import type { OverviewData, FleetSummary } from "./shared.ts";
import { summariseFleet } from "./fleet-data.ts";
import { buildProtectionLead, fleetBanner, buildTiles } from "./tiles.ts";
import { buildSurfaceCoverageGrid } from "./surface-coverage.ts";
import { buildFleetSection } from "./fleet-section.ts";
import { buildNeedsMe, buildRecoverySection } from "./recovery.ts";

// buildOverview assembles the full body from the independently-resolved data. Pure given
// the data + callbacks, so a poll re-runs it on fresh data and swaps the result atomically.
// Exported so the view-mode validator can render the TECHNICAL framing directly (no async view
// lifecycle) and assert it renders the technical dashboard, not the executive cards.
export function buildOverview(
  data: OverviewData,
  cb: {
    onDrillFleet: () => void | Promise<void>;
    announce: (m: string) => void;
    // Optional carry-through of the fleet table's filter/sort/facet state across poll
    // rebuilds (the view stores it via onFleetTableState and replays it here).
    fleetTableState?: Partial<DataTableState>;
    onFleetTableState?: (st: DataTableState) => void;
  },
): HTMLElement {
  const wrap = h("div");

  // The fleet roll-up feeds four of the sections below, so it is resolved inside the boundary too: a throw
  // here used to be the FIRST line of the function and took the page down before a single section existed.
  // An empty summary is not a fabrication, it is what a fleet nobody could summarise contains, and every
  // section that reads it already renders an honest empty state; the section that would have shown the
  // fleet says plainly that it could not be built.
  let fleet: FleetSummary;
  try {
    fleet = summariseFleet(data);
  } catch (err) {
    recordSectionFault(err);
    fleet = EMPTY_FLEET;
    wrap.appendChild(sectionFailed("Fleet health"));
  }

  // 0a. The Cloudflare-coverage hero: the nine surfaces from the public adverts, coloured by where each
  //     sits in the backup journey (covered / added / not added). It leads the page so the console reads
  //     like the ad, and it is the at-a-glance "what is and is not protected" map; the per-downpipe
  //     protection lead beneath it carries the restore-proven nuance the grid does not.
  wrap.appendChild(section("Cloudflare coverage", () => buildSurfaceCoverageGrid(data)));

  // 0b. The plain-English protection lead line: the first true sentence the operator reads on landing
  //    ("5 downpipes: 3 covered, 1 backed up but not proven, 1 not covered") plus the blunt
  //    not-covered line. It is computed from the per-downpipe protection statements (the SAME
  //    generator the downpipes screen uses), so the lead can never disagree with the per-downpipe
  //    reads, and is HONEST: never "all covered" unless every enabled downpipe's restorability is
  //    actually proven. Rendered first so the honest cover read leads the page.
  wrap.appendChild(section("Protection statement", () => buildProtectionLead(data)));

  // 1. Banners first (loud by default). A freshness/failure banner is NOT dismissible
  //    until resolved (a silently stopped backup is the worst failure). An available
  //    update is NOT restated here: the Updates tile carries the standing fact and the
  //    needs-attention item carries the action (one fact, two roles, no third copy).
  wrap.appendChild(section("Fleet banner", () => fleetBanner(fleet)));

  // 2. Status tiles, each its own success / unknown (never a stale green).
  wrap.appendChild(section("Status tiles", () => buildTiles(data, fleet)));

  // 3. Recovery posture, full-width directly beneath the status tiles so its four stat tiles flow
  //    across the whole page and read as a second posture row (the first-class-tiles design intent,
  //    "matching the status row at the top"). It was previously trapped in the narrow side column.
  wrap.appendChild(section("Recovery posture", () => buildRecoverySection(data, fleet, cb.onDrillFleet)));

  // 4. The two-column lower region: fleet roll-up (left) + the needs-me attention list (right). The
  //    .ov-grid class (tokens.css section 13) collapses it to one column under 1023px (CRAFT-03),
  //    so the fleet table and the attention list stack on medium/compact.
  const grid = h("div", { class: "ov-grid" });
  grid.appendChild(section("Fleet health", () => buildFleetSection(fleet, cb.announce, cb.fleetTableState, cb.onFleetTableState)));
  grid.appendChild(h("div", { class: "ov-side" }, section("Needs your attention", () => buildNeedsMe(data, fleet))));
  wrap.appendChild(grid);

  // 4. A quiet link to the cost projection. The full, interactive topology lives
  //    on /map; the overview no longer embeds a second, lower-fidelity copy of it (it was an incomplete,
  //    non-interactive duplicate of the same map, so it is removed rather than maintained in parallel).
  if (fleet.total > 0) {
    wrap.appendChild(
      h("div", { class: "ov-more" }, moreLink("Costs", ICON_COSTS, "/costs")),
    );
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// THE SECTION BOUNDARY: a tile that cannot render must fail AS A TILE.
// ---------------------------------------------------------------------------
//
// WHAT THIS FIXES. buildOverview was eight
// appendChild calls in a row with no boundary anywhere, called from an async load with no catch. So a
// TypeError anywhere in any one of them took the whole function down, the rejection escaped
// OverviewView.load, and the first-load skeleton stayed on screen for ever: three healthy downpipes plus
// ONE malformed roster row took the Overview from 2,632 characters of body text and nine stat tiles to
// 559 and none. The failure mode is worse than any single tile lying, because the surface that exists to
// tell you something is wrong is the surface that disappears when something is wrong, and it takes the
// other nine tiles with it, including the ones that would have named the fault.
//
// THE RULE, and the second half of it is the one that is easy to get wrong. A section that throws is
// replaced by a NAMED, READABLE card that says this part could not be rendered and what to do. It is
// never replaced by nothing: a tile that quietly disappears is the same defect wearing better clothes,
// and it is a defect the page-level check cannot see, because the page still renders. A could-not-check
// outranks a blank on a customer screen exactly as it does in our gates.
//
// WHAT THIS IS NOT. It is not a licence to stop guarding data. The boundary is the floor under a fault
// nobody predicted; the predicted ones are guarded at the point where the console still knows enough to
// say something useful (lib/downpipe-readable.ts is the example this repair shipped with). A section
// that reaches this card has lost the chance to explain itself, which is why the card names the section
// and points at the support pack rather than pretending to diagnose.

// EMPTY_FLEET is the honest zero-fleet summary used when the roll-up itself could not be built. Every
// figure is a real zero or a real null, never a placeholder that could be mistaken for a reading: the
// section that would have shown the fleet renders the could-not-build card beside it, so nothing on
// screen presents these zeros as a fleet that was successfully read.
const EMPTY_FLEET: FleetSummary = {
  total: 0,
  healthy: 0,
  stale: 0,
  failed: 0,
  disabled: 0,
  inFlight: 0,
  rows: [],
  newestGoodAt: null,
  worstGoodAt: null,
  noGoodBackupCount: 0,
  anyRuns: false,
};

// recordSectionFault banks the fault so the repair cannot make it QUIETER in the support pack than the
// crash it replaces. Before the boundary existed this same throw reached the window handler and produced
// an `unhandled` row; it now reaches a catch instead, and if the boundary recorded nothing, a repair that
// improves the screen would delete the only evidence support had. The row is emitted with the SAME kind
// and the SAME derived classes as before, on the `window-error` channel, which is what it literally is: a
// synchronous throw out of a synchronous builder. The error's message and stack are never read; only the
// closed fault class and the platform error class travel, exactly as the window handler does it.
function recordSectionFault(err: unknown): void {
  recordUnhandled(faultClassForError(err), "window-error", errorClassForError(err));
}

// sectionFailed is the card that stands in a failed section's place. It NAMES the section, because
// "something went wrong" on a nine-tile dashboard tells an operator nothing about which of the nine they
// have lost, and naming it is the difference between a could-not-check and a blank. It states the honest
// limit of the claim (this says nothing about the backups themselves), and it points at the two things
// that actually help: the rest of the page, which is still true, and the support pack, which carries the
// browser-side record of the fault. Every string reaches the DOM through the h() textContent path.
function sectionFailed(label: string): HTMLElement {
  return h(
    "div",
    { class: "card card--inset", role: "region", "aria-label": `${label}: could not be rendered`, style: "display:flex;align-items:flex-start;gap:var(--space-3);margin-bottom:var(--space-4)" },
    h("span", { class: "dot dot--neutral", "aria-hidden": "true", style: "margin-top:6px;flex:none" }),
    h(
      "div",
      { style: "min-width:0" },
      h("p", { style: "font-weight:var(--weight-medium)" }, `${label} could not be rendered.`),
      h("p", { class: "field__hint", style: "margin-top:2px" }, "The rest of this page is unaffected and still reads live data. This says nothing about whether your backups are running: it is a fault in this screen, not a finding about your estate. Reload, and if it persists download the support pack, which carries the browser-side record of what failed."),
    ),
  );
}

// section runs one section builder inside the boundary. On a throw it banks the fault and returns the
// named card in the section's place, so the failure is contained to the region that caused it and the
// operator is told which region they have lost. It takes a THUNK rather than an element so the builder
// runs INSIDE the try: passing an already-built element would put the throw at the call site, outside
// any boundary at all, which is the shape this whole repair exists to remove.
// The builders return Node rather than HTMLElement (fleetBanner can return a text-level node), so the
// boundary is typed on Node and the fallback card, which is always an element, still satisfies it.
function section(label: string, build: () => Node): Node {
  try {
    return build();
  } catch (err) {
    recordSectionFault(err);
    return sectionFailed(label);
  }
}

// moreLink: one quiet pointer row entry (icon + label + a chevron) to a screen that
// owns the detail this screen no longer embeds. The chevron, not the external-link
// glyph: this is in-app navigation, not a new tab. The label matches the rail's name
// for the screen ("Costs"), so the pointer and its destination read as one thing.
function moreLink(label: string, icon: string, route: string): HTMLElement {
  return h(
    "button",
    { "data-dp": "overview.button.navigate#1", class: "linklike", type: "button", style: "display:inline-flex;align-items:center;gap:var(--space-2)", on: { click: () => navigate(route) } },
    h("span", { style: "color:var(--text-muted);display:inline-flex", "aria-hidden": "true" }, svgIcon(icon, { size: 14 })),
    label,
    svgIcon(ICON_CHEVRON_RIGHT, { size: 13 }),
  );
}
