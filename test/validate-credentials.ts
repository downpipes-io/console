// Validate the pure logic of the Credentials/expiry screen (src/screens/credentials.ts)
// and the shared scheduled-restore-test recency helpers (src/screens/sources-downpipes.ts).
// Run with: node test/validate-credentials.ts
//
// The screens are DOM-heavy, but their load-bearing logic is extracted into pure
// functions, testable without a DOM. None of the imported modules execute DOM at import
// time, so importing them in Node succeeds.
//
// Coverage:
//   credential lifecycle registry (section 4):
//     expiryStateTone: expired=danger (NEVER ok), approaching=warn, ok=ok, no-expiry=
//       NEUTRAL (never ok/green; a distinct honest state); no stale green
//     expiryStateLabel: the short human label per state (incl. "no expiry")
//     stateOrder / compareExpiry: expired first, then approaching, then ok, then
//       no-expiry LAST; within a group the soonest deadline (fewest days remaining)
//       leads; an absent daysRemaining is +Infinity (sorts last); title tiebreak; stable
//     remainingSortValue: an absent/no-expiry daysRemaining is +Infinity (guards the
//       optional field BEFORE any arithmetic)
//     expirySummary: the count breakdown (incl. a distinct noExpiry count)
//     daysPhrase: branches on state BEFORE arithmetic: no-expiry reads "no expiry";
//       expired reads "expired Nd ago"/"expired today"; active reads "Nd
//       remaining"/"expires today"/"1d remaining"
//     soonestTileValue: no-expiry/absent reads "none"; expired reads "overdue"; never a
//       negative "${n}d"
//     lifecycleLabel: ephemeral/functional/unset (the chip's label + sort key)
//   scheduled restore tests (section 5):
//     restoreTestCadenceLabel: off when 0/absent; a friendly interval otherwise
//     restoreTestRecency: a failed last test is danger (never softened); never-tested is
//       warn when configured, neutral when off; a pass is ok unless older than 1.5x the
//       cadence (overdue=warn); the read is NEVER a stale green for a failed/absent test

import {
  expiryStateTone,
  expiryStateLabel,
  stateOrder,
  compareExpiry,
  remainingSortValue,
  expirySummary,
  daysPhrase,
  soonestTileValue,
  lifecycleLabel,
} from "../src/screens/credentials.ts";
import {
  restoreTestCadenceLabel,
  restoreTestRecency,
  restoreTestReasonPhrase,
} from "../src/screens/sources-downpipes.ts";
import { isValidDateInput } from "../src/screens/credentials/helpers.ts";
import type { ExpiryStatus } from "../src/api.ts";

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

function row(id: string, state: ExpiryStatus["state"], daysRemaining: number, label = id): ExpiryStatus {
  // source says whether the expiry was recorded by hand or observed off the credential. These rows carry a
  // fixed expiresAt, which is the manual case, and it had been absent rather than either.
  return { id, label, kind: "credential", expiresAt: "2026-01-01T00:00:00Z", daysRemaining, state, source: "manual" };
}

// noExpiryRow builds a NO-EXPIRY item: state "no-expiry" with NEITHER expiresAt NOR
// daysRemaining present (both became optional in the registry). It exercises the
// optional-daysRemaining guards every helper must apply before any arithmetic.
function noExpiryRow(id: string, label = id): ExpiryStatus {
  return { id, label, kind: "credential", source: "manual", state: "no-expiry", lifecycleClass: "functional" };
}

// ---------------------------------------------------------------------------
// expiryStateTone + expiryStateLabel (the dot hue; never a stale green).
// ---------------------------------------------------------------------------
console.log("\n-- expiryStateTone + expiryStateLabel --");

eq("expired tone = danger", expiryStateTone("expired"), "danger");
eq("approaching tone = warn", expiryStateTone("approaching"), "warn");
eq("ok tone = ok", expiryStateTone("ok"), "ok");
eq("no-expiry tone = neutral", expiryStateTone("no-expiry"), "neutral");
ok("an expired item is NEVER the ok tone (no stale green)", expiryStateTone("expired") !== "ok" && expiryStateTone("approaching") !== "ok");
ok("a no-expiry item is NEVER ok/green (a distinct honest state)", expiryStateTone("no-expiry") !== "ok");

eq("expired label", expiryStateLabel("expired"), "expired");
eq("approaching label", expiryStateLabel("approaching"), "approaching");
eq("ok label", expiryStateLabel("ok"), "healthy");
eq("no-expiry label", expiryStateLabel("no-expiry"), "no expiry");

