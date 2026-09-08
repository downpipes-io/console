// Source-discovery + cf-config + binding-attach domain functions for the EngineClient. Free functions over
// the shared Transport.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { ChangeRef } from "../change-ref.ts";
import type {
  AttachSourceInput,
  CfConfigDiscovery,
  DiscoveryStatus,
  MutationResult,
  OwnerActionResult,
  SourceDiscovery,
} from "./types.ts";

// discoverSources lists the backup-able sources in two tiers. BOUND: the engine's own env
// bindings, classified server-side by duck-typing (names only, no values, keys or data; the
// engine's reserved bindings excluded), creatable immediately. ACCOUNT (opt-in): when the
// customer stores their own READ-ONLY Cloudflare API token on the engine
// (DISCOVERY_API_TOKEN), everything that EXISTS in the account, KV namespaces, R2 buckets, D1
// databases, Secrets Store secrets, with ids, so the console can generate the exact wrangler
// stanza to bind a selection. Custody is unchanged (the customer's token, in their account; the
// vendor never sees it); accountErrors carries coarse per-product failures (a missing scope
// degrades one product, never the route). downpipe.read gated server-side.
export async function discoverSources(t: Transport): Promise<SourceDiscovery> {
  const r = await engineFetch(`${t.base}/admin/sources/discover`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<SourceDiscovery>(r, "source discovery");
}

// getDiscoveryStatus reads the presence-only account-discovery configuration (never the token).
export async function getDiscoveryStatus(t: Transport): Promise<DiscoveryStatus> {
  const r = await engineFetch(`${t.base}/admin/sources/discovery-status`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<DiscoveryStatus>(r, "discovery status");
}

// setDiscoveryToken stores (token) or clears (null) the customer's READ-ONLY API token. The
// engine verifies a pasted token LIVE against the Cloudflare API before storing (a typo or a
// scope-less token is refused with the platform's status, never stored), stores it in the
// scheduler DO (runtime, no CLI, no redeploy), audits who flipped it, and returns presence +
// the verified account list so the console can open the account chooser for a multi-account
// token. Owner-exclusive server-side. Setting the read-only API token is a high-blast owner
// mutation (it hands the engine an account-read CF credential), so when dual control is ON the
// engine queues it for a SECOND owner (HTTP 202): this resolves to a discriminated OwnerActionResult
// so the caller surfaces "queued for a second owner" rather than a false "token verified". The
// gate-off path returns { status:"result", value } unchanged.
export async function setDiscoveryToken(t: Transport, token: string | null, change?: ChangeRef): Promise<OwnerActionResult<DiscoveryStatus>> {
  // The OPTIONAL change reference (change management) rides as the X-Downpipes-Change header when supplied.
  const r = await engineFetch(`${t.base}/admin/sources/discovery-token`, {
    method: "POST",
    headers: { ...t.headers(change) },
    credentials: "include",
    body: JSON.stringify({ token }),
  });
  return t.parseJsonOrOwnerAction<DiscoveryStatus>(r, "discovery token");
}

// setDiscoveryAccounts chooses WHICH of the token's accounts are browsed and which one is the
// ENGINE's own (binding stanzas only attach there). Owner-exclusive server-side; ids must be
// among the verified accountsSeen.
//
// 202-DECODE (this pass): changing the browsed accounts is the GATED owner action
// `discovery-accounts-set` (engine scheduler-do-routing-config.ts, the POST /sources/discovery-accounts
// case, which wraps the write in gatedOwnerAction and answers through ownerActionJson). With dual control
// armed the engine answers HTTP 202 + { ownerActionQueued:true, id, status } and writes NOTHING. This used
// to read through plain parseJson, so the queued body was cast to a DiscoveryStatus and resolved as an
// applied result: the account chooser simply refreshed, showing the OLD account selection with no toast and
// no error, and the operator was left to conclude their save had silently reverted. Its sibling
// setDiscoveryToken (the same file, the same gate, one route over) has always read through
// parseJsonOrOwnerAction; the asymmetry was the whole bug. Reading through the same decoder gives the caller
// a discriminated { status:"queued" } to surface honestly. The gate-off path returns
// { status:"result", value } and is unchanged.
export async function setDiscoveryAccounts(t: Transport, selected: string[], engineAccountId: string | null, change?: ChangeRef): Promise<OwnerActionResult<DiscoveryStatus>> {
  // The OPTIONAL change reference (change management) rides as the X-Downpipes-Change header when supplied.
  const r = await engineFetch(`${t.base}/admin/sources/discovery-accounts`, {
    method: "POST",
    headers: { ...t.headers(change) },
    credentials: "include",
    body: JSON.stringify({ selected, engineAccountId }),
  });
  return t.parseJsonOrOwnerAction<DiscoveryStatus>(r, "discovery accounts");
}

// setEnabledSources records WHICH token-authenticated source types (cf-config / workers / stream /
// images / artifacts) are ADDED as available to protect, so the create-downpipe wizard offers only
// added types (the same add-then-protect discipline a bound source has). SET semantics: the full
// desired list is sent each call (idempotent). The engine filters to the known types and stores it in
// the discovery config; owner-exclusive server-side. Returns the updated discovery status (presence +
// the new enabledSources), so the Sources Add UI re-reads what is now added.
export async function setEnabledSources(t: Transport, sources: string[]): Promise<DiscoveryStatus> {
  const r = await engineFetch(`${t.base}/admin/sources/enable`, {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ sources }),
  });
  return t.parseJson<DiscoveryStatus>(r, "enable sources");
}

