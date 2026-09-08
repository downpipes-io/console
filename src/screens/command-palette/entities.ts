// The async entity source: a set of capability-gated result PROVIDERS feeding the ONE
// palette index. No-custody: NAMES / LABELS / IDS only.
// ---------------------------------------------------------------------------
//
// Assessment finding C1 (no global search across runs / audit / destinations /
// credentials) is closed here by extending the SAME entity index the palette already
// owned (downpipes by name + run id) with four more entity providers, each reusing the
// existing fuzzyScore matcher, the BuiltItem/buildOptionRow row anatomy and navigate(),
// so there is no parallel search UI:
//   - Downpipes  -> /downpipes/:id            (name match; pre-existing)
//   - Runs       -> /runs/:downpipeId/:index  (run id match, the real run drawer route)
//   - Destinations -> /destinations           (label / id match; no per-destination
//                                               deep-link exists, so it opens the screen)
//   - Credentials -> /credentials/:id          (label match; the detail drawer deep-link
//                                               the credential registry already supports)
//   - Audit      -> /access/audit?downpipe= or /access/audit (a numeric entry seq, or a
//                                               downpipe-scoped filter; no per-entry
//                                               deep-link exists, so it opens the filtered
//                                               screen, see ENTITY_AUDIT note below)
//
// Each provider is GATED by the SAME capability the owning screen reads (the client mirror
// of the engine's per-route gate; the engine is the enforcement point). A caller who may
// not see an entity gets no rows for it AND its list is never fetched. callerCan() resolves
// a built-in OR a custom role, so a custom role that omits a read capability genuinely hides
// that provider (proven by validate-palette-search).
//
// This is the PURE, DOM-free heart of the global search: it executes no DOM call at import
// or in resolveEntityGroups, so the search validator imports and runs it in Node without a
// DOM. The DOM-side fetch + render that consumes it lives in ./overlay.ts. Moved verbatim
// from the palette coordinator for size; behaviour is unchanged. House rules: Australian
// English, no em dashes, precise claims.

import { callerCan, type Capability } from "../../lib/identity.ts";
import {
  ICON_DOWNPIPES,
  ICON_RUNS,
  ICON_AUDIT,
  ICON_DESTINATIONS,
  ICON_HOURGLASS,
} from "../../lib/icons.ts";
import { fuzzyScore } from "./shared.ts";
import type {
  Caller,
  DownpipeState,
  DestinationStatus,
  ExpiryStatus,
} from "../../api.ts";

// The entity provider keys, in the order their groups appear under the static commands.
export type EntityKey = "downpipes" | "runs" | "destinations" | "credentials" | "audit";

// ENTITY_GROUP_LABEL is the calm, scannable group heading each provider's rows sit under
// (design-system calm-density budget: one labelled group per entity type, never a flat
// blur of mixed results).
export const ENTITY_GROUP_LABEL: Record<EntityKey, string> = {
  downpipes: "Downpipes",
  runs: "Runs",
  destinations: "Destinations",
  credentials: "Credentials",
  audit: "Audit",
};

// ENTITY_CAPABILITY is the read capability each provider is gated by, the SAME gate the
// owning screen / engine route enforces (identity.ts):
//   - downpipe.read gates the downpipes, runs and destinations reads (all in the universal
//     read floor; the runs and destinations screens read with it, destinations' rail surface
//     is the downpipes screen).
//   - audit.read gates the audit log read (its own read-floor capability; the audit screen
//     and GET /admin/audit gate on it).
//   - credentials (the expiry tracker) read is available to any authenticated reader; the
//     read floor's downpipe.read is the faithful "is a resolved reader" gate (there is no
//     credentials-specific READ capability in the byte-for-byte-mirrored capability union;
//     inventing one would drift from the engine). expiry.config is the WRITE gate and is
//     deliberately NOT used here, so a Viewer who can read credentials still gets results.
// A null caller (whoami pending) fails closed for every provider.
export const ENTITY_CAPABILITY: Record<EntityKey, Capability> = {
  downpipes: "downpipe.read",
  runs: "downpipe.read",
  destinations: "downpipe.read",
  credentials: "downpipe.read",
  audit: "audit.read",
};

