// Safe-apply engine-update domain functions for the EngineClient. Free functions over the shared
// Transport.
//
// design/SAFE-APPLY-UPDATE.md: the console drives the engine's own brick-safe self-update: read status,
// preview (dry-run) or apply (promote), then settle (canary-gate -> keep or auto-rollback). The deploy
// token is one-shot and held ONLY in browser memory for the apply -> settle pair; api.ts never persists it
// (no storage write here) and never carries it to the vendor, it rides in the request body to the
// in-account engine and is gone.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type {
  PromoteResult,
  RampResult,
  RampSettleResult,
  SettleResult,
  StandaloneRollbackResult,
  UpdateApplyResult,
  UpdateComponentId,
  UpdateStatus,
  UpdateStatusRecord,
} from "./types.ts";

// updateStatus reads the safe-apply lifecycle: any pending (promoted-but-not-settled) update and the last
// completed outcome. Any authenticated role may read it (it is redaction-safe, version ids + an outcome,
// never the token); the owner gate is on apply/settle, server-side. A non-2xx is a transport/auth fault
// parseJson names honestly (an Access-redirect body included).
export async function updateStatus(t: Transport): Promise<UpdateStatusRecord> {
  const r = await engineFetch(`${t.base}/admin/update/status`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<UpdateStatusRecord>(r, "update status");
}

// applyUpdate is phase 1: verify + plan (dryRun) or verify + promote (dryRun:false). dryRun DEFAULTS TRUE
// server-side, but the console ALWAYS passes it explicitly so a missing flag can never become a live deploy
// by omission. The token is supplied ONLY for a live apply (dryRun:false) and is the one-shot Cloudflare
// "Edit Cloudflare Workers" token, held in memory and never stored; a dry-run carries no token at all
// (exactOptionalPropertyTypes: token is added to the body only when present). allowDowngrade is the EXPLICIT
// opt-in to apply a NON-newer version (downgrade-to-recover); DEFAULT off (added only when true) so a signed
// older channel can never drive a silent downgrade.
//
// `components` (multi-component updates, ADDITIVE) names which release components this apply addresses
// (["engine"], ["console"], or both); OMITTED entirely when unset or empty, which is the legacy engine-only
// apply every deployed engine understands. The console only ever sends it after the engine advertised
// component awareness (UpdateStatus.components present), so an old engine never sees an unknown field from
// a component-aware flow.
//
// The result is a DISCRIMINATED UpdateApplyResult: a normal 2xx is the engine's structured PromoteResult
// ({ status:"result" }), it never 500s on an in-flow refusal (that is outcome:"refused" with a reason). A
// migration/breaking LIVE apply with DUAL CONTROL ON returns HTTP 202 with the OWNER-ACTION body on the first
// (tokenless) call: we surface it as { status:"queued", id } so the control says "queued for a second owner's
// approval" rather than misreading it as a deploy. A non-2xx is a transport/auth fault OR a gate refusal
// carrying a plain { error } reason, FOLDED into the throw exactly as setLicence/setDestination do. No value
// or key is in any payload (the engine's reason is coarse; the token is never echoed back).
export async function applyUpdate(
  t: Transport,
  opts: { token?: string; dryRun: boolean; allowDowngrade?: boolean; components?: UpdateComponentId[] },
): Promise<UpdateApplyResult<PromoteResult>> {
  const body: { dryRun: boolean; token?: string; allowDowngrade?: boolean; components?: UpdateComponentId[] } = {
    dryRun: opts.dryRun,
    ...(opts.token !== undefined && opts.token !== "" ? { token: opts.token } : {}),
    ...(opts.allowDowngrade === true ? { allowDowngrade: true } : {}),
    ...(opts.components !== undefined && opts.components.length > 0 ? { components: opts.components } : {}),
  };
  // A REAL apply is a privileged write whose pre-flow refusal reaches no engine record at all. A DRY-RUN
  // apply is the plan preview, so it names no op: a refused plan read is not an apply the operator lost.
  const r = await engineFetch(
    `${t.base}/admin/update/apply`,
    {
      method: "POST",
      headers: { ...t.headers() },
      credentials: "include",
      body: JSON.stringify(body),
    },
    opts.dryRun ? {} : { adminOp: "update-apply" },
  );
  // The 202 owner-action decode, the non-2xx { error } fold and the 2xx structured parse are precisely the
  // shared parseJsonOrOwnerAction decoder's job, so this routes through it rather than reimplementing that
  // branch inline. Keeping the decode in ONE place is what carries the malformed-202 honest-throw
  // (client-transport.ts) here too: a 202 whose body is NOT the OwnerActionQueued shape now throws the honest
  // answer-unreadable error instead of falling through to the structured parse and coercing a malformed-but-
  // valid body (even a bare `{}`) into a false "deployed" -- at the highest stakes, a live apply. The only
  // shape difference is the queued discriminant (parseJsonOrOwnerAction carries the full OwnerActionQueued
  // body, applyUpdate surfaces just its id), so map queued -> { id } and pass the structured result through
  // unchanged. Every throw (the error fold, failResponse, the malformed-202) propagates as before.
  const res = await t.parseJsonOrOwnerAction<PromoteResult>(r, "apply update");
  return res.status === "queued" ? { status: "queued", id: res.queued.id } : res;
}

// rampUpdate is the OPT-IN gradual rollout (POST /admin/update/ramp): upload + ramp `percentage`% of LIVE
// traffic to the new version, canary-gate it, and hold-at-% (awaiting a promote-to-100% via the normal apply)
// or auto-roll-back. A ramp serves REAL production traffic (not an isolated sandbox, isolated previews would
// need *.workers.dev, which is banned), so the control states that caveat plainly. The token is REQUIRED (a
// ramp deploys), one-shot, never stored. Same migration/compat/dual-control guards as the atomic apply: a
// migration/breaking ramp returns the owner-action 202 on the first call ({ status:"queued" }). allowDowngrade
// is the explicit downgrade-to-recover opt-in (default off). Returns the discriminated UpdateApplyResult.
export async function rampUpdate(t: Transport, opts: { token: string; percentage: number; allowDowngrade?: boolean }): Promise<UpdateApplyResult<RampResult>> {
  const body: { token: string; percentage: number; allowDowngrade?: boolean } = {
    token: opts.token,
    percentage: opts.percentage,
    ...(opts.allowDowngrade === true ? { allowDowngrade: true } : {}),
  };
  const r = await engineFetch(
    `${t.base}/admin/update/ramp`,
    {
      method: "POST",
      headers: { ...t.headers() },
      credentials: "include",
      body: JSON.stringify(body),
    },
    { adminOp: "update-ramp" },
  );
  // Same as applyUpdate: route the 202-queued decode, the non-2xx { error } fold and the structured
  // parse through the shared parseJsonOrOwnerAction decoder so the malformed-202 honest-throw lives once,
  // never reimplemented inline. A ramp is a LIVE production traffic shift, so a malformed 202 read as a false
  // "ramping" would be as consequential as the apply case. Map the queued discriminant to { id }; pass the
  // structured result through unchanged.
  const res = await t.parseJsonOrOwnerAction<RampResult>(r, "ramp update");
  return res.status === "queued" ? { status: "queued", id: res.queued.id } : res;
}

// rollbackUpdate is the STANDALONE one-click revert (POST /admin/update/rollback, W4): revert to the recorded
// known-good version, independent of any in-flight apply. It is the SAFE recovery direction, so the engine
// never gates it behind a second owner (no 202 here), it requires only the one-shot deploy token (so it can
// re-deploy the prior version) and is the control surfaced URGENTLY when status.rollbackNeeded is set (the
// hourly canary found a live-but-unverified bad version). `components` (ADDITIVE, mirrors applyUpdate's field)
// names which component to revert (e.g. ["console"] after a failed console build check); omitted = the legacy
// engine rollback every deployed engine understands, and it is only ever sent to a component-aware engine.
// The engine returns a structured StandaloneRollbackResult on a 2xx (it never 500s, a no-target/already/failed
// is a structured outcome with a reason); a non-2xx folds its { error } reason into the throw as above. The
// token is never stored or echoed back.
export async function rollbackUpdate(t: Transport, token: string, components?: UpdateComponentId[]): Promise<StandaloneRollbackResult> {
  // The rollback is what fixes "rollback keeps failing while a known-bad version is live". Its APPLIED
  // outcome is recorded too, so one that did go through is not silence.
  const r = await engineFetch(
    `${t.base}/admin/update/rollback`,
    {
      method: "POST",
      headers: { ...t.headers() },
      credentials: "include",
      body: JSON.stringify({ token, ...(components !== undefined && components.length > 0 ? { components } : {}) }),
    },
    { adminOp: "update-rollback" },
  );
  if (!r.ok) {
    const reason = await t.foldableReason(r); // NOT readErrorReason: 401/403/429/5xx must keep failResponse's marker
    if (reason !== null) throw new Error(`roll back update: ${reason}: ${r.status}`);
    return t.failResponse(r, "roll back update");
  }
  return t.parseJson<StandaloneRollbackResult>(r, "roll back update");
}

// rollbackPlan (0.1.5 UX design s6/s7, ADDITIVE) reads what a STANDALONE ENGINE rollback would do WITHOUT
// spending the one-shot deploy token: the console's paired-rollback confirm (design s6) needs to know, BEFORE
// the token is pasted, whether rolling the engine back would violate the live console's persisted
// minEngineVersion floor (a paired rollback then also reverts the console, so the operator should not be
// surprised by it after the fact). It mirrors applyUpdate's own dryRun seam (a plan read with the token
// omitted) rather than a new route: the SAME POST /admin/update/rollback body, `dryRun: true`, no token.
//
// BEST-EFFORT BY DESIGN: an engine that predates this read (dryRun unrecognised on this route) answers its
// ordinary token-required refusal, which throws exactly like any other refusal here. Every caller of this
// function treats ANY throw as "no plan available" and proceeds with the plain (unpaired) confirm, so an
// older engine degrades to the pre-0.1.5 rollback experience, never a blocker and never a surfaced error.
export async function rollbackPlan(t: Transport, components?: UpdateComponentId[]): Promise<StandaloneRollbackResult> {
  const r = await engineFetch(`${t.base}/admin/update/rollback`, {
    method: "POST",
    headers: { ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ dryRun: true, ...(components !== undefined && components.length > 0 ? { components } : {}) }),
  });
  if (!r.ok) {
    const reason = await t.foldableReason(r); // NOT readErrorReason: 401/403/429/5xx must keep failResponse's marker
    if (reason !== null) throw new Error(`read rollback plan: ${reason}: ${r.status}`);
    return t.failResponse(r, "read rollback plan");
  }
  return t.parseJson<StandaloneRollbackResult>(r, "read rollback plan");
}

