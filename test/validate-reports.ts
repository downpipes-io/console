// Validate the pure logic of the Reports screen (src/screens/reports.ts),
// section 6 + section 9.
// Run with: node test/validate-reports.ts
//
// The screen is DOM-heavy, but its load-bearing logic (the signature-verified state read
// that must never overstate, the period phrasing, and the completeness of the four-report
// list) is extracted into pure values/functions, testable without a DOM. None of the
// imported modules execute DOM at import time, so importing the screen in Node succeeds.
//
// Coverage:
//   REPORTS: exactly the four contract kinds, in order, each with a label and a blurb
//   signatureState (the assurance read; never a stale green, never overstated):
//     - an absent/empty signature reads NOT signed (neutral; honestly no assurance)
//     - a well-formed "edmldsa1:" signature reads signed/tamper-evident (trust)
//     - a present-but-unrecognised signature reads signed/unrecognised (warn, not trust)
//     - the detail NEVER claims "tamper-proof" and NEVER claims client-side verification
//   periodPhrase:
//     - a null period reads all-time
//     - a windowed period (epoch SECONDS) reads from/to as absolute UTC

import { installDomShim } from "./dom-shim.ts";
// The pure reads (signatureState, periodPhrase, ...) need no DOM. signatureBadge renders a
// real element, so the chip-tone regression below runs under the shim. No imported module
// executes DOM at import time, so installing it here is enough.
installDomShim();

import {
  REPORTS,
  signatureState,
  periodPhrase,
  humanSeconds,
  rtoEstimateLine,
} from "../src/screens/reports.ts";
import { signatureBadge } from "../src/screens/reports-helpers.ts";
import type { Report, ReportKind, RtoEstimate } from "../src/api.ts";

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

// ---------------------------------------------------------------------------
// REPORTS: the four contract kinds, in order.
// ---------------------------------------------------------------------------
console.log("\n-- REPORTS list --");

const WANT_KINDS: ReportKind[] = ["restore-tests", "sla-compliance", "immutability", "posture"];
eq("REPORTS lists exactly the four contract kinds in order", REPORTS.map((r) => r.kind), WANT_KINDS);
ok("every report has a non-empty label and blurb", REPORTS.every((r) => r.label.length > 0 && r.blurb.length > 0));
ok("no report blurb claims tamper-proof", REPORTS.every((r) => !/tamper-?proof/i.test(r.blurb)));

// ---------------------------------------------------------------------------
// signatureState: the assurance read.
// ---------------------------------------------------------------------------
console.log("\n-- signatureState --");

{
  const s = signatureState(undefined);
  eq("absent signature: signed=false", s.signed, false);
  eq("absent signature: tone=neutral (no stale green/trust)", s.tone, "neutral");
  ok("absent signature: tone is not trust/ok", s.tone !== "trust" && s.tone !== "ok");
  ok("absent signature: label says not signed", /not signed/i.test(s.label));
}

{
  const s = signatureState("");
  eq("empty signature: signed=false", s.signed, false);
  eq("empty signature: tone=neutral", s.tone, "neutral");
}

{
  const s = signatureState("edmldsa1:abc123def456");
  eq("hybrid signature: signed=true", s.signed, true);
  eq("hybrid signature: tone=trust", s.tone, "trust");
  ok("hybrid signature: label says signed/tamper-evident", /signed/i.test(s.label) && /tamper-evident/i.test(s.label));
  // The house idiom explicitly DISCLAIMS tamper-proof ("never tamper-proof"); what must
  // never appear is a POSITIVE tamper-proof claim, i.e. "tamper-proof" not preceded by a
  // negation. So assert there is no un-negated tamper-proof claim.
  ok("hybrid detail never POSITIVELY claims tamper-proof", !/(?<!never |not )tamper-?proof/i.test(s.detail));
  ok("hybrid detail, if it mentions tamper-proof, only disclaims it", !/tamper-?proof/i.test(s.detail) || /never tamper-?proof|not tamper-?proof/i.test(s.detail));
  ok("hybrid detail does not claim client-side verification (says verify out of band)", /out of band/i.test(s.detail));
  ok("hybrid detail names the post-quantum hybrid scheme", /post-quantum/i.test(s.detail));
}

{
  const s = signatureState("rsa2048:deadbeef");
  eq("unrecognised signature: signed=true", s.signed, true);
  eq("unrecognised signature: tone=warn (NOT trust)", s.tone, "warn");
  ok("unrecognised signature: tone is not trust (does not assert the scheme)", s.tone !== "trust");
  ok("unrecognised detail does not claim tamper-proof", !/tamper-?proof/i.test(s.detail));
}

// ---------------------------------------------------------------------------
// signatureBadge: the degraded-state chip. Its TONE must track the signature state,
// never over-claim trust. The screen renders this chip only for the degraded
// states (warn "unrecognised scheme", neutral "not signed"); the clean-signed case
// renders no chip. Rendered under the DOM shim installed at the top of this file.
// ---------------------------------------------------------------------------
console.log("\n-- signatureBadge (chip tone honesty) --");

{
  // Unrecognised scheme: state is tone "warn", signed=true. The chip MUST be warn-toned,
  // never the green trust chip a tamper-evident report wears: beside its own "verify out of
  // band" line, a green "signed" chip reads as fully trusted.
  const chip = signatureBadge("warn", true);
  ok("unrecognised-scheme chip is warn-toned (amber)", chip.className.includes("badge--warn"));
  ok("unrecognised-scheme chip is NOT the green trust chip", !chip.className.includes("badge--trust"));
  eq("unrecognised-scheme chip text is 'signed'", chip.textContent, "signed");
}

