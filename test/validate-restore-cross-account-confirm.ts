// A restore that crosses into TWO OR MORE distinct foreign Cloudflare accounts must
// require the operator to type-to-confirm EVERY distinct target account, not just the first warning.
//
// WHY THIS EXISTS
// ----------------
// crossAccountWarnings carries one entry PER LEG (cf-config, media). A plan with a cf-config leg targeting
// one foreign account and a media leg targeting a DIFFERENT foreign account has two warnings. The
// type-to-confirm gate (confirm.ts confirmApply) used to build its matchValue from
// `plan.crossAccountWarnings?.[0]?.targetAccount` -- the FIRST warning only. Once the operator typed that
// one value and clicked Apply, applyRestore stamped confirmDifferentAccountId onto EVERY cross-account leg
// unconditionally (echoing each leg's own accountId), whatever leg[1]'s target actually was. So the second
// foreign write reached the engine pre-confirmed without the operator ever having typed, seen selected, or
// consciously acknowledged that second account. Reproduced live against the unfixed code: typing only
// TARGET_CFG below armed Apply and the mocked engine.restore() received confirmDifferentAccountId set for
// BOTH legs, including the media leg the operator never typed.
//
// The engine's per-leg guard (engine/src/admin/restore-cross-account.ts) is sound on its own terms: it
// refuses a leg unless that leg's OWN confirmDifferentAccountId echoes that leg's OWN target account, and
// engine/test/validate-restore-cross-account.ts proves both directions hold. But the console defeated that
// guard by manufacturing the second leg's echo itself, having never asked for it. The engine cannot tell an
// operator-typed echo from a console-fabricated one; both arrive as the same field. That is why the fix
// lives here, changing what the operator is required to type, not in the engine.
//
// THE FIX
// -------
// crossAccountConfirmTargets (confirm.ts) collects the DISTINCT target accounts across every
// crossAccountWarning and the type-to-confirm's matchValue becomes their sorted, comma-joined
// concatenation. One account still types exactly as before (the common case is unaffected). Two or more
// accounts can only be matched by typing the full set together -- there is no way to satisfy the gate by
// naming just one of several, so a second, third, or fifth foreign account can never ride through on a
// confirmation aimed at the first.
//
// THIS FILE
// ---------
// Drives the REAL renderConfirm / confirm flow under the shared DOM shim (never re-implements it), with a
// plan carrying two crossAccountWarnings for two DIFFERENT foreign accounts.
//   1. Typing only the first target's account id must NOT enable the dialog's Apply, and no apply POST
//      must fire.
//   2. Typing the full two-account consent string (comma-joined, sorted) must enable Apply and the request
//      the mocked engine.restore() receives must carry BOTH legs' confirmDifferentAccountId correctly.
//
// Run with `node test/validate-restore-cross-account-confirm.ts`.

import { flushAsync, installDomShim, qs, qsa, textOf, type ShimEvent, type ShimNode } from "./dom-shim.ts";

installDomShim();

import type { Caller, EngineClient, RestorePlan, RestoreRequest, RestoreApproval, RestoreResult } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { setCaller } from "../src/lib/store.ts";
import { renderConfirm, crossAccountConfirmTargets } from "../src/screens/restore-flow/confirm.ts";

installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
setCaller({ method: "access", email: "maker@test", role: "approver", groups: [], isOnlyOwner: false } as Caller);

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69GCAX";
const TARGET_CFG = "acct-config-foreign"; // the cf-config leg's foreign target
const TARGET_MEDIA = "acct-media-foreign"; // the media leg's DIFFERENT foreign target
const PLAN_HASH = "b".repeat(64);

// A plan crossing into TWO distinct foreign accounts: the cf-config leg targets TARGET_CFG, the media leg
// targets TARGET_MEDIA. Both differ from the recorded origin and from EACH OTHER.
const plan: RestorePlan = {
  ok: true,
  runId: RUN_ID,
  mode: "dry-run",
  recordsVerified: 5,
  isLatest: true,
  plannedWrites: 5,
  bytes: 1024,
  sample: [],
  skipped: [],
  crossAccountWarnings: [
    { leg: "cf-config", originAccount: "acct-origin", targetAccount: TARGET_CFG },
    { leg: "media", originAccount: "acct-origin", targetAccount: TARGET_MEDIA },
  ],
} as unknown as RestorePlan;

function request(): RestoreRequest {
  return {
    runId: RUN_ID,
    cfConfig: { token: "cf-token", accountId: TARGET_CFG },
    mediaRestore: { token: "media-token", accountId: TARGET_MEDIA },
  } as unknown as RestoreRequest;
}

const FLAGS = { highImpact: false, isLarge: false, isRedirect: false, isNonLatest: false, isCrossAccount: true, isCrossZone: false };

const approval: RestoreApproval = {
  planHash: PLAN_HASH,
  status: "approved",
  approvedBy: "checker@test",
  runId: RUN_ID,
} as unknown as RestoreApproval;

function findButtonByText(root: unknown, text: string): ShimNode | undefined {
  return qsa(root, "button").find((b) => textOf(b).trim() === text);
}

