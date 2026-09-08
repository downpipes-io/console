// The provider GRID: the one work surface of the external-identity-providers screen. It replaces the old
// "pick a provider from a dropdown" step with a tile per provider, so an owner sees the whole catalogue at a
// glance and which providers their team is already signed in with. A tile is one of three states:
//
//   live        a connection exists AND at least one is enabled  -> the animated "Active" tile, click to MANAGE
//   configured  a connection exists but every one is disabled    -> a quiet ringed tile, click to MANAGE
//   available   no connection yet                                -> a plain tile with "Add", click to ADD
//
// Tiles are built from the engine's preset catalogue (so an "available" tile always has the preset its add
// form needs) PLUS one synthetic SAML 2.0 tile (SAML has no preset; the console composes that proposal). A
// connection is matched to its tile through providerKey() so a connection seeded as "entra-oidc" lines up
// with the "entra" preset tile. Any connection whose provider is not in the catalogue still gets its own
// tile, so a configured connection can never become invisible/unmanageable.
//
// GATING is mirrored, not the control: a non-owner sees the same grid (which providers exist is not a
// secret) but an "available" tile reads "Owner" rather than "Add", and the detail panel the coordinator
// mounts carries the honest owner-only gate. The engine enforces; this is UX only.
//
// House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { ICON_PLUS, ICON_LOCK } from "../../lib/icons.ts";
import type { IdpPreset, IdpConnectionView } from "../../api.ts";
import { providerKey, providerLogo, PROVIDER_META, type ProviderKey } from "./provider-logos.ts";

export type TileState = "live" | "configured" | "available";

// One provider tile: a stable id (the grouping key), the canonical provider key (null for an unrecognised
// catalogue/connection provider), the display label, the preset its add form needs (absent for the SAML
// tile and for an orphan-connection tile), whether it is the synthetic SAML tile, and the connection(s)
// already configured for it. rank drives the popularity order.
export interface ProviderTile {
  id: string;
  key: ProviderKey | null;
  label: string;
  preset?: IdpPreset;
  isSaml: boolean;
  conns: IdpConnectionView[];
  rank: number;
}

// tileKeyOfConn folds a connection onto the same grouping key its tile uses: SAML on its kind, everything
// else on its provider key, with an unrecognised provider kept distinct by its presetId so it still groups.
function tileKeyOfConn(c: IdpConnectionView): string {
  if (c.kind === "saml") return "saml";
  return providerKey(c) ?? `unknown:${c.presetId}`;
}

// buildProviderTiles assembles the ordered tile list from the catalogue + connections. Pure (no DOM), so the
// coordinator can rebuild it on reload and re-find the selected tile by id.
export function buildProviderTiles(presets: IdpPreset[], conns: IdpConnectionView[]): ProviderTile[] {
  const connsByTile = new Map<string, IdpConnectionView[]>();
  for (const c of conns) {
    const k = tileKeyOfConn(c);
    const list = connsByTile.get(k);
    if (list) list.push(c);
    else connsByTile.set(k, [c]);
  }

  const tiles: ProviderTile[] = [];
  const added = new Set<string>();

  // The SAML tile always exists (there is no SAML preset; the console composes the proposal).
  tiles.push({ id: "saml", key: "saml", label: PROVIDER_META.saml.label, isSaml: true, rank: PROVIDER_META.saml.rank, conns: connsByTile.get("saml") ?? [] });
  added.add("saml");

  // One tile per catalogue preset, folded onto its provider key (so two spellings of one vendor collapse).
  // A SAML-kind preset (none ship today) folds into the SAML tile above rather than making a second one.
  presets.forEach((p, i) => {
    const key = providerKey(p.id);
    if (key === "saml") return;
    const tk = key ?? `unknown:${p.id}`;
    if (added.has(tk)) return;
    added.add(tk);
    tiles.push({
      id: tk,
      key,
      label: key ? PROVIDER_META[key].label : p.label,
      preset: p,
      isSaml: false,
      rank: key ? PROVIDER_META[key].rank : 100 + i,
      conns: connsByTile.get(tk) ?? [],
    });
  });

  // Any connection configured against a provider the catalogue does not offer still gets a tile, so it stays
  // visible and manageable (it is always already-configured, so it only ever opens the manage view).
  let orphanRank = 200;
  for (const [tk, cs] of connsByTile) {
    if (added.has(tk)) continue;
    added.add(tk);
    const key = cs[0] ? providerKey(cs[0]) : null;
    tiles.push({ id: tk, key, label: key ? PROVIDER_META[key].label : (cs[0]?.label ?? "Identity provider"), isSaml: false, rank: orphanRank++, conns: cs });
  }

  tiles.sort((a, b) => a.rank - b.rank);
  return tiles;
}

