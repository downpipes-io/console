// Prove the demo (tour and training) faked engine carries notifyNewSignInContext and answers the
// switch's write, so the /security "notify on a new sign-in location" control never reads Unavailable
// in a public walk.
// Run with: node test/validate-demo-signin-context-policy.ts
//
// WHY THIS EXISTS. loadPolicy (src/screens/security-centre/signin-context.ts) treats a policy reply
// without notifyNewSignInContext exactly like a failed read: the switch is disabled, the label reads
// "Unavailable", and Try again re-reads the SAME seeded reply, so it never recovers. The real engine
// always sends this field (getOrgPolicyView). The demo's seeded policy must carry the field, and the
// demo must answer the switch's own POST, so a click saves and reads back. Both are demo data, not the
// control: this test drives the demo's faked engine, not a stub, so a regression in either the seed or
// the write route fails here.

import { installDomShim, flushAsync, qsa, textOf, type ShimNode } from "./dom-shim.ts";

installDomShim();

const g = globalThis as unknown as { location?: unknown };
g.location = g.location ?? { origin: "https://console.test", search: "", hostname: "console.test", href: "https://console.test/" };

import { EngineClient } from "../src/api.ts";
import { signInContextControl } from "../src/screens/security-centre/signin-context.ts";
import { setCaller } from "../src/lib/store.ts";
import type { Caller } from "../src/lib/api/types/who.ts";
import { installDemoFetch } from "../src/lib/demo/demo-fetch.ts";
import { applyDemoState, resetWorld, world } from "../src/lib/demo/demo-world.ts";
import { findButtonByText, click, SN } from "./validate-stable-components-shared.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function owner(): Caller {
  return { method: "access", subject: "sub-owner", email: "owner@northwind.example", role: "owner", groups: [], isOnlyOwner: false };
}

function switchOf(root: HTMLElement): HTMLElement | undefined {
  return qsa(root, '[role="switch"]')[0] as HTMLElement | undefined;
}

async function main(): Promise<void> {
  console.log("DEMO SIGN-IN CONTEXT POLICY: the seed carries the field and the switch saves\n");

  const realFetch = installDemoFetch();
  const engine = new EngineClient("https://console.test");

  // -----------------------------------------------------------------------------------------------
  // 1. The seeded tour world's approval-policy GET answers WITH notifyNewSignInContext. This is the
  //    exact reply shape signInContextControl reads: a reply missing the field is what an OLDER
  //    engine looks like, and the demo engine is not one.
  // -----------------------------------------------------------------------------------------------
  console.log("1. the tour world's policy reply carries notifyNewSignInContext:");
  resetWorld();
  const policyReply = await engine.getConfigApprovalPolicy();
  ok("the field is present (not undefined)", policyReply.notifyNewSignInContext !== undefined);
  ok("it starts OFF, the engine's own opt-in default", policyReply.notifyNewSignInContext === false);

  // -----------------------------------------------------------------------------------------------
  // 2. The training-start world (a fresh account) answers the same way: the field survives the
  //    training override, not only the tour's default seed.
  // -----------------------------------------------------------------------------------------------
  console.log("\n2. the training-start world's policy reply also carries the field:");
  applyDemoState({ kind: "training-start" });
  const trainingPolicy = await engine.getConfigApprovalPolicy();
  ok("training-start: the field is present", trainingPolicy.notifyNewSignInContext !== undefined);
  resetWorld();

  // -----------------------------------------------------------------------------------------------
  // 3. Driven through the real screen: the control never reads Unavailable in the tour, and pressing
  //    it round-trips through the demo's own write route, not a fabricated always-off reply.
  // -----------------------------------------------------------------------------------------------
  console.log("\n3. the rendered switch is available, and a toggle round-trips through the demo engine:");
  setCaller(owner());
  const root = signInContextControl(engine);
  await flushAsync(2);
  const text1 = textOf(root);
  ok("the switch does not read Unavailable", !text1.includes("Unavailable"));
  ok("the state line reads Off (the seeded default), not a read failure", text1.includes("Off: sign-ins do not check for a new location."));
  const sw = switchOf(root) as HTMLButtonElement | undefined;
  ok("the switch is enabled for an Owner", sw?.disabled === false);
  ok("the switch starts unchecked", sw?.getAttribute("aria-checked") === "false");

  sw?.click();
  await flushAsync();
  const surface = qsa(SN(document.body) as unknown as ShimNode, ".dialog--modal").at(-1);
  const confirm = surface ? findButtonByText(surface, "Turn on") : null;
  ok("the confirm modal opens on click", confirm !== null);
  if (confirm) click(confirm);
  await flushAsync(2);

  const text2 = textOf(root);
  ok("after saving, the switch reads On", sw?.getAttribute("aria-checked") === "true");
  ok("the state line reflects the saved value", text2.includes("On: an unusual sign-in location sends a warning notification."));

  // The world itself carries the saved value, proving the write reached the demo engine's own state
  // (not just a value painted from the save reply and forgotten).
  ok("the world's own policy now holds the saved value", world.configApprovalPolicy.notifyNewSignInContext === true);

  // A fresh read (a reload of the screen) sees the SAME value: the write persisted on the world, it did
  // not just paint the switch from the POST reply once.
  const rootAgain = signInContextControl(engine);
  await flushAsync(2);
  ok("a fresh render of the control also reads On", textOf(rootAgain).includes("On: an unusual sign-in location sends a warning notification."));

  setCaller(null);
  globalThis.fetch = realFetch;
  resetWorld();
  console.log(failures === 0 ? "\nDEMO SIGN-IN CONTEXT POLICY PASS" : `\nDEMO SIGN-IN CONTEXT POLICY: ${failures} FAILED`);
  verdictReached(failures); // prints the single VERDICT line itself; do not print a second one
  process.exit(failures === 0 ? 0 : 1);
}

void main();
