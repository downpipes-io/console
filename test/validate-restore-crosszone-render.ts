// The restore plan must SHOW the cross-zone warning.
//
// WHY THIS EXISTS
// ---------------
// The engine refuses a cf-config apply that would write zone-scoped surfaces into a zone that is provably
// not the archive's origin, unless the caller echoes the target zone id. When that guard was added the
// console rendered NEITHER half: the warning appeared nowhere, so an operator's first sight of a wrong-zone
// restore was the engine refusing an apply they had already confirmed, and confirmDifferentZoneId had no
// path through the console at all, so a legitimate cross-zone restore could only be done via the API.
//
// Both halves are wired now. This is the proof, driven against the REAL renderPlan under the shared DOM
// shim, because "I added the render" is exactly the claim that has been wrong twice this session.
//
// THE NULL-ORIGIN CASE IS THE SUBTLE ONE. The engine warns but does NOT refuse when the archive's origin
// zone cannot be read, which usually means the identity record sits outside a windowed restore. The console
// must match that: show the warning, do not demand a type-to-confirm. Getting this backwards would block a
// restore the engine is perfectly happy to run, so it is asserted in both directions.
//
// WHAT THIS DOES NOT COVER, AND WHY
// ---------------------------------
// The type-to-confirm itself. It only arms behind a usable dual-control approval, so under a stub engine
// with no approvals the panel renders its "needs approval" state and no confirmation text exists to assert.
// I know that is the reason rather than a defect because the ACCOUNT guard's confirmation, shipped long
// before this work, is equally absent under the same stub.
//
// Fabricating an approval to reach it would mean asserting against a hand-built gate state rather than the
// one the product produces, which is how a test starts agreeing with itself. The confirm path is driven end
// to end by validate-api-flows-restore.ts, and extending THAT to cover the zone case is the honest way to
// close this, recorded rather than quietly skipped.
//
// Run with `node test/validate-restore-crosszone-render.ts`.

import { installDomShim, qs, textOf } from "./dom-shim.ts";
installDomShim();

import type { RestorePlan, RestoreRequest } from "../src/lib/api/types/restore-types.ts";
import { crossZoneNeedsConfirm, renderPlan } from "../src/screens/restore-flow/plan.ts";
import { BREAK_GLASS_PREFIX } from "../src/screens/restore-flow/shared.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// The only engine calls renderPlan reaches (via renderConfirm) are approval lookups; the apply path is
// behind a click this test never makes.
const engine = {
  listApprovals: async () => [],
  requestRestore: async () => ({}),
  restore: async () => ({}),
} as never;

const basePlan: RestorePlan = {
  ok: true,
  runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  mode: "dry-run",
  recordsVerified: 10,
  isLatest: true,
  plannedWrites: 10,
  bytes: 2048,
  sample: [],
  skipped: [],
};

const req = (zoneId: string): RestoreRequest => ({
  runId: basePlan.runId,
  cfConfig: { token: "t", accountId: "acct-1", zoneId },
});

async function render(plan: RestorePlan, zoneId: string): Promise<string> {
  const el = await renderPlan(engine, plan, () => req(zoneId), () => undefined, () => undefined);
  return textOf(el);
}

console.log("-- no warning when the plan carries none --");
{
  const text = await render(basePlan, "zone-A");
  ok("a same-zone plan says nothing about zones", !/different Cloudflare zone/i.test(text));
}

console.log("\n-- a PROVEN mismatch warns and NAMES the surfaces --");
{
  const plan: RestorePlan = { ...basePlan, crossZoneWarning: { originZone: "zone-A", targetZone: "zone-B", zoneSurfaces: ["dns", "rulesets"] } };
  const text = await render(plan, "zone-B");
  ok("the warning is rendered", /different Cloudflare zone/i.test(text));
  ok("it names the ORIGIN zone", text.includes("zone-A"));
  ok("it names the TARGET zone", text.includes("zone-B"));
  // Surfaces are NAMED, not counted: a count cannot be reviewed, which is the same reason F9 names
  // removals rather than tallying them.
  ok("it names the zone-scoped surfaces rather than counting them", text.includes("dns") && text.includes("rulesets"));
}