// rediscoverCfConfig probes which cf-config surfaces THIS downpipe's account/zone actually uses and
// caches the present set on the engine, so auto-mode runs back up only those (not every surface in the
// registry, every run). Makes real read-only CF API calls server-side (downpipe.write gated + rate-limited);
// returns the present/empty/unavailable partition for display. A soft failure comes back ok:false.
export async function rediscoverCfConfig(t: Transport, id: string): Promise<{ ok: boolean; error?: string; discovery?: CfConfigDiscovery }> {
  const r = await engineFetch(`${t.base}/admin/downpipes/cf-config/rediscover`, {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ id }),
  });
  return t.parseJson<{ ok: boolean; error?: string; discovery?: CfConfigDiscovery }>(r, "cf-config rediscover");
}

// setCfConfigMode sets a cf-config downpipe's capture mode: "auto" (capture the discovered present
// set) or "manual" (capture the operator's surface selection). downpipe.write gated server-side.
//
// 202-DECODE (this pass): the capture mode is the GATED config mutation `cf-config-mode-set` (engine
// scheduler-do-routing.ts, the POST /cf-config/mode case, which dispatches through gatedConfigMutation), so
// with the change-control gate armed the engine answers HTTP 202 + { queued:true, id, status, contentHash }
// and applies NOTHING. This used to read through plain parseJson, which throws only on a NON-2xx: the 202
// sailed through, its body was cast to { ok, error }, and `ok` came back undefined. The capture-mode select
// then took its else branch and told the operator "Could not change capture mode (failed)" for a request the
// engine had accepted and queued, and reverted the select to the old mode. A FALSE FAILURE is the worse half
// of this class: it drives the operator to retry (queuing a second identical change for the approver) or to
// believe the mode is unchanged when a second approver is about to change it. Reading through
// parseJsonOrPending -- the decoder every other change-controlled mutation in this console already uses --
// gives the caller a discriminated { status:"pending" } to surface honestly. The gate-off path returns
// { status:"applied", value } and is unchanged.
export async function setCfConfigMode(t: Transport, id: string, mode: "auto" | "manual"): Promise<MutationResult<{ ok: boolean; error?: string }>> {
  const r = await engineFetch(`${t.base}/admin/downpipes/cf-config/mode`, {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ id, mode }),
  });
  return t.parseJsonOrPending<{ ok: boolean; error?: string }>(r, "cf-config mode");
}

