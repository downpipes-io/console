// Validate the CONSOLE half of a defect: the Overview "Last audited" tile composed a
// sentence out of an audit entry's ACTION and ACTOR and never read its OUTCOME.
//
// Run: node test/validate-overview-audit-outcome.ts
//
// THE DEFECT, STATED AS NARROWLY AS IT CAN BE PROVED. `lastAuditedCard` rendered
// `Newest: <action label> by <actorEmail>.` with no reference to `newest.outcome`. Roughly half the
// closed AuditAction vocabulary is phrased as a completed deed, so a DENIED role grant read as a
// granted role and a FAILED break-glass sign-in read as a break-glass sign-in, on the first screen
// an operator sees. The broader claim that an operator auditing a compromise would misread a run of
// refused rows does NOT hold: the audit table renders the outcome in its own column and in the
// detail modal, and that is the screen an operator audits from. The claim survives on this tile
// alone, and that is what is graded here.
//
// THE SECOND HALF OUTLIVES THE ENGINE REPAIR, WHICH IS WHY IT IS A SEPARATE SECTION BELOW.
// `POST /admin/auth/recovery` is unauthenticated by design, and until it was fixed,
// `recoveryRecover` wrote the caller-supplied email straight into `actorEmail` on both negative
// branches. The audit chain is append-only and tamper-evident, so any row a pre-repair engine wrote
// keeps the address whoever typed it chose, for ever, and this tile is the surface that renders it.
// The console cannot repair the chain; it can decline to present an unverified address as the actor.
//
// WHAT IS NOT MEASURED HERE, SAID PLAINLY: whether any live estate actually holds such a row. No
// estate is contacted by this file. That pass drove its fabricated address through the real router
// with IN-MEMORY doubles and recorded that no estate was deployed, driven or read, so "at least one
// estate holds a poisoned row" is unevidenced and is not asserted anywhere below.
//
// WHAT THIS FILE GRADES, kept apart rather than run together as one pass:
//   PRODUCED   the sentence names the outcome for EVERY member of the closed outcome union, over a
//              spread of actions, and names the remedy on a refusal.
//   REACHED    it arrives on the REAL rendered tile through buildRecoverySection, not only in a
//              return value. An assertion that "no refused entry reads as accomplished" holds over
//              an empty tile too, so every check here is a sentinel that must be REACHED: each one
//              is paired with a positive that fails if the tile did not render.
//   ATTRIBUTED a refused break-glass row is not attributed to the address the caller typed, and an
//              authenticated actor whose action was refused still IS named (the over-fix direction).
//   BORROWED   the vocabulary is the audit log's own. recovery.ts no longer carries a private action
//              label table, and the three arms of the one it did carry that named actions no engine
//              can write are gone.
//   REACHABLE  the remedy is a route an operator can take, not a sentence about one.
//   CENSUSED   the tile is the ONLY console composer that dropped the outcome, with the audit table
//              carried as the known positive so a census that found nothing is a red, not a pass.
//   SERVED     the sentences are in the committed bundle, because the browser is served public/*.js.
//
// FS-WRITES: none outside this repo

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installDomShim, flushAsync, markConnected } from "./dom-shim.ts";

(globalThis as unknown as { location: unknown }).location = {
  origin: "https://control.downpipes.io",
  href: "https://control.downpipes.io/",
  pathname: "/",
  assign: () => {},
  replace: () => {},
};
installDomShim();

const { newestAuditSentence, buildRecoverySection } = await import("../src/screens/overview/recovery.ts");
const { AUDIT_ACTION_GROUPS, actionLabel } = await import("../src/screens/access-security/audit-display.ts");
const { ROUTE_AUDIT } = await import("../src/screens/access-security/shared.ts");
import type { AuditEvent, AuditAction, AuditOutcome } from "../src/api.ts";
import type { OverviewData, FleetSummary } from "../src/screens/overview/shared.ts";

let failures = 0;
let checks = 0;
function ok(name: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "../src");
const readSrc = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

// The three outcomes are the CLOSED union in src/lib/api/types/audit.ts. Listed here so a member
// added to the engine's vocabulary without a rendering here is a red rather than an untested arm.
const OUTCOMES: AuditOutcome[] = ["success", "denied", "failed"];

