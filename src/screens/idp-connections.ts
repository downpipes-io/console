// External identity providers (IA route /access/idp): the OWNER surface that wires native external-IdP
// single sign-on, native OIDC / OAuth2 (from a vendor preset) and native SAML 2.0 (the generic SP path),
// so a team can sign in with Microsoft, Okta, Google, Keycloak, a generic OIDC provider, or any SAML IdP,
// WITHOUT Cloudflare Access and without the shared break-glass token. The sign-in BUTTONS for these live on
// the sign-in screen (passkey.ts); THIS screen is the management half: see every provider, add one, and
// toggle/remove the ones in use.
//
// The ONE primary question this screen answers: "which identity providers can my team sign in with, and how
// do I add or remove one?" The work surface is a GRID of provider tiles (one logo per provider, ordered by
// popularity): a tile a team already uses glows with an "Active" ring and opens its management (enable /
// disable / remove, and the SAML metadata handoff); a tile not yet used reads "Add" and opens that
// provider's add wizard. This replaced the old "choose a provider from a dropdown" step: the whole catalogue
// is visible at a glance, and the detail for the chosen one mounts in a panel below the grid.
//
// NO-CUSTODY / WRITE-ONLY SECRET: the console NEVER builds an OIDC connection itself, it reads the engine's
// preset catalogue, renders the required values, and POSTs {presetId, vars, clientId, secret?}; the engine
// owns the preset templates and the privileged build (the no-customer-CLI rule). The client SECRET is
// write-only: it is posted on create and never displayed back (a redacted connection carries only a {mode}
// descriptor). A SAML connection has no secret at all (its signing certs are public).
//
// GATING is MIRRORED, never the control: connection management is owner-reserved (keys.ceremony) and the
// engine ENFORCES it server-side; this screen mirrors the gate as UX only (a non-owner sees the grid, with
// an "Owner" chip on an unconfigured tile and the honest gate inside the detail panel). Every server-supplied
// string renders through dom.ts as a text node, so a connection label, an issuer or a SAML entity id can only
// ever be inert text. Provider names and logos are trademarks of their owners, shown to mark supported
// integrations; the disclaimer below the grid says so.
//
// This file is the COORDINATOR: it owns the screen descriptor (route, title, measure, actions, render) and
// re-exports the symbols external callers depend on. The provider grid lives in ./idp-connections/grid.ts;
// the connection management cards in ./idp-connections/list.ts; the OIDC/OAuth2 add form in
// ./idp-connections/forms.ts and the SAML add form in ./idp-connections/saml-form.ts; the shared leaf
// helpers, constants and presenters in ./idp-connections/shared.ts.
//
// House rules: Australian English, no em dashes, precise claims.

import type { EngineClient } from "../api.ts";
import { blockError } from "../components/error-view.ts";
import { banner, noteQuiet, postureStrip, skeletonTiles } from "../components/feedback.ts";
import type { StatusTone } from "../components/status.ts";
import { recordContractSkew } from "../lib/client-diag/ring.ts";
import { h, scrollToSafe, svgIcon } from "../lib/dom.ts";
import { classifyError, isUnauthorised } from "../lib/errors.ts";
import { ICON_CHEVRON_LEFT, ICON_INFO, ICON_PLUS } from "../lib/icons.ts";
import { goSignedOut, navigate } from "../lib/nav.ts";
import {
  canCap,
  capGateReason,
  defineScreen,
  pageHeader,
  pendingEngineNote,
  requireEngine,
  type Screen,
  type ScreenContext,
} from "./common.ts";
import { presetForm } from "./idp-connections/forms.ts";
import type { TakenConnIds } from "./idp-connections/shared.ts";
import { buildProviderTiles, type ProviderTile, renderProviderGrid, tileState } from "./idp-connections/grid.ts";
import { renderConnections } from "./idp-connections/list.ts";
import { providerLogo } from "./idp-connections/provider-logos.ts";
import { samlForm } from "./idp-connections/saml-form.ts";
import { MANAGE_CAP, ROUTE_IDP } from "./idp-connections/shared.ts";

// Re-exports: the idp validator (test/validate-idp.ts) imports the PEM splitter, the engine-reason
// capitaliser and the kind-label presenter BY NAME from this module. They live in the shared leaf (all
// pure); re-exporting them here keeps the public import surface of screens/idp-connections.ts byte-identical.
export { capitalise, kindLabel, splitPems } from "./idp-connections/shared.ts";

