// Validate the pure ranking / tone logic of the Security centre screen
// (src/screens/security-centre.ts), section 7 + section 9.
// Run with: node test/validate-security-centre.ts
//
// The screen is DOM-heavy, but its load-bearing logic (the severity-then-status ordering
// that puts the most important unresolved check first, and the status/score tone mapping
// that is never a stale green) is extracted into pure functions, testable without a DOM.
// None of the imported modules execute DOM at import time, so importing the screen in Node
// succeeds.
//
// Coverage:
//   compareChecks (the ranked list; the contract's "severity-ranked checks"):
//     - critical sorts before high before medium before low
//     - within a severity, fail < risk-accepted < resolved-alternative < pass
//     - a critical fail leads a high fail (severity dominates status)
//     - the sort is stable-ish (title tiebreak) and deterministic
//   severityRank / statusOrder: the underlying orderings
//   statusTone (the dot hue; never a stale green):
//     - a fail uses the severity tone (a critical fail reads danger, not ok)
//     - a pass is ok; risk-accepted is warn; resolved-alternative is trust
//   severityTone: critical=danger, high=warn, medium=info, low=neutral
//   scoreStatus (honest score tone; never green for a weak score):
//     - >=90 strong/ok, >=70 fair/warn, <70 needs-work/danger; boundaries exact
//
// COVERAGE / gap detection (section 7 + section 9):
//     coverageStatusTone (the dot hue; never a stale green): unprotected=danger, untested=warn,
//       protected=ok (an unprotected resource is NEVER the ok tone)
//     coverageStatusLabel / coverageTypeLabel: the short labels
//     compareCoverageResources (the ranked rows): unprotected first, then untested, then protected;
//       then type, then name; the most important gap leads
//     coverageStatement: an unprotected resource reads "<resource> exists but is NOT backed up"
//     coverageFindings (the pure projection the renderer consumes):
//       - an unprotected resource yields a danger finding carrying the "exists but is NOT backed up"
//         statement AND the "back-up" action
//       - an untested resource yields a warn finding with no back-up action
//       - a protected resource yields an ok finding with no back-up action
//       - the findings are ranked (unprotected first)
//     renderCoverage (rendered against a stub, via a minimal DOM shim):
//       - hasInventory:true with resources renders the unprotected finding text and a "Back this up"
//         button that targets the downpipe-create flow, plus the rollup
//       - the HONEST-UNKNOWN state (hasInventory:false) renders the "coverage is unknown" copy and
//         the "enable read-only discovery" guidance, and makes NO false coverage claim

import {
  compareChecks,
  severityRank,
  statusOrder,
  statusTone,
  severityTone,
  scoreStatus,
  isNeedsAttention,
  isOverriddenStatus,
  overrideKindLabel,
  overrideKindHelp,
  coverageStatusTone,
  coverageStatusLabel,
  coverageTypeLabel,
  coverageStatusOrder,
  compareCoverageResources,
  coverageStatement,
  coverageFindings,
  renderCoverage,
  COVERAGE_CARDS_PER_GROUP,
  parseInventory,
  parseInventoryGroup,
} from "../src/screens/security-centre.ts";
import type {
  PostureCheck,
  PostureSeverity,
  PostureStatus,
  CoverageReport,
  CoverageResource,
  CoverageResourceType,
  CoverageStatus,
  Caller,
} from "../src/api.ts";
import { installDomShim, type ShimNode, qs, qsa, textOf, flushAsync, markConnected } from "./dom-shim.ts";

