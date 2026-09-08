// The live demo world and its shared helpers, split out of the faked engine (see demo-seed.ts for the file
// layout). This module owns the ONE module-scoped world object both route tables read and mutate, the
// resetWorld/demoWhoami entry points, and the response/clock/paging helpers the route tables share.
//
// House rules: Australian English, precise claims (tamper-evident, post-quantum hybrid).

import type {
  AuditPage,
  DownpipeState,
  EngineDownpipeState,
  PointInTimeRun,
  WhoAmI,
} from "../api/types.ts";
import type { Provider } from "../../screens/destination-form-fields.ts";
import { buildSeed, type DemoWorld } from "./demo-seed.ts";
import { applyDemoStateVariant, type DemoStateVariant } from "./demo-state.ts";

// The live world. Module-scoped so the whole faked backend is one object; reload re-seeds it. resetWorld()
// rebuilds it for a deterministic "Back"/Restart replay (phase 2) without a page reload.
export let world: DemoWorld = buildSeed(Date.now());

// resetWorld rebuilds the pristine seed. Exported so the tour director (phase 2) and the tests can return
// the faked backend to its known state without reloading the page. It always returns to the PRISTINE
// default: it carries no demo-state variant of its own, so an existing caller (the tour's own "Reset
// sample data" control) is completely unaffected by the demo-state knob below.
export function resetWorld(now: number = Date.now()): void {
  world = buildSeed(now);
}

// applyDemoState re-shapes the CURRENT world through one demo-state.ts variant (empty / minimal / aged /
// role:<r>), or leaves it unchanged for "default". A SEPARATE, ADDITIVE step from resetWorld above: it is
// called exactly once, at boot, only by demo-fetch.ts's startDemo() -- after the pristine seed exists, so
// every existing resetWorld() caller (the tour director, a future test importing this module directly) is
// unaffected unless it explicitly opts into a variant too.
export function applyDemoState(variant: DemoStateVariant): void {
  world = applyDemoStateVariant(world, variant);
}

// applyWorldTransform re-shapes the CURRENT world through one pure transform (the training walk's
// time jumps: demo-state.ts advanceWorldDays / injectRunFailure). The same additive discipline as
// applyDemoState above: existing callers are unaffected unless they explicitly apply a transform, and
// the training director applies one only at a chapter boundary, where its navigation forces a fresh
// render, so no mounted screen holds the pre-transform world.
export function applyWorldTransform(transform: (w: DemoWorld) => DemoWorld): void {
  world = transform(world);
}

// settleDueRuns is the read-driven half of triggered-run settlement (see DemoWorld.settleQueue in
// demo-seed.ts): each /admin/history read that serves a queued run's ring decrements its countdown, and
// at zero the in-flight entry settles ok with honest representative counts, the downpipe's in-flight
// flag clears, and the queue entry is dropped. Deterministic by construction: the Nth read settles,
// whoever makes it (the Runs screen's manual refresh, the downpipes screen's auto-refresh, the robot
// learner), so the Running-then-ok sequence replays identically. `downpipeId` scopes the tick to the
// ring actually being served; the aggregate all-downpipes read ticks every queued run.
export function settleDueRuns(downpipeId?: string): void {
  for (const [runId, pending] of Object.entries(world.settleQueue)) {
    if (downpipeId !== undefined && pending.downpipeId !== downpipeId) continue;
    pending.readsRemaining -= 1;
    if (pending.readsRemaining > 0) continue;
    const ring = world.historyByDownpipe[pending.downpipeId] ?? [];
    const entry = ring.find((e) => e.runId === runId);
    if (entry !== undefined && entry.status === "in-flight") {
      entry.status = "ok";
      entry.recordCount = 1200;
      entry.bytes = 48_000_000;
      entry.durationMs = 42_000;
      const dp = world.downpipes.find((d) => d.config.id === pending.downpipeId);
      const destId = dp?.config.destinationIds?.[0] ?? world.destinations.defaultId;
      if (typeof destId === "string" && destId !== "") entry.destinationId = destId;
      if (dp) dp.inFlight = false;
    }
    delete world.settleQueue[runId];
  }
}

