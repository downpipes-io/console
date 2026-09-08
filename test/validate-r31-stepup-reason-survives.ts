// client-attest.ts's createAttestSession (and every sibling that shares the same
// shape) read a non-2xx body's `error` reason UNCONDITIONALLY, before gating on status. The engine's
// step-up 401 (requireStepUp, engine/src/admin/router-core.ts) answers a WELL-FORMED, non-empty reason --
// { error: "step-up required", stepUpRequired: true } -- so readErrorReason returned it first, and the
// caller threw "<verb>: step-up required: <status>". That message does not contain STEPUP_REQUIRED_MARKER
// ("stepup-required": no hyphen after "step"), so classifyError never matched it, fell through to the bare
// 401 branch, and isUnauthorised(err) read true. A step-up gap -- the operator IS authenticated and needs
// to prove presence for one sensitive action -- was misread as a lapsed session, and the caller's Start
// action (restore-flow/attend.ts) called goSignedOut(), discarding a valid session at the exact moment the
// operator was doing something that mattered. `restore-flow/attend.ts` could never render "Verify your
// identity" through this path.
//
// THE FIX is in the ONE place every affected caller shares: Transport.readErrorReason
// (src/lib/api/client-transport.ts). It now returns null for a 401 whose body carries
// stepUpRequired:true, BEFORE reading `error`, so every caller's existing "read reason; if present throw
// it; else fall through to failResponse()" shape lands on failResponse's own correct shape gate
// (detectStepUpRequiredBody), which folds STEPUP_REQUIRED_MARKER into the throw. One fix, not N patches.
//
// Run with: node test/validate-r31-stepup-reason-survives.ts
//
// Coverage, in order:
//   1. UNIT: Transport.readErrorReason itself -- the step-up 401 returns null; the untouched siblings
//      (403 dual-control reason, plain 400 validation reason) are unaffected (no regression).
//   2. SWEEP: every LIVE call site (a route in the engine's STEPUP_SUBS AND reached through the
//      reason-before-status shape) -- the marker now survives, driven through the REAL EngineClient
//      method over a scripted global fetch, exactly as validate-stepup-dest-idp.ts drives its coverage.
//   3. LATENT: call sites with the identical shape whose route is NOT (yet) in STEPUP_SUBS -- the pattern
//      is fixed too (defence in depth for when the engine gate is extended), proven the same way.
//   4. NEGATIVE CONTROL: siblings already correctly gated (parseJsonOrPending / parseJsonOrReason / plain
//      parseJson-only reads) are unaffected, with the file:line citation for each.
//   5. END-TO-END: restore-flow/attend.ts's REAL Start action, on a step-up 401 with no ceremony wired,
//      renders "Verify your identity" and does NOT call goSignedOut() -- the exact live reproduction.

import { installDomShim, qs, flushAsync, textOf, type ShimNode } from "./dom-shim.ts";
installDomShim();

// A minimal FileReader/File/MutationObserver shim so the identity.key file input works under the DOM
// shim, matching test/validate-r28-attest-session-degrade.ts and test/validate-attend-from-shares.ts.
// Installed at module scope, BEFORE any screen is rendered (renderAttendRunner reads MutationObserver at
// render time, not lazily).
class ShimFile {
  _text: string;
  name: string;
  type = "text/plain";
  constructor(text: string, name: string) {
    this._text = text;
    this.name = name;
  }
}
class ShimFileReader {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: string | null = null;
  readAsText(file: ShimFile): void {
    this.result = file._text;
    setTimeout(() => this.onload?.(), 0);
  }
}
{
  const g = globalThis as unknown as Record<string, unknown>;
  g.FileReader = ShimFileReader;
  g.File = ShimFile;
  if (g.MutationObserver === undefined) {
    g.MutationObserver = class {
      observe(): void {}
      disconnect(): void {}
    };
  }
}

const { EngineClient } = await import("../src/api.ts");
const { Transport } = await import("../src/lib/api/client-transport.ts");
const { classifyError, isStepUpRequired, isUnauthorised, STEPUP_REQUIRED_MARKER, RESTORE_UNAPPROVED_REASON } = await import("../src/lib/errors.ts");
const { renderAttendRunner } = await import("../src/screens/restore-flow/attend.ts");
const nav = await import("../src/lib/nav.ts");
const store = await import("../src/lib/store.ts");

import type { Caller } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// The exact wire shape the engine's requireStepUp sends (engine/src/admin/router-core.ts:394): a
// well-formed, non-empty `error` string ALONGSIDE stepUpRequired:true. This is what makes the defect
// possible -- a body with no usable `error` would already have returned null from readErrorReason.
const STEPUP_401_BODY = { error: "step-up required", stepUpRequired: true };