export const idpConnectionsScreen: Screen = defineScreen({
  route: ROUTE_IDP,
  title: "Identity providers",
  measure: "wide",
  actions: [
    {
      id: "idp.open",
      title: "Manage identity providers (SSO)",
      group: "Navigation",
      kind: "navigate",
      keywords: ["sso", "identity provider", "idp", "oidc", "oauth", "saml", "single sign-on", "okta", "entra", "microsoft", "google", "keycloak", "sign in with", "connection"],
      target: ROUTE_IDP,
    },
  ],
  render(_ctx: ScreenContext): HTMLElement {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;

    const canManage = canCap(MANAGE_CAP);
    // Capture the non-null engine for the hoisted loadAll() below: a function declaration does not inherit
    // the null-narrowing the guard above applies in the render body.
    const eng = engine;

    // Title strip: the one h1 + one-line description. The custody claim lives once in the posture line below.
    root.appendChild(
      pageHeader(
        "Identity providers",
        "Let your team sign in with your own identity provider, Microsoft, Okta, Google, a generic OIDC provider, or SAML. Pick a provider below to add it; a provider already in use opens its settings. The sign-in buttons appear on the sign-in screen once a connection is enabled.",
        undefined,
        { label: "Roles and access", to: "/access/roles" },
      ),
    );

    // ONE posture line: the standing facts as quiet dot+phrase items. The counts fill
    // in once the grid loads (it starts at a calm "loading").
    const postureHost = h("div", { style: "margin-top:var(--space-4)", dataset: { tourId: "idp-connection" } });
    root.appendChild(postureHost);

    // The honest "this is optional, and how it maps to roles" line, demoted to one quiet note.
    root.appendChild(
      h(
        "div",
        { style: "margin-top:var(--space-3)" },
        noteQuiet(
          h("span", { style: "display:flex;gap:var(--space-2);align-items:flex-start" },
            h("span", { style: "flex:none;margin-top:1px" }, svgIcon(ICON_INFO, { size: 16 })),
            h("span", { class: "measure", dataset: { tourId: "idp-add" } },
              "Optional. downpipes works fully on passkeys or the shared token; an external IdP is for teams that want their existing single sign-on. However a person signs in, Cloudflare Access, a native IdP here, or a passkey, roles and group mappings are applied the same way (set them on the ",
              h("button", { "data-dp": "idp-connections.button.navigate-access-roles", class: "linklike", type: "button", on: { click: () => navigate("/access/roles") } }, "Roles and access"),
              " tab).",
            ),
          ),
        ),
      ),
    );

    // The two work regions: the provider grid, and the detail panel the chosen tile mounts into. The grid
    // loads async; the posture line is updated from the same result so the two never disagree. Below them,
    // the standing trademark/ownership line for the logos.
    const gridRegion = h("div", { class: "async-region", style: "margin-top:var(--space-5)" });
    const detailRegion = h("div", { class: "idp-detail-region", style: "margin-top:var(--space-5)" });
    root.appendChild(gridRegion);
    root.appendChild(detailRegion);
    root.appendChild(trademarkNote());

    const setPosture = buildPostureHost(postureHost);

    // The screen state: which tile's detail is open, and the latest tiles (rebuilt on each load so a reload
    // after an add/remove re-finds the open tile by id and refreshes its detail in place).
    let selectedId: string | null = null;
    let currentTiles: ProviderTile[] = [];
    // The connection ids ALREADY configured, which the add forms refuse a collision against (the engine
    // refuses one at engine/src/admin/idpconn.ts:59, and only at submit). It starts null and STAYS null on
    // any load where the console did not really establish the set, so the forms say nothing about
    // collisions rather than refusing an id that may well be free.
    let takenConnIds: TakenConnIds = null;

    const renderGrid = (): void => {
      gridRegion.replaceChildren(renderProviderGrid(currentTiles, canManage, openTile, selectedId));
    };
    const renderDetail = (tile: ProviderTile, forceAdd: boolean): void => {
      detailRegion.replaceChildren(detailPanel(engine, tile, canManage, forceAdd, reload, () => renderDetail(tile, true), closeDetail, takenConnIds));
      const panel = detailRegion.firstElementChild as HTMLElement | null;
      if (panel) { scrollToSafe(panel, { behavior: "smooth", block: "nearest" }); panel.focus(); }
    };
    const openTile = (tile: ProviderTile): void => {
      selectedId = tile.id;
      renderGrid();
      renderDetail(tile, false);
    };
    const closeDetail = (): void => {
      selectedId = null;
      renderGrid();
      detailRegion.replaceChildren(selectHint());
    };
    const reload = (): void => loadAll();

    function loadAll(): void {
      gridRegion.replaceChildren(skeletonTiles(8));
      void Promise.allSettled([eng.idpPresets(), eng.idpConnections()]).then(([presetsRes, connsRes]) => {
        // The connection list is the authority for state. If it cannot load, the whole feature is either not
        // wired on this engine build (404/501) -> the honest pending note, or genuinely faulted (500/network)
        // -> the honest block error with Retry; never an empty grid that would read as "no providers".
        if (connsRes.status === "rejected") {
          handleLoadError(connsRes.reason, setPosture, gridRegion, reload);
          detailRegion.replaceChildren();
          return;
        }
        // A payload with NO `connections` array defaults to empty, and every provider tile then reads
        // "Add" on an account that is running three live connections. The console cannot tell that from an
        // account that genuinely has none, and neither could the pack. The default is right; the silence was not.
        if (connsRes.value.connections === undefined) recordContractSkew("missing-field", "idp-connections");
        const conns = connsRes.value.connections ?? [];
        // A payload with NO `connections` array is the one case the console cannot tell an empty account
        // from an unread one (the skew above is that exact fact), so the id set stays null and the add
        // forms make no collision claim. Every other load gives a real set, including a genuinely empty one.
        takenConnIds = connsRes.value.connections === undefined ? null : new Set(conns.map((c) => c.id));
        const presets = presetsRes.status === "fulfilled" ? (presetsRes.value.presets ?? []) : [];
        currentTiles = buildProviderTiles(presets, conns);

        const enabled = conns.filter((c) => c.enabled).length;
        setPosture([
          { tone: conns.length > 0 ? "ok" : "neutral", label: `${conns.length} connection${conns.length === 1 ? "" : "s"} configured` },
          { tone: enabled > 0 ? "ok" : "neutral", label: `${enabled} enabled on the sign-in screen` },
          { tone: "trust", label: "no secret is ever displayed back" },
        ]);

        renderGrid();
        // The provider catalogue did not load (but connections did): only configured providers and SAML show.
        // Say so quietly rather than silently dropping the unconfigured vendors.
        if (presetsRes.status === "rejected") gridRegion.appendChild(catalogueNote());

        // Re-open the selected tile from fresh data (its state may have flipped, e.g. just-added or removed);
        // otherwise show the calm "pick a provider" hint.
        if (selectedId) {
          const t = currentTiles.find((x) => x.id === selectedId);
          if (t) renderDetail(t, false);
          else closeDetail();
        } else {
          detailRegion.replaceChildren(selectHint());
        }
      });
    }

    loadAll();
    return root;
  },
});