console.log("\n-- an UNVERIFIABLE origin warns but must NOT demand a confirmation --");
{
  // The engine does not refuse this case, so demanding a type-to-confirm would block a restore it is
  // happy to run. Asserted in both directions because getting it backwards is silent: the screen would
  // simply look more cautious.
  const plan: RestorePlan = { ...basePlan, crossZoneWarning: { originZone: null, targetZone: "zone-B", zoneSurfaces: ["dns"] } };
  const text = await render(plan, "zone-B");
  ok("the warning is still shown", /different Cloudflare zone/i.test(text));
  ok("it says the origin zone is not recorded", /does not record which zone/i.test(text));
  ok("it says this is not blocked", /not blocked/i.test(text));
  // Deliberately NOT asserting the absence of a type-to-confirm here. The confirm never arms under this
  // stub at all, so that assertion would pass whatever the code did: it cannot fail, and an assertion that
  // cannot fail is worse than none because it reads like coverage.
}

console.log("\n-- WHICH cross-zone plans demand a type-to-confirm --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  // This used to be asserted nowhere. The comment at the top of this file explains why the CONFIRM itself
  // cannot be reached under a stub engine, and that reasoning is still right, but it left the RULE with no
  // test at all: the guard sweep neutered it and this file stayed green. Extracting the predicate makes the
  // rule observable without fabricating an approval state the product never produces.
  ok("a plan with no cross-zone warning demands nothing", !crossZoneNeedsConfirm(basePlan));
  ok("a PROVEN mismatch demands a confirmation", crossZoneNeedsConfirm({ ...basePlan, crossZoneWarning: { originZone: "zone-A", targetZone: "zone-B", zoneSurfaces: ["dns"] } }));
  // The direction that is silent when wrong: the engine warns but does NOT refuse an unreadable origin, so
  // demanding a confirmation here would block a restore it is happy to run, and the screen would merely
  // look more cautious.
  ok("an UNVERIFIABLE origin demands nothing, matching the engine", !crossZoneNeedsConfirm({ ...basePlan, crossZoneWarning: { originZone: null, targetZone: "zone-B", zoneSurfaces: ["dns"] } }));
}

console.log("\n-- both guards can fire at once, and neither hides the other --");
{
  // Both can fire at once. Which one owns the type-to-confirm (the account, as the wider blast radius) is
  // decided in confirm.ts and is not observable here, for the reason given at the top of this file.
  const plan: RestorePlan = {
    ...basePlan,
    crossAccountWarnings: [{ leg: "cf-config", originAccount: "acct-0", targetAccount: "acct-1" }],
    crossZoneWarning: { originZone: "zone-A", targetZone: "zone-B", zoneSurfaces: ["dns"] },
  };
  const text = await render(plan, "zone-B");
  ok("both warnings render, neither hiding the other", /different Cloudflare account/i.test(text) && /different Cloudflare zone/i.test(text));
}

// R-80: the break-glass-only posture branch used to offer ONLY attended verification (proof, never a write),
// because that was the whole truth when break-glass.ts could only ever dry-run. It can now apply for real
// (its own confirm+apply block, dual-control gated), so an operator who reaches the STANDARD flow first
// (this screen), rather than the break-glass panel's own secondary entry point on the runless landing, must
// be offered BOTH -- not steered only at the one that cannot write.
console.log("\n-- R-80: the break-glass-only posture branch offers BOTH attended verification and the break-glass restore apply --");
{
  const plan: RestorePlan = { ...basePlan, ok: false, reason: `${BREAK_GLASS_PREFIX}: no operational key and no browser-supplied master` };
  const el = await renderPlan(engine, plan, () => req("zone-A"), () => undefined, () => undefined);
  const text = textOf(el);
  ok("the break-glass-only posture is named", /Break-glass-only posture/.test(text));
  const attendBtn = qs(el, '[data-dp="restore-flow.button.navigate-restore-attend#2"]');
  const applyBtn = qs(el, '[data-dp="restore-flow.button.navigate-restore-break-glass#2"]');
  ok("the attended-verification action is still offered", attendBtn !== null);
  ok("a break-glass restore (apply) action is ALSO offered, not just proof", applyBtn !== null);
  ok("the apply action's own label says apply, not just verify", applyBtn !== null && textOf(applyBtn).includes("preview + apply"));
  ok("the reassurance text names BOTH paths, not just attended verification", /attended verification/i.test(text) && /apply a real restore/i.test(text));
}


