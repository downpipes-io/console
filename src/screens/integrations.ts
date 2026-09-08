// Integrations (route /integrations): the SIEM / observability / ITSM / notification catalogue as one logo-tile
// grid, the deliberate twin of the Identity providers screen (/access/idp). It answers ONE question, "which
// tools can I forward the audit trail and metrics to, and how do I connect one?", the same way the IdP screen
// answers "which identity providers can my team sign in with?". The whole catalogue is visible at a glance; a
// destination already set up glows "Active" and opens its settings, one not yet set up reads "Add".
//
// This screen adds NO new config plumbing. Each tile's panel REUSES the config surfaces Settings and
// Notifications already ship (renderPushDestination, renderOtlpPushDestination, renderPullCredentials, the
// channel form), framed with the vendor's method line and, where honest, the "Auto-parses" tag. The four write
// systems keep their own gates: the SIEM push, the OTLP push and the pull credentials are hard owner-only
// server-side (no narrower capability exists), the notify channels are the notify.config capability. This
// screen mirrors those gates as UX; the engine enforces.
//
// This file is the COORDINATOR (the screen descriptor + load + the detail panel). The catalogue is in
// integrations/catalogue.ts, the marks in integrations/marks.ts, the grid in integrations/grid.ts, the tile
// state deriver in integrations/state.ts, and the per-vendor panel body in integrations/panels.ts.
//
// House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon, scrollToSafe } from "../lib/dom.ts";
import { pageHeader, requireEngine, canCap, canDo, callerIsUnresolved, defineScreen, type Screen, type ScreenContext } from "./common.ts";
import { goSignedOut } from "../lib/nav.ts";
import { isUnauthorised, classifyError } from "../lib/errors.ts";
import type { EngineClient } from "../api.ts";
import { skeletonTiles, banner, noteQuiet } from "../components/feedback.ts";
import { ICON_INFO, ICON_CHEVRON_LEFT } from "../lib/icons.ts";
import { vendorsByCategory, type Vendor } from "./integrations/catalogue.ts";
import { integrationMark } from "./integrations/marks.ts";
import { renderIntegrationGrid, connectedSummary, focusTile, tileId, type IntegrationTile, type ManageGate, type TileGroup } from "./integrations/grid.ts";
import { vendorState, type ConfigSnapshot } from "./integrations/state.ts";
import { renderSetupBody } from "./integrations/panels.ts";
import { sessionEnded } from "../components/error-view.ts";

export const ROUTE_INTEGRATIONS = "/integrations";

// canManage a vendor: the notify channels are the notify.config capability; the SIEM push, OTLP push and pull
// credentials are hard owner-only (see the panel bodies, which show the owner gate instead of the form).
function canManageVendor(v: Vendor): boolean {
  return v.kind === "notify" ? canCap("notify.config") : canDo("owner");
}

// vendorGate is what the SURFACE renders from, and it is deliberately not the same value the GATE decides.
// canManageVendor above is the gate and it is unchanged: it fails closed on an unresolved caller, which is
// correct, because an affordance must never be offered before the engine has said who is asking.
//
// What was wrong was the SENTENCE. A fail-closed default was printed as the settled fact "Owner" on every
// tile and as "Configuring this is owner only" in every panel, so an actual owner opening /integrations was
// told, in 40 places at once, that they were not the owner. It corrected itself when whoami landed and the
// screen re-rendered, which is why it reads as a flicker rather than a fault, but for the render it governs
// it is a false statement about the reader's own authority with no reason and no remedy attached. This is
// the same distinction identity-remedy.ts already draws for every other gated screen: a role refusal and an
// unread role are different situations with different remedies, and telling a real owner to ask an owner
// sends them to themselves.
//
// canManageVendor is called FIRST and always, so its blind witness (noteGateComputedBlind, via canDo/canCap)
// still fires exactly as before and the support pack's identity-stale-gate row for this screen is unchanged.
function vendorGate(v: Vendor): ManageGate {
  const allowed = canManageVendor(v);
  if (allowed) return "allowed";
  return callerIsUnresolved() ? "unresolved" : "refused";
}

