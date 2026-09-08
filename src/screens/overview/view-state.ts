// Overview view-state helpers: the fleet table's URL view-state (read on construction,
// reflected on change) and the small serialisation helpers the poll's no-change check and
// the drill error path use. Moved verbatim out of view.ts for size; behaviour unchanged.
// House rules: Australian English, no em dashes, precise claims.

import type { DataTableState } from "../../components/data-table.ts";
import type { OverviewData } from "./shared.ts";

// fleetStateFromQuery reads the fleet table's view-state from the URL (namespaced
// fq/ff/fsort so it never collides with the banner deep-links that target other
// screens). Returns null when nothing is set, so a clean Overview seeds no state.
export function fleetStateFromQuery(): Partial<DataTableState> | null {
  const q = new URLSearchParams(location.search);
  const out: Partial<DataTableState> = {};
  const text = q.get("fq");
  if (text) out.query = text;
  const facets = q.get("ff");
  if (facets) out.facets = facets.split(",").filter((f) => f !== "");
  const sort = q.get("fsort");
  if (sort) {
    const [key, dir] = sort.split(":");
    if (key) out.sortKey = key;
    if (dir === "asc" || dir === "desc") out.sortDir = dir;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// reflectFleetState writes the fleet view-state back to the URL via replaceState (no
// history entry), preserving any other query params on "/" and clearing the fleet keys
// when empty so a reset view yields a clean URL.
export function reflectFleetState(st: DataTableState): void {
  const q = new URLSearchParams(location.search);
  q.delete("fq"); q.delete("ff"); q.delete("fsort");
  if (st.query) q.set("fq", st.query);
  if (st.facets.length) q.set("ff", st.facets.join(","));
  if (st.sortKey && st.sortDir) q.set("fsort", `${st.sortKey}:${st.sortDir}`);
  const qs = q.toString();
  try {
    history.replaceState({}, "", qs ? `/?${qs}` : "/");
  } catch {
    // Best-effort: a blocked history API just means the URL is not reflected.
  }
}

// dataSnapshot serialises the settled snapshot for the poll's no-change check. Errors are
// reduced to their message so two settles of the same failure compare equal (an Error
// would otherwise stringify to {} and make every failed read look identical to any other).
export function dataSnapshot(data: OverviewData): string {
  return JSON.stringify(data, (_key, value) => (value instanceof Error ? `error:${value.message}` : value));
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
