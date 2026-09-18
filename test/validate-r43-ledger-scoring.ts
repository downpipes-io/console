// R-43: the coverage number must come from a RESULT, not from a text match.
//
// WHY THIS FILE EXISTS. functional-catalogue-gate.mjs scored a catalogued control as covered when some
// harness file merely CONTAINED its data-dp selector, printed that as "PROVEN AT CONTROL GRAIN", and had
// a CI ratchet defending it at 404 of 454. Measured against clean harness origin/main
// (20048be) with console b7798dd, five of the controls inside that number had cells that FAILED:
// access-security.button.add#2, idp-connections.button.test-control, restore-flow.button.drill and
// notifications.button.primary-button#2 on "a refused control must say why it is refused", and
// sources-downpipes.button.create#2 on "the control's own label must be present".
//
// scripts/ledger-verdicts.mjs is the scorer that replaced it, reading the harness run ledger. Its rules
// are asserted here rather than described, and every case below is one that was measured while building
// it or that broke it:
//
//   LATEST WINS is load-bearing, not tidy. idp-connections.button.test-control banks CLEAN "before its
//   reveal" and DETECT on the reveal assertion milliseconds later. Under "any pass counts" it re-enters
//   the coverage figure as proven, which is exactly the defect.
//
//   THE PREFILTER MUST NOT BE FUSSY ABOUT SPACING. The first cut matched only `"key":"` with no space,
//   because that is how the ledger writes rows. A synthetic row written with spaced JSON
//   separators was skipped ENTIRELY, so its failing verdict scored as no verdict at all and the control
//   kept an older pass. A prefilter that silently drops rows is a coverage number that silently drops
//   failures.
//
//   ENV-FAULT IS NOT A PASS. A cell the environment stopped from running proves nothing about the
//   control it was pointed at, and lib/ledger.ts already says so ("CLEAN and HANDLED pass. Everything
//   else fails.").
//
// Run with: node test/validate-r43-ledger-scoring.ts
//
// House style: Australian English, no em dashes, no rule-of-three, precise claims.

import { keyOf, PASSING_VERDICTS, standingVerdicts } from "../scripts/ledger-verdicts.mjs";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const CATALOGUE = new Set([
  "idp-connections.button.test-control",
  "sources.button.add",
  "restore-flow.button.drill",
  "keys.button.refresh",
]);
const isCatalogueKey = (k: string) => CATALOGUE.has(k);
const allCurrent = () => true;

type Row = Record<string, unknown>;
const row = (key: string, verdict: string, ts: string, extra: Row = {}): Row => ({
  key,
  verdict,
  ts,
  console_sha: "a".repeat(40),
  served_console_build: "unknown-served-console-build",
  ...extra,
});
const compact = (r: Row) => JSON.stringify(r);
const spaced = (r: Row) => JSON.stringify(r, null, 1).replace(/\n\s*/g, " ");

console.log("R-43 ledger scoring");

// 1. LATEST WINS: the pass that precedes a failure in the same cell must not survive it.
{
  const lines = [
    compact(row("idp-connections.button.test-control", "CLEAN", "2026-07-31T07:45:14.573Z")),
    compact(row("idp-connections.button.test-control", "DETECT", "2026-07-31T07:45:15.351Z")),
  ];
  const s = standingVerdicts({ lines, isCatalogueKey, isCurrent: allCurrent });
  ok("a CLEAN followed by a DETECT for the same key scores as failing", s.driven === 0 && s.failing.length === 1);
  const stood = s.failing[0];
  ok("and the failing entry names the key and the standing verdict", stood?.key === "idp-connections.button.test-control" && stood?.verdict === "DETECT");
}

// 2. The reverse: a fix banked after a failure counts. A one-directional "any failure disqualifies" rule
//    would leave a repaired control permanently outside the figure, which is a different lie.
{
  const lines = [
    compact(row("sources.button.add", "DETECT", "2026-07-31T01:00:00.000Z")),
    compact(row("sources.button.add", "CLEAN", "2026-07-31T02:00:00.000Z")),
  ];
  const s = standingVerdicts({ lines, isCatalogueKey, isCurrent: allCurrent });
  ok("a DETECT followed by a CLEAN scores as driven", s.driven === 1 && s.failing.length === 0);
}

// 3. The prefilter must read a row whatever the writer's JSON spacing.
{
  ok("keyOf reads a compact row", keyOf(compact(row("sources.button.add", "CLEAN", "2026-07-31T02:00:00.000Z"))) === "sources.button.add");
  ok("keyOf reads a spaced row", keyOf(spaced(row("sources.button.add", "CLEAN", "2026-07-31T02:00:00.000Z"))) === "sources.button.add");
  const lines = [
    compact(row("sources.button.add", "CLEAN", "2026-07-31T02:00:00.000Z")),
    spaced(row("sources.button.add", "DETECT", "2026-07-31T03:00:00.000Z")),
  ];
  const s = standingVerdicts({ lines, isCatalogueKey, isCurrent: allCurrent });
  ok("a spaced FAILING row is not silently skipped", s.driven === 0 && s.failing.length === 1);
}

