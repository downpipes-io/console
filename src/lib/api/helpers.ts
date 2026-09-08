// Engine-origin guards, the engine/console DownpipeState boundary mapping, and the client-side
// plan-hash mirror, split out of api.ts. Re-exported verbatim from ./api.ts so callers are unchanged.

import { sha384Hex } from "../../bytes.ts";
import { recordContractDrift } from "../client-diag/ring.ts";
import { cadenceSecondsToRunsPerMonth } from "../cost-model-rates.ts";
import type { DownpipeState, EngineDownpipeState } from "./types.ts";

// epochMsToIso converts an engine epoch-ms stamp to the ISO string the console's recency helpers
// (shortDate/dateOnly via toMs, and the Date.parse overdue maths) consume. A non-finite value yields
// undefined so the field stays HONESTLY ABSENT (the generator reads that as "never"), never a
// fabricated or Invalid-Date stamp. Kept tiny and pure; it carries no value and no key.
function epochMsToIso(atMs: number | undefined): string | undefined {
  if (atMs === undefined || !Number.isFinite(atMs)) return undefined;
  return new Date(atMs).toISOString();
}

// mapEngineDownpipeState maps one engine wire DownpipeState onto the console's DownpipeState: it
// flattens the nested restoreProven { at: epoch-ms, by } to lastRestoreProvenAt (ISO) +
// lastRestoreProvenBy, flattens the nested integrityVerified { at: epoch-ms, how } to
// lastIntegrityVerifiedAt (ISO) + a derived lastIntegrityVerifiedOk, and converts the epoch-ms
// lastRestoreTestAt to an ISO string, so every consumer reads the one normalised contract. THIS is the
// mapping whose absence was the contract blocker: without it the engine's restoreProven was silently
// dropped and "offline restorability last proven" always rendered "never" in production though both
// suites were green; the integrity stamp is mapped the same way so "integrity-checked" can render TRUE
// once the engine emits it (it now does, on a clean run or a passed attestation). The bare-token prover
// (by:null) maps to an absent lastRestoreProvenBy (the statement omits the dangling "by ...").
// The engine sets integrityVerified ONLY on a PASS, so a PRESENT stamp maps to lastIntegrityVerifiedOk:
// true (its presence is the affirmative proof; there is no "failed integrity stamp" on the wire because a
// failed run never stamps). exactOptionalPropertyTypes: every derived field is spread in ONLY when it
// carries a real value, so an absent engine field stays absent (never present-as-undefined). No value or
// key transits.
// Exported so the protection-statement validator can assert the mapping end-to-end (engine wire
// shape -> mapEngineDownpipeState -> protectionStatement), the test that fails if the mapping is dropped.
export function mapEngineDownpipeState(d: EngineDownpipeState): DownpipeState {
  // The deferral kind is a CLOSED engine enum, and the spread below narrows it
  // by set membership, so a value this console does not know is silently dropped and the row renders as
  // though the test were never deferred. That is precisely "an unknown enum member coerced into plausible
  // data", and it is invisible today. The CLASS is recorded, never the value: the value is the engine text
  // the class stands in for. An ABSENT deferral is the normal case and is not drift.
  // The wire value is UNTRUSTED (the declared type is what the contract promises, not what arrived), so it
  // is read as unknown and tested by set membership, exactly as the spread below does.
  const deferred: unknown = d.lastRestoreTestDeferred;
  if (typeof deferred === "string" && deferred !== "no-run" && deferred !== "posture") recordContractDrift("unknown-enum");
  const provenAt = d.restoreProven ? epochMsToIso(d.restoreProven.at) : undefined;
  const provenBy = d.restoreProven?.by;
  const provenMethod = d.restoreProven?.method;
  const testAt = epochMsToIso(d.lastRestoreTestAt);
  // Per the PASS-only semantics in the function block above: a present stamp maps to a flat ISO
  // date plus ok:true; an absent stamp leaves both fields absent.
  const integrityAt = d.integrityVerified ? epochMsToIso(d.integrityVerified.at) : undefined;
  return {
    config: d.config,
    nextRunAt: d.nextRunAt,
    lastRunId: d.lastRunId,
    inFlight: d.inFlight,
    ...(testAt !== undefined ? { lastRestoreTestAt: testAt } : {}),
    ...(d.lastRestoreTestOk !== undefined ? { lastRestoreTestOk: d.lastRestoreTestOk } : {}),
    // The failure cause / streak / deferral kind ride through as-is (closed code, an int, a closed
    // two-value kind; the deferral kind is narrowed to its vocabulary so a bad wire value drops out).
    ...(typeof d.lastRestoreTestReason === "string" && d.lastRestoreTestReason !== "" ? { lastRestoreTestReason: d.lastRestoreTestReason } : {}),
    ...(typeof d.restoreTestConsecutiveFailures === "number" && Number.isFinite(d.restoreTestConsecutiveFailures) && d.restoreTestConsecutiveFailures > 0 ? { restoreTestConsecutiveFailures: d.restoreTestConsecutiveFailures } : {}),
    ...(d.lastRestoreTestDeferred === "no-run" || d.lastRestoreTestDeferred === "posture" ? { lastRestoreTestDeferred: d.lastRestoreTestDeferred } : {}),
    // The method-faithful compliance fields: the last-test KIND ("scheduled" | "attended") and, for an
    // attended pass, its per-run sample RATE. Narrowed to their vocabulary / a finite number so a bad wire
    // value drops out (the recency read then treats an absent kind as the scheduled path). Threading these
    // is the correctness fix that lets a sub-100 attended sample read amber, never a false fully-green.
    ...(d.lastRestoreTestKind === "scheduled" || d.lastRestoreTestKind === "attended" ? { lastRestoreTestKind: d.lastRestoreTestKind } : {}),
    ...(typeof d.lastRestoreTestSampleRate === "number" && Number.isFinite(d.lastRestoreTestSampleRate) ? { lastRestoreTestSampleRate: d.lastRestoreTestSampleRate } : {}),
    ...(provenAt !== undefined ? { lastRestoreProvenAt: provenAt } : {}),
    ...(provenBy !== undefined && provenBy !== null ? { lastRestoreProvenBy: provenBy } : {}),
    // restoreProven.method used to be dropped here; keep it (narrowed to the known union) so the proven /
    // coverage surfaces name the method faithfully. An unknown wire value drops out rather than rendering raw.
    ...(provenMethod === "blind-test" || provenMethod === "keyless-attest" || provenMethod === "attended-blind-test" ? { restoreProvenMethod: provenMethod } : {}),
    ...(integrityAt !== undefined ? { lastIntegrityVerifiedAt: integrityAt, lastIntegrityVerifiedOk: true } : {}),
    ...(d.cfConfigDiscovery !== undefined ? { cfConfigDiscovery: d.cfConfigDiscovery } : {}),
    // THE REPLICATION ANCHOR. Counts on both sides, so there is nothing to convert, only to SANITISE: the
    // wire value is untrusted, and a NaN / negative / non-integer anchor would make "how many backups have
    // succeeded since this destination was configured" answerable with nonsense. A bad value is DROPPED, which
    // reads downstream as "unanchored": the console then stays silent about that destination's age rather than
    // guessing at it, which is the same rule the bot follows. Absent on a downpipe with no fan-out and on a
    // record written before the anchor shipped.
    ...(nonNegInt(d.sealedRuns) !== undefined ? { sealedRuns: nonNegInt(d.sealedRuns) as number } : {}),
    ...(sanitiseAnchors(d.replAnchors) !== undefined ? { replAnchors: sanitiseAnchors(d.replAnchors) as Record<string, number> } : {}),
    // configRev, the base a save or a delete states back. Sanitised, never converted (a count on both
    // sides), and DROPPED when the wire value is not a real non-negative integer: a screen that holds no
    // revision states nothing, which leaves that write as unprotected as it was, while a screen holding a
    // forged revision would refuse a save with no collision in it and the operator could do nothing about
    // it. Absent on an engine older than the precondition, and on a record written before it shipped.
    ...(nonNegInt(d.configRev) !== undefined ? { configRev: nonNegInt(d.configRev) as number } : {}),
  };
}

