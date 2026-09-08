// Validates the guided-setup brain (src/lib/setup-state.ts): the step derivation
// from raw facts, the fail-open rules, and the route gate. These are the pure
// pieces the shell strip, the rail lock and the redirect all key off, so a
// regression here mis-locks the whole console; the one thing the gate must
// never do (fail-open is the contract).

import { deriveSetup, setupAllows, setupLockReason } from "../src/lib/setup-state.ts";
import type { SetupState } from "../src/api.ts";

let failures = 0;
function ok(name: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

function facts(overrides: Partial<SetupState>): SetupState {
  return {
    keysReady: false,
    signerConfigured: false,
    breakGlassConfigured: false,
    emailConfigured: false,
    discoveryTokenPresent: false,
    accountsSelected: false,
    destination: { configured: false, verified: false, kind: null, source: null },
    boundSourceCount: 0,
    downpipeCount: 0,
    anyRunCompleted: false,
    ready: false,
    ...overrides,
  };
}

console.log("-- deriveSetup: the five steps in dependency order --");
{
  const v = deriveSetup(facts({}));
  ok("a fresh engine derives five steps", v.steps.length === 5);
  ok("the order is keys, destination, connect, sources, downpipe", v.steps.map((s) => s.id).join(",") === "keys,destination,connect,sources,downpipe");
  ok("nothing done -> step 1 (keys) is current", v.currentIndex === 0 && v.current.id === "keys");
  ok("a fresh engine is not complete", !v.complete);
  ok("stepNumber is 1-based for the strip copy", v.stepNumber === 1);
}

console.log("-- deriveSetup: progress moves the current step (destination before connect) --");
{
  const v = deriveSetup(facts({ keysReady: true }));
  ok("keys done -> destination is current", v.current.id === "destination");
  const v2 = deriveSetup(facts({ keysReady: true, destination: { configured: true, verified: true, kind: "s3", source: "console" } }));
  ok("destination configured -> connect is current", v2.current.id === "connect");
  const v3 = deriveSetup(facts({ keysReady: true, destination: { configured: true, verified: true, kind: "s3", source: "console" }, discoveryTokenPresent: true }));
  ok("token present -> sources is current", v3.current.id === "sources");
  const v4 = deriveSetup(facts({ keysReady: true, destination: { configured: true, verified: true, kind: "s3", source: "console" }, discoveryTokenPresent: true, boundSourceCount: 2 }));
  ok("sources bound -> downpipe is current", v4.current.id === "downpipe");
  const v5 = deriveSetup(facts({ keysReady: true, destination: { configured: true, verified: true, kind: "s3", source: "console" }, discoveryTokenPresent: true, boundSourceCount: 2, downpipeCount: 1 }));
  ok("everything done -> complete", v5.complete);
}

console.log("-- deriveSetup: IaC transparency (env facts skip steps) --");
{
  // A wrangler-configured deployment: bound sources + env destination, no token.
  const v = deriveSetup(facts({ keysReady: true, boundSourceCount: 3, destination: { configured: true, verified: false, kind: "r2", source: "deploy" } }));
  ok("bound sources satisfy the connect step without a token", v.steps.find((s) => s.id === "connect")!.done);
  ok("a deploy-time destination satisfies the destination step", v.steps.find((s) => s.id === "destination")!.done);
  ok("the IaC deployment lands on the downpipe step directly", v.current.id === "downpipe");
}

console.log("-- deriveSetup: fail-open on absent DO facts --");
{
  const v = deriveSetup(facts({ keysReady: true, discoveryTokenPresent: true, destination: { configured: true, verified: true, kind: "s3", source: "console" }, boundSourceCount: 1 }));
  ok("a present downpipeCount of 0 keeps the downpipe step incomplete", !v.complete);
  const noCount = facts({ keysReady: true, discoveryTokenPresent: true, destination: { configured: true, verified: true, kind: "s3", source: "console" }, boundSourceCount: 1 });
  delete (noCount as Partial<SetupState>).downpipeCount;
  const v2 = deriveSetup(noCount);
  ok("an ABSENT downpipeCount reads done (fail-open: a DO hiccup never re-locks)", v2.complete);
}

console.log("-- deriveSetup: a downpipe implies sources picked (monotonic; tolerant of a dropped binding) --");
{
  // A downpipe EXISTS but the source BINDING reads 0 (e.g. an engine redeploy that did not preserve a
  // console-attached binding dropped it, while the downpipe survived in the Durable Object). Step 4 ("Pick
  // what to protect") must still read DONE because step 5 ("Create your first downpipe") is done: you cannot
  // create a downpipe without picking a source. The checklist must never show step 4 incomplete with step 5
  // ticked.
  const v = deriveSetup(facts({ keysReady: true, discoveryTokenPresent: true, destination: { configured: true, verified: true, kind: "s3", source: "console" }, boundSourceCount: 0, downpipeCount: 1 }));
  ok("a downpipe with a dropped source binding still reads the sources step DONE", v.steps.find((s) => s.id === "sources")!.done);
  ok("a downpipe also reads the connect step done", v.steps.find((s) => s.id === "connect")!.done);
  ok("the whole setup reads complete despite boundSourceCount 0 (step 5 implies step 4)", v.complete);
  // The genuine empty case is unchanged: no source AND no downpipe leaves step 4 incomplete.
  const empty = deriveSetup(facts({ keysReady: true, discoveryTokenPresent: true, destination: { configured: true, verified: true, kind: "s3", source: "console" }, boundSourceCount: 0, downpipeCount: 0 }));
  ok("no source and no downpipe still leaves the sources step incomplete", !empty.steps.find((s) => s.id === "sources")!.done);
}

console.log("-- setupAllows: the forcing, without traps (destination before sources) --");
{
  // keys done, destination NOT yet configured: the current step is destination (step 2 of 5), so Sources
  // and everything past it stay LOCKED until a destination exists (the owner's setup-first order).
  const v = deriveSetup(facts({ keysReady: true })); // current: destination (step 2)
  ok("the current step's home is allowed", setupAllows("/destinations", v));
  ok("an earlier step's home stays allowed (keys)", setupAllows("/keys", v));
  ok("SOURCES is locked until a destination exists", !setupAllows("/sources", v) && !setupAllows("/sources/advanced", v));
  ok("a later step's home is locked", !setupAllows("/downpipes", v));
  ok("a non-setup screen is locked", !setupAllows("/runs", v) && !setupAllows("/restore", v) && !setupAllows("/notifications", v));
  ok("Overview is always allowed (the checklist lives there)", setupAllows("/", v));
  ok("Settings is always allowed", setupAllows("/settings", v));
  ok("Keys and the onboarding wizard are always allowed", setupAllows("/keys", v) && setupAllows("/onboarding/:step", v));
  ok("the auth routes are always allowed", setupAllows("/passkey", v) && setupAllows("/register", v) && setupAllows("/signed-out", v));
  ok("the palette landing is always allowed (rail help link)", setupAllows("/command-palette", v));
  ok("Licence and updates is always allowed (system-level, no downpipe dependency)", setupAllows("/licence", v));
  ok("Costs is always allowed (browser-local planning calculator, no downpipe dependency)", setupAllows("/costs", v));
  ok("Security centre and owner approvals are always allowed (account-security, no downpipe dependency)", setupAllows("/security", v) && setupAllows("/security/owner-actions", v));
  ok("the lock reason names the current step number", setupLockReason(v).includes("step 2 of 5"));
}

console.log("-- setupAllows: a zero-downpipe estate can still reach Licence and Costs --");
{
  // Every earlier step done, only the downpipe step (5 of 5) outstanding: the exact shape of a
  // brand-new customer, and the shape that locked Licence for an estate's entire life before the fix.
  const v = deriveSetup(facts({ keysReady: true, discoveryTokenPresent: true, destination: { configured: true, verified: true, kind: "s3", source: "console" }, boundSourceCount: 1, downpipeCount: 0 }));
  ok("a fresh engine with zero downpipes lands on the downpipe step", v.current.id === "downpipe" && !v.complete);
  ok("Licence and updates is reachable on a zero-downpipe estate", setupAllows("/licence", v));
  ok("Costs is reachable on a zero-downpipe estate", setupAllows("/costs", v));
  ok("Security centre is reachable on a zero-downpipe estate (retiring the bootstrap admin token cannot wait on a downpipe)", setupAllows("/security", v));
  // The System group's exemption is narrow: it does not spill over into unrelated, genuinely
  // data-dependent screens still correctly locked at this step.
  ok("Runs, Restore and Notifications stay locked at the same step (unaffected by the fix)", !setupAllows("/runs", v) && !setupAllows("/restore", v) && !setupAllows("/notifications", v));
}

console.log("-- setupAllows: a configured destination unlocks Sources --");
{
  // Once the destination is configured, the connect step (read-only token, on /sources) becomes current,
  // so Sources and its sub-routes unlock; downpipes still waits for at least one bound source.
  const v = deriveSetup(facts({ keysReady: true, destination: { configured: true, verified: true, kind: "s3", source: "console" } }));
  ok("connect is current once a destination exists", v.current.id === "connect");
  ok("Sources and its sub-routes unlock with the connect step", setupAllows("/sources", v) && setupAllows("/sources/advanced", v));
  ok("downpipes stays locked until a source is bound", !setupAllows("/downpipes", v));
}

console.log("-- setupAllows: complete unlocks everything --");
{
  const v = deriveSetup(facts({ keysReady: true, discoveryTokenPresent: true, destination: { configured: true, verified: true, kind: "s3", source: "console" }, boundSourceCount: 1, downpipeCount: 1 }));
  ok("complete -> every route allowed", setupAllows("/runs", v) && setupAllows("/restore", v) && setupAllows("/reports", v) && setupAllows("/downpipes", v));
}

if (failures > 0) process.exitCode = 1;
if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nSETUP-STATE VECTORS PASS");