// ===========================================================================================
// SECTION 1 -- UNIT: Transport.readErrorReason itself.
// ===========================================================================================
async function testReadErrorReasonUnit(): Promise<void> {
  console.log("\n-- UNIT: Transport.readErrorReason (client-transport.ts) --");
  const t = new Transport("https://engine.test");
  const respond = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  {
    const reason = await t.readErrorReason(respond(STEPUP_401_BODY, 401));
    ok("a 401 { stepUpRequired:true, error:'step-up required' } reads as null (was: 'step-up required')", reason === null);
  }
  {
    // NEGATIVE CONTROL: a 401 with an ordinary lapsed-session body (no stepUpRequired field) is
    // untouched -- the engine's real ordinary 401 is plain text ("unauthorised"), which already fails
    // JSON.parse and returns null; this proves the JSON case is ALSO untouched when stepUpRequired
    // is absent or false, not merely coincidentally correct via the parse failure.
    const reason = await t.readErrorReason(respond({ error: "not authorised" }, 401));
    ok("regression: a 401 WITHOUT stepUpRequired still reads its reason (unaffected)", reason === "not authorised");
  }
  {
    const reason = await t.readErrorReason(respond({ error: "step-up required", stepUpRequired: false }, 401));
    ok("regression: stepUpRequired:false does not trip the new gate", reason === "step-up required");
  }
  {
    // The dual-control 403 this method exists for (restore not approved) must be unaffected: the gate
    // is scoped to status 401 only.
    const reason = await t.readErrorReason(respond({ error: "restore not approved" }, 403));
    ok("regression: the 403 dual-control reason is unaffected (status-scoped gate)", reason === RESTORE_UNAPPROVED_REASON);
  }
  {
    // A plain 400 validation reason (the common case parseJsonOrPending/parseJsonOrReason exist for)
    // is unaffected.
    const reason = await t.readErrorReason(respond({ error: "inventory too large" }, 400));
    ok("regression: a plain 400 validation reason is unaffected", reason === "inventory too large");
  }
}

// ===========================================================================================
// SECTION 2/3 -- SWEEP: drive the REAL EngineClient method over a scripted fetch answering the
// step-up 401 exactly once (no retry: onStepUpRequired is left unwired, matching a ceremony that is
// unavailable/cancelled -- gatedFetch's own documented fallback -- and matching every non-gatedFetch
// route, which never attempts one). Asserts the thrown message carries STEPUP_REQUIRED_MARKER and
// classifies as stepup-required, never unauthorised.
// ===========================================================================================
function scriptFetchOnce(body: unknown, status: number): { calls: number; restore: () => void } {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.fetch;
  const state = { calls: 0 };
  g.fetch = async () => {
    state.calls++;
    return {
      ok: false,
      status,
      async text() { return JSON.stringify(body); },
      async json() { return body; },
      clone() { return this; },
    };
  };
  return { calls: state.calls, restore: () => { g.fetch = prev; } };
}

interface Site { name: string; live: boolean; citation: string; invoke: (e: InstanceType<Awaited<typeof EngineClient>>) => Promise<unknown>; }

async function expectMarkerSurvives(site: Site): Promise<void> {
  const engine = new EngineClient("https://engine.test");
  const scripted = scriptFetchOnce(STEPUP_401_BODY, 401);
  let caught: unknown = null;
  try {
    await site.invoke(engine as never);
  } catch (err) {
    caught = err;
  } finally {
    scripted.restore();
  }
  const tag = site.live ? "LIVE (in engine STEPUP_SUBS)" : "LATENT (route not yet step-up gated)";
  ok(`${site.name} [${tag}, ${site.citation}]: threw an Error`, caught instanceof Error);
  const msg = caught instanceof Error ? caught.message : "";
  ok(`${site.name}: the thrown message carries STEPUP_REQUIRED_MARKER`, msg.includes(STEPUP_REQUIRED_MARKER));
  ok(`${site.name}: classifyError -> stepup-required`, classifyError(caught).kind === "stepup-required");
  ok(`${site.name}: isStepUpRequired(err) is true`, isStepUpRequired(caught));
  ok(`${site.name}: isUnauthorised(err) is FALSE (the sign-out defect)`, !isUnauthorised(caught));
}