// demoWhoami returns the seeded WhoAmI synchronously, straight off the in-memory world (the verified owner the
// faked engine answers GET /admin/whoami with). The no-login boot (demo-fetch.startDemo) uses it to PRIME the
// store's caller before the first render, so free-explore screens that render before the background whoami
// resolves still see the owner. It is the SAME shape the /admin/whoami route serves, so the primed caller is
// byte-identical to the one app.ts's resolveIdentity later builds from that route. No engine client is needed:
// it reads the module-scoped world directly.
export function demoWhoami(): WhoAmI {
  return world.whoami;
}

import { type DemoDriftKind, noteDemoDrift } from "./demo-drift.ts";

// readBody parses a write's request-init JSON body into the expected shape, or {} when absent/unparseable,
// so a handler reads typed fields defensively (a malformed body degrades to defaults rather than throwing).
// currentWritePath is the route the write in flight is on, set by routeWrite (demo-routes-write.ts) before
// it dispatches, via setCurrentWritePath below. It exists so readBody's body-parse drift event can NAME the
// route (G337) without threading a pathname through every handler signature. The demo router is
// single-threaded and dispatches one write at a time, and readBody is called synchronously inside the
// handler, so it always reads the route it belongs to. Shared by both write-route modules, so a duplicated
// reader cannot silently drop the drift note (the exact regression validate-tour.ts caught when a copy
// briefly existed).
let currentWritePath = "/admin";

export function setCurrentWritePath(pathname: string): void {
  currentWritePath = pathname;
}

export function readBody<T>(init?: RequestInit, pathname = currentWritePath): Partial<T> {
  const raw = init?.body;
  if (typeof raw !== "string" || raw === "") return {};
  try {
    return JSON.parse(raw) as Partial<T>;
  } catch {
    // G337: the write body could not be parsed, so the faked engine applied ITS DEFAULTS and answered success.
    // The visitor's choice was silently discarded and the screen reflected something they did not ask for. The
    // body itself is NEVER recorded: it is the one thing on this path a visitor could have typed into.
    noteDemoDrift("body-parse-failed", pathname);
    return {};
  }
}

// queuedChange mints the deferred-mutation 202 body, and it mints THE BODY THE ENGINE ACTUALLY SENDS:
// { queued: true, id, status, contentHash } (sched/scheduler-do.ts, the one gated-config 202 there is).
//
// The demo used to fabricate `{ pending: true, id, kind, diff }`, a shape no engine route emits (G301). That was
// not a harmless demo liberty: the console's own guard was written to the same fabricated shape, so THE DEMO WAS
// THE ONLY PLACE THE QUEUED-FOR-APPROVAL PATH EVER WORKED. The tour showed the pending toast and its link into
// the approval inbox; against a real engine the guard missed, every 202 degraded to "applied", and the operator
// was told a queued change had been saved. A simulator that answers a body the real thing never sends does not
// de-risk the real path, it hides it. One helper now, shared by both write-route modules, so the demo
// cannot drift off the wire again.
export function queuedChange(id: string): import("../api/types.ts").PendingChangeBody {
  return { queued: true, id, status: "pending", contentHash: `sha256-demo-${id}` };
}

// AZURE_STORAGE_SUFFIXES / demoProviderForEndpoint MIRROR the engine's providerForEndpoint
// (engine/src/dest/provider.ts), which is the authority on which store is behind a destination endpoint.
//
// WHY THE DEMO NEEDS IT AT ALL. Two places here derived the destination kind as
// `includes("r2.cloudflarestorage.com") ? "r2" : "s3"`, which has exactly two answers where the product has
// four. A learner who saved a Google Cloud or Azure destination in the training course had it reported back
// as "s3", and that answer is read by the residency panel (which is the screen that says whether data
// leaves the Cloudflare account), by the topology map's destination phrase, and by the downpipe drawer. So
// the course taught the wrong vendor for the learner's own destination, on the screens whose whole job is
// to say where the archives went.
//
// The two host matches differ on purpose, exactly as the engine's do: a WHOLE-HOST match for Google Cloud,
// which publishes one interop host, so a look-alike domain is not labelled Google; and a SUFFIX match on
// the account label for Azure, whose blob endpoint carries the storage account as its first label. The
// leading dot is what makes that a label boundary rather than a bare string ending, and the "$" is what
// stops a host with the Azure suffix in the middle of it reading as Azure.
const AZURE_STORAGE_SUFFIXES: readonly string[] = ["core.windows.net", "core.usgovcloudapi.net", "core.chinacloudapi.cn"];
const AZURE_BLOB_HOST = new RegExp(`\\.blob\\.(?:${AZURE_STORAGE_SUFFIXES.map((sfx) => sfx.replace(/\./g, "\\.")).join("|")})$`, "i");
const R2_HOST = /(^|\.)r2\.cloudflarestorage\.com$/i;

