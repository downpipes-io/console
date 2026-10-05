// The setup wizard's two dated retention presets ("Keep 90 days", "Keep 365 days") arm enforce:true, the
// same edit the downpipe editor gates on restore.apply (validate-retention-arm-console.ts). A caller
// without restore.apply who runs First backup with one of these presets had every planned downpipe
// refused by the engine's addDownpipe restore.apply re-check. retentionChoices (lib/setup-flow/inventory.ts)
// now takes the caller's own capGateReason("restore.apply") and marks both presets unavailable with it;
// planDownpipes (lib/setup-flow/actions-apply.ts) and the Focus Flow retention sheet (screens/setup/b/
// retention.ts) both read the real capability before offering them. "Keep every run" and the operator's own
// limits are untouched.
//
// Driven against the real wizard model (setup-surface-harness.ts, the demo engine the tour and training
// course run on), swapping the caller's identity in place so the same account, picks and posture serve
// every role without repeating the ceremony.
//
// Run with `node test/validate-retention-arm-wizard.ts`.

import { installDomShim, qs, textOf } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const harness = await import("./setup-surface-harness.ts");
const sf = await import("../src/lib/setup-flow/index.ts");
const { setCaller } = await import("../src/lib/store.ts");
const { installNav } = await import("../src/lib/nav.ts");
const { capGateReason } = await import("../src/screens/common.ts");
const { RETENTION_ARM_REASON } = await import("../src/screens/sources-downpipes/helpers.ts");
const { retentionSheet } = await import("../src/screens/setup/b/retention.ts");
type Caller = import("../src/api.ts").Caller;
type QCtx = import("../src/screens/setup/b/types.ts").QCtx;

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function quietNav(): void {
  installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
}

const OPERATOR: Caller = { method: "access", email: "op@northwind.example", role: "operator", groups: [], isOnlyOwner: false } as Caller;
const APPROVER: Caller = { method: "access", email: "appr@northwind.example", role: "approver", groups: [], isOnlyOwner: false } as Caller;

// setUpOperationalWorld starts a fresh demo account (as Owner, so the token, destination and posture ack
// are unblocked), connects the read-only token and a destination so discovery lists resources, acknowledges
// the operational posture and ticks one resource, then leaves the model ready for a caller swap and a
// retention pick. Returns the model.
async function setUpOperationalWorld(): Promise<ReturnType<typeof sf.setupModel>> {
  harness.resetSetupWorld(harness.OWNER);
  quietNav();
  const m = sf.setupModel();
  m.reset();
  await m.refresh();
  await sf.verifyToken("cf-read-only-demo");
  m.update({ provider: "r2", bucket: "northwind-backups" });
  const saved = await sf.saveDestination({ accessKeyId: "AKID", secretAccessKey: "secret" });
  if (!saved.ok) throw new Error(`setup fixture: saveDestination failed: ${JSON.stringify(saved)}`);
  const ack = await sf.acknowledgePosture("operational");
  if (!ack.ok) throw new Error(`setup fixture: acknowledgePosture failed: ${JSON.stringify(ack)}`);
  const pick = m.get().facts.groups.flatMap((g) => g.resources).find((r) => r.unavailable === undefined);
  if (pick === undefined) throw new Error("setup fixture: no available resource to pick");
  m.update({ picks: [pick.key], schedule: "daily" });
  return m;
}

