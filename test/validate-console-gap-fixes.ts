// Validates that the console never fabricates a state and never collapses an UNKNOWN into an ALL-CLEAR: a
// read that failed renders as a failed read, a safety check that could not run renders as unknown, and a
// refused write is surfaced rather than silently dropped, across the add-source picker, the audit-log
// capacity check, drill-evidence writes, the config-diff viewer, discovery-token verification, capability
// refusals, the restore receipt, and the disaster-recovery client.
//
// The suite drives the REAL functions (never a re-implementation) under the shared DOM shim, with the engine
// stubbed. Run with `node test/validate-console-gap-fixes.ts`.

import { installDomShim, textOf, flushAsync } from "./dom-shim.ts";

installDomShim();

import { unloadableDiffReason } from "../src/screens/config-history.ts";
import { tokenVerifiedToast } from "../src/screens/sources/token-entry.ts";
import { failuresByReason, namelessFailureCount } from "../src/screens/restore-flow/receipt.ts";
import { writeDrillEvidence, drillEvidenceMissedNote } from "../src/screens/restore-flow/shared.ts";
import { loadFormContext, buildR2Block, type FormContext } from "../src/screens/destination-form-fields.ts";
import { parseReconcileInput } from "../src/lib/control-plane-recovery.ts";
import { parseEstateImportInput } from "../src/lib/control-plane-import.ts";
import { runExportDownload } from "../src/lib/control-plane-export-download.ts";
import { RECOVERY_REFUSAL_CODES, refusalCodeForStatus, withRefusalCode, type RecoveryRefusalCode } from "../src/lib/recovery-refusal-codes.ts";
import { updateRecoveryBanner, RECOVERY_UNKNOWN_TITLE } from "../src/components/recovery-banner.ts";
import { nearCapView } from "../src/screens/access-security/audit.ts";
import { refusedMessage } from "../src/screens/access-security/sessions-passkeys.ts";
import { recoveryReadFailedTile } from "../src/screens/overview/recovery.ts";
import { trailReadState } from "../src/screens/overview/shared.ts";
import { removeItem } from "../src/screens/credentials/forms.ts";
import type { EngineClient, ExpiryStatus, MutationResult } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(a: unknown, b: unknown, label: string): void {
  const cond = a === b;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
  if (!cond) failures++;
}

// bannerHostText reads the singleton recovery-banner host (the component appends it to <body> once).
function bannerHostText(): string {
  const host = document.getElementById("cp-recovery-banner-host");
  return host ? textOf(host as unknown as HTMLElement) : "";
}

// VALID_EXPORT is the minimum artefact the client-side shape gate accepts, so a test aimed at a LATER
// rejection (a missing signature, a missing signer.pub) is not short-circuited by the shape gate.
const VALID_EXPORT = {
  v: 1,
  exportedAt: "2026-07-11T00:00:00.000Z",
  configContentHash: "abc",
  downpipes: [],
  destinations: [],
  roles: [],
  priorAuditHead: { seq: 1 },
};

// ===========================================================================
// G098: an unloadable config diff names WHICH version's snapshot body is gone.
// ===========================================================================
console.log("\n-- G098 unloadableDiffReason names the missing snapshot, never 'one of the versions' --");
{
  const thisGone = unloadableDiffReason(30, 29, { thisRetained: false, parentRetained: true });
  ok("this version's body missing: v30 is named", thisGone.includes("v30") && thisGone.includes("no longer retained"));
  const parentGone = unloadableDiffReason(30, 29, { thisRetained: true, parentRetained: false });
  ok("the parent's body missing: v29 is named", parentGone.includes("v29") && parentGone.includes("no longer retained"));
  ok("the parent-missing copy does not claim v30 is the missing one", !parentGone.includes(`the full snapshot for v30 is no longer retained`));
  const bothGone = unloadableDiffReason(30, 29, { thisRetained: false, parentRetained: false });
  ok("both bodies missing: both are named", bothGone.includes("v29") && bothGone.includes("v30"));
  const neitherGone = unloadableDiffReason(30, 29, { thisRetained: true, parentRetained: true });
  ok("both retained: reported as an engine fault, NOT as a retention gap", neitherGone.includes("not a retention gap"));
  const unknown = unloadableDiffReason(30, 29, { thisRetained: true, parentRetained: null });
  ok("the parent probe failed: says UNKNOWN rather than guessing", unknown.includes("unknown"));
  ok("no branch falls back to the old ambiguous 'one of the versions' copy", ![thisGone, parentGone, bothGone, neitherGone, unknown].some((s) => s.includes("one of the versions")));
}