// changeBindings applies an attach (add) and/or a detach (remove) in ONE atomic settings write, using the
// one-shot deploy token. The engine runs the full validation sequence (read the deployed bindings, confirm the
// change is exactly intended, write, then verify) and refuses to the deploy path on any anomaly without touching
// the engine. The refusal reason is specific and actionable, so fold it into the throw. Never stored or
// logged; audited by binding name. add/remove ride as `sources`/`remove` on the wire. Owner-exclusive
// server-side.
// changeBindings attaches and/or detaches source bindings via POST /admin/sources/attach, using the
// one-shot deploy token in the body for the deploy write only (never stored). sources-attach is a
// HIGH-BLAST owner action (it hands the engine a deploy credential and changes the protected set), so
// when dual control is armed the engine QUEUES it for a second owner (HTTP 202) WITHOUT applying: this
// returns a discriminated OwnerActionResult so a queued reply is surfaced as "queued for a second owner"
// (never a false "attached, verified safe" that would tell the operator to revoke a token still needed to
// complete the attach after approval). The gate-off path returns { status:"result", value } unchanged.
export async function changeBindings(t: Transport, token: string, add: AttachSourceInput[], remove: string[]): Promise<OwnerActionResult<{ attached: string[]; detached: string[] }>> {
  // A binding write the engine's prove-before-write harness REFUSES emits no sources-attached and no
  // sources-detached event, so unlike a successful change it is invisible in the pack, and this is the owner's
  // stated number-one fear domain. The op is decided HERE because it cannot be decided anywhere else: an attach
  // and a detach are the SAME POST to the same route, told apart only by which of these two typed arguments the
  // console filled in. A pure detach (nothing added, something removed) is `source-detach`; anything that adds
  // is `source-attach`, including a change that does both, because the attach is the half that deploys.
  //
  // Only the COUNTS of the two lists are consulted. No binding name enters the record: the names are the
  // operator's own labels and there is no field on the row for one.
  const adminOp = add.length === 0 && remove.length > 0 ? "source-detach" : "source-attach";
  const r = await engineFetch(
    `${t.base}/admin/sources/attach`,
    {
      method: "POST",
      headers: { ...t.headers() },
      credentials: "include",
      body: JSON.stringify({ token, sources: add, remove }),
    },
    { adminOp },
  );
  return t.parseJsonOrOwnerAction<{ attached: string[]; detached: string[] }>(r, "change bindings");
}

// ReattachResult is the outcome of a roster-driven re-attach: the bindings re-added (attached), the ones
// already present (alreadyAttached, idempotent skip), the ones the roster could not rebuild because a
// legacy config did not record the native resource id (unreconstructable, to re-save from the Sources
// screen), and the ones two downpipes disagree about (conflicting, never written; each carries the
// engine's precise reason so the operator can resolve which claim is right). affects maps each binding
// to the downpipe ids it covers.
export interface ReattachResult {
  attached: string[];
  alreadyAttached: string[];
  unreconstructable: { binding: string; type: string; downpipes: string[]; reason: string }[];
  conflicting: { binding: string; downpipes: string[]; reason: string }[];
  affects: Record<string, string[]>;
  auditDeferred?: boolean;
}

// reattachMissing HEALS the engine after a deploy/wipe dropped console-attached source bindings: it asks
// the engine to recompute the missing set from the persisted roster (the downpipe configs) vs the live
// bindings and re-add exactly those, with their ORIGINAL names + recorded native ids, so each downpipe
// reads its source again and its next run continues the SAME backup history (no new downpipe, no orphaned
// lineage). The one-shot deploy token rides in the body for one read-modify-write; never stored or logged.
// When nothing is missing the engine returns attached:[] WITHOUT needing the token, so the caller can show
// "all attached". Owner-exclusive server-side; the engine runs the same prove-before-write/verify-after as
// the attach path. The refusal reason is specific and actionable, so fold it into the throw.
export async function reattachMissing(t: Transport, token: string): Promise<ReattachResult> {
  const r = await engineFetch(
    `${t.base}/admin/sources/reattach-missing`,
    {
      method: "POST",
      headers: { ...t.headers() },
      credentials: "include",
      body: JSON.stringify({ token }),
    },
    { adminOp: "source-reattach" },
  );
  if (!r.ok) {
    const reason = await t.foldableReason(r); // NOT readErrorReason: 401/403/429/5xx must keep failResponse's marker
    if (reason !== null) throw new Error(`re-attach sources: ${reason}: ${r.status}`);
    return t.failResponse(r, "re-attach sources");
  }
  return t.parseJson<ReattachResult>(r, "re-attach sources");
}