type PostureSetter = (items: Array<{ tone: StatusTone; label: string }>) => void;

// buildPostureHost wires the ONE posture line and paints the initial calm "loading" state, returning the
// setter the loader calls so the posture and the grid never disagree.
function buildPostureHost(postureHost: HTMLElement): PostureSetter {
  const setPosture: PostureSetter = (items) => {
    postureHost.replaceChildren(postureStrip(items, { label: "Identity-provider posture" }));
  };
  setPosture([{ tone: "neutral", label: "loading providers" }, { tone: "trust", label: "no secret is ever displayed back" }]);
  return setPosture;
}

// detailPanel is what a tile opens below the grid: the add wizard for an available provider (or when
// "Add another" is pressed on a configured one), otherwise the management cards for the configured
// connection(s). A header carries a "back to all providers" control + the provider mark and name.
function detailPanel(
  engine: EngineClient,
  tile: ProviderTile,
  canManage: boolean,
  forceAdd: boolean,
  reload: () => void,
  onAddAnother: () => void,
  onClose: () => void,
  taken?: TakenConnIds,
): HTMLElement {
  const state = tileState(tile);
  const adding = forceAdd || state === "available";
  const panel = h("section", {
    class: "card idp-detail",
    style: "display:grid;gap:var(--space-4)",
    tabindex: "-1",
    "aria-label": `${tile.label}: ${adding ? "add a connection" : "manage connections"}`,
  });

  // Header: back control + the provider mark and name.
  const back = h("button", { "data-dp": "idp-connections.button.back", class: "btn btn--ghost btn--sm idp-detail__back", type: "button" }, svgIcon(ICON_CHEVRON_LEFT, { size: 14 }), "All providers") as HTMLButtonElement;
  back.addEventListener("click", onClose);
  panel.appendChild(
    h("div", { class: "idp-detail__head" },
      back,
      h("div", { class: "idp-detail__title" },
        h("span", { class: "idp-detail__logo" }, providerLogo(tile.key, 26)),
        h("h2", { style: "font-size:var(--text-lg);margin:0" }, tile.label),
      ),
    ),
  );

  if (adding) {
    if (!canManage) { panel.appendChild(ownerOnlyGate()); return panel; }
    panel.appendChild(tile.isSaml ? samlForm(engine, reload, taken) : tile.preset ? presetForm(engine, tile.preset, reload, taken) : noPresetNote());
    return panel;
  }

  // Management: the configured connection card(s), with an owner affordance to add a second connection of the
  // same provider (some teams run two Okta orgs, two tenants...).
  if (canManage && (tile.preset || tile.isSaml)) {
    const addAnother = h("button", { "data-dp": "idp-connections.button.add-another", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_PLUS, { size: 14 }), `Add another ${tile.label}`) as HTMLButtonElement;
    addAnother.addEventListener("click", onAddAnother);
    panel.appendChild(h("div", { class: "idp-detail__actions" }, addAnother));
  }
  panel.appendChild(renderConnections(engine, tile.conns, canManage, reload));
  return panel;
}

