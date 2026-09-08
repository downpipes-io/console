// Key-install + posture-tightening + guided-setup domain functions for the EngineClient. Free functions
// over the shared Transport.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { ChangeRef } from "../change-ref.ts";
import type { AttachSourceInput, CustodyShareSendInput, CustodyShareSendResult, KeyInstallInput, KeyInstallResult, KeyVintageInventory, OwnerActionResult } from "./types.ts";
import { changeBindings } from "./client-sources.ts";

// getKeyVintages reads the KEYLESS key-vintage inventory: which archive vintages each key opens, how many
// runs are stranded to a key the engine no longer holds, and the signer-continuity rollup. Gated on
// downpipe.read server-side, the same capability as the run-history reads it is derived from. It is the
// SURFACING half the rotation warning needed: without a console caller, an owner who rotated and kept
// only the latest key had no way to see the old
// vintage was stranded. The response is { inventory }; the wrapper is unwrapped here so screens hold the
// inventory itself. Nothing in the body is a key: fingerprints, a closed role name and counts only.
export async function getKeyVintages(t: Transport): Promise<KeyVintageInventory> {
  const r = await engineFetch(`${t.base}/admin/keys/vintages`, { headers: t.headers(), credentials: "include" });
  const body = await t.parseJson<{ inventory: KeyVintageInventory }>(r, "key vintages");
  return body.inventory;
}

// attachSources is the add-only convenience over changeBindings (kept for existing callers). It forwards
// the discriminated OwnerActionResult so a dual-control-queued attach (HTTP 202) is not mistaken for an
// applied one; a queued result is passed through, an applied one narrows to just the attached ids.
export async function attachSources(t: Transport, token: string, sources: AttachSourceInput[]): Promise<OwnerActionResult<{ attached: string[] }>> {
  const res = await changeBindings(t, token, sources, []);
  return res.status === "queued" ? res : { status: "result", value: { attached: res.value.attached } };
}