// 4. The verdict vocabulary. HANDLED passes; everything outside the pair fails.
{
  ok("the passing set is exactly CLEAN and HANDLED", PASSING_VERDICTS.size === 2 && PASSING_VERDICTS.has("CLEAN") && PASSING_VERDICTS.has("HANDLED"));
  for (const v of ["ENV-FAULT", "UNHELPFUL", "RECTIFY", "EXPLAIN", "GAP", "VACUOUS", "DETECT"]) {
    const s = standingVerdicts({ lines: [compact(row("keys.button.refresh", v, "2026-07-31T02:00:00.000Z"))], isCatalogueKey, isCurrent: allCurrent });
    ok(`${v} does not count as driven`, s.driven === 0 && s.failing.length === 1);
  }
  const handled = standingVerdicts({ lines: [compact(row("keys.button.refresh", "HANDLED", "2026-07-31T02:00:00.000Z"))], isCatalogueKey, isCurrent: allCurrent });
  ok("HANDLED counts as driven", handled.driven === 1);
}

// 5. A key that is not in the catalogue is not coverage of anything this gate counts. The ledger is full
//    of field-smoke rows keyed by "file::control", and none of them may inflate the figure.
{
  const lines = [compact(row("src/screens/costs/inputs-section.ts::cost-source", "CLEAN", "2026-07-31T02:00:00.000Z"))];
  const s = standingVerdicts({ lines, isCatalogueKey, isCurrent: allCurrent });
  ok("a non-catalogue key contributes nothing", s.driven === 0 && s.rowsNamingAKey === 0);
}

// 6. Currency is the caller's rule, and a verdict it rejects must be DROPPED and COUNTED, never counted
//    as a pass and never silently vanished.
{
  const stale = row("restore-flow.button.drill", "CLEAN", "2026-07-31T02:00:00.000Z", { console_sha: "b".repeat(40) });
  const s = standingVerdicts({
    lines: [compact(stale)],
    isCatalogueKey,
    isCurrent: (r: Row) => r.console_sha === "a".repeat(40),
  });
  ok("a verdict from a build we no longer are is dropped", s.driven === 0 && s.failing.length === 0);
  ok("and the drop is counted, so the exclusion is printable", s.excludedStaleBuild === 1 && s.rowsNamingAKey === 1);
}

// 7. A row graded against a DEPLOYED estate is excluded whatever its verdict: harness R-18 established
//    that console_sha names the test machine's checkout, not what the estate served, and this gate cannot
//    know whether that estate still serves it.
{
  const estate = row("sources.button.add", "CLEAN", "2026-07-31T04:00:00.000Z", {
    served_console_build: { version: "0.1.10", bundleDigest: "deadbeefcafe", bundleBytes: 123 },
  });
  const s = standingVerdicts({ lines: [compact(estate)], isCatalogueKey, isCurrent: allCurrent });
  ok("an estate-graded row does not count as driven", s.driven === 0 && s.excludedEstateBuild === 1);
  const both = standingVerdicts({
    lines: [compact(row("sources.button.add", "CLEAN", "2026-07-31T02:00:00.000Z")), compact(estate)],
    isCatalogueKey,
    isCurrent: allCurrent,
  });
  ok("and it does not overwrite a static-pass verdict that IS scorable", both.driven === 1 && both.excludedEstateBuild === 1);
}

// 8. A torn or unparseable line is not a verdict, and must not take the process down with it: the ledger
//    is appended by parallel Playwright workers and a half-written tail is a real state.
{
  const lines = ["{not json", compact(row("sources.button.add", "CLEAN", "2026-07-31T02:00:00.000Z"))];
  const s = standingVerdicts({ lines, isCatalogueKey, isCurrent: allCurrent });
  ok("an unparseable line is skipped rather than thrown", s.driven === 1);
}

// 9. An empty ledger is zero DRIVEN, and that must be distinguishable from "no ledger" by the CALLER.
//    This module returns 0; functional-catalogue-gate.mjs prints "not measured here" only when the file
//    itself is absent, and that difference is the whole reason it keeps `ledger = null` as a state.
{
  const s = standingVerdicts({ lines: [], isCatalogueKey, isCurrent: allCurrent });
  ok("an empty ledger scores zero rather than throwing", s.driven === 0 && s.rowsNamingAKey === 0);
}

console.log(failures === 0 ? "\nR-43 ledger scoring: OK\n" : `\nR-43 ledger scoring: ${failures} FAILURE(S)\n`);
verdictReached(failures);
process.exit(failures === 0 ? 0 : 1);