// nonNegInt narrows an untrusted wire number to a non-negative integer count, or undefined. The anchor maths is
// a subtraction of two counts: a non-finite or negative one would produce a nonsense age, so it is dropped and
// the age is left unestablished (never forged).
function nonNegInt(v: number | undefined): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
  return Math.floor(v);
}

// sanitiseAnchors narrows the untrusted anchor map to the entries that are real non-negative integer counts.
// An entry that fails is DROPPED, so that destination reads as unanchored (age unknown, so the console makes no
// claim about it) rather than anchoring at a forged 0, which would assert a fault on the day it was configured.
// An empty result is undefined, so the field stays HONESTLY ABSENT (exactOptionalPropertyTypes).
function sanitiseAnchors(raw: Record<string, number> | undefined): Record<string, number> | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const out: Record<string, number> = {};
  let n = 0;
  for (const [id, v] of Object.entries(raw)) {
    const c = nonNegInt(v);
    if (typeof id !== "string" || id === "" || c === undefined) continue;
    out[id] = c;
    n++;
  }
  return n > 0 ? out : undefined;
}

// isLocalhostHost reports whether a URL host is a loopback/dev host, where http is acceptable
// (there is no network path to downgrade). 127.0.0.1, ::1 (which URL.hostname renders as
// "[::1]"), localhost, and any *.localhost subdomain.
function isLocalhostHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

