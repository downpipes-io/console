// The async entity source: the DOM-side fetch + render that consumes the DOM-free entity
// engine (./entities.ts). No-custody: NAMES / LABELS / IDS only.
//
// appendEntityMatches fetches (capability-gated, cached, in parallel) the redaction-safe
// lists the ENABLED providers need, resolves the grouped matches via resolveEntityGroups,
// and merges them into the listbox under their own group headers, without ever blocking
// the static command rows. It matches the palette's pre-existing async pattern: a spinner
// row while the first settled query loads, a token guard that drops a superseded query, a
// per-entity session cache so only the first query hits the network, and fail-OPEN error
// handling (a failed entity fetch degrades to a note; a 401 closes the palette). It reads
// only names / labels / ids / counts and renders every string via highlight() -> h()
// (textContent), so no secret is shown and no markup can be injected. Moved verbatim from
// the overlay for size; behaviour is unchanged. House rules: Australian English, no em
// dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import {
  getDownpipesCache,
  setDownpipesCache,
  getDestinationsForSearch,
  setDestinationsForSearch,
  getCredentialsForSearch,
  setCredentialsForSearch,
  getRunsForSearch,
  setRunsForSearch,
} from "../../lib/store.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import type {
  Caller,
  DownpipeState,
  EngineClient,
  DestinationStatus,
  ExpiryStatus,
} from "../../api.ts";
import {
  entityProviderEnabled,
  isSeqQuery,
  resolveEntityGroups,
  type EntityData,
} from "./entities.ts";
import { buildOptionRow, type PaletteRow, type BuiltItem } from "./rows.ts";

// Which providers a caller may see for a given query (gates the fetch AND the resolve via
// the one predicate). Audit is additionally gated on the query naming a sequence number.
interface ProviderWants {
  downpipes: boolean;
  runs: boolean;
  destinations: boolean;
  credentials: boolean;
  audit: boolean;
}

function providerWants(caller: Caller | null, query: string): ProviderWants {
  return {
    downpipes: entityProviderEnabled(caller, "downpipes"),
    runs: entityProviderEnabled(caller, "runs"),
    destinations: entityProviderEnabled(caller, "destinations"),
    credentials: entityProviderEnabled(caller, "credentials"),
    audit: entityProviderEnabled(caller, "audit") && isSeqQuery(query),
  };
}

// loadEntityData resolves each enabled list from cache or a one-time fetch, IN PARALLEL.
// Each loader fails OPEN: a rejection yields null (that provider is skipped) so one
// slow/denied list never takes down the others or the static commands. A 401 anywhere is
// surfaced via the returned sawUnauthorised flag so the caller can close the palette and
// route to signed-out.
async function loadEntityData(
  engine: EngineClient,
  wants: ProviderWants,
): Promise<{ data: EntityData; sawUnauthorised: boolean }> {
  // onErr is the shared fail-open handler for all five loaders below: it records (by closing over
  // sawUnauthorised) whether any provider hit a 401 and returns null so that provider is skipped.
  // Defined once so the catch blocks stay one line each and the 401 bookkeeping is in one place.
  let sawUnauthorised = false;
  const onErr = (err: unknown): null => {
    if (isUnauthorised(err)) sawUnauthorised = true;
    return null;
  };

  const loadDownpipes = async (): Promise<DownpipeState[] | null> => {
    if (!wants.downpipes) return null;
    const cached = getDownpipesCache();
    if (cached) return cached;
    try {
      const list = await engine.listDownpipes();
      setDownpipesCache(list);
      return list;
    } catch (err) {
      return onErr(err);
    }
  };

  const loadRuns = async (): Promise<EntityData["runs"]> => {
    if (!wants.runs) return null;
    const cached = getRunsForSearch();
    if (cached) return cached;
    try {
      const { byDownpipe } = await engine.listAllHistory();
      // Flatten to the redaction-safe (runId, index, downpipeId) triples the run provider
      // needs, never the counts, sizes, error reasons or destination ids.
      const flat: NonNullable<EntityData["runs"]> = [];
      for (const [downpipeId, entries] of Object.entries(byDownpipe)) {
        for (const e of entries) flat.push({ runId: e.runId, index: e.index, downpipeId });
      }
      setRunsForSearch(flat);
      return flat;
    } catch (err) {
      return onErr(err);
    }
  };

  const loadDestinations = async (): Promise<DestinationStatus[] | null> => {
    if (!wants.destinations) return null;
    const cached = getDestinationsForSearch();
    if (cached) return cached;
    try {
      const { destinations } = await engine.listDestinations();
      setDestinationsForSearch(destinations);
      return destinations;
    } catch (err) {
      return onErr(err);
    }
  };

  const loadCredentials = async (): Promise<ExpiryStatus[] | null> => {
    if (!wants.credentials) return null;
    const cached = getCredentialsForSearch();
    if (cached) return cached;
    try {
      const list = await engine.listExpiry();
      setCredentialsForSearch(list);
      return list;
    } catch (err) {
      return onErr(err);
    }
  };

  const loadAuditHead = async (): Promise<number | null> => {
    if (!wants.audit) return null;
    try {
      // Confirm a typed entry number exists from the chain head alone (limit:1, no listing).
      const page = await engine.listAudit({ limit: 1 });
      return page.headSeq;
    } catch (err) {
      return onErr(err);
    }
  };

  const [downpipes, runs, destinations, credentials, auditHeadSeq] = await Promise.all([
    loadDownpipes(),
    loadRuns(),
    loadDestinations(),
    loadCredentials(),
    loadAuditHead(),
  ]);

  return { data: { downpipes, runs, destinations, credentials, auditHeadSeq }, sawUnauthorised };
}