// ---------------------------------------------------------------------------
// stateOrder + compareExpiry (the urgency ranking).
// ---------------------------------------------------------------------------
console.log("\n-- stateOrder + compareExpiry --");

ok("stateOrder: expired < approaching < ok", stateOrder("expired") < stateOrder("approaching") && stateOrder("approaching") < stateOrder("ok"));
ok("stateOrder: ok < no-expiry (no-expiry sorts AFTER healthy)", stateOrder("ok") < stateOrder("no-expiry"));

{
  // State dominates: an expired item (even with many overdue days) sorts before an
  // approaching one, which sorts before an ok one.
  const expired = row("e", "expired", -5);
  const approaching = row("a", "approaching", 10);
  const okRow = row("o", "ok", 200);
  ok("expired before approaching", compareExpiry(expired, approaching) < 0);
  ok("approaching before ok", compareExpiry(approaching, okRow) < 0);
  ok("expired before ok", compareExpiry(expired, okRow) < 0);
}

{
  // Within a group, the soonest deadline (fewest days remaining) leads.
  const sooner = row("sooner", "approaching", 3);
  const later = row("later", "approaching", 20);
  ok("within a group: fewer days remaining leads", compareExpiry(sooner, later) < 0);
}

{
  // Title tiebreak when state + days are equal.
  const a = row("x", "ok", 100, "alpha");
  const b = row("y", "ok", 100, "bravo");
  ok("same state+days: title tiebreak (alpha before bravo)", compareExpiry(a, b) < 0);
}

{
  // A full sort: expired sorts by fewest days remaining first, which for an expired item
  // means the MOST overdue leads, then approaching, then ok, then a NO-EXPIRY item LAST
  // (its absent daysRemaining is treated as +Infinity, so it sinks below every dated item).
  const rows: ExpiryStatus[] = [
    noExpiryRow("no-exp"),
    row("ok-far", "ok", 300),
    row("appr-late", "approaching", 25),
    row("expired-deep", "expired", -40),
    row("appr-soon", "approaching", 2),
    row("expired-shallow", "expired", -1),
  ];
  const sorted = rows.slice().sort(compareExpiry).map((r) => r.id);
  eq("full sort order (most urgent first; no-expiry last)", sorted, ["expired-deep", "expired-shallow", "appr-soon", "appr-late", "ok-far", "no-exp"]);
  const sorted2 = rows.slice().sort(compareExpiry).map((r) => r.id);
  eq("sort is deterministic", sorted2, sorted);
}

{
  // The optional-daysRemaining guard: a no-expiry / absent-days row never reaches
  // arithmetic: compareExpiry orders it AFTER a healthy dated item via the +Infinity
  // remaining value, and never throws on the absent field.
  const okRow = row("o", "ok", 5);
  const noExp = noExpiryRow("n");
  ok("compareExpiry: a healthy dated item sorts before a no-expiry item", compareExpiry(okRow, noExp) < 0);
  ok("compareExpiry: two no-expiry items fall back to the label tiebreak (no NaN)", compareExpiry(noExpiryRow("a"), noExpiryRow("b")) < 0);
}

// ---------------------------------------------------------------------------
// remainingSortValue (the optional-daysRemaining guard: absent/no-expiry => +Infinity).
// ---------------------------------------------------------------------------
console.log("\n-- remainingSortValue --");

eq("remainingSortValue: a dated row is its daysRemaining", remainingSortValue(row("a", "ok", 12)), 12);
eq("remainingSortValue: an expired row is its (negative) daysRemaining", remainingSortValue(row("a", "expired", -3)), -3);
ok("remainingSortValue: a no-expiry row is +Infinity (sorts last)", remainingSortValue(noExpiryRow("a")) === Number.POSITIVE_INFINITY);

// ---------------------------------------------------------------------------
// expirySummary (the count breakdown).
// ---------------------------------------------------------------------------
console.log("\n-- expirySummary --");

{
  const rows: ExpiryStatus[] = [
    row("a", "expired", -1),
    row("b", "expired", -10),
    row("c", "approaching", 5),
    row("d", "ok", 100),
    noExpiryRow("e"),
  ];
  // no-expiry is its OWN count, never folded into ok (they are distinct honest states).
  eq("summary counts (no-expiry is distinct from ok)", expirySummary(rows), { total: 5, expired: 2, approaching: 1, ok: 1, noExpiry: 1 });
  eq("empty summary", expirySummary([]), { total: 0, expired: 0, approaching: 0, ok: 0, noExpiry: 0 });
}

