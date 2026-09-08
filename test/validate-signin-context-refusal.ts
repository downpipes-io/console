// Prove the sign-in-context switch's NON-OWNER REFUSAL, the branch nobody had exercised.
// Run with: npx tsx test/validate-signin-context-refusal.ts
//
// WHY THIS EXISTS. src/screens/security-centre/signin-context.ts gates its switch on
//   const isOwner = can(callerRole(), "access.policy") && callerRole() === "owner";
// and everything downstream (the standing refusal, the "Owner only" badge, the toggle's early return)
// hangs off that one boolean. The refusal branch was never proven because the demo seed signs in as an
// Owner, so a live walk of the screen only ever exercises the ENABLED path. That does not need a live
// estate to fix: the caller is in-memory state with a setter (store.setCaller), the control is a pure
// render over it, and the engine is an interface. So the non-owner state is CONSTRUCTED here rather
// than waited for.
//
// The engine is the enforcement point; this gating is a client courtesy and never the control. What is
// asserted is therefore what the console OWES a non-owner: an honest, reachable refusal, and a toggle
// that does not pretend.
//
// The last assertion is the one that matters. The others check what a non-owner is TOLD; that one
// checks what happens when they press it anyway, which is the only question a refusal really answers.

import { installDomShim, qsa, textOf, flushAsync } from "./dom-shim.ts";

installDomShim();

import { signInContextControl } from "../src/screens/security-centre/signin-context.ts";
import { setCaller } from "../src/lib/store.ts";
import type { EngineClient } from "../src/api.ts";
import type { Caller } from "../src/lib/api/types/who.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// A caller with every field the type demands, differing from an Owner in exactly one place: role.
// Keeping the rest identical is the point. If the refusal turned on something other than the role, a
// caller built this way would still be treated as an Owner and the assertions below would say so.
function callerWithRole(role: Caller["role"]): Caller {
  return { method: "access", subject: "sub-test", email: "someone@example.com", role, groups: [], isOnlyOwner: false };
}

// A stub engine that counts writes. getConfigApprovalPolicy answers with the field PRESENT and false, so
// the control takes its normal available-and-off path rather than degrading to "this engine build does
// not support it", which would make the refusal vacuously true for the wrong reason.
//
// THE WRITE METHOD IS NAMED setSignInContextPolicy, and getting that name wrong is how this test would
// have lied. The first draft counted setConfigApprovalPolicy, which onToggle never calls, so the "no
// write reached the engine" assertion would have passed for an Owner too. It is asserted against the
// EngineClient type below rather than left as a bare string, so a rename breaks compilation instead of
// quietly emptying the check.
const WRITE_METHOD = "setSignInContextPolicy" satisfies keyof EngineClient;

function stubEngine(): { engine: EngineClient; writes: () => number } {
  let writes = 0;
  const engine = {
    getConfigApprovalPolicy: () => Promise.resolve({ notifyNewSignInContext: false }),
    [WRITE_METHOD]: (on: boolean) => { writes++; return Promise.resolve({ notifyNewSignInContext: on }); },
  } as unknown as EngineClient;
  return { engine, writes: () => writes };
}

async function renderFor(role: Caller["role"]): Promise<{ root: HTMLElement; writes: () => number }> {
  setCaller(callerWithRole(role));
  const { engine, writes } = stubEngine();
  const root = signInContextControl(engine);
  await flushAsync(); // let loadPolicy's promise settle so reflect() has run
  return { root, writes };
}

function switchOf(root: HTMLElement): HTMLElement | undefined {
  return qsa(root, '[role="switch"]')[0] as HTMLElement | undefined;
}