// installKeys installs the in-browser key ceremony's output as the engine's OWN worker secrets
// via POST /admin/keys/install, using the ONE-SHOT scoped "Edit Cloudflare Workers" token in the
// body for the writes only (the no-customer-CLI replacement for `wrangler secret put`). The token
// and the private values are sent ONCE over the authenticated same-origin channel; the engine
// VALIDATES every key before any write, NEVER stores or logs the token/private bytes, and audits
// the install by NAME only. The engine returns the signer PUBLIC + presence booleans. A refusal
// (a bad key, or a token missing the Workers-edit scope) carries the engine's coarse, value-free
// reason, surfaced via readErrorReason so the operator learns WHY. Owner-exclusive server-side.
export async function installKeys(t: Transport, input: KeyInstallInput): Promise<KeyInstallResult> {
  const body: KeyInstallInput = {
    token: input.token,
    signerPrivate: input.signerPrivate,
    breakGlassPublic: input.breakGlassPublic,
    ...(input.operationalPublic !== undefined && input.operationalPublic !== "" ? { operationalPublic: input.operationalPublic } : {}),
    ...(input.operationalPrivate !== undefined && input.operationalPrivate !== "" ? { operationalPrivate: input.operationalPrivate } : {}),
    // confirmRekey rides ONLY when the caller set it (a deliberate, warned re-key over an existing signer);
    // a first install omits it, so the engine's already-present guard stays the backstop against a silent one.
    ...(input.confirmRekey === true ? { confirmRekey: true } : {}),
  };
  const r = await t.gatedFetch("/admin/keys/install", {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const reason = await t.foldableReason(r); // NOT readErrorReason: 401/403/429/5xx must keep failResponse's marker
    if (reason !== null) throw new Error(`install keys: ${reason}: ${r.status}`);
    return t.failResponse(r, "install keys");
  }
  return t.parseJson<KeyInstallResult>(r, "install keys");
}

// acknowledgeSetup marks the guided first run done when the operator finished the wizard with the
// keys already present (continuing with existing keys, which skips /keys/install, the only other
// path that clears the demo first-run marker). The engine SERVER-ENFORCES correctness: it clears
// the marker only when it observes the signer + break-glass present, so a premature call is a safe
// no-op (ok:false). Best-effort: a failure never blocks finishing the wizard, so this resolves to
// { ok:false } rather than throwing. Off-demo the marker is never set, so this is a harmless no-op.
export async function acknowledgeSetup(t: Transport): Promise<{ ok: boolean }> {
  try {
    const r = await engineFetch(`${t.base}/admin/setup/acknowledge`, {
      method: "POST",
      headers: { ...t.headers() },
      credentials: "include",
      body: "{}",
    });
    if (!r.ok) return { ok: false };
    const body = (await r.json().catch(() => ({}))) as { ok?: unknown };
    return { ok: body.ok === true };
  } catch {
    return { ok: false };
  }
}

// acknowledgePosture records the customer's confirmation of a versioned key-posture acceptance
// statement (the liability record). It sends only the posture, the statement VERSION and the exact
// words the console displayed (so the engine can reject a drifted console before it records anything);
// the engine recomputes the hash over its OWN canonical text and writes the posture, version and hash
// into the tamper-evident audit log, never the free-form text. channel distinguishes the onboarding
// fork from a later Keys re-key. Best-effort by design: the acknowledgement is advisory evidence, not
// an access gate, so a transient failure never blocks the ceremony (it resolves to { ok:false } rather
// than throwing), but the console records were it able to.
export async function acknowledgePosture(
  t: Transport,
  input: { posture: "operational" | "break-glass-only"; statementVersion: string; acknowledgedText: string; channel: "onboarding" | "keys-rekey" },
): Promise<{ ok: boolean; statementSha384?: string }> {
  try {
    const r = await fetch(`${t.base}/admin/keys/posture-acknowledgement`, {
      method: "POST",
      headers: { ...t.headers() },
      credentials: "include",
      body: JSON.stringify(input),
    });
    if (!r.ok) return { ok: false };
    const body = (await r.json().catch(() => ({}))) as { ok?: unknown; statementSha384?: unknown };
    return { ok: body.ok === true, ...(typeof body.statementSha384 === "string" ? { statementSha384: body.statementSha384 } : {}) };
  } catch {
    return { ok: false };
  }
}

// addOperationalKey installs ONLY the operational pair on a break-glass-only engine, via a one-shot
// scoped token, POSTing to /admin/keys/add-operational: the targeted upgrade path the full ceremony
// never had. The engine writes ONLY OPERATIONAL_PUBLIC and OPERATIONAL_PRIVATE; SIGNER_PRIVATE and
// BREAK_GLASS_PUBLIC are never touched, so every existing run stays signed by the same signer and
// console-verifiable exactly as before. It uses gatedFetch: a stale session's 401 { stepUpRequired } runs
// the step-up ceremony and retries automatically, matching installKeys. This sentence used to end "unlike
// rotateBreakGlass/setBreakGlassOnly (plain engineFetch, no auto-retry)", and it was made false by the same
// commit that fixed it moved both of those onto gatedFetch too, so the asymmetry it named is gone
// and every key route below now runs the ceremony. The engine REFUSES (a non-2xx { error }), never silently reissuing, when an
// operational key is already present; the console surfaces that reason via readErrorReason.
export async function addOperationalKey(t: Transport, input: { token: string; operationalPublic: string; operationalPrivate: string }): Promise<{ ok: true }> {
  const r = await t.gatedFetch("/admin/keys/add-operational", {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const reason = await t.foldableReason(r); // NOT readErrorReason: 401/403/429/5xx must keep failResponse's marker
    if (reason !== null) throw new Error(`add operational key: ${reason}: ${r.status}`);
    return t.failResponse(r, "add operational key");
  }
  return t.parseJson<{ ok: true }>(r, "add operational key");
}

// rotateBreakGlass applies a NEW break-glass public to the engine via a one-shot scoped token (the
// engine writes only BREAK_GLASS_PUBLIC; signer + operational untouched). The new break-glass
// PRIVATE never leaves the browser. Mirrors installKeys' coarse, value-free error surfacing.
export async function rotateBreakGlass(t: Transport, token: string, breakGlassPublic: string): Promise<{ ok: true }> {
  const r = await t.gatedFetch("/admin/keys/rotate", {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ token, breakGlassPublic }),
  });
  // Route the read through parseJsonOrOwnerAction so a 202
  // can NEVER be coerced into a false "applied" and a false "break-glass key present" while the posture never
  // moved. The decoder's non-2xx { error }-reason fold and its 2xx parse are byte-identical to the hand-rolled
  // reads this replaces (the error-fold characterisation still holds), so only an illegitimate 202 changes
  // behaviour: keys/rotate is NOT owner-action gated engine-side (router-keys.ts answers 200 { ok } or a 4xx
  // { error }, never a 202), so a malformed 202 throws answer-unreadable inside the decoder, and a well-formed
  // owner-action-shaped 202 would name an owner-action inbox this route never files to, so it takes the same
  // honest throw rather than a fabricated "queued".
  const res = await t.parseJsonOrOwnerAction<{ ok: true }>(r, "rotate break-glass");
  if (res.status === "queued") throw new Error(`rotate break-glass: ${r.status}`);
  return res.value;
}