// ---------------------------------------------------------------------------
// daysPhrase (the days-remaining read).
// ---------------------------------------------------------------------------
console.log("\n-- daysPhrase --");

eq("expired N days ago", daysPhrase(row("a", "expired", -5)), "expired 5d ago");
eq("expired today (0)", daysPhrase(row("a", "expired", 0)), "expired today");
eq("expires today (active 0)", daysPhrase(row("a", "approaching", 0)), "expires today");
eq("1d remaining", daysPhrase(row("a", "approaching", 1)), "1d remaining");
eq("Nd remaining", daysPhrase(row("a", "ok", 90)), "90d remaining");
eq("no-expiry reads 'no expiry'", daysPhrase(noExpiryRow("a")), "no expiry");
ok("an expired phrase never says 'remaining'", !daysPhrase(row("a", "expired", -3)).includes("remaining"));
ok("a no-expiry phrase never says 'remaining' (no arithmetic on an absent field)", !daysPhrase(noExpiryRow("a")).includes("remaining"));

// ---------------------------------------------------------------------------
// soonestTileValue (the compact tile value; never a negative day; no-expiry => "none").
// ---------------------------------------------------------------------------
console.log("\n-- soonestTileValue --");

eq("soonestTileValue: expired reads 'overdue' (never a negative day)", soonestTileValue(row("a", "expired", -7)), "overdue");
eq("soonestTileValue: a same-day active deadline reads 'today'", soonestTileValue(row("a", "approaching", 0)), "today");
eq("soonestTileValue: an active deadline reads 'Nd'", soonestTileValue(row("a", "ok", 12)), "12d");
eq("soonestTileValue: a no-expiry / absent-days row reads 'none'", soonestTileValue(noExpiryRow("a")), "none");
ok("soonestTileValue never emits a negative day", !soonestTileValue(row("a", "expired", -40)).startsWith("-"));

// ---------------------------------------------------------------------------
// lifecycleLabel (the chip's label + filter/sort key).
// ---------------------------------------------------------------------------
console.log("\n-- lifecycleLabel --");

eq("lifecycle ephemeral", lifecycleLabel("ephemeral"), "ephemeral");
eq("lifecycle functional", lifecycleLabel("functional"), "functional");
eq("lifecycle unset (absent class, an older row)", lifecycleLabel(undefined), "unset");
ok("lifecycle labels are distinct (so the column sorts/filters)", lifecycleLabel("ephemeral") !== lifecycleLabel("functional"));

// ---------------------------------------------------------------------------
// restoreTestCadenceLabel (section 5).
// ---------------------------------------------------------------------------
console.log("\n-- restoreTestCadenceLabel --");

eq("cadence off (0)", restoreTestCadenceLabel(0), "Off (no scheduled test)");
eq("cadence off (absent)", restoreTestCadenceLabel(undefined), "Off (no scheduled test)");
eq("cadence weekly (604800)", restoreTestCadenceLabel(604800), "Every 7d");
eq("cadence daily (86400)", restoreTestCadenceLabel(86400), "Daily");

// ---------------------------------------------------------------------------
// restoreTestRecency (section 5): never a stale green for a failed/absent test.
// ---------------------------------------------------------------------------
console.log("\n-- restoreTestRecency --");

const NOW = Date.parse("2026-06-09T00:00:00Z");

{
  // A failed last test is the loudest read (danger), regardless of how recent.
  const r = restoreTestRecency({ config: { restoreTestCadenceSeconds: 604800 }, lastRestoreTestAt: "2026-06-08T00:00:00Z", lastRestoreTestOk: false }, NOW);
  eq("failed last test = danger", r.tone, "danger");
  ok("failed last test is never ok", r.tone !== "ok");
}

{
  // Never tested while a cadence is configured = warn (configured but unevidenced).
  const r = restoreTestRecency({ config: { restoreTestCadenceSeconds: 604800 } }, NOW);
  eq("never-tested while configured = warn", r.tone, "warn");
  eq("never-tested while configured label", r.label, "Never tested");
}

{
  // Never tested and the cadence is off = neutral (nothing expected), never a green.
  const r = restoreTestRecency({ config: { restoreTestCadenceSeconds: 0 } }, NOW);
  eq("never-tested + off = neutral", r.tone, "neutral");
  ok("never-tested + off is not ok (no stale green)", r.tone !== "ok");
}