// engineOriginError returns a human reason string if the given engine URL is not an acceptable
// origin (unparseable, or a non-https scheme that is not a localhost dev engine), or null if it is
// fine. Exported so the settings form can surface the same rule inline before the client is built;
// the EngineClient constructor enforces it unconditionally as the actual control.
export function engineOriginError(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Enter a valid URL.";
  }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && isLocalhostHost(u.hostname)) return null;
  return "The engine connection must use https (http is allowed only for a localhost dev engine).";
}

// assertEngineOrigin throws unless the URL is an acceptable engine origin (https, or http on
// localhost for dev). This is the no-custody transport guard at the single chokepoint every caller
// passes through (connect / restoreConnection both build the client here).
export function assertEngineOrigin(url: string): string {
  const err = engineOriginError(url);
  if (err !== null) throw new Error(err);
  return url;
}

// projectKVCost is the bill-shock guard the schedule picker shows: a high-frequency full
// re-read of a large KV namespace is the dominant cost. This is a rough projection from
// record count and cadence, in KV read units per month, to steer operators off hourly KV.
// Guard: a zero or invalid cadence means no runs are scheduled, so the projected read count
// is 0, not Infinity (which division-by-zero would otherwise produce).
//
// IT USES THE COST LIBRARY'S AVERAGE MONTH, NOT ITS OWN. This function used to divide by a
// local 30-day constant while every other runs-per-month figure in the console came from
// cadenceSecondsToRunsPerMonth (DAYS_PER_MONTH = 30.44, the 365.25/12 averaging constant the
// spec pins). The two were never compared on one screen, so the disagreement was invisible:
// the downpipe editor projected an hourly namespace at 720 runs a month while the costs screen
// priced the same schedule at 730.6. A projection that steers an operator off a cadence has to
// agree with the screen that prices it, and the shared constant errs slightly HIGH, which is
// the direction the cost engine's over-estimate stance already takes.
export function projectMonthlyKVReads(recordCount: number, cadenceSeconds: number): number {
  if (cadenceSeconds <= 0) return 0;
  return Math.round(recordCount * cadenceSecondsToRunsPerMonth(cadenceSeconds));
}