// ===========================================================================
// G129: a stored token that sees ZERO accounts is not a success.
// ===========================================================================
console.log("\n-- G129 a discovery token that sees no accounts is a WARN, not 'Token verified' --");
{
  const zero = tokenVerifiedToast(0);
  eq(zero.tone, "warn", "zero accounts: warn tone");
  ok("zero accounts: does not read as a plain verification", !zero.message.startsWith("Token verified"));
  ok("zero accounts: names the cause (scopes) and the remedy", zero.message.includes("scopes") && zero.message.toLowerCase().includes("account read"));
  const one = tokenVerifiedToast(1);
  eq(one.tone, undefined, "one account: no warn tone");
  ok("one account: singular", one.message.includes("1 account visible"));
  ok("three accounts: plural", tokenVerifiedToast(3).message.includes("3 accounts visible"));
}

// ===========================================================================
// G179: the restore receipt breaks the failures down, and owns the nameless ones.
// ===========================================================================
console.log("\n-- G179 restore failures carry a class breakdown and the nameless count --");
{
  const failuresIn = [
    { name: "a", reason: "checksum mismatch" },
    { name: "b", reason: "checksum mismatch" },
    { name: "c", reason: "destination refused the write" },
    { name: "", reason: "checksum mismatch" },
    { name: "", reason: "" },
  ];
  const grouped = failuresByReason(failuresIn);
  eq(grouped[0]?.reason, "checksum mismatch", "the biggest class leads");
  eq(grouped[0]?.count, 3, "the biggest class carries its true count");
  eq(grouped.length, 3, "an empty reason becomes its own explicit bucket, never dropped");
  ok("the unstated-reason bucket is named, not silently merged", grouped.some((g) => g.reason.includes("not stated")));
  eq(grouped.reduce((n, g) => n + g.count, 0), failuresIn.length, "every failure is accounted for exactly once");
  eq(namelessFailureCount(failuresIn), 2, "the nameless failures are counted (they cannot be retried by name)");
  eq(namelessFailureCount([{ name: "a" }, { name: "b" }]), 0, "all named: nothing to warn about");
}

// ===========================================================================
// G045 / G047: a refused drill-evidence write is surfaced, never swallowed.
// ===========================================================================
console.log("\n-- G045/G047 a refused drill-evidence write is stated beside the PASSING drill --");
{
  let missed = 0;
  const refusing = { recordDrillEvidence: () => Promise.reject(new Error("boom")) } as unknown as EngineClient;
  await writeDrillEvidence(refusing, "run-1", () => { missed++; });
  eq(missed, 1, "a refused evidence write calls onMissed (it used to hit an empty catch)");

  const accepting = { recordDrillEvidence: () => Promise.resolve(undefined) } as unknown as EngineClient;
  await writeDrillEvidence(accepting, "run-1", () => { missed++; });
  eq(missed, 1, "a written entry calls nothing (no false alarm on the happy path)");

  const note = textOf(drillEvidenceMissedNote());
  ok("the note says the drill PASSED (the verdict is never disturbed)", note.includes("drill passed"));
  ok("the note says the evidence entry did not land", note.includes("evidence entry could not be written"));
  ok("the note names the consequence: the recoverability report will not show it", note.includes("recoverability report"));
  ok("the note carries no engine error text", !note.includes("boom"));
}

