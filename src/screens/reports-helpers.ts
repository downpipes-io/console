// Reports pure helpers + small UI/value helpers, moved out of reports.ts to keep the
// screen module under its size bound (console-struct-miss-reports). Behaviour-preserving:
// the symbols are identical to their former definitions; reports.ts re-exports the
// validator-facing ones so importers and the validator are unchanged.
//
// The pure functions (signatureState, periodPhrase, humanSeconds, rtoEstimateLine) are the
// load-bearing honest reads: the signature-state read that must never overstate, the
// period phrasing, and the RTO reading that never fabricates a number. They are exercised
// by test/validate-reports.ts.

import { recordWireAnomaly } from "../lib/client-diag/ring.ts";
import { h } from "../lib/dom.ts";
import { badge, type StatusTone } from "../components/status.ts";
import { absoluteTime } from "../lib/format.ts";
import type { Report, RtoEstimate } from "../api.ts";

// ===========================================================================
// Pure helpers (exported for the validator: the signature-state read that must never
// overstate, and the period phrasing).
// ===========================================================================

// SignatureState is the honest read of a report's signature: whether it is present and
// well-formed, the status tone (never a stale green for an unsigned report), a short
// label, and a precise detail line that does not claim more than the console can assert.
export interface SignatureState {
  signed: boolean;
  tone: StatusTone;
  label: string;
  detail: string;
}

// signatureState classifies a report's signature field. A well-formed "edmldsa1:" hybrid
// signature reads as signed/tamper-evident (trust tone). A present-but-unrecognised
// prefix reads as signed with an unknown scheme (warn; do not assert verification). An
// absent signature reads as not signed (neutral; honestly no assurance). The console
// does NOT claim to have verified the signature cryptographically; it states the
// signature is present so an auditor verifies it out of band against the engine signer.
export function signatureState(signature: string | undefined): SignatureState {
  if (signature === undefined || signature === "") {
    return {
      signed: false,
      tone: "neutral",
      label: "Not signed",
      detail: "This report carries no signature, so it is not tamper-evident. A signature is added when the engine signer is configured; until then treat the figures as informational.",
    };
  }
  if (signature.startsWith("edmldsa1:")) {
    return {
      signed: true,
      tone: "trust",
      label: "Signed, tamper-evident",
      detail: "Signed with the post-quantum hybrid scheme (Ed25519 with ML-DSA-87) over the canonical report body. The signature is shown below; verify it out of band against the engine signer. Signed and tamper-evident, never tamper-proof.",
    };
  }
  return {
    signed: true,
    tone: "warn",
    label: "Signed, unrecognised scheme",
    detail: "The report carries a signature, but not the expected post-quantum hybrid prefix. The console cannot assert the scheme; verify it out of band before relying on it.",
  };
}

// periodPhrase describes a report's reporting window. An all-time report (period null)
// says so; a windowed report shows the from/to as absolute UTC dates. Epoch SECONDS per
// the contract. Exported for the validator.
export function periodPhrase(report: Report): string {
  if (report.period === null) return "All-time (no period bound)";
  const from = absoluteTime(report.period.fromSeconds * 1000);
  const to = absoluteTime(report.period.toSeconds * 1000);
  return `Period ${from} to ${to}`;
}