// settleUpdate is phase 2: the console calls it right after a "promoted" apply, hitting the NOW-LIVE new
// version with the SAME one-shot token (held in memory only, never persisted), to fly the canary on the new
// code and KEEP it ("applied") or AUTO-ROLL-BACK ("rolled-back"). The token is required here (the engine
// re-deploys the prior version on a rollback, which itself needs the deploy token). It is ALSO the call the
// "verify now / roll back" affordance uses to finish a pending (promoted-but-not-settled) update after the
// token is re-collected. The ENGINE settle is UNCHANGED by multi-component updates; `components` (ADDITIVE,
// mirrors applyUpdate's field) exists so a console-component pending verification can be settled on the same
// route by a component-aware engine, and is only ever sent to one. The engine returns a structured
// SettleResult on a 2xx (it never 500s, a failed verdict is outcome:"rolled-back" with a reason); a non-2xx
// folds its { error } reason into the throw, as above. No value or key is in the payload; the token is never
// echoed back.
//
// 202-DECODE (this pass): the KEEP direction of a settle is the GATED owner action `update-settle` (engine
// router-updates.ts: when the canary's verdict is keep AND the pending release is migration/breaking-class,
// the handler calls ownerActionGate and answers ownerActionQueuedResponse, HTTP 202 +
// { ownerActionQueued:true, id, status }, WITHOUT settling; a ROLLBACK verdict is the safe direction and is
// never gated). This used to read through plain parseJson, which throws only on a NON-2xx, so the queued body
// was cast to a SettleResult with no `outcome` field. settleWithBudget's ladder treats a non-definitive
// outcome as "not yet" and RETRIES, so a queued settle burnt the whole retry budget re-submitting, then fell
// through to the persisted-record recovery and told the operator the settle outcome could not be read. The
// engine had in fact accepted the settle and was waiting on a second owner. Reading through
// parseJsonOrOwnerAction (the decoder applyUpdate and rampUpdate already use for the same gate on the same
// surface) gives a discriminated { status:"queued" } the flow can surface instead of retrying it. The queued
// discriminant is mapped to its id, matching applyUpdate/rampUpdate's UpdateApplyResult shape; the gate-off
// path is { status:"result", value } and is byte-unchanged. Every throw (the error fold, failResponse, the
// malformed-202 honest throw) propagates as before, because parseJsonOrOwnerAction runs the SAME
// readErrorReason fold on a non-2xx that the hand-rolled block did.
export async function settleUpdate(t: Transport, token: string, components?: UpdateComponentId[]): Promise<UpdateApplyResult<SettleResult>> {
  const r = await engineFetch(
    `${t.base}/admin/update/settle`,
    {
      method: "POST",
      headers: { ...t.headers() },
      credentials: "include",
      body: JSON.stringify({ token, ...(components !== undefined && components.length > 0 ? { components } : {}) }),
    },
    { adminOp: "update-settle" },
  );
  const res = await t.parseJsonOrOwnerAction<SettleResult>(r, "settle update");
  return res.status === "queued" ? { status: "queued", id: res.queued.id } : res;
}