{
  // A recent pass within the cadence = ok.
  const r = restoreTestRecency({ config: { restoreTestCadenceSeconds: 604800 }, lastRestoreTestAt: "2026-06-06T00:00:00Z", lastRestoreTestOk: true }, NOW);
  eq("recent pass = ok", r.tone, "ok");
  eq("recent pass label", r.label, "Recently tested");
}

{
  // A pass older than 1.5x the cadence = overdue (warn). Weekly cadence => 1.5 weeks =
  // 10.5 days; a 20-day-old pass is overdue.
  const r = restoreTestRecency({ config: { restoreTestCadenceSeconds: 604800 }, lastRestoreTestAt: "2026-05-20T00:00:00Z", lastRestoreTestOk: true }, NOW);
  eq("stale pass = overdue/warn", r.tone, "warn");
  eq("stale pass label", r.label, "Test overdue");
}

{
  // A pass with the cadence OFF is read as a recent pass (ok): there is no cadence to be
  // overdue against, so an old pass with no cadence is still "tested", not "overdue".
  const r = restoreTestRecency({ config: { restoreTestCadenceSeconds: 0 }, lastRestoreTestAt: "2025-01-01T00:00:00Z", lastRestoreTestOk: true }, NOW);
  eq("pass with cadence off = ok (no overdue without a cadence)", r.tone, "ok");
}