{
  // Not signed: a plain neutral "unsigned" chip (no tone modifier), unchanged by the fix.
  const chip = signatureBadge("neutral", false);
  eq("not-signed chip text is 'unsigned'", chip.textContent, "unsigned");
  ok("not-signed chip is not a trust chip", !chip.className.includes("badge--trust"));
  ok("not-signed chip is a plain badge (no tone modifier)", chip.className === "badge");
}

{
  // End to end: the tone the screen feeds the chip is signatureState(...).tone, so the chip
  // can never out-run the state's own honesty. An unrecognised scheme stays warn, not trust.
  const s = signatureState("rsa2048:deadbeef");
  const chip = signatureBadge(s.tone, s.signed);
  ok("chip fed from signatureState(unrecognised) is warn, not trust", chip.className.includes("badge--warn") && !chip.className.includes("badge--trust"));
}

// ---------------------------------------------------------------------------
// periodPhrase.
// ---------------------------------------------------------------------------
console.log("\n-- periodPhrase --");

{
  const r: Report = { kind: "posture", generatedAt: "2026-06-09T00:00:00Z", period: null, data: {} };
  ok("null period reads all-time", /all-time/i.test(periodPhrase(r)));
}

{
  // Epoch SECONDS per the contract. = 1767225600s.
  const from = 1767225600;
  const to = from + 86400 * 30;
  const r: Report = { kind: "sla-compliance", generatedAt: "2026-06-09T00:00:00Z", period: { fromSeconds: from, toSeconds: to }, data: {} };
  const phrase = periodPhrase(r);
  ok("windowed period mentions Period and a UTC range", /^Period /.test(phrase) && /UTC/.test(phrase) && / to /.test(phrase));
  ok("windowed period renders the from year (2026)", phrase.includes("2026"));
}

// ---------------------------------------------------------------------------
// humanSeconds: the calm, rounded duration phrasing for the RTO estimate.
// ---------------------------------------------------------------------------
console.log("\n-- humanSeconds --");

eq("45s reads about 45s", humanSeconds(45), "about 45s");
eq("90s reads about 1m", humanSeconds(90), "about 1m");
eq("3600s reads about 1h", humanSeconds(3600), "about 1h");
eq("7800s reads about 2h 10m", humanSeconds(7800), "about 2h 10m");
eq("97200s reads about 1d 3h", humanSeconds(97200), "about 1d 3h");
eq("a negative duration reads unknown (never a fabricated figure)", humanSeconds(-1), "unknown");
eq("a non-finite duration reads unknown", humanSeconds(Number.NaN), "unknown");
ok("every known phrasing is prefixed 'about' (an approximate projection, never exact)", ["about 45s", humanSeconds(120), humanSeconds(7200)].every((s) => s.startsWith("about")));

// ---------------------------------------------------------------------------
// rtoEstimateLine: the honest reading; NEVER fabricates a number for an unknown estimate.
// ---------------------------------------------------------------------------
console.log("\n-- rtoEstimateLine --");

{
  // An UNKNOWN estimate (no drill history): known:false, no estimateSeconds. It must read an honest
  // unknown and must NOT contain a fabricated number (no digits in the headline value).
  const est: RtoEstimate = { known: false, confidence: "none", reason: "no restore-test history yet" };
  const line = rtoEstimateLine(est);
  eq("unknown estimate: known=false", line.known, false);
  ok("unknown estimate: value says Unknown (no recovery drills yet)", /unknown \(no recovery drills yet\)/i.test(line.value));
  ok("unknown estimate: value contains NO fabricated number (no digit)", !/\d/.test(line.value));
  ok("unknown estimate: basis carries the engine reason", /no restore-test history/i.test(line.basis));
}

{
  // A KNOWN estimate: the derived figure formatted, with the "based on N drills" basis + confidence.
  const est: RtoEstimate = { id: "uploads", name: "Uploads", known: true, estimateSeconds: 7800, basedOnDrills: 4, confidence: "medium" };
  const line = rtoEstimateLine(est);
  eq("known estimate: known=true", line.known, true);
  eq("known estimate: value is the humanSeconds form", line.value, "about 2h 10m");
  ok("known estimate: basis states 'Based on 4 drills'", /based on 4 drills/i.test(line.basis));
  ok("known estimate: basis names the confidence", /medium confidence/i.test(line.basis));
}

{
  // A single-drill estimate uses the singular "drill" and reads its confidence.
  const est: RtoEstimate = { known: true, estimateSeconds: 50, basedOnDrills: 1, confidence: "low" };
  const line = rtoEstimateLine(est);
  ok("single-drill basis uses the singular 'drill'", /based on 1 drill\b/i.test(line.basis) && !/drills/i.test(line.basis));
}

{
  // A known:true estimate with a missing estimateSeconds is treated as UNKNOWN (defensive): the engine
  // contract pairs known:true with a number, but the console must never render a fabricated 0 if not.
  const est = { known: true, confidence: "high" } as RtoEstimate;
  const line = rtoEstimateLine(est);
  eq("known:true but no estimateSeconds is treated as unknown", line.known, false);
  ok("that degraded case still renders the honest unknown, no fabricated number", !/\d/.test(line.value));
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nVALIDATE-REPORTS VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