async function testSweep(): Promise<void> {
  console.log("\n-- SWEEP: every reason-before-status call site, the marker now survives --");

  const sites: Site[] = [
    // ---- client-attest.ts ----
    { name: "createAttestSession", live: true, citation: "client-attest.ts:35-45", invoke: (e) => e.createAttestSession({}) },
    // ---- client-keys.ts ----
    { name: "installKeys", live: true, citation: "client-keys.ts:51-63", invoke: (e) => e.installKeys({ token: "t", signerPrivate: "s", breakGlassPublic: "b" }) },
    { name: "addOperationalKey", live: true, citation: "client-keys.ts:124-136", invoke: (e) => e.addOperationalKey({ token: "t", operationalPublic: "p", operationalPrivate: "q" }) },
    { name: "setBreakGlassOnly", live: true, citation: "client-keys.ts:166-187 (plain engineFetch, not gatedFetch: no retry chance)", invoke: (e) => e.setBreakGlassOnly("t") },
    { name: "retireBreakGlassToken", live: true, citation: "client-keys.ts:248-259 (plain engineFetch, not gatedFetch: no retry chance)", invoke: (e) => e.retireBreakGlassToken() },
    // ---- client-session.ts ----
    { name: "deletePasskeyCredential", live: true, citation: "client-session.ts:138-149", invoke: (e) => e.deletePasskeyCredential("cred-1") },
    // ---- client-transport.ts parseJsonOrOwnerAction (the SAME ungated readErrorReason call, one layer
    //      up): every one of these resolves through the shared helper at client-transport.ts:417-421. ----
    { name: "setDestination (via parseJsonOrOwnerAction)", live: true, citation: "client-destinations.ts:41-47 + client-transport.ts:417-421", invoke: (e) => e.setDestination(null) },
    { name: "addDestination (via parseJsonOrOwnerAction)", live: true, citation: "client-destinations.ts:96-104 + client-transport.ts:417-421", invoke: (e) => e.addDestination({} as never, "label") },
    { name: "removeDestination (via parseJsonOrOwnerAction)", live: true, citation: "client-destinations.ts:121-127 + client-transport.ts:417-421", invoke: (e) => e.removeDestination("d1") },
    { name: "setDefaultDestination (via parseJsonOrOwnerAction)", live: true, citation: "client-destinations.ts:133-139 + client-transport.ts:417-421", invoke: (e) => e.setDefaultDestination("d1") },
    { name: "createIdpConnection (via parseJsonOrOwnerAction)", live: true, citation: "client-idp.ts:76-77 + client-transport.ts:417-421", invoke: (e) => e.createIdpConnection({} as never) },
    { name: "deleteIdpConnection (via parseJsonOrOwnerAction)", live: true, citation: "client-idp.ts:131-132 + client-transport.ts:417-421", invoke: (e) => e.deleteIdpConnection("c1") },
    { name: "setIdpConnectionEnabled (via parseJsonOrOwnerAction)", live: true, citation: "client-idp.ts:144-145 + client-transport.ts:417-421", invoke: (e) => e.setIdpConnectionEnabled("c1", false) },
    { name: "setOtlpPush (via parseJsonOrOwnerAction)", live: true, citation: "client-otlp-push.ts:37-43 + client-transport.ts:417-421", invoke: (e) => e.setOtlpPush({} as never) },
    { name: "setPush (via parseJsonOrOwnerAction)", live: true, citation: "client-push.ts:39-46 + client-transport.ts:417-421", invoke: (e) => e.setPush({} as never) },
    // ---- client-keys.ts rotateBreakGlass (ALSO via parseJsonOrOwnerAction, plain engineFetch) ----
    { name: "rotateBreakGlass (via parseJsonOrOwnerAction)", live: true, citation: "client-keys.ts:142-158 + client-transport.ts:417-421 (plain engineFetch, not gatedFetch)", invoke: (e) => e.rotateBreakGlass("t", "bg-pub") },

    // ---- LATENT: identical shape, route not (yet) step-up gated engine-side ----
    { name: "setCoverageInventory", live: false, citation: "client-posture.ts:71-78 (/admin/coverage/inventory not in STEPUP_SUBS)", invoke: (e) => e.setCoverageInventory({} as never) },
    { name: "restore", live: false, citation: "client-downpipes.ts:159-181 (/admin/restore not in STEPUP_SUBS)", invoke: (e) => e.restore({} as never) },
    { name: "restoreCapsule", live: false, citation: "client-downpipes.ts:192-200 (/admin/restore/capsule not in STEPUP_SUBS)", invoke: (e) => e.restoreCapsule("r1") },
    { name: "setLicence", live: false, citation: "client-downpipes.ts:219-232 (/admin/licence not in STEPUP_SUBS)", invoke: (e) => e.setLicence("tok") },
    { name: "rollbackUpdate", live: false, citation: "client-update.ts:132-151 (/admin/update/rollback not in STEPUP_SUBS)", invoke: (e) => e.rollbackUpdate("t") },
    { name: "rollbackPlan", live: false, citation: "client-update.ts:164-177 (/admin/update/rollback not in STEPUP_SUBS)", invoke: (e) => e.rollbackPlan() },
    { name: "settleUpdate", live: false, citation: "client-update.ts:190-207 (/admin/update/settle not in STEPUP_SUBS)", invoke: (e) => e.settleUpdate("t") },
    { name: "settleRampUpdate", live: false, citation: "client-update.ts:238-255 (/admin/update/ramp/settle not in STEPUP_SUBS)", invoke: (e) => e.settleRampUpdate("t") },
    { name: "reattachMissing", live: false, citation: "client-sources.ts:173-190 (/admin/sources/reattach-missing not in STEPUP_SUBS)", invoke: (e) => e.reattachMissing("t") },
  ];

  for (const site of sites) await expectMarkerSurvives(site);

  // sendCustodyShare is FAIL-SOFT (never throws): its consequence is a mis-worded inline reason, never a
  // sign-out. Proven separately: the raw engine text must not leak through unclassified.
  {
    const engine = new EngineClient("https://engine.test");
    const scripted = scriptFetchOnce(STEPUP_401_BODY, 401);
    const res = await engine.sendCustodyShare({ toEmail: "a@b.com", shareB64: "x", n: 3, m: 2 }).finally(scripted.restore);
    ok("sendCustodyShare [LATENT, client-keys.ts:283-287, fail-soft]: sent:false", res.sent === false);
    ok("sendCustodyShare: does not surface the raw un-gated reason (falls to the status-labelled fallback)", res.reason !== "step-up required");
  }
}