// renderEntityGroups appends each entity group header + its option rows, extending the flat
// row model so keyboard movement reaches them. It builds through the SAME row builder as the
// static commands so the row anatomy never drifts; the title is set via highlight() -> h()
// (textContent), so a name / label / id can never inject markup (no-custody / no injection).
// Entity ids are prefixed (dp-/run-/dest-/cred-/audit-) so they cannot collide with a
// command option id.
function renderEntityGroups(
  entityGroups: ReturnType<typeof resolveEntityGroups>,
  listbox: HTMLElement,
  rows: PaletteRow[],
  setActiveAt: (i: number) => void,
  close: () => void,
): void {
  for (const group of entityGroups) {
    listbox.appendChild(h("li", { class: "cmdp__group", role: "presentation" }, group.label));
    for (const mtch of group.matches) {
      const run = () => {
        close();
        navigate(mtch.route);
      };
      const item: BuiltItem = {
        id: `entity-${mtch.id}`,
        title: mtch.title,
        matches: mtch.matches,
        icon: mtch.icon,
        meta: mtch.meta,
        kind: "navigate",
        run,
      };
      const idx = rows.length; // its flat index once pushed (entities follow the statics)
      const li = buildOptionRow(item, () => setActiveAt(idx));
      listbox.appendChild(li);
      rows.push({ el: li, run });
    }
  }
}

export async function appendEntityMatches(args: {
  engine: EngineClient;
  caller: Caller | null;
  query: string;
  token: number;
  currentToken: () => number;
  listbox: HTMLElement;
  getRows: () => PaletteRow[];
  setRows: (r: PaletteRow[]) => void;
  setActiveAt: (i: number) => void;
  rebindActive: () => void;
  announce: (n: number) => void;
  close: () => void;
}): Promise<void> {
  const { engine, caller, query, token, currentToken, listbox, getRows, setRows, setActiveAt, rebindActive, announce, close } = args;

  const wants = providerWants(caller, query);

  // Nothing to resolve for this caller/query: bail before any fetch (a Viewer-less / null
  // caller, or an audit-only query the caller cannot see).
  if (!wants.downpipes && !wants.runs && !wants.destinations && !wants.credentials && !wants.audit) return;

  // Show a single non-interactive spinner row while the first settled query loads any
  // missing list. Removed before painting; never interactive.
  let spinnerRow: HTMLElement | null = null;
  const needsFetch =
    (wants.downpipes && !getDownpipesCache()) ||
    (wants.runs && !getRunsForSearch()) ||
    (wants.destinations && !getDestinationsForSearch()) ||
    (wants.credentials && !getCredentialsForSearch()) ||
    wants.audit; // audit head is intentionally not cached (an append-only log moves)
  if (needsFetch) {
    spinnerRow = h(
      "li",
      { class: "cmdp__spinner", role: "presentation" },
      h("span", { class: "spinner spinner--sm", "aria-hidden": "true" }),
      h("span", { class: "field__hint" }, "Searching"),
    );
    listbox.appendChild(spinnerRow);
  }

  const { data, sawUnauthorised } = await loadEntityData(engine, wants);

  // A newer query superseded this one while we awaited: drop silently.
  if (token !== currentToken()) {
    spinnerRow?.remove();
    return;
  }
  spinnerRow?.remove();

  // A 401 on any list: the session is gone. Close and let the next guarded navigation route
  // to signed-out (matching the pre-existing single-source behaviour).
  if (sawUnauthorised) {
    close();
    return;
  }

  const entityGroups = resolveEntityGroups(data, caller, query);
  if (entityGroups.length === 0) return;

  // The static pass painted a "No matches" empty row when no command matched. Now that an entity DID
  // match, that row would contradict the entity rows beneath it ("no matches" above actual matches),
  // so remove it before appending the first entity group.
  listbox.querySelector(".cmdp__empty")?.remove();

  const rows = getRows();
  renderEntityGroups(entityGroups, listbox, rows, setActiveAt, close);
  setRows(rows);
  rebindActive();
  // Re-announce the new total (static + entity rows).
  announce(rows.length);
}
