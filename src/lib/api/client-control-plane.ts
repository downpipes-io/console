// Control-plane recovery domain functions for the EngineClient (free functions over the shared
// Transport, the same leaf pattern as client-recovery.ts / client-misc.ts). Two routes:
//
//   controlPlaneStatus  GET  /admin/control-plane/status   -- the recovery-required latch + reason + emptiness
//     (any authenticated role; rides the session cookie / bearer; no secret in the answer). The boot flow
//     and the security centre poll it to decide whether to raise the standing recovery banner.
//
//   controlPlaneRestore POST /admin/control-plane/restore  -- the break-glass-gated reconcile. Mirrors
//     resetDemoFresh EXACTLY: the engine gates this route on the ADMIN_TOKEN bearer DIRECTLY (not the auth
//     precedence), because after a DO wipe the role table is empty so a passkey/Access caller resolves to a
//     recovery-required VIEWER and cannot authorise it -- only the operator presenting the break-glass token
//     may. So the token is sent ONCE as a one-off Bearer header and NEVER stored. The engine verifies the
//     export's detached signature against its pinned signer and re-asserts no plaintext secret BEFORE
//     touching the DO; the console only relays the (already no-custody) export + signature the operator
//     pulled out-of-band from the destination bucket.

import { capabilityPhrase } from "../../screens/capability-copy.ts";
import { recordRecoveryRefusal } from "../client-diag/ring.ts";
import { refusalClassToCode, refusalCodeForStatus, withRefusalCode } from "../recovery-refusal-codes.ts";
import type { Transport } from "./client-transport.ts";
import { engineFetch } from "./engine-fetch.ts";
import type { ControlPlaneAcknowledgeResult, ControlPlaneApplyStagedResult, ControlPlaneReconcileResult, ControlPlaneStatus, EstateImportResult } from "./types.ts";