async function main(): Promise<void> {
  console.log("-- (A) retentionChoices: the two dated presets carry the reason; Keep every run does not --");
  {
    const open = sf.retentionChoices("operational");
    ok("(A1) with no reason, every preset is open", open.every((x) => x.unavailable === undefined));
    const reason = "Requires permission to apply a restore; your Operator role does not hold it.";
    const gated = sf.retentionChoices("operational", reason);
    ok("(A2) Keep every run stays open", gated.find((x) => x.id === "keep-all")?.unavailable === undefined);
    ok("(A3) Keep 90 days carries the reason", gated.find((x) => x.id === "90-days")?.unavailable === reason);
    ok("(A4) Keep 365 days carries the reason", gated.find((x) => x.id === "365-days")?.unavailable === reason);
    const offline = sf.retentionChoices("break-glass-only", reason);
    ok("(A5) offline key only wins over the restore.apply reason", offline.find((x) => x.id === "90-days")?.unavailable === "Offline key only: pruning does not run in your engine.");
  }

  console.log("\n-- (B) planDownpipes: an Operator's dated preset is refused; an Approver's is accepted --");
  {
    const m = await setUpOperationalWorld();
    m.update({ retention: "90-days" });

    setCaller(OPERATOR);
    const asOperator = sf.planDownpipes();
    ok("(B1) an Operator's 90-day preset is refused on the retention field", !asOperator.ok && asOperator.error.field === "retention");
    ok("(B2) with the restore.apply reason, not a generic message", !asOperator.ok && asOperator.error.message === capGateReason("restore.apply"));

    setCaller(APPROVER);
    const asApprover = sf.planDownpipes();
    ok("(B3) an Approver's 90-day preset is accepted", asApprover.ok && asApprover.data.every((p) => p.dp.retention?.keepDays === 90 && p.dp.retention?.enforce === true));

    // Control: "Keep every run" needs no capability at all, for the same Operator.
    setCaller(OPERATOR);
    m.update({ retention: "keep-all" });
    const keepAll = sf.planDownpipes();
    ok("(B4) control: an Operator's Keep every run is accepted", keepAll.ok && keepAll.data.every((p) => p.dp.retention === undefined));
  }

  console.log("\n-- (C) createDownpipes: the same Operator is refused end to end, not partway through the bulk call --");
  {
    const m = await setUpOperationalWorld();
    m.update({ retention: "365-days" });
    setCaller(OPERATOR);
    const created = await sf.createDownpipes();
    ok("(C1) the Operator's create is refused before any engine call, on the retention field", !created.ok && created.error.field === "retention");
  }

  console.log("\n-- (D) the Focus Flow sheet's own custom-limits Enforce checkbox --");
  {
    const m = await setUpOperationalWorld();
    const noop: QCtx = { rerender: () => {} } as unknown as QCtx;

    setCaller(OPERATOR);
    m.update({ retentionCustom: { keepRuns: 30, enforce: false } }); // selects the "custom" tile
    (document.body as unknown as { replaceChildren: () => void }).replaceChildren();
    retentionSheet(noop);
    const opBox = qs(document.body, ".fb-check__input") as unknown as { disabled: boolean } | null;
    const opLine = qs(document.body, ".fb-check__line");
    ok("(D1) an Operator's own-limits Enforce checkbox is disabled", opBox !== null && opBox.disabled === true);
    ok("(D2) with RETENTION_ARM_REASON as the visible reason", opLine !== null && textOf(opLine) === RETENTION_ARM_REASON);

    setCaller(APPROVER);
    (document.body as unknown as { replaceChildren: () => void }).replaceChildren();
    retentionSheet(noop);
    const apBox = qs(document.body, ".fb-check__input") as unknown as { disabled: boolean } | null;
    const apLine = qs(document.body, ".fb-check__line");
    ok("(D3) an Approver's own-limits Enforce checkbox stays open", apBox !== null && apBox.disabled === false);
    ok("(D4) with its plain hint, not the permission reason", apLine !== null && textOf(apLine) !== RETENTION_ARM_REASON);

    // The checkbox never starts checked for a caller without restore.apply, even from a draft made while
    // they (or somebody else on this account) held it: the sheet reads canArm before it reads the draft.
    setCaller(OPERATOR);
    m.update({ retentionCustom: { keepRuns: 30, enforce: true } });
    (document.body as unknown as { replaceChildren: () => void }).replaceChildren();
    retentionSheet(noop);
    const staleBox = qs(document.body, ".fb-check__input") as unknown as { checked: boolean; disabled: boolean } | null;
    ok("(D5) a stale enforced draft renders unchecked and disabled for an Operator", staleBox !== null && staleBox.checked === false && staleBox.disabled === true);
  }

  console.log("\n-- (E) planDownpipes refuses an enforced custom draft for an Operator however it got there --");
  {
    const m = await setUpOperationalWorld();
    // Bypasses the sheet entirely: a stale draft, a race with a role change, or any other way the model
    // could hold an armed custom policy. planDownpipes is the one place every path (a single create, the
    // bulk create, and the First backup preview) reads it, so it is where the gate must hold regardless.
    m.update({ retentionCustom: { keepRuns: 30, enforce: true } });

    setCaller(OPERATOR);
    const asOperator = sf.planDownpipes();
    ok("(E1) an Operator's enforced custom draft is refused on the retention field", !asOperator.ok && asOperator.error.field === "retention");
    ok("(E2) with the restore.apply reason", !asOperator.ok && asOperator.error.message === capGateReason("restore.apply"));
    const createdAsOperator = await sf.createDownpipes();
    ok("(E3) createDownpipes refuses it too, before any engine call", !createdAsOperator.ok && createdAsOperator.error.field === "retention");

    setCaller(APPROVER);
    const asApprover = sf.planDownpipes();
    ok("(E4) an Approver's enforced custom draft is accepted", asApprover.ok && asApprover.data.every((p) => p.dp.retention?.keepRuns === 30 && p.dp.retention?.enforce === true));

    // Control: an Operator's own limits without enforce need no capability at all.
    setCaller(OPERATOR);
    m.update({ retentionCustom: { keepRuns: 30, enforce: false } });
    const reportOnly = sf.planDownpipes();
    ok("(E5) control: an Operator's report-only custom draft is accepted", reportOnly.ok && reportOnly.data.every((p) => p.dp.retention?.keepRuns === 30 && p.dp.retention?.enforce === undefined));
  }

  console.log(failures === 0 ? "\nRETENTION-ARM-WIZARD PASS" : `\nRETENTION-ARM-WIZARD FAIL (${failures})`);
  verdictReached(failures, checks);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