export const integrationsScreen: Screen = defineScreen({
  route: ROUTE_INTEGRATIONS,
  title: "Integrations",
  measure: "wide",
  actions: [
    {
      id: "integrations.open",
      title: "Integrations (SIEM and monitoring)",
      group: "Navigation",
      kind: "navigate",
      keywords: ["integrations", "siem", "monitoring", "observability", "splunk", "datadog", "sentinel", "qradar", "elastic", "prometheus", "grafana", "pagerduty", "opsgenie", "servicenow", "slack", "webhook", "audit push", "metrics", "forward audit"],
      target: ROUTE_INTEGRATIONS,
    },
  ],
  render(_ctx: ScreenContext): HTMLElement {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;
    const eng = engine;

    root.appendChild(
      pageHeader(
        "Integrations",
        "Forward your audit trail and metrics to the tools your team already runs. Pick a destination to connect it; the format it reads is chosen for you, so there is nothing to map. A destination already in use opens its settings.",
        undefined,
        { label: "Notifications", to: "/notifications" },
      ),
    );

    const connectedRegion = h("div", { style: "margin-top:var(--space-4)" });
    const gridRegion = h("div", { class: "async-region", style: "margin-top:var(--space-5)" });
    const detailRegion = h("div", { class: "idp-detail-region", style: "margin-top:var(--space-5)" });
    root.appendChild(connectedRegion);
    root.appendChild(gridRegion);
    root.appendChild(detailRegion);
    root.appendChild(trademarkNote());

    let selectedId: string | null = null;
    // The tile a close owes focus back to (WCAG 2.4.3), consumed by the next renderGrid.
    //
    // It cannot be focused inside closeDetail itself. closeDetail calls loadAll(), which with no selection
    // replaces the whole grid with skeleton tiles SYNCHRONOUSLY and only rebuilds the real tiles once the six
    // reads settle. A tile focused on the way out is therefore detached moments later, the browser drops
    // document.activeElement to <body>, and the operator is back where this is meant to stop them being.
    let returnFocusTo: string | null = null;
    let currentGroups: TileGroup[] = [];
    let currentFlat: IntegrationTile[] = [];
    let currentSnap: ConfigSnapshot = { push: null, otlp: null, support: null, channels: [], rules: [], downpipes: [] };

    const renderGrid = (): void => {
      // Gate each tile on the caller's REAL per-vendor capability (vendorGate over canManageVendor), never a
      // hardcoded true: an operator must read an owner-only SIEM/OTLP/pull tile as "Owner"/"owner only", not a
      // false "Add" the setup panel then refuses, and must read "Checking" rather than "Owner" while the
      // identity report is still in flight. The panel gates the same way (renderSetupBody takes the same gate).
      gridRegion.replaceChildren(renderIntegrationGrid(currentGroups, vendorGate, openTile, selectedId));
      // The one moment the tile a close owes focus to actually exists in the document. Cleared either way:
      // an unsatisfiable request must not sit here and move focus on some later, unrelated re-render.
      if (returnFocusTo !== null) {
        focusTile(gridRegion, returnFocusTo);
        returnFocusTo = null;
      }
    };
    const renderConnected = (): void => {
      const strip = connectedSummary(currentFlat);
      connectedRegion.replaceChildren(strip ?? h("span"));
    };
    const renderDetail = (tile: IntegrationTile): void => {
      detailRegion.replaceChildren(detailPanel(eng, tile, currentSnap, reload, closeDetail));
      const panel = detailRegion.firstElementChild as HTMLElement | null;
      if (panel) { scrollToSafe(panel, { behavior: "smooth", block: "nearest" }); panel.focus(); }
    };
    const openTile = (tile: IntegrationTile): void => {
      selectedId = tile.id;
      renderGrid();
      renderDetail(tile);
    };
    const closeDetail = (): void => {
      // Hand focus back to the tile this panel was opened from. openTile's half of the pair already moves
      // focus INTO the panel (renderDetail focuses the tabindex="-1" section), so without this the screen
      // managed focus in one direction only: an operator who opened Splunk with the keyboard and backed out
      // landed on <body> and had to traverse the whole page to reach the tile they were on. renderGrid
      // performs the move, once the rebuilt tile is in the document.
      returnFocusTo = selectedId;
      selectedId = null;
      // Re-read state on close so a just-configured destination flips to Active in the grid.
      loadAll();
      detailRegion.replaceChildren(selectHint());
    };
    const reload = (): void => loadAll();

    function loadAll(): void {
      if (!selectedId) gridRegion.replaceChildren(skeletonTiles(10));
      void Promise.allSettled([eng.getPush(), eng.getOtlpPush(), eng.getSupport(), eng.listNotifyChannels(), eng.listNotifyRules(), eng.listDownpipes()]).then((results) => {
        const [pushRes, otlpRes, supportRes, channelsRes, rulesRes, downpipesRes] = results;
        // If every read is unauthorised, the session is gone: hand off to signed-out.
        if (results.every((r) => r.status === "rejected") && results.some((r) => r.status === "rejected" && isUnauthorised(r.reason))) {
          // PAINT FIRST, THEN LEAVE: the tile grid is ten skeleton tiles until this replaces them.
          gridRegion.replaceChildren(sessionEnded(reload));
          connectedRegion.replaceChildren();
          // No grid means no tile to return focus to, and the pending request must not survive to steal
          // focus from whatever the signed-out screen puts there.
          returnFocusTo = null;
          goSignedOut();
          return;
        }
        // If every read failed (not auth), the feature is not wired on this engine build, or the engine is
        // faulted: show the honest note rather than an empty grid that would read as "no integrations".
        if (results.every((r) => r.status === "rejected")) {
          handleLoadError(pushRes.status === "rejected" ? pushRes.reason : undefined, gridRegion);
          connectedRegion.replaceChildren();
          // Same reason as the branch above: the grid was replaced by a note, so there is no tile to
          // return to and the request is dropped rather than left pending.
          returnFocusTo = null;
          return;
        }

        currentSnap = {
          push: pushRes.status === "fulfilled" ? pushRes.value : null,
          otlp: otlpRes.status === "fulfilled" ? otlpRes.value : null,
          support: supportRes.status === "fulfilled" ? supportRes.value : null,
          channels: channelsRes.status === "fulfilled" ? channelsRes.value : [],
          // rules + downpipes back the notify routing surface only; a failure there is non-critical (the grid
          // and every other panel still render), so default to empty rather than degrade the whole screen.
          rules: rulesRes.status === "fulfilled" ? rulesRes.value : [],
          downpipes: downpipesRes.status === "fulfilled" ? downpipesRes.value : [],
        };

        const built = buildTiles(currentSnap);
        currentGroups = built.groups;
        currentFlat = built.flat;

        renderConnected();
        renderGrid();

        if (selectedId) {
          const t = currentFlat.find((x) => x.id === selectedId);
          if (t) renderDetail(t);
          else closeDetail();
        }
      });
    }

    detailRegion.replaceChildren(selectHint());
    loadAll();
    return root;
  },
});

