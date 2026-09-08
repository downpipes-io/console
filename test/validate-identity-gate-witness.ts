// A gate on the RESTORE screen decided without an identity must leave a row, and must be recoverable.
//
// WHY THIS EXISTS
// ---------------
// The restore apply/request panel used to gate on canDo("approver"), a cumulative role RANK, while the
// engine gates on the restore.apply CAPABILITY, which restore-operator holds while sitting off that ladder at
// rank 0. The engine accepted the role's dry-run with a 200 and the console offered it nothing. The panel was
// fixed (screens/restore-flow/confirm.ts gates on canCap) and the screen-owned palette commands were fixed
// one layer up (validate-screen-action-gates.ts).
//
// The residue was one layer BELOW both, and it is what this file pins. canCap and canDo fail closed on a null
// caller, correctly, but they did it in SILENCE. Every restore surface gates through them, and the witness that
// exists precisely to record a gate computed before the identity report arrived
// (lib/client-diag/identity-gate.ts) had been wired into four screen-LOCAL copies of canCap and into neither
// original. Two consequences, and neither is cosmetic:
//
//   NO EVIDENCE. The identity-stale-gate row could not name screen "restore" whatever happened, so a raced
//   Owner and a genuine viewer produced byte-identical support packs on the restore screen. That equivalence
//   is the exact confusion the row was added to end, and it survived on the screen that matters most for
//   disaster recovery.
//
//   NO RECOVERY. app.ts reads currentScreenGatedBlind() to set forceForBlindGate, which is what re-renders
//   the on-screen screen when the resolved caller's render key is UNCHANGED (a same-identity re-resolve during
//   which a late async gate ran blind). A gate that never witnesses cannot raise that flag, so on the restore
//   screen a late blind gate stayed stuck instead of self-correcting.
//
// WHAT IT PINS, AND WHY IT IS NOT AN ABSENCE-OF-ERROR TEST
// -------------------------------------------------------
// It asserts the CAPABILITY VERDICT that is actually offered at each step, not merely that nothing threw:
// restore-operator gets true from canCap("restore.apply") and false from a capability it does not hold, a
// null caller gets false, and the blind decision leaves a row naming "restore". A build that answered false
// to everything, or true to everything, fails here.
//
// Run with `node test/validate-identity-gate-witness.ts`.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { flushAsync, installDomShim } from "./dom-shim.ts";
import { makeChecks } from "./validate-checks.ts";

installDomShim();

import type { Caller, EngineClient, RestorePlan, RestoreRequest } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { setCaller } from "../src/lib/store.ts";
import { canCap, canDo } from "../src/screens/common.ts";
import { renderConfirm } from "../src/screens/restore-flow/confirm.ts";
import { visibleCommands } from "../src/shell/registry.ts";
import { reset as resetRing, setActiveScreen, snapshot } from "../src/lib/client-diag/ring.ts";
import { currentScreenGatedBlind, noteIdentityLanded, resetIdentityGateWitness } from "../src/lib/client-diag/identity-gate.ts";

const checks = makeChecks();
const { ok, eq } = checks;

installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

/** A caller on a built-in role, shaped the way the engine's whoami reports one. */
function builtin(role: Caller["role"], email: string): Caller {
  return { method: "access", email, role, groups: [], isOnlyOwner: false } as Caller;
}

/** A plan that genuinely writes, so renderConfirm does not short-circuit on "nothing to apply". */
function planThatWrites(): RestorePlan {
  return { plannedWrites: 3, configChanges: [], mediaPlanned: [] } as unknown as RestorePlan;
}

function request(): RestoreRequest {
  return { runId: "01TESTRUNTESTRUNTESTRUN", target: { kind: "redirect", binding: "RESTORE_KV" } } as unknown as RestoreRequest;
}

const FLAGS = { highImpact: false, isLarge: false, isRedirect: true, isNonLatest: false, isCrossAccount: false, isCrossZone: false };

/** Renders the REAL confirm section. The approvals lookup is never reached on the paths below. */
async function renderRestoreConfirm(): Promise<HTMLElement> {
  const engine = { listApprovals: () => Promise.resolve([]) } as unknown as EngineClient;
  const section = await renderConfirm(engine, planThatWrites(), request(), "a".repeat(64), FLAGS, () => {}, () => {});
  await flushAsync();
  return section;
}

/** Every identity-stale-gate row in the ring, by screen. */
function staleGateScreens(): string[] {
  return snapshot().records.filter((r) => r.kind === "identity-stale-gate").map((r) => String(r.screen));
}

/** Puts the session back to "booted, on /restore, whoami still in flight". */
function onRestoreWithIdentityPending(): void {
  resetRing();
  resetIdentityGateWitness();
  setActiveScreen("/restore");
  setCaller(null);
}

console.log("a blind gate on the restore screen is recorded and recoverable");

// ---- 1. The premise, asserted rather than assumed. ---------------------------------------------------------
// If restore-operator did not actually hold restore.apply in the console's mirror, every assertion below would
// be measuring something other than R-DIV-1. The capability-drift gate proves the mirror equals the engine;
// this proves the console's own gate answers from it.
resetRing();
resetIdentityGateWitness();
setActiveScreen("/restore");

