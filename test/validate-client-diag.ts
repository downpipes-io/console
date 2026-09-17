// Validate the console-diagnostics ring (src/lib/client-diag/): the LOCAL, in-memory, bounded ring of
// coarse closed-class error records that rides inside a support pack the customer deliberately generates.
// This suite exercises the REAL modules; it never re-implements the behaviour.
//
// Run with `node test/validate-client-diag.ts`.
//
// Coverage (each load-bearing invariant of the design):
//   CONFORMANCE:   the console's frozen vocabulary EQUALS the engine's canonical list, member for member,
//                  in order, and cap for cap. The two repos are separate, so the lists are defined once per
//                  repo; this is the drift guard that stops them diverging (the AUTO_HEAL_REFUSAL_CODES
//                  pattern). It reads the ENGINE'S OWN SOURCE from the engine worktree.
//   I2 VALUE-FREE: a customer value (a downpipe id, an email, a token, a bucket name) planted at a catch
//                  site -- in the URL, in the error message, in the error name, in a response body, and in
//                  extra keys on a pushed record -- NEVER appears anywhere in the resulting payload. The
//                  payload is checked field by field: every string is a frozen member; there are NO string
//                  fields beyond the closed unions.
//   I3 SCREEN:     screenFromPattern is TOTAL (every route template maps to a frozen member), and a
//                  concrete path carrying a customer id maps to a frozen member with the id NOWHERE in the
//                  output -- so even the wrong implementation could not leak one.
//   MAPPERS:       faultClassForStatus is total over 100..599 (always a frozen member); httpClassForStatus
//                  is exact at the 4xx/5xx boundaries; httpClassForRejection classifies abort/timeout from
//                  a NAME EQUALITY check against product constants and copies nothing.
//   CAPS (D3):     coalescing is on the FULL tuple; a repeat is an increment, not a row; the per-kind row
//                  cap is 32 newest-wins; the global cap is 128; count is clamped; the per-kind true-count
//                  rollup survives rows the cap evicted.
//   CLAMPS:        clampInt / clampNonNegInt are total (NaN, Infinity, negatives, fractions, non-numbers).
//   MONOTONIC:     firstMs/lastMs come from performance.now offsets, never the wall clock (a Date.now jump
//                  backwards does not move them).
//   POST SHAPE:    the api layer sends POST /admin/support/bundle with { clientDiagnostics: {records,
//                  engineAttempts} } when a payload is supplied, and the UNCHANGED GET when it is not
//                  (which is what keeps the vendor bearer-pull structurally free of the section, I1).
//   BODY CAP (D1): packPayload never exceeds the engine's 32,768-byte pre-parse cap.
//
// Every section has a negative control that would fail on a wrong or no-op implementation.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportBundle } from "../src/lib/api/client-support.ts";
import type { Transport } from "../src/lib/api/client-transport.ts";
import { engineFetch } from "../src/lib/api/engine-fetch.ts";
import { mapEngineDownpipeState } from "../src/lib/api/helpers.ts";
import type { Downpipe } from "../src/lib/api/types.ts";
import { type BulkCreateItem, type BulkCreatePoster, runBulkCreate } from "../src/lib/bulk-create.ts";
import {
  bulkReasonForCounts,
  clampInt,
  clampNonNegInt,
  currentScreen,
  faultClassForError,
  faultClassForStatus,
  httpClassForRejection,
  httpClassForStatus,
  isNavigationCancelled,
  noteEngineAttempt,
  packPayload,
  push,
  recordAdminWrite,
  recordAdminWriteThrown,
  recordBulkOutcome,
  recordCapabilityFault,
  recordClaimExchange,
  recordContractDrift,
  recordContractSkew,
  recordDiscoveryConnect,
  recordEngineCall,
  recordFocusLanding,
  recordFormRefused,
  recordOnboardingStep,
  recordReadDegraded,
  recordRecoveryRefusal,
  recordRendererState,
  recordStorageBlocked,
  recordTransportFault,
  reset,
  rollupByKind,
  screenFromPattern,
  setActiveScreen,
  snapshot,
  storageClassFor,writeOutcomeForStatus 
} from "../src/lib/client-diag/ring.ts";
import {
  ADMIN_OPS_RECORDING_SUCCESS,
  CLIENT_DIAG_ADMIN_OPS,
  CLIENT_DIAG_ANOMALIES,
  CLIENT_DIAG_APPLY_CLASSES,
  CLIENT_DIAG_BOOT_CLASSES,
  CLIENT_DIAG_BUILD_CHECK_CLASSES,
  CLIENT_DIAG_BULK_ACTIONS,
  CLIENT_DIAG_CALL_CLASSES,
  CLIENT_DIAG_CAPABILITIES,
  CLIENT_DIAG_CAPABILITY_OUTCOMES,
  CLIENT_DIAG_CATALOGUE_CLASSES,
  CLIENT_DIAG_CEREMONY_FAULTS,
  CLIENT_DIAG_CEREMONY_OUTCOMES,
  CLIENT_DIAG_CEREMONY_STEPS,
  CLIENT_DIAG_CHANNEL_REASON_CLASSES,
  CLIENT_DIAG_CLAIM_RESULTS,
  CLIENT_DIAG_CONTRACT_CLASSES,
  CLIENT_DIAG_COUNT_MAX,
  CLIENT_DIAG_CSP_BLOCKED,
  CLIENT_DIAG_CSP_DIRECTIVES,
  CLIENT_DIAG_CSP_INLINE_ORIGINS,
  CLIENT_DIAG_DEGRADE_CAUSES,
  CLIENT_DIAG_DELETE_FATES,
  CLIENT_DIAG_DISCOVERY_OUTCOMES,
  CLIENT_DIAG_DRIFT_CLASSES,
  CLIENT_DIAG_DRILL_ABORTS,
  CLIENT_DIAG_DRILL_FACTS,
  CLIENT_DIAG_DROP_FACTS,
  CLIENT_DIAG_DROP_SURFACES,
  CLIENT_DIAG_ERROR_CLASSES,
  CLIENT_DIAG_FAULT_CLASSES,
  CLIENT_DIAG_FAULT_SOURCES,
  CLIENT_DIAG_FEATURE_CLASSES,
  CLIENT_DIAG_FEATURE_OUTCOMES,
  CLIENT_DIAG_FIELD_CLASSES,
  CLIENT_DIAG_FIELD_FAMILIES,
  CLIENT_DIAG_FOCUS_OUTCOMES,
  CLIENT_DIAG_FORM_FIELDS,
  CLIENT_DIAG_GATE_BLOCK_CLASSES,
  CLIENT_DIAG_GLOBAL_ROW_CAP,
  CLIENT_DIAG_GOV_GATES,
  CLIENT_DIAG_HANDOFF_CLASSES,
  CLIENT_DIAG_HTTP_CLASSES,
  CLIENT_DIAG_INTENT_CLASSES,
  CLIENT_DIAG_KINDS,
  CLIENT_DIAG_MATERIAL_CLASSES,
  CLIENT_DIAG_MAX_BODY_BYTES,
  CLIENT_DIAG_MS_MAX,
  CLIENT_DIAG_ONBOARDING_OUTCOMES,
  CLIENT_DIAG_ONBOARDING_STEPS,
  CLIENT_DIAG_OWNER_ACTION_CODES,
  CLIENT_DIAG_PER_KIND_ROW_CAP,
  CLIENT_DIAG_PROBE_OUTCOMES,
  CLIENT_DIAG_PROBE_SURFACES,
  CLIENT_DIAG_REASON_CLASSES,
  CLIENT_DIAG_RECOVERY_CODES,
  CLIENT_DIAG_RECOVERY_OPS,
  CLIENT_DIAG_REJECT_OUTCOMES,
  CLIENT_DIAG_RENDERER_MODES,
  CLIENT_DIAG_ROLLBACK_CLASSES,
  CLIENT_DIAG_SCREENS,
  CLIENT_DIAG_SKEW_CLASSES,
  CLIENT_DIAG_STORAGE_AREAS,
  CLIENT_DIAG_STORAGE_CLASSES,
  CLIENT_DIAG_STORAGE_OPS,
  CLIENT_DIAG_STORAGE_SURFACES,
  CLIENT_DIAG_SURFACES,
  CLIENT_DIAG_TRANSPORT_CLASSES,
  CLIENT_DIAG_WRITE_OUTCOMES,
  type ClientDiagFaultClass,
  type ClientDiagHttpClass,
  type ClientDiagKind,
  type ClientDiagnosticRecord,
  type ClientDiagScreen,
  CONSOLE_BUILD_RE,
} from "../src/lib/client-diag/vocab.ts";
import { noteUnhandledRejection, noteWindowError } from "../src/lib/client-diag/window-faults.ts";
import { validateSplitParams } from "../src/lib/custody.ts";
import { requestPostNavigationFocus, takePostNavigationFocus } from "../src/lib/nav.ts";
import { RECOVERY_REFUSAL_CODES } from "../src/lib/recovery-refusal-codes.ts";
import { classifyRenderer } from "../src/screens/map/renderer-diag.ts";
import { verdictCannotCheck, verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;

function ok(cond: boolean, what: string): void {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL ${what}`);
  }
}

function eq<T>(actual: T, expected: T, what: string): void {
  ok(Object.is(actual, expected), `${what} (got ${String(actual)}, want ${String(expected)})`);
}

function section(name: string): void {
  console.log(`\n${name}`);
}

// ---- 1. CONFORMANCE: the console vocabulary EQUALS the engine's canonical vocabulary ------------------
//
// The console and the engine are SEPARATE REPOS, so the frozen lists cannot be imported across the
// boundary. They are defined once per repo and this test asserts they are identical. It parses the
// ENGINE'S OWN SOURCE (the canonical file) so a member added on either side and not the other fails here.

section("1. conformance: console vocabulary == engine canonical vocabulary (drift guard)");

// WHICH ENGINE. Naming a single fixed worktree path risks comparing the shipping console against an engine
// checkout that will never ship: the check would pass, green and confident, while the console emitted kinds
// the REAL engine drops on arrival. That is the "looks closed" failure this whole vocabulary guard exists to
// prevent, so the resolution has to be live rather than pinned.
//
// So the engine is resolved the way scripts/client-diag-parity-gate.mjs resolves it: an explicit override
// first, then the worktree that IS the engine being built, then the merged repo. The order is shared with the
// gate deliberately, so the test and the gate can never disagree about which engine they are checking.
const HERE = dirname(fileURLToPath(import.meta.url));

// Walk out of a .worktrees/<name> layout to the directory holding the repos. Without this NO candidate
// below resolves when the console is checked out as a worktree, which is how it is checked out for most
// runs: the relative hops land on console/.worktrees/engine and console/engine, neither of which ever
// exists. A missing-engine response of "skip" would let the cross-repo drift check quietly not run at all,
// so a vocabulary change made on one side of the mirror could go uncaught by the thing built to catch it.
function workspaceRoot(from: string): string {
  const at = from.indexOf(`${sep}.worktrees${sep}`);
  return at === -1 ? join(from, "..", "..", "..") : join(from.slice(0, at), "..");
}
const ENGINE_CANDIDATES = [
  process.env.DOWNPIPES_ENGINE,
  join(HERE, "..", "..", "support-unified-engine"),
  join(HERE, "..", "..", "support-pack-engine"),
  join(HERE, "..", "..", "engine"),
  join(HERE, "..", "..", "..", "engine"),
  join(workspaceRoot(HERE), "engine"),
].filter((c): c is string => typeof c === "string" && c.length > 0);

let engineSrc = "";
let ENGINE_VOCAB = "(not found)";
let ENGINE_ROOT = "";
for (const root of ENGINE_CANDIDATES) {
  const candidate = join(root, "src", "admin", "client-diag-vocab.ts");
  try {
    engineSrc = readFileSync(candidate, "utf8");
    ENGINE_VOCAB = candidate;
    ENGINE_ROOT = root;
    break;
  } catch {
    // Not this one: try the next candidate.
  }
}

// A conformance check that quietly opts out when it cannot check reads as a pass, so the skip below is loud
// rather than silent, and it stays bounded: it must never be the reason the cross-repo guarantee stops being
// checked EVERYWHERE.
//
// `npm run validate:workspace` runs this file with the engine checked out and no candidate missing, and that
// chain is where the cross-repo guarantee actually lives. A console-only runner records the note below and
// carries on with sections 2 onward, which are entirely console-side and lose nothing.
// REQUIRE_ENGINE=1 turns that bounded skip into a failure, the same contract test/engine-path.ts carries: it
// is the chain whose whole purpose is the cross-repo comparison, so there a missing engine is a configuration
// fault to fix, not a reason to stop checking.
const ENGINE_PRESENT = engineSrc.length > 0;
if (!ENGINE_PRESENT && process.env.REQUIRE_ENGINE === "1") {
  // A REFUSAL, NOT A FINDING. Exiting 1 in this repository means the console diverged from the engine. It did
  // not: the engine's vocabulary was never read, so no member of it was compared with anything. The
  // distinction is the whole reason the chains run through scripts/run-gate-chain.mjs, where a refusal
  // outranks a finding precisely so that a chain reporting 1 can be read as "every member graded its subject,
  // and these are the violations". A could-not-establish reported as 1 poisons that reading at the source, so
  // this refuses (exit 2 via verdictCannotCheck) exactly as its sibling scripts/client-diag-parity-gate.mjs
  // does when it walks the same candidate list and finds no engine.
  verdictCannotCheck(
    `validate-client-diag: REFUSED, REQUIRE_ENGINE=1 and the engine canonical vocabulary was not found (tried ${ENGINE_CANDIDATES.length} candidates).\n` +
      "  This is the cross-repo chain: the conformance drift guard must run here rather than skip, and with\n" +
      "  no engine it cannot run at all. Nothing below was compared against the engine, so this file will not\n" +
      "  report that the conformance comparison happened.\n" +
      "  Point it at one with DOWNPIPES_ENGINE=/path/to/engine, or check the engine out beside this repo.",
  );
}
if (!ENGINE_PRESENT) {
  console.log(`  note engine canonical vocabulary not found (tried ${ENGINE_CANDIDATES.length} candidates); skipping the conformance drift guard`);
  console.log("  note run `npm run validate:workspace` with the engine checked out, or set DOWNPIPES_ENGINE, to exercise it");
} else {
  ok(engineSrc.length > 0, `the engine's canonical vocabulary is readable at ${ENGINE_VOCAB}`);

  // Trusting whatever candidate resolves, with no staleness check and no printed provenance beyond the ok()
  // line above (which only prints on FAILURE), risks comparing correct console vocabulary against an engine
  // checkout that is merely BEHIND its own origin/main -- for example an unrelated leftover clone sitting at a
  // candidate path in a shared scratch tree, coincidentally named "engine". That reports assertions failing
  // that look exactly like real console-vs-engine drift when they are not: a fresh clone of both repos' actual
  // origin/main agrees member for member, cap for cap. So which engine, and how stale, is printed
  // unconditionally rather than left a mystery, matching the same guard in scripts/client-diag-parity-gate.mjs
  // (this file's sibling, walking the SAME candidate list, so the two can never disagree about which engine
  // they are checking). CLIENT_DIAG_ALLOW_STALE=1 overrides, matching the gate.
  console.log(`  note comparing against engine at ${ENGINE_ROOT} (${ENGINE_VOCAB})`);
  if (process.env.CLIENT_DIAG_ALLOW_STALE !== "1") {
    let behind: number | null = null;
    try {
      behind = Number(
        execFileSync("git", ["-C", ENGINE_ROOT, "rev-list", "--count", "HEAD..origin/main"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      );
    } catch {
      // Unknown freshness (no origin/main ref, not a git checkout at all, no network) -- nothing to conclude.
    }
    if (Number.isFinite(behind) && (behind as number) > 0) {
      // A REFUSAL, NOT A FINDING. A stale sibling does not mean the console is wrong about the engine, it
      // means this file cannot establish what the engine's vocabulary IS, so there is no comparison to report
      // the result of. Every other guard in this repository that measures the same lag already says so with
      // exit 2: scripts/sibling-staleness.mjs refuseIfStale, and the gates that inline the same rev-list,
      // scripts/client-diag-parity-gate.mjs among them, which walks this file's own candidate list.
      //
      // CLIENT_DIAG_ALLOW_STALE=1 still grades the old tree, matching the same hatch in those gates. It is the
      // answer to "I meant to use an old tree", not to this: a hatch cannot make a refusal into a correct
      // finding, it only decides whether the old tree is graded.
      verdictCannotCheck(
        `validate-client-diag: REFUSED, the engine at ${ENGINE_ROOT} is ${behind} commit(s) behind its own origin/main.\n` +
          "  Every conformance assertion below would grade the console against a vocabulary that has since\n" +
          "  moved, and report it safe. That is a comparison this file cannot make rather than one it made and\n" +
          "  failed, so it will not report a divergence it did not establish.\n" +
          "  Update the checkout, or set CLIENT_DIAG_ALLOW_STALE=1 if an old tree is deliberate.",
      );
    }
  }
}

// engineList extracts the string-literal members of an exported `as const` array from the engine source.
// It reads the members positionally, so ORDER is compared too, not just set membership.
//
// COMMENTS ARE STRIPPED FIRST, AND THAT IS NOT A TIDY-UP. Scraping every "..." in the array's source text
// without stripping comments first would turn a QUOTED PHRASE IN A COMMENT into a phantom vocabulary member.
// The engine's vocabulary is heavily commented (each member carries a note on why it exists), and the moment a
// comment quotes a role name or a sentence -- `"owner only"`, `"nothing, or only the secrets named before the
// failure, was set"` -- an unstripped parse would grow the engine list with members the engine does not have.
// The pins would then fail against prose, and, far worse, a count that happened to match would PASS while
// comparing garbage.
//
// A gate that mis-parses its subject is worse than no gate: it converts an unchecked invariant into a green tick,
// which is the same failure that let the bot's vocabulary sit fifteen kinds behind the engine with a green suite.
function engineList(name: string): string[] {
  const m = engineSrc.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  if (!m || m[1] === undefined) return [];
  const body = m[1]
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/[^\n]*/g, ""); // line comments (every member's trailing note, and the section headers)
  return [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
}

function engineNumber(name: string): number | null {
  const m = engineSrc.match(new RegExp(`export const ${name} = ([0-9_]+);`));
  if (!m || m[1] === undefined) return null;
  return Number(m[1].replace(/_/g, ""));
}

const VOCAB_PAIRS: Array<[string, readonly string[], number]> = [
  ["CLIENT_DIAG_KINDS", CLIENT_DIAG_KINDS, 42], // +focus-landing: the FIRST member of this vocabulary that can see the accessibility surface. With zero members matching keyboard/a11y/tablist/roving/focus, a keyboard user who could not arrow past the first tab produced a pack byte-identical to a healthy one.
  ["CLIENT_DIAG_SCREENS", CLIENT_DIAG_SCREENS, 18],
  ["CLIENT_DIAG_HTTP_CLASSES", CLIENT_DIAG_HTTP_CLASSES, 5],
  ["CLIENT_DIAG_FAULT_CLASSES", CLIENT_DIAG_FAULT_CLASSES, 7],
  ["CLIENT_DIAG_DRIFT_CLASSES", CLIENT_DIAG_DRIFT_CLASSES, 4],
  ["CLIENT_DIAG_REASON_CLASSES", CLIENT_DIAG_REASON_CLASSES, 6],
  ["CLIENT_DIAG_APPLY_CLASSES", CLIENT_DIAG_APPLY_CLASSES, 6],
  // These discriminators are conformance-checked exactly like the rest: a capability or a surface the
  // console emits and the engine does not admit means the engine DROPS the row on arrival, and the browser
  // evidence for a refused recovery download vanishes silently on its way into the pack.
  ["CLIENT_DIAG_CAPABILITIES", CLIENT_DIAG_CAPABILITIES, 4],
  // surface 6 -> 7: add-operational-key (the targeted break-glass-only -> operational upgrade card's own
  // keygen-fault reporting, distinct from the full ceremony's key-ceremony tag).
  ["CLIENT_DIAG_SURFACES", CLIENT_DIAG_SURFACES, 8],
  ["CLIENT_DIAG_CAPABILITY_OUTCOMES", CLIENT_DIAG_CAPABILITY_OUTCOMES, 2],
  // These discriminators are conformance-checked exactly like the rest: a member the console emits and the
  // engine does not admit means the engine DROPS the whole row on arrival, and the browser evidence for a
  // console update that was never served, a restore gate that could not arm, or a wire value that would not
  // parse vanishes silently on its way into the pack.
  ["CLIENT_DIAG_BOOT_CLASSES", CLIENT_DIAG_BOOT_CLASSES, 2],
  ["CLIENT_DIAG_BUILD_CHECK_CLASSES", CLIENT_DIAG_BUILD_CHECK_CLASSES, 6],
  ["CLIENT_DIAG_ROLLBACK_CLASSES", CLIENT_DIAG_ROLLBACK_CLASSES, 7],
  ["CLIENT_DIAG_GATE_BLOCK_CLASSES", CLIENT_DIAG_GATE_BLOCK_CLASSES, 4],
  ["CLIENT_DIAG_FIELD_CLASSES", CLIENT_DIAG_FIELD_CLASSES, 21], // +blackout-minute: the clamp that silently EDITS the customer schedule; +cadence: a cadence this build cannot read NULLS the staleness test, so a two-month-old backup renders green
  ["CLIENT_DIAG_ANOMALIES", CLIENT_DIAG_ANOMALIES, 6], // +out-of-range: parsed, finite, non-negative and still outside the field's range
  ["CLIENT_DIAG_ERROR_CLASSES", CLIENT_DIAG_ERROR_CLASSES, 10],
  ["CLIENT_DIAG_FAULT_SOURCES", CLIENT_DIAG_FAULT_SOURCES, 2],
  // Same reason, and it is the reason this whole file exists: a member the console emits and the engine does
  // not admit means the engine DROPS the row on arrival, so the browser evidence for a CORS-blocked console, a
  // swallowed recovery-status read, a wizard step nobody could get past, a discovery token that saw nothing, or
  // a vendor claim outage vanishes silently on its way into the pack, and the pack reads clean.
  // +engine-binding-absent: when THE CONSOLE'S OWN DEPLOY has no ENGINE service binding, the engine surfaces
  // fall through to the SPA and serve index.html at 200. The console reads its own shell as `html-not-engine`
  // ("correct the engine URL", on a URL that is correct), the engine receives nothing and reads healthy in the
  // same pack, and a /metrics scrape of HTML at 200 tells the customer's monitoring all is well.
  ["CLIENT_DIAG_TRANSPORT_CLASSES", CLIENT_DIAG_TRANSPORT_CLASSES, 10], // +console-origin-fault: the console's OWN 500, which would otherwise be filed as an engine 5xx
  ["CLIENT_DIAG_CALL_CLASSES", CLIENT_DIAG_CALL_CLASSES, 7],
  ["CLIENT_DIAG_ONBOARDING_STEPS", CLIENT_DIAG_ONBOARDING_STEPS, 6],
  // +readiness-refused and +poll-refused. The readiness poll's catch was the ONE swallowed engine read in the
  // wizard that classified nothing at all, so an engine ANSWERING 500 ON EVERY TICK was filed under members
  // whose own definitions -- and the support bot's rendering of them -- assert that the engine was
  // UNREACHABLE. A row must not assert something the code never tested.
  // With engine-binding-absent: the wizard's calls never left the console, so no member that asserts something
  // about the ENGINE's reachability may carry that state.
  ["CLIENT_DIAG_ONBOARDING_OUTCOMES", CLIENT_DIAG_ONBOARDING_OUTCOMES, 14], // +console-origin-fault: the poll's ticks were answered by the console, not the engine
  // channelReasonClass is pinned here because leaving it out is how a silently frozen update channel could go
  // on being classified into four members while the fifth and sixth were needed.
  ["CLIENT_DIAG_CHANNEL_REASON_CLASSES", CLIENT_DIAG_CHANNEL_REASON_CLASSES, 6],
  ["CLIENT_DIAG_DISCOVERY_OUTCOMES", CLIENT_DIAG_DISCOVERY_OUTCOMES, 5],
  // +band-full: a self-serve licence's estate band already fully bound to other Cloudflare accounts, a
  // legitimate business refusal (409) admitted as an engine-and-console pair (this vocab and the engine's own
  // client-diag-vocab.ts) so the pack can tell it apart from a genuine fault (http-4xx) rather than dropping
  // the row or mis-classifying it.
  ["CLIENT_DIAG_CLAIM_RESULTS", CLIENT_DIAG_CLAIM_RESULTS, 10],
  // Same reason again: an adminOp the console emits and the engine does not admit means the engine DROPS the
  // row, and the evidence that a rollback, an offboarding, a dual-control toggle or a binding attach was
  // REFUSED vanishes on its way into the pack.
  // +idp-connection-cert-rollover: the SAML signing-cert rollover, admitted as an engine-and-console pair with
  // the engine admitting it first.
  // +recovery-codes-confirm: the save-confirm panel's own POST, admitted as an engine-and-console pair with the
  // engine admitting it first.
  ["CLIENT_DIAG_ADMIN_OPS", CLIENT_DIAG_ADMIN_OPS, 59],
  ["CLIENT_DIAG_WRITE_OUTCOMES", CLIENT_DIAG_WRITE_OUTCOMES, 7],
  // +estate-import-sealed: the browser-unseal counterpart of estate-import.
  ["CLIENT_DIAG_RECOVERY_OPS", CLIENT_DIAG_RECOVERY_OPS, 6], // +cp-restore-sealed: the console call site for POST /control-plane/restore-sealed. +cp-acknowledge: the acknowledge-only latch clear, its own operator in front of its own broken thing rather than a variant of cp-restore
  // DP-R18/R19/R20/R21 give the four verify verdicts their own codes rather than sharing DP-R15 across a
  // second branch, which the vocabulary's own rule forbids. The engine verifies BOTH halves of the
  // hybrid signature over the same export bytes, so a failure that leaves either half verifying proves the
  // EXPORT intact and puts the damage in the operator's own kit: the opposite remedy to the tamper code. The
  // engine twin must admit each one or the row is dropped on arrival and the split never reaches the pack.
  // +DP-R22..DP-R28, the browser-unseal-only codes (lib/sealed-export-unseal.ts) -- states only a browser
  // holding the private identity can ever observe, with no plaintext-import equivalent.
  ["CLIENT_DIAG_RECOVERY_CODES", CLIENT_DIAG_RECOVERY_CODES, 30], // +DP-R29/DP-R30, the engine-side twins of DP-R23/DP-R28 that only the sealed reconcile route can answer. +DP-R31/R32/R33, the acknowledge route's three refusals, none of which an existing code covers (DP-R11 says "not an Owner", wrong in both directions here; DP-R12 is a verification code over an artefact this call does not carry)
  // Same reason once more, and it is worth stating because it is the failure this whole suite exists to
  // prevent: a member the console emits and the engine does not admit is a row the engine DROPS on arrival, so
  // the browser's evidence that a restore option was thrown away, that a vendor test failed, that a validator
  // refused a value the catalogue accepts, or that the console was told to grey a control out, vanishes on its
  // way into the pack, and the pack reads clean.
  ["CLIENT_DIAG_INTENT_CLASSES", CLIENT_DIAG_INTENT_CLASSES, 5],
  ["CLIENT_DIAG_PROBE_SURFACES", CLIENT_DIAG_PROBE_SURFACES, 5],
  ["CLIENT_DIAG_PROBE_OUTCOMES", CLIENT_DIAG_PROBE_OUTCOMES, 22], // +dest-region-mismatch
  // The destination controls with NO client-side validator (dest-r2-bucket, dest-account-id, dest-s3-bucket,
  // dest-region, dest-access-key, dest-secret) carry no member here. A form-rejected row means the console's
  // OWN validator refused the operator in the browser; those six are verified by the ENGINE, live, and its
  // refusal is an engine-call row.
  //
  // Every control whose validator can only reject the EMPTY string (the six deploy-token controls,
  // channel-name, channel-routing-key, demo-reset-token, group-role-group, idp-client-id, idp-label,
  // licence-token, saml-label) is excluded too. Each HAS a validator, which is why a naive list would look
  // right, and each validator is an emptiness test and nothing more, so every non-empty string passes it.
  // Their only reachable refusal is the empty one, and components/field.ts does not record that (an operator
  // part-way through a form is the commonest blur in the console, not a fault) -- so no build could ever emit
  // them, and a member here would assert that a validator turned the operator away from a value it never
  // examined.
  //
  // The same pathology extends to pk-recovery-code (`v === ""`), terminate-user-email (`v.trim() === ""`) and
  // rule-downpipe (a CROSS-FIELD emptiness test), which are emptiness-only validators written in ways a naive
  // regex-based scan would miss; idp-secret is the same rule on the refuse() arm (the IdP preset refuses a
  // confidential client with an EMPTY secret box, and nothing else), which a plain `v !== ""` guard would also
  // miss. The dead-vocab gate decides by MEANING -- a validator whose every use of the value is an emptiness
  // test cannot refuse the value the operator typed -- and refuse() carries the same guard, so neither arm can
  // record an empty box.
  //
  // The dead-vocab gate models all of this and fails on a member with no producer, so a control that gains a
  // REAL client-side rule (a shape, a bound, a range) fails just as loudly until its member goes back in.
  // +saml-rollover-certs, the rollover paste box, passes the test the paragraph above sets rather than being
  // waved through: its validator refuses a non-empty paste with no BEGIN CERTIFICATE header, so it can record
  // a refusal the operator actually saw.
  ["CLIENT_DIAG_FORM_FIELDS", CLIENT_DIAG_FORM_FIELDS, 56],
  ["CLIENT_DIAG_REJECT_OUTCOMES", CLIENT_DIAG_REJECT_OUTCOMES, 2],
  ["CLIENT_DIAG_CATALOGUE_CLASSES", CLIENT_DIAG_CATALOGUE_CLASSES, 20], // +the five classified catalogue-read throws (cf-surface-list-not-an-engine / -denied / -refused-at-edge / -rate-limited / -transport) and cf-rediscover-refused-at-edge: a 403 that did not speak the ENGINE'S refusal vocabulary is not a role denial
  ["CLIENT_DIAG_FEATURE_CLASSES", CLIENT_DIAG_FEATURE_CLASSES, 7], // -custom-roles: it had no caller, so it was dead vocabulary
  ["CLIENT_DIAG_FEATURE_OUTCOMES", CLIENT_DIAG_FEATURE_OUTCOMES, 13], // +refused-not-by-engine: a 403 whose body is not a refusal the engine emits establishes neither the role nor the address
  ["CLIENT_DIAG_GOV_GATES", CLIENT_DIAG_GOV_GATES, 2],
  ["CLIENT_DIAG_SKEW_CLASSES", CLIENT_DIAG_SKEW_CLASSES, 8], // re-aimed at the RUNNING bundle vs what the ORIGIN serves
  // Same rule, same reason: a member the console emits and the engine does not admit is a row the engine DROPS
  // on arrival, so the browser's evidence that a recovery share was refused for base64 padding, that a bulk
  // DELETE half-failed (rather than some other bulk loop), that an aborted fleet drill never reached 22 of its
  // 30 pipes, or that the console was handed an IdP preset it does not know, vanishes on its way into the pack,
  // and the pack reads clean.
  ["CLIENT_DIAG_BULK_ACTIONS", CLIENT_DIAG_BULK_ACTIONS, 7],
  ["CLIENT_DIAG_MATERIAL_CLASSES", CLIENT_DIAG_MATERIAL_CLASSES, 5],
  ["CLIENT_DIAG_CONTRACT_CLASSES", CLIENT_DIAG_CONTRACT_CLASSES, 6],
  ["CLIENT_DIAG_FIELD_FAMILIES", CLIENT_DIAG_FIELD_FAMILIES, 31], // +downpipe-config: ONE malformed row inside a healthy list, which the engine's own roster-hygiene names and heals, and which no retry fixes. Kept apart from downpipe-list because the pack must not coalesce a whole-read contract break with a single roster ghost. -vendor-mark: its only producer read the console's OWN integrations catalogue, so no engine could ever reach it. token-source-flags fired only when the engine advertised NOT ONE capability, so a build advertising a strict SUBSET (which is what a rollback lands on) recorded nothing and read like a healthy engine. Replaced by one family per capability: token-source-tier/-cf-config/-workers/-stream/-images.
  ["CLIENT_DIAG_DRILL_ABORTS", CLIENT_DIAG_DRILL_ABORTS, 3],
  ["CLIENT_DIAG_DRILL_FACTS", CLIENT_DIAG_DRILL_FACTS, 6], // +deferred: a break-glass-only refusal is not a failure
  // Same rule, same reason: a member the console emits and the engine does not admit is a row the engine DROPS
  // on arrival, so the browser's evidence that a dual-control approval was refused for a maker-checker clash,
  // that the console's own asset was blocked by its own CSP, that half a certificate paste was silently
  // discarded, that a wizard lost the operator's account pick, or that an M-of-N split died in a locked-down
  // browser, vanishes on its way into the pack, and the pack reads clean.
  ["CLIENT_DIAG_OWNER_ACTION_CODES", CLIENT_DIAG_OWNER_ACTION_CODES, 12], // +identity-unresolved (no identity to judge by, so do NOT claim not-owner); terminal-state (a status the routes never return) replaced by expired + already-decided, read off the console's own inbox; +bare-token (the break-glass caller dual control refuses by design, which was landing in the residual) and +answer-unreadable (a 2xx whose body will not parse is an engine that ANSWERED and, on an approve, already ran the action: recording it as `unreachable` sent support away from it); and THE 403 SPLIT: +engine-authz-refused, +engine-csrf and +edge-blocked, because FOUR things answer 403 to one approve and only the capability gate is about the caller's authority
  // `frame-src` is not a member: buildCsp states no frame-src and the console embeds no frames, so the browser
  // can never name that directive in a violation report. An injected frame still records, as `other`.
  ["CLIENT_DIAG_CSP_DIRECTIVES", CLIENT_DIAG_CSP_DIRECTIVES, 7],
  ["CLIENT_DIAG_CSP_BLOCKED", CLIENT_DIAG_CSP_BLOCKED, 5],
  // cspInlineOrigin and deleteFate are pinned here for the SAME reason as everything above them, and they are
  // the two members most likely to be dropped quietly: each one is the ONLY thing separating a pair of states
  // that are otherwise byte-identical. Without cspInlineOrigin admitted engine-side, a stale pre-paint hash (a
  // broken deploy) and an injected inline script (an attack) arrive as one row. Without deleteFate, a
  // custom-role delete that was merely QUEUED for approval arrives as one that was APPLIED, and the pack
  // asserts that N people lost access when nobody did.
  ["CLIENT_DIAG_CSP_INLINE_ORIGINS", CLIENT_DIAG_CSP_INLINE_ORIGINS, 2],
  ["CLIENT_DIAG_DELETE_FATES", CLIENT_DIAG_DELETE_FATES, 2],
  ["CLIENT_DIAG_DROP_SURFACES", CLIENT_DIAG_DROP_SURFACES, 2],
  ["CLIENT_DIAG_DROP_FACTS", CLIENT_DIAG_DROP_FACTS, 2],
  ["CLIENT_DIAG_HANDOFF_CLASSES", CLIENT_DIAG_HANDOFF_CLASSES, 3], // -wizard-account-lost, +wizard-spec-account-absent, +editor-refused-account-absent: the wizard cannot LOSE an account (every discovered-row apply() writes it with the binding), and the one class was coalescing two opposite tickets -- a spec the wizard SENT (an engine 400 exists) and a create the editor refused LOCALLY (no request was ever made). -prefill-zone-unmatched, -prefill-account-unmatched and -wizard-binding-lost have no producer either. The last one hides best: its recorder exists and typechecks, but it needs chosenType kv/r2/d1 and the wizard radio rows write only workers/stream/images/artifacts -- the binding-backed kinds are the CHECKBOX path, keyed BY the binding name, so the binding cannot go missing there. WizType is now the four radio types, so the branch is unrepresentable.
  ["CLIENT_DIAG_CEREMONY_STEPS", CLIENT_DIAG_CEREMONY_STEPS, 4],
  ["CLIENT_DIAG_CEREMONY_OUTCOMES", CLIENT_DIAG_CEREMONY_OUTCOMES, 2],
  ["CLIENT_DIAG_CEREMONY_FAULTS", CLIENT_DIAG_CEREMONY_FAULTS, 5],
  // Same rule, same reason, and these two are the ones no engine can ever re-derive: a member the console
  // emits and the engine does not admit is a row the engine DROPS on arrival, so a locked-down browser that
  // lost the operator's wizard, and a topology map the browser refused to render, would be recorded in the
  // browser and vanish silently on the way into the pack.
  ["CLIENT_DIAG_STORAGE_AREAS", CLIENT_DIAG_STORAGE_AREAS, 2],
  ["CLIENT_DIAG_STORAGE_OPS", CLIENT_DIAG_STORAGE_OPS, 3],
  ["CLIENT_DIAG_STORAGE_CLASSES", CLIENT_DIAG_STORAGE_CLASSES, 4],
  ["CLIENT_DIAG_STORAGE_SURFACES", CLIENT_DIAG_STORAGE_SURFACES, 7],
  ["CLIENT_DIAG_RENDERER_MODES", CLIENT_DIAG_RENDERER_MODES, 2],
  ["CLIENT_DIAG_DEGRADE_CAUSES", CLIENT_DIAG_DEGRADE_CAUSES, 6],
  // This pair closes the gap where the accessibility surface had no vocabulary AT ALL, so a keyboard user
  // trapped on the first tab of a tablist produced a pack byte-identical to a healthy one. It is pinned here
  // under the same rule as every pair above, and the engine half matters more than usual: a focusOutcome the
  // console emits and the engine does not admit fails the WHOLE RECORD closed in projectRecord(), so the row
  // would not be downgraded, it would VANISH.
  ["CLIENT_DIAG_FOCUS_OUTCOMES", CLIENT_DIAG_FOCUS_OUTCOMES, 3],
];

for (const [name, consoleList, expectedCount] of VOCAB_PAIRS) {
  // The console-side frozen count is a console-only fact and is asserted on every runner: a member added
  // here without updating the frozen number fails in the repo-local chain, with no engine in sight.
  eq(consoleList.length, expectedCount, `${name}: the console list has the frozen member count`);
  // The two cross-repo comparisons need the engine's own source. They run in validate:workspace, and on a
  // console-only runner they are skipped once, loudly, by the note printed above rather than silently here.
  if (!ENGINE_PRESENT) continue;
  const fromEngine = engineList(name);
  eq(fromEngine.length, expectedCount, `${name}: the engine list has the frozen member count`);
  eq(consoleList.join(","), fromEngine.join(","), `${name}: console == engine, member for member and in order`);
}

// Negative control: a member the vocabulary never froze must NOT be present on either side. `csp-violation` is
// admitted deliberately rather than excluded as browser-noise-dominated, and it is worth saying why rather than
// leaving the assertion unexplained: the extension noise a blanket exclusion would worry about is real, but
// dropping the whole channel would throw away the only possible evidence for a stale-hashed-chunk fault (the
// console's OWN asset silently blocked by its OWN policy after an update) and for any injection attempt at
// all. The noise is a FILTER to write, not a reason to have no signal, and window-faults.ts writes it: an
// extension-origin blocked URI is dropped before anything is classified.
//
// `storage-blocked` is admitted for the same reason rather than excluded as private-browsing noise: a private
// window does not make the store throw (a private window gives a partitioned store that works and is cleared
// on close). What DOES make it throw is a locked-down enterprise profile or a blocked-storage policy, which is
// not noise: it is the customer whose wizard drafts vanish, whose engine URL will not stick and whose
// motion-sensitivity pause re-enables itself on every reload, and it is a browser-policy fix nobody could
// diagnose remotely. The row is emitted only where a store ACTUALLY threw, and it coalesces per (area, op,
// class, surface), so a blocked profile produces a handful of rows, not a flood.
//
// The negative control names a kind that must NEVER exist: a record whose very shape would carry the typed
// VALUE a validator refused. That is the leak this whole vocabulary is built to make structurally impossible.
ok(!CLIENT_DIAG_KINDS.includes("form-value" as ClientDiagKind), "negative control: form-value is NOT a kind (a typed value can never be a record field)");
if (ENGINE_PRESENT) ok(!engineList("CLIENT_DIAG_KINDS").includes("form-value"), "negative control: the engine does not admit form-value either");
// storage-blocked IS admitted on BOTH sides, which is the drift this suite is really for.
ok(CLIENT_DIAG_KINDS.includes("storage-blocked" as ClientDiagKind), "storage-blocked is a console kind");
if (ENGINE_PRESENT) ok(engineList("CLIENT_DIAG_KINDS").includes("storage-blocked"), "and the engine admits it, so the row is not dropped on arrival");
ok(CLIENT_DIAG_KINDS.includes("renderer-degraded" as ClientDiagKind), "renderer-degraded is a console kind");
if (ENGINE_PRESENT) ok(engineList("CLIENT_DIAG_KINDS").includes("renderer-degraded"), "and the engine admits it");
ok(CLIENT_DIAG_KINDS.includes("focus-landing" as ClientDiagKind), "focus-landing is a console kind");
if (ENGINE_PRESENT) ok(engineList("CLIENT_DIAG_KINDS").includes("focus-landing"), "and the engine admits it");
// And csp-violation IS admitted on BOTH sides, which is the drift this suite is really for: a kind the
// console emits and the engine does not admit is a row the engine drops on arrival.
ok(CLIENT_DIAG_KINDS.includes("csp-violation" as ClientDiagKind), "csp-violation is a console kind");
if (ENGINE_PRESENT) ok(engineList("CLIENT_DIAG_KINDS").includes("csp-violation"), "and the engine admits it, so the row is not dropped on arrival");

// The caps are part of the contract (the engine drops/400s against them), so they are conformance-checked
// exactly like the members.
const CAP_PAIRS: Array<[string, number]> = [
  ["CLIENT_DIAG_PER_KIND_ROW_CAP", CLIENT_DIAG_PER_KIND_ROW_CAP],
  ["CLIENT_DIAG_GLOBAL_ROW_CAP", CLIENT_DIAG_GLOBAL_ROW_CAP],
  ["CLIENT_DIAG_COUNT_MAX", CLIENT_DIAG_COUNT_MAX],
  ["CLIENT_DIAG_MS_MAX", CLIENT_DIAG_MS_MAX],
  ["CLIENT_DIAG_MAX_BODY_BYTES", CLIENT_DIAG_MAX_BODY_BYTES],
];
for (const [name, consoleValue] of CAP_PAIRS) {
  // Cross-repo, like the member lists above: engineNumber reads the engine's own source, so on a
  // console-only runner it has nothing to read and the comparison is skipped by the same loud note.
  if (!ENGINE_PRESENT) continue;
  eq(consoleValue, engineNumber(name), `${name}: console cap == engine cap`);
}

// ---- 2. I2: the record is STRUCTURALLY value-free -----------------------------------------------------
//
// The strongest test in the suite. A customer value is planted at EVERY place a catch site could reach it:
// the request URL, the thrown error's message, the thrown error's NAME, the response body, and extra keys
// bolted onto a pushed record. None of them may appear anywhere in the payload.

section("2. I2: a customer value planted at a catch site never reaches a record");

const SENTINEL = "dp_7f3a-acme-payroll-prod@acme.example.com/secret-bucket";

reset();
setActiveScreen("/downpipes/:id");

// (a) The value is in the URL and in the response body of a failing engine call, driven through the REAL
// engineFetch seam (the C1 emit site) with a stubbed global fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string) =>
  new Response(JSON.stringify({ error: SENTINEL, downpipeId: SENTINEL }), {
    status: 500,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
await engineFetch(`https://engine.example.com/admin/downpipes/${encodeURIComponent(SENTINEL)}`, { method: "GET" });

// (b) The value is in the thrown error's MESSAGE and NAME, which the boot/unhandled path must never carry.
globalThis.fetch = (async () => {
  const e = new TypeError(`Failed to fetch ${SENTINEL}`);
  e.name = SENTINEL;
  throw e;
}) as unknown as typeof fetch;
try {
  await engineFetch(`https://engine.example.com/admin/history?id=${encodeURIComponent(SENTINEL)}`);
} catch {
  // expected: engineFetch rethrows the original rejection verbatim
}
globalThis.fetch = realFetch;

// (c) The value is smuggled as EXTRA KEYS and as non-member values on a directly pushed record.
push({
  kind: "engine-call",
  screen: SENTINEL as unknown as ClientDiagScreen,
  count: 1,
  firstMs: 0,
  lastMs: 0,
} as ClientDiagnosticRecord);
push({
  kind: "engine-call",
  screen: "downpipes",
  httpClass: SENTINEL as unknown as ClientDiagHttpClass,
  count: 1,
  firstMs: 0,
  lastMs: 0,
} as ClientDiagnosticRecord);
push({
  kind: "engine-call",
  screen: "downpipes",
  httpClass: "5xx",
  count: 1,
  firstMs: 0,
  lastMs: 0,
  // extra keys the allowlist projection must never copy
  message: SENTINEL,
  url: SENTINEL,
  stack: SENTINEL,
} as unknown as ClientDiagnosticRecord);

// (d) The value is planted in an UNHANDLED REJECTION: in the message, in the NAME, and in the stack. The
// C5 handler must map it to a frozen faultClass and carry none of the three.
const unhandledErr = new Error(`could not load ${SENTINEL}: 500`);
unhandledErr.name = SENTINEL;
unhandledErr.stack = `Error: ${SENTINEL}\n    at ${SENTINEL} (${SENTINEL}.ts:1:1)`;
noteUnhandledRejection(unhandledErr);
noteWindowError(unhandledErr);

// (e) The value is planted in a CONTRACT-DRIFT emit: the caller may only hand over a class, so a smuggled
// value in the class position must fail the record closed rather than ride.
recordContractDrift(SENTINEL as unknown as "malformed-body");
recordContractDrift("malformed-body"); // and a legitimate one, so the drift kind is genuinely exercised

// (f) The value is planted in a BULK OUTCOME: as the reasonClass (must be dropped) and as the count (a
// customer string where an integer belongs must clamp to 0, never ride as text).
recordBulkOutcome("delete", SENTINEL as unknown as "partial", 3);
recordBulkOutcome("delete", "partial", SENTINEL as unknown as number);
// The third position too: bulkAction is the loop's own discriminator, and a caller that smuggles a value
// through it has to be refused like the other two.
recordBulkOutcome(SENTINEL as unknown as "delete", "partial", 3);

const planted = packPayload();
const serialised = JSON.stringify(planted);

ok(!serialised.includes("acme"), "the sentinel does not appear anywhere in the serialised payload");
ok(!serialised.includes("dp_7f3a"), "no downpipe id fragment appears in the payload");
ok(!serialised.includes("secret-bucket"), "no bucket name appears in the payload");
ok(!serialised.includes("@"), "no email fragment appears in the payload");
ok(!serialised.includes("message"), "no `message` key was copied onto a record");
ok(!serialised.includes("url"), "no `url` key was copied onto a record");
ok(!serialised.includes("stack"), "no `stack` key was copied onto a record");

// Negative control: the sentinel IS distinctive enough that a leak would have been caught (prove the
// assertion above is not vacuous by checking the sentinel is genuinely detectable in a string that has it).
ok(JSON.stringify({ leak: SENTINEL }).includes("acme"), "negative control: the sentinel is detectable when present");

// The records that DID land are the legitimate closed-class ones, and they are complete.
ok(planted.records.length > 0, "the legitimate closed-class records did land (the ring is not simply empty)");

// Field-by-field: EVERY string on EVERY record is a frozen member, and there are NO other string fields.
const ALLOWED_KEYS = new Set([
  "kind", "screen", "httpClass", "faultClass", "driftClass", "reasonClass", "applyClass", "capability", "surface",
  "capabilityOutcome", "bootClass", "buildCheckClass", "rollbackClass", "gateBlockClass", "fieldClass", "anomaly",
  "errorClass", "faultSource", "count", "firstMs", "lastMs",
  // bulkAction is the discriminator that tells a half-failed bulk delete from a half-failed bulk run. This
  // list is maintained by hand, so it must be kept in step with it: a planting call that lands the sentinel
  // in the bulkAction slot by position instead would have both records refused, no bulk outcome would reach
  // the pack, and this gate would never see the field, so section (f) would prove nothing.
  "bulkAction",
]);
const MEMBER_SETS: Record<string, readonly string[]> = {
  kind: CLIENT_DIAG_KINDS,
  bulkAction: CLIENT_DIAG_BULK_ACTIONS,
  screen: CLIENT_DIAG_SCREENS,
  httpClass: CLIENT_DIAG_HTTP_CLASSES,
  faultClass: CLIENT_DIAG_FAULT_CLASSES,
  driftClass: CLIENT_DIAG_DRIFT_CLASSES,
  reasonClass: CLIENT_DIAG_REASON_CLASSES,
  applyClass: CLIENT_DIAG_APPLY_CLASSES,
  capability: CLIENT_DIAG_CAPABILITIES,
  surface: CLIENT_DIAG_SURFACES,
  capabilityOutcome: CLIENT_DIAG_CAPABILITY_OUTCOMES,
  bootClass: CLIENT_DIAG_BOOT_CLASSES,
  buildCheckClass: CLIENT_DIAG_BUILD_CHECK_CLASSES,
  rollbackClass: CLIENT_DIAG_ROLLBACK_CLASSES,
  gateBlockClass: CLIENT_DIAG_GATE_BLOCK_CLASSES,
  fieldClass: CLIENT_DIAG_FIELD_CLASSES,
  anomaly: CLIENT_DIAG_ANOMALIES,
  errorClass: CLIENT_DIAG_ERROR_CLASSES,
  faultSource: CLIENT_DIAG_FAULT_SOURCES,
};

let stringFields = 0;
for (const rec of planted.records) {
  for (const [key, value] of Object.entries(rec)) {
    ok(ALLOWED_KEYS.has(key), `record key "${key}" is one of the frozen keys (no extra key rode along)`);
    if (typeof value === "string") {
      stringFields++;
      const members = MEMBER_SETS[key];
      ok(members?.includes(value) ?? false, `record string field ${key}="${value}" is a frozen union member`);
    } else {
      ok(typeof value === "number" && Number.isInteger(value) && value >= 0, `record numeric field ${key} is a clamped non-negative integer`);
    }
  }
}
ok(stringFields > 0, "the records do carry string fields (so the membership assertions above were exercised)");

// engineAttempts is a plain integer denominator and nothing else.
eq(typeof planted.engineAttempts, "number", "engineAttempts is a number");
ok(Number.isInteger(planted.engineAttempts ?? -1) && (planted.engineAttempts ?? -1) >= 0, "engineAttempts is a non-negative integer");
eq(Object.keys(planted).sort().join(","), "engineAttempts,records", "the payload carries records + engineAttempts and NOTHING else");

// ---- 3. I3: the screen is always a frozen literal ------------------------------------------------------

section("3. I3: screenFromPattern is total and can never echo a customer id");

const PATTERN_EXPECTATIONS: Array<[string, ClientDiagScreen]> = [
  ["/", "overview"],
  ["/downpipes", "downpipes"],
  ["/downpipes/:id", "downpipes"],
  ["/downpipes/:id/edit", "downpipes"],
  ["/runs/:downpipeId/:index", "downpipes"],
  ["/canary", "downpipes"],
  ["/destinations", "destinations"],
  ["/sources", "sources"],
  ["/sources/advanced", "sources"],
  ["/restore", "restore"],
  ["/restore/:runId", "restore"],
  ["/restore/approvals", "restore"],
  ["/keys", "keys"],
  ["/access", "access"],
  ["/access/roles", "access"],
  ["/access/roles/builder", "access"],
  ["/access/audit", "access"],
  ["/access/idp", "idp"],
  ["/notifications", "notifications"],
  ["/notifications/rules", "notifications"],
  ["/integrations", "integrations"],
  ["/security", "security"],
  // THE TWO APPROVAL INBOXES GET THEIR OWN SCREEN. Without this both would fall into the `security` bucket
  // ("/config" and "/security" both map there), and a render throw inside a .then with no .catch is nearly
  // always a TypeError -- so the config-approvals screen frozen on skeleton rows and the owner-approvals
  // screen frozen on skeleton rows would emit the BYTE-IDENTICAL tuple {unhandled, security, other,
  // unhandled-rejection, TypeError} and COALESCE into ONE row with a bumped count, leaving support unable to
  // tell the two screens apart.
  //
  // Each must now resolve to its OWN screen, and the prefixes must be ordered so the specific one wins over its
  // family (the /config/history and /credentials rows below prove the families still fall through correctly).
  ["/security/owner-actions", "owner-actions"],
  ["/config/changes", "config-changes"],
  ["/config/history", "security"],
  ["/credentials", "security"],
  ["/reports", "security"],
  ["/licence", "updates"],
  ["/settings", "settings"],
  ["/onboarding/:step", "boot"],
  ["/passkey", "access"],
  ["/map", "overview"],
  ["/costs", "overview"],
];
for (const [pattern, expected] of PATTERN_EXPECTATIONS) {
  eq(screenFromPattern(pattern), expected, `screenFromPattern("${pattern}")`);
}

// /access/idp must resolve BEFORE the /access family (ordering matters, and a wrong order is a real bug).
ok(screenFromPattern("/access/idp") !== "access", "negative control: /access/idp is NOT swallowed by the /access family");

// TOTALITY: any input at all yields a frozen member. This is the property that makes a leak structurally
// impossible even if a caller passed a concrete path instead of a template.
const HOSTILE_INPUTS: unknown[] = [
  `/downpipes/${SENTINEL}`,
  `/restore/${SENTINEL}?token=${SENTINEL}#${SENTINEL}`,
  `/${SENTINEL}`,
  "",
  "not-a-path",
  "//",
  "/unknown/family",
  null,
  undefined,
  42,
  {},
  [],
];
for (const input of HOSTILE_INPUTS) {
  const out = screenFromPattern(input);
  ok((CLIENT_DIAG_SCREENS as readonly string[]).includes(out), `screenFromPattern(${JSON.stringify(input)}) returns a frozen member (got "${out}")`);
  ok(!out.includes("acme"), `screenFromPattern(${JSON.stringify(input)}) does not echo the sentinel`);
}
eq(screenFromPattern(`/${SENTINEL}`), "unknown-route", "an unrecognised path falls back to unknown-route, never to its own text");
eq(screenFromPattern(`/downpipes/${SENTINEL}`), "downpipes", "a CONCRETE path with a customer id still maps to the frozen family literal, id discarded");

// setActiveScreen stores a frozen literal, never the raw input.
setActiveScreen(`/downpipes/${SENTINEL}`);
eq(currentScreen(), "downpipes", "setActiveScreen stores the mapped frozen literal");
setActiveScreen(`/${SENTINEL}`);
eq(currentScreen(), "unknown-route", "setActiveScreen on an unknown path stores unknown-route, not the path");

// ---- 4. the fault mappers are total and value-free -----------------------------------------------------

section("4. mapper totality (faultClass / httpClass), and no error text is ever read");

for (let status = 100; status <= 599; status++) {
  const fc = faultClassForStatus(status);
  ok((CLIENT_DIAG_FAULT_CLASSES as readonly string[]).includes(fc), `faultClassForStatus(${status}) is a frozen member`);
}
eq(faultClassForStatus(401), "auth", "401 -> auth");
eq(faultClassForStatus(403), "auth", "403 -> auth");
eq(faultClassForStatus(404), "not-found", "404 -> not-found");
eq(faultClassForStatus(409), "conflict", "409 -> conflict");
eq(faultClassForStatus(412), "conflict", "412 -> conflict");
eq(faultClassForStatus(428), "conflict", "428 -> conflict");
eq(faultClassForStatus(429), "rate-limited", "429 -> rate-limited (NOT server: it is recoverable by pacing)");
eq(faultClassForStatus(500), "server", "500 -> server");
eq(faultClassForStatus(503), "server", "503 -> server");
eq(faultClassForStatus(418), "other", "an unmapped 4xx -> other");
ok(faultClassForStatus(429) !== "server", "negative control: 429 does not collapse into server");

eq(httpClassForStatus(400), "4xx", "400 -> 4xx");
eq(httpClassForStatus(499), "4xx", "499 -> 4xx");
eq(httpClassForStatus(500), "5xx", "500 -> 5xx");
eq(httpClassForStatus(599), "5xx", "599 -> 5xx");
eq(httpClassForStatus(200), null, "a 2xx is not a fault (null: nothing is recorded)");
eq(httpClassForStatus(302), null, "a 3xx is not a fault (null)");

// httpClassForRejection: the ONE place a name is consulted. It is compared for EQUALITY against two frozen
// product constants and copied nowhere.
const abortErr = new Error("cancelled");
abortErr.name = "AbortError";
eq(httpClassForRejection(abortErr), "aborted", "an AbortError -> aborted (D5 excludes it from the failing signal)");
const timeoutErr = new Error("timed out");
timeoutErr.name = "TimeoutError";
eq(httpClassForRejection(timeoutErr), "timeout", "a TimeoutError -> timeout");
eq(httpClassForRejection(new TypeError("Failed to fetch")), "network", "a plain fetch TypeError -> network");
const sentinelNamed = new Error(SENTINEL);
sentinelNamed.name = SENTINEL;
eq(httpClassForRejection(sentinelNamed), "network", "an error whose NAME is a customer value -> network (the name is compared, never copied)");
eq(httpClassForRejection("a bare string"), "network", "a non-Error rejection -> network (total)");
eq(httpClassForRejection(undefined), "network", "an undefined rejection -> network (total)");

// An ABORTED call records NO faultClass (it is not a Downpipes fault).
reset();
setActiveScreen("/downpipes");
recordEngineCall("aborted");
const abortedPayload = snapshot();
eq(abortedPayload.records.length, 1, "an aborted call records one row");
eq(abortedPayload.records[0]?.faultClass, undefined, "an aborted call carries NO faultClass");
eq(abortedPayload.records[0]?.httpClass, "aborted", "an aborted call carries httpClass=aborted");

// ---- 5. the caps and the coalescing (D3/D7) ------------------------------------------------------------

section("5. caps: full-tuple coalescing, per-kind 32 newest-wins, global 128, clamped counts, true rollup");

// Coalescing is on the FULL tuple: the same tuple increments a count; a DIFFERENT tuple adds a row.
reset();
setActiveScreen("/downpipes");
for (let i = 0; i < 500; i++) recordEngineCall("5xx", "server");
let snap = snapshot();
eq(snap.records.length, 1, "500 identical faults coalesce into ONE row (not 500 rows)");
eq(snap.records[0]?.count, 500, "the repeat count is 500 (a repeat increments the count, never adds a row)");
ok((snap.records[0]?.lastMs ?? -1) >= (snap.records[0]?.firstMs ?? 0), "lastMs >= firstMs on a coalesced row");

recordEngineCall("4xx", "not-found");
snap = snapshot();
eq(snap.records.length, 2, "a DIFFERENT tuple adds a second row (the key is the full tuple)");

// A different SCREEN is a different tuple too.
setActiveScreen("/restore");
recordEngineCall("5xx", "server");
snap = snapshot();
eq(snap.records.length, 3, "the same fault on a different screen is a different tuple");

// Per-kind row cap: 32, newest-wins. Drive more than 32 DISTINCT tuples of the same kind.
reset();
let tuples = 0;
for (const screen of ["/downpipes", "/restore", "/keys", "/settings", "/notifications", "/integrations", "/security", "/sources"]) {
  setActiveScreen(screen);
  for (const hc of CLIENT_DIAG_HTTP_CLASSES) {
    for (const fc of CLIENT_DIAG_FAULT_CLASSES) {
      recordEngineCall(hc as ClientDiagHttpClass, fc as ClientDiagFaultClass);
      tuples++;
    }
  }
}
ok(tuples > CLIENT_DIAG_PER_KIND_ROW_CAP, `the drive produced ${tuples} distinct tuples, more than the per-kind cap of ${CLIENT_DIAG_PER_KIND_ROW_CAP}`);
snap = snapshot();
eq(snap.records.length, CLIENT_DIAG_PER_KIND_ROW_CAP, `the per-kind row cap holds the ring at ${CLIENT_DIAG_PER_KIND_ROW_CAP} rows`);
ok(snap.records.length <= CLIENT_DIAG_GLOBAL_ROW_CAP, `the ring is within the global cap of ${CLIENT_DIAG_GLOBAL_ROW_CAP}`);

// NEWEST-WINS: the LAST tuple driven must still be present; the FIRST must have been evicted.
const lastTuple = snap.records[snap.records.length - 1];
eq(lastTuple?.screen, "sources", "newest-wins: the most recently seen tuple survived the cap");

// The per-kind true-count rollup survives the eviction (D3): the ring knows how many events it really saw.
const rollup = rollupByKind();
eq(rollup["engine-call"], tuples, `the per-kind uncapped true count is ${tuples}, even though only ${CLIENT_DIAG_PER_KIND_ROW_CAP} rows survived`);
ok((rollup["engine-call"] ?? 0) > snap.records.length, "negative control: the true count EXCEEDS the surviving row count (the rollup is not just the row count)");

// engineAttempts (the D4 denominator) is uncapped by the row caps and counts every attempt.
reset();
for (let i = 0; i < 1000; i++) noteEngineAttempt();
eq(snapshot().engineAttempts, 1000, "engineAttempts counts every attempt (the ratio denominator stays honest)");

// ---- 6. clamps are total (D3/D7) -----------------------------------------------------------------------

section("6. clamps: total over NaN, Infinity, negatives, fractions and non-numbers");

eq(clampInt(12.9), 12, "clampInt truncates a fraction");
eq(clampInt(-5), 0, "clampInt floors a negative to 0");
eq(clampInt(CLIENT_DIAG_MS_MAX + 1000), CLIENT_DIAG_MS_MAX, "clampInt caps a finite overflow at MS_MAX");
eq(clampInt("9999" as unknown as number), 0, "clampInt of a non-number is 0 (never the string)");
eq(clampInt(null), 0, "clampInt(null) is 0");

// A NON-FINITE input (a corrupted clock reading) FAILS CLOSED to 0, exactly like a non-number: it is NOT
// clamped to MS_MAX, because MS_MAX would be a fabricated measurement. This matters across the repo
// boundary: the engine's receiver DROPS a record whose numeric is non-finite (client-diag-receive.ts
// returns undefined for it), so by mapping non-finite to 0 the console guarantees it can never emit a value
// the engine would have to drop. Both sides fail closed; neither coerces a value into existence.
eq(clampInt(Number.NaN), 0, "clampInt(NaN) fails closed to 0");
eq(clampInt(Number.POSITIVE_INFINITY), 0, "clampInt(Infinity) fails closed to 0 (NOT fabricated as MS_MAX)");
eq(clampInt(Number.NEGATIVE_INFINITY), 0, "clampInt(-Infinity) fails closed to 0");

eq(clampNonNegInt(CLIENT_DIAG_COUNT_MAX + 1), CLIENT_DIAG_COUNT_MAX, "clampNonNegInt caps a finite count at COUNT_MAX");
eq(clampNonNegInt(-1), 0, "clampNonNegInt floors a negative count to 0");
eq(clampNonNegInt(Number.NaN), 0, "clampNonNegInt(NaN) fails closed to 0");
eq(clampNonNegInt(Number.POSITIVE_INFINITY), 0, "clampNonNegInt(Infinity) fails closed to 0");
eq(clampNonNegInt(SENTINEL as unknown as number), 0, "clampNonNegInt of a customer STRING is 0 (never the string)");

// The cross-repo consequence, asserted directly: every clamp output is a FINITE integer in range, which is
// precisely the set of values the engine's receiver accepts rather than drops.
for (const hostile of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1e30, 12.9, null, SENTINEL]) {
  const ms = clampInt(hostile as number);
  const count = clampNonNegInt(hostile as number);
  ok(Number.isInteger(ms) && ms >= 0 && ms <= CLIENT_DIAG_MS_MAX, `clampInt(${String(hostile)}) is a finite in-range integer the engine accepts`);
  ok(Number.isInteger(count) && count >= 0 && count <= CLIENT_DIAG_COUNT_MAX, `clampNonNegInt(${String(hostile)}) is a finite in-range integer the engine accepts`);
}

// ---- 7. the offsets are monotonic, not wall-clock -------------------------------------------------------

section("7. firstMs/lastMs are performance.now offsets, not the wall clock");

reset();
setActiveScreen("/downpipes");
const realDateNow = Date.now;
// Move the WALL CLOCK backwards by a year. A wall-clock implementation would produce a negative or
// wildly-shifted offset; a monotonic one is unmoved.
Date.now = () => realDateNow() - 365 * 24 * 3600 * 1000;
recordEngineCall("5xx", "server");
Date.now = realDateNow;
const monoSnap = snapshot();
const row = monoSnap.records[0];
ok(row !== undefined, "a record landed while the wall clock was skewed");
ok((row?.firstMs ?? -1) >= 0, "firstMs is non-negative despite a wall clock jumped a year backwards");
ok((row?.firstMs ?? Number.MAX_SAFE_INTEGER) < 365 * 24 * 3600 * 1000, "firstMs is a session offset, not a wall-clock epoch (a Date.now-based impl would fail here)");
ok((row?.lastMs ?? -1) >= (row?.firstMs ?? 0), "lastMs >= firstMs");

// ---- 8. the POST shape, and the GET that keeps the vendor pull section-free (I1) -------------------------

section("8. POST /admin/support/bundle carries the section; the GET is unchanged (vendor pull stays free of it)");

interface Captured {
  url: string;
  init: RequestInit | undefined;
}
const calls: Captured[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  calls.push({ url, init });
  return new Response("{\"bundle\":true}", { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const fakeTransport = {
  base: "https://engine.example.com",
  headers: () => ({ "content-type": "application/json" }),
  failResponse: async () => {
    throw new Error("unexpected");
  },
} as unknown as Transport;

// (a) No payload: the UNCHANGED GET. This is what makes the vendor bearer-pull and every scheduled build
// structurally incapable of carrying the section (I1) -- there is no body on those paths.
await getSupportBundle(fakeTransport);
eq(calls[0]?.url, "https://engine.example.com/admin/support/bundle", "the bundle route is unchanged");
eq(calls[0]?.init?.method, undefined, "with NO payload the call stays a GET (no method set)");
eq(calls[0]?.init?.body, undefined, "with NO payload the call carries NO body, so no section can be built");

// (b) With a payload: a POST carrying { clientDiagnostics: { records, engineAttempts } }.
reset();
setActiveScreen("/downpipes");
recordEngineCall("5xx", "server");
noteEngineAttempt();
await getSupportBundle(fakeTransport, packPayload());
const posted = calls[1];
eq(posted?.init?.method, "POST", "with a payload the call is a POST");
const body = JSON.parse(String(posted?.init?.body ?? "{}")) as { clientDiagnostics?: { records?: unknown[]; engineAttempts?: number } };
ok(body.clientDiagnostics !== undefined, "the body carries a clientDiagnostics key (the engine's expected wire shape)");
eq(body.clientDiagnostics?.records?.length, 1, "the body carries the ring's records");
eq(typeof body.clientDiagnostics?.engineAttempts, "number", "the body carries the engineAttempts denominator");
eq(Object.keys(body).join(","), "clientDiagnostics", "the body carries clientDiagnostics and NOTHING else");
// The console never asserts provenance or a time: those are engine-stamped (I4).
ok(!("source" in (body.clientDiagnostics ?? {})), "the console never sends `source` (the engine stamps client-asserted)");
ok(!("receivedAt" in (body.clientDiagnostics ?? {})), "the console never sends `receivedAt` (the engine stamps it)");

globalThis.fetch = realFetch;

// ---- 8b. the step-up handshake is NOT a fault -------------------------------------------------------------
//
// The step-up ceremony OPENS with a 401 { stepUpRequired: true }: the engine asking for a fresh passkey
// assertion on a sensitive action. That is a normal protocol handshake, not a failure. If it were recorded,
// every SUCCESSFUL step-up would fabricate an `auth` fault and could drive a false
// console-engine-calls-failing signal. A GENUINE 401 must still be recorded.

section("8b. a successful step-up records no phantom auth fault; a genuine 401 still records one");

const { Transport: RealTransport } = await import("../src/lib/api/client-transport.ts");

// (a) The engine demands step-up, the ceremony succeeds, the retry returns 200. NO fault may be recorded.
reset();
setActiveScreen("/downpipes");
let leg = 0;
globalThis.fetch = (async () => {
  leg++;
  if (leg === 1) return new Response(JSON.stringify({ stepUpRequired: true }), { status: 401, headers: { "content-type": "application/json" } });
  return new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const stepUpTransport = new RealTransport("https://engine.example.com");
stepUpTransport.onStepUpRequired = async () => "a-single-use-step-up-token";
const stepUpRes = await stepUpTransport.gatedFetch("/admin/restore", { method: "POST" });
eq(stepUpRes.status, 200, "the step-up ceremony retried and the call succeeded");
const afterStepUp = snapshot();
eq(afterStepUp.records.length, 0, "a SUCCESSFUL step-up leaves NO fault record (the handshake 401 is not a fault)");
eq(afterStepUp.engineAttempts, 2, "both legs of the ceremony still count as engine attempts (the denominator stays honest)");

// (b) A GENUINE 401 (no step-up handler wired) IS surfaced to the operator, so it MUST be recorded.
reset();
setActiveScreen("/downpipes");
globalThis.fetch = (async () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const plainTransport = new RealTransport("https://engine.example.com");
await plainTransport.gatedFetch("/admin/restore", { method: "POST" });
const afterPlain401 = snapshot();
eq(afterPlain401.records.length, 1, "negative control: a genuine 401 with no ceremony DOES record a fault");
eq(afterPlain401.records[0]?.faultClass, "auth", "the genuine 401 is classed auth");

// (c) The operator CANCELS the ceremony: the original 401 reaches the screen, so it is a real fault.
reset();
setActiveScreen("/downpipes");
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ stepUpRequired: true }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const cancelTransport = new RealTransport("https://engine.example.com");
cancelTransport.onStepUpRequired = async () => null; // the operator cancelled
await cancelTransport.gatedFetch("/admin/restore", { method: "POST" });
eq(snapshot().records.length, 1, "a CANCELLED step-up records the 401 that the screen actually surfaces");

globalThis.fetch = realFetch;

// ---- 9. the body cap (D1) --------------------------------------------------------------------------------

section("9. packPayload never exceeds the engine's pre-parse body cap");

reset();
// Fill the ring to its caps with as many distinct tuples as the vocabulary allows.
for (const screen of ["/downpipes", "/restore", "/keys", "/settings", "/notifications", "/integrations", "/security", "/sources", "/access", "/access/idp", "/licence", "/destinations"]) {
  setActiveScreen(screen);
  for (const hc of CLIENT_DIAG_HTTP_CLASSES) {
    for (const fc of CLIENT_DIAG_FAULT_CLASSES) recordEngineCall(hc as ClientDiagHttpClass, fc as ClientDiagFaultClass);
  }
}
const full = packPayload();
const fullBytes = new TextEncoder().encode(JSON.stringify({ clientDiagnostics: full })).length;
ok(fullBytes <= CLIENT_DIAG_MAX_BODY_BYTES, `a fully-loaded ring serialises to ${fullBytes} bytes, within the engine's ${CLIENT_DIAG_MAX_BODY_BYTES}-byte cap`);
ok(full.records.length <= CLIENT_DIAG_GLOBAL_ROW_CAP, "a fully-loaded ring is within the global row cap");
ok(fullBytes < 20_000, `the worst-case section is small (${fullBytes} bytes, the plan's ~13 KB ceiling)`);

reset();

// ---- 10. C2: contract drift, at the REAL coercion seams ---------------------------------------------------
//
// Each case drives the REAL module (the transport's parse helpers, the downpipe-state mapper, the bulk
// loop), not a re-implementation, and asserts BOTH that the drift is recorded AND that the offending value
// and field name are nowhere in the payload: the class only.

section("10. C2 contract-drift: the class is recorded, the value and the field name never are");

const drifted = (): ClientDiagnosticRecord[] => snapshot().records.filter((r) => r.kind === "contract-drift");
const t = new RealTransport("https://engine.example.com");
const jsonHeaders = { "content-type": "application/json" };

// (a) A 2xx whose body is not the JSON the contract describes, with a customer value inside the body.
reset();
setActiveScreen("/downpipes");
try {
  await t.parseJson(new Response(`not json at all: ${SENTINEL}`, { status: 200, headers: jsonHeaders }), "list downpipes");
} catch {
  // expected: the transport still throws exactly as it did before
}
eq(drifted().length, 1, "a malformed 2xx body records ONE contract-drift record");
eq(drifted()[0]?.driftClass, "malformed-body", "it is classed malformed-body");
eq(drifted()[0]?.screen, "downpipes", "it is attributed to the active screen (a frozen literal)");
ok(!JSON.stringify(snapshot()).includes("acme"), "the offending BODY does not appear in the payload");

// (b) NOISE FILTER: an Access login page served where JSON was expected is a lapsed session, NOT engine
// drift. It is the same class of false positive as the step-up 401 and must record NOTHING.
reset();
setActiveScreen("/downpipes");
try {
  await t.parseJson(new Response("<html><body>Cloudflare Access: sign in</body></html>", { status: 200, headers: jsonHeaders }), "list downpipes");
} catch {
  // expected: the transport throws the access-redirect marker
}
eq(drifted().length, 0, "NOISE FILTER: a lapsed Access session records NO contract drift (a session matter, not drift)");

// (c) Negative control: a well-formed 2xx records nothing at all.
reset();
await t.parseJson(new Response("{\"ok\":true}", { status: 200, headers: jsonHeaders }), "list downpipes");
eq(snapshot().records.length, 0, "negative control: a body that MATCHES the contract records nothing");

// (d) A 202 that says "queued for approval" but does not carry the pending shape: the transport
// THROWS the honest answer-unreadable error rather than silently reading it as APPLIED. The contract-drift
// row is still recorded before the throw, so the class survives even though no fabricated value does.
reset();
setActiveScreen("/settings");
try {
  await t.parseJsonOrPending(new Response(JSON.stringify({ id: SENTINEL }), { status: 202, headers: jsonHeaders }), "set config");
} catch {
  // expected: throws rather than resolving to a false "applied"
}
eq(drifted().length, 1, "the malformed 202 still records ONE contract-drift record before it throws");
eq(drifted()[0]?.driftClass, "missing-field", "it is classed missing-field");
ok(!JSON.stringify(snapshot()).includes("acme"), "the 202 body's id does not appear in the payload");

// (e) Negative control: a WELL-FORMED 202 pending body is the contract working, and records nothing.
reset();
const pending = await t.parseJsonOrPending(new Response(JSON.stringify({ queued: true, id: "chg_1", status: "pending", contentHash: "h1" }), { status: 202, headers: jsonHeaders }), "set config");
eq(pending.status, "pending", "a well-formed 202 resolves to pending");
eq(drifted().length, 0, "negative control: a well-formed 202 records NO drift");

// (f) The owner-action gate: a 202 that is not the OwnerActionQueued shape likewise THROWS rather than
// being coerced to applied; the contract-drift row is still recorded before the throw.
reset();
setActiveScreen("/destinations");
try {
  await t.parseJsonOrOwnerAction(new Response(JSON.stringify({ ownerActionQueued: true }), { status: 202, headers: jsonHeaders }), "set destination");
} catch {
  // expected: throws rather than resolving to a false "result"
}
eq(drifted().length, 1, "a 202 missing the owner-action id still records ONE contract-drift record before it throws");
eq(drifted()[0]?.driftClass, "missing-field", "it is classed missing-field");

reset();
await t.parseJsonOrOwnerAction(new Response(JSON.stringify({ ownerActionQueued: true, id: "oa_1" }), { status: 202, headers: jsonHeaders }), "set destination");
eq(drifted().length, 0, "negative control: a well-formed owner-action 202 records NO drift");

// (g) An UNKNOWN ENUM MEMBER from the engine, coerced by the downpipe-state mapper into "not deferred".
reset();
setActiveScreen("/downpipes");
mapEngineDownpipeState({
  config: { id: SENTINEL, name: SENTINEL, cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: SENTINEL, include: [], exclude: [] } },
  lastRestoreTestDeferred: SENTINEL as unknown as "no-run",
} as never);
eq(drifted().length, 1, "an unrecognised member of a closed engine enum records ONE contract-drift record");
eq(drifted()[0]?.driftClass, "unknown-enum", "it is classed unknown-enum");
ok(!JSON.stringify(snapshot()).includes("acme"), "the unrecognised VALUE is nowhere in the payload (only the class travels)");

reset();
mapEngineDownpipeState({
  config: { id: "dp", name: "dp", cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: "b", include: [], exclude: [] } },
  lastRestoreTestDeferred: "posture",
} as never);
eq(drifted().length, 0, "negative control: a KNOWN member records no drift");
reset();
mapEngineDownpipeState({
  config: { id: "dp", name: "dp", cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: "b", include: [], exclude: [] } },
} as never);
eq(drifted().length, 0, "negative control: an ABSENT deferral (the normal case) records no drift");

// (h) VERSION SKEW: this console knows POST /admin/downpipes/bulk and the engine's router does not, so the
// loop silently falls back to the per-item create and nobody learns the two components have skewed.
reset();
setActiveScreen("/sources");
const item = (label: string): BulkCreateItem => ({
  dp: { id: label, name: label, cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: label, include: [], exclude: [] } } as Downpipe,
  label,
});
const olderEngine: BulkCreatePoster = {
  bulk: () => Promise.reject(new Error("bulk add downpipes: 404")),
  single: () => Promise.resolve({ status: "applied", value: {} }),
};
const skewOutcome = await runBulkCreate(olderEngine, [item(SENTINEL), item(`${SENTINEL}-2`)]);
eq(skewOutcome.done, 2, "the fallback still created every downpipe (behaviour unchanged)");
eq(drifted().length, 1, "the missing bulk route records ONE contract-drift record");
eq(drifted()[0]?.driftClass, "version-skew", "it is classed version-skew");
ok(!JSON.stringify(snapshot()).includes("acme"), "no binding name from the batch appears in the payload");

// ---- 11. C3: bulk outcomes, counts only, never an item identity --------------------------------------------

section("11. C3 bulk-outcome: reasonClass + counts, never an item name or reason");

const bulked = (): ClientDiagnosticRecord[] => snapshot().records.filter((r) => r.kind === "bulk-outcome");

// The classifier the failures dialog uses is total and reads only two integers.
eq(bulkReasonForCounts(0, 5), "all-failed", "nothing succeeded -> all-failed");
eq(bulkReasonForCounts(3, 5), "partial", "some succeeded -> partial");
eq(bulkReasonForCounts(5, 0), "all-failed", "no failures at all is never reported as partial (the dialog does not open)");
for (const [d, f] of [
  [0, 0],
  [-1, -1],
  [Number.NaN, Number.NaN],
  [1e30, 1e30],
] as Array<[number, number]>) {
  ok((CLIENT_DIAG_REASON_CLASSES as readonly string[]).includes(bulkReasonForCounts(d, f)), `bulkReasonForCounts(${d}, ${f}) is a frozen member (total)`);
}

// A session expiry mid-batch: the remainder was never attempted, and the count says how many.
reset();
setActiveScreen("/sources");
const haltingEngine: BulkCreatePoster = {
  bulk: () => Promise.reject(new Error("bulk add downpipes: 401")),
  single: () => Promise.resolve({ status: "applied", value: {} }),
};
const halted = await runBulkCreate(haltingEngine, [item(SENTINEL), item(`${SENTINEL}-2`), item(`${SENTINEL}-3`)]);
ok(halted.halted, "the loop halted on the session expiry (behaviour unchanged)");
eq(bulked().length, 1, "a halted batch records ONE bulk-outcome record");
eq(bulked()[0]?.reasonClass, "auth", "a session expiry mid-batch is classed auth");
eq(bulked()[0]?.count, 3, "the count is the number of items that did not complete");
eq(bulked()[0]?.screen, "sources", "it is attributed to the active screen");
ok(!JSON.stringify(snapshot()).includes("acme"), "no item label from the halted batch appears in the payload");

// Per-item failures inside the engine's 200 bulk response: invisible to the engine-call kind (the call
// SUCCEEDED), and today visible only in a dialog the operator dismisses.
reset();
setActiveScreen("/sources");
const partialEngine: BulkCreatePoster = {
  bulk: (dps) =>
    Promise.resolve({
      results: dps.map((_d, i) => (i === 0 ? { status: "applied" as const } : { status: "error" as const, error: `refused: ${SENTINEL}` })),
    } as never),
  single: () => Promise.resolve({ status: "applied", value: {} }),
};
const partial = await runBulkCreate(partialEngine, [item("a"), item(SENTINEL), item(`${SENTINEL}-2`)]);
eq(partial.failures.length, 2, "the loop reported the per-item failures (behaviour unchanged)");
// The dialog is the emit seam and needs a DOM, so the classification + emit it performs is driven directly.
recordBulkOutcome("create", bulkReasonForCounts(partial.done, partial.failures.length), partial.failures.length);
eq(bulked().length, 1, "a partially-failed batch records ONE bulk-outcome record");
eq(bulked()[0]?.reasonClass, "partial", "one item succeeded, so it is classed partial");
eq(bulked()[0]?.count, 2, "the count is the number of failed items");
const bulkSerialised = JSON.stringify(snapshot());
ok(!bulkSerialised.includes("acme"), "no failed ITEM NAME appears in the payload");
ok(!bulkSerialised.includes("refused"), "no per-item engine REASON appears in the payload");

// A hostile reasonClass fails the record CLOSED (dropped whole, never coerced to a neighbour).
reset();
recordBulkOutcome("create", SENTINEL as unknown as "partial", 4);
eq(bulked().length, 0, "a non-member reasonClass DROPS the record (never coerced to a member)");

// ---- 12. C5: boot + unhandled, and the noise filters that make them worth anything -------------------------

section("12. C5 boot-fault / unhandled: the noise filters (D5), and no error text ever travels");

// NOISE FILTER 1: an aborted request. A route change or an unmount cancels every in-flight fetch, and the
// abort surfaces here. It is the console working as designed, so NOTHING may be recorded.
const domAbort = { name: "AbortError", message: `cancelled ${SENTINEL}` }; // a DOMException-shaped rejection
const errAbort = new Error("The user aborted a request.");
errAbort.name = "AbortError";
ok(isNavigationCancelled(domAbort), "a DOMException-shaped AbortError is recognised (it is NOT an Error instance)");
ok(isNavigationCancelled(errAbort), "an Error-shaped AbortError is recognised");
ok(!isNavigationCancelled(new Error("list downpipes: 500")), "negative control: a genuine 500 is NOT navigation-cancelled");

reset();
setActiveScreen("/downpipes");
eq(noteUnhandledRejection(domAbort), false, "NOISE FILTER: an aborted fetch records NOTHING (a route change is not a fault)");
eq(noteUnhandledRejection(errAbort), false, "NOISE FILTER: an Error-shaped abort records nothing either");
eq(noteWindowError(errAbort), false, "NOISE FILTER: an abort on the error channel records nothing");
eq(snapshot().records.length, 0, "the ring is EMPTY after the aborts (the filters are the whole point of D5)");

// NOISE FILTER 2: a cross-origin script error. A browser extension that throws reaches window.onerror as an
// opaque "Script error." with NO error object, as does a failed resource load. Neither is Downpipes.
reset();
eq(noteWindowError(null), false, "NOISE FILTER: an error event with NO error object records nothing (extension noise)");
eq(noteWindowError(undefined), false, "NOISE FILTER: an undefined error records nothing");
eq(noteWindowError("Script error."), false, "NOISE FILTER: the opaque cross-origin `Script error.` records nothing");
eq(noteWindowError({ message: SENTINEL }), false, "NOISE FILTER: a bare object is not an uncaught console fault");
eq(snapshot().records.length, 0, "the ring is EMPTY after the browser noise");

// The genuine article IS recorded, as a class and nothing more.
reset();
setActiveScreen("/restore");
eq(noteUnhandledRejection(new Error("start restore: 500")), true, "a genuine unhandled rejection IS recorded");
let unhandledRecs = snapshot().records.filter((r) => r.kind === "unhandled");
eq(unhandledRecs.length, 1, "it records ONE unhandled record");
eq(unhandledRecs[0]?.faultClass, "server", "a 5xx rejection is classed server");
eq(unhandledRecs[0]?.screen, "restore", "it is attributed to the active screen");

reset();
eq(noteUnhandledRejection(new Error("whoami: 401")), true, "a 401 rejection is recorded");
unhandledRecs = snapshot().records.filter((r) => r.kind === "unhandled");
eq(unhandledRecs[0]?.faultClass, "auth", "a 401 rejection is classed auth");

// faultClassForError is TOTAL and reads the message for a NUMBER only, never for text.
for (const err of [
  new Error(`${SENTINEL}: 404`),
  new Error(`${SENTINEL}: 429`),
  new Error(`${SENTINEL}: 409`),
  new Error(SENTINEL),
  new TypeError("Failed to fetch"),
  new Error("get status: access-redirect"),
  new Error("get status: html-body-not-json"),
  SENTINEL,
  null,
  undefined,
  42,
  {},
]) {
  const fc = faultClassForError(err);
  ok((CLIENT_DIAG_FAULT_CLASSES as readonly string[]).includes(fc), `faultClassForError(${String(err)}) is a frozen member (total)`);
  ok(!fc.includes("acme"), "faultClassForError never echoes the error text");
}
eq(faultClassForError(new Error("x: 404")), "not-found", "a 404 rejection is classed not-found");
eq(faultClassForError(new Error("x: 429")), "rate-limited", "a 429 rejection is classed rate-limited");
eq(faultClassForError(new Error("get status: access-redirect")), "auth", "a lapsed Access session is classed auth");
eq(faultClassForError(new TypeError("Failed to fetch")), "other", "a status-less throw is `other`, NOT transport (the engine-call seam owns transport, and calling this transport would double-count it)");

// A boot fault carries the frozen `boot` sentinel, never a location read.
reset();
setActiveScreen(`/downpipes/${SENTINEL}`); // even with a screen resolved, boot records `boot`
const { recordBootFault } = await import("../src/lib/client-diag/ring.ts");
recordBootFault(faultClassForError(new Error(`boot failed ${SENTINEL}`)));
const bootRecs = snapshot().records.filter((r) => r.kind === "boot-fault");
eq(bootRecs.length, 1, "a boot fault records ONE boot-fault record");
eq(bootRecs[0]?.screen, "boot", "a boot fault is attributed to the frozen `boot` sentinel");
ok(!JSON.stringify(snapshot()).includes("acme"), "the boot error's text is nowhere in the payload");

reset();

// ---- summary --------------------------------------------------------------------------------------------


// ---- 13. EVERY CLOSED FIELD SURVIVES THE RING AND REACHES THE PACK (the projection guard) ----------------
//
// This is the test that was missing, and its absence cost seven gaps. push() and snapshot() each rebuild the
// record by ALLOWLIST PROJECTION rather than by spreading the candidate, which is what makes a smuggled key
// structurally impossible. The cost is that a field the vocabulary declares, the tuple key coalesces on and a
// recorder sets, but which NEITHER projection lists, is silently DROPPED on its way into the ring, and then
// again on its way into the pack. Nothing fails. The row still arrives. It just cannot say anything.
//
// That is precisely what had happened: transportClass, callClass, obStep, obOutcome, discoveryOutcome and
// claimResult were declared, keyed and recorded, and absent from both projections, so an `origin-rejected`
// transport fault (a CORS setup step on a healthy engine) and an `engine-unreachable` one (an outage) both
// reached the pack as {kind:"transport-fault", screen, count:1} -- byte-identical, and the exact pair the row
// exists to separate. The gaps read as closed and were not.
//
// So: drive EVERY recorder, and assert the discriminator it was called with is present in snapshot(). A new
// recorder whose field is missing from a projection fails here rather than in a customer's support pack.
section("13. every recorder's discriminator survives push() and snapshot() into the pack");

reset();
setActiveScreen("security");
recordTransportFault("origin-rejected");
recordTransportFault("engine-unreachable");
recordReadDegraded("control-plane-status", new TypeError("network"));
recordOnboardingStep("readiness-poll", "poll-exhausted");
recordDiscoveryConnect("listing-errors");
recordClaimExchange("http-5xx");
recordCapabilityFault("blob-download", "recovery-codes", "refused");
recordAdminWrite("update-rollback", "server-error");
recordRecoveryRefusal("estate-import", "DP-R12");

const projected = snapshot().records;
const has = (pred: (r: ClientDiagnosticRecord) => boolean, what: string): void => ok(projected.some(pred), what);

has((r) => r.kind === "transport-fault" && r.transportClass === "origin-rejected", "transportClass origin-rejected reaches the pack");
has((r) => r.kind === "transport-fault" && r.transportClass === "engine-unreachable", "transportClass engine-unreachable reaches the pack");
has((r) => r.kind === "read-degraded" && r.callClass === "control-plane-status", "callClass reaches the pack");
has((r) => r.kind === "onboarding-step" && r.obStep === "readiness-poll" && r.obOutcome === "poll-exhausted", "obStep/obOutcome reach the pack");
has((r) => r.kind === "discovery-connect" && r.discoveryOutcome === "listing-errors", "discoveryOutcome reaches the pack");
has((r) => r.kind === "claim-exchange" && r.claimResult === "http-5xx", "claimResult reaches the pack");
has((r) => r.kind === "capability-fault" && r.capability === "blob-download" && r.surface === "recovery-codes", "capability/surface reach the pack");
has((r) => r.kind === "admin-write" && r.adminOp === "update-rollback" && r.writeOutcome === "server-error", "adminOp/writeOutcome reach the pack");
has((r) => r.kind === "recovery-refusal" && r.recoveryOp === "estate-import" && r.recoveryCode === "DP-R12", "recoveryOp/recoveryCode reach the pack");

// The CORS block and the outage are TWO rows, and each says which it is. That is the whole point.
const tf = projected.filter((r) => r.kind === "transport-fault");
eq(tf.length, 2, "a CORS block and an outage are two DISTINCT rows, not one coalesced mystery");

// ---- 14. admin-write: the privileged write, and how it ended -----------------------------------------------
section("14. admin-write: the privileged write, and how it ended");

// The status mapper is total and reads ONE integer. It never sees a body, a header or a refusal sentence.
eq(writeOutcomeForStatus(200), "applied", "2xx -> applied");
eq(writeOutcomeForStatus(202), "applied", "202 (queued for a second owner) -> applied: the engine took it");
eq(writeOutcomeForStatus(400), "refused-validation", "400 -> refused-validation");
eq(writeOutcomeForStatus(403), "denied-role", "403 -> denied-role");
eq(writeOutcomeForStatus(409), "conflict", "409 -> conflict");
eq(writeOutcomeForStatus(429), "rate-limited", "429 -> rate-limited");
eq(writeOutcomeForStatus(500), "server-error", "5xx -> server-error");

// NOISE DISCIPLINE. A healthy console must write NO admin-write row: a successful save is already an engine
// audit event, and filling the ring with good news would evict the refusals underneath it (the per-kind cap is
// newest-wins). The exception is the handful of ops where "did it actually apply" IS the ticket.
reset();
setActiveScreen("security");
recordAdminWrite("approval-policy-set", "applied");
recordAdminWrite("notify-rule-upsert", "applied");
recordAdminWrite("source-attach", "applied");
eq(snapshot().records.length, 0, "a SUCCESSFUL ordinary admin write records nothing: no cry-wolf, no cap pressure");

reset();
recordAdminWrite("terminate-all-sessions", "applied");
recordAdminWrite("recovery-codes-regenerate", "applied");
recordAdminWrite("update-rollback", "applied");
eq(snapshot().records.length, 3, "the ops whose SUCCESS is the question record it, so an ABSENT row means something");
eq(ADMIN_OPS_RECORDING_SUCCESS.size, 8, "exactly eight ops record their success");
// The offboarding IdP-cleanup attestation is one of them, and it is the one op whose whole purpose is to
// PROVE a control was in force. A compliance review asks whether the attestation was recorded for a departed
// employee, so an absent `applied` row is the proof's absence, and it is the answer.
reset();
recordAdminWrite("idp-cleanup-attest", "applied");
eq(snapshot().records.length, 1, "an APPLIED IdP-cleanup attestation is recorded (the proof the control was in force)");

// DISCRIMINATION. The compromise ticket is "Sign out everyone errored; are the sessions actually dead?" A
// terminate that APPLIED and one the engine 500'd must not be one row, and a refused offboarding must not be
// the same row as a refused dual-control toggle on the same screen.
reset();
setActiveScreen("access");
recordAdminWrite("terminate-all-sessions", "applied");
recordAdminWrite("terminate-all-sessions", "server-error");
recordAdminWrite("role-delete", "refused-validation");
recordAdminWrite("approval-policy-set", "refused-validation");
const aw = snapshot().records.filter((r) => r.kind === "admin-write");
eq(aw.length, 4, "four distinct privileged-write outcomes are four rows, not one");
ok(
  aw.some((r) => r.adminOp === "terminate-all-sessions" && r.writeOutcome === "applied") &&
    aw.some((r) => r.adminOp === "terminate-all-sessions" && r.writeOutcome === "server-error"),
  "a terminate that applied and one that failed are TOLD APART (are the sessions dead?)",
);
ok(
  aw.some((r) => r.adminOp === "role-delete") && aw.some((r) => r.adminOp === "approval-policy-set"),
  "a refused offboarding and a refused dual-control toggle are TOLD APART",
);

// A repeat of the same tuple coalesces into a COUNT: "the rollback was refused five times" is one row, five.
reset();
for (let i = 0; i < 5; i++) recordAdminWrite("update-rollback", "denied-role");
const rb = snapshot().records.filter((r) => r.kind === "admin-write");
eq(rb.length, 1, "five identical refusals coalesce to one row");
eq(rb[0]?.count, 5, "...with a count of five");

// A write that never reached the engine is `unreachable`, and that is the leg the engine can never hold: it
// never saw the request. An ABORTED call is not one (a navigation cancelled it; not a Downpipes fault).
reset();
recordAdminWriteThrown("update-settle", new TypeError("Failed to fetch"));
eq(snapshot().records[0]?.writeOutcome, "unreachable", "a write the engine never saw is `unreachable`");
reset();
const aborted = new Error("aborted");
aborted.name = "AbortError";
recordAdminWriteThrown("update-settle", aborted);
eq(snapshot().records.length, 0, "an ABORTED write is not a fault and records nothing");

// The dry-run seams must name NO op: the apply plan preview and the rollback plan read share a mutating route,
// and an older engine refuses the rollback plan read on every healthy rollback confirm. Recording that would put
// a phantom rollback failure in the pack of every customer who rolled back successfully.
const updateSrc = readFileSync(join(HERE, "..", "src", "lib", "api", "client-update.ts"), "utf8");
ok(
  /rollbackPlan[\s\S]*?dryRun: true[\s\S]*?\}\);/.test(updateSrc) && !/rollbackPlan[\s\S]*?adminOp/.test(updateSrc.slice(updateSrc.indexOf("export async function rollbackPlan"), updateSrc.indexOf("export async function settleUpdate"))),
  "rollbackPlan (the DRY-RUN plan read) names no adminOp: a refused plan read is not a rollback the operator lost",
);

// ---- 15. recovery-refusal: the disaster-recovery flows, where the browser may be the only witness -----------
section("15. recovery-refusal: the disaster-recovery flows, where the browser may be the only witness");

// The pack's code vocabulary IS the one the operator is reading on screen. If they diverge, the customer quotes
// a code the pack does not contain.
eq(
  [...CLIENT_DIAG_RECOVERY_CODES].sort().join(","),
  [...RECOVERY_REFUSAL_CODES].sort().join(","),
  "the pack's recovery codes are EXACTLY the codes stamped into the operator's on-screen refusal",
);

// A browser-side parse rejection and an engine-side token refusal are different rows, and a reconcile and an
// import that hit the same gate are different rows. Both distinctions are the ticket.
reset();
setActiveScreen("overview");
recordRecoveryRefusal("estate-import", "DP-R02");
recordRecoveryRefusal("estate-import", "DP-R12");
recordRecoveryRefusal("cp-restore", "DP-R12");
recordRecoveryRefusal("cp-restore", "DP-R10");
recordRecoveryRefusal("export-download", "DP-R14");
const rr = snapshot().records.filter((r) => r.kind === "recovery-refusal");
eq(rr.length, 5, "five distinct recovery refusals are five rows");
ok(
  rr.some((r) => r.recoveryOp === "estate-import" && r.recoveryCode === "DP-R12") &&
    rr.some((r) => r.recoveryOp === "cp-restore" && r.recoveryCode === "DP-R12"),
  "the SAME code on an import and on a reconcile are told apart (they are different tickets)",
);
ok(
  rr.some((r) => r.recoveryCode === "DP-R02"),
  "a browser-side parse rejection reaches the pack: the engine can NEVER have a record of it",
);

// ---- THE DISCRIMINATION TESTS -------------------------------------------------------------------------------
//
// Each of these drives the STATES that would otherwise be indistinguishable and asserts they produce DIFFERENT
// rows. Asserting merely that "a row was recorded" is not sufficient: a recorder, a caller and a projection are
// not a closed gap if two states still coalesce into one row.

section("a blocked browser store says WHICH store, WHY, and WHAT the customer lost");

reset();
setActiveScreen("sources");

// The classifier is the no-custody boundary: it reads the exception to SELECT a member and returns the member.
const secErr = new Error("localStorage is not available in this context"); secErr.name = "SecurityError";
const quotaErr = new Error("The quota has been exceeded"); quotaErr.name = "QuotaExceededError";
eq(storageClassFor(secErr), "denied", "a SecurityError is classified as a POLICY denial (a browser policy to change)");
eq(storageClassFor(quotaErr), "quota-exceeded", "a QuotaExceededError is classified as a FULL store (site data to clear)");
eq(storageClassFor(new TypeError("sessionStorage is undefined")), "unavailable", "an absent API is classified as unavailable");
eq(storageClassFor({ nope: true }), "other", "the classifier is TOTAL: an unplaceable throw is `other`, never a guess");
ok(storageClassFor(new Error("example-secret-51H8xQe token=abcdef bucket=acme-backups")) === "other", "the classifier returns a MEMBER, never the message");

// THE STATES THE GAP NAMES. A locked-down profile, a full store, and each of the three symptoms the customer
// reports in one breath (a lost wizard draft, an engine URL that will not stick, an auto-refresh that
// re-enables itself against a motion pause). Every one must be a DIFFERENT row.
recordStorageBlocked("session", "write", "draft", secErr); // the lost wizard
recordStorageBlocked("session", "write", "draft", quotaErr); // the SAME surface, a different cause
recordStorageBlocked("local", "write", "engine-url", secErr); // "we must re-point at our engine every refresh"
recordStorageBlocked("local", "read", "refresh-pref", secErr); // the motion pause that will not stay paused
recordStorageBlocked("local", "read", "engine-url", secErr); // the READ half of the engine-url fault
const sb = snapshot().records.filter((r) => r.kind === "storage-blocked");
eq(sb.length, 5, "five distinct storage faults are FIVE rows, not one row with a count of five");
ok(
  sb.some((r) => r.storageSurface === "draft" && r.storageClass === "denied") &&
    sb.some((r) => r.storageSurface === "draft" && r.storageClass === "quota-exceeded"),
  "a draft lost to a browser POLICY and a draft lost to a FULL store are told apart (two different remedies)",
);
ok(
  sb.some((r) => r.storageSurface === "engine-url" && r.storageArea === "local") &&
    sb.some((r) => r.storageSurface === "refresh-pref"),
  "a forgotten engine URL and an un-pausable auto-refresh are told apart (two different tickets)",
);
ok(
  sb.some((r) => r.storageSurface === "engine-url" && r.storageOp === "read") &&
    sb.some((r) => r.storageSurface === "engine-url" && r.storageOp === "write"),
  "the READ half and the WRITE half of the engine-url fault are told apart (only the write loses the setting)",
);
// THE COALESCER IS THE RECURRING TRAP: a field outside the tuple key discriminates nothing.
recordStorageBlocked("session", "write", "draft", secErr);
const sb2 = snapshot().records.filter((r) => r.kind === "storage-blocked");
eq(sb2.length, 5, "a REPEAT of the same closed tuple increments a count rather than adding a row");
eq(sb2.find((r) => r.storageSurface === "draft" && r.storageClass === "denied")?.count, 2, "and the count is the repeat");
// Negative control: the draft KEY and the stored VALUE never ride (a draft id can carry a run id).
ok(
  JSON.stringify(snapshot()).indexOf("run-ledger") === -1 && JSON.stringify(snapshot()).indexOf("acme-backups") === -1,
  "no key, no value and no message from a storage fault appears anywhere in the payload",
);

section("the map's renderer says WHICH renderer was live and WHY it was not the full one");

reset();
setActiveScreen("overview");

// THE STATES THE GAP NAMES, driven through the PURE classifier: a browser that refused the canvas, an
// extension that froze the animation loop, a frozen CSS layer, an accessibility setting the operator chose,
// and a healthy live view. Five states, five DIFFERENT causes.
eq(classifyRenderer({ mode: "svg-fallback", animation: "static-frame", raf: "ticking", cssAnim: "advancing", everHidden: false }), "canvas-blocked", "a refused canvas is canvas-blocked");
eq(classifyRenderer({ mode: "canvas2d", animation: "animated", raf: "frozen", cssAnim: "advancing", everHidden: false }), "raf-frozen", "a live canvas whose loop never ticks is raf-frozen (the hung map)");
eq(classifyRenderer({ mode: "canvas2d", animation: "animated", raf: "unavailable", cssAnim: "advancing", everHidden: false }), "raf-frozen", "an ABSENT rAF is the same dead map and the same remedy");
eq(classifyRenderer({ mode: "canvas2d", animation: "animated", raf: "ticking", cssAnim: "frozen", everHidden: false }), "css-anim-frozen", "a ticking loop over a frozen CSS layer is its own cause");
eq(classifyRenderer({ mode: "canvas2d", animation: "static-frame", raf: "ticking", cssAnim: "none", everHidden: false }), "reduced-motion", "a static frame the OPERATOR asked for is reduced-motion, NOT a browser fault");
eq(classifyRenderer({ mode: "canvas2d", animation: "animated", raf: "ticking", cssAnim: "advancing", everHidden: false }), "none", "a healthy live view is recorded as healthy, so the pack can SAY it was healthy");
// THE STATE THAT MADE raf-frozen UNREADABLE (R2): a HIDDEN document suspends requestAnimationFrame while the
// freeze guard's setTimeout keeps running, so an ordinary backgrounded tab read as the gap's own headline fault.
// It is its own cause now. The visibility watch and the probes are driven in validate-support-posture-gaps-6.ts.
eq(classifyRenderer({ mode: "canvas2d", animation: "animated", raf: "frozen", cssAnim: "advancing", everHidden: true }), "unobserved", "a healthy map that mounted in a BACKGROUND TAB is unobserved, not a frozen loop");
// NOISE: reduced motion runs no animation loop, so a frozen rAF reading under it is meaningless and must never
// manufacture a fault on the commonest accessibility configuration in the estate.
eq(classifyRenderer({ mode: "canvas2d", animation: "static-frame", raf: "frozen", cssAnim: "frozen", everHidden: false }), "reduced-motion", "under reduced motion a frozen loop is NOT reported as a fault (there is no loop to freeze)");

recordRendererState("svg-fallback", "canvas-blocked");
recordRendererState("canvas2d", "raf-frozen");
recordRendererState("canvas2d", "reduced-motion");
recordRendererState("canvas2d", "none");
const rd = snapshot().records.filter((r) => r.kind === "renderer-degraded");
eq(rd.length, 4, "a blocked canvas, a frozen loop, a reduced-motion frame and a healthy view are FOUR rows");
ok(
  rd.some((r) => r.rendererMode === "svg-fallback" && r.degradeCause === "canvas-blocked") &&
    rd.some((r) => r.rendererMode === "canvas2d" && r.degradeCause === "reduced-motion"),
  "'the map is a static diagram' from a BLOCKED canvas and from the operator's OWN motion setting are told apart",
);
ok(rd.some((r) => r.degradeCause === "none"), "and a healthy renderer is in the pack, so a frozen map and an unopened map are not the same absence");

section("where keyboard focus landed after a tab activation that IS a navigation");

reset();
setActiveScreen("keys");

// THE READER IS DRIVEN, not the recorder alone. takePostNavigationFocus is the console's OWN computation of
// the fact the pack was missing, and until this landed it collapsed two genuinely different states into one
// null: nothing was declared (the ordinary route change, focus belongs on <main>) and something WAS declared
// and was not mounted when the shell read it (the defect: the tab moved, focus fell back to <main>, and every
// further arrow key does nothing). Those two are what a keyboard-trapped operator and a healthy one look like.
eq(takePostNavigationFocus().state, "none", "no screen declared an intent: `none`, and the shell focuses <main>, which is correct");

// The two elements are stand-ins carrying only the property the reader actually consults (isConnected).
// This suite runs in plain node with no DOM, and using a real element would test jsdom rather than the
// branch: the reader's whole job is to ask whether the named node is connected, and that is what is driven.
const mounted = { isConnected: true } as unknown as HTMLElement;
const neverMounted = { isConnected: false } as unknown as HTMLElement;
requestPostNavigationFocus(() => mounted);
const honoured = takePostNavigationFocus();
eq(honoured.state, "honoured", "a declared control that IS mounted is honoured");
ok(honoured.el === mounted, "and the reader hands back the element itself, so the shell focuses the tab and not <main>");

// THE DEFECT, driven: a declaration whose element was never connected. This is the regression sentinel for a
// repair whose failure mode is a RACE (the shell's swap-and-focus runs in a later task than the render that
// scheduled the declaration), so it can come back from a change to the view transition and never from a change
// to the tablist itself.
requestPostNavigationFocus(() => neverMounted);
const detached = takePostNavigationFocus();
eq(detached.state, "detached", "a declared control that was NOT mounted is detached, which is the keyboard trap");
ok(detached.el === null, "and it carries no element, so the shell falls back to <main> exactly as it did before");

// The intent is consumed once, so a stale declaration can never park focus on the NEXT navigation.
eq(takePostNavigationFocus().state, "none", "the declaration is consumed once and cannot leak forward");

reset();
setActiveScreen("keys");
recordFocusLanding("honoured");
recordFocusLanding("dropped-detached");
recordFocusLanding("consumed-quiet");
const fl = snapshot().records.filter((r) => r.kind === "focus-landing");
eq(fl.length, 3, "the three landings are three rows, not one");
ok(fl.some((r) => r.focusOutcome === "dropped-detached"), "the keyboard trap reaches the pack as its own outcome");
ok(
  fl.some((r) => r.focusOutcome === "honoured"),
  "and the HEALTHY landing is in the pack too, so a broken tablist and a tablist the customer never touched are not the same absence",
);
ok(fl.some((r) => r.focusOutcome === "consumed-quiet"), "a quiet re-render that ate the declaration is told apart from a mount race, because the remedy differs");
// I2: the row carries no element, id, label, accessible name or key -- only the kind, the closed outcome and
// the screen literal. Asserted structurally rather than by eye.
// Two steps the checker needs and the assertion does not lose anything to. `fl[0]` is
// ClientDiagnosticRecord | undefined under noUncheckedIndexedAccess, and ClientDiagnosticRecord is a closed
// record type with no string index signature, so the direct cast is refused on both counts. `?? {}` keeps
// the absent case LOUD rather than papering over it: an empty object's key list is "", which is not the
// expected list, so the eq below fails exactly as it should if the row never arrived.
const flRow = (fl[0] ?? {}) as unknown as Record<string, unknown>;
eq(
  Object.keys(flRow).sort().join(","),
  "count,firstMs,focusOutcome,kind,lastMs,screen",
  "a focus-landing row is the kind, the closed outcome, the screen literal and two clamped integers, and nothing else",
);

section("a refused form field says WHICH control refused");

reset();
setActiveScreen("keys");

// THE STATES THE GAP NAMES: "the form will not accept my X" and "the split button stays disabled". The refusal
// happens entirely in the browser (no request is made), so the engine can never hold a record of any of it.
//
// The rows below are pushed by hand to assert the RING's coalescing and shape. That is all they prove, and it is
// deliberately not the claim: the PRODUCERS -- the real cron control, the real timezone control, the real setup
// screen, the real destination form, the real custody pickers, the real SAML and IdP forms -- are driven through
// their own entry points in validate-support-posture-gaps-6.ts, because the cron's refusal never reached this
// funnel at all until that work landed, and the three DIRECT recorder call sites were writing a `rejected` row
// for an EMPTY box until R5.
//
// Each one passes A VALUE, because recordFormRefused cannot write a row without one: the emptiness rule is the
// recorder's now, not each caller's. The value is read only to test whether it is empty; it is never stored, and
// the redaction sweep below re-proves that none of them is anywhere in the payload.
recordFormRefused("custody-split-n", "3");
recordFormRefused("custody-split-threshold", "9");
recordFormRefused("dp-sched-cron", "0 2 * *");
const fr = snapshot().records.filter((r) => r.kind === "form-rejected");
eq(fr.length, 3, "three refused controls are three rows");
ok(
  fr.some((r) => r.formField === "custody-split-n") && fr.some((r) => r.formField === "custody-split-threshold"),
  "'the split button stays disabled' says WHICH picker: the share count and the threshold are different edits",
);
// validateSplitParams names the refused field, and the two refusals are NOT the same row.
eq(validateSplitParams(1, 2).refusedField, "custody-split-n", "a share count below the floor names the share-count field");
eq(validateSplitParams(5, 9).refusedField, "custody-split-threshold", "a threshold above N names the threshold field");
ok(validateSplitParams(5, 3).ok && validateSplitParams(5, 3).refusedField === undefined, "a VALID pair names no field and records nothing (no wolf cry)");

section("console-vs-engine skew, and an invite capability that was silently absent");

reset();
setActiveScreen("access");

// The three forward-compat fallbacks are three DIFFERENT pieces of engine vocabulary the console has not
// caught up with, and the pack must say WHICH: an unknown target kind, an unknown auth method, an unlabelled
// engine-state field. Folding them together leaves support unable to say what the console is behind on.
recordContractSkew("unknown-enum-member", "audit-target");
recordContractSkew("unknown-enum-member", "audit-method");
recordContractSkew("unknown-enum-member", "audit-field-name");
recordContractSkew("missing-field", "invite-state");
const cs = snapshot().records.filter((r) => r.kind === "contract-skew");
eq(cs.length, 4, "the three audit fallbacks and the absent invite capability are FOUR rows");
ok(
  cs.some((r) => r.fieldFamily === "audit-target") && cs.some((r) => r.fieldFamily === "audit-method") && cs.some((r) => r.fieldFamily === "audit-field-name"),
  "an unrecognised target, an unknown method and a raw field name are told apart",
);
ok(cs.some((r) => r.fieldFamily === "invite-state"), "a grant that came back with NO invite statement is recorded as skew, not guessed at");

// The other half: the pack must carry the CONSOLE BUILD, or "update your console to X" cannot be said at
// all. It rides on the ENVELOPE (a session fact, not a per-row one), and it is admitted by a SHAPE GATE.
ok(CONSOLE_BUILD_RE.test("0.1.9") && CONSOLE_BUILD_RE.test("1.2.0-rc1"), "the build gate admits a product version");
ok(
  !CONSOLE_BUILD_RE.test("https://acme.example.com/admin") &&
    !CONSOLE_BUILD_RE.test("Error: connect ECONNREFUSED 10.0.0.1") &&
    !CONSOLE_BUILD_RE.test("acme-backups") &&
    !CONSOLE_BUILD_RE.test("colin@maelstrom.au"),
  "and it admits NO url, message, bucket or email at any length: the field is shape-gated, not clamped",
);
// An unstamped build (a Node validator run, which is exactly this process) sends the field ABSENT rather than a
// fabricated one: "we do not know which console this was" is the honest answer.
eq(packPayload().consoleBuild, undefined, "an unstamped build omits consoleBuild rather than inventing one");

reset();
setActiveScreen("overview");

console.log(`\n${checks - failures}/${checks} ok`);
// The count is declared rather than inferred: this validator prints one summary line rather than a line
// per assertion, so the guard's assertion-line floor has nothing per-check to see.
// ---------------------------------------------------------------------------------------------------
// EVERY GUARDED FIELD IS ACTUALLY CLOSED, and the list of them is READ FROM THE SOURCE.
//
// push() is the one door into the ring, and it closes a record whole when any string on it is not a member
// of that field's frozen allowlist. Two of those fields were checked by hand above (screen and httpClass)
// out of more than sixty, so the guarantee was asserted for a sample and assumed for the rest. A guard that
// is never exercised is a guard nobody knows is wired: this file's own subject is a value smuggled onto the
// wire inside a support pack, and the cheapest way for one to get there is a field whose check was written
// and never fired.
//
// THE FIELD LIST IS PARSED OUT OF ring.ts RATHER THAN TYPED HERE, and that is the point. A hand-written list
// goes stale the first time a field is added, silently, in the passing direction: the new field's guard is
// simply never named and the suite stays green. Reading the source means a new guard is covered the moment
// it is written, and a guard DELETED from the source stops being claimed here instead of being claimed
// falsely. The parse itself is asserted against a floor, so a regex that stops matching cannot read zero
// fields and report a clean sweep.
//
// EACH FIELD GETS BOTH ARMS. The negative arm proves a non-member is refused; the positive control proves
// the same field admits a real member, because a push() broken to reject everything would pass a
// negative-only suite and would be a total loss of diagnostics.
// ---------------------------------------------------------------------------------------------------
{
  const ringSource = readFileSync(join(HERE, "..", "src", "lib", "client-diag", "ring.ts"), "utf8");
  const guardRe = /if \(candidate\.(\w+) !== undefined && !(CLIENT_DIAG_\w+_SET)\.has\(candidate\.\1\)\) return;/g;
  const guards: Array<{ field: string; setName: string }> = [];
  for (const m of ringSource.matchAll(guardRe)) guards.push({ field: m[1]!, setName: m[2]! });

  // MEASURED, not slack. A floor below the real count is a floor that stays silent while guards are deleted
  // one at a time, which is precisely the drift a source-derived list is otherwise blind to: a guard that is
  // removed also removes itself from what this sweep claims.
  ok(guards.length === 62, `the guard sweep reads push()'s optional-field checks out of ring.ts (read ${guards.length}, measured at 62)`);

  // AND THE OTHER DIRECTION, which the derived list cannot see on its own: every optional field the ring's
  // record PROJECTION copies outward must have a membership guard on the way in. A field that is projected
  // and unguarded is a field that rides to the wire unchecked, and deleting its guard would otherwise just
  // shrink this sweep's own claim rather than failing it.
  const rowStart = ringSource.indexOf("  const row: ClientDiagnosticRecord = {");
  const rowEnd = ringSource.indexOf("\n  };", rowStart);
  ok(rowStart > 0 && rowEnd > rowStart, "the ring's record projection is readable in source");
  const projected = [...ringSource.slice(rowStart, rowEnd).matchAll(/\.\.\.\(candidate\.(\w+) !== undefined \?/g)].map((m) => m[1]!);
  const guardedNames = new Set(guards.map((g) => g.field));
  const unguarded = projected.filter((f) => !guardedNames.has(f));
  ok(projected.length >= 60, `the projection sweep reads the ring row out of ring.ts (read ${projected.length})`);
  ok(unguarded.length === 0, `every optional field the ring projects outward is membership-checked on the way in${unguarded.length > 0 ? ` (projected but unguarded: ${unguarded.join(", ")})` : ""}`);

  // The vocabulary sets by name, so a field's own allowlist supplies its positive control.
  const vocab = (await import("../src/lib/client-diag/vocab.ts")) as unknown as Record<string, ReadonlySet<string>>;

  const SMUGGLED = "smuggled-not-a-member-value";
  const refusedFields: string[] = [];
  const admittedFields: string[] = [];
  const unresolvedSets: string[] = [];

  for (const g of guards) {
    const set = vocab[g.setName];
    if (!(set instanceof Set) || set.size === 0) {
      unresolvedSets.push(g.setName);
      continue;
    }
    const member = [...set][0]!;

    // NEGATIVE: a non-member closes the record. Nothing of it may reach the ring.
    reset();
    push({ kind: "engine-call", screen: "downpipes", count: 1, firstMs: 0, lastMs: 0, [g.field]: SMUGGLED } as unknown as ClientDiagnosticRecord);
    if (snapshot().records.length === 0) refusedFields.push(g.field);

    // POSITIVE CONTROL: the same field, a real member, is admitted and carries that member.
    reset();
    push({ kind: "engine-call", screen: "downpipes", count: 1, firstMs: 0, lastMs: 0, [g.field]: member } as unknown as ClientDiagnosticRecord);
    const rows = snapshot().records as unknown as Array<Record<string, unknown>>;
    if (rows.length === 1 && rows[0]?.[g.field] === member) admittedFields.push(g.field);
  }
  reset();

  ok(unresolvedSets.length === 0, `every guard's allowlist resolves in vocab.ts${unresolvedSets.length > 0 ? ` (unresolved: ${unresolvedSets.join(", ")})` : ""}`);
  ok(
    refusedFields.length === guards.length,
    `every one of the ${guards.length} guarded field(s) REFUSES a non-member outright${refusedFields.length === guards.length ? "" : ` (admitted: ${guards.map((g) => g.field).filter((f) => !refusedFields.includes(f)).join(", ")})`}`,
  );
  ok(
    admittedFields.length === guards.length,
    `and every one of them ADMITS a real member, so the refusal above is a check and not a dead door${admittedFields.length === guards.length ? "" : ` (refused its own member: ${guards.map((g) => g.field).filter((f) => !admittedFields.includes(f)).join(", ")})`}`,
  );
}

verdictReached(failures, checks); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("CLIENT-DIAGNOSTICS RING PASS");
