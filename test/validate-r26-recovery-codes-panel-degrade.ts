// the public, no-login tour crashed on free-roam /security. Regenerate threw inside
// src/components/recovery-codes-panel.ts, reached through the demo world's unmodelled
// /admin/auth/recovery-codes/regenerate fallback: routeWrite had no case for that path, so it fell
// through to benignWrite's generic { ok:true, deleted:true, applied:true, status:"result", value:{ok:true} }
// (no `recoveryCodes` field). security-centre/access.ts's regenerateRecoveryCodesFlow then built
// `recoveryCodesPanel({ codes: result.recoveryCodes, ... })` with `codes` undefined, and
// recoveryCodesText's `codes.map(...)` threw TypeError: Cannot read properties of undefined (reading
// 'map') -- confirmed against the DEPLOYED tour bundle (tour.downpipes.io/app.js), whose minified
// recoveryCodesText (`function I2(e){...e.map(r=>...)...}`) and demo-fetch chunk (whose
// default-write fallback literal `{ok:!0,deleted:!0,applied:!0,status:"result",val...}` matches
// benignWrite byte-for-byte) both carry the same unguarded shape as this source tree, and neither
// carries a case for the regenerate path.
//
// This proves the fix at all three layers it touches:
//   1. the demo route table now models POST /admin/auth/recovery-codes/regenerate for real (a
//      RecoveryCodesResult, not the benign fallback)
//   2. the call site (regenerateRecoveryCodesFlow) validates the response BEFORE opening the
//      one-time panel, and degrades to an actionable warn toast on an unusable one
//   3. the panel itself (recoveryCodesPanel / recoveryCodesText) never throws on a malformed `codes`,
//      from ANY caller, not only this one -- the generalising half of the fix
//
// Run with: node test/validate-r26-recovery-codes-panel-degrade.ts

import { installDomShim, qs, qsa, textOf, flushAsync, markConnected, type ShimNode } from "./dom-shim.ts";
installDomShim();

// Now it is safe to import the modules under test (they touch document at load).
const { route } = await import("../src/lib/demo/demo-routes-read.ts");
const { resetWorld } = await import("../src/lib/demo/demo-world.ts");
const { recoveryCodesPanel, hasUsableRecoveryCodes, recoveryCodesText } = await import("../src/components/recovery-codes-panel.ts");
const accessMod = await import("../src/screens/security-centre/access.ts");
const store = await import("../src/lib/store.ts");
const nav = await import("../src/lib/nav.ts");

import type { Caller, StatusReport } from "../src/api.ts";

nav.installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function docBody(): ShimNode {
  return (globalThis as unknown as { document: { body: ShimNode } }).document.body;
}

// clickModalButton mirrors validate-security-centre.ts's helper: it waits for the next confirmModal
// to render under the shim and clicks the button with the given label, so a confirm-first gate is
// driven for real rather than bypassed.
async function clickModalButton(label: string): Promise<void> {
  await flushAsync();
  const surface = qs(docBody(), ".dialog--modal");
  if (!surface) throw new Error(`clickModalButton: no open modal found for "${label}"`);
  const btn = qsa(surface, "button").find((b) => textOf(b).includes(label));
  if (!btn) throw new Error(`clickModalButton: no button labelled "${label}" in the open modal`);
  btn.click();
  await flushAsync();
}

function baseStatus(): StatusReport {
  return {
    service: "downpipes-engine", engineVersion: "0.0.0", signerConfigured: true, breakGlassConfigured: true,
    operationalConfigured: { public: true, private: true }, destConfigured: true, destKind: "r2",
    updateChannelConfigured: false, licenceConfigured: false, downpipeCount: 1, ready: true,
    recoveryCodesRemaining: 2, breakGlassTokenRetired: false, tokenFallbackDisabled: false,
  };
}

// =====================================================================================
// SECTION 1: the demo route table models POST /admin/auth/recovery-codes/regenerate for real.
// =====================================================================================
async function testDemoRouteModelsRegenerate(): Promise<void> {
  console.log("\n-- demo route table: POST /admin/auth/recovery-codes/regenerate returns a USABLE result --");
  resetWorld(Date.UTC(2026, 6, 30, 0, 0, 0));
  const res = await route("/admin/auth/recovery-codes/regenerate", { method: "POST" });
  ok("status 200", res.status === 200);
  const body = (await res.json()) as { recoveryCodes?: unknown };
  ok("the body carries a USABLE recoveryCodes array (the reported gap was the benign\n" +
    "       {ok:true,...} fallback, which carries no such field)", hasUsableRecoveryCodes(body.recoveryCodes));
  ok("mints the documented ten-code set", Array.isArray(body.recoveryCodes) && body.recoveryCodes.length === 10);

  // The demo's status count should reflect the fresh mint too (a believable demo, not just a non-crash).
  const status = await route("/admin/status");
  const statusBody = (await status.json()) as { recoveryCodesRemaining?: number };
  ok("world.status.recoveryCodesRemaining refreshes to the fresh count", statusBody.recoveryCodesRemaining === 10);
}