async function main(): Promise<void> {
  console.log("SIGN-IN CONTEXT: the non-owner refusal path\n");

  // -----------------------------------------------------------------------------------------------
  // 1. The control renders at all for a non-owner. A refusal that renders nothing is not a refusal,
  //    it is a disappearance, and the operator cannot tell it from a broken screen.
  // -----------------------------------------------------------------------------------------------
  console.log("1. an access-admin (not an Owner) still SEES the control:");
  const admin = await renderFor("access-admin");
  const adminSwitch = switchOf(admin.root);
  ok("the switch is rendered", adminSwitch !== undefined);
  ok("the state is still stated, not hidden", textOf(admin.root).includes("Off: sign-ins do not check for a new location."));

  // -----------------------------------------------------------------------------------------------
  // 2. The refusal is STANDING and REACHABLE. aria-disabled rather than the native disabled attribute,
  //    because native disabled drops a control out of the tab order and a screen reader user then meets
  //    a refusal they cannot reach. The reason must be real text, and aria-describedby must point at a
  //    node that is actually in this tree: a dangling id is the exact defect this file's own header
  //    records being fixed on the unavailable path.
  // -----------------------------------------------------------------------------------------------
  console.log("\n2. the refusal is stated, and reachable:");
  ok("the switch is aria-disabled", adminSwitch?.getAttribute("aria-disabled") === "true");
  ok("it is NOT natively disabled (that would drop it out of the tab order)",
    (adminSwitch as HTMLButtonElement | undefined)?.disabled === false);
  const adminText = textOf(admin.root);
  ok("the reason names the Owner requirement", adminText.includes("Only an Owner can change this notification."));
  ok('the "Owner only" badge is shown', adminText.includes("Owner only"));
  const describedBy = (adminSwitch?.getAttribute("aria-describedby") ?? "").split(" ").filter((s) => s !== "");
  ok("aria-describedby is set", describedBy.length > 0);
  const resolvable = describedBy.every((id) => qsa(admin.root, `#${id}`).length > 0);
  ok("every aria-describedby id resolves to a node in this tree (no dangling reference)", resolvable);

  // -----------------------------------------------------------------------------------------------
  // 3. THE ONE THAT MATTERS. Pressing it anyway must reach no engine write. onToggle's first line is
  //    `if (!view.isOwner || view.sw.disabled) return;`, and the click listener disabledWithReason
  //    installs calls preventDefault; neither is a substitute for checking that nothing was written.
  // -----------------------------------------------------------------------------------------------
  console.log("\n3. pressing it anyway writes nothing:");
  // The shim's own click(), which dispatches a real bubbling, cancellable click through the same
  // listener chain the browser would, so disabledWithReason's preventDefault guard is genuinely in play.
  adminSwitch?.click();
  await flushAsync();
  ok("no policy write reached the engine", admin.writes() === 0);
  ok("the switch still reads off afterwards", adminSwitch?.getAttribute("aria-checked") === "false");

  // -----------------------------------------------------------------------------------------------
  // 4. The counter-case, so section 3 cannot pass by being blind. An Owner must NOT be refused. Without
  //    this, a control that refused everybody would satisfy every assertion above.
  // -----------------------------------------------------------------------------------------------
  console.log("\n4. the counter-case: an Owner is not refused:");
  const owner = await renderFor("owner");
  const ownerSwitch = switchOf(owner.root);
  ok("the switch is rendered for an Owner", ownerSwitch !== undefined);
  ok("it is NOT aria-disabled", ownerSwitch?.getAttribute("aria-disabled") !== "true");
  const ownerText = textOf(owner.root);
  ok("no Owner-only refusal text", !ownerText.includes("Only an Owner can change this notification."));
  ok('no "Owner only" badge', !ownerText.includes("Owner only"));

  // -----------------------------------------------------------------------------------------------
  // 4b. THE PROOF THAT SECTION 3 IS NOT BLIND. Counting writes only means something if a write is
  //     reachable at all on this wiring. onToggle opens a confirm dialog before it writes, so an
  //     Owner's click must at least get that far. If this fails, section 3's silence proves nothing
  //     about the refusal and everything about the stub.
  // -----------------------------------------------------------------------------------------------
  console.log("\n4b. an Owner's click DOES reach the toggle path (so section 3 means something):");
  const dialogsBefore = qsa(document.body as unknown as HTMLElement, '[role="dialog"]').length;
  ownerSwitch?.click();
  await flushAsync();
  const dialogsAfter = qsa(document.body as unknown as HTMLElement, '[role="dialog"]').length;
  ok("the confirm dialog opened for the Owner", dialogsAfter > dialogsBefore);
  ok("it did NOT open for the non-owner earlier (no dialog was left behind)", dialogsBefore === 0);

  // -----------------------------------------------------------------------------------------------
  // 5. The refusal must not depend on the role NAME alone. A viewer is refused for the same reason and
  //    an operator is too, so the gate is the Owner requirement rather than a single hard-coded role.
  // -----------------------------------------------------------------------------------------------
  console.log("\n5. every non-Owner role is refused the same way:");
  for (const role of ["viewer", "operator", "approver", "restore-operator", "access-admin"] as const) {
    const r = await renderFor(role);
    const sw = switchOf(r.root);
    ok(`${role}: aria-disabled with the Owner reason`,
      sw?.getAttribute("aria-disabled") === "true" && textOf(r.root).includes("Only an Owner can change this notification."));
  }

  setCaller(null);
  console.log(failures === 0 ? "\nSIGN-IN CONTEXT REFUSAL PASS" : `\nSIGN-IN CONTEXT REFUSAL: ${failures} FAILED`);
  if (failures > 0) process.exitCode = 1;
  process.exit(failures === 0 ? 0 : 1);
}

void main();