// humanSeconds formats a duration in SECONDS as a short, calm phrase ("about 45s", "about 6m",
// "about 2h 10m", "about 1d 3h"). The RTO estimate is an approximate projection, so the phrasing is
// deliberately rounded and prefixed "about" rather than implying a precise figure. Presentation only;
// never fed back into a request. A non-finite or negative input reads "unknown" (the honest fallback).
// Exported for the validator (the rounding boundaries are load-bearing for the honest reading).
export function humanSeconds(seconds: number): string {
  // The RTO projection came back as something that is not a finite, non-negative number of seconds, and
  // the report honestly reads "unknown". The honesty is right and the silence is not: an RTO an executive is
  // reading as "we cannot project this" is an engine that sent a broken figure, and it looked like a product
  // that simply does not compute one.
  if (!Number.isFinite(seconds)) recordWireAnomaly("duration", "non-finite");
  else if (seconds < 0) recordWireAnomaly("duration", "negative");
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  const s = Math.round(seconds);
  if (s < 60) return `about ${s}s`;
  const totalMin = Math.floor(s / 60);
  if (totalMin < 60) return `about ${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin - totalHr * 60;
  if (totalHr < 24) return remMin > 0 ? `about ${totalHr}h ${remMin}m` : `about ${totalHr}h`;
  const days = Math.floor(totalHr / 24);
  const remHr = totalHr - days * 24;
  return remHr > 0 ? `about ${days}d ${remHr}h` : `about ${days}d`;
}

// RtoLine is the honest, DOM-free reading of one RTO estimate, so the screen's render and the validator
// share the exact words. `value` is the headline (the formatted estimate, or the honest unknown); `basis`
// is the "based on N drills" caveat (or the unknown reason); `known` carries the discriminator so the
// render can tone the value (trust vs neutral) without re-deriving it.
export interface RtoLine {
  known: boolean;
  value: string;
  basis: string;
}

// rtoEstimateLine maps an RtoEstimate to its honest reading. An UNKNOWN estimate (no drill history) reads
// "Unknown (no recovery drills yet)" with the engine's reason as the basis, NEVER a fabricated number. A
// KNOWN estimate reads the formatted whole-archive recovery time with a "based on N drills" basis (and the
// coarse confidence). The number is the engine's derived projection; this only formats it. Exported for the
// validator (the never-fabricate-a-number rule is the load-bearing assertion).
export function rtoEstimateLine(est: RtoEstimate): RtoLine {
  // AN ENGINE THAT CLAIMED AN ESTIMATE AND SENT NO USABLE NUMBER IS NOT AN ESTATE WITH NO DRILLS.
  //
  // On the real function: {known: true, basedOnDrills: 3} with the seconds field absent, and the
  // same with the seconds arriving as the string "7200", BOTH rendered "Unknown (no recovery drills yet)"
  // over the basis "No restore-test history yet, so there is no signal to estimate from." That is BYTE
  // IDENTICAL to a brand-new estate that has genuinely never run a drill, and the two need opposite
  // actions: one operator should go and run a drill, the other has run three and has an engine sending a
  // figure this console cannot read. Telling the first story to the second operator sends them to run a
  // fourth drill that will change nothing.
  //
  // The two are separated here rather than folded, on the same reasoning recoveryCountReadable states for
  // the recovery-code count: "no drills yet" is a true and calm sentence about a new estate, and "the
  // engine reported a projection this console cannot read" is a fault in a live one.
  if (est.known === true && typeof est.estimateSeconds !== "number") {
    return {
      known: false,
      value: "Unknown (the projection could not be read)",
      basis: "Your engine reported a recovery-time projection in a shape this console cannot read, so no estimate is shown. Your restore-test history is unaffected; the raw figure travels in a support pack.",
    };
  }
  if (!est.known || typeof est.estimateSeconds !== "number") {
    return {
      known: false,
      value: "Unknown (no recovery drills yet)",
      basis: est.reason ?? "No restore-test history yet, so there is no signal to estimate from.",
    };
  }
  const drills = typeof est.basedOnDrills === "number" ? est.basedOnDrills : 0;
  const basisDrills = `Based on ${drills} ${drills === 1 ? "drill" : "drills"}`;
  const basis = est.confidence && est.confidence !== "none" ? `${basisDrills}, ${est.confidence} confidence` : basisDrills;
  return { known: true, value: humanSeconds(est.estimateSeconds), basis };
}

// ---- small UI + value helpers ----------------------------------------------

// signatureBadge renders the small signed/unsigned chip. The screen shows it only for the
// DEGRADED signature states (warn "unrecognised scheme", neutral "not signed"): a cleanly
// signed report already carries the trust dot + "Signed, tamper-evident" label, so a second
// green "signed" chip there was the same fact twice.
//
// The chip's TONE must track the signature STATE, not merely its signedness. A signature with
// an unrecognised scheme is "signed" but is NOT trusted, so it wears the state's warn tone
// (amber), never the green trust chip a tamper-evident report wears: beside its own "verify it
// out of band" line, a green "signed" chip reads as fully trusted. A not-signed report stays a
// neutral "unsigned" chip. The caller passes the signature state's tone (never "trust" here,
// since the clean-signed case renders no chip).
export function signatureBadge(tone: StatusTone, signed: boolean): HTMLElement {
  return signed ? badge(tone, "signed") : badge("default", "unsigned");
}

// safeStringify pretty-prints a value as JSON, falling back to a placeholder on a
// circular/throwing structure (a report is plain JSON from the engine, so this is belt
// and braces).
export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return "(the report could not be serialised for display)";
  }
}

// truncateMiddle shortens a long opaque string (a signature) for display, keeping the
// head and tail so it is recognisable; the full value is available via the copy button.
export function truncateMiddle(s: string, keep: number): string {
  if (s.length <= keep) return s;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

// downloadBytes triggers a browser download of raw bytes (the PDF). Mirrors the
// downloadText idiom the audit export uses, for a Uint8Array body. The Blob copies the
// bytes into a fresh ArrayBuffer-backed view so the BlobPart type is exact.
export function downloadBytes(name: string, bytes: Uint8Array, type: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    URL.revokeObjectURL(url);
  }
}