// controlPlaneStatus reads the recovery-required latch. It is an authenticated read (any role), so it rides
// the session cookie + the optional bearer like whoami; the answer carries three booleans + a redaction-safe
// reason, never a secret. A non-2xx / Access-redirect body is named honestly by parseJson.
export async function controlPlaneStatus(t: Transport): Promise<ControlPlaneStatus> {
  const r = await engineFetch(`${t.base}/admin/control-plane/status`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<ControlPlaneStatus>(r, "control-plane status");
}

// controlPlaneExportDownload builds + fetches the CURRENT signed control-plane export so the operator can
// save it (the JSON + its detached signature) alongside their recovery kit, so the kit's config inventory
// does not depend on later bucket access. It is an authenticated read gated engine-side on access.policy
// (owner / access-admin) and rides the session cookie + optional bearer like the status read. The answer is
// the no-custody export (secrets ride wrapped or as a reestablish marker, never plaintext) plus its detached
// signature; a non-2xx / Access-redirect body is named honestly by parseJson.
export async function controlPlaneExportDownload(t: Transport): Promise<{ export: unknown; signature: string }> {
  // A FAILED signed-export download is one of the three manual recovery refusals the pack could not see.
  // The refusal is recorded here, where the status is still a number, and parseJson then throws exactly as it
  // did before (it owns the Access-redirect / malformed-body naming, and that is unchanged).
  const r = await engineFetch(`${t.base}/admin/control-plane/export-download`, { headers: t.headers(), credentials: "include" }).catch((err: unknown) => {
    recordRecoveryRefusal("export-download", "DP-R13");
    throw err;
  });
  if (!r.ok) recordRecoveryRefusal("export-download", refusalCodeForStatus(r.status));
  return t.parseJson<{ export: unknown; signature: string }>(r, "control-plane export download");
}

// engineRefusalClass extracts the engine's CLOSED refusalClass member from a 400 body, or null.
//
// IT MUST BE GIVEN THE WHOLE BODY. It used to be handed the DISPLAY string, which is truncated to 300 characters
// for the operator's screen, and `refusalClass` is the LAST key the engine serialises -- so on any refusal whose
// prose runs past the cut (the partial-signer-rotation sentence is a 504-character body) the JSON was severed
// mid-string, the parse threw, and the class silently degraded to DP-R12: the catch-all, byte-identical to a
// plane that was not empty. A discriminator that collapses into the bucket it was built to escape is worse than
// none, because it looks closed. The display clamp now happens AFTER the class is read, and only for the screen.
//
// It returns ONE FIELD as a bare string, which refusalClassToCode then admits ONLY by SET MEMBERSHIP against the
// frozen list. Nothing else on the body is read, and the returned string is never stored, never suffixed onto a
// message and never carried into the ring: a customer value smuggled into this field cannot be a set member, so it
// maps to DP-R12 exactly as an absent field does. A body that is not JSON, or carries no refusalClass, yields null
// -- which is precisely what an OLDER ENGINE (one that does not send the field) produces, so the console keeps
// working against it.
function engineRefusalClass(bodyText: string): string | null {
  try {
    const body: unknown = JSON.parse(bodyText);
    if (body === null || typeof body !== "object") return null;
    const cls = (body as Record<string, unknown>).refusalClass;
    return typeof cls === "string" ? cls : null;
  } catch {
    return null;
  }
}

// controlPlaneRestore reconciles the wiped control plane from a signed, no-custody export the operator pulled
// out-of-band from the destination bucket. It authorises with the operator-entered ADMIN_TOKEN as a one-off
// Bearer header (the engine gates the route on the ADMIN_TOKEN bearer DIRECTLY, exactly like demo-reset, so
// it works even though the browser's own session resolves to a recovery-required viewer after a wipe); the
// token is sent once and never stored. credentials:"include" carries the Access/session cookie so the
// request passes the perimeter. The export + detached signature are forwarded verbatim; the engine verifies
// the signature against its pinned signer and re-asserts the no-custody invariant before any rebuild. It
// refuses unless the control plane AND the role table are empty (a recovery rebuilds a wiped plane; it never
// overwrites a live one). Throws a clear message on 401 (wrong token) / 400 (signature/shape/no-custody refusal).
export async function controlPlaneRestore(
  t: Transport,
  adminToken: string,
  exportArtefact: unknown,
  signature: string,
): Promise<ControlPlaneReconcileResult> {
  // An engine that cannot be reached at all is DP-R13, the same code the operator is shown for it. This leg
  // matters more here than anywhere else in the console: a reconcile runs against a WIPED engine, so "the engine
  // never answered" is a live hypothesis and there can be no engine-side record of the attempt by construction.
  const r = await engineFetch(`${t.base}/admin/control-plane/restore`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    credentials: "include",
    body: JSON.stringify({ export: exportArtefact, signature }),
  }).catch((err: unknown) => {
    recordRecoveryRefusal("cp-restore", "DP-R13");
    throw err;
  });
  if (!r.ok) {
    // The engine's own reason is CARRIED on every branch, including 401. It used to be read and then
    // dropped on the 401 branch in favour of a fixed sentence, which threw away the one thing that
    // distinguished a wrong token from a token the engine could not check at all. Every branch also
    // carries a stable refusal code the operator can read out: this flow runs on a wiped engine, where
    // the audit ring is empty and a support pack may not build, so the message is the only witness.
    const body = await r.text().catch(() => "");
    // DP-R12 WAS EVERY 400. The engine answers 400 for a bad signature, a failed shape check, a no-custody
    // refusal and a plane that was not empty alike, so three of the five states the ticket enumerates were ONE
    // code and coalesced into ONE pack row. The engine now returns a CLOSED refusalClass member in the 400 body;
    // engineRefusalClass reads it BY SET MEMBERSHIP off the WHOLE body (not the clamped display string, which
    // severs the trailing key and drops the class back to DP-R12) and refusalClassToCode maps it to a distinct
    // code. `txt` is the engine's own prose, clamped for the screen only: never classified, never carried.
    const code = r.status === 400 ? refusalClassToCode(engineRefusalClass(body)) : refusalCodeForStatus(r.status);
    const txt = body.slice(0, 300);
    recordRecoveryRefusal("cp-restore", code);
    if (r.status === 401) throw new Error(withRefusalCode(`that ADMIN_TOKEN (break-glass token) was not accepted${txt ? `: ${txt}` : ""}`, code));
    if (r.status === 400) throw new Error(withRefusalCode(`the export was refused${txt ? `: ${txt}` : " (bad signature, shape, or it carried a secret)"}`, code));
    throw new Error(withRefusalCode(`control-plane reconcile failed (${r.status})${txt ? `: ${txt}` : ""}`, code));
  }
  return t.parseJson<ControlPlaneReconcileResult>(r, "control-plane reconcile");
}