// tileState derives the visual + interaction state from the tile's connections.
export function tileState(tile: ProviderTile): TileState {
  if (tile.conns.length === 0) return "available";
  return tile.conns.some((c) => c.enabled) ? "live" : "configured";
}

// renderProviderGrid paints the tile grid. selectedId highlights the tile whose detail is open. onSelect is
// called with the tile when its button is activated; the coordinator decides add vs manage from the state.
export function renderProviderGrid(
  tiles: ProviderTile[],
  canManage: boolean,
  onSelect: (tile: ProviderTile) => void,
  selectedId: string | null,
): HTMLElement {
  const grid = h("div", { class: "idp-grid", role: "list", "aria-label": "Identity providers", dataset: { tourId: "idp-providers" } });
  for (const tile of tiles) grid.appendChild(tileButton(tile, canManage, onSelect, selectedId));
  return grid;
}

function tileButton(tile: ProviderTile, canManage: boolean, onSelect: (tile: ProviderTile) => void, selectedId: string | null): HTMLElement {
  const state = tileState(tile);
  const enabledCount = tile.conns.filter((c) => c.enabled).length;

  // The accessible name spells out the provider AND what activating it does, so the chip is not load-bearing
  // for assistive tech.
  const action = state === "available" ? (canManage ? "add a connection" : "owner only") : "manage";
  const stateWord = state === "live" ? `active, ${enabledCount} enabled` : state === "configured" ? "configured, currently off" : "not configured";

  const btn = h(
    "button",
    { "data-dp": "idp-connections.button.select",
      class: "idp-tile",
      type: "button",
      role: "listitem",
      "data-state": state,
      "aria-label": `${tile.label}: ${stateWord}. ${action}.`,
      ...(selectedId === tile.id ? { "aria-current": "true", "data-selected": "true" } : {}),
    },
    h("span", { class: "idp-tile__logo" }, providerLogo(tile.key)),
    h("span", { class: "idp-tile__name" }, tile.label),
    cornerChip(state, tile.conns.length, canManage),
  );
  btn.addEventListener("click", () => onSelect(tile));
  return btn;
}

// cornerChip is the small bottom-corner status: "Active" (teal, with a live dot) for an enabled provider,
// "Off" for a configured-but-disabled one, "Add" for an available one (or "Owner" when the viewer cannot
// manage). A live provider with more than one connection shows the count so the manage view is expected.
function cornerChip(state: TileState, connCount: number, canManage: boolean): HTMLElement {
  if (state === "live") {
    return h(
      "span",
      { class: "idp-tile__chip idp-tile__chip--active" },
      h("span", { class: "idp-tile__chip-dot", "aria-hidden": "true" }),
      connCount > 1 ? `Active · ${connCount}` : "Active",
    );
  }
  if (state === "configured") {
    return h("span", { class: "idp-tile__chip idp-tile__chip--off" }, connCount > 1 ? `Off · ${connCount}` : "Off");
  }
  if (!canManage) {
    return h("span", { class: "idp-tile__chip idp-tile__chip--owner" }, svgIcon(ICON_LOCK, { size: 11 }), "Owner");
  }
  return h("span", { class: "idp-tile__chip idp-tile__chip--add" }, svgIcon(ICON_PLUS, { size: 12 }), "Add");
}