let failures = 0;

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function eq<T>(label: string, got: T, want: T): void {
  const cond = JSON.stringify(got) === JSON.stringify(want);
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

function check(id: string, severity: PostureSeverity, status: PostureStatus): PostureCheck {
  const autoStatus = status === "pass" ? "pass" : status === "unattested" ? "cannot-verify" : "fail";
  return { id, title: id, severity, status, autoStatus, control: "TEST", detail: "d", remediation: "r", how: "how" };
}

// The DOM shim used to inspect the rendered coverage tree (text and structure only) is the
// shared test/dom-shim.ts (installDomShim + ShimNode), the canonical source for every validator.

// ---------------------------------------------------------------------------
// severityRank + statusOrder (the underlying orderings).
// ---------------------------------------------------------------------------
console.log("\n-- severityRank + statusOrder --");

ok("severityRank: critical > high > medium > low", severityRank("critical") > severityRank("high") && severityRank("high") > severityRank("medium") && severityRank("medium") > severityRank("low"));
ok("statusOrder: fail first", statusOrder("fail") < statusOrder("risk-accepted") && statusOrder("risk-accepted") < statusOrder("resolved-alternative") && statusOrder("resolved-alternative") < statusOrder("pass"));
ok("statusOrder: the needs-attention pair leads (fail, then needs-attestation)", statusOrder("fail") < statusOrder("unattested") && statusOrder("unattested") < statusOrder("risk-accepted"));
ok("statusOrder: customer-graded passes sit between accepted and N/A", statusOrder("compensating-control") < statusOrder("attested-pass") && statusOrder("attested-pass") < statusOrder("not-applicable") && statusOrder("not-applicable") < statusOrder("pass"));
ok("isNeedsAttention: exactly fail + unattested", isNeedsAttention("fail") && isNeedsAttention("unattested") && !isNeedsAttention("risk-accepted") && !isNeedsAttention("attested-pass") && !isNeedsAttention("compensating-control") && !isNeedsAttention("not-applicable") && !isNeedsAttention("pass"));
ok("isOverriddenStatus: the customer-graded set", isOverriddenStatus("risk-accepted") && isOverriddenStatus("attested-pass") && isOverriddenStatus("compensating-control") && isOverriddenStatus("not-applicable") && isOverriddenStatus("resolved-alternative") && !isOverriddenStatus("fail") && !isOverriddenStatus("unattested") && !isOverriddenStatus("pass"));

// ---------------------------------------------------------------------------
// compareChecks: the ranked list.
// ---------------------------------------------------------------------------
console.log("\n-- compareChecks: severity dominates, then status --");

{
  // Severity ordering across statuses: a critical-pass still sorts above a low-fail
  // (severity dominates the ranking).
  const criticalPass = check("crit-pass", "critical", "pass");
  const lowFail = check("low-fail", "low", "fail");
  ok("critical (any status) sorts before low (any status)", compareChecks(criticalPass, lowFail) < 0);
}

{
  // Within the same severity, failing leads accepted leads passing.
  const fail = check("a", "high", "fail");
  const accepted = check("b", "high", "risk-accepted");
  const pass = check("c", "high", "pass");
  ok("same severity: fail before risk-accepted", compareChecks(fail, accepted) < 0);
  ok("same severity: risk-accepted before pass", compareChecks(accepted, pass) < 0);
  ok("same severity: fail before pass", compareChecks(fail, pass) < 0);
}

{
  // A critical fail leads a high fail (severity dominates status).
  const critFail = check("x", "critical", "fail");
  const highFail = check("y", "high", "fail");
  ok("critical fail before high fail", compareChecks(critFail, highFail) < 0);
}

{
  // A full sort: the most important unresolved item must be first, a passing low last.
  const checks: PostureCheck[] = [
    check("low-pass", "low", "pass"),
    check("high-fail", "high", "fail"),
    check("crit-fail", "critical", "fail"),
    check("med-accepted", "medium", "risk-accepted"),
    check("crit-pass", "critical", "pass"),
  ];
  const sorted = checks.slice().sort(compareChecks).map((c) => c.id);
  eq("full sort order", sorted, ["crit-fail", "crit-pass", "high-fail", "med-accepted", "low-pass"]);
  // Deterministic: sorting twice yields the same order.
  const sorted2 = checks.slice().sort(compareChecks).map((c) => c.id);
  eq("sort is deterministic", sorted2, sorted);
}

{
  // Title tiebreak: same severity + status orders by title for stability.
  const b = check("bravo", "medium", "fail");
  const a = check("alpha", "medium", "fail");
  ok("same severity+status: title tiebreak (alpha before bravo)", compareChecks(a, b) < 0);
}

// ---------------------------------------------------------------------------
// severityTone + statusTone (the dot hue; never a stale green).
// ---------------------------------------------------------------------------
console.log("\n-- severityTone + statusTone --");

eq("severityTone critical=danger", severityTone("critical"), "danger");
eq("severityTone high=warn", severityTone("high"), "warn");
eq("severityTone medium=info", severityTone("medium"), "info");
eq("severityTone low=neutral", severityTone("low"), "neutral");

// A FAIL must NOT read ok/green; it takes the severity tone, so a critical fail is danger.
eq("critical fail tone = danger (never ok)", statusTone("fail", severityTone("critical")), "danger");
ok("a fail is never the ok tone", statusTone("fail", severityTone("critical")) !== "ok" && statusTone("fail", severityTone("low")) !== "ok");
eq("pass tone = ok", statusTone("pass", "danger"), "ok");
eq("risk-accepted tone = warn", statusTone("risk-accepted", "danger"), "warn");
eq("resolved-alternative tone = trust", statusTone("resolved-alternative", "danger"), "trust");
// The new override states: needs-attestation reads warn (amber, never the red of a failure the operator
// cannot clear); a customer-graded pass reads trust; N/A reads neutral.
eq("unattested tone = warn (amber, never red)", statusTone("unattested", severityTone("critical")), "warn");
ok("an unattested check is never the danger tone", statusTone("unattested", severityTone("critical")) !== "danger");
eq("attested-pass tone = trust", statusTone("attested-pass", "danger"), "trust");
eq("compensating-control tone = trust", statusTone("compensating-control", "danger"), "trust");
eq("not-applicable tone = neutral", statusTone("not-applicable", "danger"), "neutral");
// The kind labels + explanations the override modal shows: every kind has both, and the report/score
// consequence is stated (the load-bearing copy for an informed decision).
for (const k of ["attested-pass", "compensating-control", "not-applicable", "risk-accepted"] as const) {
  ok(`overrideKindLabel(${k}) is non-empty`, overrideKindLabel(k).length > 4);
  ok(`overrideKindHelp(${k}) explains the consequence`, overrideKindHelp(k).length > 20);
}
ok("risk-accept help never dresses a risk as a pass", overrideKindHelp("risk-accepted").includes("never as a pass"));
ok("N/A help states the score exclusion", overrideKindHelp("not-applicable").includes("Removed from the score"));

// ---------------------------------------------------------------------------
// scoreStatus (honest score tone; never green for a weak score).
// ---------------------------------------------------------------------------
console.log("\n-- scoreStatus --");

eq("score 100 -> ok/strong", scoreStatus(100), { tone: "ok", label: "strong" });
eq("score 90 (boundary) -> ok/strong", scoreStatus(90), { tone: "ok", label: "strong" });
eq("score 89 -> warn/fair", scoreStatus(89), { tone: "warn", label: "fair" });
eq("score 70 (boundary) -> warn/fair", scoreStatus(70), { tone: "warn", label: "fair" });
eq("score 69 -> danger/needs work", scoreStatus(69), { tone: "danger", label: "needs work" });
eq("score 0 -> danger/needs work", scoreStatus(0), { tone: "danger", label: "needs work" });
ok("a 0 score is NEVER the ok tone (no stale green)", scoreStatus(0).tone !== "ok" && scoreStatus(50).tone !== "ok");

// ===========================================================================
// COVERAGE / gap detection (section 7 + section 9).
// ===========================================================================

function res(type: CoverageResourceType, id: string, status: CoverageStatus, name = id, downpipeId?: string): CoverageResource {
  return { type, id, name, status, ...(downpipeId !== undefined ? { downpipeId } : {}) };
}

function coverageReport(resources: CoverageResource[], hasInventory = true): CoverageReport {
  const rollup = {
    total: resources.length,
    protected: resources.filter((r) => r.status === "protected").length,
    unprotected: resources.filter((r) => r.status === "unprotected").length,
    untested: resources.filter((r) => r.status === "untested").length,
  };
  return { hasInventory, generatedAt: "2026-06-09T00:00:00.000Z", rollup, resources };
}

// ---------------------------------------------------------------------------
// coverageStatusTone / coverageStatusLabel / coverageTypeLabel (never a stale green).
// ---------------------------------------------------------------------------
console.log("\n-- coverage tones + labels --");

eq("unprotected tone = danger", coverageStatusTone("unprotected"), "danger");
eq("untested tone = warn", coverageStatusTone("untested"), "warn");
eq("protected tone = ok", coverageStatusTone("protected"), "ok");
ok("an unprotected resource is NEVER the ok tone (no stale green)", coverageStatusTone("unprotected") !== "ok" && coverageStatusTone("untested") !== "ok");

eq("unprotected label = not backed up", coverageStatusLabel("unprotected"), "not backed up");
eq("untested label = backed up, not yet proven", coverageStatusLabel("untested"), "backed up, not yet proven");
// The strong chip reads "proven", never "protected": Sources/Overview use "protected" for merely
// attached-and-covered, while this screen's strong state means a restore has been PROVEN.
eq("protected label = proven", coverageStatusLabel("protected"), "proven");

eq("type label kv", coverageTypeLabel("kv"), "KV namespace");
eq("type label r2", coverageTypeLabel("r2"), "R2 bucket");
eq("type label secrets", coverageTypeLabel("secrets"), "Secrets Store secret");
eq("type label d1", coverageTypeLabel("d1"), "D1 database");

// ---------------------------------------------------------------------------
// compareCoverageResources: the ranked rows (the worst gap leads).
// ---------------------------------------------------------------------------
console.log("\n-- compareCoverageResources --");

ok("coverageStatusOrder: unprotected < untested < protected", coverageStatusOrder("unprotected") < coverageStatusOrder("untested") && coverageStatusOrder("untested") < coverageStatusOrder("protected"));

{
  const unprotected = res("kv", "u", "unprotected");
  const untested = res("kv", "t", "untested");
  const prot = res("kv", "p", "protected");
  ok("unprotected sorts before untested", compareCoverageResources(unprotected, untested) < 0);
  ok("untested sorts before protected", compareCoverageResources(untested, prot) < 0);
  ok("unprotected sorts before protected", compareCoverageResources(unprotected, prot) < 0);
}

{
  // A full sort: the most important gap (unprotected) must lead, a protected resource last.
  const rows: CoverageResource[] = [
    res("r2", "prod-bucket", "protected"),
    res("kv", "sessions", "unprotected"),
    res("d1", "main-db", "untested"),
    res("kv", "config", "unprotected"),
  ];
  const sorted = rows.slice().sort(compareCoverageResources).map((r) => `${r.status}:${r.id}`);
  // Two unprotected first (ordered by type then name: kv "config" before kv "sessions"), then untested, then protected.
  eq("full coverage sort", sorted, ["unprotected:config", "unprotected:sessions", "untested:main-db", "protected:prod-bucket"]);
}

// ---------------------------------------------------------------------------
// coverageStatement: the exact contract wording for an unprotected resource.
// ---------------------------------------------------------------------------
console.log("\n-- coverageStatement --");

{
  const statement = coverageStatement(res("kv", "ns-1", "unprotected", "sessions"));
  ok('unprotected statement contains "exists but is NOT backed up"', statement.includes("exists but is NOT backed up"));
  ok("unprotected statement names the resource", statement.includes('"sessions"') && statement.includes("KV namespace"));
}
ok("untested statement says recoverability not proven", coverageStatement(res("d1", "db", "untested")).toLowerCase().includes("not been proven"));
ok("protected statement says protected (never absolute 'safe')", coverageStatement(res("r2", "b", "protected")).includes("protected") && !coverageStatement(res("r2", "b", "protected")).toLowerCase().includes("safe"));

// ---------------------------------------------------------------------------
// coverageFindings: the pure projection the renderer consumes.
// ---------------------------------------------------------------------------
console.log("\n-- coverageFindings (the projection) --");

{
  const report = coverageReport([
    res("r2", "prod", "protected", "prod", "dp-1"),
    res("kv", "sessions", "unprotected", "sessions"),
    res("d1", "main", "untested", "main", "dp-2"),
  ]);
  const findings = coverageFindings(report);

  // Ranked: the unprotected finding leads.
  eq("findings are ranked (unprotected leads)", findings.map((f) => f.resource.status), ["unprotected", "untested", "protected"]);

  const unprotected = findings[0]!;
  eq("unprotected finding tone = danger", unprotected.tone, "danger");
  ok('unprotected finding statement = "exists but is NOT backed up"', unprotected.statement.includes("exists but is NOT backed up"));
  eq("unprotected finding carries the back-up action", unprotected.action, "back-up");

  const untested = findings[1]!;
  eq("untested finding tone = warn", untested.tone, "warn");
  ok("untested finding has NO back-up action", untested.action === undefined);

  const prot = findings[2]!;
  eq("protected finding tone = ok", prot.tone, "ok");
  ok("protected finding has NO back-up action", prot.action === undefined);

  // Only the unprotected rows carry a back-up action.
  eq("exactly one back-up action (the unprotected row)", findings.filter((f) => f.action === "back-up").length, 1);
}

// ===========================================================================
// renderCoverage: render the section against a stub via the shared DOM shim, and
// inspect the produced node tree. This is the "renders findings from a stub +
// the honest-unknown state" check. The shared shim provides textContent-first nodes
// with className / setProperty / querySelectorAll, enough for h() / svgIcon() /
// statTile() / badge() / emptyState().
// ===========================================================================
console.log("\n-- renderCoverage (DOM shim) --");

installDomShim();

{
  // hasInventory:true with resources: the unprotected finding text and a "Back this up" button.
  const report = coverageReport([
    res("kv", "sessions", "unprotected", "sessions"),
    res("r2", "prod", "protected", "prod", "dp-1"),
  ]);
  const root = renderCoverage(report, () => {}) as unknown as ShimNode;
  const text = root.textContent;

  ok("renders the Coverage heading", text.includes("Coverage"));
  ok('renders the "exists but is NOT backed up" finding', text.includes("exists but is NOT backed up"));
  ok('renders a "Back this up" action', text.includes("Back this up"));
  ok("renders the rollup headline", text.includes("Coverage rollup") && text.includes("Not backed up"));

  // The back-up affordance is a real <button> that targets the downpipe-create flow. navigate() is a
  // shimmed no-op, so we assert the button is present and clickable without throwing.
  const buttons = root.querySelectorAll("button");
  const backUp = buttons.find((b) => b.textContent.includes("Back this up"));
  ok("the back-up affordance is a button", backUp !== undefined);
  let threw = false;
  try { backUp?.click(); } catch { threw = true; }
  ok("clicking 'Back this up' routes without throwing", !threw);
}

{
  // At scale the coverage list must stay BOUNDED -- a per-group cap with a "Show all N"
  // disclosure, never one uncapped card per resource (the uncapped render grew the page without bound). The
  // group label still states the TRUE count and every card is one click away, so no gap is hidden. Each
  // unprotected card carries exactly one "Back this up" button, so counting those counts the rendered cards.
  const overCap = COVERAGE_CARDS_PER_GROUP + 80;
  const many = coverageReport(Array.from({ length: overCap }, (_, i) => res("kv", `ns-${i}`, "unprotected", `ns-${i}`)));
  const root = renderCoverage(many, () => {}) as unknown as ShimNode;
  const backUps = (node: ShimNode): number => node.querySelectorAll("button").filter((b) => b.textContent.includes("Back this up")).length;

  // The cap's VALUE is pinned first. The assertion below establishes that a cap is applied, because an
  // uncapped render would return overCap, but it cannot establish what the cap is: overCap is derived
  // from the constant and the expected count IS the constant, so the number cancels on both sides. At
  // COVERAGE_CARDS_PER_GROUP = 5000 the bound that exists to stop the page growing without limit stops
  // bounding anything, and this block stays green. Fifty is the figure the render was sized for.
  ok("the per-group cap is 50 cards", COVERAGE_CARDS_PER_GROUP === 50);
  ok("the default coverage render is CAPPED per group, not one card per resource", backUps(root) === COVERAGE_CARDS_PER_GROUP);
  ok("the group label still states the TRUE count (nothing is hidden)", root.textContent.includes(`Exists but not backed up (${overCap})`));
  const showAll = root.querySelectorAll("button").find((b) => b.textContent.includes("Show all"));
  ok("a Show all affordance appears when a group exceeds the cap", showAll !== undefined && root.textContent.includes(`Show all ${overCap}`));

  let threwShowAll = false;
  try { showAll?.click(); } catch { threwShowAll = true; }
  ok("Show all reveals every remaining card in place without throwing", !threwShowAll && backUps(root) === overCap);
  ok("Show all removes itself once expanded", root.querySelectorAll("button").find((b) => b.textContent.includes("Show all")) === undefined);
}

{
  // The HONEST-UNKNOWN state: no inventory. Make no coverage claim; prompt read-only discovery.
  const report = coverageReport([], false);
  const root = renderCoverage(report, () => {}) as unknown as ShimNode;
  const text = root.textContent.toLowerCase();

  ok("honest-unknown: states coverage is unknown", text.includes("coverage is unknown"));
  ok("honest-unknown: prompts read-only discovery", text.includes("read-only discovery"));
  // It must make NO false positive coverage claim. It may (and does) say "NOT that everything is
  // covered" as an honest negation, so the check is that any "everything is covered" is negated and
  // there is no unqualified "fully covered" / "all protected".
  ok("honest-unknown: makes NO unqualified positive coverage claim", !text.includes("fully covered") && !text.includes("all protected"));
  ok("honest-unknown: any 'everything is covered' is explicitly negated", !text.includes("everything is covered") || text.includes("not that everything is covered"));
  ok("honest-unknown: shows no 'exists but is NOT backed up' finding (nothing is known to exist)", !root.textContent.includes("exists but is NOT backed up"));
}

// ===========================================================================
// POPULATE INVENTORY: the in-console populate of the coverage reference inventory (no-CLI rule).
// parseInventory(Group) is the pure parse of the modal textareas into a ResourceInventory; renderCoverage
// surfaces a "Populate inventory" affordance when (and only when) the coordinator wires the populate
// callback for an access.policy caller.
// ===========================================================================
console.log("\n-- parseInventoryGroup (the per-textarea parse) --");

eq("a bare id parses to { id }", parseInventoryGroup("ns-1"), [{ id: "ns-1" }]);
eq("'id, label' splits on the first comma into { id, name }", parseInventoryGroup("ns-1, sessions"), [{ id: "ns-1", name: "sessions" }]);
eq("a label may itself contain commas (first comma splits)", parseInventoryGroup("ns-1, a, b"), [{ id: "ns-1", name: "a, b" }]);
eq("blank lines are ignored", parseInventoryGroup("ns-1\n\n  \nns-2"), [{ id: "ns-1" }, { id: "ns-2" }]);
eq("a trailing comma (empty label) is treated as no label", parseInventoryGroup("ns-1,   "), [{ id: "ns-1" }]);
eq("a line that is only a comma/label (no id) is skipped", parseInventoryGroup(", orphan"), []);
eq("an empty textarea parses to an empty list", parseInventoryGroup(""), []);

console.log("\n-- parseInventory (the four groups -> a ResourceInventory) --");

{
  const inv = parseInventory({ kv: "ns-1\nns-2", r2: "uploads, prod uploads", d1: "", secrets: "api-key" });
  eq("kv group parsed", inv.kv, [{ id: "ns-1" }, { id: "ns-2" }]);
  eq("r2 group parsed (with label)", inv.r2, [{ id: "uploads", name: "prod uploads" }]);
  eq("an empty group is an empty list", inv.d1, []);
  eq("secrets group parsed", inv.secrets, [{ id: "api-key" }]);
  // The shape is exactly the engine's ResourceInventory (all four groups present).
  eq("the parsed inventory has exactly the four groups", Object.keys(inv).sort(), ["d1", "kv", "r2", "secrets"]);
}

console.log("\n-- renderCoverage: the 'Populate inventory' affordance --");

{
  // With a populate callback wired (the access.policy caller path), the affordance renders as a button.
  const report = coverageReport([res("kv", "sessions", "unprotected", "sessions")]);
  let opened = false;
  const root = renderCoverage(report, () => {}, { onClick: () => { opened = true; } }) as unknown as ShimNode;
  const buttons = root.querySelectorAll("button");
  const populate = buttons.find((b) => b.textContent.includes("Populate inventory"));
  ok("renders a 'Populate inventory' button for an access.policy caller", populate !== undefined);
  populate?.click();
  ok("clicking 'Populate inventory' invokes the wired callback", opened);
}

{
  // The honest-unknown state ALSO offers the populate affordance to an access.policy caller (the day-one
  // action that ends the unknown state), in place of the read-only-discovery prompt.
  let opened = false;
  const root = renderCoverage(coverageReport([], false), () => {}, { onClick: () => { opened = true; } }) as unknown as ShimNode;
  const buttons = root.querySelectorAll("button");
  const populate = buttons.find((b) => b.textContent.includes("Populate inventory"));
  ok("honest-unknown: offers 'Populate inventory' to an access.policy caller", populate !== undefined);
  populate?.click();
  ok("honest-unknown: the populate action invokes the wired callback", opened);
}

{
  // WITHOUT a populate callback (a caller lacking access.policy, or the pure render), no populate
  // affordance is shown, only Refresh and the back-up actions.
  const report = coverageReport([res("kv", "sessions", "unprotected", "sessions")]);
  const root = renderCoverage(report, () => {}) as unknown as ShimNode;
  const buttons = root.querySelectorAll("button");
  const populate = buttons.find((b) => b.textContent.includes("Populate inventory"));
  ok("no 'Populate inventory' affordance without the access.policy callback", populate === undefined);
}

// ===========================================================================
// configApprovalControl (security-centre/access.ts): the four-eyes / dual-control policy TOGGLE.
//
// Disarming four-eyes is the engine's ASYMMETRIC off-switch (router-config-version.ts /
// scheduler-do-routing-config.ts) -- a lone attributable owner's disarm is itself routed through the
// owner-action dual-control gate, so the engine answers 202 + OwnerActionQueued rather than applying, and
// the policy stays ON. setConfigApprovalPolicy used to call the plain parseJson, which cast that queued
// body straight to ConfigApprovalPolicy; requireConfigApproval read back undefined (falsy), so the toggle
// immediately painted "Off" for a gate that was, correctly, still armed. This renders the REAL
// configApprovalControl against a stubbed EngineClient over the shared DOM shim (never a copy of its
// logic), drives the real confirm modal, and asserts the switch stays honest in both directions.
// ===========================================================================
async function testConfigApprovalToggle(): Promise<void> {
  console.log("\n-- configApprovalControl: the dual-control toggle honestly reflects a queued disarm --");

  const store = await import("../src/lib/store.ts");
  const nav = await import("../src/lib/nav.ts");
  const accessMod = await import("../src/screens/security-centre/access.ts");
  nav.installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

  function docBody(): ShimNode {
    return (globalThis as unknown as { document: { body: ShimNode } }).document.body;
  }

  // clickModalButton waits for the next confirmModal to render under the shim and clicks the button with
  // the given label (mirroring validate-destinations.ts's answerModal), so the toggle's own confirm-first
  // gate is driven for real rather than bypassed.
  async function clickModalButton(label: string): Promise<void> {
    await flushAsync();
    const surface = qs(docBody(), ".dialog--modal");
    if (!surface) throw new Error(`clickModalButton: no open modal found for "${label}"`);
    const btn = qsa(surface, "button").find((b) => textOf(b).includes(label));
    if (!btn) throw new Error(`clickModalButton: no button labelled "${label}" in the open modal`);
    btn.click();
    await flushAsync();
  }

  const owner: Caller = { method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false };
  store.setCaller(owner);
  store.connect("https://engine.test");
  const engine = store.getEngine();
  if (!engine) throw new Error("testConfigApprovalToggle: no engine in store");
  // Baseline: the gate is ON (requireConfigApproval:true), the common state a disarm attempt starts from.
  (engine as unknown as { getConfigApprovalPolicy: () => Promise<{ requireConfigApproval: boolean }> }).getConfigApprovalPolicy = async () => ({ requireConfigApproval: true });

  {
    // A lone owner's DISARM is queued for a second owner (202 + OwnerActionQueued), so the
    // policy is UNCHANGED. The toggle must keep reading On (never flip to Off for a gate that is still
    // armed), and a queued-owner-action toast must fire instead of a "no longer require approval" one.
    (engine as unknown as { setConfigApprovalPolicy: (on: boolean) => Promise<unknown> }).setConfigApprovalPolicy = async () => ({
      status: "queued",
      queued: { ownerActionQueued: true, id: "oa-dc-1", status: "pending" },
    });

    const root = accessMod.configApprovalControl(engine);
    markConnected(root);
    await flushAsync(); // the initial getConfigApprovalPolicy load resolves

    const sw = qs(root, '[data-dp="security-centre.switch.config-approval-control"]');
    if (!sw) throw new Error("configApprovalControl: the switch did not render");
    ok("baseline: the switch loads reading On (aria-checked=true)", sw.getAttribute("aria-checked") === "true");

    sw.click(); // request the disarm (next = false)
    await clickModalButton("Stop requiring approval"); // drives the real confirm, never bypassed

    ok("after a QUEUED disarm the switch STILL reads On (aria-checked=true), never Off", sw.getAttribute("aria-checked") === "true");
    ok('the switch label still says "On"', textOf(sw) === "On");
    ok("the state line still says four-eyes is ON", textOf(root).includes("Four-eyes is ON"));
    const toastBody = textOf(docBody());
    ok("a queued-owner-action toast fires (never a false 'no longer require approval' toast)", toastBody.includes("queued for a second owner to approve"));
    ok('the toast does NOT claim the policy changed ("no longer require approval")', !toastBody.includes("no longer require approval"));
  }

  {
    // The counterpart: an IMMEDIATE disarm (a plain 200 -- an owner-action-exempt path, or a second
    // owner's own approval completing it) DOES flip the toggle to Off, proving the fix does not make every
    // disarm look queued.
    (engine as unknown as { setConfigApprovalPolicy: (on: boolean) => Promise<unknown> }).setConfigApprovalPolicy = async () => ({
      status: "result",
      value: { requireConfigApproval: false },
    });
    const root = accessMod.configApprovalControl(engine);
    markConnected(root);
    await flushAsync();
    const sw = qs(root, '[data-dp="security-centre.switch.config-approval-control"]');
    if (!sw) throw new Error("configApprovalControl: the switch did not render (immediate-disarm case)");
    sw.click();
    await clickModalButton("Stop requiring approval");
    ok("an IMMEDIATE disarm (200) DOES flip the switch to Off (aria-checked=false)", sw.getAttribute("aria-checked") === "false");
    ok('an immediate disarm shows the real "no longer require approval" toast', textOf(docBody()).includes("no longer require approval"));
  }
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
async function finish(): Promise<void> {
  await testConfigApprovalToggle();
  console.log(failures === 0 ? "\nVALIDATE-SECURITY-CENTRE VECTORS PASS" : `\n${failures} FAILURE(S)`);
  // Exit deterministically: the rendered toggle's toast schedules an auto-dismiss timer that legitimately
  // outlives this test (mirrors validate-owner-actions.ts's own explicit exit for the same reason).
  if (failures > 0) process.exitCode = 1;
  process.exit(failures > 0 ? 1 : 0);
}
finish().catch((err) => {
  console.error("\nVALIDATE-SECURITY-CENTRE THREW:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
// THERE IS DELIBERATELY NO `if (failures > 0) process.exit(1)` BELOW THIS LINE. Almost every assertion in
// this file runs SYNCHRONOUSLY at module level (lines 104 to 431); only the config-approval toggle lives
// inside finish(). finish() is async, so it yields at its first await, and a module-level bail placed here
// would run while finish() is still in flight, pre-empting the exit code finish() decides once it
// completes. It would also be redundant: finish() tallies the same `failures` counter after awaiting, so
// the synchronous failures are already counted there.