// setBreakGlassOnly tightens the engine to strict break-glass-only posture: the engine removes both
// operational secrets via a one-shot scoped token, so it can no longer self-decrypt archives.
// Recovery is unaffected (every archive wraps to the break-glass recipient too). One-way: undoing it
// means generating and installing a fresh operational key.
export async function setBreakGlassOnly(t: Transport, token: string, confirmDiscardStranded = false): Promise<{ ok: true }> {
  const r = await t.gatedFetch("/admin/keys/break-glass-only", {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify(confirmDiscardStranded ? { token, confirmDiscardStranded: true } : { token }),
  });
  if (!r.ok) {
    // The engine's discard guard answers 409 with a STRUCTURED body, and that structure is the whole
    // point: it says how many archives only the key being removed can open, how many could not be
    // checked, and whether the scan was complete. Flattening it to a message string (which is what this
    // function used to do for every non-2xx) is what left the owner with a dead end: the console printed
    // a sentence and re-enabled the button, so the only sanctioned path forward did not exist in the UI.
    // A DiscardGuardRefusal is thrown instead, so the screen can show the counts and offer the
    // deliberate second confirmation the engine is waiting for.
    const guard = await readDiscardGuard(r);
    if (guard !== null) throw guard;
    const reason = await t.foldableReason(r); // NOT readErrorReason: 401/403/429/5xx must keep failResponse's marker
    if (reason !== null) throw new Error(`break-glass-only: ${reason}: ${r.status}`);
    return t.failResponse(r, "break-glass-only");
  }
  return t.parseJson<{ ok: true }>(r, "break-glass-only");
}

/** The engine's discard-guard refusal, thrown by {@link setBreakGlassOnly} on a 409 that carries
 *  `discardGuard: true`. It is an Error so existing catch paths still surface something sensible, and
 *  carries the counts so the screen can explain the refusal instead of restating it. */
export class DiscardGuardRefusal extends Error {
  readonly discardGuard = true as const;
  readonly strandedRunCount: number;
  readonly unknownRunCount: number;
  readonly truncated: boolean;
  readonly historyReadOk: boolean;
  constructor(reason: string, fields: { strandedRunCount: number; unknownRunCount: number; truncated: boolean; historyReadOk: boolean }) {
    super(reason);
    this.name = "DiscardGuardRefusal";
    this.strandedRunCount = fields.strandedRunCount;
    this.unknownRunCount = fields.unknownRunCount;
    this.truncated = fields.truncated;
    this.historyReadOk = fields.historyReadOk;
  }
}

/** isDiscardGuardRefusal narrows an unknown catch value. A predicate rather than `instanceof` alone so a
 *  refusal that crossed a module boundary (or a structured-clone) is still recognised. */
export function isDiscardGuardRefusal(e: unknown): e is DiscardGuardRefusal {
  return e instanceof DiscardGuardRefusal || (typeof e === "object" && e !== null && (e as { discardGuard?: unknown }).discardGuard === true);
}

// readDiscardGuard returns a DiscardGuardRefusal when the response is the guard's 409, else null so the
// caller falls through to its ordinary error handling. Fail-soft on a malformed body: a 409 that does
// not decode is NOT treated as a guard hit, because inventing counts would be worse than a plain error.
async function readDiscardGuard(r: Response): Promise<DiscardGuardRefusal | null> {
  if (r.status !== 409) return null;
  let body: { error?: unknown; discardGuard?: unknown; strandedRunCount?: unknown; unknownRunCount?: unknown; truncated?: unknown; historyReadOk?: unknown };
  try {
    body = (await r.clone().json()) as typeof body;
  } catch {
    return null;
  }
  if (body.discardGuard !== true) return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return new DiscardGuardRefusal(typeof body.error === "string" && body.error !== "" ? body.error : "The engine refused the switch to prevent silent data loss.", {
    strandedRunCount: num(body.strandedRunCount),
    unknownRunCount: num(body.unknownRunCount),
    // Both default to the CAUTIOUS reading when absent: a body that does not say the scan was complete
    // must not be read as "it was".
    truncated: body.truncated !== false,
    historyReadOk: body.historyReadOk === true,
  });
}

