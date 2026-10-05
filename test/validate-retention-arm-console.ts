// The console side of "arming the scheduled prune needs restore.apply" (engine 7e88e25c). The
// engine's addDownpipe re-checks restore.apply, beyond downpipe.write, for an upsert that lets the
// cron retention pass delete more (retentionWidensPrune, engine/src/sched/destinations.ts): arming
// enforce where it is off, or, while enforce stays on, lowering or removing a keepRuns/keepDays bound
// or unpinning a replica. This file drives the console's client mirror of that rule against the real
// code: the Enforce checkbox is disabled-with-reason for a caller without restore.apply when enforce
// is off; the retention section's resolve() stops a narrowing edit before submit, in the same words;
// and the editor names the cause when the engine still refuses (a stale capability read), instead of
// the generic "ask an Owner" authority sentence. No jsdom, no network: the DOM uses the shared shim
// and the engine is a recording stub.
//
// Run with `node test/validate-retention-arm-console.ts`.

import { flushAsync, installDomShim, qs, qsa, textOf } from "./dom-shim.ts";

installDomShim();

import type { Caller, Downpipe } from "../src/api.ts";
import { EngineClient } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { setCaller } from "../src/lib/store.ts";
import { buildRetentionSection } from "../src/screens/sources-downpipes/editor-retention-section.ts";
import { openEditor } from "../src/screens/sources-downpipes/editor-upsert.ts";
import { RETENTION_ARM_REASON, retentionWidensPrune } from "../src/screens/sources-downpipes/helpers.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

const OPERATOR: Caller = { method: "access", email: "op@test", role: "operator", groups: [], isOnlyOwner: false };
const APPROVER: Caller = { method: "access", email: "appr@test", role: "approver", groups: [], isOnlyOwner: false };

function inputEl(root: unknown, id: string): { value: string } {
  const el = qs(root, `#${id}`);
  if (el === null) throw new Error(`no control #${id}`);
  return el as unknown as { value: string };
}