// A fabricated address of the shape the pre-repair engine would have stored: it exists nowhere in
// any account and is never sent anywhere. It is a local string literal in a test file, deliberately
// on the reserved .invalid TLD, and it is never written to a log this file then quotes back.
const TYPED_ADDRESS = "chair-controlchar-never-existed@victim.example.invalid";

function event(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    seq: 41,
    ts: "2026-08-11T23:00:00.000Z",
    actorEmail: "owner@example.com",
    actorMethod: "access",
    sourceIp: "203.0.113.9",
    action: "role-change",
    outcome: "success",
    target: { kind: "role", email: "ops@example.com", role: "operator" },
    prevHash: "sha384:prev",
    hash: "sha384:head",
    ...over,
  } as AuditEvent;
}

// ============================================================================
// 0. THE DEFECT'S OWN SHAPE, read off the source so the repair cannot be undone quietly
// ============================================================================
console.log("\n-- 0. the composer reads the outcome at all --");

const RECOVERY_SRC = readSrc("screens/overview/recovery.ts");
// A known positive on the reader first: if this file cannot be read, every absence check below is
// vacuous and would pass over an empty string.
ok("the tile's source was read (instrument control)", RECOVERY_SRC.length > 5_000 && RECOVERY_SRC.includes("lastAuditedCard"));
ok("the composer references the entry's outcome", /e\.outcome/.test(RECOVERY_SRC));
ok("no composer emits an action-and-actor sentence with no outcome beside it", !/Newest: \$\{auditActionLabel\(/.test(RECOVERY_SRC));

// ============================================================================
// 1. PRODUCED: every member of the closed outcome union is named, over a spread of actions
// ============================================================================
console.log("\n-- 1. PRODUCED: the outcome is named for every member of the closed union --");

const EVERY_ACTION: AuditAction[] = AUDIT_ACTION_GROUPS.flatMap((g) => g.actions);
ok("the closed action union was enumerated (instrument control)", EVERY_ACTION.length > 50);

for (const outcome of OUTCOMES) {
  const sentences = EVERY_ACTION.map((action) => newestAuditSentence(event({ action, outcome })));
  ok(`every action produces a sentence naming outcome "${outcome}" (${sentences.length} actions)`,
    sentences.every((s) => s.includes(`Outcome: ${outcome.charAt(0).toUpperCase()}${outcome.slice(1)}`)));
  ok(`no "${outcome}" sentence is empty or a bare full stop (instrument control)`,
    sentences.every((s) => s.length > 20 && s.startsWith("Newest: ")));
}

// The consequence clause is what stops a past-tense action label reading as a completed deed. It is
// asserted on the two refusal outcomes and asserted ABSENT on success, so an over-fix that stamps
// "not carried out" on everything fails here.
{
  const denied = newestAuditSentence(event({ action: "role-change", outcome: "denied" }));
  const failed = newestAuditSentence(event({ action: "restore-apply", outcome: "failed" }));
  const success = newestAuditSentence(event({ action: "role-change", outcome: "success" }));
  ok("a denied entry says it was not carried out", denied.includes("so it was not carried out"));
  ok("a failed entry says it did not complete", failed.includes("so it did not complete"));
  ok("a successful entry claims neither (the over-fix direction)",
    !success.includes("not carried out") && !success.includes("did not complete"));
  ok("a denied entry names the remedy", denied.includes(`Open the audit log filtered to denied.`));
  ok("a failed entry names the remedy", failed.includes(`Open the audit log filtered to failed.`));
  ok("a successful entry does not send the operator anywhere", !success.includes("Open the audit log"));
}

// THE HARM, STATED AS THE PRODUCT SENTENCE IT PRODUCES. `recovery-code-used` is the one action name
// in the closed vocabulary that is itself a past-tense claim of consumption, which is why the
// nineteenth defect landed on it. The two directions are graded together so a repair that merely
// deleted the action label would not pass.
{
  const refused = newestAuditSentence(event({ action: "recovery-code-used", outcome: "failed", actorMethod: "recovery", actorEmail: null }));
  const real = newestAuditSentence(event({ action: "recovery-code-used", outcome: "success", actorMethod: "recovery", actorEmail: "owner@example.com" }));
  ok("a REFUSED break-glass attempt no longer reads as an accomplished sign-in", refused.includes("Outcome: Failed"));
  ok("a refused break-glass attempt still says WHAT was attempted", refused.includes("Recovery code used"));
  ok("a real break-glass sign-in still reads as one, and names the owner who made it",
    real.includes("Outcome: Success") && real.includes("owner@example.com"));
  ok("the two are not the same sentence (the discriminator exists at all)", refused !== real);
}

// ============================================================================
// 2. ATTRIBUTED: who the tile is allowed to name
// ============================================================================
console.log("\n-- 2. ATTRIBUTED: an unverified address is not presented as the actor --");

{
  const poisoned = newestAuditSentence(event({
    action: "recovery-code-used", outcome: "failed", actorMethod: "recovery", actorEmail: TYPED_ADDRESS,
  }));
  ok("a refused break-glass row does not print the address the caller typed", !poisoned.includes(TYPED_ADDRESS));
  ok("it says an address was recorded and was never verified", poisoned.includes("by an unverified address"));
  ok("it still names the outcome and the remedy (the sentinel is REACHED, not merely absent)",
    poisoned.includes("Outcome: Failed") && poisoned.includes("Open the audit log filtered to failed."));

  const deniedPoison = newestAuditSentence(event({
    action: "recovery-code-used", outcome: "denied", actorMethod: "recovery", actorEmail: TYPED_ADDRESS,
  }));
  ok("the same holds on the rate-limited DENIED branch, which is the other one that wrote an actor",
    !deniedPoison.includes(TYPED_ADDRESS) && deniedPoison.includes("by an unverified address"));
}

// The over-fix direction, and it is the reason the rule is narrow. An operator who authenticated and
// then had an action refused IS a verified actor: the identity was established before the refusal,
// which is exactly the distinction audit-types.ts draws on authn-failure.
{
  const authenticatedRefusal = newestAuditSentence(event({
    action: "restore-apply", outcome: "failed", actorMethod: "access", actorEmail: "ops@example.com",
  }));
  ok("an AUTHENTICATED actor whose action failed is still named", authenticatedRefusal.includes("by ops@example.com"));
  const successfulBreakGlass = newestAuditSentence(event({
    action: "recovery-code-used", outcome: "success", actorMethod: "recovery", actorEmail: "owner@example.com",
  }));
  ok("a SUCCESSFUL break-glass sign-in is still attributed, because the code match verified it",
    successfulBreakGlass.includes("by owner@example.com"));
  const noActor = newestAuditSentence(event({ actorEmail: null, actorMethod: "engine" }));
  ok("an entry with no actor recorded invents nobody", !noActor.includes(" by ") && noActor.includes("Outcome: Success"));
}

// ============================================================================
// 3. BORROWED: one vocabulary, not two
// ============================================================================
console.log("\n-- 3. BORROWED: the tile reuses the audit log's own label table --");

ok("recovery.ts no longer declares a private action-label switch", !RECOVERY_SRC.includes("function auditActionLabel"));
ok("recovery.ts imports the audit log's actionLabel", /import \{ actionLabel \} from "\.\.\/access-security\/audit-display\.ts";/.test(RECOVERY_SRC));
// The three arms the private switch carried that no engine can ever write. Each is asserted absent
// from the union, so this is a claim about the product rather than about a string.
for (const dead of ["role-grant", "role-revoke", "downpipe-update"]) {
  ok(`"${dead}" is not a member of the closed action union, so the arm that named it was dead`,
    !(EVERY_ACTION as string[]).includes(dead));
}
ok("the shared label table covers every member of the union (no hyphen-strip fallback in practice)",
  EVERY_ACTION.every((a) => actionLabel(a) !== a.replace(/-/g, " ")));
ok("the shared table still degrades rather than throwing for an action a NEWER engine writes",
  actionLabel("some-future-action" as AuditAction) === "some future action");

// ============================================================================
// 4. REACHED: the sentence arrives on the real rendered tile
// ============================================================================
console.log("\n-- 4. REACHED: the tile itself, rendered through buildRecoverySection --");

const emptyFleet: FleetSummary = {
  total: 0, healthy: 0, stale: 0, failed: 0, disabled: 0, inFlight: 0, rows: [],
  newestGoodAt: null, worstGoodAt: null, noGoodBackupCount: 0, anyRuns: false,
};

function overviewData(audit: AuditEvent[]): OverviewData {
  return {
    health: { ok: true, value: { ok: true, service: "downpipe engine" } },
    status: { ok: false, error: new Error("not exercised by this validator") },
    licence: { ok: true, value: { tier: "community", valid: false } },
    updates: { ok: true, value: { configured: true, verified: true, currentVersion: "0.0.0" } },
    history: { ok: true, value: {} },
    downpipes: { ok: true, value: [] },
    drillEvidence: { ok: true, value: [] },
    audit: { ok: true, value: audit },
    approvals: { ok: true, value: [] },
    discovery: { ok: false, error: new Error("not exercised by this validator") },
  } as unknown as OverviewData;
}

async function renderTileText(audit: AuditEvent[]): Promise<{ text: string; el: HTMLElement }> {
  const section = buildRecoverySection(overviewData(audit), emptyFleet, () => {});
  markConnected(section);
  await flushAsync();
  return { text: section.textContent ?? "", el: section };
}

{
  const { text } = await renderTileText([event({ action: "role-change", outcome: "denied", actorEmail: "ops@example.com" })]);
  // THE POSITIVE THAT MAKES EVERY ABSENCE BELOW MEAN SOMETHING. A blank section would satisfy
  // "no refused entry reads as accomplished" perfectly.
  ok("the recovery section actually rendered its Last audited tile", text.includes("Last audited") && text.length > 200);
  ok("the rendered tile names the outcome", text.includes("Outcome: Denied"));
  ok("the rendered tile says the action was not carried out", text.includes("so it was not carried out"));
  ok("the rendered tile names the remedy", text.includes("Open the audit log filtered to denied."));
  ok("the rendered tile still names the authenticated actor", text.includes("ops@example.com"));
}
{
  const { text } = await renderTileText([event({
    action: "recovery-code-used", outcome: "failed", actorMethod: "recovery", actorEmail: TYPED_ADDRESS,
  })]);
  ok("the break-glass tile rendered (sentinel reached)", text.includes("Last audited") && text.includes("Recovery code used"));
  ok("the rendered tile never prints the caller-typed address", !text.includes(TYPED_ADDRESS));
  ok("the rendered tile says the attempt failed", text.includes("Outcome: Failed"));
}
{
  // The two arms that must NOT gain any of this: a wired-but-empty chain and a successful newest row.
  const { text } = await renderTileText([]);
  ok("the empty-chain tile still renders its own prompt", text.includes("No events yet"));
  ok("the empty-chain tile claims no outcome", !text.includes("Outcome:"));

  const { text: okText } = await renderTileText([event({ action: "downpipe-create", outcome: "success" })]);
  ok("a successful newest row reads as success", okText.includes("Outcome: Success"));
  ok("a successful newest row names no remedy", !okText.includes("Open the audit log"));
}

// ============================================================================
// 5. REACHABLE: the remedy is a route, not a sentence about one
// ============================================================================
console.log("\n-- 5. REACHABLE: a refused row opens the audit log already filtered --");

function tileButtons(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll("button.stat--button")] as HTMLElement[];
}

{
  const { el } = await renderTileText([event({ action: "role-change", outcome: "failed" })]);
  ok("the refused tile is an operable control, not a plain region", tileButtons(el).length === 1);
  const { el: okEl } = await renderTileText([event({ action: "role-change", outcome: "success" })]);
  ok("a successful newest row leaves the tile a plain region (the over-fix direction)", tileButtons(okEl).length === 0);
}
// Written as a regular expression rather than a string literal on purpose: the thing being asserted
// IS a template placeholder, and a string holding one trips biome's noTemplateCurlyInString.
ok("the route the remedy names is the audit log's own constant, not a second spelling",
  ROUTE_AUDIT === "/access/audit" && /\$\{ROUTE_AUDIT\}\?outcome=\$\{newest\.outcome\}/.test(RECOVERY_SRC));
// The filter the URL carries has to be one the audit screen actually accepts, or the tile lands on
// an unfiltered table and the remedy is a dead end.
{
  const filters = readSrc("screens/access-security/audit-filters.ts");
  ok("the audit screen seeds its filters from the URL (instrument control)", filters.includes("query.get(\"outcome\")"));
  ok("and it accepts only members of the closed outcome union",
    filters.includes("(AUDIT_OUTCOME_OPTIONS as string[]).includes(outcome)"));
}

// ============================================================================
// 6. CENSUSED: is the tile the only console reader that dropped the outcome?
// ============================================================================
console.log("\n-- 6. CENSUSED: every console composer of an audit entry --");

// The population is every src file that imports the AuditEvent type. A composer is one that renders
// an entry's fields to an operator. The audit table is carried as the KNOWN POSITIVE: if the census
// cannot find the surface that has always rendered the outcome, the census is broken and says so.
const ALL_SRC: string[] = [];
(function walk(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts")) ALL_SRC.push(p);
  }
})(SRC);
ok("the console source tree was walked (instrument control)", ALL_SRC.length > 400);