// retireBreakGlassToken disposes the bootstrap break-glass token IN-APP (no redeploy): once a real
// break-glass exists (recovery codes acknowledged, or a second Owner), an Owner can retire the static
// bootstrap token so it can never sign in again, tightening the posture without touching wrangler. It is
// OWNER-ONLY, enforced server-side. The engine REFUSES with a clear error (a non-2xx { error }) when no
// alternative break-glass exists yet (retiring the only way in would lock the account out); the console
// surfaces that reason plainly via readErrorReason so the operator learns WHY rather than seeing a bare
// status. The change takes effect immediately. No value or key transits; the token is disposed
// server-side, never returned.
//
// 202-DECODE (this pass): retiring is the GATED owner action `break-glass-retire` (engine
// scheduler-do-routing-config.ts, the POST /policy/break-glass-retired case, which wraps the retire:true
// direction in gatedOwnerAction and answers through ownerActionJson; the un-retire direction is never
// gated). With dual control armed the engine answers HTTP 202 + { ownerActionQueued:true, id, status } and
// the latch is NOT set. This used to read through plain parseJson, which throws only on a NON-2xx, so the
// queued body was cast to { retired } and the screen showed "Break-glass token retired. The static token can
// no longer sign in." while the static token still signed in. That is the worst member of this class: the
// operator is told a way in is closed, so they stop treating the bootstrap token as live, and it is live
// until a second owner approves. Reading through parseJsonOrOwnerAction gives the caller a discriminated
// { status:"queued" }. The non-2xx path is unchanged: parseJsonOrOwnerAction runs the SAME readErrorReason
// fold (throwing "<verb>: <reason>: <status>", which retireRefuseText parses) and falls through to
// failResponse when the body carries no usable reason.
export async function retireBreakGlassToken(t: Transport, change?: ChangeRef): Promise<OwnerActionResult<{ retired: boolean }>> {
  // The OPTIONAL change reference (change management) rides as the X-Downpipes-Change header when supplied
  // (retiring the break-glass token removes the way back in, a change-controlled action).
  const r = await t.gatedFetch("/admin/policy/retire-break-glass-token", { method: "POST", headers: t.headers(change), credentials: "include" }, { adminOp: "break-glass-retire" });
  return t.parseJsonOrOwnerAction<{ retired: boolean }>(r, "retire break-glass token");
}

// sendCustodyShare emails ONE Shamir share of the split break-glass wrapping key to a custodian, via the
// engine (a browser cannot send email; the engine holds the EMAIL binding). This is the ONE place the
// console POSTs any custody material: it is SAFE because the ciphertext (the envelope over identity.key)
// is NEVER part of this request, so a captured share stays useless (ciphertext separation, S1), and a
// single share below the threshold reveals nothing (Shamir). One share per call. The engine re-validates
// the address + the 33-byte share, never logs or stores either, and audits redaction-safe counts only.
// Fail-soft (never throws): email delivery is advisory, so a refusal (email-not-configured, a bad address,
// a rate limit) resolves to { sent:false, reason } the caller surfaces, rather than an exception.
export async function sendCustodyShare(t: Transport, input: CustodyShareSendInput): Promise<CustodyShareSendResult> {
  try {
    const r = await t.gatedFetch("/admin/custody/send-share", {
      method: "POST",
      headers: { ...t.headers() },
      credentials: "include",
      body: JSON.stringify({
        toEmail: input.toEmail,
        shareB64: input.shareB64,
        n: input.n,
        m: input.m,
        ...(input.custodianLabel !== undefined && input.custodianLabel !== "" ? { custodianLabel: input.custodianLabel } : {}),
      }),
    });
    if (!r.ok) {
      // A 400 (bad address/share), 403 (not authorised) or 429 (rate limited) carries the engine's coarse,
      // value-free reason; surface it so the operator learns WHY, never as a thrown transport error.
      const reason = await t.readErrorReason(r);
      return { sent: false, reason: reason ?? `send-failed-${r.status}` };
    }
    const body = (await r.json().catch(() => ({}))) as { sent?: unknown; reason?: unknown; code?: unknown };
    return {
      sent: body.sent === true,
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      ...(typeof body.code === "string" ? { code: body.code } : {}),
    };
  } catch {
    return { sent: false, reason: "network-error" };
  }
}