async function main(): Promise<void> {
  console.log("-- (A) retentionWidensPrune, the pure mirror of the engine's rule --");
    // An arm: enforce was not on before (a create, or a downpipe with no stored policy).
    ok("(A1) create with enforce true widens", retentionWidensPrune(undefined, { retention: { keepRuns: 5, enforce: true } }));
    ok("(A2) arm from stored enforce false widens", retentionWidensPrune({ retention: { keepRuns: 5, enforce: false } }, { retention: { keepRuns: 5, enforce: true } }));
    // A lowered or removed bound while enforce stays on widens; raising or adding one does not.
    ok("(A3) lowering keepRuns while armed widens", retentionWidensPrune({ retention: { keepRuns: 10, enforce: true } }, { retention: { keepRuns: 5, enforce: true } }));
    ok("(A4) removing keepRuns while armed widens", retentionWidensPrune({ retention: { keepRuns: 10, enforce: true } }, { retention: { enforce: true } }));
    ok("(A5) raising keepRuns while armed does not widen", !retentionWidensPrune({ retention: { keepRuns: 10, enforce: true } }, { retention: { keepRuns: 20, enforce: true } }));
    // A round trip (the same stored value) does not widen.
    ok("(A6) a round trip does not widen", !retentionWidensPrune({ retention: { keepRuns: 10, enforce: true } }, { retention: { keepRuns: 10, enforce: true } }));
    // Turning enforce off never widens, whatever the bounds do.
    ok("(A7) turning enforce off never widens", !retentionWidensPrune({ retention: { keepRuns: 10, enforce: true } }, { retention: { enforce: false } }));
    // An unpinned replica while armed widens; adding one does not.
    ok("(A8) unpinning a replica while armed widens", retentionWidensPrune({ retention: { keepRuns: 10, enforce: true }, destinationIds: ["d1", "d2"] }, { retention: { keepRuns: 10, enforce: true }, destinationIds: ["d1"] }));
    ok("(A9) adding a replica while armed does not widen", !retentionWidensPrune({ retention: { keepRuns: 10, enforce: true }, destinationIds: ["d1"] }, { retention: { keepRuns: 10, enforce: true }, destinationIds: ["d1", "d2"] }));

  console.log("\n-- (B) the Enforce checkbox: disabled-with-reason for a caller without restore.apply --");
  {
    setCaller(OPERATOR);
    const sec = buildRetentionSection(null);
    const cb = qs(sec.el, "#dp-retention-enforce") as unknown as { getAttribute: (n: string) => string | null };
    ok("(B1) an Operator creating a downpipe: the checkbox is disabled", cb.getAttribute("aria-disabled") === "true");
    const reason = qs(sec.el, "#dp-retention-enforce-disabled-reason");
    ok("(B2) the reason names restore.apply and the roles that hold it", reason !== null && textOf(reason) === RETENTION_ARM_REASON);
  }
  {
    setCaller(APPROVER);
    const sec = buildRetentionSection(null);
    const cb = qs(sec.el, "#dp-retention-enforce") as unknown as { getAttribute: (n: string) => string | null };
    ok("(B3) an Approver creating a downpipe: the checkbox is not disabled", cb.getAttribute("aria-disabled") !== "true");
  }
  {
    setCaller(OPERATOR);
    const existing = { id: "dp-1", name: "Existing", cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: "KV_x", include: [], exclude: [] }, retention: { keepRuns: 10, enforce: true } } as Downpipe;
    const sec = buildRetentionSection(existing);
    const cb = qs(sec.el, "#dp-retention-enforce") as unknown as { getAttribute: (n: string) => string | null };
    ok("(B4) an Operator editing an already-armed downpipe: the checkbox stays open (turning it off needs only downpipe.write)", cb.getAttribute("aria-disabled") !== "true");
  }

  console.log("\n-- (C) resolve(): a narrowing edit is stopped before submit, in the same words --");
  {
    setCaller(OPERATOR);
    const existing = { id: "dp-1", name: "Existing", cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: "KV_x", include: [], exclude: [] }, retention: { keepRuns: 10, keepDays: 30, enforce: true }, destinationIds: ["d1", "d2"] } as Downpipe;

    const lowered = buildRetentionSection(existing);
    inputEl(lowered.el, "dp-keep-runs").value = "5";
    const loweredResult = lowered.resolve(["d1", "d2"]);
    ok("(C1) an Operator lowering keepRuns while armed is blocked", loweredResult.error === true);
    ok("(C1b) with the reason named, word for word", textOf(qs(lowered.el, "#dp-retention-error")!) === RETENTION_ARM_REASON);

    const removed = buildRetentionSection(existing);
    inputEl(removed.el, "dp-keep-runs").value = "";
    const removedResult = removed.resolve(["d1", "d2"]);
    ok("(C2) an Operator removing keepRuns while keepDays stays armed is blocked", removedResult.error === true);

    const raised = buildRetentionSection(existing);
    inputEl(raised.el, "dp-keep-runs").value = "20";
    const raisedResult = raised.resolve(["d1", "d2"]);
    ok("(C3) an Operator raising keepRuns while armed stays open", raisedResult.error === false && raisedResult.policy?.keepRuns === 20);

    const roundTrip = buildRetentionSection(existing);
    const roundTripResult = roundTrip.resolve(["d1", "d2"]);
    ok("(C4) a round trip (nothing changed) stays open", roundTripResult.error === false);

    const turnedOff = buildRetentionSection(existing);
    inputEl(turnedOff.el, "dp-keep-runs").value = "5";
    (qs(turnedOff.el, "#dp-retention-enforce") as unknown as { checked: boolean }).checked = false;
    const turnedOffResult = turnedOff.resolve(["d1", "d2"]);
    ok("(C5) turning enforce off, even while lowering a bound, stays open", turnedOffResult.error === false);

    const replicaRemoved = buildRetentionSection(existing);
    const replicaRemovedResult = replicaRemoved.resolve(["d1"]);
    ok("(C6) an Operator unticking a replica while armed is blocked", replicaRemovedResult.error === true);

    const replicaAdded = buildRetentionSection(existing);
    const replicaAddedResult = replicaAdded.resolve(["d1", "d2", "d3"]);
    ok("(C7) an Operator ticking an extra replica while armed stays open", replicaAddedResult.error === false);

    // Control: an Approver (holds restore.apply) is never gated by this rule.
    setCaller(APPROVER);
    const asApprover = buildRetentionSection(existing);
    inputEl(asApprover.el, "dp-keep-runs").value = "5";
    const asApproverResult = asApprover.resolve(["d1"]);
    ok("(C8) control: an Approver lowering a bound AND unpinning a replica stays open", asApproverResult.error === false);
  }

  console.log("\n-- (D) the editor names the cause when the engine still refuses (a stale capability read) --");
  {
    setCaller(APPROVER); // the client gate passes: the form is submitted
    (document.body as unknown as { replaceChildren: () => void }).replaceChildren();
    const engine = new EngineClient("https://engine.test");
    const stub = engine as unknown as Record<string, unknown>;
    stub.discoverSources = async () => ({ bound: { kv: [], r2: [], d1: [], secrets: [] }, tokenPresent: false });
    stub.listDestinations = async () => ({ destinations: [{ id: "d1", label: "Primary" }, { id: "d2", label: "Secondary" }], defaultId: "d1" });
    stub.getDestination = async () => ({ configured: true, kind: "r2" });
    stub.addDownpipe = async () => {
      // The DO's AuthError funnel for the restore.apply re-check: a generic {"error":"forbidden"} 403,
      // classified engine-authz (no `required` field), exactly as scheduler-do.ts's own funnel answers.
      throw new Error("add downpipe: forbidden-class=engine-authz: 403");
    };
    const existing = { id: "dp-1", name: "Existing", cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: "KV_x", include: [], exclude: [] }, retention: { keepRuns: 10, enforce: true } } as Downpipe;
    openEditor(engine, existing, null, () => {}, () => {}, undefined, 7);
    await flushAsync(20);
    inputEl(document.body, "dp-keep-runs").value = "5"; // narrows the armed policy
    const saveBtn = qsa(document.body, "button").find((b) => /^Save changes$/.test(textOf(b)));
    saveBtn?.click();
    await flushAsync(20);
    const visible = qsa(document.body, ".field__error").find((e) => (e as unknown as { hidden: boolean }).hidden === false && textOf(e) !== "");
    ok("(D1) the drawer shows a visible form error", visible !== undefined);
    ok("(D2) it names restore.apply and the roles that hold it, not the generic authority sentence", visible !== undefined && textOf(visible).includes(RETENTION_ARM_REASON) && !textOf(visible).includes("Ask an Owner"));
  }

  console.log("\n-- (D control) an unrelated engine-authz refusal keeps its generic sentence --");
  {
    setCaller(APPROVER);
    (document.body as unknown as { replaceChildren: () => void }).replaceChildren();
    const engine = new EngineClient("https://engine.test");
    const stub = engine as unknown as Record<string, unknown>;
    stub.discoverSources = async () => ({ bound: { kv: [], r2: [], d1: [], secrets: [] }, tokenPresent: false });
    stub.listDestinations = async () => ({ destinations: [{ id: "d1", label: "Primary" }, { id: "d2", label: "Secondary" }], defaultId: "d1" });
    stub.getDestination = async () => ({ configured: true, kind: "r2" });
    stub.addDownpipe = async () => {
      throw new Error("add downpipe: forbidden-class=engine-authz: 403");
    };
    const existing = { id: "dp-1", name: "Existing", cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: "KV_x", include: [], exclude: [] }, retention: { keepRuns: 10, enforce: true } } as Downpipe;
    openEditor(engine, existing, null, () => {}, () => {}, undefined, 7);
    await flushAsync(20);
    inputEl(document.body, "dp-keep-runs").value = "20"; // RAISES the bound: not a widening edit
    const saveBtn = qsa(document.body, "button").find((b) => /^Save changes$/.test(textOf(b)));
    saveBtn?.click();
    await flushAsync(20);
    const visible = qsa(document.body, ".field__error").find((e) => (e as unknown as { hidden: boolean }).hidden === false && textOf(e) !== "");
    ok("(control) a non-widening edit refused engine-authz keeps the generic authority sentence", visible !== undefined && textOf(visible).includes("Ask an Owner") && !textOf(visible).includes(RETENTION_ARM_REASON));
  }

  console.log(failures === 0 ? "\nRETENTION-ARM-CONSOLE PASS" : `\nRETENTION-ARM-CONSOLE FAIL (${failures})`);
  verdictReached(failures, checks);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