/** demoProviderForEndpoint names the store behind a destination endpoint host, the four-way answer the
 *  engine gives. "s3" is the residual and stays the residual: any S3-compatible store not recognised by
 *  host (Wasabi, Backblaze B2, MinIO, a private endpoint) reads as "s3", exactly as before.
 *
 * @param hostOrUrl - the endpoint, as a full URL or a bare host.
 * @returns the derived provider.
 */
export function demoProviderForEndpoint(hostOrUrl: string | undefined): Provider {
  const h = (hostOrUrl ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
  if (h === "") return "s3";
  if (R2_HOST.test(h)) return "r2";
  if (h === "storage.googleapis.com") return "gcs";
  if (AZURE_BLOB_HOST.test(h)) return "azure";
  return "s3";
}

// json builds a 200 application/json Response from a value, the same content-type the console's parseJson
// path expects. The body is the serialised wire shape; no header carries a secret.
export function json(value: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(value), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

// notImplemented is a DELIBERATE non-2xx the demo returns ONLY where the console EXPECTS one and degrades
// gracefully on it (the PDF render path and an unknown report kind, which the report screens route through
// failResponse to restore the download button and show an honest "could not download" warn; and an unknown
// restore approve/reject plan, which has nothing to action). It is NOT the generic fallback: an unmodelled
// SCREEN-LOAD path must never reach here (it returns a benign empty-but-valid 200 via benignGet below), so a
// publicly explorable tour never surfaces "the engine returned an error" on a screen. The path is echoed.
export function notImplemented(method: string, path: string, kind: DemoDriftKind = "fallback-substitution"): Response {
  // G337: an honest 501 is still DRIFT. The console asked the faked engine for something it does not model, and
  // the visitor met a dead affordance (a download that cannot download, an approval that cannot be actioned).
  // The kind says WHICH, so a PDF the tour never modelled is not confused with a plan hash that did not match.
  noteDemoDrift(kind, path);
  return json({ error: `demo engine does not model ${method} ${path}` }, { status: 501 });
}

// benignGet is the GRACEFUL fallback for any GET the demo does not explicitly model: a 200 with a safe,
// empty-but-VALID shape so the calling screen renders an empty/healthy state rather than an engine error.
// The shape is chosen to satisfy the broadest set of console list/status parsers: an object that is ALSO
// usable as an empty array (length 0, every index undefined), carrying the common empty-collection envelopes
// (items/events/versions/connections/credentials/sessions/providers/presets/byDownpipe) and the benign
// status flags (ok/present/found/configured) so whichever field a screen reads is present and harmless. The
// public tour degrades gracefully here; it never fails loud on a screen load.
export function benignGet(pathname = "/admin"): Response {
  // G337: THE fabricated-success funnel on the read side. This 200 makes an unmodelled screen render blank and
  // healthy, which is the right thing to do to a prospect mid-tour and the reason console-vs-demo drift has
  // been invisible for weeks at a time. The route PATTERN (product words only, ids replaced) is emitted so the
  // routes the table outgrew can be enumerated instead of discovered by a human replaying the tour.
  noteDemoDrift("unmodelled-get", pathname);
  const empty: unknown[] = [];
  const body = {
    ok: true,
    present: false,
    found: false,
    configured: false,
    enabled: false,
    items: empty,
    events: empty,
    versions: empty,
    connections: empty,
    providers: empty,
    presets: empty,
    credentials: empty,
    sessions: empty,
    channels: empty,
    rules: empty,
    history: empty,
    byDownpipe: {},
    length: 0,
  };
  return json(body);
}

// benignWrite is the GRACEFUL fallback for any POST/mutation the demo does not explicitly model: a 200 with
// a generic applied/ok result. It carries the shapes the common mutation parsers read (ok/deleted/applied
// plus a discovery/owner-action-style result envelope) so a click resolves as a benign success rather than
// erroring. No world mutation (an unmodelled write changes nothing); a reload re-seeds. The public tour
// degrades gracefully here; a click never surfaces "the engine returned an error".
export function benignWrite(pathname = "/admin"): Response {
  // G337: the same funnel on the WRITE side, and the more serious of the two. This 200 answers "deleted: true,
  // applied: true" to a mutation the faked engine never performed: the delete that "succeeded" with nothing
  // changing, and the drill / blind test / attestation that "passes" for a run that does not exist. A demo that
  // lies about a recoverability proof is worse than a demo that admits it cannot do something.
  noteDemoDrift("unmodelled-post", pathname);
  return json({ ok: true, deleted: true, applied: true, status: "result", value: { ok: true } });
}

// demoEpoch / demoIso are the module-scoped clock helpers the route handlers use (buildSeed's own iso/epoch
// are local to it). Each is "now" plus a signed offset, so a handler's timestamps read as "just now"-ish on
// every call, exactly like the seed's.
export function demoEpoch(offsetMs: number): number {
  return Date.now() + offsetMs;
}
export function demoIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

// runsAtResolve models GET /admin/runs/at?downpipe=&at=<rfc3339> (resolveRunAt): the latest SUCCESSFUL run
// at-or-before T from the named downpipe's ring. The demo resolves it from the ring head (the most recent ok
// run), so the point-in-time restore picker shows a real recovery point; an unknown downpipe is the honest
// found:false with the recoverable-window bounds absent. Redaction-safe (a run id + a timestamp + an index).
export function runsAtResolve(query: URLSearchParams): PointInTimeRun {
  const downpipeId = query.get("downpipe") ?? "";
  const ring = world.historyByDownpipe[downpipeId] ?? [];
  const ok = ring.find((r) => r.status === "ok");
  if (!ok) {
    return { downpipeId, found: false, reason: ring.length === 0 ? "no such downpipe in the demo world" : "no successful run at or before that time" };
  }
  return {
    downpipeId,
    found: true,
    runId: ok.runId,
    completedAt: ok.startedAt,
    index: ok.index,
    retainedFrom: ring[ring.length - 1]?.startedAt ?? ok.startedAt,
    retainedTo: ring[0]?.startedAt ?? ok.startedAt,
  };
}

// pathAndMethod normalises the request into a bare pathname (no origin, no query) and an upper-case method,
// the two keys the table dispatches on. The query string is parsed by the individual handlers that need it.
export function pathAndMethod(path: string, init?: RequestInit): { pathname: string; query: URLSearchParams; method: string } {
  // The console always calls an absolute `${base}${path}`; base is location.origin in the demo. Parse against
  // a fixed base so a relative path (defensive) still resolves, then take only the pathname + query.
  const url = new URL(path, "http://demo.invalid");
  return {
    pathname: url.pathname,
    query: url.searchParams,
    method: (init?.method ?? "GET").toUpperCase(),
  };
}

// auditPage builds the GET /admin/audit response honouring the server-side filters the audit screen sends
// (actor / action / outcome / before / limit). before pages OLDER than a seq (the screen's "load older"),
// so the paging terminates; an empty page is the honest end of the log. The head is the newest seq/hash of
// the WHOLE chain (not the filtered slice), so the tamper-evidence head stamp is stable across filters.
export function auditPage(query: URLSearchParams): AuditPage {
  const all = world.audit; // newest-first
  const head = all[0];
  const actor = query.get("actor");
  const action = query.get("action");
  const outcome = query.get("outcome");
  const before = query.get("before");
  const limitRaw = Number(query.get("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  let events = all.filter((e) => {
    if (actor !== null && actor !== "" && !(e.actorEmail ?? "").toLowerCase().includes(actor.toLowerCase())) return false;
    if (action !== null && action !== "" && e.action !== action) return false;
    if (outcome !== null && outcome !== "" && e.outcome !== outcome) return false;
    if (before !== null && before !== "" && !(e.seq < Number(before))) return false;
    return true;
  });
  if (limit !== undefined) events = events.slice(0, limit);
  return { events, headSeq: head?.seq ?? 0, headHash: head?.hash ?? "" };
}

// toEngineDownpipeWire serialises one internally-held DownpipeState (the console's NORMALISED flat-ISO
// shape the seed and the write handlers maintain) as the engine's RAW wire EngineDownpipeState, so GET
// /admin/downpipes answers in the EXACT shape the only consumer, listDownpipes(), parses. listDownpipes
// runs the response through mapEngineDownpipeState, which reads the engine's NESTED restoreProven /
// integrityVerified objects and an EPOCH-MS lastRestoreTestAt; serving the flat fields verbatim made that
// mapper drop every recency stamp, so every pipe silently read "never proven" / "never
// integrity-checked". This converter is the exact INVERSE of that mapper (flat ISO -> nested epoch-ms),
// keeping the demo wire-faithful: the seed's "proven N days ago" assurance survives the round trip, and
// the not-yet-proven pipes (cf-config and the freshly added artifacts pipe, which honestly carry no
// proven/test stamps) still read "never proven", preserving the deliberate contrast. It runs at READ time, so a drill / blind verify / apply that stamps a flat
// field via stampProven is reflected on the next list too. exactOptionalPropertyTypes: each optional wire
// field is spread in ONLY when the flat source carries a value, so an absent flat field stays absent (it
// never round-trips through a present-as-undefined). The synthesised method / how / runId are discarded by
// mapEngineDownpipeState (it keeps only at + by), so honest representative values suffice; no value or key
// transits (recency + a coarse prover label only).
export function toEngineDownpipeWire(dp: DownpipeState): EngineDownpipeState {
  const testMs = dp.lastRestoreTestAt !== undefined ? Date.parse(dp.lastRestoreTestAt) : NaN;
  const provenMs = dp.lastRestoreProvenAt !== undefined ? Date.parse(dp.lastRestoreProvenAt) : NaN;
  const integrityMs = dp.lastIntegrityVerifiedAt !== undefined ? Date.parse(dp.lastIntegrityVerifiedAt) : NaN;
  return {
    config: dp.config,
    nextRunAt: dp.nextRunAt,
    lastRunId: dp.lastRunId,
    inFlight: dp.inFlight,
    ...(Number.isFinite(testMs) ? { lastRestoreTestAt: testMs } : {}),
    ...(dp.lastRestoreTestOk !== undefined ? { lastRestoreTestOk: dp.lastRestoreTestOk } : {}),
    // The method-faithful compliance fields round-trip as top-level passthrough (epoch-identical on both
    // sides): the last-test KIND and, for an attended pass, its per-run sample RATE. Serving them lets the
    // demo represent an attended verification (kind:"attended", sampleRate < 100) that the recency read must
    // render amber rather than a false fully-green, so the demo exercises the compliance surfacing honestly.
    ...(dp.lastRestoreTestKind !== undefined ? { lastRestoreTestKind: dp.lastRestoreTestKind } : {}),
    ...(dp.lastRestoreTestSampleRate !== undefined ? { lastRestoreTestSampleRate: dp.lastRestoreTestSampleRate } : {}),
    // The engine carries the prover identity inside the nested record; the flat shape splits it across
    // lastRestoreProvenAt + lastRestoreProvenBy (+ the flattened method). Re-nest only when the proof
    // actually happened (a finite stamp), so an unproven pipe (e.g. cf-config) round-trips as ABSENT and
    // reads "never proven"; the method honours the seed's flat restoreProvenMethod, defaulting to blind-test.
    ...(Number.isFinite(provenMs)
      ? { restoreProven: { at: provenMs, by: dp.lastRestoreProvenBy ?? null, method: dp.restoreProvenMethod ?? "blind-test", runId: dp.lastRunId ?? "" } }
      : {}),
    // integrityVerified is PASS-only on the wire (the engine stamps it only on a pass), so re-nest only a
    // present, OK stamp; a failed or absent flat stamp round-trips as absent and reads "never
    // integrity-checked" rather than a fabricated pass.
    ...(Number.isFinite(integrityMs) && dp.lastIntegrityVerifiedOk !== false
      ? { integrityVerified: { at: integrityMs, how: "run" } }
      : {}),
    ...(dp.cfConfigDiscovery !== undefined ? { cfConfigDiscovery: dp.cfConfigDiscovery } : {}),
  };
}