function typeInto(input: ShimNode, value: string): void {
  input.value = value;
  input.dispatchEvent({ type: "input", target: input, currentTarget: input, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} } as ShimEvent);
}

/** Renders the armed confirm section and opens the type-to-confirm dialog by clicking Apply. */
async function openConfirmDialog(capture: { req: RestoreRequest | null }): Promise<{ section: ShimNode; surface: ShimNode }> {
  const engine = {
    listApprovals: async () => [approval],
    getConfigApprovalPolicy: async () => ({ requireChangeNumber: false }) as never,
    restore: async (req: RestoreRequest) => {
      capture.req = req;
      return { ok: true, runId: RUN_ID, mode: "applied", recordsVerified: 5, recordsRestored: 5, bytesRestored: 1024, isLatest: true, failures: [] } as unknown as RestoreResult;
    },
  } as unknown as EngineClient;

  const section = (await renderConfirm(engine, plan, request(), PLAN_HASH, FLAGS, () => {}, () => {})) as unknown as ShimNode;
  await flushAsync();
  const applyBtn = findButtonByText(section, "Apply restore");
  if (!applyBtn) throw new Error("Apply restore control did not render (the approval gate did not arm)");
  applyBtn.click();
  await flushAsync();
  const surface = qs(document.body, ".dialog--modal");
  if (!surface) throw new Error("the type-to-confirm dialog did not open");
  return { section, surface };
}

console.log("the cross-account type-to-confirm must bind EVERY distinct foreign account, not just the first");

// ---- 0. The rule itself, at the unit level. -----------------------------------------------------------
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  ok("one leg, one target: the match is that one account alone", crossAccountConfirmTargets([{ targetAccount: "acct-a" }]).join(",") === "acct-a");
  ok(
    "two legs, two DIFFERENT targets: both are required, sorted, deduplicated against accident",
    crossAccountConfirmTargets([{ targetAccount: TARGET_MEDIA }, { targetAccount: TARGET_CFG }]).join(", ") === [TARGET_CFG, TARGET_MEDIA].sort().join(", "),
  );
  ok(
    "two legs sharing ONE target: the operator still only has one account to type",
    crossAccountConfirmTargets([{ targetAccount: "acct-shared" }, { targetAccount: "acct-shared" }]).length === 1,
  );
}

// ---- 1. Typing only the FIRST target must NOT arm the apply. ------------------------------------------
{
  const capture: { req: RestoreRequest | null } = { req: null };
  const { surface } = await openConfirmDialog(capture);

  const hint = textOf(surface);
  ok("the dialog states both distinct accounts must be typed", /2 target Cloudflare account ids/.test(hint) || /all 2 target/.test(hint));

  const input = qs(surface, "input");
  ok("a text input is present", input !== null);
  if (input) typeInto(input, TARGET_CFG);

  const dialogApplyBtn = findButtonByText(surface, "Apply restore");
  ok(
    `typing ONLY the first target account (${TARGET_CFG}) does NOT enable the dialog's Apply button`,
    dialogApplyBtn !== undefined && dialogApplyBtn.disabled === true,
  );
  // Click anyway (an operator hammering a disabled control, or a stale handle): the click handler itself
  // re-checks the match and must refuse to settle/apply on a partial value.
  dialogApplyBtn?.click();
  await flushAsync();
  await flushAsync();
  ok("no apply POST fired on a partial (first-account-only) confirmation", capture.req === null);

  // Close this dialog (Cancel) so the next case's qs(document.body, ".dialog--modal") finds ITS OWN dialog,
  // not this one left open by the disabled-Apply guard above.
  const cancelBtn = findButtonByText(surface, "Cancel");
  cancelBtn?.click();
  await flushAsync();
}

// ---- 2. Typing the FULL two-account consent string arms the apply, and BOTH legs land correctly. ------
{
  const capture: { req: RestoreRequest | null } = { req: null };
  const { surface } = await openConfirmDialog(capture);

  const fullConsent = crossAccountConfirmTargets(plan.crossAccountWarnings ?? []).join(", ");
  const input = qs(surface, "input");
  if (input) typeInto(input, fullConsent);

  const dialogApplyBtn = findButtonByText(surface, "Apply restore");
  ok("typing the FULL consent (all distinct accounts, comma-joined) enables the dialog's Apply button", dialogApplyBtn !== undefined && dialogApplyBtn.disabled === false);
  dialogApplyBtn?.click();
  await flushAsync();
  await flushAsync();

  ok("the apply POST fired on full consent", capture.req !== null);
  const sentCfgConfirm = (capture.req as unknown as { cfConfig?: { confirmDifferentAccountId?: string } } | null)?.cfConfig?.confirmDifferentAccountId;
  const sentMediaConfirm = (capture.req as unknown as { mediaRestore?: { confirmDifferentAccountId?: string } } | null)?.mediaRestore?.confirmDifferentAccountId;
  ok("the cf-config leg is confirmed to its own target", sentCfgConfirm === TARGET_CFG);
  ok("the media leg -- the SECOND, distinct foreign account -- is confirmed too, because the operator typed BOTH", sentMediaConfirm === TARGET_MEDIA);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
process.exit(failures === 0 ? 0 : 1);