const auditReaders = ALL_SRC.filter((p) => {
  const body = readFileSync(p, "utf8");
  return /\bAuditEvent\b/.test(body) && !p.endsWith("types/audit.ts") && !p.includes("/demo/") && !p.includes("/api/");
}).map((p) => p.slice(SRC.length + 1));
ok(`the census found the audit readers it must find (found ${auditReaders.length})`,
  auditReaders.includes("screens/access-security/audit-events.ts")
  && auditReaders.includes("screens/access-security/audit-display.ts")
  && auditReaders.includes("screens/overview/recovery.ts"));

const eventsSrc = readSrc("screens/access-security/audit-events.ts");
ok("KNOWN POSITIVE: the audit table renders the outcome in its own column",
  eventsSrc.includes('header: "Outcome"') && eventsSrc.includes("outcomeStatus(e.outcome)"));
ok("KNOWN POSITIVE: the detail modal carries an Outcome line too",
  eventsSrc.includes('kvLine("Outcome", outcomeStatus(e.outcome))'));
// Every reader that composes an entry into operator-facing text must now reach an outcome. The two
// display leaves that do not compose one (the label tables, the filter bar) are named rather than
// silently excluded.
for (const rel of auditReaders) {
  const body = readFileSync(join(SRC, rel), "utf8");
  const composes = /actorEmail|actionLabel\(/.test(body);
  if (!composes) continue;
  // Either shape counts: reading the field off an entry, or being handed the typed value to render.
  // audit-display.ts is the second kind (outcomeStatus takes an AuditOutcome), and before the repair
  // recovery.ts was neither, which is what makes this question able to fail.
  ok(`${rel} reaches the entry's outcome`, /\.outcome\b/.test(body) || /\bAuditOutcome\b/.test(body));
}

// ============================================================================
// 7. SERVED: the browser is handed public/*.js, not src/
// ============================================================================
console.log("\n-- 7. the SERVED artefact carries the sentences --");

const publicDir = join(HERE, "../public/");
const servedJs = readdirSync(publicDir).filter((f) => f.endsWith(".js"));
const servedText = servedJs.map((f) => readFileSync(join(publicDir, f), "utf8")).join("\n");
ok("the served bundle was read at all (instrument control)", servedJs.length >= 2 && servedText.length > 100_000);
ok("the served bundle carries a tile sentence the console has shipped for months (instrument control)",
  servedText.includes("Privileged actions are recorded here as they happen."));
ok("the served bundle carries the outcome clause", servedText.includes("Outcome: "));
ok("the served bundle carries the denied consequence", servedText.includes("so it was not carried out"));
ok("the served bundle carries the failed consequence", servedText.includes("so it did not complete"));
ok("the served bundle carries the remedy", servedText.includes("Open the audit log filtered to "));
ok("the served bundle carries the unverified-actor phrase", servedText.includes("an unverified address"));
// The old sentence is gone from what is actually served, which is the check a source-only assertion
// cannot make: a bundle that was never rebuilt would still be shipping the defect.
ok("the served bundle no longer carries the dead label arms",
  !servedText.includes("a role granted") && !servedText.includes("a downpipe updated"));

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-overview-audit-outcome: ${checks} checks, ${failures} failures`);
if (failures > 0) process.exitCode = 1;
if (failures > 0) process.exitCode = 1;