// ===========================================================================
// G008: a rejected source discovery is stated, never silently degraded.
// ===========================================================================
console.log("\n-- G008 a failed discovery read is stated, not rendered as an empty account --");
{
  const bothFail = {
    discoverSources: () => Promise.reject(new Error("network")),
    listDownpipes: () => Promise.reject(new Error("network")),
  } as unknown as EngineClient;
  const ctxFail = await loadFormContext(bothFail);
  ok("a rejected discovery is recorded as a FAILED read, not as an empty result", ctxFail?.discoveryRead === false);
  ok("a rejected downpipe list is recorded as a FAILED read", ctxFail?.downpipesRead === false);

  const bothOk = {
    discoverSources: () => Promise.resolve({ engineAccountId: "acct", accounts: [{ accountId: "acct", r2: [{ name: "b1" }] }] }),
    listDownpipes: () => Promise.resolve([]),
  } as unknown as EngineClient;
  const ctxOk = await loadFormContext(bothOk);
  ok("a successful discovery is recorded as read", ctxOk?.discoveryRead === true && ctxOk?.downpipesRead === true);
  eq(ctxOk?.engineR2Buckets.length, 1, "the bucket list still resolves on the happy path");

  const failedForm = buildR2Block({ engineAccountId: null, engineR2Buckets: [], sourceR2Buckets: new Set(), discoveryRead: false, downpipesRead: false } as FormContext, () => {});
  const failedText = textOf(failedForm.block);
  ok("the form says the bucket list could not be READ", failedText.includes("could not be read"));
  ok("the form says this is a failed read, NOT an empty account", failedText.includes("not an empty account"));
  ok("the form says the archive-into-a-source check could not run", failedText.includes("cannot check"));

  const healthyForm = buildR2Block({ engineAccountId: "acct", engineR2Buckets: ["b1"], sourceR2Buckets: new Set(), discoveryRead: true, downpipesRead: true } as FormContext, () => {});
  const healthyText = textOf(healthyForm.block);
  ok("a healthy read shows NO degrade notice (it must not cry wolf)", !healthyText.includes("could not be read") && !healthyText.includes("cannot check"));
}