// entityProviderEnabled is the single gate predicate both the FETCH and the RESOLVE consult,
// so a provider's data is never fetched for a caller who could not see its rows, and the two
// can never drift. It mirrors the engine's gate via callerCan (built-in OR custom role); a
// null caller fails closed.
export function entityProviderEnabled(caller: Caller | null, key: EntityKey): boolean {
  if (!caller) return false;
  return callerCan(caller.role, ENTITY_CAPABILITY[key], caller.customRole);
}

// A run-id-shaped query is a hex/dash/alnum token; an audit entry is identified ONLY by a
// small monotonic sequence number (AuditEvent.seq), so a bare integer is the audit-entry
// signal. isSeqQuery keeps the audit provider cheap and calm: it resolves only when the
// query is a plausible seq, never on free text.
export function isSeqQuery(query: string): boolean {
  return /^\d{1,12}$/.test(query.trim());
}

// EntityData is the redaction-safe slice each enabled provider needs (names / labels / ids
// / counts only; never a secret, value or key). Any field may be null when that provider was
// gated off or its fetch failed, the resolver simply skips it (honest partial results).
export interface EntityData {
  downpipes: DownpipeState[] | null;
  runs: Array<{ runId: string; index: number; downpipeId: string }> | null;
  destinations: DestinationStatus[] | null;
  credentials: ExpiryStatus[] | null;
  // The audit head sequence (GET /admin/audit headSeq): the only thing needed to confirm a
  // typed entry number EXISTS, without listing entries. null when gated off / unfetched.
  auditHeadSeq: number | null;
}

interface EntityMatch {
  id: string;
  title: string;
  matches: number[];
  meta: string;
  icon: string;
  route: string;
}

export interface EntityGroup {
  key: EntityKey;
  label: string;
  matches: EntityMatch[];
}

// downpipeNameById is a small lookup so a run row can show its owning downpipe's name.
function downpipeNameById(downpipes: DownpipeState[] | null, id: string): string | undefined {
  return downpipes?.find((d) => d.config.id === id)?.config.name;
}

// resolveEntityGroups is the PURE, DOM-free heart of the global search: given the (gated)
// entity data, the caller and the query, it returns the grouped, fuzzy-ranked, CAPABILITY-
// GATED entity matches in canonical group order. It is exported so validate-palette-search
// can prove each provider resolves a matching entity to the correct route AND is hidden when
// the caller lacks the capability, without a DOM. Each provider re-checks entityProviderEnabled,
// so a gated-off provider returns nothing even if stale data were passed in.
export function resolveEntityGroups(data: EntityData, caller: Caller | null, query: string): EntityGroup[] {
  const q = query.trim();
  if (q === "") return [];
  const groups: EntityGroup[] = [];
  for (const provider of ENTITY_PROVIDERS) {
    if (!entityProviderEnabled(caller, provider.key)) continue;
    const matches = provider.resolve(data, q);
    if (matches.length) groups.push({ key: provider.key, label: ENTITY_GROUP_LABEL[provider.key], matches });
  }
  return groups;
}

// EntityProvider is one capability-gated search provider: its EntityKey (which carries the gate, the
// group label and the canonical group order) and a pure resolve() that returns its already-capped,
// fuzzy-ranked matches for the query. resolveEntityGroups iterates this registry; each resolve() is
// only called once its provider's gate has passed.
interface EntityProvider {
  key: EntityKey;
  resolve: (data: EntityData, q: string) => EntityMatch[];
}

// The providers in canonical group order (downpipes, runs, destinations, credentials, audit).
const ENTITY_PROVIDERS: EntityProvider[] = [
  { key: "downpipes", resolve: resolveDownpipes },
  { key: "runs", resolve: resolveRuns },
  { key: "destinations", resolve: resolveDestinations },
  { key: "credentials", resolve: resolveCredentials },
  { key: "audit", resolve: resolveAudit },
];

// --- Downpipes (by name) -> /downpipes/:id (pre-existing behaviour) ---
function resolveDownpipes(data: EntityData, q: string): EntityMatch[] {
  if (!data.downpipes) return [];
  const m: EntityMatch[] = [];
  for (const dp of data.downpipes) {
    const hit = fuzzyScore(dp.config.name, q);
    if (!hit) continue;
    m.push({
      id: `dp-${dp.config.id}`,
      title: dp.config.name,
      matches: hit.indices,
      meta: dp.config.source.type.toUpperCase(),
      icon: ICON_DOWNPIPES,
      route: `/downpipes/${encodeURIComponent(dp.config.id)}`,
    });
  }
  return m.slice(0, 6);
}

