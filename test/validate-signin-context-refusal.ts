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

import { installDomShim, qsa, textOf, flushAsync, type ShimNode } from "./dom-shim.ts";

installDomShim();

import { signInContextControl } from "../src/screens/security-centre/signin-context.ts";
import { restoreApprovalControl } from "../src/screens/security-centre/restore-approval.ts";
import { configApprovalControl } from "../src/screens/security-centre/access.ts";
import { changeNumberControl } from "../src/screens/security-centre/change-management.ts";
import { POLICY_READ_FAILED } from "../src/screens/security-centre/shared.ts";
import { setCaller } from "../src/lib/store.ts";
import type { EngineClient } from "../src/api.ts";
import type { Caller } from "../src/lib/api/types/who.ts";
import { click, findButtonByText, SN } from "./validate-stable-components-shared.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

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
// the control takes its normal available-and-off path rather than the unavailable path (section 6), which
// would make the refusal vacuously true for the wrong reason.
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

  // -----------------------------------------------------------------------------------------------
  // 6. A policy reply WITHOUT the setting. The switch must not show a value it did not read: it reads
  //    Unavailable (never "Off"), stays natively disabled, states POLICY_READ_FAILED, and offers Retry,
  //    the same as a failed read. Proven for all four switches that read the shared policy (dual control
  //    and change number included: a reply without requireConfigApproval once painted "Four-eyes is OFF"),
  //    and Retry must re-read: a second reply that carries the field paints the real state.
  // -----------------------------------------------------------------------------------------------
  console.log("\n6. a policy reply without the setting reads Unavailable and offers Retry:");
  setCaller(callerWithRole("owner"));
  const cases = [
    { name: "sign-in context", field: "notifyNewSignInContext", render: signInContextControl, offText: "Off: sign-ins do not check for a new location." },
    { name: "restore approval", field: "requireRestoreApproval", render: restoreApprovalControl, offText: "Off: you can apply a restore on your own." },
    { name: "dual control", field: "requireConfigApproval", render: configApprovalControl, offText: "Four-eyes is OFF: config changes apply immediately." },
    { name: "change number", field: "requireChangeNumber", render: changeNumberControl, offText: "Off: change-controlled actions do not ask for a change number." },
  ] as const;
  for (const c of cases) {
    let reads = 0;
    const engine = {
      getConfigApprovalPolicy: () => { reads++; return Promise.resolve(reads === 1 ? {} : { [c.field]: false }); },
    } as unknown as EngineClient;
    const root = c.render(engine);
    await flushAsync();
    const sw = switchOf(root) as HTMLButtonElement | undefined;
    const text = textOf(root);
    ok(`${c.name}: the switch label reads Unavailable, not Off`, text.includes("Unavailable") && !text.includes(c.offText));
    ok(`${c.name}: the switch is natively disabled`, sw?.disabled === true);
    ok(`${c.name}: the state line states POLICY_READ_FAILED`, text.includes(POLICY_READ_FAILED));
    const retry = qsa(root, "button").find((b) => textOf(b as unknown as HTMLElement).includes("Try again"));
    ok(`${c.name}: a Retry control is offered`, retry !== undefined);
    (retry as unknown as HTMLButtonElement | undefined)?.click();
    await flushAsync();
    ok(`${c.name}: Retry re-reads the policy and paints the real state`, reads === 2 && textOf(root).includes(c.offText) && sw?.disabled === false);
  }

  // -----------------------------------------------------------------------------------------------
  // 7. A SAVE reply without the setting. The dual-control and change-number saves read the new value off
  //    the save reply; a reply without it once painted "Off" whatever the engine now held. The switch must
  //    re-read the policy instead and paint what that read says. The modal is driven, not stubbed.
  // -----------------------------------------------------------------------------------------------
  console.log("\n7. a save reply without the setting re-reads the policy rather than painting Off:");
  const saves = [
    { name: "dual control", field: "requireConfigApproval", render: configApprovalControl, confirm: "Require approval", onText: "Four-eyes is ON", write: "setConfigApprovalPolicy", reply: { status: "result", value: {} } },
    { name: "change number", field: "requireChangeNumber", render: changeNumberControl, confirm: "Require change number", onText: "On: change-controlled actions ask for a change number.", write: "setChangeNumberPolicy", reply: {} },
  ] as const;
  for (const c of saves) {
    let reads = 0;
    const engine = {
      getConfigApprovalPolicy: () => { reads++; return Promise.resolve({ [c.field]: reads > 1 }); },
      [c.write]: () => Promise.resolve(c.reply),
    } as unknown as EngineClient;
    const root = c.render(engine);
    await flushAsync();
    const sw = switchOf(root);
    if (sw) click(SN(sw));
    await flushAsync();
    // The LAST modal: an earlier section may have left one open, and answering that one would test nothing.
    const surface = qsa(SN(document.body) as unknown as ShimNode, ".dialog--modal").at(-1);
    const confirm = surface ? findButtonByText(surface, c.confirm) : null;
    ok(`${c.name}: the confirm modal is presented`, confirm !== null);
    if (confirm) click(confirm);
    await flushAsync();
    await flushAsync();
    ok(`${c.name}: the switch re-read the policy after the save (${reads} reads)`, reads === 2);
    ok(`${c.name}: the switch paints the re-read value, not a guessed Off`, textOf(root).includes(c.onText) && sw?.getAttribute("aria-checked") === "true");
  }

  setCaller(null);
  console.log(failures === 0 ? "\nSIGN-IN CONTEXT REFUSAL PASS" : `\nSIGN-IN CONTEXT REFUSAL: ${failures} FAILED`);
  verdictReached(failures); // prints the single VERDICT line itself; do not print a second one
  process.exit(failures === 0 ? 0 : 1);
}

void main();