// controlPlaneRestoreSealed reconciles the wiped control plane from a SEALED export, for the sub-case
// controlPlaneRestore cannot serve: the destination bucket holds only a `.sealed.json` artefact, because sealing
// is on by default whenever a break-glass recipient is configured, and this engine has no CONFIG_RECIPIENT_PRIVATE
// with which auto-heal could have staged it. The operator has already recovered the plaintext locally with
// lib/sealed-export-unseal.ts, so what travels here is the sealed wrapper, its detached signature and the
// recovered export, and the ENGINE verifies all three again against its own pinned signer server-side. The local
// unseal is defence in depth, never the authority: nothing this method sends is trusted because the browser
// checked it.
//
// THREE CREDENTIALS, and they are genuinely three. The ADMIN_TOKEN break-glass token authorises the route (its
// requireLiveBreakGlassToken gate; the DO's role table is empty post-wipe, so the browser's own session resolves
// to a recovery-required viewer and cannot authorise this), the identity.key opens the capsule, and the
// recovery kit's signer.pub verifies the wrapper. Only the first travels, once, as a one-off Bearer header, and
// it is never stored. credentials:"include" carries the Access/session cookie so the request passes the perimeter.
//
// The 400 branch admits two classes the plaintext route can never answer, `sealed-unhashed` and
// `sealed-body-mismatch` (DP-R29/DP-R30). They are reachable here and nowhere else: on the estate-import path the
// browser's own unseal always reaches the fault first, whereas here the engine opens the artefact itself, so a
// bypassed or raced local pre-check leaves the engine entitled to answer either.
export async function controlPlaneRestoreSealed(
  t: Transport,
  adminToken: string,
  sealed: unknown,
  sealedSignature: string,
  exportArtefact: unknown,
): Promise<ControlPlaneReconcileResult> {
  // Unreachable engine is DP-R13, as on controlPlaneRestore, and for the same reason: this runs against a WIPED
  // engine, so "the engine never answered" is a live hypothesis and no engine-side record of the attempt can exist.
  const r = await engineFetch(`${t.base}/admin/control-plane/restore-sealed`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    credentials: "include",
    body: JSON.stringify({ sealed, sealedSignature, export: exportArtefact }),
  }).catch((err: unknown) => {
    recordRecoveryRefusal("cp-restore-sealed", "DP-R13");
    throw err;
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    const code = r.status === 400 ? refusalClassToCode(engineRefusalClass(body)) : refusalCodeForStatus(r.status);
    const txt = body.slice(0, 300);
    recordRecoveryRefusal("cp-restore-sealed", code);
    if (r.status === 401) throw new Error(withRefusalCode(`that ADMIN_TOKEN (break-glass token) was not accepted${txt ? `: ${txt}` : ""}`, code));
    if (r.status === 400) throw new Error(withRefusalCode(`the sealed export was refused${txt ? `: ${txt}` : " (bad signature, shape, or it carried a secret)"}`, code));
    throw new Error(withRefusalCode(`sealed control-plane reconcile failed (${r.status})${txt ? `: ${txt}` : ""}`, code));
  }
  return t.parseJson<ControlPlaneReconcileResult>(r, "sealed control-plane reconcile");
}

// controlPlaneApplyStaged confirms an AUTO-HEAL-staged recovery: the cron auto-heal has already
// verified a sealed recovery export's signature, unsealed it with this engine's own CONFIG_RECIPIENT_PRIVATE
// (engine/src/cron/control-plane-pass.ts unsealAndResignForAutoHeal) and resumed backups from it, all without
// any pasted export. This route restores ONLY the authority slice (RBAC, the silence-killer latch, the
// bootstrap re-arm, the audit bridge) from that already-staged, already-verified record. It authorises with
// the operator-entered ADMIN_TOKEN as a one-off Bearer header, exactly like controlPlaneRestore (the DO's role
// table is empty post-wipe, so the browser's own session resolves to a recovery-required viewer and cannot
// authorise this); the token is sent once and never stored. No export, no signature and no signer.pub travel
// on this call: the artefact was already verified when it was staged, so this is a human confirmation, not a
// second verification. Throws a clear message on 401 (wrong token) / 400 (nothing staged, or a malformed
// staged record) / 403 (the role table was not empty, refusing to overwrite existing authority).
export async function controlPlaneApplyStaged(t: Transport, adminToken: string): Promise<ControlPlaneApplyStagedResult> {
  const r = await engineFetch(`${t.base}/admin/control-plane/apply-staged`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
    credentials: "include",
  }).catch((err: unknown) => {
    recordRecoveryRefusal("cp-restore", "DP-R13");
    throw err;
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    const code = r.status === 400 ? refusalClassToCode(engineRefusalClass(body)) : refusalCodeForStatus(r.status);
    const txt = body.slice(0, 300);
    recordRecoveryRefusal("cp-restore", code);
    if (r.status === 401) throw new Error(withRefusalCode(`that ADMIN_TOKEN (break-glass token) was not accepted${txt ? `: ${txt}` : ""}`, code));
    if (r.status === 403) throw new Error(withRefusalCode(`only the break-glass token can confirm a staged recovery${txt ? `: ${txt}` : ""}`, code));
    if (r.status === 400) throw new Error(withRefusalCode(`the staged recovery could not be confirmed${txt ? `: ${txt}` : " (nothing is staged, or the staged record is malformed)"}`, code));
    throw new Error(withRefusalCode(`confirming the staged recovery failed (${r.status})${txt ? `: ${txt}` : ""}`, code));
  }
  return t.parseJson<ControlPlaneApplyStagedResult>(r, "control-plane apply-staged");
}