// --- Runs (by run id) -> /runs/:downpipeId/:index (the real run drawer route) ---
function resolveRuns(data: EntityData, q: string): EntityMatch[] {
  if (!data.runs) return [];
  const m: EntityMatch[] = [];
  for (const r of data.runs) {
    const hit = fuzzyScore(r.runId, q);
    if (!hit) continue;
    const dpName = downpipeNameById(data.downpipes, r.downpipeId);
    m.push({
      id: `run-${r.downpipeId}-${r.index}`,
      title: r.runId,
      matches: hit.indices,
      meta: dpName ? `run of ${dpName}` : "run",
      icon: ICON_RUNS,
      // The run drawer is /runs/:downpipeId/:index (runs.ts onRowActivate); deep-link
      // straight to it so the operator lands on the run, not just the activity list.
      route: `/runs/${encodeURIComponent(r.downpipeId)}/${r.index}`,
    });
  }
  return m.slice(0, 6);
}

// --- Destinations (by label / id) -> /destinations ---
// No per-destination deep-link exists today (the screen lists all destinations as cards),
// so a destination match opens the Destinations screen, the best honest target.
function resolveDestinations(data: EntityData, q: string): EntityMatch[] {
  if (!data.destinations) return [];
  const m: EntityMatch[] = [];
  for (const d of data.destinations) {
    const label = d.label ?? d.bucket ?? d.id ?? "";
    if (!label) continue;
    const labelHit = fuzzyScore(label, q);
    const hit = labelHit ?? (d.id ? fuzzyScore(d.id, q) : null);
    if (!hit) continue;
    m.push({
      id: `dest-${d.id ?? label}`,
      title: label,
      // Only highlight when the TITLE itself matched (an id-only match has no title ranges).
      matches: labelHit ? labelHit.indices : [],
      meta: d.isDefault ? "default destination" : "destination",
      icon: ICON_DESTINATIONS,
      route: "/destinations",
    });
  }
  return m.slice(0, 6);
}

// --- Credentials (by label) -> /credentials/:id (the detail-drawer deep-link) ---
function resolveCredentials(data: EntityData, q: string): EntityMatch[] {
  if (!data.credentials) return [];
  const m: EntityMatch[] = [];
  for (const c of data.credentials) {
    const hit = fuzzyScore(c.label, q);
    if (!hit) continue;
    m.push({
      id: `cred-${c.id}`,
      title: c.label,
      matches: hit.indices,
      meta: c.kind,
      icon: ICON_HOURGLASS,
      // The credential registry already supports /credentials/:id opening the detail
      // drawer (credentials.ts route "/credentials/:id" -> openItemDrawer); deep-link to it.
      route: `/credentials/${encodeURIComponent(c.id)}`,
    });
  }
  return m.slice(0, 6);
}

// --- Audit (by entry seq) -> /access/audit ---
// Audit entries are identified ONLY by a monotonic seq and have NO per-entry deep-link
// (the audit screen supports filter params, not an ?entry= anchor), so a numeric query
// that names an EXISTING entry (seq <= headSeq) opens the audit screen, the honest best.
// We confirm existence from headSeq alone (no entry listing, no extra page fetch).
function resolveAudit(data: EntityData, q: string): EntityMatch[] {
  if (data.auditHeadSeq === null || !isSeqQuery(q)) return [];
  const seq = Number(q);
  if (!Number.isInteger(seq) || seq < 1 || seq > data.auditHeadSeq) return [];
  const title = `Audit entry #${seq}`;
  return [{
    id: `audit-${seq}`,
    title,
    // The seq digits sit after the "#": highlight them so the typed number is visible.
    matches: matchTrailingDigits(title),
    meta: "opens the audit log",
    icon: ICON_AUDIT,
    // No per-entry route exists; open the audit log screen.
    route: "/access/audit",
  }];
}

// matchTrailingDigits returns the indices of the run of digits at the END of a title (the
// "#<seq>" tail), so the audit row highlights the entry number the operator typed.
function matchTrailingDigits(title: string): number[] {
  const out: number[] = [];
  for (let i = title.length - 1; i >= 0; i--) {
    const ch = title[i]!;
    if (ch >= "0" && ch <= "9") out.unshift(i);
    else break;
  }
  return out;
}
