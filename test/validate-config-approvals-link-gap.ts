// The Config approvals page's "where do I turn this on or off?" line (config-changes.ts) sits directly
// under the "Approvals and change numbers" doc link. A negative top margin pulled it up far enough to
// overlap the link by 8px at 1440 wide. Pure layout cannot be measured under a DOM shim with no real box
// model, so this pins what CAN be checked in Node: the paragraph's declared spacing token is never a
// negative one, which is the exact cause of the overlap.
// Run with: node test/validate-config-approvals-link-gap.ts

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import type { Caller, ConfigChange } from "../src/api.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;

function ok(label: string, cond: boolean): void {
  checks += 1;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures += 1;
}

async function main(): Promise<void> {
  const screenMod = await import("../src/screens/config-changes.ts");
  const store = await import("../src/lib/store.ts");
  const nav = await import("../src/lib/nav.ts");
  nav.installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

  const caller: Caller = { method: "access", email: "checker@example.com", role: "owner", groups: [], isOnlyOwner: false };
  store.setCaller(caller);
  store.connect("https://engine.test");
  const engine = store.getEngine()!;
  (engine as unknown as { listConfigChanges: () => Promise<ConfigChange[]> }).listConfigChanges = async () => [];

  const root = screenMod.configChangesScreen.render({
    pattern: "/config/changes", params: {}, query: new URLSearchParams(), path: "/config/changes",
    engine, caller, navigate: () => {},
  }) as unknown as HTMLElement;

  // The quiet hand-off line: "Turn this requirement on or off in Dual control (Security centre). See the
  // full config version history for every change that has been applied."
  const lines = [...root.querySelectorAll("p")];
  const target = lines.find((p) => (p.textContent ?? "").includes("Turn this requirement on or off in"));
  ok("the hand-off line renders", target !== undefined);
  const marginTop = target ? target.style.getPropertyValue("margin-top") : "";
  ok("the hand-off line declares a margin-top", marginTop !== "");
  const isNegative = marginTop.trim().startsWith("-") || /calc\(\s*-/.test(marginTop);
  ok(
    `the hand-off line's margin-top ("${marginTop}") is not a negative token, which is what pulled it under the doc link above and caused the 8px overlap`,
    !isNegative,
  );

  verdictReached(failures, checks);
  console.log(`validate-config-approvals-link-gap: ${checks} checks, ${failures} failures`);
  if (failures > 0) {
    console.error(`validate-config-approvals-link-gap: ${failures} FAILURES`);
    process.exitCode = 1;
  }
}

void main();