// ===========================================================================================
// SECTION 4 -- NEGATIVE CONTROL: siblings that were ALREADY correctly gated, unaffected by the fix,
// and never had the defect. Cited so no symmetry is assumed.
// ===========================================================================================
async function testNegativeControls(): Promise<void> {
  console.log("\n-- NEGATIVE CONTROL: siblings that never had the defect (parseJsonOrPending / parseJsonOrReason / plain parseJson) --");

  const sites: Array<{ name: string; citation: string; invoke: (e: InstanceType<Awaited<typeof EngineClient>>) => Promise<unknown> }> = [
    { name: "setRole (parseJsonOrPending)", citation: "client-rbac.ts:37-40", invoke: (e) => (e as unknown as { setRole: (e: string, r: string) => Promise<unknown> }).setRole("a@b.com", "operator") },
    { name: "deleteRole (parseJsonOrPending)", citation: "client-rbac.ts:53-55", invoke: (e) => (e as unknown as { deleteRole: (e: string) => Promise<unknown> }).deleteRole("a@b.com") },
    { name: "setGroupRole (parseJsonOrPending)", citation: "client-rbac.ts:74-76", invoke: (e) => (e as unknown as { setGroupRole: (g: string, r: string) => Promise<unknown> }).setGroupRole("g", "operator") },
    { name: "createCustomRole (parseJsonOrPending)", citation: "client-rbac.ts:108-110", invoke: (e) => (e as unknown as { createCustomRole: (p: unknown) => Promise<unknown> }).createCustomRole({}) },
    { name: "acceptPostureRisk (parseJsonOrPending)", citation: "client-posture.ts:33-36", invoke: (e) => e.acceptPostureRisk("chk1", "reason") },
    { name: "approveRestore (parseJsonOrReason)", citation: "client-restore.ts:23-25", invoke: (e) => e.approveRestore("hash") },
    { name: "passkeyRegisterFinish (plain parseJson, no reason pre-read)", citation: "client-passkey.ts:75-76", invoke: (e) => (e as unknown as { passkeyRegisterFinish: (e: string, c: unknown) => Promise<unknown> }).passkeyRegisterFinish("a@b.com", {}) },
    { name: "regenerateRecoveryCodes (plain parseJson, no reason pre-read)", citation: "client-recovery.ts:35-36", invoke: (e) => (e as unknown as { regenerateRecoveryCodes: () => Promise<unknown> }).regenerateRecoveryCodes() },
    { name: "clearOtlpPush (plain parseJson, no reason pre-read)", citation: "client-otlp-push.ts:49-50", invoke: (e) => (e as unknown as { clearOtlpPush: () => Promise<unknown> }).clearOtlpPush() },
    { name: "clearPush (plain parseJson, no reason pre-read)", citation: "client-push.ts:52-53", invoke: (e) => (e as unknown as { clearPush: () => Promise<unknown> }).clearPush() },
    { name: "testPush (plain parseJson, no reason pre-read)", citation: "client-push.ts:66-67", invoke: (e) => (e as unknown as { testPush: () => Promise<unknown> }).testPush() },
  ];

  for (const site of sites) {
    const engine = new EngineClient("https://engine.test");
    const scripted = scriptFetchOnce(STEPUP_401_BODY, 401);
    let caught: unknown = null;
    try {
      await site.invoke(engine as never);
    } catch (err) {
      caught = err;
    } finally {
      scripted.restore();
    }
    ok(`${site.name} [${site.citation}]: threw`, caught instanceof Error);
    ok(`${site.name}: already classified stepup-required BEFORE this fix (no change here)`, classifyError(caught).kind === "stepup-required");
  }
}