// controlPlaneImport is the CROSS-ENVIRONMENT estate import: a bootstrapped Owner on a fresh engine re-imports
// a lost estate's DEFINITION from a signed export, verified engine-side against the operator-supplied recovery
// -kit signer.pub (tamper-evidence, never an authority root). Unlike controlPlaneRestore it rides the OWNER
// SESSION (the engine gates the route on access.policy, not the break-glass token), so it sends no bearer --
// credentials:"include" carries the session / Access cookie. The export, its detached signature and the
// signer.pub are forwarded verbatim; the engine verifies, GRANTS NO AUTHORITY, and disables the imported
// downpipes on a cross-account import. Throws a clear message on 403 (not an Owner) / 400 (verify/shape/no-custody).
export async function controlPlaneImport(
  t: Transport,
  exportArtefact: unknown,
  signature: string,
  signerPublic: string,
): Promise<EstateImportResult> {
  const r = await engineFetch(`${t.base}/admin/control-plane/import`, {
    method: "POST",
    headers: { "content-type": "application/json", ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ export: exportArtefact, signature, signerPublic }),
  }).catch((err: unknown) => {
    recordRecoveryRefusal("estate-import", "DP-R13");
    throw err;
  });
  if (!r.ok) {
    // As above: the engine's reason rides on the 403 branch too (it names WHICH gate refused, and a
    // non-Owner refusal and a policy refusal are different tickets), and every branch carries its stable
    // refusal code.
    const body = await r.text().catch(() => "");
    // Same split as the reconcile above, and the same rule: the class is read off the WHOLE body and
    // the prose is clamped only for the screen. Same code, different op: a signature refusal on an import (a wrong
    // signer.pub) and one on a reconcile (this engine's own signer key) are different tickets, and recoveryOp is
    // in the ring's tuple key, so they cannot coalesce.
    const code = r.status === 400 ? refusalClassToCode(engineRefusalClass(body)) : refusalCodeForStatus(r.status);
    const txt = body.slice(0, 300);
    recordRecoveryRefusal("estate-import", code);
    if (r.status === 403) throw new Error(withRefusalCode(`only an Owner can import an estate${txt ? `: ${txt}` : ""}`, code));
    if (r.status === 400) throw new Error(withRefusalCode(`the import was refused${txt ? `: ${txt}` : " (wrong signer.pub, bad signature, shape, or it carried a secret)"}`, code));
    throw new Error(withRefusalCode(`estate import failed (${r.status})${txt ? `: ${txt}` : ""}`, code));
  }
  return t.parseJson<EstateImportResult>(r, "estate import");
}