// settleRampUpdate is the RAMP's phase 2 (POST /admin/update/ramp/settle, asvs-HI-13), and it is the control
// a ramped update had NO WAY to reach. The engine has had this route since asvs-HI-13 and no console client
// ever called it: every pending, ramp-shaped or not, was sent to settleUpdate above, and the engine's plain
// settle REFUSES a ramp-shaped pending ("this pending verification is a gradual ramp; use the ramp settle call
// instead"). A customer who started a gradual ramp therefore had no control that could ever finish it, and
// customers never run a terminal. The pending card now routes on the pending's OWN shape (a recorded
// `percentage` means a ramp), so a ramped pending settles here and a plain one settles there.
//
// SETTLED THE WAY THE ENGINE EXPECTS. The engine's handleRampSettle reads exactly ONE field from the body,
// `token`, and it is REQUIRED: a ramp settle can DEPLOY (its rollback re-deploys the prior version at 100%),
// so the one-shot Cloudflare "Edit Cloudflare Workers" token is collected again, rides in the request body to
// the in-account engine, and is never stored, never persisted and never echoed back -- the same one-shot
// posture as apply/settle/rollback. `components` is deliberately NOT sent: a gradual ramp is ENGINE-ONLY,
// forever (a static-assets console swap is atomic at promote and has no traffic-percentage concept, and the
// ramp START route refuses a request naming the console outright), so there is no split for this route to
// carry and the engine's ramp settle does not read one.
//
// It is NOT gated behind a second owner (no 202 here): the dual-control gate fired at ramp START, on the
// consequential direction (shipping new engine code). Settling is what finishes it, and rollback is always
// the safe direction.
//
// The admin-op recorded for the client-diagnostics ring is `update-settle`, shared with the plain settle
// deliberately: the ring names the PRIVILEGED WRITE the operator made ("finish verifying a promoted update"),
// and that is the same operator action on both routes. WHICH route ran is the engine's own fact and it records
// it (its route-error rows carry `ramp-settle`, and only this route produces `update-settle-inconclusive`).
//
// A non-2xx folds its { error } reason into the throw exactly as settleUpdate does. Note that "inconclusive"
// is a 200, NOT an error: it means this dispatch did not land on the ramped slice, nothing was changed, and
// the pending stays armed for a retry.
export async function settleRampUpdate(t: Transport, token: string): Promise<RampSettleResult> {
  const r = await engineFetch(
    `${t.base}/admin/update/ramp/settle`,
    {
      method: "POST",
      headers: { ...t.headers() },
      credentials: "include",
      body: JSON.stringify({ token }),
    },
    { adminOp: "update-settle" },
  );
  if (!r.ok) {
    const reason = await t.foldableReason(r); // NOT readErrorReason: 401/403/429/5xx must keep failResponse's marker
    if (reason !== null) throw new Error(`settle gradual ramp: ${reason}: ${r.status}`);
    return t.failResponse(r, "settle gradual ramp");
  }
  return t.parseJson<RampSettleResult>(r, "settle gradual ramp");
}

export async function updates(t: Transport): Promise<UpdateStatus> {
  const r = await engineFetch(`${t.base}/admin/updates`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<UpdateStatus>(r, "updates");
}