// =====================================================================================
// SECTION 2: recoveryCodesPanel / recoveryCodesText never throw on a malformed `codes`, from ANY
// caller -- the exact reproduction of the deployed crash, driven at the unit the deployed bundle's
// minified I2(e){...e.map(...)...} corresponds to.
// =====================================================================================
function testPanelDegradesHonestly(): void {
  console.log("\n-- recoveryCodesText: a malformed codes value never throws (was: TypeError on .map) --");
  for (const bad of [undefined, null, "not-an-array", 42, {}] as unknown[]) {
    let threw = false;
    try {
      recoveryCodesText(bad as unknown as string[]);
    } catch {
      threw = true;
    }
    ok(`recoveryCodesText(${JSON.stringify(bad)}) does not throw`, !threw);
  }

  console.log("\n-- recoveryCodesPanel: the EXACT reproduction -- codes:undefined, as regenerateRecoveryCodesFlow\n" +
    "   built it from result.recoveryCodes when the demo's benignWrite fallback answered --");
  {
    let threw: unknown = null;
    let panel: HTMLElement | undefined;
    try {
      panel = recoveryCodesPanel({
        codes: undefined as unknown as string[],
        context: "regenerate",
        downloadText: () => true,
        onConfirm: () => {},
      });
    } catch (err) {
      threw = err;
    }
    ok("recoveryCodesPanel({codes: undefined, ...}) does NOT throw (this is the live crash)", threw === null);
    const tree = panel as unknown as ShimNode | undefined;
    ok("renders SOMETHING (not an empty/undefined return)", tree !== undefined);
    if (tree) {
      const text = textOf(tree);
      ok("renders an HONEST, ACTIONABLE message a person can act on (not a blank panel, not the codes UI)",
        text.includes("could not be shown") || text.includes("did not include"));
      ok("does NOT claim to show the save-or-lose codes UI it cannot deliver", !text.includes("I have saved my recovery codes"));
      const closeBtn = qsa(tree, "button").find((b) => textOf(b).includes("Close"));
      ok("offers a Close action (a dead-end modal with no exit is its own defect)", closeBtn !== undefined);
    }
  }

  console.log("\n-- recoveryCodesPanel: a genuinely usable set still renders the normal save-confirm UI (no regression) --");
  {
    const panel = recoveryCodesPanel({
      codes: ["AAAAA-11111-BBBBB-22222-CCCCC-33333"],
      context: "regenerate",
      downloadText: () => true,
      onConfirm: () => {},
    }) as unknown as ShimNode;
    const text = textOf(panel);
    ok("a valid set still renders the code", text.includes("AAAAA-11111-BBBBB-22222-CCCCC-33333"));
    ok("a valid set still renders the save-confirm gate", text.includes("I have saved my recovery codes"));
  }
}

// =====================================================================================
// SECTION 3: the FULL flow, driven through the real Regenerate button and the real confirm modal,
// against a stub engine answering the EXACT malformed shape the demo world used to return. Proves the
// fix end-to-end: no unhandled rejection, and an honest, actionable toast (never a silent dead click,
// never a false "New recovery codes generated" success).
// =====================================================================================
async function testRegenerateFlowEndToEnd(): Promise<void> {
  console.log("\n-- regenerateRecoveryCodesFlow: a malformed engine response degrades to an actionable\n" +
    "   toast, never an unhandled rejection or a false success end-to-end --");

  const owner: Caller = { method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false };
  store.setCaller(owner);
  store.connect("https://engine.test");
  const engine = store.getEngine();
  if (!engine) throw new Error("no engine in store");

  // The exact benignWrite shape (src/lib/demo/demo-world.ts) the unmodelled route used to answer with,
  // asserted through the engine client's OWN return type so a real TS caller could not have produced
  // this by construction -- exactly how a JSON-boundary response bypasses the type system in practice.
  (engine as unknown as { regenerateRecoveryCodes: () => Promise<unknown> }).regenerateRecoveryCodes = async () => (
    { ok: true, deleted: true, applied: true, status: "result", value: { ok: true } }
  );

  let reloaded = false;
  const root = accessMod.renderRecoveryAccess(engine, baseStatus(), true, () => { reloaded = true; }) as unknown as ShimNode;
  markConnected(root);

  const regenBtn = qsa(root, "button").find((b) => textOf(b).includes("Regenerate recovery codes"));
  if (!regenBtn) throw new Error("Regenerate button did not render");

  // Catch an unhandled rejection for the DURATION of this click: the pre-fix flow's throw happens
  // inside the async regenerateRecoveryCodesFlow, invoked as `void regenerateRecoveryCodesFlow(...)`
  // from the click listener, so it surfaces as an unhandled rejection, not a synchronous throw out of
  // .click(). This is the live symptom: nothing renders, the click is silently swallowed by the
  // runtime, and only devtools shows the thrown TypeError.
  let unhandled: unknown = null;
  const onUnhandled = (reason: unknown): void => { unhandled = reason; };
  process.on("unhandledRejection", onUnhandled);
  try {
    regenBtn.click();
    await clickModalButton("Regenerate codes"); // drives the real confirm, never bypassed
    // Give the async flow's own .then/.catch chain a full turn to settle before checking for an
    // unhandled rejection (flushAsync alone is already several microtask/macrotask rounds).
    await flushAsync();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  ok("no unhandled rejection from the click (was: TypeError from recoveryCodesText's .map)", unhandled === null);

  const bodyText = textOf(docBody());
  ok("an ACTIONABLE warn toast renders (a person can act on 'reload and check your count')",
    bodyText.includes("Could not regenerate your recovery codes") && bodyText.includes("did not include the new codes"));
  ok("the toast does NOT falsely claim success", !bodyText.includes("New recovery codes generated"));
  ok("no dead-end 'codes could not be shown' modal was left open (the call site pre-empts the panel)",
    qs(docBody(), ".dialog--modal") === null);
  ok("reload() was NOT called (nothing changed to refresh)", reloaded === false);
}

async function main(): Promise<void> {
  await testDemoRouteModelsRegenerate();
  testPanelDegradesHonestly();
  await testRegenerateFlowEndToEnd();

  console.log(failures === 0 ? "\nR-26 RECOVERY-CODES-PANEL-DEGRADE VALIDATION PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-R26-RECOVERY-CODES-PANEL-DEGRADE THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