// ===========================================================================
// G196 / G214: the disaster-recovery refusal vocabulary.
// ===========================================================================
console.log("\n-- G196/G214 every recovery refusal carries a stable, value-free code --");
{
  ok("every code is a compile-time constant of the frozen DP-Rnn shape", RECOVERY_REFUSAL_CODES.every((c) => /^DP-R\d\d$/.test(c)));
  eq(new Set(RECOVERY_REFUSAL_CODES).size, RECOVERY_REFUSAL_CODES.length, "no code is duplicated (a code maps to exactly one gate)");

  // The status mapper is TOTAL: no status leaves the operator with an uncoded refusal.
  const statuses = [400, 401, 403, 404, 409, 418, 500, 502, 0, -1, 999];
  ok("refusalCodeForStatus is total (every status yields a frozen member)", statuses.every((s) => (RECOVERY_REFUSAL_CODES as readonly string[]).includes(refusalCodeForStatus(s))));
  eq(refusalCodeForStatus(401), "DP-R10", "401 -> the token was not accepted");
  eq(refusalCodeForStatus(403), "DP-R11", "403 -> not an Owner");
  eq(refusalCodeForStatus(400), "DP-R12", "400 -> refused at verification");
  eq(refusalCodeForStatus(503), "DP-R13", "anything else -> the catch-all engine/transport code");

  // The code is DISPLAY-ONLY and carries nothing of the operator's. Plant a secret in the message and
  // confirm the CODE itself is unchanged by it: the code is a constant, never derived from the input.
  const planted = withRefusalCode("the token sk-live-SECRET-VALUE was rejected", "DP-R10");
  ok("withRefusalCode appends the code, it never rewrites the message", planted.startsWith("the token sk-live-SECRET-VALUE was rejected"));
  ok("the code is a constant: a planted value cannot alter it", planted.endsWith("(DP-R10)"));

  // Every browser-side rejection (these never reach the engine, so the code is the ONLY trace) is coded.
  const reconcileCases: Array<[{ exportText: string; signature: string; token: string }, RecoveryRefusalCode]> = [
    [{ exportText: "", signature: "s", token: "t" }, "DP-R01"],
    [{ exportText: "not json", signature: "s", token: "t" }, "DP-R02"],
    [{ exportText: '{"v":2}', signature: "s", token: "t" }, "DP-R03"],
    [{ exportText: JSON.stringify(VALID_EXPORT), signature: "", token: "t" }, "DP-R04"],
    [{ exportText: JSON.stringify(VALID_EXPORT), signature: "s", token: "" }, "DP-R06"],
  ];
  for (const [raw, code] of reconcileCases) {
    const r = parseReconcileInput(raw);
    ok(`reconcile rejection ${code}: coded`, r.ok === false && r.code === code);
    ok(`reconcile rejection ${code}: the code is IN the operator's copy`, r.ok === false && r.error.endsWith(`(${code})`));
  }
  ok("a valid reconcile form still parses (the codes did not break the happy path)", parseReconcileInput({ exportText: JSON.stringify(VALID_EXPORT), signature: "s", token: "t" }).ok === true);

  const importCases: Array<[{ exportText: string; signatureText: string; signerPublicText: string }, RecoveryRefusalCode]> = [
    [{ exportText: "", signatureText: "s", signerPublicText: "p" }, "DP-R01"],
    [{ exportText: "{oops", signatureText: "s", signerPublicText: "p" }, "DP-R02"],
    [{ exportText: '{"v":1}', signatureText: "s", signerPublicText: "p" }, "DP-R03"],
    [{ exportText: JSON.stringify(VALID_EXPORT), signatureText: "", signerPublicText: "p" }, "DP-R04"],
    [{ exportText: JSON.stringify(VALID_EXPORT), signatureText: "s", signerPublicText: "" }, "DP-R05"],
  ];
  for (const [raw, code] of importCases) {
    const r = parseEstateImportInput(raw);
    ok(`estate-import rejection ${code}: coded`, r.ok === false && r.code === code);
    ok(`estate-import rejection ${code}: the code is IN the operator's copy`, r.ok === false && r.error.endsWith(`(${code})`));
  }
  ok("a valid import form still parses", parseEstateImportInput({ exportText: JSON.stringify(VALID_EXPORT), signatureText: "s", signerPublicText: "p" }).ok === true);

  // A 200 that carries no signed export is a malformed answer, and it is coded too.
  let downloadErr = "";
  await runExportDownload({ controlPlaneExportDownload: () => Promise.resolve({ export: null, signature: "" }) } as unknown as EngineClient, {
    save: () => {},
    onError: (m) => { downloadErr = m; },
    onDone: () => {},
  });
  ok("an export download with no signed export is coded DP-R14", downloadErr.endsWith("(DP-R14)"));
  ok("and it says the engine ANSWERED (it is not reported as an outage)", downloadErr.includes("the engine answered"));
}

// ===========================================================================
// G214: a failed recovery-status read is not an all-clear (and 404 does not cry wolf).
// ===========================================================================
console.log("\n-- G214 a failed recovery-status read renders UNKNOWN, never silence --");
{
  const deps = { reconcile: () => Promise.reject(new Error("unavailable")) };

  updateRecoveryBanner(null, deps, "ok");
  eq(bannerHostText(), "", "a healthy plane renders nothing");

  updateRecoveryBanner(null, deps, "route-absent");
  eq(bannerHostText(), "", "an engine that does not serve the status route renders nothing (no wolf-crying)");

  updateRecoveryBanner(null, deps, "failed");
  const unknownText = bannerHostText();
  ok("a FAILED status read renders the unknown state", unknownText.includes(RECOVERY_UNKNOWN_TITLE));
  ok("the unknown state says it is not an all-clear", unknownText.includes("not an all-clear"));
  ok("the unknown state does NOT claim recovery is required", !unknownText.includes("Control plane needs recovery"));

  updateRecoveryBanner({ recoveryRequired: true, reason: "storage lost" } as never, deps, "ok");
  const dangerText = bannerHostText();
  ok("a confirmed latch still raises the real danger banner", dangerText.includes("Control plane needs recovery"));
  ok("and the danger banner is not replaced by the unknown copy", !dangerText.includes(RECOVERY_UNKNOWN_TITLE));

  updateRecoveryBanner(null, deps, "ok");
  eq(bannerHostText(), "", "the banner clears once the plane reports healthy again");
}