// buildTiles turns the catalogue + a config snapshot into the grouped tiles (for the grid) and a flat list (for
// the connected strip and re-finding the open tile). Pure over the snapshot.
function buildTiles(snap: ConfigSnapshot): { groups: TileGroup[]; flat: IntegrationTile[] } {
  const flat: IntegrationTile[] = [];
  const groups = vendorsByCategory().map(({ category, vendors }) => ({
    category,
    tiles: vendors.map((v) => {
      const tile: IntegrationTile = { id: tileId(v), vendor: v, state: vendorState(v, snap) };
      flat.push(tile);
      return tile;
    }),
  }));
  return { groups, flat };
}

// detailPanel is what a tile opens below the grid: a back control + the vendor mark and name, then the
// kind-specific setup body (panels.ts), which reuses the real config surface behind that destination.
function detailPanel(engine: EngineClient, tile: IntegrationTile, snap: ConfigSnapshot, reload: () => void, onClose: () => void): HTMLElement {
  const v = tile.vendor;
  const panel = h("section", { class: "card idp-detail", style: "display:grid;gap:var(--space-4)", tabindex: "-1", "aria-label": `${v.name}: set up` });
  const back = h("button", { "data-dp": "integrations.button.back", class: "btn btn--ghost btn--sm idp-detail__back", type: "button" }, svgIcon(ICON_CHEVRON_LEFT, { size: 14 }), "All integrations") as HTMLButtonElement;
  back.addEventListener("click", onClose);
  panel.appendChild(
    h("div", { class: "idp-detail__head" },
      back,
      h("div", { class: "idp-detail__title" },
        h("span", { class: "idp-detail__logo" }, integrationMark(v.mark, v.name, 26)),
        h("h2", { style: "font-size:var(--text-lg);margin:0" }, v.name),
      ),
    ),
  );
  panel.appendChild(renderSetupBody(engine, v, vendorGate(v), snap, reload));
  return panel;
}

function selectHint(): HTMLElement {
  return noteQuiet(
    h("span", { style: "display:flex;gap:var(--space-2);align-items:flex-start" },
      h("span", { style: "flex:none;margin-top:1px" }, svgIcon(ICON_INFO, { size: 16 })),
      h("span", { class: "measure" }, "Select a destination above to connect it."),
    ),
  );
}

function trademarkNote(): HTMLElement {
  return h("p", { class: "idp-trademark-note measure", style: "margin-top:var(--space-6)" },
    "Product names and logos are trademarks of their respective owners and are shown only to indicate supported integrations. downpipes is not affiliated with, endorsed by, or sponsored by them.");
}

function handleLoadError(err: unknown, gridRegion: HTMLElement): void {
  const kind = err === undefined ? { kind: "unknown" as const } : classifyError(err);
  const notWired = kind.kind === "server" && (kind.status === 404 || kind.status === 501);
  gridRegion.replaceChildren(
    banner({
      tone: "info",
      message: notWired
        ? "Forwarding to SIEM and monitoring tools is not active on this engine build yet. The destinations you can connect appear here once the engine supports it."
        : "The integration state could not load. Reload the page to try again.",
    }),
  );
}