// ===========================================================================================
// SECTION 5 -- END-TO-END: restore-flow/attend.ts's REAL Start action, driven through the REAL
// EngineClient/Transport/client-attest.ts stack over a scripted global fetch, exactly as the test
// (validate-r28-attest-session-degrade.ts) drives Start -- but here the engine answers a genuine step-up
// 401, not a malformed 2xx. No ceremony wired (store.connect's onStepUpRequired delegates to the
// module-level stepUpRunner, unset in this test, so it resolves to null: the same "ceremony
// unavailable/cancelled" path gatedFetch documents), so this is also the worst case: the ceremony cannot
// run at all, and the console must still not sign the operator out.
// ===========================================================================================
async function testEndToEndAttendStart(): Promise<void> {
  console.log("\n-- END-TO-END: restore-flow/attend.ts Start renders 'Verify your identity', never signs out --");

  let signedOut = false;
  nav.installNav({
    navigate: () => {},
    onUnauthorised: () => { signedOut = true; },
    refreshIdentity: async () => {},
    signOut: () => {},
    onAuthenticated: async () => {},
  });

  const owner: Caller = { method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false };
  store.setCaller(owner);
  store.connect("https://engine.test");
  const engine = store.getEngine();
  if (!engine) throw new Error("no engine in store");

  const root = renderAttendRunner(engine) as unknown as ShimNode;
  await flushAsync();

  const km = await (await import("../src/keygen.ts")).runKeyCeremony({ operational: false });
  const identityText = (await import("../src/keygen.ts")).identityFile(km.breakGlass);

  const el = qs(root, "#attend-identity");
  if (el === null) throw new Error("no identity file input on the attend screen");
  (el as unknown as { files: unknown }).files = [new ShimFile(identityText, "identity.key")];
  el.dispatchEvent({ type: "change", target: el, currentTarget: el, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} });
  await flushAsync();

  const startBtn = qs(root, `[data-dp="restore-flow.button.start"]`);
  if (startBtn === null) throw new Error("Start button not found");
  ok("Start is enabled once identity.key is supplied", (startBtn as unknown as { disabled: boolean }).disabled === false);

  // Script the REAL fetch createAttestSession makes: POST /admin/attest/session/create -> the genuine
  // step-up 401 (no ceremony can complete: onStepUpRequired resolves to null with no stepUpRunner wired).
  const scripted = scriptFetchOnce(STEPUP_401_BODY, 401);
  let unhandled: unknown = null;
  const onUnhandled = (reason: unknown): void => { unhandled = reason; };
  process.on("unhandledRejection", onUnhandled);
  try {
    (startBtn as unknown as HTMLButtonElement).click();
    await flushAsync();
    await flushAsync();
  } finally {
    process.off("unhandledRejection", onUnhandled);
    scripted.restore();
  }

  ok("no unhandled rejection from Start", unhandled === null);
  ok("goSignedOut() was NOT called -- the valid session survives", !signedOut);
  const bodyText = textOf(root);
  ok("'Verify your identity' renders on the Start action's own screen", bodyText.includes("Verify your identity"));
  ok("the copy names the session as still active, not lapsed", bodyText.includes("Your session is still active"));
}

async function main(): Promise<void> {
  await testReadErrorReasonUnit();
  await testSweep();
  await testNegativeControls();
  await testEndToEndAttendStart();

  console.log(failures === 0 ? "\nR-31 STEPUP-REASON-SURVIVES VALIDATION PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-R31-STEPUP-REASON-SURVIVES THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