// ---- Dual-control: the client-side plan-hash mirror ----------------------
// RestorePlanHashRequest is the full restore-request shape restorePlanHash() reads to re-derive the
// dual-control binding key. It is the request, not the binding: it carries every selector field plus
// the secret-bearing token, whereas the hash is computed over the decision-relevant subset only.
//   - runId       - the run the restore reads from.
//   - target      - the KV/R2 destination selector (binding / namespaceId / bucketName), or absent.
//   - include/exclude - the record selectors.
//   - maxRecords  - optional cap on records applied.
//   - recordName  - present for a GRANULAR single-record apply; binds its own distinct approval.
//   - cfConfig    - the Cloudflare-config apply target (account, optional zone, and the RESOLVED surface
//                    allow-list the engine reports on the plan). The surface set is bound because F10 made
//                    it part of what an approval authorises: widening it must invalidate an approval that
//                    was granted for a narrower one. `surfaces` is taken from RestorePlan.cfConfigSurfaces
//                    rather than re-derived, because the DEFAULT is the engine's proven set and a second
//                    copy of that rule in the console would drift the moment a surface is proven.
//   - mediaRestore - the media re-upload target. Its `token` is a SECRET and is EXCLUDED from the
//                    hash (a secret must never enter the preimage); only accountId is bound.
export interface RestorePlanHashRequest {
  runId: string;
  target?: { binding?: string; namespaceId?: string; bucketName?: string };
  include?: string[];
  exclude?: string[];
  maxRecords?: number;
  recordName?: string;
  cfConfig?: { accountId: string; zoneId?: string; surfaces?: string[] };
  // mediaRestore.token is a media re-upload edit token (a secret). It is never included in the
  // hash preimage and must never enter any digest or log; only accountId is bound.
  mediaRestore?: { token?: string; accountId: string };
  // d1Tables is the D1 table-subset scope (database + tables + optional createOnly). It is bound into the
  // hash (mirrors the engine): the tables are lower-cased, deduped and sorted, and createOnly is bound when
  // true, so a table-subset (or createOnly) apply carries its own approval, distinct from a whole-DB restore.
  d1Tables?: { database: string; tables: string[]; createOnly?: boolean };
}

// restorePlanHash re-derives the dual-control binding key the engine keys an approval on, so the
// restore screen can show the operator the EXACT hash an approval binds to and re-arm (re-hide
// Apply, clear the confirm) the instant a changed request yields a new hash (the re-arm-on-change
// invariant). It MUST match the engine byte-for-byte
// (engine/src/admin/approvals.ts restorePlanHash):
//   - the binding is the request's DECISION-RELEVANT fields ALONE -> { runId, target, include,
//     exclude, maxRecords? } (NOT isLatest/plannedWrites/bytes; those are plan OUTPUTS the engine
//     does not hash, which is why this can be computed from the request without a dry-run);
//   - exactOptionalPropertyTypes parity: each optional key is included only when it carries a value,
//     so an absent field and an explicit-undefined field hash identically (matching the engine's
//     spread-when-present construction);
//   - the hash is "sha384:" + hex(SHA-384(canonicalJSON(binding))), where canonicalJSON is the
//     engine's sorted-key, compact, integer-only form (engine/src/format/canonjson.ts).
// It carries NO plaintext and NO key (names, counts and selectors only), so computing it in the
// browser leaks nothing and never weakens no-custody. The engine remains the authority: the apply
// route recomputes the hash server-side and gates on a matching approval; this mirror is UX only.
export async function restorePlanHash(req: RestorePlanHashRequest): Promise<string> {
  const binding: PlanBinding = {
    runId: req.runId,
    target: req.target
      ? {
          ...(req.target.binding !== undefined ? { binding: req.target.binding } : {}),
          ...(req.target.namespaceId !== undefined ? { namespaceId: req.target.namespaceId } : {}),
          ...(req.target.bucketName !== undefined ? { bucketName: req.target.bucketName } : {}),
        }
      : null,
    include: req.include ?? [],
    exclude: req.exclude ?? [],
    ...(req.maxRecords !== undefined ? { maxRecords: req.maxRecords } : {}),
    // recordName MUST be bound here to match the engine byte-for-byte (engine/src/admin/approvals.ts
    // restorePlanHash includes it): a GRANULAR single-record apply carries its OWN distinct approval, so
    // a single-record plan must hash differently from the whole-run plan, and changing WHICH record
    // re-arms the gate. Included only when set, so a whole-run plan hashes exactly as it did before
    // recordName existed (stable back-compat with the spread-when-present construction the engine uses).
    ...(req.recordName !== undefined ? { recordName: req.recordName } : {}),
    // cfConfig binds the Cloudflare-config APPLY target (account + optional zone) to match the engine, so a
    // cf-config apply carries its OWN approval. The TOKEN is never included (a secret must not enter the
    // hash), matching engine/src/admin/approvals.ts restorePlanHash.
    // surfaces is bound when the caller knows it (the plan reports it). Omitted when it does not: an engine
    // old enough not to report the list is also old enough not to bind it, so omitting matches rather than
    // guesses. Sent verbatim, already resolved and sorted by the engine, so no ordering rule lives here.
    ...(req.cfConfig
      ? {
          cfConfig: {
            accountId: req.cfConfig.accountId,
            ...(req.cfConfig.zoneId !== undefined ? { zoneId: req.cfConfig.zoneId } : {}),
            ...(req.cfConfig.surfaces !== undefined ? { surfaces: req.cfConfig.surfaces } : {}),
          },
        }
      : {}),
    // mediaRestore binds the media RE-UPLOAD target (account) to match the engine, so a media re-upload
    // carries its OWN approval. The TOKEN is never included (a secret), matching engine approvals.ts.
    ...(req.mediaRestore ? { mediaRestore: { accountId: req.mediaRestore.accountId } } : {}),
    // d1Tables binds the D1 table-subset scope, byte-for-byte with the engine (approvals.ts): database +
    // lower-cased, deduped, sorted table names + createOnly when true. The Array guard keeps a malformed
    // tables value from hashing over its characters (the engine refuses it anyway).
    ...(req.d1Tables && Array.isArray(req.d1Tables.tables)
      ? { d1Tables: { database: req.d1Tables.database, tables: [...new Set(req.d1Tables.tables.map((t) => String(t).toLowerCase()))].sort(), ...(req.d1Tables.createOnly === true ? { createOnly: true } : {}) } }
      : {}),
  };
  return `sha384:${await sha384Hex(canonicalJSONBytes(binding))}`;
}