// controlPlaneImportSealed is controlPlaneImport's browser-unseal counterpart: the console has
// ALREADY verified the SEALED artefact's signature and unsealed its body entirely in the browser
// (lib/sealed-export-unseal.ts -- the private break-glass identity never reaches this function or anything it
// calls). It forwards the ORIGINAL sealed artefact + its own detached signature (so the engine can
// independently re-verify BOTH the signature and, via bodyHash, that the plaintext below is genuinely what
// that signature covers) alongside the recovered plaintext export, to POST /control-plane/import-sealed. Rides
// the OWNER SESSION exactly like controlPlaneImport (access.policy, not the break-glass token); grants no
// authority; disables the imported downpipes on a cross-account import. Throws a clear message on 403 (not an
// Owner) / 400 (sealed-signature / bodyHash-mismatch / shape / no-custody refusal).
export async function controlPlaneImportSealed(
  t: Transport,
  sealed: unknown,
  sealedSignature: string,
  signerPublic: string,
  exportArtefact: unknown,
): Promise<EstateImportResult> {
  const r = await engineFetch(`${t.base}/admin/control-plane/import-sealed`, {
    method: "POST",
    headers: { "content-type": "application/json", ...t.headers() },
    credentials: "include",
    body: JSON.stringify({ sealed, sealedSignature, signerPublic, export: exportArtefact }),
  }).catch((err: unknown) => {
    recordRecoveryRefusal("estate-import-sealed", "DP-R13");
    throw err;
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    const code = r.status === 400 ? refusalClassToCode(engineRefusalClass(body)) : refusalCodeForStatus(r.status);
    const txt = body.slice(0, 300);
    recordRecoveryRefusal("estate-import-sealed", code);
    if (r.status === 403) throw new Error(withRefusalCode(`only an Owner can import an estate${txt ? `: ${txt}` : ""}`, code));
    if (r.status === 400) throw new Error(withRefusalCode(`the sealed import was refused${txt ? `: ${txt}` : " (wrong signer.pub, bad sealed signature, shape, no-custody, or the plaintext did not match what was signed)"}`, code));
    throw new Error(withRefusalCode(`sealed estate import failed (${r.status})${txt ? `: ${txt}` : ""}`, code));
  }
  return t.parseJson<EstateImportResult>(r, "sealed estate import");
}

// controlPlaneAcknowledgeRecovery clears the recovery-required latch and does NOTHING ELSE. It is
// the one exit an ESTABLISHED account has, and until this function existed the console could not reach it:
// enumerating the control-plane routes named anywhere in console/src returned nine, and no acknowledge, while
// the engine had served the route. The two affordances the banner did offer both rebuild a
// wiped plane and so refuse a non-empty role table, and the last-Owner guard makes a non-empty role table the
// norm, so every affordance on the banner was one the engine had to refuse.
//
// UNLIKE EVERY OTHER FUNCTION IN THIS FILE, IT SENDS NO ADMIN_TOKEN AND NO ARTEFACT. It rides the operator's
// own session (the engine gates access.policy and refuses the bare break-glass token BY NAME on this route),
// because the estate it serves has a live role table: whoami does not degrade a caller over a non-empty role
// table, so there is a real owner signed in to ask. Nothing is imported, no role is restored and
// bootstrapConsumed is never touched, which is why the result carries no counts to report.
export async function controlPlaneAcknowledgeRecovery(t: Transport): Promise<ControlPlaneAcknowledgeResult> {
  const r = await engineFetch(`${t.base}/admin/control-plane/acknowledge-recovery`, {
    method: "POST",
    headers: t.headers(),
    credentials: "include",
  }).catch((err: unknown) => {
    recordRecoveryRefusal("cp-acknowledge", "DP-R13");
    throw err;
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    // The 403 is its OWN code rather than DP-R11 ("the caller is not an Owner"), which is wrong in both
    // directions here: an Access admin may acknowledge, and the break-glass token, which holds owner
    // everywhere else in this file, is refused on this route alone. The sentence names the capability
    // through capabilityPhrase and the role by its DISPLAY LABEL, per a raw capability id or a raw
    // built-in role id in customer copy is a string only this repo can read.
    const code = r.status === 403 ? "DP-R33" : r.status === 400 ? refusalClassToCode(engineRefusalClass(body)) : refusalCodeForStatus(r.status);
    const txt = body.slice(0, 300);
    recordRecoveryRefusal("cp-acknowledge", code);
    if (r.status === 403) throw new Error(withRefusalCode(`this sign-in cannot acknowledge a recovery: it needs ${capabilityPhrase("access.policy")}, which the Owner and Access admin roles hold, and it can never be the break-glass token${txt ? `: ${txt}` : ""}`, code));
    if (r.status === 400) throw new Error(withRefusalCode(`the recovery could not be acknowledged${txt ? `: ${txt}` : ""}`, code));
    throw new Error(withRefusalCode(`acknowledging the recovery failed (${r.status})${txt ? `: ${txt}` : ""}`, code));
  }
  return t.parseJson<ControlPlaneAcknowledgeResult>(r, "control-plane acknowledge-recovery");
}