// ===========================================================================
// THE DRY-RUN REASSURANCE MUST ARRIVE BEFORE THE BLAST RADIUS, IN EVERY TONE.
// ===========================================================================
//
// "Nothing has been written yet" rode only on the integrity statement at the FOOT of the card, under the
// resolved-destinations table (up to 200 rows), under every skipped group, and under the cross-account and
// cross-zone warnings this file already drives. An operator scrolling a large plan therefore met the whole
// blast radius, in warn and danger tints, before the one sentence saying none of it had happened.
//
// It now ends the impact banner, which is the FIRST element on the card. Asserted in all three tones (calm,
// the warn non-latest, the danger redirect) and, crucially, on ORDER: the sentence must appear before the
// cross-zone warning text, not merely somewhere in the card. An assertion that only tested "the words are
// present" would have passed before this change.
console.log("\n-- 'Nothing has been written yet' arrives before the blast radius, in every tone --");
{
  const REASSURANCE = "Nothing has been written yet";
  // FIGURES is the element renderPlan appends IMMEDIATELY after the banner, so "before the figures" is
  // exactly "in the banner". Asserting mere presence would be vacuous: the integrity statement at the foot
  // carries the same sentence, so a card with no banner copy at all still contains the words.
  const FIGURES = "Records verified";
  const leads = (text: string): boolean => {
    const at = text.indexOf(REASSURANCE);
    const figures = text.indexOf(FIGURES);
    return at >= 0 && figures >= 0 && at < figures;
  };

  const calm = await render(basePlan, "zone-A");
  ok("calm tone: the reassurance LEADS (before the plan figures, so it is in the banner)", leads(calm));

  const older = await render({ ...basePlan, isLatest: false }, "zone-A");
  ok("warn tone (an older run over current data): the reassurance LEADS", leads(older));
  ok("and the older-run caution is still stated", /older run/i.test(older));

  // The danger tone: a redirect writes every record to ONE binding the operator chose.
  const redirectEl = await renderPlan(
    engine,
    basePlan,
    () => ({ runId: basePlan.runId, target: { binding: "KV_TARGET" } }) as RestoreRequest,
    () => undefined,
    () => undefined,
  );
  const redirect = textOf(redirectEl);
  ok("danger tone (a whole-run redirect): the reassurance LEADS", leads(redirect));
  ok("and the redirect fact is still stated", redirect.includes("KV_TARGET"));

  // ORDER, which is the whole point. Driven against a plan carrying the cross-zone warning this file
  // exists for, so the "blast radius" being ordered against is a real one rendered by the real card.
  const withWarning = await render(
    { ...basePlan, crossZoneWarning: { originZone: "zone-A", targetZone: "zone-B", zoneSurfaces: ["dns", "rulesets"] } },
    "zone-B",
  );
  const firstReassurance = withWarning.indexOf(REASSURANCE);
  const warningAt = withWarning.search(/different Cloudflare zone/i);
  ok("the reassurance appears at all on a warning-bearing plan", firstReassurance >= 0);
  ok("the cross-zone warning appears at all (the control for the order test)", warningAt >= 0);
  ok("and the reassurance comes BEFORE the warning, not after it", firstReassurance >= 0 && warningAt >= 0 && firstReassurance < warningAt);
  // The foot keeps its own copy deliberately (it is a claim about the records above it), so the sentence
  // is expected TWICE. Asserting the count pins that the banner copy was ADDED rather than MOVED, which is
  // what makes the "before the warning" assertion above about the banner and not about the old placement.
  ok("the sentence is said twice: once leading, once on the integrity statement", withWarning.split(REASSURANCE).length - 1 === 2);
}

console.log(failures === 0 ? "\nRESTORE CROSS-ZONE RENDER PASS" : `\n${failures} FAILURE(S)`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