// The deferral / cause / kind extension (restorability heal): a not-passed completion is no longer
// one loud state. A DEFERRAL renders as could-not-test (calm, self-healing copy); a real failure
// names the engine's persisted coarse cause and the streak; a cause-less not-passed stays the
// loudest read (an older engine's real failure must never be softened) but says a test runs
// automatically after the next successful backup. The kind field is what the restore screen
// groups by, so each state's kind is pinned here too.
{
  // Could-not-test deferral: no completed backup at test time.
  const r = restoreTestRecency({ config: { restoreTestCadenceSeconds: 604800 }, lastRestoreTestAt: "2026-06-08T22:00:00Z", lastRestoreTestOk: false, lastRestoreTestDeferred: "no-run" }, NOW);
  eq("no-run deferral = warn, not danger", r.tone, "warn");
  eq("no-run deferral label", r.label, "Not yet testable");
  eq("no-run deferral kind", r.kind, "deferred-no-run");
  ok("no-run deferral says the next backup retests", r.detail.includes("automatically after the next successful backup"));
  ok("no-run deferral never claims a failure", !r.detail.includes("recoverability problem"));
}
{
  // Posture deferral: break-glass-only, the engine cannot self-test.
  const r = restoreTestRecency({ config: { restoreTestCadenceSeconds: 604800 }, lastRestoreTestAt: "2026-06-08T22:00:00Z", lastRestoreTestOk: false, lastRestoreTestDeferred: "posture" }, NOW);
  eq("posture deferral = neutral (a posture choice, not a fault)", r.tone, "neutral");
  eq("posture deferral label", r.label, "Attended verification available");
  eq("posture deferral kind", r.kind, "deferred-posture");
  // The old dead-end steered to an offline CLI rehearsal; it now steers to attended verification (the
  // in-platform proof path), naming the break-glass key it needs. No CLI, no offline-only dead-end.
  ok("posture deferral steers to attended verification", r.detail.includes("attended verification"));
  ok("posture deferral names the break-glass key it needs", r.detail.includes("break-glass"));
}
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  // METHOD-FAITHFUL attended verification (the compliance blocker): a sub-100 attended pass is a PARTIAL
  // proof and must NEVER read the fully-green "recently tested"; a 100% attended pass reads as an attended
  // proof. The kind + sample rate are threaded from the state (lastRestoreTestKind / lastRestoreTestSampleRate).
  {
    const partial = restoreTestRecency({ config: {}, lastRestoreTestAt: "2026-06-10T22:00:00Z", lastRestoreTestOk: true, lastRestoreTestKind: "attended", lastRestoreTestSampleRate: 72 }, NOW);
    eq("sub-100 attended pass is amber, never green", partial.tone, "warn");
    eq("sub-100 attended pass kind", partial.kind, "attended-partial");
    ok("sub-100 attended pass names the sample rate", partial.label.includes("72%"));
    ok("sub-100 attended pass never reads 'recently tested'", !partial.detail.includes("Recently tested"));
    ok("sub-100 attended pass names attended verification", partial.detail.includes("attended verification"));
  }
  {
    const full = restoreTestRecency({ config: {}, lastRestoreTestAt: "2026-06-10T22:00:00Z", lastRestoreTestOk: true, lastRestoreTestKind: "attended", lastRestoreTestSampleRate: 100 }, NOW);
    eq("full attended pass reads ok (a genuine attended proof)", full.tone, "ok");
    eq("full attended pass kind", full.kind, "attended-full");
    eq("full attended pass is labelled by its method, not 'recently tested'", full.label, "Attended verification");
  }
  {
    // An attended pass with an UNRECORDED sample rate must not be assumed 100%: it reads partial (never green).
    const unknown = restoreTestRecency({ config: {}, lastRestoreTestAt: "2026-06-10T22:00:00Z", lastRestoreTestOk: true, lastRestoreTestKind: "attended" }, NOW);
    eq("attended pass with no recorded sample is not green", unknown.tone, "warn");
    eq("attended pass with no recorded sample is partial", unknown.kind, "attended-partial");
  }
}
{
  // A real failure names the persisted coarse cause and the streak.
  const r = restoreTestRecency({ config: { restoreTestCadenceSeconds: 604800 }, lastRestoreTestAt: "2026-06-08T22:00:00Z", lastRestoreTestOk: false, lastRestoreTestReason: "dest-access", restoreTestConsecutiveFailures: 3 }, NOW);
  eq("attributed failure = danger", r.tone, "danger");
  eq("attributed failure kind", r.kind, "failed");
  ok("attributed failure names the cause", r.detail.includes("destination refused or failed the read"));
  ok("attributed failure names the streak", r.detail.includes("3 consecutive tests have failed"));
}
{
  // A single attributed failure carries no streak line (a streak of 1 is just "it failed").
  const r = restoreTestRecency({ config: { restoreTestCadenceSeconds: 604800 }, lastRestoreTestAt: "2026-06-08T22:00:00Z", lastRestoreTestOk: false, lastRestoreTestReason: "integrity", restoreTestConsecutiveFailures: 1 }, NOW);
  ok("integrity failure names the cause", r.detail.includes("integrity verification"));
  ok("a streak of 1 adds no consecutive line", !r.detail.includes("consecutive"));
}
{
  // Cause-less not-passed (older engine, or a legacy pre-tracking row): loudest read preserved,
  // with the self-heal promise in the copy.
  const r = restoreTestRecency({ config: { restoreTestCadenceSeconds: 604800 }, lastRestoreTestAt: "2026-06-08T00:00:00Z", lastRestoreTestOk: false }, NOW);
  eq("cause-less not-passed stays danger (older-engine real failures are never softened)", r.tone, "danger");
  eq("cause-less not-passed kind", r.kind, "failed-unattributed");
  ok("cause-less not-passed says the next backup retests", r.detail.includes("automatically after the next successful backup"));
}
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  // The reason phrase map is closed: an unknown code reads as the generic phrase, never the raw code.
  eq("unknown cause code reads generically", restoreTestReasonPhrase("weird-new-code"), "the recovery check failed");
  ok("origin-removed names the destination gap", restoreTestReasonPhrase("origin-removed").includes("no longer configured"));
}
{
  // Never-tested copy now teaches that the first test rides the first successful backup.
  const r = restoreTestRecency({ config: { restoreTestCadenceSeconds: 604800 } }, NOW);
  eq("never-tested kind", r.kind, "never");
  ok("never-tested says the first test is automatic", r.detail.includes("first test runs automatically after the first successful backup"));
}

// ---------------------------------------------------------------------------
// isValidDateInput: rejects malformed shapes AND overflowed calendar dates (Date.parse
// silently rolls "" to, so a finite parse is not sufficient).
// ---------------------------------------------------------------------------
ok("a real date is valid", isValidDateInput("2023-06-15"));
ok("a leap-year Feb 29 is valid", isValidDateInput("2024-02-29"));
ok("Feb 30 (overflow) is rejected", !isValidDateInput("2023-02-30"));
ok("Feb 29 in a non-leap year is rejected", !isValidDateInput("2023-02-29"));
ok("month 13 is rejected", !isValidDateInput("2023-13-01"));
ok("day 32 is rejected", !isValidDateInput("2023-01-32"));
ok("April 31 (overflow) is rejected", !isValidDateInput("2023-04-31"));
ok("wrong shape is rejected", !isValidDateInput("2023-6-15"));
ok("empty string is rejected", !isValidDateInput(""));

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nVALIDATE-CREDENTIALS VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
