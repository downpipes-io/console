// The map view's pure URL + filter helpers: the base route, the filter -> query-string builders
// and the in-place filter application over the cached flow set. Factored out of view.ts for size.
// These own no view lifecycle and no `this`: they take the present filter state (the FilterState
// the filter bar already reads) plus the flows as parameters and return a value (a filtered flow
// set, a query string, or perform the best-effort history write). Moved verbatim from view.ts;
// behaviour is unchanged. House rules: Australian English, no em dashes, precise claims.

import type { FlowRecord } from "../../components/topology.ts";
import { flowTouchesNode } from "./panels.ts";
import type { FilterState } from "./filter-bar.ts";

// The base route this screen owns. The drawer selection is reflected as ?open=<id> on this
// SAME path, so the URL reads /map?open=<id> while a drawer is open and closing returns to
// /map; the status / kind filters live in ?status= / ?kind= (shareable, survive refresh).
export const MAP_ROUTE = "/map";

// applyFilters re-applies the status / kind / node filters to a flow set. A filter is a pure
// view over the last fetched flows, so this never touches the network.
export function applyFilters(flows: FlowRecord[], filters: FilterState): FlowRecord[] {
  let out = flows;
  if (filters.statusFilter !== null) out = out.filter((f) => f.status === filters.statusFilter);
  if (filters.kindFilter !== null) out = out.filter((f) => f.source.kind === filters.kindFilter);
  if (filters.nodeFilter !== null) out = out.filter((f) => flowTouchesNode(f, filters.nodeFilter!));
  return out;
}

// buildFilterQuery assembles the ?status=&kind=&node= params from the present filter state,
// optionally adding ?open=<id> when a drawer is open. The shared builder behind the URL
// reflection, the closed-state suffix and the open-drawer push, so the param order is one source.
export function buildFilterQuery(filters: FilterState, openId: string | null): URLSearchParams {
  const qs = new URLSearchParams();
  if (filters.statusFilter !== null) qs.set("status", filters.statusFilter);
  if (filters.kindFilter !== null) qs.set("kind", filters.kindFilter);
  if (filters.nodeFilter !== null) qs.set("node", filters.nodeFilter);
  if (openId !== null) qs.set("open", openId);
  return qs;
}

// filterSuffix builds the ?status=&kind=&node= suffix WITHOUT ?open (the closed state).
export function filterSuffix(filters: FilterState): string {
  const s = buildFilterQuery(filters, null).toString();
  return s ? `?${s}` : "";
}

// reflectFiltersInUrl reflects the present filters (and any open drawer) into the URL with a
// best-effort replaceState, so a view is shareable and survives refresh without a navigation.
export function reflectFiltersInUrl(filters: FilterState, openId: string | null): void {
  const qs = buildFilterQuery(filters, openId);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  try {
    history.replaceState({}, "", `${MAP_ROUTE}${suffix}`);
  } catch {
    // best-effort; a blocked history API just means the URL is not reflected.
  }
}