// ===========================================================================
// G022: audit-log capacity. An UNKNOWN is never an all-clear.
// ===========================================================================
console.log("\n-- G022 audit capacity: a failed or unreported check is UNKNOWN, never silence --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  eq(nearCapView("ok", true), "warn", "the engine says near cap: warn");
  eq(nearCapView("ok", false), "none", "the engine says not near cap: nothing (the only silent path)");
  eq(nearCapView("ok", undefined), "unknown-not-reported", "an engine that does not report capacity: unknown");
  eq(nearCapView("failed", undefined), "unknown-read-failed", "a failed status read: unknown");
  eq(nearCapView("failed", false), "unknown-read-failed", "a failed read is unknown even with a stale value to hand");
  ok("'none' is reachable ONLY from an engine that answered and said no", nearCapView("ok", false) === "none" && nearCapView("failed", false) !== "none" && nearCapView("ok", undefined) !== "none");
}

// ===========================================================================
// G175: a 403 carries the ENGINE'S reason, never generic capability copy alone.
// ===========================================================================
console.log("\n-- G175 an engine refusal keeps the engine's reason --");
{
  const msg = refusedMessage(new Error("owner-escalation guard: cannot act on an Owner"), "Needs the roles.write capability.");
  ok("the engine's own reason rides in the copy", msg.includes("owner-escalation guard"));
  ok("the capability hint accompanies it, it does not replace it", msg.includes("roles.write"));
  ok("the copy no longer ASSERTS the role gate as the cause", !msg.includes("at its role gate"));
  const lastOwner = refusedMessage(new Error("last Owner cannot be removed"), "Owner only.");
  ok("a different refusal reads as itself, not as the same fixed sentence", lastOwner.includes("last Owner") && !lastOwner.includes("owner-escalation"));
}

// B39: the overview recovery tiles tell a genuinely not-wired route (404/501, an honest engine
// addition) apart from a real fault (a 500 the engine served while broken, or a network throw). A real
// fault must NOT read as an unbuilt "Pending engine" feature (the B37/B23/B24 pending-vs-broken class,
// on the overview recovery tiles), while a real 404/501 keeps the honest pending copy.
{
  const PENDING = "the durable dated trail ships with the engine.";
  const wired404 = textOf(recoveryReadFailedTile("Last proven recoverable", new Error("drill-evidence: 404"), PENDING));
  ok("B39: a 404 (route not wired) still reads 'Pending engine'", wired404.includes("Pending engine") && wired404.includes("Engine addition"));
  const wired501 = textOf(recoveryReadFailedTile("Last audited", new Error("audit: 501"), PENDING));
  ok("B39: a 501 (route not implemented) still reads 'Pending engine'", wired501.includes("Pending engine"));
  const broken500 = textOf(recoveryReadFailedTile("Last proven recoverable", new Error("drill-evidence: 500"), PENDING));
  ok("B39: a 500 (engine live and broken) reads an engine error, NOT 'Pending engine'", broken500.includes("Could not read") && broken500.includes("Engine error") && !broken500.includes("Pending engine"));
  ok("B39: the 500 tile does not frame the fault as an unbuilt feature", !broken500.includes("ships with the engine") && broken500.includes("not an unbuilt feature"));
  const network = textOf(recoveryReadFailedTile("Last audited", new TypeError("Failed to fetch"), PENDING));
  ok("B39: a network throw (unreachable) reads an engine error, not 'Pending engine'", network.includes("Could not read") && !network.includes("Pending engine"));
}