setCaller(builtin("restore-operator", "dr@test"));
eq("restore-operator is OFFERED restore.apply by the console's own gate", canCap("restore.apply"), true);
eq("restore-operator is OFFERED restore.request", canCap("restore.request"), true);
// The gate discriminates. A build that answered true to everything would pass the line above and fail here.
eq("restore-operator is REFUSED downpipe.write, which its role does not hold", canCap("downpipe.write"), false);
// And it sits off the rank ladder, which is the whole reason the old rank gate hid it.
eq("restore-operator does NOT satisfy the approver RANK, which is why canDo hid the panel", canDo("approver"), false);
eq("a resolved caller leaves no blind-gate witness", currentScreenGatedBlind(), false);

setCaller(builtin("viewer", "viewer@test"));
eq("a viewer is REFUSED restore.apply", canCap("restore.apply"), false);
eq("a viewer resolved is still not a blind gate", currentScreenGatedBlind(), false);

noteIdentityLanded();
eq("no identity-stale-gate row from gates computed against a resolved caller", staleGateScreens().length, 0);

// ---- 2. THE PIN: the primary capability gate, blind, on the restore screen. --------------------------------
onRestoreWithIdentityPending();

eq("canCap fails CLOSED while the identity is pending (this part was always right)", canCap("restore.apply"), false);
ok("and it WITNESSED the blind gate, so the restore screen is held", currentScreenGatedBlind());

noteIdentityLanded();
eq("the identity landing emits exactly one identity-stale-gate row", staleGateScreens().length, 1);
eq("and the row names the RESTORE screen, which it could never do before", staleGateScreens()[0], "restore");

// ---- 3. The same, through canDo, the rank gate the rest of the console still uses. -------------------------
onRestoreWithIdentityPending();
eq("canDo fails closed while the identity is pending", canDo("approver"), false);
ok("canDo witnesses its blind gate too", currentScreenGatedBlind());
noteIdentityLanded();
eq("canDo's blind gate reaches the pack as a restore row", staleGateScreens()[0], "restore");

// ---- 4. The REAL restore confirm screen, rendered blind. ---------------------------------------------------
// Not the helper in isolation: renderConfirm is the screen R-DIV-1 was reported against, and this is the
// render that used to leave no trace at all.
{
  onRestoreWithIdentityPending();
  const section = await renderRestoreConfirm();
  const text = section.textContent ?? "";

  ok("a pending identity lands on the role-gated panel, never an armed Apply", !text.includes("Checking whether this plan has an approval"));
  // The wording moved when the blind refusal gained a remedy (lib/identity-remedy.ts): it now says the
  // role was not reported AND what to do about the specific failure, rather than stopping at the fault.
  // The assertion is on the CLAIM, which is unchanged, not on the old sentence.
  ok("and the banner says the role was not reported rather than naming a wrong one", /has not reported your role/.test(text));
  ok("and it does not stop there, which was the dead end", /Reload this page|older than this console|Cloudflare Access|could not reach your engine|engine's state rather than your access/.test(text));
  ok("the render WITNESSED its blind gate", currentScreenGatedBlind());

  noteIdentityLanded();
  eq("so the support pack carries a restore identity-stale-gate row for that render", staleGateScreens()[0], "restore");
}

// ---- 5. The palette, which is the third gate that was silent. ----------------------------------------------
{
  onRestoreWithIdentityPending();
  const pending = visibleCommands({ caller: null, engine: { connected: true, ready: true, downpipeCount: 3 } });
  const ids = pending.map((c) => c.id);
  ok("a palette opened before whoami returns offers no apply-restore", !ids.includes("apply-restore"));
  ok("and no request-restore", !ids.includes("request-restore"));
  ok("the palette's capability gate WITNESSED the blind decision", currentScreenGatedBlind());

  // The positive half: the same registry offers both to a restore-operator, so the exclusion above is the
  // pending identity and not a registry that hides them from everyone.
  const armed = visibleCommands({
    caller: builtin("restore-operator", "dr@test"),
    engine: { connected: true, ready: true, downpipeCount: 3 },
  }).map((c) => c.id);
  ok("a resolved restore-operator IS offered apply-restore", armed.includes("apply-restore"));
  ok("and request-restore", armed.includes("request-restore"));
}

// ---- 6. The witness is one-shot and per screen, not a counter that inflates. -------------------------------
onRestoreWithIdentityPending();
canCap("restore.apply");
canCap("restore.request");
canDo("approver");
noteIdentityLanded();
eq("three blind gates on one screen yield ONE row, not three", staleGateScreens().length, 1);

// After the identity has landed, a gate is being decided from a real report, so there is nothing to witness.
setCaller(null);
canCap("restore.apply");
ok("a gate computed after the identity landed adds no further witness", !currentScreenGatedBlind());

console.log(`\n${checks.failures === 0 ? "PASS" : "FAIL"}: identity-gate witness on the restore surfaces (${checks.failures} failure(s))`);
process.exit(checks.failures === 0 ? 0 : 1);