// PlanBinding mirrors the engine's private PlanBinding (engine/src/admin/approvals.ts): the
// canonical, redaction-safe object the plan hash is computed over. Not a wire type; it exists only
// so the client mirror builds the identical structure the engine hashes.
interface PlanBinding {
  runId: string;
  target: { binding?: string; namespaceId?: string; bucketName?: string } | null;
  include: string[];
  exclude: string[];
  maxRecords?: number;
  // recordName binds a GRANULAR single-record restore into the plan hash (mirrors the engine), so a
  // single-record apply carries its own distinct approval. Included only when set.
  recordName?: string;
  // cfConfig binds the Cloudflare-config apply target (account + optional zone) into the plan hash (mirrors
  // the engine); the token is never part of it. Included only when set.
  cfConfig?: { accountId: string; zoneId?: string };
  // mediaRestore binds the media re-upload target (account) into the plan hash (mirrors the engine); the
  // token is never part of it. Included only when set.
  mediaRestore?: { accountId: string };
  // d1Tables binds the D1 table-subset scope into the plan hash (mirrors the engine): { database, tables
  // (lower-cased, deduped, sorted), createOnly? }. Included only when set.
  d1Tables?: { database: string; tables: string[]; createOnly?: boolean };
}

// canonicalJSONBytes mirrors the engine's canonicalJSON (engine/src/format/canonjson.ts) so the
// plan-hash client mirror produces the identical preimage: object keys sorted by UTF-16 code unit
// (JavaScript's default string sort), no insignificant whitespace, integers only, no HTML escaping
// (JSON.stringify does not HTML-escape). The PlanBinding only ever contains strings, string arrays,
// null and one optional safe-integer (maxRecords), so the integer guard is satisfied. Returns UTF-8
// bytes for the SHA-384 input.
function canonicalJSONBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canon(value));
}

function canon(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`non-integer number ${v} is not allowed in a canonical object`);
    if (!Number.isSafeInteger(v)) throw new Error(`integer ${v} exceeds the 2^53-1 canonical ceiling`);
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort(); // default JS sort is UTF-16 code-unit order, matching the engine
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`).join(",")}}`;
  }
  throw new Error(`unsupported value in canonical JSON: ${typeof v}`);
}