// B44: the recovery-evidence roll-up copy (buildBoundaryNote + the executive "evidence in place" answer)
// reads trailReadState. Either read live = "live"; both a genuine 404/501 = "not-wired" (an unbuilt
// engine addition, honest); both failed with at least one real fault (500/network) = "faulted", so a broken
// engine is NOT described as an unbuilt feature.
{
  const ok404 = { ok: false as const, error: new Error("drill-evidence: 404") };
  const ok500 = { ok: false as const, error: new Error("audit: 500") };
  const live = { ok: true as const, value: [] };
  eq(trailReadState(live, ok500), "live", "B44: either read live => live");
  eq(trailReadState(ok404, live), "live", "B44: either read live (audit) => live");
  eq(trailReadState(ok404, { ok: false, error: new Error("audit: 501") }), "not-wired", "B44: both a genuine 404/501 => not-wired (honest unbuilt)");
  eq(trailReadState(ok404, ok500), "faulted", "B44: both failed, one a real 500 => faulted (not unbuilt)");
  eq(trailReadState({ ok: false, error: new TypeError("Failed to fetch") }, ok500), "faulted", "B44: both failed with real faults => faulted");
}

// B53: the change-control-gated deletes (notify channel, notify rule, expiry item) must report the QUEUED
// 202 honestly. Before the fix the client plain-parsed the 202 and the handler toasted "Deleted"/"Removed"
// and reloaded a list still holding the item, a false success for a deletion a second approver might still
// reject. removeItem (the expiry delete) is the exported representative of the three structurally identical
// handlers; the wire shape for all three is proven in cov/lib-api-client + validate-api-client. Here we drive
// the REAL confirm modal and assert the queued branch surfaces "queued for approval" and does NOT reload.
{
  type ClickBtn = { textContent: string; click: () => void };
  const bodyQuery = <T>(sel: string): T[] => (document.body as unknown as { querySelectorAll: (s: string) => T[] }).querySelectorAll(sel);
  const clickLastRemove = (): void => { const bs = bodyQuery<ClickBtn>("button").filter((b) => b.textContent.trim() === "Remove"); bs[bs.length - 1]?.click(); };
  const clearToasts = (): void => { for (const r of bodyQuery<{ replaceChildren: () => void }>(".toast-region")) r.replaceChildren(); };
  const row = { id: "exp_1", label: "prod destination key" } as unknown as ExpiryStatus;

  // Queued path: dual control armed, so the engine QUEUED the removal (202 -> pending) and the item is STILL
  // tracked. The handler must say so, not "Removed", and must NOT reload (the row must stay).
  clearToasts();
  let reloadedOnPending = false;
  const pendingEngine = { deleteExpiryItem: async (): Promise<MutationResult<{ deleted: boolean }>> => ({ status: "pending", changeId: "chg_exp", raw: { queued: true, id: "chg_exp" } }) } as unknown as EngineClient;
  removeItem(pendingEngine, row, () => { reloadedOnPending = true; });
  await flushAsync();
  clickLastRemove();
  await flushAsync();
  const pendingToast = textOf(document.body as unknown as HTMLElement);
  ok("B53: a QUEUED expiry removal says 'queued for approval', never 'Removed'", pendingToast.toLowerCase().includes("queued for approval") && !pendingToast.includes('Removed "prod destination key"'));
  ok("B53: a QUEUED expiry removal does NOT reload the list (the item is still tracked)", reloadedOnPending === false);

  // Applied path (gate off): a real 200 delete resolves to applied -> "Removed" + reload, the byte-unchanged
  // success path.
  clearToasts();
  // On a holder: written only from inside the reload callback, so as a local `let` the compiler keeps
  // it narrowed to false and the check below becomes an assertion that can never hold.
  const rec = { reloadedOnApplied: false };
  const appliedEngine = { deleteExpiryItem: async (): Promise<MutationResult<{ deleted: boolean }>> => ({ status: "applied", value: { deleted: true } }) } as unknown as EngineClient;
  removeItem(appliedEngine, row, () => { rec.reloadedOnApplied = true; });
  await flushAsync();
  clickLastRemove();
  await flushAsync();
  const appliedToast = textOf(document.body as unknown as HTMLElement);
  ok("B53: an APPLIED expiry removal says 'Removed' and reloads the list", appliedToast.includes('Removed "prod destination key"') && rec.reloadedOnApplied === true);
}

await flushAsync();

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