// ownerOnlyGate is the honest non-owner note inside an "add" panel: the same gate the engine enforces,
// mirrored as UX.
function ownerOnlyGate(): HTMLElement {
  return h("div", { class: "stack-sm", style: "display:grid;gap:var(--space-2)" },
    banner({ tone: "info", message: "Adding an identity provider is owner only (it can grant a whole organisation a way in). You can see the configured providers above." }),
    h("p", { class: "field__hint" }, capGateReason(MANAGE_CAP)),
  );
}

// noPresetNote covers the rare degraded case: a configured-but-uncatalogued provider whose add form needs a
// preset the catalogue did not return. The owner can still manage the existing connection; adding a fresh one
// waits on the catalogue.
function noPresetNote(): HTMLElement {
  return h("p", { class: "field__hint measure" }, "This provider's add form needs the engine preset catalogue, which did not load. Reload the page to try again; the configured connection above is unaffected.");
}

// selectHint is the calm prompt in the empty detail region before a tile is chosen.
function selectHint(): HTMLElement {
  return noteQuiet(
    h("span", { style: "display:flex;gap:var(--space-2);align-items:flex-start" },
      h("span", { style: "flex:none;margin-top:1px" }, svgIcon(ICON_INFO, { size: 16 })),
      // The click semantics (active opens settings, other opens the add wizard) live in the page
      // subtitle; repeating them here said the same thing twice on one screen.
      h("span", { class: "measure" }, "Select a provider above."),
    ),
  );
}

// catalogueNote is the quiet "catalogue did not load" line appended under the grid when only the connection
// list came back (so the configured providers + SAML still render, but the unconfigured vendors cannot).
function catalogueNote(): HTMLElement {
  return h("p", { class: "field__hint measure", style: "margin-top:var(--space-3)" }, "The provider catalogue did not load, so only the providers you have configured and the SAML option are shown. Reload the page to see the full list.");
}

// trademarkNote is the standing ownership line for the brand logos (the affordance is nominative: it marks
// supported sign-in integrations, not an affiliation).
function trademarkNote(): HTMLElement {
  return h("p", { class: "idp-trademark-note measure", style: "margin-top:var(--space-6)" },
    "Provider names and logos are trademarks of their respective owners and are shown only to indicate supported sign-in integrations. downpipes is not affiliated with, endorsed by, or sponsored by them.");
}

// handleLoadError paints the honest pending/error note when the connection list cannot load: a 404/501 is the
// "not wired on this engine build yet" note (the management surface is still described); a 401 hands off to
// signed-out; any other fault states the engine reason.
function handleLoadError(err: unknown, setPosture: PostureSetter, gridRegion: HTMLElement, reload: () => void): void {
  if (isUnauthorised(err)) { goSignedOut(); return; }
  const kind = classifyError(err);
  const notWired = kind.kind === "server" && (kind.status === 404 || kind.status === 501);
  setPosture([{ tone: "neutral", label: "provider list unavailable" }, { tone: "trust", label: "no secret is ever displayed back" }]);
  if (!notWired) {
    // A 500 (engine live, IdP routes broken) or a network throw (engine unreachable) is a real fault, not
    // "pending engine support": the pending note frames it as an unbuilt feature and misleads the operator.
    // Render the honest block error with Retry; keep the pending note only for a genuine not-wired build.
    gridRegion.replaceChildren(blockError(err, reload, { origin: location.origin }));
    return;
  }
  gridRegion.replaceChildren(
    pendingEngineNote({
      what: "Native external-IdP sign-in is not active on this engine build yet. The providers you can add appear here once the engine supports it.",
      dependsOn: "engine support for the native IdP routes (GET/POST /admin/idp/connections)",
      interim: "Providers appear here once the engine backs the IdP routes.",
    }),
  );
}

// Re-exported for any consumer that wants the route constant without importing the screen object.
export { ROUTE_IDP };
