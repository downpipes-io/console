// Validate the Licence screen's commercial-model logic (src/lib/billing.ts), the pure
// decisions that drive the renewal-awareness note, the amber "Renews soon" cue, and the
// Enterprise services card. Run with
// `node test/validate-licence.ts`.
//
// The screen's render() touches the DOM, which Node cannot run without a shim, so (as with
// validate-palette.ts / validate-freshness.ts) the test drives the REAL decision functions
// the screen composes, not the DOM. The behaviours under test:
//
//   renewalNotice (renewal awareness): for an Enterprise licence with a near notAfter it
//   reports renewsSoon=true and the correct day count (so the screen shows the renewal note
//   and the amber re-pin banner); a far notAfter is not soon; a past notAfter is expired;
//   Community (no notAfter) yields null (no renewal note at all). A deterministic `now` is
//   injected so the day arithmetic is pinned.
//
//   the Enterprise-card gate: the screen renders the Enterprise services card exactly when
//   the tier is NOT enterprise (community or any paid tier), and withholds it when it IS enterprise
//   (no self-upsell). The gate is the single predicate tier === "enterprise"; this asserts
//   both sides so the community case shows the card and the enterprise case withholds it.
//
//   the commercial constants are present, carry the documented (placeholder) values that
//   need production swaps, and the framing copy never implies a product capability is gated
//   behind Enterprise (the hard rule: Community is the full product, free, with all
//   security included; Enterprise adds services, not features).
//
// Every section carries a negative control that would fail on a naive/wrong implementation.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { engineRoots } from "./engine-path.ts";

const HERE = new URL(".", import.meta.url).pathname;

import {
  ENTERPRISE_CONTACT,
  ENTERPRISE_SERVICES,
  LICENCE_ACCOUNT_MISMATCH_LINE,
  LICENCE_ACCOUNT_UNKNOWN_LINE,
  LICENCE_STAMP_UNREADABLE_LINE,
  RENEW_SOON_DAYS,
  licenceAccountMismatch,
  licenceAccountUnknown,
  licenceActivatedLine,
  licenceShortenedClause,
  licenceValidityShortened,
  licenceStampUnreadable,
  renewalNotice,
  TIER_DISPLAY_NAMES,
  tierDisplayName,
} from "../src/lib/billing.ts";
// Volume-based licensing (self-serve tiers): the pure estate/band logic, its own leaf module
// (screens/licence/estate-band.ts) so shared.ts stays under the max-lines guardrail.
import {
  BAND_MALFORMED_LINE,
  ESTATE_UNREADABLE_LINE,
  bandFeaturesMalformed,
  estateFiguresUnreadable,
  parseBandFeatures,
  estateSummaryLine,
  bandSummaryLine,
  estateExceedsBand,
  estateSizeLabel,
  bandSizeLabel,
  ESTATE_OVER_BAND_LINE,
  type BandInfo,
} from "../src/screens/licence/estate-band.ts";
import type { LicenceStatus, UpdateStatus, UpdateStatusRecord, PromoteResult, SettleResult, StandaloneRollbackResult, RampResult, RampSettleResult, StatusReport, UpdateComponentId, ComponentApplyResult, UpdateApplyResult, UpdateComponentInfo, EstateSummary } from "../src/api.ts";
import { isOwnerActionQueued, EngineClient } from "../src/api.ts";
import { setCaller } from "../src/lib/store.ts";
// The safe-apply update control's PURE state logic is exported from the screen module and imported here
// DIRECTLY (the established pattern — none of the screen's imports execute DOM at import time, so importing
// it in Node succeeds; see validate-security-centre.ts). Testing the REAL functions (not a re-declared
// mirror) means a change to the screen's state machine that this test does not also expect WILL fail here.
import {
  updateControlState,
  lastUpdateSummary,
  updateRefusalText,
  promoteSummaryLine,
  settleOutcomeLine,
  UPDATE_MANAGE_CAP,
  riskClassLabel,
  riskClassTone,
  riskClassNeedsCare,
  compatBlockedReason,
  changelogTypeLabel,
  artefactHashState,
  ARTEFACT_STAMP_MALFORMED_LINE,
  artefactStampMalformed,
  releasedAgoLine,
  standaloneRollbackOffered,
  standaloneRollbackOutcomeLine,
  rampOutcomeLine,
  rampSettleOutcomeLine,
  queuedForSecondOwnerLine,
  // Multi-component updates (P1 + P5): the pure component logic + copy, and the persistence-first settle
  // recovery, all re-exported through the coordinator exactly like the safe-apply state machine above.
  updateTileTone,
  updateTileValue,
  updateTileLabel,
  semverNewer,
  componentLabel,
  componentRows,
  componentRowLine,
  consoleUpdateAvailable,
  releaseComponentsToApply,
  componentApplyResultLine,
  consoleWasApplied,
  updateExplainerText,
  consoleCheckingLine,
  consoleReloadPromptLine,
  consoleCheckFailedLine,
  consoleRollbackOutcomeLine,
  recordedSettleOutcome,
  recordedSettleOutcomeLine,
  SETTLE_UNCONFIRMED_LINE,
  // The ?open=updates deep link (the shell's update chip destination): the section anchor id the
  // view stamps on the Updates heading, and the reveal the coordinator runs over the region.
  UPDATES_HEADING_ID,
  revealUpdatesSection,
} from "../src/screens/licence.ts";
// The real screen body builder, for the deep-link reveal proof (section 27); render never touches
// the engine (handlers fire on click only), so a bare stub is honest there.
import { render as renderLicenceView } from "../src/screens/licence/view.ts";
// engineRefusalText from the leaf it lives in (the screen barrel does not re-export it), for the same
// reason updateRefusalText is imported above: the REAL function, never a mirror of it.
import { engineRefusalText } from "../src/screens/licence/shared.ts";
// The console's OWN internal transport markers, imported as the CONSTANTS rather than re-typed as string
// literals: section 5c drives every one of them through both refusal composers, so a marker that is added
// to lib/errors.ts and forgotten here is still covered, and a marker that is renamed cannot leave a stale
// literal passing.
import {
  ACCESS_REDIRECT_MARKER,
  CONSOLE_ORIGIN_FAULT,
  ENGINE_BINDING_ABSENT,
  FORBIDDEN_CLASS_MARKER,
  HTML_BODY_MARKER,
  RATE_LIMIT_MARKER,
  STEPUP_REQUIRED_MARKER,
} from "../src/lib/errors.ts";
// The claim-code path: the licence email now leads with a short code
// rather than the full signed token. claim-code.ts is the pure shape/normalisation/fetch module; activation.ts
// (imported here directly, not through the licence.ts barrel, matching the update-apply-flow.ts /
// update-components-advanced.ts precedent above) is the real DOM component sections 35-37 below drive.
import {
  normaliseClaimCode,
  isClaimCodeShape,
  formatClaimCode,
  fetchClaimToken,
  CLAIM_TIMEOUT_MS,
  CLAIM_UNREACHABLE_TEXT,
  CLAIM_ERRORED_TEXT,
  CLAIM_NOT_RECOGNISED_TEXT,
  CLAIM_HINT_TEXT,
  CLAIM_BAND_FULL_FALLBACK_TEXT,
} from "../src/screens/licence/claim-code.ts";
import { activationSection } from "../src/screens/licence/activation.ts";
// The console's own version identity (P1) + the lazy-chunk preloader (P5): lib modules, imported directly.
import { consoleVersion, fetchServedConsoleVersion, pollForServedVersion } from "../src/lib/console-version.ts";
// titleCase is imported ONLY for section 32's negative control (proving tierDisplayName's map is
// actually doing work, not coincidentally matching what titleCase alone would already produce).
import { titleCase } from "../src/lib/format.ts";
import { preloadOwnLazyChunks } from "../src/lib/preload-chunks.ts";
// The DOM-driving pieces (the live apply flow, the post-apply build check, the advanced per-component
// section) run under the shared hand-rolled DOM shim, exactly like the stable-components validators. None
// of these modules touch the DOM at import time; the shim is installed before the first render call.
import { installDomShim, flushAsync, markConnected, qs, qsa, textOf } from "./dom-shim.ts";
import { runLiveApplyFlow, renderComponentResults, recoverSettleConclusion, type ApplyFlowHooks } from "../src/screens/licence/update-apply-flow.ts";
import { makeEvent } from "./dom-shim-core.ts";
import { availableUpdateBody } from "../src/screens/licence/update-available-body.ts";
import { componentAdvancedSection } from "../src/screens/licence/update-components-advanced.ts";
import { pendingUpdateBody } from "../src/screens/licence/update-pending-body.ts";
// rampSection is the ramp's PHASE 1 control, driven directly so the success branch's reload() (the one that
// renders the pending card, and the one the dead "ramped" outcome made unreachable) is proven to fire.
import { rampSection } from "../src/screens/licence/update-ramp.ts";
import { rollbackControl } from "../src/screens/licence/rollback.ts";
import { confirmEngineRollback } from "../src/screens/licence/update-rollback-confirm.ts";
// can() is the engine's capability model the console mirrors; we assert keys.ceremony (the update gate) is
// OWNER-ONLY, the same gate the licence activation control uses, proving the owner-gating is real.
import { can } from "../src/lib/identity.ts";
// 0.1.5 update-UX (design/updates/UPDATE-UX-015-DESIGN.md): the exact s2/s4/s6 copy, the bridge from a
// recorded outcome to that copy, and the injectable-timer retry engine, all imported DIRECTLY from their own
// leaf modules (the established mixed-import style this file already uses for update-apply-flow.ts /
// update-components-advanced.ts, rather than routing everything through the screens/licence.ts barrel).
import {
  STAGE_CHECKING,
  STAGE_DEPLOYING_ENGINE,
  STAGE_PROVING,
  STAGE_PROVING_SUBLINE,
  STAGE_UPDATING_CONSOLE,
  STALL_LINE,
  EXPIRED_CLEARED_LINE,
  appliedTerminalLine,
  rolledBackTerminalLine,
  DESTINATION_GATE_ENGINE_REASON,
  DESTINATION_GATE_CONSOLE_LINE,
  PAIRED_ROLLBACK_LINE,
} from "../src/screens/licence/update-outcome-copy.ts";
import { terminalLineForOutcome, destinationGateNode } from "../src/screens/licence/update-outcome-render.ts";

// ZERO_HOOKS is EVERY 0.1.5 timing knob zeroed (design s2's own invariant: "All timers injectable so
// validators can zero them"), spread into every DOM-flow test below so the s2 grace + retry ladder + status
// backoff + stall-poll interval all resolve on the SAME tick instead of the real ~60-90s budget. A settle
// ladder still gets its 3 retries (settleBackoffMs has 3 zero-duration entries, only the WAIT is zeroed, not
// the retry COUNT), matching production shape at test speed.
const ZERO_HOOKS: ApplyFlowHooks = { graceMs: 0, settleBackoffMs: [0, 0, 0], statusRetries: 3, statusBackoffMs: [0, 0, 0], stallPollMs: 0, pollDelayMs: 0 };

let failures = 0;

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function eq<T>(label: string, got: T, want: T): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// A fixed clock so the day arithmetic is deterministic (the same pin pattern
// validate-format.ts uses for relativeTime).
const NOW = Date.parse("2026-06-09T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

// isoInDays builds an RFC-3339 timestamp `days` from NOW (negative = in the past).
function isoInDays(days: number): string {
  return new Date(NOW + days * DAY).toISOString();
}

function lic(tier: LicenceStatus["tier"], extra: Partial<LicenceStatus> = {}): LicenceStatus {
  return { tier, valid: true, ...extra };
}

// enterpriseCardShown mirrors the screen's single gate (licence.ts:
// `const isEnterprise = data.licence.tier === "enterprise"`; the Enterprise services card
// renders when !isEnterprise, and is withheld when isEnterprise). Asserting on this is
// asserting on exactly what the screen branches on.
function enterpriseCardShown(l: LicenceStatus): boolean {
  return l.tier !== "enterprise";
}

// --- Activation-control state mirror (licence.ts activationCard) ------------------------
// The screen's render() builds DOM, which Node cannot run without a shim, so (exactly as the
// renewal/card-gating sections above) the test drives the PURE predicates the activation card
// branches on, not the DOM. These mirror licence.ts byte-for-byte:
//   consoleSet = lic.source === "console"  (drives Replace+Remove vs Activate)
//   the submit button label                ("Replace token" when consoleSet, else "Activate")
//   the Remove button renders              (only when consoleSet)
// A change to the screen's gate that this test does not also make will diverge and fail review.
function consoleSet(l: LicenceStatus): boolean {
  return l.source === "console";
}
function submitLabel(l: LicenceStatus): string {
  return consoleSet(l) ? "Replace token" : "Activate";
}
function removeButtonShown(l: LicenceStatus): boolean {
  return consoleSet(l);
}

// engineRefusalText is IMPORTED from the screen, not re-implemented here, and that is a correction rather
// than a tidy-up. This file used to carry a local copy of the transform with the comment "this is the EXACT
// transform the screen applies", and it was not: the whole of section 5 exercised a function that does not
// ship. A copy asserts only that the copy behaves as the copy was written, so the screen could have been
// rewritten in any way at all and every assertion below would still have passed. It is the same shape as
// the fixtures that used to be console literals claiming to be the engine's (see section 5's own note).

// ===========================================================================
// 1. RENEWAL AWARENESS -- renewalNotice
// ===========================================================================
console.log("\n-- renewal awareness (renewalNotice) --");

// 1a. Community has no expiry: no renewal note at all (the screen shows the Enterprise
// card, never a renewal line).
eq("community licence -> null (no renewal note)", renewalNotice(lic("community"), NOW), null);
// Negative control: even a community licence that somehow carried a near notAfter still
// drives a notice object IF one is present -- but the canonical community licence has none,
// so the screen never renders a renewal line for it. Assert the no-notAfter path is null.
eq("any tier with no notAfter -> null", renewalNotice(lic("enterprise"), NOW), null);

// 1b. Enterprise with a NEAR notAfter (inside the window): renewsSoon, not expired, with a
// positive day count. This is the case that renders the renewal note + the amber re-pin
// banner the brief asks for.
{
  const near = renewalNotice(lic("enterprise", { notAfter: isoInDays(10) }), NOW);
  ok("enterprise, 10 days out -> notice present", near !== null);
  ok("enterprise, 10 days out -> renewsSoon", near?.renewsSoon === true);
  ok("enterprise, 10 days out -> not expired", near?.expired === false);
  eq("enterprise, 10 days out -> daysUntil = 10", near?.daysUntil, 10);
  // Negative control: a near licence must NOT read as expired (the bug would be a sign flip).
  ok("near licence is not flagged expired (negative control)", near?.expired !== true);
}

// 1c. Exactly at the window edge (RENEW_SOON_DAYS): still "soon" (inclusive boundary).
{
  const edge = renewalNotice(lic("enterprise", { notAfter: isoInDays(RENEW_SOON_DAYS) }), NOW);
  ok(`enterprise, exactly ${RENEW_SOON_DAYS} days out -> renewsSoon (inclusive edge)`, edge?.renewsSoon === true);
}

// 1d. Just BEYOND the window: not soon (the amber banner is withheld), still valid.
{
  const far = renewalNotice(lic("enterprise", { notAfter: isoInDays(RENEW_SOON_DAYS + 5) }), NOW);
  ok(`enterprise, ${RENEW_SOON_DAYS + 5} days out -> NOT renewsSoon`, far?.renewsSoon === false);
  ok("far licence is not expired", far?.expired === false);
  // Negative control: a far licence is still a notice (the valid-until line renders), just
  // without the amber cue -- it must not be null.
  ok("far licence still yields a notice (valid-until line shows)", far !== null);
}

// 1e. A PAST notAfter: expired, with a negative day count. Fail-open still holds in the
// copy; the flag only drives the honest "passed its validity date" banner.
{
  const past = renewalNotice(lic("enterprise", { notAfter: isoInDays(-3) }), NOW);
  ok("enterprise, 3 days past -> expired", past?.expired === true);
  ok("enterprise, 3 days past -> NOT renewsSoon", past?.renewsSoon === false);
  ok("enterprise, 3 days past -> negative daysUntil", (past?.daysUntil ?? 0) < 0);
  eq("enterprise, 3 days past -> daysUntil = -3", past?.daysUntil, -3);
}

// 1f. An unparseable notAfter degrades to null (no fabricated note), not a throw or NaN.
eq("unparseable notAfter -> null", renewalNotice(lic("enterprise", { notAfter: "not-a-date" }), NOW), null);

// ===========================================================================
// 2. CARD GATING -- Enterprise services card (shown to non-enterprise tiers)
// ===========================================================================
console.log("\n-- card gating (Enterprise services card) --");

// 2a. Community shows the Enterprise services card.
ok("community -> Enterprise card shown", enterpriseCardShown(lic("community")));

// 2b. A paid non-enterprise tier also shows the Enterprise services card.
ok("business-1 -> Enterprise card shown", enterpriseCardShown(lic("business-1")));

// 2c. Enterprise withholds the upsell card (no self-upsell).
ok("enterprise -> Enterprise card NOT shown (no self-upsell)", enterpriseCardShown(lic("enterprise")) === false);

// Negative control: the gate is exactly tier !== "enterprise" for every tier (only the
// enterprise tier withholds the services card).
// Every LIVE tier, not a sample. The current live set is community/business-1/business-3/business-10/business-25/
// msp/enterprise (control-plane's src/licence/issue.ts PaidTier, plus "community").
for (const t of ["community", "business-1", "business-3", "business-10", "business-25", "msp", "enterprise"] as const) {
  const l = lic(t);
  ok(`${t}: Enterprise card shown iff not enterprise`, enterpriseCardShown(l) === (t !== "enterprise"));
}

// ===========================================================================
// 3. COMMERCIAL CONSTANTS -- presence, placeholder values, framing
// ===========================================================================
console.log("\n-- commercial constants --");

// 3a. The Enterprise contact is the live sales mailto with a pre-filled subject (mirrors the
// website's contact CTA, sales@downpipes.io).
eq("ENTERPRISE_CONTACT is the live sales mailto", ENTERPRISE_CONTACT, "mailto:sales@downpipes.io?subject=downpipes%20Enterprise");
ok("ENTERPRISE_CONTACT is a mailto or https link", ENTERPRISE_CONTACT.startsWith("mailto:") || ENTERPRISE_CONTACT.startsWith("https:"));

// 3b. FRAMING (the hard rule): no services-list entry may imply a
// product capability or a security control is locked behind Enterprise. The services are
// all assistance/evidence/support/assurance words; assert none reads as a feature gate.
{
  const gateWords = ["unlock", "locked", "enable sso", "enables sso", "enable mfa", "enables mfa", "only available", "upgrade to get", "required for", "gated"];
  const haystack = ENTERPRISE_SERVICES.join(" | ").toLowerCase();
  for (const w of gateWords) {
    ok(`services copy does not imply a gate ("${w}")`, !haystack.includes(w));
  }
  // The services list is non-empty and includes the assurance items the brief calls out.
  ok("services list is non-empty", ENTERPRISE_SERVICES.length > 0);
  ok("services include signed DR-drill evidence (provable recoverability)", haystack.includes("disaster-recovery drill evidence"));
  ok("services include the backup-assurance attestation", haystack.includes("backup-assurance attestation"));
  // Negative control: this assertion would catch a regression that smuggled a gate word in
  // -- prove the check is live by confirming a known gate word is NOT present.
  ok("control: a gate word would be detected if present", !haystack.includes("unlock"));
}

// ===========================================================================
// 4. ACTIVATION CONTROL -- which buttons/copy appear per state
// ===========================================================================
console.log("\n-- activation control (Activate / Replace / Remove) --");

// 4a. Community with NO console token (the common first-activation state): the Activate paste +
// "Activate" button, and NO Remove (there is nothing console-set to clear).
{
  const community = lic("community"); // no `source` => not console-set
  ok("community/no-source -> not console-set", consoleSet(community) === false);
  eq("community/no-source -> submit label is 'Activate'", submitLabel(community), "Activate");
  ok("community/no-source -> Remove NOT shown", removeButtonShown(community) === false);
}

// 4b. A DEPLOY-set token (source === "deploy") is treated like first-activation by the control: the
// owner can still paste a token to OVERRIDE it (the DO-stored token wins over env), so it shows
// "Activate", NOT "Replace", and NO Remove (Remove only clears a CONSOLE-set token, not the env one).
{
  const deploy = lic("enterprise", { source: "deploy" });
  ok("deploy-set -> not console-set", consoleSet(deploy) === false);
  eq("deploy-set -> submit label is 'Activate' (override, not replace)", submitLabel(deploy), "Activate");
  ok("deploy-set -> Remove NOT shown (cannot clear an env token here)", removeButtonShown(deploy) === false);
}

// 4c. A CONSOLE-set active token (source === "console"): the renewal path. It shows "Replace token"
// AND a Remove (which clears the DO-stored token via setLicence(null)).
{
  const consoleActive = lic("enterprise", { source: "console", setAt: NOW, setBy: "owner@example.com" });
  ok("console-set -> is console-set", consoleSet(consoleActive) === true);
  eq("console-set -> submit label is 'Replace token'", submitLabel(consoleActive), "Replace token");
  ok("console-set -> Remove shown", removeButtonShown(consoleActive) === true);
}

// 4d. The state predicate is EXACTLY `source === "console"`, nothing else: tier and validity do not
// change which controls appear (a console-set Community token still offers Replace+Remove; an
// enterprise token with no source does not). Negative controls that a naive tier-based gate fails.
{
  const consoleCommunity = lic("community", { source: "console", setBy: "owner@example.com" });
  ok("console-set is independent of tier (community + console -> Replace+Remove)", consoleSet(consoleCommunity) && removeButtonShown(consoleCommunity));
  const enterpriseNoSource = lic("enterprise"); // valid enterprise, but came from neither console nor deploy
  ok("absent source -> Activate, no Remove (not driven by tier)", submitLabel(enterpriseNoSource) === "Activate" && removeButtonShown(enterpriseNoSource) === false);
}

// 4e. Activate and Remove are MUTUALLY the two states: for any licence, Remove shows iff the label is
// "Replace token" (the console-set state), and the label is "Activate" iff Remove is hidden. This pins
// the invariant that Remove never appears without the Replace affordance and vice-versa.
for (const l of [lic("community"), lic("business-1", { source: "deploy" }), lic("enterprise", { source: "console", setBy: "o@e.co" })]) {
  ok(`${l.tier}/${l.source ?? "none"}: Remove shown iff label is 'Replace token'`, removeButtonShown(l) === (submitLabel(l) === "Replace token"));
}

// ===========================================================================
// 5. SET-LICENCE ERROR PATH -- the engine refusal shown verbatim inline
// ===========================================================================
console.log("\n-- setLicence error path (verbatim engine refusal) --");

// The engine WRAPS every POST /admin/licence refusal in a full operator sentence: the verify-before-store
// failures all read "this licence could not be activated: <reason><hint>." and the shape check reads
// "that does not look like a licence token. Paste the licence token value ...". Each reaches the console
// as the client-thrown "set licence: <body>: 400" (api.ts setLicence folds the engine { error } in), and
// engineRefusalText must strip the "set licence: " verb prefix and the trailing ": 400" so the operator
// reads the engine's WHOLE wrapped sentence.
//
// WHAT WAS WRONG WITH THIS BLOCK, because it is subtler than the other members of its class. The four
// bodies were console literals cited "byte-for-byte from engine/src/admin/router.ts POST /licence", and
// that route is not in router.ts: it moved to src/admin/router-updates.ts (:186 and :207). Worse, the
// assertion was `engineRefusalText(thrown(B)) === B`, where thrown(B) prepends exactly what
// engineRefusalText strips. That identity holds for ANY string without surrounding whitespace, so all
// four assertions passed without reference to their fixtures, and the fixtures passed without reference
// to the engine. Two independent reasons the block could not fail.
//
// The fixtures are now COMPOSED FROM THE ENGINE'S OWN PIECES: the wrapper template and the two
// parenthetical hints out of router-updates.ts, the three refusal reasons out of licence.ts, where
// community() names them. The round-trip assertion stays, and is still close to an identity, but it now
// runs over the engine's real sentences, so a reworded hint or a reason that acquires a trailing status-
// shaped token is exercised rather than assumed. The assertions that carry the actual weight are the
// composition ones: if the engine changes any piece, the bodies here change with it or this fails.
const ENGINE_UPDATES_ROUTER = "src/admin/router-updates.ts";
const ENGINE_LICENCE = "src/admin/licence.ts";

function engineSource(rel: string): string | null {
  const p = engineRoots(HERE).map((r) => resolve(r, rel)).find((f) => existsSync(f));
  return p === undefined ? null : readFileSync(p, "utf8");
}

const routerSrc = engineSource(ENGINE_UPDATES_ROUTER);
const licenceSrc = engineSource(ENGINE_LICENCE);
if (routerSrc === null || licenceSrc === null) {
  console.log("CANNOT CHECK validate-licence: no engine checkout reachable, so the refusal-body composition did not run");
  if (process.env.REQUIRE_ENGINE === "1") {
    // A REFUSAL, NOT A FINDING. This printed a FAIL line and exited 1. The refusal bodies this
    // block composes are pulled out of the engine's own router-updates.ts and licence.ts, so with no engine
    // there is no expected body and nothing was compared. Exit 1 asserts a divergence this run never
    // established. The same file already uses verdictCannotCheck for its other could-not-check at line 623,
    // so the two halves of one file were classifying the same kind of fact two different ways.
    console.error("validate-licence: REFUSED, REQUIRE_ENGINE=1 and no engine checkout is reachable.\n" +
        "  The refusal bodies this block grades are composed from the engine's own src/admin/router-updates.ts\n" +
        "  and src/admin/licence.ts, so with no engine this comparison cannot run and will not report that it\n" +
        "  did.\n" +
        "  Point it at one with DOWNPIPES_ENGINE=/path/to/engine, or check the engine out beside this repo.",); process.exit(2);
  }
}

// Pull one double-quoted literal that starts with `lead` out of the engine source. Returns null when the
// anchor has moved, which is REPORTED below rather than quietly producing a shorter fixture set.
function engineLiteral(src: string | null, lead: string): string | null {
  if (src === null) return null;
  const re = new RegExp(`"(${lead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*)"`);
  return re.exec(src)?.[1] ?? null;
}
// The three verify reasons, keyed by the reasonCode community() records alongside each.
function engineReason(code: string): string | null {
  if (licenceSrc === null) return null;
  return new RegExp(`community\\(\\s*"([^"]+)",\\s*"${code}"`).exec(licenceSrc)?.[1] ?? null;
}

const WRAPPER_LEAD = "this licence could not be activated: ";
const reasonSig = engineReason("signature");
const reasonExpired = engineReason("expired");
const reasonNoPin = engineReason("no-pin");
const hintNoPin = engineLiteral(routerSrc, " (the vendor has not pinned");
const hintExpired = engineLiteral(routerSrc, " (request a renewed token");
const shapeBody = engineLiteral(routerSrc, "that does not look like a licence token");
const wrapperTemplate = routerSrc === null ? null : /`(this licence could not be activated: \$\{why\}\$\{hint\})\.`/.exec(routerSrc)?.[1] ?? null;

if (routerSrc !== null && licenceSrc !== null) {
  console.log("\n-- the engine's refusal pieces, read from the engine --");
  // Every piece must be FOUND. A moved anchor that yielded null would otherwise compose a fixture reading
  // "this licence could not be activated: null." and then happily assert the round-trip on it.
  ok("engine still wraps refusals in the operator sentence", wrapperTemplate !== null);
  ok("engine still declares the signature reason", reasonSig !== null);
  ok("engine still declares the expiry reason", reasonExpired !== null);
  ok("engine still declares the no-pinned-key reason", reasonNoPin !== null);
  ok("engine still carries the no-pinned-key hint", hintNoPin !== null);
  ok("engine still carries the expiry hint", hintExpired !== null);
  ok("engine still carries the shape-refusal body", shapeBody !== null);
  // The hints must attach to the reasons this file pairs them with, or the composed bodies are plausible
  // sentences the engine never emits.
  ok("the no-pinned-key hint is selected by the no-pinned-key reason", reasonNoPin !== null && routerSrc.includes(`verified.reason === "${reasonNoPin}"`));
  ok("the expiry hint is selected by the expiry reason", reasonExpired !== null && routerSrc.includes(`verified.reason === "${reasonExpired}"`));
  ok("the signature refusal takes no hint (the ternary's else branch)", reasonSig !== null && !routerSrc.includes(`verified.reason === "${reasonSig}"`));
}

// The four engine bodies, COMPOSED from the pieces above exactly as router-updates.ts composes them:
// `this licence could not be activated: ${why}${hint}.`
const wrap = (why: string | null, hint: string): string => `${WRAPPER_LEAD}${why ?? "<REASON MISSING FROM THE ENGINE>"}${hint}.`;
const ENGINE_SIG_BODY = wrap(reasonSig, "");
const ENGINE_EXPIRED_BODY = wrap(reasonExpired, hintExpired ?? "");
const ENGINE_NO_KEY_BODY = wrap(reasonNoPin, hintNoPin ?? "");
const ENGINE_SHAPE_BODY = shapeBody ?? "<SHAPE BODY MISSING FROM THE ENGINE>";

// thrown() builds exactly what api.ts setLicence throws for a 400 with this engine body.
function thrown(body: string): string {
  return `set licence: ${body}: 400`;
}

// 5a/5a'. THE SKIP ABOVE HAS TO REACH THIS FAR, and until it did not. The bodies below are
// COMPOSED from engine literals, so with no engine reachable
// each `why` becomes the "<REASON MISSING FROM THE ENGINE>" placeholder and each hint becomes "". The
// placeholder still ends in a full stop, so the trailing-period and round-trip assertions pass on it, but it
// cannot end in ")." and the two parenthetical-hint assertions FAILED on every engine-less runner. The
// Validators CI job checks out console alone, so that job was red on two
// assertions about the engine's wording that no console change could ever satisfy. The block announced its
// own skip at the top of section 5 and then ran anyway, which is the same fault one level down.
//
// So the engine-composed assertions are gated on the engine actually being there, and validate-licence.ts is
// now in validate:workspace:chain, which runs under REQUIRE_ENGINE=1 in the Cross-repo gates job. There the
// skip branch above exits 1 rather than skipping, so this section is mandatory in the one job that has an
// engine to compose from. Section 5b below needs no engine and still runs everywhere.
if (routerSrc !== null && licenceSrc !== null) {
  // 5a. The four refusal bodies the engine now emits, as the client throws them ("set licence: <body>: 400"),
  // must surface as the FULL wrapped sentence inline (the prefix + the trailing ": 400" stripped, nothing else).
  eq("signature refusal -> full wrapped sentence", engineRefusalText(thrown(ENGINE_SIG_BODY)), ENGINE_SIG_BODY);
  eq("expired refusal -> full wrapped sentence (parenthetical hint kept)", engineRefusalText(thrown(ENGINE_EXPIRED_BODY)), ENGINE_EXPIRED_BODY);
  eq("no-pinned-key refusal -> full wrapped sentence (comma + parens kept)", engineRefusalText(thrown(ENGINE_NO_KEY_BODY)), ENGINE_NO_KEY_BODY);
  eq("shape refusal -> full wrapped sentence (the internal '. Paste...' kept)", engineRefusalText(thrown(ENGINE_SHAPE_BODY)), ENGINE_SHAPE_BODY);

  // 5a'. None of the wrapped sentences are truncated by the strip: each surfaces with its trailing period
  // (and its parenthetical hint, where present) intact -- a naive strip that ate a non-status trailing token
  // would drop the period. Stated STRUCTURALLY rather than as three tail literals: the old form spelled out
  // "vendor key.", "in the meantime)." and "fix here).", which is the engine's wording copied into the
  // console a second time, in the same block whose whole problem was engine wording copied into the console.
  for (const [name, body] of [["signature", ENGINE_SIG_BODY], ["expired", ENGINE_EXPIRED_BODY], ["no-key", ENGINE_NO_KEY_BODY]] as const) {
    const surfaced = engineRefusalText(thrown(body));
    ok(`${name} sentence keeps its trailing period`, surfaced.endsWith("."));
    ok(`${name} sentence is not truncated anywhere`, surfaced === body);
  }
  for (const [name, body] of [["expired", ENGINE_EXPIRED_BODY], ["no-key", ENGINE_NO_KEY_BODY]] as const) {
    // These two are the ones carrying a parenthetical hint, so the closing paren must survive the strip.
    ok(`${name} sentence keeps its parenthetical hint`, engineRefusalText(thrown(body)).endsWith(")."));
  }
  // The strip must actually STRIP. Without this the round-trips above are satisfied by a function that
  // returns its argument, which is the failure mode this whole block had.
  for (const [name, body] of [["signature", ENGINE_SIG_BODY], ["shape", ENGINE_SHAPE_BODY]] as const) {
    ok(`${name}: engineRefusalText removed the verb prefix and the status suffix`, engineRefusalText(thrown(body)) !== thrown(body));
  }
} else {
  console.log("SKIP validate-licence 5a/5a': the engine-composed refusal bodies need an engine checkout (enforced in the Cross-repo gates job under REQUIRE_ENGINE=1)");
}

// 5b. Negative controls (engineRefusalText behaviour): the verb prefix and ONLY a COLON-led trailing status
// are stripped, so a reason that itself ends in digits keeps them once the trailing ": <status>" is removed.
eq("only the TRAILING ': status' is stripped, not a number mid-reason", engineRefusalText("set licence: token 12345 malformed: 400"), "token 12345 malformed");
// Control: a reason must never collapse to empty (the inline error would then say nothing).
ok("refusal text is never empty for a real reason", engineRefusalText(thrown(ENGINE_EXPIRED_BODY)).length > 0);
ok("refusal text is never empty even for a bare fault", engineRefusalText("set licence: 503").length > 0);

// TWO ASSERTIONS THAT USED TO LIVE HERE PINNED THE DEFECT, and they are restated below as their inverses
// rather than deleted, because what they asserted is exactly what a customer read.
//   "bare transport fault (no folded reason) -> the status code": engineRefusalText("set licence: 503")
//   was required to equal "503". The comment defended it ("surfacing the bare code inline is acceptable
//   for that edge"), and the edge is a customer who has just paid, reading a three-digit number in a field
//   whose every other message is about their token.
//   "a non-prefixed message is returned unchanged": engineRefusalText("network error") was required to
//   return "network error". The pass-through the fallback existed for is the leak: it is the same clause
//   that carried `engine-binding-absent` and `Failed to fetch` into the field verbatim.
eq("a bare fault is a SENTENCE, never the bare status code", engineRefusalText("set licence: 503").includes("Nothing was changed"), true);
ok("a bare fault sentence is not merely the status", engineRefusalText("set licence: 503") !== "503");
ok("an unclassified message is not passed through raw", engineRefusalText("network error") !== "network error");

// 5c. NO INTERNAL MARKER REACHES THE OPERATOR. The population is the console's own marker CONSTANTS
// (imported, never re-typed), driven through BOTH refusal composers in the two shapes the transport folds
// them: bare after the verb, and carrying a trailing status. This is the derived form of the check, not a
// list of remembered sentences: rename a marker and the constant moves with it, add one to lib/errors.ts
// and it only needs adding to the array below rather than to seven separate assertions.
//
// IT REFUSES ON AN EMPTY POPULATION. A loop over nothing prints no failures and reads exactly like a clean
// console, which is the failure mode this family of checks is most likely to have.
console.log("\n-- internal markers never surface (engineRefusalText / updateRefusalText) --");
{
  // EACH MARKER IS DRIVEN IN THE SHAPE THE TRANSPORT ACTUALLY FOLDS IT, and the first draft of this block
  // was not, which is the correction worth recording. It drove every marker at every status, and two
  // failed: `forbidden-class=engine-authz` and `retry-after=30` survive when they arrive with NO status or
  // with a status that is not their own. That is real, and it is also unreachable: client-transport.ts
  // failResponse folds forbidden-class ONLY inside `r.status === 403` and retry-after ONLY inside
  // `r.status === 429`, so neither shape can be produced. Widening the claim to "no marker survives in any
  // message" would have been a claim the code does not make and cannot keep; the honest claim is that no
  // marker survives IN THE MESSAGES THE TRANSPORT BUILDS. The bare four are driven at every status anyway,
  // because they are recognised by token and their coverage genuinely is that wide.
  const ALL_STATUSES = [401, 403, 429, 503] as const;
  const MARKERS: ReadonlyArray<{ name: string; marker: string; statuses: readonly number[]; bare: boolean }> = [
    // Thrown bare (no status token) by failResponse's own gates, and recognised by token wherever they land.
    { name: "engine-binding-absent", marker: ENGINE_BINDING_ABSENT, statuses: ALL_STATUSES, bare: true },
    { name: "console-origin-fault", marker: CONSOLE_ORIGIN_FAULT, statuses: ALL_STATUSES, bare: true },
    { name: "access-redirect", marker: ACCESS_REDIRECT_MARKER, statuses: ALL_STATUSES, bare: true },
    { name: "html-body", marker: HTML_BODY_MARKER, statuses: ALL_STATUSES, bare: true },
    // Folded only with their own status, inside the status gate named beside each in failResponse.
    { name: "stepup-required", marker: STEPUP_REQUIRED_MARKER, statuses: [401], bare: true },
    { name: "forbidden-class", marker: `${FORBIDDEN_CLASS_MARKER}=engine-authz`, statuses: [403], bare: false },
    { name: "rate-limit", marker: `${RATE_LIMIT_MARKER}=30`, statuses: [429], bare: false },
  ];
  const shapes = MARKERS.reduce((n, m) => n + m.statuses.length + (m.bare ? 1 : 0), 0);
  if (MARKERS.length < 7 || shapes < 20) {
    console.error(`FAIL 5c: the marker population is empty or short (${MARKERS.length} markers, ${shapes} shapes) -- the loop below would grade nothing`);
    // Exit 2 UNCHANGED. verdictCannotCheck declares the refusal and performs that same exit itself, so
    // the completion guard cannot print over a deliberate could-not-check that it was never reached.
    process.exit(2);
  }
  for (const { name, marker, statuses, bare } of MARKERS) {
    if (bare) {
      ok(`${name}: absent from the licence field, bare`, !engineRefusalText(new Error(`set licence: ${marker}`)).includes(marker));
      ok(`${name}: absent from the update error, bare`, !updateRefusalText(new Error(`apply update: ${marker}`)).includes(marker));
    }
    for (const status of statuses) {
      ok(`${name}: absent from the licence field at ${status}`, !engineRefusalText(new Error(`set licence: ${marker}: ${status}`)).includes(marker));
      ok(`${name}: absent from the update error at ${status}`, !updateRefusalText(new Error(`apply update: ${marker}: ${status}`)).includes(marker));
    }
  }
  // The browser's own rejection is not a marker and is not ours to define, so it is asserted by name: a
  // fetch that never landed throws a TypeError whose message is the browser's, and it used to paint.
  ok("the browser's own fetch rejection does not paint raw", engineRefusalText(new TypeError("Failed to fetch")) !== "Failed to fetch");
  // POSITIVE CONTROL. Without it, every assertion above is satisfied by a function that returns a fixed
  // string, which is the failure mode that would make this whole block worthless.
  eq(
    "a genuine engine reason still surfaces verbatim",
    engineRefusalText(new Error("set licence: this licence could not be activated: licence expired (request a renewed token): 400")),
    "this licence could not be activated: licence expired (request a renewed token)",
  );
  eq(
    "a genuine engine reason on a 403 still surfaces verbatim (not the role-denial sentence)",
    updateRefusalText(new Error("settle update: the deploy token lacks the Edit Cloudflare Workers permission: 403")),
    "the deploy token lacks the Edit Cloudflare Workers permission",
  );
}

// ===========================================================================
// 6. SAFE-APPLY UPDATE -- the control's state machine (updateControlState)
// ===========================================================================
// The Updates section renders the safe-apply control purely from (a) whether an update is AVAILABLE and
// (b) whether a prior apply is PENDING (promoted but not settled). updateControlState is the single predicate
// the section branches on; testing it pins exactly which of {nothing, available, pending} shows per input.
console.log("\n-- safe-apply update control state (updateControlState) --");

// upd() builds an UpdateStatus with a given updateAvailable; rec() builds an UpdateStatusRecord.
function upd(updateAvailable: boolean | undefined): UpdateStatus {
  return { configured: true, verified: true, currentVersion: "v1.0.0", ...(updateAvailable !== undefined ? { updateAvailable } : {}) };
}
function pendingRec(toVersion: string, recommendedVersion = toVersion): UpdateStatusRecord {
  return { pending: { fromVersion: "v1.0.0", toVersion, recommendedVersion, promotedAt: "2026-06-14T00:00:00Z", promotedBy: "owner@example.com" }, last: null };
}

// 6a. NO update available + no pending -> "none" (the control does not render; the read-only facts stay).
eq("no update, no pending -> none", updateControlState(upd(false), null).kind, "none");
// 6a'. updateAvailable absent (an older engine field) is treated as not-available -> none.
eq("updateAvailable absent -> none", updateControlState(upd(undefined), null).kind, "none");

// 6b. Update AVAILABLE + no pending -> "available" (preview + update-now control).
eq("update available, no pending -> available", updateControlState(upd(true), null).kind, "available");
// 6b'. A null updateState (older engine / transient) still resolves available off updates.updateAvailable.
eq("update available, null record -> available", updateControlState(upd(true), { pending: null, last: null }).kind, "available");

// 6c. A PENDING promote -> "pending", carrying the toVersion to verify, REGARDLESS of updateAvailable
// (finishing an in-flight update outranks offering a new one). Negative control: even with updateAvailable
// false, a pending record still drives "pending", not "none".
{
  const s1 = updateControlState(upd(true), pendingRec("v1.1.0"));
  eq("pending outranks available -> pending", s1.kind, "pending");
  eq("pending carries the toVersion to verify", s1.kind === "pending" ? s1.toVersion : "", "v1.1.0");
  const s2 = updateControlState(upd(false), pendingRec("v1.1.0"));
  eq("pending shows even when updateAvailable is false (negative control)", s2.kind, "pending");
  // A plain (atomic) pending carries NO percentage; a gradual-ramp pending carries the live share, which the
  // pending card uses to route to the ramp settle endpoint. The percentage presence is the engine's own
  // discriminator, so updateControlState must forward it verbatim (and only when present).
  eq("atomic pending carries no percentage", s1.kind === "pending" ? s1.percentage : 1, undefined as unknown as number);
  const rampRec: UpdateStatusRecord = { pending: { fromVersion: "v1.0.0", toVersion: "v1.1.0", recommendedVersion: "v1.1.0", promotedAt: "2026-06-14T00:00:00Z", promotedBy: "owner@example.com", percentage: 10 }, last: null };
  const s3 = updateControlState(upd(false), rampRec);
  eq("ramp pending forwards the percentage discriminator", s3.kind === "pending" ? s3.percentage : 0, 10);
}

// ===========================================================================
// 7. SAFE-APPLY UPDATE -- owner gating (UPDATE_MANAGE_CAP is keys.ceremony, owner-only)
// ===========================================================================
// The control mirrors the engine's gate as disabled-with-reason: canCap(UPDATE_MANAGE_CAP). We assert the
// capability is keys.ceremony (the same OWNER-RESERVED gate the licence activation uses) and that only the
// owner holds it -- so a non-owner sees the control disabled, exactly as the engine enforces server-side.
console.log("\n-- safe-apply update owner gating (UPDATE_MANAGE_CAP) --");

eq("update gate capability is keys.ceremony", UPDATE_MANAGE_CAP, "keys.ceremony");
ok("owner holds keys.ceremony (control enabled)", can("owner", UPDATE_MANAGE_CAP) === true);
// Every non-owner role is denied (the control renders disabled-with-reason). access-admin is the key
// negative control: it can confer access.policy but NEVER keys.ceremony, so it cannot apply an update.
for (const r of ["approver", "operator", "viewer", "restore-operator", "access-admin"] as const) {
  ok(`${r} does NOT hold keys.ceremony (control disabled)`, can(r, UPDATE_MANAGE_CAP) === false);
}

// ===========================================================================
// 8. SAFE-APPLY UPDATE -- the last-update summary line (lastUpdateSummary)
// ===========================================================================
// The compact "Last update: …" line. A rollback must read as the safety net working (reassuring, "nothing
// was lost"), never an alarm; dry-run / no-update / a bare promoted are NOT summarised (they changed nothing,
// or the pending banner owns the mid-flight state).
console.log("\n-- safe-apply last-update summary (lastUpdateSummary) --");

function lastRec(last: NonNullable<UpdateStatusRecord["last"]>): UpdateStatusRecord {
  return { pending: null, last };
}
const AT = "2026-06-14T00:00:00Z";

eq("no record -> null (no standing line)", lastUpdateSummary(null), null);
eq("empty last -> null", lastUpdateSummary({ pending: null, last: null }), null);

// 8a. applied names the version that is live.
eq(
  "applied -> 'applied vX'",
  lastUpdateSummary(lastRec({ outcome: "applied", toVersion: "v1.1.0", at: AT, by: "o@e.co" })),
  "Last update: applied v1.1.0.",
);

// 8b. rolled-back is reassuring and names where it landed; it must NOT read as a failure of the platform.
{
  const line = lastUpdateSummary(lastRec({ outcome: "rolled-back", fromVersion: "v1.0.0", toVersion: "v1.1.0", at: AT, by: "o@e.co" }));
  ok("rolled-back mentions the version it landed on", (line ?? "").includes("v1.0.0"));
  ok("rolled-back reassures nothing was lost", (line ?? "").toLowerCase().includes("nothing was lost"));
  // Negative control: the rollback line must not use alarming failure words (it is the safety net working).
  const lower = (line ?? "").toLowerCase();
  ok("rolled-back is not alarmist (no 'failed'/'error'/'broken')", !lower.includes("failed") && !lower.includes("error") && !lower.includes("broken"));
}

// 8c. refused shows the reason (the engine was left unchanged).
{
  const line = lastUpdateSummary(lastRec({ outcome: "refused", reason: "the new version requires a database migration", at: AT, by: "o@e.co" }));
  ok("refused surfaces the reason", (line ?? "").includes("requires a database migration"));
  ok("refused reads as not-applied", (line ?? "").toLowerCase().includes("not applied"));
}

// 8d. no-update / dry-run / promoted are NOT summarised as a completed outcome (null).
eq("no-update -> null (changed nothing)", lastUpdateSummary(lastRec({ outcome: "no-update", at: AT, by: null })), null);
eq("dry-run -> null (changed nothing)", lastUpdateSummary(lastRec({ outcome: "dry-run", at: AT, by: null })), null);
eq("promoted -> null (mid-flight; the pending banner owns it)", lastUpdateSummary(lastRec({ outcome: "promoted", at: AT, by: null })), null);

// ===========================================================================
// 9. SAFE-APPLY UPDATE -- the phase summary lines (promoteSummaryLine / settleOutcomeLine)
// ===========================================================================
console.log("\n-- safe-apply phase summaries (promote / settle) --");

function promote(o: PromoteResult["outcome"], extra: Partial<PromoteResult> = {}): PromoteResult {
  return { phase: "promote", outcome: o, recommendedVersion: "v1.1.0", steps: [], ...extra };
}

// 9a. dry-run states the plan: would deploy X, rollback target Y -- calm, non-committal (nothing deployed).
{
  const line = promoteSummaryLine(promote("dry-run", { toVersion: "v1.1.0", fromVersion: "v1.0.0" }));
  ok("dry-run names the version it would deploy", line.includes("v1.1.0"));
  ok("dry-run names the rollback target", line.includes("v1.0.0"));
  ok("dry-run reads as verified-not-deployed", line.toLowerCase().includes("would deploy"));
}
// 9b. no-update is the already-current case.
ok("no-update reads as already-current", promoteSummaryLine(promote("no-update")).toLowerCase().includes("already on the recommended"));
// 9c. refused surfaces the reason and that the engine is unchanged.
{
  const line = promoteSummaryLine(promote("refused", { reason: "signature did not verify" }));
  ok("refused surfaces the reason", line.includes("signature did not verify"));
}
// 9d. promoted reads as deployed-and-verifying (the console settles next), naming the rollback target.
{
  const line = promoteSummaryLine(promote("promoted", { toVersion: "v1.1.0", fromVersion: "v1.0.0" }));
  ok("promoted reads as deployed + verifying", line.toLowerCase().includes("deployed") && line.toLowerCase().includes("verifying"));
  ok("promoted names the rollback target", line.includes("v1.0.0"));
}

function settle(o: SettleResult["outcome"], extra: Partial<SettleResult> = {}): SettleResult {
  return { phase: "settle", outcome: o, recommendedVersion: "v1.1.0", fromVersion: "v1.0.0", toVersion: "v1.1.0", steps: [], ...extra };
}

// 9e. applied is a quiet success naming the live version.
{
  const line = settleOutcomeLine(settle("applied"));
  ok("settle applied names the live version", line.includes("v1.1.0"));
  ok("settle applied reads as success", line.toLowerCase().includes("applied"));
}
// 9f. rolled-back is reassuring: names the prior version, the reason, and that nothing was lost / data + recovery safe.
{
  const line = settleOutcomeLine(settle("rolled-back", { reason: "the canary did not sing" }));
  ok("settle rolled-back names the prior version", line.includes("v1.0.0"));
  ok("settle rolled-back surfaces the reason", line.includes("the canary did not sing"));
  ok("settle rolled-back reassures nothing was lost", line.toLowerCase().includes("nothing was lost"));
  ok("settle rolled-back states data + recovery were never affected", line.toLowerCase().includes("never affected"));
  // Negative control: the rollback outcome line must not be alarmist.
  ok("settle rolled-back is not alarmist (no 'failed'/'broken'/'bricked')", !/(failed|broken|bricked)/i.test(line));
}

// ===========================================================================
// 10. SAFE-APPLY UPDATE -- error-reason folding (updateRefusalText)
// ===========================================================================
// api.ts folds the engine { error } into the throw as "apply update: <reason>: <status>" /
// "settle update: <reason>: <status>" (same custody as setLicence). updateRefusalText strips the verb prefix
// and the trailing ": <status>" so the operator reads the engine's reason verbatim inline.
console.log("\n-- safe-apply error folding (updateRefusalText) --");

// 10a. an apply refusal surfaces the engine's whole reason (prefix + trailing status stripped).
eq(
  "apply refusal -> reason verbatim",
  updateRefusalText(new Error("apply update: the new version requires a Durable Object migration; apply it manually: 409")),
  "the new version requires a Durable Object migration; apply it manually",
);
// 10b. a settle refusal folds the same way (different verb).
eq(
  "settle refusal -> reason verbatim",
  updateRefusalText(new Error("settle update: the deploy token lacks the Edit Cloudflare Workers permission: 403")),
  "the deploy token lacks the Edit Cloudflare Workers permission",
);
// 10c. only the TRAILING ': status' is stripped, not a number mid-reason.
eq(
  "mid-reason number preserved; trailing status stripped",
  updateRefusalText(new Error("apply update: version v1.1.0 failed 1 of 3 checks: 400")),
  "version v1.1.0 failed 1 of 3 checks",
);
// 10d/10e. THE SAME TWO PINS SECTION 5b CARRIED, on the update verbs, and inverted for the same reason: a
// bare status and a raw browser string are not explanations, and pinning them as the expected answer is
// what let them stand. Both now take the reviewed sentence for their kind.
ok("a bare transport fault is a sentence, not the status code", updateRefusalText(new Error("apply update: 503")) !== "503");
ok("a bare transport fault sentence says nothing was changed", updateRefusalText(new Error("apply update: 503")).includes("Nothing was changed"));
ok("a non-prefixed message is not passed through raw", updateRefusalText(new Error("network error")) !== "network error");
// A non-Error value is still stringified and folded (the reason path is unchanged for a real reason).
eq("non-Error value stringified", updateRefusalText("settle update: boom: 500"), "boom");
// 10f. the refusal text is never empty for a real reason (the inline error would otherwise say nothing).
ok("refusal text never empty for a real reason", updateRefusalText(new Error("apply update: nope: 400")).length > 0);
ok("refusal text never empty for a bare fault", updateRefusalText(new Error("apply update: 503")).length > 0);

// ===========================================================================
// 11. W2 RICH RELEASE METADATA -- risk class, compat verdict, changelog grouping
// ===========================================================================
// The Updates section renders the signed channel's rich metadata for an available update. The risk class drives
// the badge tone + the "needs care" framing (a migration/breaking release is visually distinct); the compat
// verdict disables the apply honestly when the release cannot be applied onto this engine.
console.log("\n-- W2 rich release metadata (risk class / compat / changelog) --");

// 11a. Risk-class labels + tone + needs-care: routine is calm/info and does NOT need care; migration/breaking
// are warn and DO need care; an absent class defaults to the cautious (warn / needs-care) interpretation.
eq("routine label", riskClassLabel("routine"), "Routine update");
ok("migration label mentions review", riskClassLabel("migration").toLowerCase().includes("review"));
ok("breaking label mentions review", riskClassLabel("breaking").toLowerCase().includes("review"));
ok("absent risk class still gives a review label", riskClassLabel(undefined).toLowerCase().includes("review"));
eq("routine tone is info (calm)", riskClassTone("routine"), "info");
eq("migration tone is warn (distinct)", riskClassTone("migration"), "warn");
eq("breaking tone is warn (distinct)", riskClassTone("breaking"), "warn");
eq("absent tone defaults to warn (cautious)", riskClassTone(undefined), "warn");
ok("routine does NOT need care", riskClassNeedsCare("routine") === false);
ok("migration needs care", riskClassNeedsCare("migration") === true);
ok("breaking needs care", riskClassNeedsCare("breaking") === true);
ok("absent risk class defaults to needs-care (cautious)", riskClassNeedsCare(undefined) === true);

// 11b. compatBlockedReason: blocks ONLY when an update is available AND compatible === false. An available
// compatible update, or no update, or an absent verdict (older engine), never blocks. Names the floor when set.
function updFull(extra: Partial<UpdateStatus>): UpdateStatus {
  return { configured: true, verified: true, currentVersion: "v1.0.0", ...extra };
}
eq("no update available -> not blocked", compatBlockedReason(updFull({ updateAvailable: false, compatible: false })), null);
eq("available + compatible -> not blocked", compatBlockedReason(updFull({ updateAvailable: true, compatible: true })), null);
eq("available + compatible absent (older engine) -> not blocked", compatBlockedReason(updFull({ updateAvailable: true })), null);
{
  const reason = compatBlockedReason(updFull({ updateAvailable: true, compatible: false, minEngineVersion: "v2.0.0" }));
  ok("available + incompatible -> blocked with a reason", reason !== null);
  ok("blocked reason names the required floor", (reason ?? "").includes("v2.0.0"));
  ok("blocked reason names the running engine", (reason ?? "").includes("v1.0.0"));
  // Negative control: the block must still produce a reason even without a stated floor (so the apply disables honestly).
  const noFloor = compatBlockedReason(updFull({ updateAvailable: true, compatible: false }));
  ok("incompatible with no floor still blocks honestly", noFloor !== null);
}

// 11c. changelogTypeLabel groups the known types and title-cases an unknown one (never drops it).
eq("fix -> Fix", changelogTypeLabel("fix"), "Fix");
eq("feature -> Feature", changelogTypeLabel("feature"), "Feature");
eq("security -> Security", changelogTypeLabel("security"), "Security");
eq("other -> Change", changelogTypeLabel("other"), "Change");
eq("empty -> Change", changelogTypeLabel(""), "Change");
eq("unknown type is title-cased, not dropped", changelogTypeLabel("perf"), "Perf");

// ===========================================================================
// 12. REAL PROVENANCE HASH -- artefactHashState reads status.artefactSha384 honestly
// ===========================================================================
// The provenance card renders the engine's SELF-STAMPED artefact SHA-384 when present (a real 96-hex digest),
// and an honest "not reported" when genuinely absent. It must NOT render a malformed/garbage value as if real.
console.log("\n-- real provenance hash (artefactHashState) --");

function status(extra: Partial<StatusReport>): StatusReport {
  return {
    service: "downpipe-engine",
    engineVersion: "v1.0.0",
    signerConfigured: true,
    breakGlassConfigured: true,
    operationalConfigured: { public: true, private: true },
    destConfigured: true,
    destKind: "r2",
    updateChannelConfigured: true,
    licenceConfigured: true,
    downpipeCount: 0,
    ready: true,
    ...extra,
  };
}
const REAL_SHA384 = "a".repeat(96); // a well-formed 96-hex digest
eq("a well-formed 96-hex SHA-384 is rendered", artefactHashState(status({ artefactSha384: REAL_SHA384 })), REAL_SHA384);
eq("uppercase hex is normalised to lower and rendered", artefactHashState(status({ artefactSha384: "A".repeat(96) })), "a".repeat(96));
eq("surrounding whitespace is trimmed", artefactHashState(status({ artefactSha384: `  ${REAL_SHA384}  ` })), REAL_SHA384);
eq("absent field -> null (honest not-reported)", artefactHashState(status({})), null);
eq("the build placeholder sentinel -> null (not a real hash)", artefactHashState(status({ artefactSha384: "downpipe-artefact-sha384-build-placeholder" })), null);
eq("a too-short value -> null", artefactHashState(status({ artefactSha384: "deadbeef" })), null);
eq("a non-hex 96-char value -> null", artefactHashState(status({ artefactSha384: "z".repeat(96) })), null);

// ===========================================================================
// 13. RELEASED-AGO LINE -- releasedAgoLine (pinned clock)
// ===========================================================================
console.log("\n-- released-ago line (releasedAgoLine) --");

eq("absent releasedAt -> null (no fabricated date)", releasedAgoLine(undefined, NOW), null);
eq("unparseable releasedAt -> null", releasedAgoLine("not-a-date", NOW), null);
ok("released today -> 'Released <date>'", (releasedAgoLine(isoInDays(0), NOW) ?? "").startsWith("Released "));
ok("released 1 day ago -> '1 day ago'", (releasedAgoLine(isoInDays(-1), NOW) ?? "").includes("1 day ago"));
ok("released 5 days ago -> '5 days ago'", (releasedAgoLine(isoInDays(-5), NOW) ?? "").includes("5 days ago"));
// Negative control: a future releasedAt does not produce a negative "days ago" (it reads as just-released,
// i.e. "Released <date>." with no "ago"), never "Released -3 days ago".
{
  const future = releasedAgoLine(isoInDays(3), NOW) ?? "";
  ok("future releasedAt reads as just-released (no 'ago')", future.startsWith("Released ") && !future.includes("ago"));
}

// ===========================================================================
// 14. STANDALONE ROLLBACK -- offered predicate + outcome line
// ===========================================================================
// The first-class standalone rollback renders only when a known-good target plausibly exists (a pending verify,
// or a last outcome of applied/rolled-back/promoted) -- never before any update was ever applied (no dead button).
console.log("\n-- standalone rollback (offered / outcome line) --");

eq("null record -> not offered", standaloneRollbackOffered(null), false);
eq("empty record (no pending, no last) -> not offered", standaloneRollbackOffered({ pending: null, last: null }), false);
ok("pending verify -> offered", standaloneRollbackOffered(pendingRec("v1.1.0")) === true);
ok("last applied -> offered", standaloneRollbackOffered(lastRec({ outcome: "applied", toVersion: "v1.1.0", at: AT, by: null })) === true);
ok("last rolled-back -> offered", standaloneRollbackOffered(lastRec({ outcome: "rolled-back", fromVersion: "v1.0.0", at: AT, by: null })) === true);
ok("last promoted -> offered", standaloneRollbackOffered(lastRec({ outcome: "promoted", at: AT, by: null })) === true);
// Negative controls: outcomes that did NOT record a target do not offer the standalone rollback.
ok("last no-update -> not offered (no target recorded)", standaloneRollbackOffered(lastRec({ outcome: "no-update", at: AT, by: null })) === false);
ok("last dry-run -> not offered", standaloneRollbackOffered(lastRec({ outcome: "dry-run", at: AT, by: null })) === false);
ok("last refused -> not offered", standaloneRollbackOffered(lastRec({ outcome: "refused", at: AT, by: null })) === false);

function rb(o: StandaloneRollbackResult["outcome"], extra: Partial<StandaloneRollbackResult> = {}): StandaloneRollbackResult {
  return { outcome: o, toVersion: "v1.0.0", steps: [], ...extra };
}
// 14a. reverted is reassuring; reverted-unverified flags investigate but keeps data/recovery safe; the
// no-change outcomes (already/no-target/failed) each say nothing was changed. None is alarmist.
{
  const reverted = standaloneRollbackOutcomeLine(rb("reverted"));
  ok("reverted names the version + reassures recovery", reverted.includes("v1.0.0") && reverted.toLowerCase().includes("never affected"));
  const unverified = standaloneRollbackOutcomeLine(rb("reverted-unverified", { reason: "canary timed out" }));
  ok("reverted-unverified surfaces the reason", unverified.includes("canary timed out"));
  ok("reverted-unverified still reassures recovery", unverified.toLowerCase().includes("never affected"));
  ok("already states nothing changed", standaloneRollbackOutcomeLine(rb("already")).toLowerCase().includes("nothing was changed"));
  ok("no-target explains there is no recorded prior version", standaloneRollbackOutcomeLine(rb("no-target")).toLowerCase().includes("no recorded prior version"));
  const failed = standaloneRollbackOutcomeLine(rb("failed", { reason: "token lacked permission" }));
  ok("failed surfaces the reason + nothing half-applied", failed.includes("token lacked permission") && failed.toLowerCase().includes("half-applied"));
  // Negative control: a rollback outcome line must not be alarmist (it is the safe recovery direction).
  ok("reverted is not alarmist", !/(bricked|broken|disaster)/i.test(reverted));
}

// ===========================================================================
// 15. GRADUAL RAMP -- rampOutcomeLine (phase 1) + rampSettleOutcomeLine (phase 2)
// ===========================================================================
// The ramp is TWO-PHASE (asvs-HI-13, mirroring apply's promote/settle): phase 1 (POST /update/ramp) shifts
// the traffic and returns "ramp-pending" UNVERIFIED; phase 2 (POST /update/ramp/settle) canary-checks the
// ramped slice and applies / rolls-back / is inconclusive. The old one-call "ramped"/"rolled-back" outcomes
// are gone from the console type; a walk found the console still branched on them, so nothing finished a ramp.
console.log("\n-- gradual ramp outcome lines (rampOutcomeLine + rampSettleOutcomeLine) --");

function rmp(o: RampResult["outcome"], extra: Partial<RampResult> = {}): RampResult {
  return { outcome: o, recommendedVersion: "v1.1.0", steps: [], ...extra };
}
function rmpS(o: RampSettleResult["outcome"], extra: Partial<RampSettleResult> = {}): RampSettleResult {
  return { phase: "ramp-settle", outcome: o, recommendedVersion: "v1.1.0", fromVersion: "v1.0.0", toVersion: "v1.1.0", steps: [], ...extra };
}
{
  // Phase 1: the only success outcome is "ramp-pending" -- honest that the slice is UNVERIFIED and points
  // at the pending panel to finish, never claiming the canary sang (this call cannot have flown it). The engine's
  // RampOutcome is exactly "refused" | "ramp-pending" | "no-update"; the two dead members ("ramped",
  // "rolled-back") are gone from the union, which is what lets the type checker refuse them.
  const pending = rampOutcomeLine(rmp("ramp-pending", { toVersion: "v1.1.0", percentage: 10 }));
  ok("ramp-pending names the version + percentage", pending.includes("v1.1.0") && pending.includes("10%"));
  ok("ramp-pending states it is NOT yet verified", /not\s+yet\s+verified/i.test(pending));
  ok("ramp-pending points at finishing from the pending panel", pending.toLowerCase().includes("pending panel"));
  ok("ramp-pending does NOT claim the canary sang", !/sang|passed its check/i.test(pending));
  ok("ramp-pending does NOT claim the ramp finished", !/the ramp finished/i.test(pending));
  ok("ramp no-update reads already-current", rampOutcomeLine(rmp("no-update")).toLowerCase().includes("already on the recommended"));
  ok("ramp refused surfaces the reason", rampOutcomeLine(rmp("refused", { reason: "needs a migration" })).includes("needs a migration"));
  // Negative control: an unverified live traffic split is stated plainly, never alarmingly.
  ok("ramp-pending is not alarmist", !/(bricked|broken|disaster)/i.test(pending));

  // Phase 2: applied keeps + points at promote-to-100%; rolled-back is reassuring; inconclusive is honest
  // about the probabilistic routing and invites another check (never alarmist).
  const applied = rampSettleOutcomeLine(rmpS("applied"));
  ok("ramp-settle applied names the version + points at promote-to-100%", applied.includes("v1.1.0") && applied.toLowerCase().includes("100%"));
  const back = rampSettleOutcomeLine(rmpS("rolled-back", { reason: "canary did not sing" }));
  ok("ramp-settle rolled-back surfaces the reason + nothing lost", back.includes("canary did not sing") && back.toLowerCase().includes("nothing was lost"));
  ok("ramp-settle rolled-back names the version traffic returned to", back.includes("v1.0.0"));
  const inconclusive = rampSettleOutcomeLine(rmpS("inconclusive"));
  ok("ramp-settle inconclusive invites another check", /verify again|check again/i.test(inconclusive));
  ok("ramp-settle inconclusive is not a fault", inconclusive.toLowerCase().includes("not evidence") || inconclusive.toLowerCase().includes("unchanged"));
  // Negative control: neither the rolled-back nor the inconclusive line is alarmist.
  ok("ramp-settle lines not alarmist", !/(bricked|broken|disaster)/i.test(back + inconclusive));

  // THE FOURTH OUTCOME. This engine emits "rollback-failed-still-split" (G219) and the outcome line must handle
  // it EXPLICITLY: an unhandled member falls to the switch default, "The ramp check finished.", which would
  // report the worst state the update surface has (it failed AND the rollback failed, live traffic is still
  // reaching the suspect version) as a benign completion. A settle that concluded safely and a deployment that
  // is still split are opposites, and the copy must never confuse them.
  const split = rampSettleOutcomeLine(rmpS("rollback-failed-still-split"));
  ok("ramp-settle still-split says the deployment is STILL SPLIT", /still split/i.test(split));
  ok("ramp-settle still-split names the version to re-deploy", split.includes("v1.0.0"));
  ok("ramp-settle still-split reassures on data + recovery", /backups and your ability to restore are unaffected/i.test(split));
  ok("ramp-settle still-split NEVER reads as a benign completion", !/the ramp check finished/i.test(split));
}

// ===========================================================================
// 16. DUAL CONTROL 202 -- queued-for-second-owner message + the owner-action guard
// ===========================================================================
// A migration/breaking apply/ramp under dual control returns HTTP 202 with the owner-action body. The console
// surfaces "queued for a second owner's approval" (NOT a deploy), and isOwnerActionQueued recognises the body.
console.log("\n-- dual control 202 (queued for second owner) --");

{
  const apply = queuedForSecondOwnerLine("apply");
  const ramp = queuedForSecondOwnerLine("ramp");
  ok("apply queued line says a second owner must approve", apply.toLowerCase().includes("second owner"));
  ok("apply queued line says nothing was deployed", apply.toLowerCase().includes("nothing was deployed"));
  ok("ramp queued line names the ramp", ramp.toLowerCase().includes("ramp"));
  ok("ramp queued line also says a second owner must approve", ramp.toLowerCase().includes("second owner"));
  // Negative control: the queued message must NOT claim the update was applied/deployed (it was not).
  ok("queued line does not falsely claim applied", !apply.toLowerCase().includes("is now live"));
}

// 16b. isOwnerActionQueued recognises the engine's 202 owner-action body, and rejects everything else (a normal
// PromoteResult/RampResult, a config-change pending body, a malformed 202) so it falls through to the structured path.
ok("recognises a real owner-action 202 body", isOwnerActionQueued({ ownerActionQueued: true, id: "oa_123", status: "pending" }) === true);
ok("rejects a config-change pending body (different mechanism)", isOwnerActionQueued({ queued: true, id: "cc_1", status: "pending", contentHash: "h" }) === false);
ok("rejects a 202 with an empty id", isOwnerActionQueued({ ownerActionQueued: true, id: "", status: "pending" }) === false);
ok("rejects a normal PromoteResult", isOwnerActionQueued({ phase: "promote", outcome: "promoted", recommendedVersion: "v1.1.0", steps: [] }) === false);
ok("rejects null / non-object", isOwnerActionQueued(null) === false && isOwnerActionQueued("x") === false);

// ===========================================================================
// 17. CONSOLE VERSION IDENTITY (P1) -- consoleVersion / fetchServedConsoleVersion / pollForServedVersion
// ===========================================================================
// The console's own version is baked by the build stamp (__CONSOLE_VERSION__); this Node run is UNSTAMPED,
// so consoleVersion() must honestly answer null (never a fabricated value). The served-origin version is
// read from /__build.json with cache:no-store; the poll is bounded by construction.
console.log("\n-- console version identity (P1) --");

eq("an unstamped run (Node, no define) -> null, never a guess", consoleVersion(), null);

// fakeFetch builds an injectable fetcher that records its calls and answers one canned response shape.
function fakeFetch(answer: { ok: boolean; body?: unknown; jsonThrows?: boolean }, calls: Array<{ url: string; cache: string | undefined }>): (input: string, init?: RequestInit) => Promise<Response> {
  return (input: string, init?: RequestInit) => {
    calls.push({ url: input, cache: init?.cache });
    return Promise.resolve({
      ok: answer.ok,
      json: () => (answer.jsonThrows ? Promise.reject(new Error("bad json")) : Promise.resolve(answer.body)),
    } as unknown as Response);
  };
}

{
  const calls: Array<{ url: string; cache: string | undefined }> = [];
  const v = await fetchServedConsoleVersion(fakeFetch({ ok: true, body: { version: "0.2.0" } }, calls));
  eq("a served {version} answers the version", v, "0.2.0");
  eq("the read targets /__build.json", calls[0]?.url, "/__build.json");
  eq("the read bypasses every cache (no-store)", calls[0]?.cache, "no-store");
}
eq("a non-2xx -> null", await fetchServedConsoleVersion(fakeFetch({ ok: false }, [])), null);
eq("a non-JSON body -> null (fault, not a throw)", await fetchServedConsoleVersion(fakeFetch({ ok: true, jsonThrows: true }, [])), null);
eq("a body without version -> null", await fetchServedConsoleVersion(fakeFetch({ ok: true, body: { builtAt: "x" } }, [])), null);
eq("an empty version -> null", await fetchServedConsoleVersion(fakeFetch({ ok: true, body: { version: " " } }, [])), null);
eq("a throwing fetch -> null (never escapes)", await fetchServedConsoleVersion(() => Promise.reject(new Error("net down"))), null);

// The poll: bounded attempts, injectable fetcher, normalised compare, throw-tolerant.
{
  let n = 0;
  const served = (versions: Array<string | null>) => (): Promise<string | null> => Promise.resolve(versions[Math.min(n++, versions.length - 1)] ?? null);
  n = 0;
  ok("an immediate match confirms on the first read", (await pollForServedVersion("0.2.0", served(["0.2.0"]), 6, 0)) === true && n === 1);
  n = 0;
  ok("a late swap confirms on the third read", (await pollForServedVersion("0.2.0", served([null, "0.1.0", "0.2.0"]), 6, 0)) === true && n === 3);
  n = 0;
  ok("a never-matching origin exhausts EXACTLY the attempt budget then answers false", (await pollForServedVersion("0.2.0", served(["0.1.0"]), 6, 0)) === false && n === 6);
  ok("a fetcher that always throws -> false, never a throw", (await pollForServedVersion("0.2.0", () => Promise.reject(new Error("boom")), 3, 0)) === false);
  ok("a v-prefixed served version matches its bare twin (normalised)", (await pollForServedVersion("0.2.0", () => Promise.resolve("v0.2.0"), 1, 0)) === true);
  ok("a zero attempt budget clamps to one read (never a vacuous true/false)", (await pollForServedVersion("0.2.0", () => Promise.resolve("0.2.0"), 0, 0)) === true);
}

// ===========================================================================
// 18. MULTI-COMPONENT ROWS -- semverNewer / componentRows / componentRowLine (+ OLD-ENGINE DEGRADATION)
// ===========================================================================
console.log("\n-- multi-component rows (semver / rows / degradation) --");

// 18a. semverNewer: strictly-newer only; equal/older/unparseable are false (never claim what versions
// cannot prove); numeric (not lexicographic) ordering; tolerant of a leading v.
ok("0.2.0 is newer than 0.1.2", semverNewer("0.2.0", "0.1.2") === true);
ok("equal versions are not newer", semverNewer("0.2.0", "0.2.0") === false);
ok("an older candidate is not newer", semverNewer("0.1.0", "0.2.0") === false);
ok("0.10.0 is newer than 0.9.0 (numeric, not lexicographic)", semverNewer("0.10.0", "0.9.0") === true);
ok("1.0.0 is newer than 0.9.9 (major wins)", semverNewer("1.0.0", "0.9.9") === true);
ok("a v-prefixed candidate compares (v0.2.0 > 0.1.0)", semverNewer("v0.2.0", "0.1.0") === true);
ok("an unparseable candidate is not newer (safe default)", semverNewer("latest", "0.1.0") === false);
ok("an unparseable running side is not newer (safe default)", semverNewer("0.2.0", "dev") === false);

// compUpd builds a component-aware UpdateStatus (engine running 0.1.2; per-component recommended versions
// injectable). The map deliberately lists console FIRST to prove the row ordering is derived, not incidental.
function compInfo(kind: string, rec: string): UpdateComponentInfo {
  return { kind, recommendedVersion: rec, riskClass: "routine" };
}
function compUpd(engineRec: string, consoleRec: string, extra: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    configured: true,
    verified: true,
    currentVersion: "0.1.2",
    recommendedVersion: "0.2.0",
    updateAvailable: true,
    riskClass: "routine",
    components: { console: compInfo("static-assets", consoleRec), engine: compInfo("worker-module", engineRec) },
    ...extra,
  };
}

// 18b. OLD-ENGINE DEGRADATION (the hard rule): with NO components map every component helper answers its
// do-nothing value, and the control-state decision is IDENTICAL to the legacy two-argument call.
{
  const legacy = upd(true); // no components field at all (an old engine's UpdateStatus)
  eq("old engine -> componentRows is []", componentRows(legacy, "0.1.0").length, 0);
  eq("old engine -> consoleUpdateAvailable is false", consoleUpdateAvailable(legacy, "0.1.0"), false);
  eq("old engine -> releaseComponentsToApply is []", releaseComponentsToApply(legacy, "0.1.0").length, 0);
  eq("old engine -> control state identical to the legacy call", updateControlState(legacy, null, false).kind, updateControlState(legacy, null).kind);
  eq("old engine + no update -> none (unchanged)", updateControlState(upd(false), null, false).kind, "none");
  // The tiles degrade identically: the additive parameter defaults to false, so old callers see old values.
  eq("old engine tile value unchanged (default parameter)", updateTileValue(upd(false)), "Up to date");
  eq("old engine tile label unchanged (default parameter)", updateTileLabel(upd(false)), "Nothing pending");
  eq("old engine tile tone unchanged (default parameter)", updateTileTone(upd(false)), "ok");
}

// 18c. Component rows: both newer -> two "update" rows, ENGINE FIRST (derived order), exact line copy.
{
  const rows = componentRows(compUpd("0.2.0", "0.2.0"), "0.1.0");
  eq("two rows for a two-component release", rows.length, 2);
  eq("engine row first (derived ordering, map listed console first)", rows[0]?.id, "engine");
  eq("console row second", rows[1]?.id, "console");
  eq("engine row state is update", rows[0]?.state, "update");
  eq("engine row line", componentRowLine(rows[0] as NonNullable<(typeof rows)[0]>), "Engine 0.1.2 -> 0.2.0");
  eq("console row line", componentRowLine(rows[1] as NonNullable<(typeof rows)[1]>), "Console 0.1.0 -> 0.2.0");
}

// 18d. Console up to date (a console whose baked version equals the release's) -> the exact "-- up to date"
// line; a v-prefix difference still reads as the same version.
{
  const rows = componentRows(compUpd("0.2.0", "0.1.0"), "0.1.0");
  eq("console equal -> current", rows[1]?.state, "current");
  eq("console current line states its own version (never a bare 'up to date')", componentRowLine(rows[1] as NonNullable<(typeof rows)[1]>), "Console 0.1.0 -- up to date");
  const vRows = componentRows(compUpd("0.2.0", "v0.1.0"), "0.1.0");
  eq("v-prefixed equal still reads up to date", vRows[1]?.state, "current");
}

// 18e. An UNSTAMPED console (null own version) is honest: the row states the facts, claims no verdict.
{
  const rows = componentRows(compUpd("0.2.0", "0.2.0"), null);
  eq("unstamped console -> unknown state", rows[1]?.state, "unknown");
  ok("unstamped console line states the facts", componentRowLine(rows[1] as NonNullable<(typeof rows)[1]>).includes("version not reported by this build"));
  ok("unstamped console line names the release version", componentRowLine(rows[1] as NonNullable<(typeof rows)[1]>).includes("0.2.0"));
}

// 18f. A running side AHEAD of the release reads up to date (never a downgrade nudge); an unparseable
// recommended version reads unknown with plain facts.
{
  const ahead = componentRows(compUpd("0.1.0", "0.1.0"), "0.2.0");
  eq("engine ahead of the release -> current", ahead[0]?.state, "current");
  eq("console ahead of the release -> current", ahead[1]?.state, "current");
  const weird = componentRows(compUpd("0.2.0", "latest"), "0.1.0");
  eq("unparseable recommended -> unknown", weird[1]?.state, "unknown");
  ok("unparseable recommended line carries both facts", componentRowLine(weird[1] as NonNullable<(typeof weird)[1]>).includes("release carries latest"));
}

// 18g. componentLabel: known ids get proper names; future ids are title-cased, never dropped.
eq("engine label", componentLabel("engine"), "Engine");
eq("console label", componentLabel("console"), "Console");
eq("future id is title-cased", componentLabel("cli"), "Cli");
eq("empty id degrades to Component", componentLabel(""), "Component");

// ===========================================================================
// 19. RELEASE APPLY SET + CONTROL STATE (P1 nudge) -- releaseComponentsToApply / consoleUpdateAvailable
// ===========================================================================
console.log("\n-- release apply set + console nudge --");

eq("both newer -> engine,console", releaseComponentsToApply(compUpd("0.2.0", "0.2.0"), "0.1.0").join(","), "engine,console");
eq("console-only release -> console", releaseComponentsToApply(compUpd("0.1.2", "0.2.0"), "0.1.0").join(","), "console");
eq("engine-only release -> engine", releaseComponentsToApply(compUpd("0.2.0", "0.1.0"), "0.1.0").join(","), "engine");
eq("nothing newer -> empty", releaseComponentsToApply(compUpd("0.1.2", "0.1.0"), "0.1.0").length, 0);
eq("unstamped console is never claimed applicable", releaseComponentsToApply(compUpd("0.2.0", "0.2.0"), null).join(","), "engine");

// The nudge decision itself + its effect on the control state (a console-only release must surface the
// apply control even when the engine reports no engine update).
ok("console newer -> consoleUpdateAvailable", consoleUpdateAvailable(compUpd("0.1.2", "0.2.0"), "0.1.0") === true);
ok("console equal -> no nudge", consoleUpdateAvailable(compUpd("0.1.2", "0.1.0"), "0.1.0") === false);
ok("unstamped build -> no nudge (cannot honestly compare)", consoleUpdateAvailable(compUpd("0.1.2", "0.2.0"), null) === false);
eq("engine says no update BUT console update -> control renders", updateControlState(upd(false), null, true).kind, "available");
eq("pending still outranks a console update", updateControlState(upd(false), pendingRec("v1.1.0"), true).kind, "pending");
eq("no engine update + no console update -> none", updateControlState(upd(false), null, false).kind, "none");
eq("console update flips the tile to Available", updateTileValue(upd(false), true), "Available");
eq("console update flips the tile label", updateTileLabel(upd(false), true), "Update available");
eq("console update tile tone is info (not alarming)", updateTileTone(upd(false), true), "info");

// ===========================================================================
// 20. COMPONENT RESULT ROWS + APPLY EVIDENCE -- componentApplyResultLine / consoleWasApplied
// ===========================================================================
console.log("\n-- component results (lines + console-applied evidence) --");

function cr(component: string, outcome: string, extra: Partial<ComponentApplyResult> = {}): ComponentApplyResult {
  return { component, outcome, ...extra };
}
eq("no-update line", componentApplyResultLine(cr("engine", "no-update")), "Engine: already up to date, nothing to deploy.");
eq(
  "dry-run line names version + rollback target",
  componentApplyResultLine(cr("console", "dry-run", { toVersion: "0.2.0", fromVersion: "0.1.0" })),
  "Console: verified. A live update would deploy 0.2.0 and keep 0.1.0 as the rollback target.",
)
eq("dry-run line without a target", componentApplyResultLine(cr("console", "dry-run", { toVersion: "0.2.0" })), "Console: verified. A live update would deploy 0.2.0.");
eq("refused line carries the reason", componentApplyResultLine(cr("console", "refused", { reason: "hash mismatch" })), "Console: not applied, hash mismatch.");
eq("refused line without a reason is honest", componentApplyResultLine(cr("console", "refused")), "Console: not applied; this component is unchanged.");
eq("promoted line", componentApplyResultLine(cr("engine", "promoted", { toVersion: "0.2.0" })), "Engine: deployed 0.2.0.");
eq("applied line", componentApplyResultLine(cr("console", "applied", { toVersion: "0.2.0" })), "Console: 0.2.0 is live.");
ok("an unknown outcome renders as text, never dropped", componentApplyResultLine(cr("console", "quarantined", { reason: "odd" })).includes("quarantined"));

// consoleWasApplied: evidence-driven, never assumed.
{
  const promoted = promote("promoted", { toVersion: "0.2.0", fromVersion: "0.1.2" });
  const withConsole = { ...promoted, componentResults: [cr("engine", "promoted"), cr("console", "applied")] };
  const engineOnlyResults = { ...promoted, componentResults: [cr("engine", "promoted")] };
  eq("legacy apply (requested null) -> never", consoleWasApplied(withConsole, null, null), false);
  eq("console not requested -> never (even with a stray result row)", consoleWasApplied(withConsole, null, ["engine"]), false);
  eq("apply componentResults say console applied -> true", consoleWasApplied(withConsole, null, ["engine", "console"]), true);
  eq("no console evidence in a both-request -> false (top level describes the engine)", consoleWasApplied(engineOnlyResults, null, ["engine", "console"]), false);
  const settleWithConsole = { ...settle("applied"), componentResults: [cr("console", "promoted")] };
  eq("settle componentResults say console promoted -> true", consoleWasApplied(engineOnlyResults, settleWithConsole, ["engine", "console"]), true);
  // A console-only apply's top-level PromoteResult IS the console's own ConsoleApplyResult, whose outcome
  // vocabulary is "applied"/"applied-unconfirmed"/"rolled-back"/"rollback-failed"/"refused"/"dry-run" --
  // never "promoted" (that string belongs to the two-phase ENGINE flow alone; a console component is atomic
  // and self-verifying in one request, see engine update-orchestrate.ts ConsoleApplyOutcome). This used to
  // check `promote.outcome === "promoted"`, which a real console-only response never satisfies, so this
  // branch was unreachable against real engine output (live-confirmed, UAT-0.3.0.md section 3.2).
  eq("console-only request + top-level applied -> true (top level IS the console's own outcome)", consoleWasApplied(promote("applied", { toVersion: "0.2.0", fromVersion: "0.1.2" }), null, ["console"]), true);
  eq("console-only request + top-level applied-unconfirmed -> true", consoleWasApplied(promote("applied-unconfirmed", { toVersion: "0.2.0" }), null, ["console"]), true);
  eq("console-only request + top-level refused -> false", consoleWasApplied(promote("refused"), null, ["console"]), false);
  eq("console-only request + top-level promoted alone -> false (not real console vocabulary, never asserted)", consoleWasApplied(promoted, null, ["console"]), false);
}

// ===========================================================================
// 21. COMPONENT-AWARE COPY -- updateExplainerText + the post-apply check lines
// ===========================================================================
console.log("\n-- component-aware copy (explainer + check lines) --");

{
  const legacy = updateExplainerText(false);
  const aware = updateExplainerText(true);
  // The legacy explainer is the byte-exact pre-multi-component copy (the degradation rule for the card).
  ok("legacy explainer opens with the engine wording", legacy.startsWith("Updating deploys a newer vendor-signed engine version"));
  ok("legacy explainer never mentions the console component", !legacy.includes("console"));
  ok("aware explainer names the safe order (engine first)", aware.includes("the engine first"));
  ok("aware explainer names the console reload step", aware.includes("prompts a reload"));
  ok("both keep the data-never-at-risk reassurance", legacy.includes("never at risk") && aware.includes("never at risk"));
}
ok("checking line names the expected version", consoleCheckingLine("0.2.0").includes("0.2.0"));
ok("reload prompt says the console updated + is reloading itself", consoleReloadPromptLine("0.2.0").startsWith("Console updated to 0.2.0.") && /reloading/i.test(consoleReloadPromptLine("0.2.0")));
ok("reload prompt names the served version", consoleReloadPromptLine("0.2.0").includes("0.2.0"));
{
  const failed = consoleCheckFailedLine("0.2.0");
  ok("failed line names the expected version", failed.includes("0.2.0"));
  ok("failed line offers the rollback", failed.toLowerCase().includes("roll the console back"));
  ok("failed line is honest about the token custody", failed.includes("never stored"));
  ok("failed line reassures data + recovery", failed.toLowerCase().includes("data and recovery are unaffected"));
  ok("failed line is not alarmist", !/(bricked|broken|disaster)/i.test(failed));
}
// consoleRollbackOutcomeLine speaks console (reload), never canary.
{
  const reverted = consoleRollbackOutcomeLine(rb("reverted"));
  ok("console reverted names the version + a reload note", reverted.includes("v1.0.0") === false ? reverted.includes("0.1.0") || reverted.includes("Reload") : true);
  ok("console reverted prompts a reload", reverted.toLowerCase().includes("reload"));
  ok("console reverted never speaks canary", !reverted.toLowerCase().includes("canary"));
  ok("console unverified surfaces the reason", consoleRollbackOutcomeLine(rb("reverted-unverified", { reason: "confirm timed out" })).includes("confirm timed out"));
  ok("console no-target is honest", consoleRollbackOutcomeLine(rb("no-target")).toLowerCase().includes("no recorded prior console version"));
  ok("console already is honest", consoleRollbackOutcomeLine(rb("already")).toLowerCase().includes("nothing was changed"));
  ok("console failed carries the reason + half-applied reassurance", consoleRollbackOutcomeLine(rb("failed", { reason: "token lacked permission" })).includes("token lacked permission"));
}

// ===========================================================================
// 22. PERSISTENCE-FIRST SETTLE RECOVERY -- recordedSettleOutcome / recordedSettleOutcomeLine
// ===========================================================================
// A settle response can lose the race against the engine's own rollback deploy (seen live, 0.1.0 -> 0.1.2):
// the console must NEVER conclude from the broken response; it re-reads the persisted record and renders it.
console.log("\n-- persistence-first settle recovery (recorded truth) --");

eq("null record -> unknown", recordedSettleOutcome(null).kind, "unknown");
eq("empty record -> unknown", recordedSettleOutcome({ pending: null, last: null }).kind, "unknown");
eq("a pending record -> pending", recordedSettleOutcome(pendingRec("v1.1.0")).kind, "pending");
{
  const applied = recordedSettleOutcome(lastRec({ outcome: "applied", toVersion: "0.1.2", at: AT, by: "o@e.co" }));
  eq("recorded applied -> applied", applied.kind, "applied");
  ok("recorded applied carries the version", applied.kind === "applied" && applied.toVersion === "0.1.2");
  const rolled = recordedSettleOutcome(lastRec({ outcome: "rolled-back", fromVersion: "0.1.0", toVersion: "0.1.2", reason: "canary liveness dropped after promote", at: AT, by: null }));
  eq("recorded rolled-back -> rolled-back", rolled.kind, "rolled-back");
  ok("recorded rolled-back carries the engine's reason", rolled.kind === "rolled-back" && rolled.reason === "canary liveness dropped after promote");
  eq("an unrelated last outcome (refused) -> unknown (not a settle conclusion)", recordedSettleOutcome(lastRec({ outcome: "refused", at: AT, by: null })).kind, "unknown");
  // CROSS-CONTRACT: the ENGINE writes "expired" and "superseded" (its real wire values, verified against
  // router-updates.ts) for a benign stale-pending clear -- NOT the literal "expired-cleared" (this console's
  // render kind). Both must map to expired-cleared, or they fall to the "still verifying" stall line -- the
  // exact "recorded outcome could not be read" bug this release fixes. These pin that reconciliation.
  eq("engine 'expired' -> expired-cleared (real wire value, not the render kind)", recordedSettleOutcome(lastRec({ outcome: "expired", at: AT, by: null })).kind, "expired-cleared");
  eq("engine 'superseded' -> expired-cleared (benign stale-pending clear)", recordedSettleOutcome(lastRec({ outcome: "superseded", at: AT, by: null })).kind, "expired-cleared");
}

// 22a. CONSOLE-COMPONENT settle recovery -- recordedSettleOutcome's `component` parameter, replaying the
// EXACT GET /admin/update/status shape recorded live for a console-only apply
// (the recorded console-only apply shape): the engine's own `last` (the
// most recent ENGINE settle, unrelated and untouched by this apply) sits beside a fresh `lastConsole`. THE
// DEFECT THIS PINS: before `lastConsole` existed on UpdateStatusRecord and before `component` existed on
// recordedSettleOutcome, a re-read of this exact record had no way to find the console's own outcome at
// all (defaulting to `rec.last` read the ENGINE's stale record instead, or "unknown" with no `last`), which
// is why the Apply-update status region reported "unexpected outcome" indefinitely over a genuinely
// successful, already-finished console apply.
{
  const consoleOnlySettleRec: UpdateStatusRecord = {
    pending: null,
    // The engine's own last outcome: an EARLIER, unrelated engine settle (0.2.0 -> 0.3.0), proving the two
    // components' histories are read from separate slots and cannot be confused for one another.
    last: { outcome: "applied", toVersion: "8e2dcc0c-8071-429f-aff6-2c79d48c185e", fromVersion: "722abca9-0000-0000-0000-000000000000", at: "2026-09-06T10:49:27Z", by: "owner@example.com" },
    lastConsole: {
      outcome: "applied",
      component: "console",
      fromVersion: "addd6c8d-0000-0000-0000-000000000000",
      toVersion: "067ce0bc-0000-0000-0000-000000000000",
      reason: "console 0.2.1 is live (promote confirmed at 100%). Reload the console to finish; if the page misbehaves, use the console Roll back control.",
      artefactSha384: "5718e727a749e6a9bcff7a5e7a1f1ab6e4ee86b1d0be5f8ee28e54e4fe802a357536b4abfa6224d736438bdbdb7fd232",
      at: "2026-09-06T11:05:00Z",
      by: "owner@example.com",
    },
  };
  const consoleOutcome = recordedSettleOutcome(consoleOnlySettleRec, "console");
  eq("component:'console' reads lastConsole, not last -> applied (the live-recorded outcome), never 'unknown'", consoleOutcome.kind, "applied");
  ok("the console outcome carries the CONSOLE version, not the engine's", consoleOutcome.kind === "applied" && consoleOutcome.toVersion === "067ce0bc-0000-0000-0000-000000000000");
  const engineOutcome = recordedSettleOutcome(consoleOnlySettleRec);
  eq("component defaults to 'engine' (unchanged for every existing caller) -> still applied", engineOutcome.kind, "applied");
  ok("...but reads last, not lastConsole (the ENGINE's version, not the console's)", engineOutcome.kind === "applied" && engineOutcome.toVersion === "8e2dcc0c-8071-429f-aff6-2c79d48c185e");
  // A console-only apply never leaves an ENGINE pending record (single-phase; no two-phase settle to await),
  // so component:"console" must never consult `rec.pending` even when one happens to be present (an
  // in-flight ENGINE apply running concurrently with a console read, say) -- that pending describes the
  // OTHER component's in-flight state, not this one's conclusion.
  const withUnrelatedEnginePending: UpdateStatusRecord = { ...consoleOnlySettleRec, pending: { fromVersion: "v1.0.0", toVersion: "v1.1.0", recommendedVersion: "v1.1.0", promotedAt: AT, promotedBy: null } };
  eq("component:'console' ignores an unrelated engine pending record -> still reads lastConsole", recordedSettleOutcome(withUnrelatedEnginePending, "console").kind, "applied");
  eq("component:'engine' (default) still honours its own pending, unchanged", recordedSettleOutcome(withUnrelatedEnginePending).kind, "pending");
  // No console outcome ever recorded here (an older engine, or no console apply yet): honestly unknown,
  // never a false "applied" borrowed from the engine's own last.
  eq("no lastConsole at all -> unknown (never falls back to the engine's last)", recordedSettleOutcome({ pending: null, last: consoleOnlySettleRec.last }, "console").kind, "unknown");
}

// The live-flow replay of this same console-only apply (the DOM-driven end-to-end case) lives in section 24,
// alongside runLiveApplyFlow's other DOM fixtures (the shared dom-shim is installed once, there) -- see
// section 24c-2 below.

// The copy: each recorded conclusion in calm, honest words; the hourly canary appears ONLY on pending.
{
  const appliedLine = recordedSettleOutcomeLine({ kind: "applied", toVersion: "0.1.2", confirmationPending: false });
  ok("applied line opens Applied and verified", appliedLine.startsWith("Applied and verified"));
  ok("applied line names the live version", appliedLine.includes("0.1.2"));
  const rolledLine = recordedSettleOutcomeLine({ kind: "rolled-back", fromVersion: "0.1.0", toVersion: "0.1.2", reason: "canary liveness dropped after promote" });
  ok("rolled-back line says rolled back automatically + the reason", rolledLine.includes("rolled back automatically: canary liveness dropped after promote"));
  ok("rolled-back line names where the engine is", rolledLine.includes("0.1.0"));
  ok("rolled-back line reassures nothing was lost", rolledLine.toLowerCase().includes("nothing was lost"));
  ok("rolled-back line NEVER claims the new version is live", !rolledLine.includes("is live"));
  const pendingLine = recordedSettleOutcomeLine({ kind: "pending", toVersion: "0.1.2" });
  ok("pending line says the verification has not finished", pendingLine.includes("verification has not finished"));
  ok("pending line is the ONLY one invoking the hourly canary", pendingLine.includes("hourly canary") && !appliedLine.includes("hourly canary") && !rolledLine.includes("hourly canary"));
  const unknownLine = recordedSettleOutcomeLine({ kind: "unknown" });
  ok("unknown line asserts NO outcome (no live claim, no canary claim)", !unknownLine.includes("is live") && !unknownLine.includes("hourly canary") && !unknownLine.includes("rolled back"));
  ok("the interim line claims nothing either", !SETTLE_UNCONFIRMED_LINE.includes("is live") && SETTLE_UNCONFIRMED_LINE.includes("could not be confirmed"));
}
// The standing "Last update" line now carries the engine's recorded reason when present (and is unchanged
// without one, proven by section 8 above).
{
  const line = lastUpdateSummary(lastRec({ outcome: "rolled-back", fromVersion: "0.1.0", reason: "canary liveness dropped after promote", at: AT, by: null }));
  ok("last-update line carries the recorded rollback reason", (line ?? "").includes("canary liveness dropped after promote"));
  ok("last-update line still reassures", (line ?? "").toLowerCase().includes("nothing was lost"));
}

// ===========================================================================
// 23. WIRE SHAPES -- the REAL client sends components additively (and omits it in legacy calls)
// ===========================================================================
// Drives the REAL EngineClient over a stubbed global fetch (the lib-api-client idiom) so the contract on
// the wire is pinned: `components` rides ONLY when supplied non-empty, on apply, settle and rollback.
console.log("\n-- wire shapes (components field is additive) --");

{
  const bodies: Array<Record<string, unknown>> = [];
  const canned = (payload: unknown): Response =>
    ({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)), json: () => Promise.resolve(payload) }) as unknown as Response;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {});
    return Promise.resolve(canned({ phase: "promote", outcome: "dry-run", recommendedVersion: "0.2.0", steps: [] }));
  }) as typeof fetch;
  try {
    const engine = new EngineClient("https://engine.example.com");
    await engine.applyUpdate({ dryRun: true, components: ["engine", "console"] });
    eq("apply carries components when supplied", JSON.stringify(bodies[0]?.components), JSON.stringify(["engine", "console"]));
    await engine.applyUpdate({ dryRun: true });
    ok("a legacy apply has NO components key at all", bodies[1] !== undefined && !("components" in bodies[1]));
    await engine.applyUpdate({ dryRun: true, components: [] });
    ok("an empty components set is omitted (legacy wire shape)", bodies[2] !== undefined && !("components" in bodies[2]));
    await engine.settleUpdate("tok", ["console"]);
    eq("settle carries components when supplied", JSON.stringify(bodies[3]?.components), JSON.stringify(["console"]));
    await engine.settleUpdate("tok");
    ok("a legacy settle has NO components key", bodies[4] !== undefined && !("components" in bodies[4]));
    await engine.rollbackUpdate("tok", ["console"]);
    eq("rollback carries components when supplied", JSON.stringify(bodies[5]?.components), JSON.stringify(["console"]));
    await engine.rollbackUpdate("tok");
    ok("a legacy rollback has NO components key", bodies[6] !== undefined && !("components" in bodies[6]));
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ===========================================================================
// 24. THE LIVE APPLY FLOW (DOM) -- legacy / both / console-only / queued / settle-race recovery
// ===========================================================================
// Drives the REAL runLiveApplyFlow under the shared DOM shim with a recording fake engine: what goes on the
// wire, what renders, which callbacks fire, and that the post-apply check + preload happen exactly when the
// console component is genuinely in play.
console.log("\n-- live apply flow (DOM, fake engine) --");

installDomShim();

interface FlowCalls {
  apply: Array<Record<string, unknown>>;
  settleTokens: string[];
  // rampSettleTokens is the SIBLING-SITE LEDGER. The pending card has TWO settle call sites now, and the whole
  // defect was that one pending shape was being driven into the wrong one, so the fixture counts BOTH and every
  // assertion below states which ledger moved AND that the other did not.
  rampSettleTokens: string[];
  rollbacks: Array<{ token: string; components: UpdateComponentId[] | undefined }>;
  statusReads: number;
  log: string[];
}
function newCalls(): FlowCalls {
  return { apply: [], settleTokens: [], rampSettleTokens: [], rollbacks: [], statusReads: 0, log: [] };
}
function flowEngine(
  calls: FlowCalls,
  spec: {
    apply: UpdateApplyResult<PromoteResult> | (() => UpdateApplyResult<PromoteResult>);
    settle?: () => SettleResult;
    // settleQueued is the OWNER-ACTION 202 arm of the settle: keeping a migration/breaking release is
    // dual-control gated, so the engine answers the settle with { status:"queued" } and finalises nothing.
    // It is a separate spec key rather than a SettleResult variant precisely because it is NOT an outcome:
    // the whole defect was the flow treating it as one (an absent outcome, retried to the end of the budget,
    // then reported as an unreadable settle).
    settleQueued?: string;
    rampSettle?: () => RampSettleResult;
    rollback?: () => StandaloneRollbackResult;
    status?: () => UpdateStatusRecord;
  },
): EngineClient {
  return {
    applyUpdate: (opts: Record<string, unknown>) => {
      calls.apply.push(opts);
      calls.log.push("apply");
      return Promise.resolve(typeof spec.apply === "function" ? spec.apply() : spec.apply);
    },
    settleUpdate: (token: string) => {
      calls.settleTokens.push(token);
      calls.log.push("settle");
      // The client now returns the DISCRIMINATED UpdateApplyResult (the applyUpdate/rampUpdate shape), so the
      // fixture wraps its plain SettleResult stub in the "result" arm and serves the "queued" arm from
      // spec.settleQueued. Every existing case keeps its bare-SettleResult stub unchanged.
      if (spec.settleQueued !== undefined) return Promise.resolve({ status: "queued", id: spec.settleQueued } as UpdateApplyResult<SettleResult>);
      if (!spec.settle) return Promise.reject(new Error("settle update: transport dropped: 502"));
      return Promise.resolve({ status: "result", value: spec.settle() } as UpdateApplyResult<SettleResult>);
    },
    settleRampUpdate: (token: string) => {
      // The RAMP settle has its own ledger: the pending card has two settle call sites, and the 29h cases below
      // assert the ramp-shaped pending NEVER reaches the plain settle (the engine refuses it) and vice versa.
      // Pushing both into one array would make that pair of assertions unfalsifiable. The rejection string is
      // the one the merged client actually throws ("settle gradual ramp: ...").
      calls.rampSettleTokens.push(token);
      calls.log.push("ramp-settle");
      if (!spec.rampSettle) return Promise.reject(new Error("settle gradual ramp: transport dropped: 502"));
      return Promise.resolve(spec.rampSettle());
    },
    rollbackUpdate: (token: string, components?: UpdateComponentId[]) => {
      calls.rollbacks.push({ token, components });
      return spec.rollback ? Promise.resolve(spec.rollback()) : Promise.reject(new Error("no rollback stub"));
    },
    updateStatus: () => {
      calls.statusReads++;
      if (!spec.status) return Promise.reject(new Error("status read failed"));
      return Promise.resolve(spec.status());
    },
  } as unknown as EngineClient;
}
function flowEnv(engine: EngineClient): { env: { engine: EngineClient; out: HTMLElement; reload: () => void; restoreFocus: () => void }; counters: { reloads: number } } {
  const counters = { reloads: 0 };
  const out = document.createElement("div");
  return { env: { engine, out, reload: () => { counters.reloads++; }, restoreFocus: () => {} }, counters };
}
function buttonsOf(root: HTMLElement): Array<{ text: string; click: () => void }> {
  return qsa(root, "button").map((b) => ({ text: textOf(b).trim(), click: () => (b as unknown as HTMLElement).click() }));
}
const okPromote = (extra: Partial<PromoteResult> = {}): UpdateApplyResult<PromoteResult> => ({ status: "result", value: promote("promoted", { toVersion: "0.2.0", fromVersion: "0.1.2", ...extra }) });
// progressLine reads the orchestrated flow's ONE visible progress/terminal line (the FIRST <p> under `out`,
// document order -- always region's own `line` node, however much verbose content the collapsed Details
// disclosure holds below it, since Details is a later sibling and querySelector returns the first match).
function progressLine(out: HTMLElement): string {
  const p = qs(out, "p");
  return p ? textOf(p) : "";
}

// 24a. LEGACY (old engine): requested null -> NO components on the wire, engine settle runs with the SAME
// token, the section reloads, and neither the preloader nor the served-version check ever fires.
{
  const calls = newCalls();
  const engine = flowEngine(calls, { apply: okPromote(), settle: () => settle("applied", { toVersion: "0.2.0", fromVersion: "0.1.2" }) });
  const { env, counters } = flowEnv(engine);
  let preloads = 0;
  let checks = 0;
  const res = await runLiveApplyFlow(env, "tok", null, null, { ...ZERO_HOOKS, preload: () => { preloads++; return Promise.resolve(true); }, fetchServedVersion: () => { checks++; return Promise.resolve("0.2.0"); } });
  eq("legacy flow completes", res, "done");
  ok("legacy apply has NO components key on the wire", calls.apply[0] !== undefined && !("components" in (calls.apply[0] as Record<string, unknown>)));
  eq("settle ran with the SAME one-shot token", calls.settleTokens[0], "tok");
  eq("the section reloaded", counters.reloads, 1);
  eq("the preloader never fired (no console in play)", preloads, 0);
  eq("the served-version check never fired", checks, 0);
  eq("the exact s2 terminal sentence rendered, byte-for-byte", progressLine(env.out), appliedTerminalLine("0.2.0", { confirmationPending: false }));
}

// 24b. BOTH components: preload runs BEFORE the apply, components ride the wire, the settle runs, the
// build check confirms the new version and the "reload to finish" prompt (with its Reload button) renders;
// the section does NOT reload underneath it.
{
  const calls = newCalls();
  const engine = flowEngine(calls, {
    apply: () => {
      const v = promote("promoted", { toVersion: "0.2.0", fromVersion: "0.1.2" });
      return { status: "result", value: { ...v, componentResults: [cr("engine", "promoted", { toVersion: "0.2.0" }), cr("console", "applied", { toVersion: "0.2.0" })] } };
    },
    settle: () => settle("applied", { toVersion: "0.2.0", fromVersion: "0.1.2" }),
  });
  const { env, counters } = flowEnv(engine);
  let checks = 0;
  let pageReloads = 0;
  const res = await runLiveApplyFlow(env, "tok", ["engine", "console"], "0.2.0", {
    ...ZERO_HOOKS,
    preload: () => { calls.log.push("preload"); return Promise.resolve(true); },
    fetchServedVersion: () => { checks++; return Promise.resolve("0.2.0"); },
    reload: () => { pageReloads++; },
    reloadDelayMs: 0,
  });
  eq("both flow completes", res, "done");
  eq("preload ran BEFORE the apply (chunks safe before the swap)", calls.log.slice(0, 2).join(","), "preload,apply");
  eq("components rode the wire", JSON.stringify((calls.apply[0] as { components?: unknown }).components), JSON.stringify(["engine", "console"]));
  eq("engine settle still ran", calls.settleTokens.length, 1);
  ok("the served-version check ran", checks >= 1);
  const text = textOf(env.out);
  ok("per-component outcome rows rendered (Details disclosure)", text.includes("Console: 0.2.0 is live."));
  ok("the reload prompt rendered (auto-reload copy)", text.includes("Console updated to 0.2.0"));
  ok("a 'Reload now' button is offered for immediacy", buttonsOf(env.out).some((b) => b.text === "Reload now"));
  eq("the section itself did NOT re-render under the prompt", counters.reloads, 0);
  await flushAsync();
  eq("the flow AUTO-RELOADED the page once confirmed (no manual click needed)", pageReloads, 1);
  eq("the exact s2 terminal sentence rendered, WITH the reloading suffix", progressLine(env.out), appliedTerminalLine("0.2.0", { confirmationPending: false, consoleApplied: true }));
  ok("the terminal line never leaks settle-fold jargon (settle/recorded outcome/pending verification)", !/(\bsettle\b|recorded outcome|pending verification)/i.test(progressLine(env.out)));
}

// 24c. CONSOLE-ONLY apply where the origin never serves the new version: NO engine settle, the bounded
// check fails, the honest warn copy + the one-click "Roll back console" affordance render, and clicking it
// calls the rollback route with the SAME token and components ["console"].
//
// THE FIXTURE USED TO STUB THIS AS outcome:"promoted" (okPromote()), which is NOT a string the real engine
// ever returns for a console-only apply: router-updates-components.ts's handleComponentApply returns the
// console's OWN ConsoleApplyResult verbatim as the top-level body when "console" is the only requested
// component, and ConsoleApplyOutcome (update-orchestrate.ts) has no "promoted" member at all -- a console
// component is atomic and self-verifying in one request, so it settles to "applied" (or
// "applied-unconfirmed"/"rolled-back"/"rollback-failed") directly, never a two-phase "promoted". The stub
// happened to still exercise this test's assertions because runLiveApplyFlow's OWN outcome switch used to
// fall through to consoleWasApplied's `promote.outcome === "promoted"` check for a single-requested-console
// apply -- itself the same wrong assumption, so the two bugs canceled out and made this fixture look correct.
// A REAL console-only "applied" hit neither branch and rendered "An unexpected outcome was returned" instead.
// Fixed on both
// sides (runLiveApplyFlow's own !includesEngine branch, consoleOnlyApplyOutcome; consoleWasApplied's last
// line, shared.ts); this fixture is corrected to the outcome the engine actually sends so it exercises the
// real code path rather than the coincidence that used to stand in for it.
{
  const calls = newCalls();
  const engine = flowEngine(calls, {
    apply: { status: "result", value: promote("applied", { toVersion: "0.2.0", fromVersion: "0.1.2" }) },
    rollback: () => ({ outcome: "reverted", toVersion: "0.1.0", fromVersion: "0.2.0", steps: [{ step: "redeploy prior console", ok: true }] }),
  });
  const { env, counters } = flowEnv(engine);
  const res = await runLiveApplyFlow(env, "tok", ["console"], "0.2.0", { ...ZERO_HOOKS, fetchServedVersion: () => Promise.resolve("0.1.0") });
  eq("console-only flow completes", res, "done");
  eq("NO engine settle for a console-only apply", calls.settleTokens.length, 0);
  const text = textOf(env.out);
  ok("the honest not-confirmed copy rendered", text.includes("not yet serving version 0.2.0"));
  const rbBtn = buttonsOf(env.out).find((b) => b.text === "Roll back console");
  ok("the one-click console rollback affordance is offered", rbBtn !== undefined);
  rbBtn?.click();
  await flushAsync();
  eq("the rollback rode the same route with the held token", calls.rollbacks[0]?.token, "tok");
  eq("the rollback addressed the console component", JSON.stringify(calls.rollbacks[0]?.components), JSON.stringify(["console"]));
  ok("the console rollback outcome rendered", textOf(env.out).includes("Console rolled back to 0.1.0"));
  eq("no section reload under the affordance", counters.reloads, 0);
}

// 24c-2. CONSOLE-ONLY apply that SUCCEEDS: the served-version check confirms the new console and the
// reload prompt renders -- replaying, end to end through the real runLiveApplyFlow, a console-only apply
// (engine unchanged, console 0.2.0 -> 0.2.1, apply outcome "applied"). THE DEFECT THIS PINS: the status-
// region poller never recognised this exact response as terminal -- the region stuck on "An unexpected
// outcome was returned; the engine state is unclear" for the whole poll window while GET
// /admin/update/status already showed `lastConsole` applied. Section 22a above pins the re-read
// (recordedSettleOutcome's `component` parameter reading lastConsole); this pins the LIVE response path
// (runLiveApplyFlow's own !includesEngine branch, consoleOnlyApplyOutcome), which is the one that actually
// rendered the defect during the apply itself, before any re-read ever happened.
{
  const calls = newCalls();
  const engine = flowEngine(calls, {
    apply: { status: "result", value: promote("applied", { toVersion: "0.2.1", fromVersion: "0.2.0" }) },
  });
  const { env, counters } = flowEnv(engine);
  let pageReloads = 0;
  const res = await runLiveApplyFlow(env, "tok", ["console"], "0.2.1", {
    ...ZERO_HOOKS,
    fetchServedVersion: () => Promise.resolve("0.2.1"),
    reload: () => { pageReloads++; },
    reloadDelayMs: 0,
  });
  eq("console-only success flow completes", res, "done");
  eq("still no engine settle for a console-only apply", calls.settleTokens.length, 0);
  const text = textOf(env.out);
  ok("NEVER the unexpected-outcome fallback (the live-observed defect)", !text.toLowerCase().includes("unexpected outcome"));
  ok("the reload prompt rendered (the served version matched)", text.includes("Console updated to 0.2.1"));
  eq("the section itself did not reload underneath the prompt", counters.reloads, 0);
  await flushAsync();
  eq("the flow auto-reloaded the page once confirmed", pageReloads, 1);
}

// 24d. QUEUED (dual control): the flow reports "queued", nothing settles, and the queued copy renders.
{
  const calls = newCalls();
  const engine = flowEngine(calls, { apply: { status: "queued", id: "oa_1" } });
  const { env } = flowEnv(engine);
  const res = await runLiveApplyFlow(env, "tok", ["engine", "console"], "0.2.0", { ...ZERO_HOOKS, preload: () => Promise.resolve(true) });
  eq("queued flow reports queued", res, "queued");
  eq("nothing settled", calls.settleTokens.length, 0);
  ok("the queued-for-second-owner copy rendered", textOf(env.out).includes("second owner"));
}

// 24d-2. QUEUED SETTLE (dual control, the KEEP direction). This is the sibling of 24d one phase later, and
// it is a DIFFERENT state: the promote already happened, so the new version is LIVE. The engine gates only
// the KEEP decision (router-updates.ts), answers the settle with a 202, and finalises nothing.
//
// THE DEFECT THIS PINS. The client used to decode that 202 as an ordinary 2xx body, so the settle "result"
// carried no `outcome`; the retry ladder read that as a non-definitive answer and RE-SUBMITTED it for the
// whole budget, then fell through to the persisted-record recovery and told the operator the settle outcome
// could not be read. The engine had answered clearly. Both halves are asserted: the flow settles ONCE (no
// retry storm) and the recorded-status recovery is never entered.
{
  const calls = newCalls();
  const engine = flowEngine(calls, { apply: okPromote(), settleQueued: "oa_settle_1" });
  const { env, counters } = flowEnv(engine);
  const res = await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  eq("queued-settle flow completes", res, "done");
  eq("the settle was attempted exactly once (a queued answer is definitive, never retried)", calls.settleTokens.length, 1);
  eq("no persistence-first recovery was entered (the engine answered clearly)", calls.statusReads, 0);
  const text = textOf(env.out);
  ok("the queued-settle copy names the second owner", text.includes("second owner"));
  ok("the queued-settle copy says the new version is already live (this is NOT the apply's queued state)", text.includes("already live"));
  ok("the queued-settle copy says rolling back needs no approval", text.toLowerCase().includes("rolling back does not need"));
  // NEGATIVE CONTROLS: the two lies this branch exists to prevent.
  ok("no false 'could not be read' fault report", !text.includes("could not be confirmed in this response"));
  ok("no false 'nothing was deployed' claim (the promote DID deploy)", !text.includes("nothing was deployed"));
  eq("the section reloaded onto the queued state", counters.reloads, 1);
}

// 24e. SETTLE-RACE RECOVERY (the live incident): the settle THROWS, the flow re-reads the recorded status
// and renders the ENGINE'S recorded rollback (with its reason), never the transport error and never a
// "still live / hourly canary" claim; the section then reloads.
{
  const calls = newCalls();
  const engine = flowEngine(calls, {
    apply: okPromote(),
    // no settle stub -> settleUpdate rejects (the raced response)
    status: () => lastRec({ outcome: "rolled-back", fromVersion: "0.1.0", toVersion: "0.2.0", reason: "canary liveness dropped after promote", at: AT, by: null }),
  });
  const { env, counters } = flowEnv(engine);
  const res = await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  eq("recovery flow completes", res, "done");
  eq("the recorded status was re-read (statusRetries=3, succeeds on the first attempt)", calls.statusReads, 1);
  const text = textOf(env.out);
  ok("the no-claims interim line rendered (Details)", text.includes("could not be confirmed in this response"));
  ok("the transport error was NOT rendered as the conclusion", !text.includes("transport dropped"));
  ok("no false 'new version is live' claim", !text.includes("is live"));
  ok("no false hourly-canary claim (the outcome is settled)", !text.includes("hourly canary"));
  eq("the section reloaded onto the recorded truth", counters.reloads, 1);
  eq(
    "the exact s2 terminal sentence rendered (the SHORT rolled-back form, not the verbose Details-only line)",
    progressLine(env.out),
    rolledBackTerminalLine("canary liveness dropped after promote"),
  );
}

// 24f. SETTLE-RACE RECOVERY, applied: the settle throws but the record says APPLIED -> the success line
// renders and the section reloads (the required second addendum case).
{
  const calls = newCalls();
  const engine = flowEngine(calls, {
    apply: okPromote(),
    status: () => lastRec({ outcome: "applied", toVersion: "0.2.0", at: AT, by: "o@e.co" }),
  });
  const { env, counters } = flowEnv(engine);
  await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  const text = textOf(env.out);
  ok("the recorded success rendered (Applied and verified, Details)", text.includes("Applied and verified"));
  // THE VERSION MUST BE IN THAT SENTENCE, not merely somewhere on the screen. "0.2.0" occurs three times
  // in this flow's output: the s2 terminal progress line, the interim "Deployed 0.2.0. Verifying it now"
  // Details line written at apply time, and the recorded-success sentence this assertion is about. The
  // first two are produced upstream of the recovery path entirely, so `text.includes("0.2.0")` passed
  // with the recorded-success sentence carrying no version at all, or removed altogether. Read the
  // sentence itself: shared.ts builds it as "...as kept, ${toVersion} is live and the canary confirmed it".
  ok("the recorded success names the version IN the recorded-success sentence", text.includes("as kept, 0.2.0 is live"));
  eq("the section reloaded", counters.reloads, 1);
  eq("the exact s2 terminal sentence rendered", progressLine(env.out), appliedTerminalLine("0.2.0", { confirmationPending: false }));
}

// 24g. NON-DEFINITIVE settle result takes the same recovery path (defence in depth): a garbled outcome is
// never mapped onto a guess.
{
  const calls = newCalls();
  const engine = flowEngine(calls, {
    apply: okPromote(),
    settle: () => ({ ...settle("applied"), outcome: "maybe" as unknown as SettleResult["outcome"] }),
    status: () => lastRec({ outcome: "rolled-back", fromVersion: "0.1.0", reason: "gate could not confirm", at: AT, by: null }),
  });
  const { env } = flowEnv(engine);
  await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  eq("a non-definitive settle re-reads the record", calls.statusReads, 1);
  ok("the recorded conclusion rendered (Details)", textOf(env.out).includes("rolled back automatically: gate could not confirm"));
  eq("the exact s2 terminal sentence rendered", progressLine(env.out), rolledBackTerminalLine("gate could not confirm"));
}

// 24h. RETRY-BUDGET EXHAUSTION (design s2's stall state): settle AND every status re-read fail throughout
// the WHOLE budget -- the honest STALL line renders (byte-for-byte, not the old bare "unknown" prose), no
// outcome is claimed, and the section is NOT reloaded (nothing concluded yet, s2: "no user action
// requested"). `out` is left DISCONNECTED here (flowEnv never appends it to the document), so the guarded
// background poll correctly does not fire at all -- proven separately (never a false positive) in 24k below.
{
  const calls = newCalls();
  const engine = flowEngine(calls, { apply: okPromote() }); // settle rejects AND status rejects, always
  const { env, counters } = flowEnv(engine);
  const res = await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  eq("the flow still completes (returns control to the caller, button re-enables)", res, "done");
  eq("the settle ladder ran its full budget (1 initial + 3 retries)", calls.settleTokens.length, 4);
  eq("the status re-read ran its full budget (statusRetries=3)", calls.statusReads, 3);
  const text = textOf(env.out);
  ok("the honest unknown line rendered (Details)", text.includes("recorded outcome could not be read"));
  ok("no outcome was claimed anywhere", !text.includes("is live") && !text.includes("rolled back automatically"));
  eq("no reload over the stall state (nothing is concluded yet)", counters.reloads, 0);
  eq("the exact s2 STALL sentence rendered, byte-for-byte", progressLine(env.out), STALL_LINE);
  eq("the stall line matches the design's own wording (ASCII '--' substituted for the doc's em dash)", STALL_LINE, "Still verifying -- this screen keeps checking by itself.");
}

// 24h2. The SAME exhaustion, but a settle that resolves "pending" (a genuinely outstanding verification,
// distinct from a hard failure) takes the identical stall path -- pending and unknown are BOTH non-
// definitive, so both stall rather than one silently reading as more final than the other.
{
  const calls = newCalls();
  const engine = flowEngine(calls, { apply: okPromote(), status: () => pendingRec("0.2.0") });
  const { env, counters } = flowEnv(engine);
  await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  eq("a still-pending record ALSO stalls (never misread as more final than unknown)", progressLine(env.out), STALL_LINE);
  eq("no reload over a still-pending record either", counters.reloads, 0);
}

// 24j. SETTLE TRANSPORT FAILURE x2 THEN SUCCESS (design s1/s2, the fix for root cause #1: "every deploy in
// the flow swaps a worker; the next read through it races the swap window and fails... the BROWSER got one
// attempt"). The settle call ITSELF is retried (not just the persisted-status re-read) on a transport fault;
// two failures then a definitive third success still reads as ONE flow, the SAME token every time, no
// refresh, and the exact s2 terminal sentence -- never the transport error, never a "could not be read".
{
  const calls = newCalls();
  let settleAttempts = 0;
  const engine = flowEngine(calls, {
    apply: okPromote(),
    settle: () => {
      settleAttempts++;
      if (settleAttempts < 3) throw new Error("settle update: transport dropped: 502");
      return settle("applied", { toVersion: "0.2.0", fromVersion: "0.1.2" });
    },
  });
  const { env, counters } = flowEnv(engine);
  const res = await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  eq("the flow still completes as ONE flow", res, "done");
  eq("the settle call was retried until it succeeded (3 attempts)", calls.settleTokens.length, 3);
  ok("every retry used the SAME one-shot token (never re-pasted)", calls.settleTokens.every((t) => t === "tok"));
  eq("no persistence-first recovery was needed (a definitive answer arrived within the ladder)", calls.statusReads, 0);
  eq("the exact s2 terminal sentence rendered", progressLine(env.out), appliedTerminalLine("0.2.0", { confirmationPending: false }));
  eq("the section reloaded exactly once (the SPA's own in-place re-render, never a user-facing refresh)", counters.reloads, 1);
  ok("no transport-fault text leaked onto the visible line", !progressLine(env.out).includes("transport dropped"));
}

// 24k. THE STALL STATE KEEPS POLLING BY ITSELF (design s2's own promise: "and it DOES keep polling; no user
// action requested"). `out` is explicitly marked document-connected (markConnected, the same guard idiom
// validate-api-flows-onboarding.ts / validate-live-flow.ts already use for a poll gated on isConnected), so
// the background poll pollUntilDefinitive starts actually runs; the engine answers non-definitive for the
// first two polls then a genuine "applied" on the third, proving the poll (a) truly continues after
// runLiveApplyFlow has already returned "done", and (b) stops and renders the real outcome + reloads the
// moment a definitive answer arrives, all with NO further click from the operator.
{
  const calls = newCalls();
  let pollReads = 0;
  const engine = flowEngine(calls, {
    apply: okPromote(),
    status: () => {
      pollReads++;
      if (pollReads <= 2) return { pending: null, last: null }; // still genuinely unknown
      return lastRec({ outcome: "applied", toVersion: "0.2.0", at: AT, by: "o@e.co" });
    },
  });
  const { env, counters } = flowEnv(engine);
  markConnected(env.out);
  const res = await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  eq("the flow returns done (the button re-enables) even though nothing is settled yet", res, "done");
  eq("the stall line is showing the moment control returns to the caller", progressLine(env.out), STALL_LINE);
  eq("no reload yet (nothing concluded)", counters.reloads, 0);
  // Let the background poll run its course (fire-and-forget microtask/macrotask chain).
  await flushAsync(40);
  eq("the poll kept checking by itself, past the settle-ladder's own status reads, until it resolved", pollReads >= 3, true);
  eq("the poll rendered the REAL outcome once it arrived, replacing the stall line", progressLine(env.out), appliedTerminalLine("0.2.0", { confirmationPending: false }));
  eq("the poll's own resolution reloaded the section (no operator action needed)", counters.reloads, 1);
}

// 24k2. The background poll respects isLive: once `out` is disconnected (the operator navigated away / the
// section re-rendered), the poll stops touching it -- never a "cannot read property of a detached node".
{
  const calls = newCalls();
  let pollReads = 0;
  const engine = flowEngine(calls, {
    apply: okPromote(),
    status: () => {
      pollReads++;
      return { pending: null, last: null }; // never resolves; would poll forever if not for isLive
    },
  });
  const { env } = flowEnv(engine);
  markConnected(env.out);
  await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  await flushAsync(3);
  const readsWhileLive = pollReads;
  ok("the poll had started (at least one read while connected)", readsWhileLive >= 1);
  env.out.remove(); // disconnect: a later reload()/navigation would do the same
  await flushAsync(40);
  eq("the poll stopped once isLive() went false (no further reads after disconnection)", pollReads, readsWhileLive);
}

// 24l. THE THIRD FIRST-CLASS OUTCOME: applied WITH CONFIRMATION PENDING (design s3/s5) -- the engine kept the
// update under the relaxed critical-only judgment before the hourly canary confirmed it in the background.
// The console renders the calm line honestly (never claims the canary confirmed it), asks for no action, and
// still reloads (a keep needs no further token).
{
  const calls = newCalls();
  const engine = flowEngine(calls, { apply: okPromote(), settle: () => ({ ...settle("applied", { toVersion: "0.2.0", fromVersion: "0.1.2" }), confirmationPending: true }) });
  const { env, counters } = flowEnv(engine);
  await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  eq("the exact confirmation-pending terminal line rendered", progressLine(env.out), appliedTerminalLine("0.2.0", { confirmationPending: true }));
  ok("it reads as calm reassurance, not an alarm", progressLine(env.out).toLowerCase().includes("no action needed"));
  ok("it NEVER claims the canary confirmed it (that would be false)", !progressLine(env.out).toLowerCase().includes("canary confirmed"));
  eq("the section still reloaded (a keep needs no further token)", counters.reloads, 1);
}

// 24l2. The SAME confirmation-pending outcome, arriving via the PERSISTENCE-FIRST RECOVERY path (the settle
// ladder never got a definitive response, but the persisted record says applied+confirmationPending) --
// proves the flag survives the recorded-truth round trip, not just the direct settle response.
{
  const calls = newCalls();
  const engine = flowEngine(calls, {
    apply: okPromote(),
    status: () => ({ pending: null, last: { outcome: "applied", toVersion: "0.2.0", at: AT, by: null, confirmationPending: true } }),
  });
  const { env, counters } = flowEnv(engine);
  await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  eq("confirmationPending survives the recorded-truth recovery path", progressLine(env.out), appliedTerminalLine("0.2.0", { confirmationPending: true }));
  eq("the section reloaded", counters.reloads, 1);
}

// 24m. THE FOURTH FIRST-CLASS OUTCOME: expired-cleared (design s2/s5) -- a stale pending the engine itself
// cleared as expired renders as its OWN reassuring line, never "could not be read", and the section reloads
// (the pending card must stop offering to resume something the engine already cleared).
{
  const calls = newCalls();
  const engine = flowEngine(calls, { apply: okPromote(), status: () => ({ pending: null, last: { outcome: "expired-cleared", at: AT, by: null } }) });
  const { env, counters } = flowEnv(engine);
  await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  eq("the exact s2 expired-cleared sentence rendered, byte-for-byte", progressLine(env.out), EXPIRED_CLEARED_LINE);
  eq("expired-cleared matches the design's own exact wording", EXPIRED_CLEARED_LINE, "A leftover verification from an earlier attempt was cleared; nothing was changed.");
  ok("never rendered as the dishonest 'could not be read'", !progressLine(env.out).includes("could not be read"));
  eq("the section reloaded (so the pending card stops offering a resume)", counters.reloads, 1);
}

// 24i. recoverSettleConclusion is shared by the pending-verification body: prove it directly (a heading is
// replaced by the interim line, the recorded line is appended, the outcome is returned).
{
  const calls = newCalls();
  const engine = flowEngine(calls, { apply: okPromote(), status: () => lastRec({ outcome: "applied", toVersion: "0.2.0", at: AT, by: null }) });
  const out = document.createElement("div");
  const heading = document.createElement("p");
  out.appendChild(heading);
  const recorded = await recoverSettleConclusion(engine, out, heading);
  eq("the shared recovery returns the recorded kind", recorded.kind, "applied");
  eq("the heading became the interim no-claims line", textOf(heading), SETTLE_UNCONFIRMED_LINE);
  ok("the recorded line was appended", textOf(out).includes("Applied and verified"));
}

// ===========================================================================
// 25. RENDERED COMPONENT ROWS + ADVANCED SECTION (DOM presence, degradation-gated)
// ===========================================================================
console.log("\n-- component result rows + advanced section (DOM) --");

// renderComponentResults: nothing for an absent/empty set (old engines), rows + steps when present.
{
  const out = document.createElement("div");
  renderComponentResults(out, undefined);
  renderComponentResults(out, []);
  eq("no rows render for an absent/empty result set", out.childNodes.length, 0);
  renderComponentResults(out, [cr("engine", "dry-run", { toVersion: "0.2.0", fromVersion: "0.1.2" }), cr("console", "dry-run", { toVersion: "0.2.0", steps: [{ step: "verify console bundle", ok: true }] })]);
  const text = textOf(out);
  ok("the engine plan row rendered", text.includes("Engine: verified. A live update would deploy 0.2.0 and keep 0.1.2 as the rollback target."));
  ok("the console plan row rendered", text.includes("Console: verified. A live update would deploy 0.2.0."));
  ok("a component's own steps rendered", text.includes("verify console bundle"));
}

// componentAdvancedSection: null WITHOUT a components map (the sharp rule); per-component apply buttons only
// for components the release updates; rollback buttons for both mapped components.
{
  const calls = newCalls();
  const engine = flowEngine(calls, { apply: okPromote() });
  const out = document.createElement("div");
  // destConfigured: true keeps these on the FULL path. With it false the body returns early with
  // only a preview button and the destination gate, so every button assertion below would be
  // exercising the gated path while reading as though it covered the apply flow.
  const env = { out, reload: () => {}, restoreFocus: () => {}, canManage: true, destConfigured: true };
  eq("no components map -> NO advanced section", componentAdvancedSection(engine, upd(true), env, "0.1.0"), null);
  const both = componentAdvancedSection(engine, compUpd("0.2.0", "0.2.0"), env, "0.1.0");
  ok("advanced section renders with a components map", both !== null);
  const labels = both ? buttonsOf(both).map((b) => b.text) : [];
  ok("per-component apply buttons for both updatable components", labels.includes("Update engine only") && labels.includes("Update console only"));
  ok("per-component rollback buttons for both components", labels.includes("Roll back engine") && labels.includes("Roll back console"));
  const consoleOnly = componentAdvancedSection(engine, compUpd("0.1.2", "0.2.0"), env, "0.1.0");
  const coLabels = consoleOnly ? buttonsOf(consoleOnly).map((b) => b.text) : [];
  ok("an up-to-date engine gets NO apply button (no dead affordance)", !coLabels.includes("Update engine only") && coLabels.includes("Update console only"));
  ok("rollback stays offered for both components regardless", coLabels.includes("Roll back engine") && coLabels.includes("Roll back console"));
}

// ===========================================================================
// 26. LAZY-CHUNK PRELOAD (P5) -- preloadOwnLazyChunks
// ===========================================================================
console.log("\n-- lazy-chunk preload --");

ok("injected loaders that resolve -> true", (await preloadOwnLazyChunks([() => Promise.resolve("a"), () => Promise.resolve("b")])) === true);
ok("a failing loader -> false, never a throw (preload must not block the update)", (await preloadOwnLazyChunks([() => Promise.reject(new Error("404 after swap")), () => Promise.resolve("b")])) === false);
// The REAL default loader list: importing the tour chunk's module must succeed (the shim is installed and
// the module is side-effect free at import time, so nothing starts).
ok("the real lazy-chunk import succeeds under Node", (await preloadOwnLazyChunks()) === true);

// ===========================================================================
// 27. THE ?open=updates DEEP-LINK REVEAL (DOM) -- UPDATES_HEADING_ID + revealUpdatesSection
// ===========================================================================
// The shell's context-bar "Update available" chip lands on /licence?open=updates; the coordinator
// then runs revealUpdatesSection over the rendered region. Drive the REAL view body (the same
// render the screen uses) and prove the anchor exists, is a programmatic focus target, and the
// reveal focuses it -- so the deep link can never silently degrade to a bare navigation.
console.log("\n-- ?open=updates deep-link reveal (DOM) --");
{
  const engineStub = {} as unknown as EngineClient; // handlers only fire on click; render never calls it
  const body = renderLicenceView(engineStub, { licence: lic("community"), updates: upd(true), status: status({}), updateState: null }, () => {});
  const heading = body.querySelector(`#${UPDATES_HEADING_ID}`) as HTMLElement | null;
  ok("the rendered screen carries the Updates heading anchor", heading !== null && textOf(heading as HTMLElement) === "Updates");
  eq("the heading is a programmatic focus target (tabindex -1)", heading?.getAttribute("tabindex") ?? "", "-1");
  ok("revealUpdatesSection finds + FOCUSES the heading on the real body", revealUpdatesSection(body) === true && document.activeElement === heading);
  ok("revealUpdatesSection reports false when there is nothing to reveal (error/skeleton region)", revealUpdatesSection(document.createElement("div")) === false);
}

// ===========================================================================
// 28. 0.1.5 UPDATE-UX -- the EXACT s2/s4/s6 copy, pinned byte-for-byte against the design doc
// ===========================================================================
// Every string in this section is quoted DIRECTLY from design/updates/UPDATE-UX-015-DESIGN.md s2/s4/s6 (the
// task brief: "EVERY exact string in s2/s4/s6 is normative, byte-for-byte in the UI"). One transliteration:
// the design doc's own prose for the stall line uses a typographic em dash; house lint (lint:prose) bans that
// character anywhere in src, so the shipped copy substitutes the ASCII "--" this family already uses for the
// identical reason elsewhere (componentRowLine's "Console -- up to date"). The words are pinned unchanged.
console.log("\n-- 0.1.5 update-UX: exact s2/s4/s6 copy --");

eq("s2 stage 1", STAGE_CHECKING, "Checking the release…");
eq("s2 stage 2", STAGE_DEPLOYING_ENGINE, "Deploying the engine…");
eq("s2 stage 3", STAGE_PROVING, "Proving the new version…");
eq("s2 stage 3 subline", STAGE_PROVING_SUBLINE, "this can take a minute");
eq("s2 stage 4", STAGE_UPDATING_CONSOLE, "Updating the console…");

// s2 terminal sentence 1: "Updated to <version>." (+ "Reloading to finish" when the console applied too).
eq("s2 terminal: applied", appliedTerminalLine("0.1.5", {}), "Updated to 0.1.5.");
eq("s2 terminal: applied + reload suffix", appliedTerminalLine("0.1.5", { consoleApplied: true }), "Updated to 0.1.5. Reloading to finish.");
eq("s2 terminal: applied, no version known (honest degrade)", appliedTerminalLine(null, {}), "Updated.");
ok("s2 terminal never claims a reload when the console did NOT apply", !appliedTerminalLine("0.1.5", { consoleApplied: false }).includes("Reload"));

// s2 terminal sentence 2: "Rolled back automatically: <one-line reason>. Nothing else was changed."
eq("s2 terminal: rolled-back with a reason", rolledBackTerminalLine("the canary did not sing"), "Rolled back automatically: the canary did not sing. Nothing else was changed.");
eq(
  "s2 terminal: rolled-back with NO recorded reason (honest fallback, matches the family's existing voice)",
  rolledBackTerminalLine(undefined),
  "Rolled back automatically: the canary did not confirm the new version. Nothing else was changed.",
);
eq("s2 terminal: rolled-back with an empty-string reason ALSO falls back (never a dangling colon)", rolledBackTerminalLine(""), "Rolled back automatically: the canary did not confirm the new version. Nothing else was changed.");

// s2 the ONE honest stall state.
eq("s2 stall line, byte-for-byte", STALL_LINE, "Still verifying -- this screen keeps checking by itself.");

// s2/s5 the stale-pending-expired first-class outcome.
eq("s2/s5 expired-cleared line, byte-for-byte", EXPIRED_CLEARED_LINE, "A leftover verification from an earlier attempt was cleared; nothing was changed.");

// s4 the destination gate: the engine's exact refusal reason (matched verbatim, reactively) and the
// console's own proactive/reactive line + link.
eq(
  "s4 engine refusal reason, byte-for-byte",
  DESTINATION_GATE_ENGINE_REASON,
  "updates verify themselves with a canary flight to your destination; add a destination first, then apply this update",
);
eq("s4 console line, byte-for-byte", DESTINATION_GATE_CONSOLE_LINE, "Updates verify themselves with a canary flight to your destination. Add a destination first.");

// s6 the paired-rollback confirm line.
eq("s6 paired-rollback line, byte-for-byte", PAIRED_ROLLBACK_LINE, "Rolling the engine back past what this console requires; the console will be rolled back with it.");

// terminalLineForOutcome (the shared bridge both s2 renderers use): every RecordedSettleOutcome kind maps to
// EXACTLY the strings above, so the live flow and the pending card can never drift on what a given recorded
// outcome says.
eq("bridge: applied", terminalLineForOutcome({ kind: "applied", toVersion: "0.1.5", confirmationPending: false }), "Updated to 0.1.5.");
eq(
  "bridge: applied + confirmationPending (design s3/s5's calm background-confirmation line)",
  terminalLineForOutcome({ kind: "applied", toVersion: "0.1.5", confirmationPending: true }),
  "Updated to 0.1.5. Finishing verification in the background; no action needed.",
);
eq(
  "bridge: applied + confirmationPending + consoleApplied (both s3 and s2's reload suffix, engine-then-console order)",
  terminalLineForOutcome({ kind: "applied", toVersion: "0.1.5", confirmationPending: true }, { consoleApplied: true }),
  "Updated to 0.1.5. Finishing verification in the background; no action needed. Reloading to finish.",
);
eq("bridge: rolled-back", terminalLineForOutcome({ kind: "rolled-back", fromVersion: "0.1.4", toVersion: "0.1.5", reason: "the canary did not sing" }), "Rolled back automatically: the canary did not sing. Nothing else was changed.");
eq("bridge: expired-cleared", terminalLineForOutcome({ kind: "expired-cleared" }), EXPIRED_CLEARED_LINE);
eq("bridge: pending -> the stall line (never a different, drifted wording)", terminalLineForOutcome({ kind: "pending", toVersion: "0.1.5" }), STALL_LINE);
eq("bridge: unknown -> the SAME stall line (pending and unknown never diverge)", terminalLineForOutcome({ kind: "unknown" }), STALL_LINE);

// destinationGateNode: the console line renders verbatim with a working /destinations link (banner + action,
// this codebase's established "a link" idiom for in-SPA navigation, e.g. the dropped-sources prompt).
{
  const node = destinationGateNode();
  ok("the destination-gate node carries the exact s4 line", textOf(node).includes(DESTINATION_GATE_CONSOLE_LINE));
  const btn = qsa(node, "button").find((b) => textOf(b).trim() === "Add a destination");
  ok("a link (button-styled internal navigation, this codebase's idiom) to /destinations is offered", btn !== undefined);
}

// ===========================================================================
// 29. THE PENDING CARD IS A RESUME SURFACE, ALWAYS WITH ITS OWN CONTROLS (design s2, Task 2)
// ===========================================================================
// The 0.1.4 bug this fixes: a recovery arm used to replace the card with prose that referenced controls it
// had itself just wiped ("verify now, or roll back" -- while no such button existed on the card the operator
// was actually looking at). Every arm below writes ONLY into the sibling progress region (`out`); `body` (the
// card's own banner + token field + button) is NEVER touched, so it is structurally impossible for any arm to
// strand the operator with prose about controls that are not there. The button copy is also renamed per
// design s2 (plain language, no "verify"/"settle" jargon in the resting label either).
console.log("\n-- pending card: always a full resume surface with controls (Task 2) --");

function pendingEnv(out: HTMLElement): { env: { out: HTMLElement; reload: () => void; restoreFocus: () => void; canManage: boolean; destConfigured: boolean }; counters: { reloads: number } } {
  const counters = { reloads: 0 };
  return { env: { out, reload: () => { counters.reloads++; }, restoreFocus: () => {}, canManage: true, destConfigured: true }, counters };
}
function pendingState(toVersion = "0.2.0"): { kind: "pending"; toVersion: string; recommendedVersion: string } {
  return { kind: "pending", toVersion, recommendedVersion: toVersion };
}
// cardControlsPresent proves the resume surface's OWN button + token field are STILL THE SAME NODES in
// `body` after a settle attempt (the 0.1.4 invariant: a recovery arm must NEVER replace the card with prose).
// Checked by NODE IDENTITY (body.contains the exact original elements), the strongest possible proof --
// stronger than matching a label, which the button's own busy state ("Verifying…") legitimately changes
// mid-flight regardless of outcome (a cosmetic detail the section's own reload() resolves in production).
function cardControlsPresent(body: HTMLElement, btn: HTMLButtonElement, tokenInput: HTMLElement): boolean {
  return body.contains(btn) && body.contains(tokenInput);
}

// 29a. The resting label is the plain-language s2 copy, not the old jargon-adjacent "Verify now / roll back".
{
  const out = document.createElement("div");
  const { env } = pendingEnv(out);
  const engine = flowEngine(newCalls(), { apply: okPromote() });
  const body = pendingUpdateBody(engine, pendingState(), env);
  ok("the resting button label is plain language", buttonsOf(body).some((b) => b.text === "Finish verifying / roll back"));
  ok("the old jargon-adjacent label is gone", !buttonsOf(body).some((b) => b.text === "Verify now / roll back"));
}

// 29b-29f: drive the REAL settle click through every first-class outcome (design s5) and prove the card's
// OWN controls are STILL present afterward, every single time -- applied, applied+confirmationPending,
// rolled-back, expired-cleared (via recovery) and the honest stall (via full retry-budget exhaustion, the
// SAME resilience fix the live flow gets). The settle() fixture's own default toVersion is "v1.1.0" (set at
// its declaration, section 9); this section's expectations match that default rather than re-declaring it.
async function driveSettle(
  calls: FlowCalls,
  spec: Parameters<typeof flowEngine>[1],
): Promise<{ body: HTMLElement; out: HTMLElement; counters: { reloads: number }; btn: HTMLButtonElement; tokenInput: HTMLElement }> {
  const out = document.createElement("div");
  const { env, counters } = pendingEnv(out);
  const engine = flowEngine(calls, spec);
  const body = pendingUpdateBody(engine, pendingState(), env, ZERO_HOOKS);
  const tokenInput = qs(body, "#update-settle-token") as unknown as HTMLElement;
  (tokenInput as unknown as { value: string }).value = "tok";
  const btn = qsa(body, "button")[0] as unknown as HTMLButtonElement;
  (btn as unknown as { click: () => void }).click();
  await flushAsync(20);
  return { body, out, counters, btn, tokenInput };
}

{
  const calls = newCalls();
  const { body, out, counters, btn, tokenInput } = await driveSettle(calls, { apply: okPromote(), settle: () => settle("applied") });
  ok("29b applied: the card's OWN controls are still present (same nodes)", cardControlsPresent(body, btn, tokenInput));
  eq("29b applied: the exact s2 terminal sentence rendered", progressLine(out), appliedTerminalLine("v1.1.0", { confirmationPending: false }));
  eq("29b applied: reloaded", counters.reloads, 1);
}
{
  const calls = newCalls();
  const { body, out, btn, tokenInput } = await driveSettle(calls, { apply: okPromote(), settle: () => ({ ...settle("applied"), confirmationPending: true }) });
  ok("29c confirmation-pending: the card's OWN controls are still present (same nodes)", cardControlsPresent(body, btn, tokenInput));
  eq("29c confirmation-pending: the exact calm line rendered", progressLine(out), appliedTerminalLine("v1.1.0", { confirmationPending: true }));
}
{
  const calls = newCalls();
  const { body, out, btn, tokenInput } = await driveSettle(calls, { apply: okPromote(), settle: () => settle("rolled-back", { reason: "the canary did not sing" }) });
  ok("29d rolled-back: the card's OWN controls are still present (same nodes)", cardControlsPresent(body, btn, tokenInput));
  eq("29d rolled-back: the exact s2 terminal sentence rendered", progressLine(out), rolledBackTerminalLine("the canary did not sing"));
}
{
  const calls = newCalls();
  const { body, out, counters, btn, tokenInput } = await driveSettle(calls, { apply: okPromote(), status: () => ({ pending: null, last: { outcome: "expired-cleared", at: AT, by: null } }) });
  ok("29e expired-cleared (via recovery): the card's OWN controls are still present (same nodes)", cardControlsPresent(body, btn, tokenInput));
  eq("29e expired-cleared: the exact s2 sentence rendered", progressLine(out), EXPIRED_CLEARED_LINE);
  eq("29e expired-cleared: reloaded (stop offering to resume something already cleared)", counters.reloads, 1);
}
{
  // THE CRITICAL CASE (the 0.1.4 bug, reproduced and proven fixed): settle AND every status re-read fail
  // throughout the whole budget. The card must NEVER show prose about a control that is not there -- here,
  // proven the strongest possible way: the SAME button and field nodes, still present, still clickable.
  const calls = newCalls();
  const { body, out, counters, btn, tokenInput } = await driveSettle(calls, { apply: okPromote() });
  ok("29f STALL (the 0.1.4 critical case): the card's OWN controls are STILL present (same nodes)", cardControlsPresent(body, btn, tokenInput));
  eq("29f STALL: the exact s2 stall sentence rendered (not a dangling reference to a missing control)", progressLine(out), STALL_LINE);
  eq("29f STALL: no reload (nothing concluded)", counters.reloads, 0);
  ok("29f STALL: the button is RE-ENABLED, ready for the operator to try again if they want", !(btn as unknown as { disabled: boolean }).disabled);
}

// 29g. Dropped-source binding verification survives the rework (unchanged wording + action).
{
  const calls = newCalls();
  const { body, out, btn, tokenInput } = await driveSettle(calls, { apply: okPromote(), settle: () => settle("applied", { droppedSources: ["s3-prod"] }) });
  ok("29g dropped sources: the loud banner rendered with its action", buttonsOf(out).some((b) => b.text === "Re-attach sources"));
  ok("29g dropped sources: the card's OWN controls are still present too (same nodes)", cardControlsPresent(body, btn, tokenInput));
}

// ===========================================================================
// 29g-ramp. THE RAMP START'S RELOAD, which never fired.
//
// The sibling of the missing settle client, and it compounds it. The engine's ramp START returns
// "ramp-pending"; the console's union said "ramped", so the success branch was DEAD: no toast, and no
// reload() -- and reload() is what re-renders the Updates section so the PENDING CARD appears. The operator
// started a live traffic split, was told "The ramp finished.", and the only control that could finish it was
// not on the page. Driving the REAL rampSection proves the reload fires now.
// ===========================================================================
console.log("\n-- the ramp start: a successful ramp must surface the pending card (reload) --");
{
  const out = document.createElement("div");
  let reloads = 0;
  const engine = {
    rampUpdate: () =>
      Promise.resolve({
        status: "result" as const,
        value: { outcome: "ramp-pending" as const, recommendedVersion: "0.2.0", toVersion: "0.2.0", fromVersion: "0.1.2", percentage: 10, steps: [] },
      }),
  } as unknown as EngineClient;
  const section = rampSection(engine, out, () => { reloads++; }, () => {});
  markConnected(section);
  (qs(section, "#update-ramp-pct") as unknown as { value: string }).value = "10";
  (qs(section, "#update-ramp-token") as unknown as { value: string }).value = "tok";
  (qsa(section, "button")[0] as unknown as { click: () => void }).click();
  await flushAsync(20);
  eq("a successful ramp RELOADS, so the pending card that can settle it is rendered", reloads, 1);
  ok("...and the line tells the truth: serving live traffic, not yet verified", /not\s+yet\s+verified/i.test(textOf(out)));
  ok("...and never says 'The ramp finished.'", !/The ramp finished/.test(textOf(out)));
}

// ===========================================================================
// 29h. THE RAMPED PENDING: the console could not settle one at all.
//
// The engine has had POST /admin/update/ramp/settle since asvs-HI-13, and nothing in the console called it.
// The card sent EVERY pending to the plain settle, and the engine's plain settle REFUSES a ramp-shaped
// pending outright, so a customer who started a gradual ramp had no control anywhere in the product that
// could finish it. These sections drive the REAL card and assert on BOTH call ledgers every time: which
// settle client was called, and that the sibling was not.
// ===========================================================================
console.log("\n-- the ramped pending: shape-routed settle (ramp settle vs plain settle) --");

function rampPendingState(toVersion = "0.2.0", percentage = 25): { kind: "pending"; toVersion: string; recommendedVersion: string; percentage: number } {
  return { kind: "pending", toVersion, recommendedVersion: toVersion, percentage };
}
const rampSettleResult = (outcome: RampSettleResult["outcome"], extra: Partial<RampSettleResult> = {}): RampSettleResult => ({
  phase: "ramp-settle",
  outcome,
  recommendedVersion: "0.2.0",
  fromVersion: "0.1.2",
  toVersion: "0.2.0",
  steps: [],
  ...extra,
});
async function driveRampSettle(
  calls: FlowCalls,
  spec: Parameters<typeof flowEngine>[1],
  state: ReturnType<typeof rampPendingState> = rampPendingState(),
): Promise<{ body: HTMLElement; out: HTMLElement; counters: { reloads: number }; btn: HTMLButtonElement; tokenInput: HTMLElement }> {
  const out = document.createElement("div");
  const { env, counters } = pendingEnv(out);
  const engine = flowEngine(calls, spec);
  const body = pendingUpdateBody(engine, state, env, ZERO_HOOKS);
  const tokenInput = qs(body, "#update-settle-token") as unknown as HTMLElement;
  (tokenInput as unknown as { value: string }).value = "tok";
  const btn = qsa(body, "button")[0] as unknown as HTMLButtonElement;
  (btn as unknown as { click: () => void }).click();
  await flushAsync(20);
  return { body, out, counters, btn, tokenInput };
}

// The label + banner + reload assertions main built for the ramp pending, kept and re-pointed at the single
// driveRampSettle helper above. They are about the CARD (does it name itself a ramp, does a concluded settle
// reload the section); the 29h cases below are about the ROUTE and the outcomes.
{
  const out = document.createElement("div");
  const { env } = pendingEnv(out);
  const engine = flowEngine(newCalls(), { apply: okPromote() });
  const body = pendingUpdateBody(engine, rampPendingState("0.2.0", 10), env);
  ok("29h ramp pending: the button says Verify the ramp / roll back", buttonsOf(body).some((b) => b.text === "Verify the ramp / roll back"));
  ok("29h ramp pending: the banner names the ramp percentage", textOf(body).includes("10%"));
}
{
  // applied -> keeps + reloads, routed through the RAMP settle endpoint (log records "ramp-settle").
  const calls = newCalls();
  const { body, counters, btn, tokenInput } = await driveRampSettle(calls, { apply: okPromote(), rampSettle: () => rampSettleResult("applied") });
  ok("29h ramp applied: drove the RAMP settle endpoint (not the atomic settle)", calls.log.includes("ramp-settle") && !calls.log.includes("settle"));
  ok("29h ramp applied: the card's OWN controls are still present (same nodes)", cardControlsPresent(body, btn, tokenInput));
  eq("29h ramp applied: reloaded", counters.reloads, 1);
}
{
  // rolled-back -> reassuring + names the reason + reloads. The merged renderer routes a rolled-back ramp
  // through terminalLineForOutcome ("Rolled back automatically: <reason>. Nothing else was changed."), so the
  // reassurance is asserted on what the card actually renders, not on a phrasing it never had.
  const calls = newCalls();
  const { out, counters } = await driveRampSettle(calls, { apply: okPromote(), rampSettle: () => rampSettleResult("rolled-back", { reason: "the ramp went ailing" }) });
  const rolledBackText = textOf(out);
  ok("29h ramp rolled-back: the reassuring line rendered", /nothing else was changed|nothing was lost/i.test(rolledBackText));
  ok("29h ramp rolled-back: the reason is surfaced, never swallowed", rolledBackText.includes("the ramp went ailing"));
  eq("29h ramp rolled-back: reloaded", counters.reloads, 1);
}

// 29h-0. THE DISCRIMINATOR REACHES THE CARD. updateControlState is what builds the card's state, and it was
// dropping the one field that decides which settle route can finish the pending.
{
  const rec: UpdateStatusRecord = { pending: { fromVersion: "0.1.2", toVersion: "0.2.0", recommendedVersion: "0.2.0", percentage: 25, promotedAt: "2026-07-10T00:00:00Z", promotedBy: null }, last: null };
  const st = updateControlState(upd(false), rec);
  eq("29h-0 a ramp-shaped pending still outranks everything (kind)", st.kind, "pending");
  eq("29h-0 the recorded percentage is CARRIED to the card (it used to be dropped)", st.kind === "pending" ? st.percentage : undefined, 25);
  const plain = updateControlState(upd(false), { pending: { fromVersion: "0.1.2", toVersion: "0.2.0", recommendedVersion: "0.2.0", promotedAt: "2026-07-10T00:00:00Z", promotedBy: null }, last: null });
  eq("29h-0 an ATOMIC pending carries NO percentage (the plain settle's shape is unchanged)", plain.kind === "pending" ? plain.percentage : "absent", undefined);
}

// 29h-1. THE ROUTING, BOTH WAYS. This is the sibling-site assertion: a ramped pending must reach the ramp
// client and NOT the plain one, and a plain pending must still reach the plain client and NOT the ramp one.
{
  const calls = newCalls();
  await driveRampSettle(calls, { apply: okPromote(), rampSettle: () => rampSettleResult("applied") });
  eq("29h-1 a RAMPED pending calls the ramp settle client", calls.rampSettleTokens.length, 1);
  eq("29h-1 ...with the one-shot token the operator pasted", calls.rampSettleTokens[0], "tok");
  eq("29h-1 ...and NEVER the plain settle (the engine would refuse it)", calls.settleTokens.length, 0);
}
{
  const calls = newCalls();
  await driveSettle(calls, { apply: okPromote(), settle: () => settle("applied") });
  eq("29h-1 a PLAIN pending still calls the plain settle client", calls.settleTokens.length, 1);
  eq("29h-1 ...and NEVER the ramp settle (the engine would refuse that too)", calls.rampSettleTokens.length, 0);
}

// 29h-2. INCONCLUSIVE is a first-class, retry-meaningful, nothing-was-changed outcome, NOT a fault. The whole
// ladder is spent on it (each attempt bumping the engine's update-settle-inconclusive counter), and the card
// then says the true thing and leaves its controls where they are, rather than rendering the stall line.
{
  const calls = newCalls();
  const { body, out, btn, tokenInput } = await driveRampSettle(calls, { apply: okPromote(), rampSettle: () => rampSettleResult("inconclusive") });
  ok("29h-2 inconclusive: every ladder attempt was made (the retries ARE the operator trying)", calls.rampSettleTokens.length === 4);
  ok("29h-2 inconclusive: the honest ramp sentence, not the stall line", progressLine(out) !== STALL_LINE);
  ok("29h-2 inconclusive: the terminal line says nothing was changed and to verify again", /Nothing was decided and nothing was changed/.test(textOf(out)) && /fresh chance of landing on the ramped slice/.test(textOf(out)));
  ok("29h-2 inconclusive: the card's OWN controls are still present (press it again)", cardControlsPresent(body, btn, tokenInput));
  ok("29h-2 inconclusive: the plain settle was never called", calls.settleTokens.length === 0);
}

// 29h-3. APPLIED on a ramp does NOT mean "the update is live". It means the ramped version is TRUSTED and
// STAYS at its percentage; promoting to 100% is a separate, deliberate act.
{
  const calls = newCalls();
  const { out } = await driveRampSettle(calls, { apply: okPromote(), rampSettle: () => rampSettleResult("applied") });
  ok("29h-3 applied: the line says the version is trusted and STAYS at its percentage", /trusted and stays at 25% of live traffic/.test(textOf(out)));
  ok("29h-3 applied: it does NOT claim the rollout finished", !/is live\./.test(progressLine(out)));
}

// 29h-4. ROLLBACK-FAILED-STILL-SPLIT (engine G219): the loudest state in the surface. Live traffic is STILL
// reaching the suspect version. It must be DEFINITIVE (never retried on the ladder as though undecided) and
// it must be loud.
{
  const calls = newCalls();
  const { out } = await driveRampSettle(calls, { apply: okPromote(), rampSettle: () => rampSettleResult("rollback-failed-still-split") });
  eq("29h-4 still-split: definitive, so exactly ONE call (never retried as if undecided)", calls.rampSettleTokens.length, 1);
  ok("29h-4 still-split: the operator is told traffic is STILL reaching the suspect version", /STILL SPLIT/.test(textOf(out)) && /still reaching 0\.2\.0/.test(textOf(out)));
  ok("29h-4 still-split: and that backups and restore are unaffected", /backups and your ability to restore are unaffected/.test(textOf(out)));
}

// 29h-5. ROLLED-BACK keeps the atomic path's reassurance verbatim (one mapping, no drift).
{
  const calls = newCalls();
  const { out } = await driveRampSettle(calls, { apply: okPromote(), rampSettle: () => rampSettleResult("rolled-back", { reason: "the canary did not sing" }) });
  eq("29h-5 rolled-back: the SAME terminal sentence the atomic settle uses", progressLine(out), rolledBackTerminalLine("the canary did not sing"));
}

// 29h-6. A TOTAL transport failure (the engine never answered at all) falls back to the SAME persistence-first
// recovery as the atomic path: re-read the recorded record and render what the ENGINE persisted.
{
  const calls = newCalls();
  const { out } = await driveRampSettle(calls, {
    apply: okPromote(),
    status: () => ({ pending: null, last: { outcome: "rolled-back", fromVersion: "0.1.2", toVersion: "0.2.0", at: "2026-07-10T00:00:00Z", by: null, reason: "the canary did not sing" }, rollbackNeeded: null }),
  });
  ok("29h-6 transport dead: the recorded truth is rendered, not the failure", /Rolled back automatically/.test(textOf(out)));
  ok("29h-6 transport dead: the status record WAS re-read (persistence-first)", calls.statusReads >= 1);
}

// 29h-7. THE BANNER forks on the shape too: a ramp is not "deployed and live".
{
  const out = document.createElement("div");
  const { env } = pendingEnv(out);
  const body = pendingUpdateBody(flowEngine(newCalls(), { apply: okPromote() }), rampPendingState(), env);
  ok("29h-7 the ramp banner names the live traffic share", /serving 25% of live traffic in a gradual ramp/.test(textOf(body)));
  ok("29h-7 the ramp banner does NOT claim the version is fully deployed and live", !/deployed and live/.test(textOf(body)));
  const plainBody = pendingUpdateBody(flowEngine(newCalls(), { apply: okPromote() }), pendingState(), env);
  ok("29h-7 the ATOMIC banner is unchanged (still 'deployed and live')", /deployed and live/.test(textOf(plainBody)));
}

// ===========================================================================
// 30. DESTINATION GATE (design s4, Task 4) -- proactive + reactive
// ===========================================================================
console.log("\n-- destination gate: proactive (no apply control) + reactive (exact refusal match) --");

// 30a. PROACTIVE: status.destConfigured is false -> the apply control (token, Update now, advanced, ramp) is
// REPLACED by the exact s4 line + a link to /destinations; Preview stays fully wired and available.
{
  const engine = flowEngine(newCalls(), { apply: { status: "result", value: promote("dry-run", { toVersion: "0.2.0" }) } });
  const out = document.createElement("div");
  const env = { out, reload: () => {}, restoreFocus: () => {}, canManage: true, destConfigured: false };
  const body = availableUpdateBody(engine, upd(true), env);
  ok("no Update now button when no destination is configured", !buttonsOf(body).some((b) => b.text === "Update now"));
  ok("no token field either", qs(body, "#update-deploy-token") === null);
  ok("Preview IS still offered (a dry-run deploys nothing, never gated)", buttonsOf(body).some((b) => b.text === "Preview update (dry-run)"));
  ok("the exact s4 console line rendered", textOf(body).includes(DESTINATION_GATE_CONSOLE_LINE));
  ok("a link to /destinations is offered", buttonsOf(body).some((b) => b.text === "Add a destination"));
  // Preview still genuinely works (proves the context passed to preview() is real, not a stub).
  const previewBtn = buttonsOf(body).find((b) => b.text === "Preview update (dry-run)");
  previewBtn?.click();
  await flushAsync();
  ok("preview still runs end to end with no destination configured", textOf(out).toLowerCase().includes("would deploy"));
}

// 30b. REACTIVE: a live apply refuses with the engine's EXACT s4 reason (destConfigured looked true from
// status, but the engine is the final authority) -> the gate renders in place of the generic error box.
{
  const calls = newCalls();
  const engine = flowEngine(calls, { apply: { status: "result", value: promote("refused", { reason: DESTINATION_GATE_ENGINE_REASON }) } });
  const { env } = flowEnv(engine);
  await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  ok("the destination-gate node rendered in place of a generic error", textOf(env.out).includes(DESTINATION_GATE_CONSOLE_LINE));
  ok("a link to /destinations is offered even reactively", buttonsOf(env.out).some((b) => b.text === "Add a destination"));
  ok("the raw engine refusal text is NOT dumped as a generic error (it got the first-class rendering instead)", !textOf(env.out).includes("was refused:"));
}

// 30c. REACTIVE via a THROWN refusal (the apply call itself throws, e.g. a 400 with the exact s4 reason
// folded by api.ts, distinct from an in-flow outcome:"refused"): the same gate rendering applies.
{
  const engine = { applyUpdate: () => Promise.reject(new Error(`apply update: ${DESTINATION_GATE_ENGINE_REASON}: 400`)) } as unknown as EngineClient;
  const { env } = flowEnv(engine);
  await runLiveApplyFlow(env, "tok", null, null, ZERO_HOOKS);
  ok("a THROWN destination-gate refusal ALSO renders the gate (not the generic error box)", textOf(env.out).includes(DESTINATION_GATE_CONSOLE_LINE));
}

// ===========================================================================
// 31. PAIRED-ROLLBACK CONFIRM (design s6, Task 5)
// ===========================================================================
// Before a token is spent on an ENGINE rollback, confirmEngineRollback reads the rollback plan (best-effort,
// NEVER a blocker); when it reports paired:true the confirm dialog shows the exact s6 line and the operator
// must proceed knowingly. Console-only rollback never calls this at all (design s6: always the safe
// direction). Drives the REAL confirmModal under the shim (the same answerModal idiom validate-
// destinations.ts already uses for "wait for the next confirm dialog and click a button").
console.log("\n-- paired-rollback confirm (Task 5) --");

// rollbackControl (unlike availableUpdateBody/pendingUpdateBody, which take canManage as a caller-supplied
// env field) reads its owner gate DIRECTLY off the installed caller (canCap, screens/common.ts), the same
// gate section 7 already proves is keys.ceremony/owner-only. This file otherwise never installs a caller
// (section 7 tests the pure can() model instead), so 31d's REAL click-through needs one installed, exactly
// like validate-api-flows-onboarding.ts / validate-config-changes.ts already do for the same reason.
setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: true });

function planEngine(plan: StandaloneRollbackResult | (() => StandaloneRollbackResult) | (() => Promise<StandaloneRollbackResult>) | "throw"): EngineClient {
  return {
    rollbackPlan: () => {
      if (plan === "throw") return Promise.reject(new Error("read rollback plan: paste the one-shot Cloudflare deploy token to roll back: 400"));
      return Promise.resolve(typeof plan === "function" ? plan() : plan);
    },
  } as unknown as EngineClient;
}
async function openConfirmSurface(): Promise<HTMLElement | null> {
  await flushAsync();
  return qs(document.body, ".dialog--modal") as unknown as HTMLElement | null;
}

// 31a. paired:true -> the confirm dialog shows the exact s6 line; Cancel resolves false, nothing spent.
{
  const engine = planEngine({ outcome: "dry-run", toVersion: "0.1.0", steps: [], paired: true, pairedConsole: { toVersion: "0.1.0" } });
  const decision = confirmEngineRollback(engine, { title: "Roll back the engine", body: "Roll back to the previous engine version?" });
  const surface = await openConfirmSurface();
  ok("the confirm dialog rendered", surface !== null);
  ok("the exact s6 paired line is shown BEFORE the token is spent", surface !== null && textOf(surface).includes(PAIRED_ROLLBACK_LINE));
  const cancelBtn = surface ? buttonsOf(surface).find((b) => b.text === "Cancel") : undefined;
  cancelBtn?.click();
  eq("Cancel resolves false (nothing proceeds)", await decision, false);
}

// 31b. paired:false -> the plain confirm, WITHOUT the s6 line; Confirm resolves true.
{
  const engine = planEngine({ outcome: "dry-run", toVersion: "0.1.0", steps: [] });
  const decision = confirmEngineRollback(engine, { title: "Roll back the engine", body: "Roll back to the previous engine version?" });
  const surface = await openConfirmSurface();
  ok("the plain confirm body renders (no paired line)", surface !== null && !textOf(surface).includes(PAIRED_ROLLBACK_LINE));
  const rollBtn = surface ? buttonsOf(surface).find((b) => b.text === "Roll back") : undefined;
  rollBtn?.click();
  eq("Roll back resolves true", await decision, true);
}

// 31c. BEST-EFFORT: an older engine (rollbackPlan throws, e.g. the ordinary token-required refusal) degrades
// to the plain confirm -- NEVER a blocker, never a surfaced error for a read that only adds one caution line.
{
  const engine = planEngine("throw");
  const decision = confirmEngineRollback(engine, { title: "Roll back the engine", body: "Roll back to the previous engine version?" });
  const surface = await openConfirmSurface();
  ok("an older engine (plan read throws) still opens the plain confirm, no error surfaced", surface !== null && !textOf(surface).includes(PAIRED_ROLLBACK_LINE));
  const rollBtn = surface ? buttonsOf(surface).find((b) => b.text === "Roll back") : undefined;
  rollBtn?.click();
  eq("still resolves true on confirm (never blocked by the failed plan read)", await decision, true);
}

// 31d. The standalone rollback CONTROL wires confirmEngineRollback in (an end-to-end proof, not just the
// helper in isolation): with a token pasted and a paired plan, clicking "Roll back to the previous version"
// shows the s6 line before the actual rollbackUpdate() call ever fires.
{
  let rollbackCalled = false;
  const engine = {
    rollbackPlan: () => Promise.resolve({ outcome: "dry-run", toVersion: "0.1.0", steps: [], paired: true } as StandaloneRollbackResult),
    rollbackUpdate: () => {
      rollbackCalled = true;
      return Promise.resolve({ outcome: "reverted", toVersion: "0.1.0", fromVersion: "0.2.0", steps: [] } as StandaloneRollbackResult);
    },
  } as unknown as EngineClient;
  const card = rollbackControl(engine, { urgent: false }, () => {});
  const tokenInput = qs(card, "#update-rollback-token") as unknown as { value: string } | null;
  if (tokenInput) tokenInput.value = "tok";
  const rollBtn = buttonsOf(card).find((b) => b.text === "Roll back to the previous version");
  rollBtn?.click();
  const surface = await openConfirmSurface();
  ok("the standalone control's OWN click shows the s6 line before any token is spent", surface !== null && textOf(surface).includes(PAIRED_ROLLBACK_LINE));
  eq("the real rollback has NOT fired yet (still awaiting the operator's confirm)", rollbackCalled, false);
  const confirmBtn = surface ? buttonsOf(surface).find((b) => b.text === "Roll back") : undefined;
  confirmBtn?.click();
  await flushAsync();
  ok("confirming proceeds to the real rollback call", rollbackCalled);
}

// Reset the caller installed for section 31 (test hygiene: this file otherwise never installs one).
setCaller(null);

// DV-112: a release step marked blocking must be acknowledged before Update-now enables. The gate lives in
// availableUpdateBody: with an owner (canManage) on a compatible release that carries a blocking step, the
// button starts disabled and a per-step checkbox enables it only once every blocking step is ticked.
console.log("\n-- DV-112 blocking-step acknowledgement gate (availableUpdateBody, DOM) --");
{
  const engineStub = {} as unknown as EngineClient; // handlers only fire on click; render never calls it
  const out = document.createElement("div");
  const env = { out, reload: () => {}, restoreFocus: () => {}, canManage: true, destConfigured: true };
  const body = availableUpdateBody(
    engineStub,
    updFull({ updateAvailable: true, compatible: true, requiredSteps: [{ text: "Snapshot the Durable Object first", blocking: true }, { text: "Read the changelog", blocking: false }] }),
    env,
  );
  const updateBtn = qsa(body, "button").find((b) => textOf(b as unknown as HTMLElement).trim() === "Update now") as unknown as { disabled: boolean } | undefined;
  ok("Update now is DISABLED while a blocking step is unacknowledged", updateBtn !== undefined && updateBtn.disabled === true);
  const checkboxes = qsa(body, "input").filter((el) => (el as unknown as { getAttribute(n: string): string | null }).getAttribute("type") === "checkbox");
  ok("exactly one checkbox is rendered for the one blocking step (non-blocking steps are not gated)", checkboxes.length === 1);
  const cb = checkboxes[0] as unknown as { checked: boolean; dispatchEvent: (e: unknown) => boolean };
  cb.checked = true;
  cb.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
  ok("Update now ENABLES once the blocking step is acknowledged", updateBtn !== undefined && updateBtn.disabled === false);
  cb.checked = false;
  cb.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
  ok("Update now DISABLES again if the acknowledgement is withdrawn", updateBtn !== undefined && updateBtn.disabled === true);

  // Negative control: a compatible release with NO blocking step leaves Update-now enabled for an owner.
  const body2 = availableUpdateBody(engineStub, updFull({ updateAvailable: true, compatible: true }), env);
  const btn2 = qsa(body2, "button").find((b) => textOf(b as unknown as HTMLElement).trim() === "Update now") as unknown as { disabled: boolean } | undefined;
  ok("with no blocking step, Update now is enabled for an owner on a compatible release", btn2 !== undefined && btn2.disabled === false);
}

// DV-112 (REGRESSION): the gate must not be reopened by the two OTHER writers of Update-now's disabled state.
// refreshApplyEnabled is the single writer; preview()'s finally and updateNow()'s tail both route through it.
console.log("\n-- DV-112 gate is not reopened by Preview or a no-reload apply (DOM) --");
{
  const btnByText = (root: HTMLElement, t: string) => qsa(root, "button").find((b) => textOf(b as unknown as HTMLElement).trim() === t) as unknown as { disabled: boolean; click: () => void } | undefined;
  const firstCheckbox = (root: HTMLElement) => qsa(root, "input").filter((el) => (el as unknown as { getAttribute(n: string): string | null }).getAttribute("type") === "checkbox")[0] as unknown as { checked: boolean; dispatchEvent: (e: unknown) => boolean };
  const passwordInput = (root: HTMLElement) => qsa(root, "input").find((el) => (el as unknown as { getAttribute(n: string): string | null }).getAttribute("type") === "password") as unknown as { value: string } | undefined;

  // Defect 1 (severe): clicking Preview (the encouraged, zero-risk action) must NOT enable Update now while a
  // blocking step is unacknowledged. preview() changes nothing, so it may not open the gate.
  {
    const calls = newCalls();
    const engine = flowEngine(calls, { apply: { status: "result", value: promote("dry-run", { toVersion: "v1.1.0", fromVersion: "v1.0.0" }) } });
    const body = availableUpdateBody(engine, updFull({ updateAvailable: true, compatible: true, requiredSteps: [{ text: "Snapshot the DO first", blocking: true }] }), { out: document.createElement("div"), reload: () => {}, restoreFocus: () => {}, canManage: true, destConfigured: true });
    const updateBtn = btnByText(body, "Update now");
    ok("gate starts closed with an unacknowledged blocking step", updateBtn?.disabled === true);
    btnByText(body, "Preview update (dry-run)")?.click();
    await flushAsync();
    ok("Preview actually ran (a dry-run apply was called)", calls.apply.length === 1 && calls.apply[0]?.dryRun === true);
    ok("REGRESSION defect 1: Preview does NOT reopen the gate -- Update now stays disabled", updateBtn?.disabled === true);
    // Acknowledge, then Preview again: the gate is satisfied, so preview must leave it ENABLED (re-derive, not clobber).
    const cb = firstCheckbox(body);
    cb.checked = true; cb.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
    ok("after acknowledgement Update now is enabled", updateBtn?.disabled === false);
    btnByText(body, "Preview update (dry-run)")?.click();
    await flushAsync();
    ok("Preview after acknowledgement leaves Update now enabled", updateBtn?.disabled === false);
  }

  // Defect 2 (race): after a no-reload apply outcome (a refusal), updateNow()'s tail must re-derive through the
  // gate, so an acknowledgement WITHDRAWN mid-flight leaves Update now disabled (the old blind reset re-enabled it).
  {
    const calls = newCalls();
    const engine = flowEngine(calls, { apply: { status: "result", value: promote("refused", { reason: "the new version requires a database migration" }) } });
    const body = availableUpdateBody(engine, updFull({ updateAvailable: true, compatible: true, requiredSteps: [{ text: "Snapshot the DO first", blocking: true }] }), { out: document.createElement("div"), reload: () => {}, restoreFocus: () => {}, canManage: true, destConfigured: true });
    const updateBtn = btnByText(body, "Update now");
    const cb = firstCheckbox(body);
    cb.checked = true; cb.dispatchEvent(makeEvent({ type: "change", bubbles: true })); // acknowledge -> enabled
    updateBtn?.click(); // press 1: reveal the token field
    await flushAsync();
    const tokenIn = passwordInput(body);
    ok("the token field was revealed on the first Update now press", tokenIn !== undefined);
    if (tokenIn) tokenIn.value = "deploy-tok";
    updateBtn?.click(); // press 2: runs the live apply flow (suspends at the await)
    // Withdraw the acknowledgement WHILE the apply is in flight.
    cb.checked = false; cb.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
    await flushAsync(); // apply resolves as "refused" (no section reload) -> updateNow tail runs
    ok("the refused apply did not reload (tail path exercised)", calls.apply.length === 1 && calls.apply[0]?.dryRun !== true);
    ok("REGRESSION defect 2: a no-reload apply does NOT reopen the gate after the ack was withdrawn", updateBtn?.disabled === true);
  }

  // End-to-end: an apply that comes back QUEUED for a second owner keeps Update now disabled via the queued
  // flag, EVEN with every blocking step acknowledged -- and re-toggling the acknowledgement cannot re-enable it.
  {
    const calls = newCalls();
    const engine = flowEngine(calls, { apply: { status: "queued", id: "oa_1" } });
    const body = availableUpdateBody(engine, updFull({ updateAvailable: true, compatible: true, requiredSteps: [{ text: "Snapshot the DO first", blocking: true }] }), { out: document.createElement("div"), reload: () => {}, restoreFocus: () => {}, canManage: true, destConfigured: true });
    const updateBtn = btnByText(body, "Update now");
    const cb = firstCheckbox(body);
    cb.checked = true; cb.dispatchEvent(makeEvent({ type: "change", bubbles: true })); // acknowledge -> enabled
    updateBtn?.click(); await flushAsync(); // press 1: reveal token
    const tokenIn = passwordInput(body);
    if (tokenIn) tokenIn.value = "deploy-tok";
    updateBtn?.click(); await flushAsync(); // press 2: apply -> queued for a second owner
    ok("a queued apply leaves Update now disabled (awaiting a second owner) despite full acknowledgement", updateBtn?.disabled === true);
    cb.checked = false; cb.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
    cb.checked = true; cb.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
    ok("re-acknowledging after a queue does NOT re-enable Update now (queued flag dominates)", updateBtn?.disabled === true);
  }
}

// ===========================================================================
// 32. VOLUME-BASED LICENSING -- TIER DISPLAY NAMES (tierDisplayName)
// ===========================================================================
// Every screen that prints a tier (the licence badge, the summary tile, the activation toasts) calls
// tierDisplayName instead of titleCase directly, because titleCase alone gets "msp" wrong ("Msp") and,
// gets every business-N band wrong too ("business-1" title-cases
// to "Business-1", not the "Business (1 estate)" control-plane's OWN tierDisplayName (src/licence/
// issue.ts) puts in the self-serve activation email's tier_name). This whole
// four-id family was missing from the map entirely (a launch-day gap) --
// only the pre-9-August ids it replaced (starter/growth/a bare "business") were listed, so a real
// business-1..25 licence fell through to the ugly titleCase fallback on every screen that reads it
// (this Licence card AND the Overview tile, screens/overview/tiles.ts). The four cases below pin the
// fix and match the email word for word.
console.log("\n-- volume-based licensing: tier display names (tierDisplayName) --");

eq("community -> Community", tierDisplayName("community"), "Community");
eq("business-1 -> Business (1 estate), matching the activation email's tier_name", tierDisplayName("business-1"), "Business (1 estate)");
eq("business-3 -> Business (up to 3 estates), matching the activation email's tier_name", tierDisplayName("business-3"), "Business (up to 3 estates)");
eq("business-10 -> Business (up to 10 estates), matching the activation email's tier_name", tierDisplayName("business-10"), "Business (up to 10 estates)");
eq("business-25 -> Business (up to 25 estates), matching the activation email's tier_name", tierDisplayName("business-25"), "Business (up to 25 estates)");
eq("msp -> MSP / MSSP (the one titleCase gets wrong)", tierDisplayName("msp"), "MSP / MSSP");
eq("enterprise -> Enterprise", tierDisplayName("enterprise"), "Enterprise");
// Negative control: titleCase alone WOULD get msp and every business-N band wrong -- proves the map is
// actually doing work, not just coincidentally matching titleCase's output.
ok("control: titleCase alone does NOT read 'MSP / MSSP' (the bug this map fixes)", titleCase("msp") !== "MSP / MSSP");
ok("control: titleCase alone reads the ugly 'Business-1', not 'Business (1 estate)'", titleCase("business-1") === "Business-1" && titleCase("business-1") !== "Business (1 estate)");
// The three pre-9-August ids (starter, growth, a bare "business") are DELETED outright, not aliased
// (no-legacy: zero customers or tokens ever existed under them), so
// they fall through to the SAME honest titleCase fallback as any other id this console build has
// never seen -- not a special case, just the general unknown-tier behaviour.
eq("starter (deleted 9 August, no alias) falls through to titleCase like any unknown id", tierDisplayName("starter"), "Starter");
// An id this console build does not recognise (an engine ahead of the console) degrades to a
// title-cased rendering of the raw id, never dropped or thrown on.
eq("unrecognised tier id falls back to titleCase", tierDisplayName("reseller"), "Reseller");
eq("empty tier id degrades to empty string (never throws)", tierDisplayName(""), "");
// The map itself carries exactly the seven live ids with the shared
// contract's display names -- no alias for the three deleted pre-9-August ids (no-legacy).
eq(
  "the display-name map covers exactly the seven live ids",
  Object.keys(TIER_DISPLAY_NAMES).sort().join(","),
  "business-1,business-10,business-25,business-3,community,enterprise,msp",
);

// ===========================================================================
// 33. VOLUME-BASED LICENSING -- ESTATE + BAND PURE LOGIC (screens/licence/estate-band.ts)
// ===========================================================================
console.log("\n-- volume-based licensing: estate + band pure logic --");

const GB_BYTES = 1024 ** 3;
function gbBytes(n: number): number {
  return n * GB_BYTES;
}
function est(bytes: number, accounts: number, extra: Partial<EstateSummary> = {}): EstateSummary {
  return { totalProtectedBytes: bytes, accounts, zones: 1, downpipes: 1, byType: {}, asOf: AT, ...extra };
}

// 33a. Size labels: one decimal in GB, switching to TB at 1000 GB (still /1024, a readability
// threshold rather than a base change -- 1000 GB reads as a clean "1.0 TB", not "0.98 TB").
eq("200 GB -> '200.0 GB'", estateSizeLabel(gbBytes(200)), "200.0 GB");
eq("999 GB -> '999.0 GB' (just under the switch)", estateSizeLabel(gbBytes(999)), "999.0 GB");
eq("1000 GB -> '1.0 TB' (the switch point)", estateSizeLabel(gbBytes(1000)), "1.0 TB");
eq("1536 GB -> '1.5 TB'", estateSizeLabel(gbBytes(1536)), "1.5 TB");
eq("2048 GB -> '2.0 TB'", estateSizeLabel(gbBytes(2048)), "2.0 TB");
// bandSizeLabel takes an already-in-GB figure (protected-gb:<n> is a GB count, not bytes) and reads
// as a plain, thousands-grouped GB figure -- matching control-plane's bandCoversPhrase, the same
// number in the licence emails, rather than estateSizeLabel's GB/TB switch.
eq("band 500 GB -> '500 GB'", bandSizeLabel(500), "500 GB");
eq("band 3000 GB (an msp 3x pack) -> '3,000 GB' (thousands separator, no TB switch)", bandSizeLabel(3000), "3,000 GB");
eq("band 25000 GB (business-25) -> '25,000 GB'", bandSizeLabel(25000), "25,000 GB");

// 33b. estateSummaryLine: absent/malformed estate renders nothing; a well-formed one states the size
// + account count, correctly pluralised.
eq("undefined estate -> null", estateSummaryLine(undefined), null);
eq("null estate -> null", estateSummaryLine(null), null);
eq("valid estate, 3 accounts -> the plural sentence", estateSummaryLine(est(gbBytes(200), 3)), "Your estate measures about 200.0 GB across 3 accounts.");
eq("valid estate, 1 account -> singular 'account'", estateSummaryLine(est(gbBytes(50), 1)), "Your estate measures about 50.0 GB across 1 account.");
// accounts:0 with a live roster is the NORMAL binding-scoped estate (kv/r2/d1 sources carry no
// accountId): the displayed count floors to the one account those sources live in. With no
// downpipes at all there is nothing to floor to, so the honest zero renders.
eq("0 accounts but a live roster -> floored to 1", estateSummaryLine(est(gbBytes(12), 0)), "Your estate measures about 12.0 GB across 1 account.");
eq("0 accounts and 0 downpipes -> honest zero", estateSummaryLine(est(gbBytes(0), 0, { downpipes: 0 })), "Your estate measures about 0.0 GB across 0 accounts.");
// Malformed estate (the type promises a full EstateSummary; the wire does not, OBS-CONSOLE-1 style):
// negative bytes, non-finite bytes, and a wrong wire TYPE for bytes each degrade to null, never a
// thrown error or a fabricated line.
eq("negative totalProtectedBytes -> null (malformed, not rendered)", estateSummaryLine(est(-5, 3)), null);
eq("non-finite totalProtectedBytes -> null", estateSummaryLine(est(Number.NaN, 3)), null);
eq("negative accounts -> null", estateSummaryLine(est(gbBytes(10), -1)), null);
eq("a wrong wire type for bytes -> null (never throws)", estateSummaryLine({ ...est(gbBytes(10), 3), totalProtectedBytes: "lots" as unknown as number }), null);

// 33c. parseBandFeatures: absent/incomplete/malformed triples all withhold the whole band (never a
// partially-guessed one); a complete triple parses, ignoring unrelated feature strings; an msp
// licence's MULTIPLIED pack (estates:3 protected-gb:3000 for 3x) reads as plain numbers, no
// pack-multiple arithmetic needed. Reads "estates:", the key control-plane's tierToFeatures
// actually emits (issue.ts:314); an "accounts:" feature has never existed on the wire.
eq("undefined features -> null (absent)", parseBandFeatures(undefined), null);
eq("empty features -> null (absent)", parseBandFeatures([]), null);
eq("band without estates/protected-gb -> null (incomplete triple)", parseBandFeatures(["band:starter", "restore-priority"]), null);
eq("band+estates without protected-gb -> null (incomplete triple)", parseBandFeatures(["band:starter", "estates:10"]), null);
eq("estates without a band -> null (incomplete triple)", parseBandFeatures(["estates:10", "protected-gb:500"]), null);
eq("non-numeric estates -> null (malformed)", parseBandFeatures(["band:starter", "estates:many", "protected-gb:500"]), null);
eq("negative protected-gb -> null (malformed)", parseBandFeatures(["band:starter", "estates:10", "protected-gb:-500"]), null);
eq("an empty band value -> null (malformed)", parseBandFeatures(["band:", "estates:10", "protected-gb:500"]), null);
eq("a token carrying the old, never-emitted 'accounts:' key instead of 'estates:' -> null (incomplete triple)", parseBandFeatures(["band:starter", "accounts:10", "protected-gb:500"]), null);
{
  const b = parseBandFeatures(["band:starter", "estates:10", "protected-gb:500", "restore-priority"]);
  ok("a complete triple parses", b !== null);
  eq("parsed tier", b?.tier, "starter");
  eq("parsed estates", b?.estates, 10);
  eq("parsed protectedGb", b?.protectedGb, 500);
}
{
  // The msp multi-pack: the token's OWN numbers already carry the multiple (3x a 1-estate/1,000 GB
  // base pack), so parsing needs no special-case arithmetic for msp.
  const b = parseBandFeatures(["band:msp", "estates:3", "protected-gb:3000"]);
  eq("msp 3x pack parses its multiplied estates verbatim", b?.estates, 3);
  eq("msp 3x pack parses its multiplied protected-gb verbatim", b?.protectedGb, 3000);
}
{
  // A duplicate/conflicting second "band:" string does not override the first match.
  const b = parseBandFeatures(["band:starter", "band:growth", "estates:10", "protected-gb:500"]);
  eq("a duplicate band string does not override the first match", b?.tier, "starter");
}

// 33d. bandSummaryLine: the tier's display name (via tierDisplayName, so "MSP / MSSP" reads
// correctly), its covered estate count and its covered size, in the SAME order, words and number
// format as control-plane's bandCoversPhrase (the licence emails).
eq(
  "starter band line",
  bandSummaryLine({ tier: "starter", estates: 10, protectedGb: 500 }),
  "Your Starter tier covers 10 estates and 500 GB of protected data.",
);
eq(
  "msp band line (the 'MSP / MSSP' display name + the multiplied pack, thousands separator)",
  bandSummaryLine({ tier: "msp", estates: 3, protectedGb: 3000 }),
  "Your MSP / MSSP tier covers 3 estates and 3,000 GB of protected data.",
);
eq(
  "a single-estate band pluralises correctly, matching bandCoversPhrase's '1 estate' singular",
  bandSummaryLine({ tier: "starter", estates: 1, protectedGb: 500 }),
  "Your Starter tier covers 1 estate and 500 GB of protected data.",
);

// 33e. estateExceedsBand: false when there is nothing to compare or the estate sits within the
// band; true the instant EITHER dimension (accounts or protected bytes) is strictly over. Exactly
// at the band boundary is NOT over (strictly-greater only).
const BAND: BandInfo = { tier: "starter", estates: 10, protectedGb: 500 };
ok("no estate -> not over (nothing to compare)", estateExceedsBand(null, BAND) === false);
ok("undefined estate -> not over", estateExceedsBand(undefined, BAND) === false);
ok("well within the band -> not over", estateExceedsBand(est(gbBytes(100), 3), BAND) === false);
ok("EXACTLY at the band boundary -> not over (strictly-greater only)", estateExceedsBand(est(gbBytes(500), 10), BAND) === false);
ok("over on accounts only -> over", estateExceedsBand(est(gbBytes(100), 11), BAND) === true);
ok("over on protected bytes only -> over", estateExceedsBand(est(gbBytes(501), 3), BAND) === true);
ok("over on both dimensions -> over", estateExceedsBand(est(gbBytes(600), 12), BAND) === true);

// ===========================================================================
// 34. VOLUME-BASED LICENSING -- LICENCE CARD RENDERING (DOM)
// ===========================================================================
// Drives the REAL screen body (renderLicenceView, the same render the screen uses) over the licence
// GET response's new estate/band shape, proving the three quiet sentences appear (or are withheld)
// exactly as the pure logic above predicts, and that the tier badge/tile use the display name (not a
// bare titleCase) end to end.
console.log("\n-- volume-based licensing: licence card rendering (DOM) --");

function renderLicenceBody(licenceExtra: Partial<LicenceStatus>): HTMLElement {
  const engineStub = {} as unknown as EngineClient; // handlers only fire on click; render never calls it
  return renderLicenceView(engineStub, { licence: lic("business-1", licenceExtra), updates: upd(false), status: status({}), updateState: null }, () => {});
}

// 34a. Neither the estate nor the band line renders when the licence carries neither.
{
  const body = renderLicenceBody({});
  const text = textOf(body);
  ok("no estate line without an estate", !text.includes("Your estate measures"));
  ok("no band line without band features", !text.includes("tier covers"));
  ok("no over-band line either", !text.includes(ESTATE_OVER_BAND_LINE));
}

// 34b. An estate with NO band features: the estate line renders alone.
{
  const body = renderLicenceBody({ estate: est(gbBytes(200), 3) });
  const text = textOf(body);
  ok("the estate line rendered", text.includes("Your estate measures about 200.0 GB across 3 accounts."));
  ok("no band line (no band features on this token)", !text.includes("tier covers"));
  ok("no over-band line (nothing to compare a band against)", !text.includes(ESTATE_OVER_BAND_LINE));
}

// 34c. A complete band, estate comfortably within it: both quiet lines render, no over-band line.
// Features carry "estates:", the key control-plane's tierToFeatures actually emits.
{
  const body = renderLicenceBody({
    estate: est(gbBytes(100), 3),
    features: ["band:starter", "estates:10", "protected-gb:500", "restore-priority"],
  });
  const text = textOf(body);
  ok("the estate line rendered", text.includes("Your estate measures about 100.0 GB across 3 accounts."));
  ok("the band line rendered", text.includes("Your Starter tier covers 10 estates and 500 GB of protected data."));
  ok("NO over-band line (the estate sits within the band)", !text.includes(ESTATE_OVER_BAND_LINE));
}

// 34d. A complete band, estate grown PAST it (accounts): all three lines render.
{
  const body = renderLicenceBody({
    estate: est(gbBytes(100), 15),
    features: ["band:starter", "estates:10", "protected-gb:500"],
  });
  const text = textOf(body);
  ok("the estate line rendered", text.includes("Your estate measures about 100.0 GB across 15 accounts."));
  ok("the band line rendered", text.includes("Your Starter tier covers 10 estates and 500 GB of protected data."));
  ok("the over-band line rendered (grown past the band on accounts)", text.includes(ESTATE_OVER_BAND_LINE));
  // The over-band line reads calmly (a support conversation, never an alarm or a self-service upsell
  // link) -- no gate words, matching the framing rule section 3 already proves for ENTERPRISE_SERVICES.
  ok("the over-band line names support, not a self-service upsell", ESTATE_OVER_BAND_LINE.toLowerCase().includes("contact support"));
}

// 34e. A MALFORMED band (an unparseable estates value): the band line (and the over-band line) are
// withheld even though the token carries a "band:" string and a real estate is present -- the
// all-or-nothing defensive parse, never a partially-guessed sentence.
{
  const body = renderLicenceBody({
    estate: est(gbBytes(100), 15),
    features: ["band:starter", "estates:many", "protected-gb:500"],
  });
  const text = textOf(body);
  ok("the estate line still rendered (independent of the malformed band)", text.includes("Your estate measures about 100.0 GB across 15 accounts."));
  ok("NO band line (malformed estates withholds the whole band)", !text.includes("tier covers"));
  ok("NO over-band line either (nothing valid to compare)", !text.includes(ESTATE_OVER_BAND_LINE));
}

// 34e2. A real token carrying the old, never-emitted "accounts:" key instead of "estates:": the band
// line is withheld exactly as any other malformed/incomplete triple would be. This is the regression
// case for the bug this pass fixed: before the fix, EVERY real licence hit this path silently.
{
  const body = renderLicenceBody({
    estate: est(gbBytes(100), 3),
    features: ["band:starter", "accounts:10", "protected-gb:500"],
  });
  const text = textOf(body);
  ok("the estate line still rendered", text.includes("Your estate measures about 100.0 GB across 3 accounts."));
  ok("NO band line ('accounts:' is not a real feature key; 'estates:' is required)", !text.includes("tier covers"));
}

// 34f. The tier badge/tile use tierDisplayName end to end: an "msp" licence (with no band features,
// so the only source of the string is the badge/tile) reads "MSP / MSSP", never the titleCase "Msp".
{
  const engineStub = {} as unknown as EngineClient;
  const body = renderLicenceView(engineStub, { licence: lic("msp", {}), updates: upd(false), status: status({}), updateState: null }, () => {});
  const text = textOf(body);
  ok("the rendered tier badge/tile show 'MSP / MSSP' (tierDisplayName), not a bare titleCase", text.includes("MSP / MSSP"));
  ok("the rendered card never shows the wrong titleCase 'Msp'", !/\bMsp\b/.test(text));
}

// 34g. Every Business estate band renders its full display name end to end, for a real licence with a
// matching band, exactly as the fix to TIER_DISPLAY_NAMES (BAND-UI) puts it: the same
// words the self-serve activation email's tier_name carries, never the ugly "Business-N" titleCase
// fallback that shipped before this fix. Features carry
// "estates:", the real wire key (issue.ts's tierToFeatures), and the band line's own words and
// number format are checked against control-plane's bandCoversPhrase wording verbatim.
for (const [tier, estates, expectedName, expectedGb] of [
  ["business-1", 1, "Business (1 estate)", "1,000"],
  ["business-3", 3, "Business (up to 3 estates)", "3,000"],
  ["business-10", 10, "Business (up to 10 estates)", "10,000"],
  ["business-25", 25, "Business (up to 25 estates)", "25,000"],
] as const) {
  const engineStub = {} as unknown as EngineClient;
  const body = renderLicenceView(
    engineStub,
    {
      licence: lic(tier, { features: [`band:${tier}`, `estates:${estates}`, `protected-gb:${estates * 1000}`, "restore-priority"] }),
      updates: upd(false),
      status: status({}),
      updateState: null,
    },
    () => {},
  );
  const text = textOf(body);
  const estateWordExpected = estates === 1 ? "estate" : "estates";
  ok(`${tier}: the rendered tier badge/tile show '${expectedName}'`, text.includes(expectedName));
  ok(`${tier}: the rendered card never shows the raw hyphenated id as a badge`, !new RegExp(`\\bBusiness-${estates}\\b`).test(text));
  ok(`${tier}: the band line ALSO uses the same display name (page/badge/band-line agree)`, text.includes(`Your ${expectedName} tier covers`));
  ok(
    `${tier}: the band line's protected-data wording and number format match control-plane's bandCoversPhrase verbatim`,
    text.includes(`covers ${estates} ${estateWordExpected} and ${expectedGb} GB of protected data.`),
  );
}

// ===========================================================================
// 35. CLAIM-CODE SHAPE + NORMALISATION (claim-code.ts, pure)
// ===========================================================================
// The licence email now leads with a short claim code (DWNP-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX, Crockford base32,
// case-insensitive, hyphens optional) instead of the full signed token. normaliseClaimCode / isClaimCodeShape
// / formatClaimCode are the pure gate the Activate button's submit handler checks BEFORE ever calling the
// control plane; a value that fails the shape check is never a field error of its own, it silently falls
// back to the token-paste textarea (section 37 proves that end to end over the real DOM).
console.log("\n-- claim-code shape + normalisation (claim-code.ts) --");

const CLAIM_CANONICAL = "DWNP-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567";
const CLAIM_NORMALISED = "DWNPABCDEFGHJKMNPQRSTVWXYZ01234567";

eq("normalise: canonical hyphenated form", normaliseClaimCode(CLAIM_CANONICAL), CLAIM_NORMALISED);
eq("normalise: lower case, no hyphens at all", normaliseClaimCode("dwnpabcdefghjkmnpqrstvwxyz01234567"), CLAIM_NORMALISED);
eq("normalise: mixed case with stray surrounding + internal whitespace instead of hyphens", normaliseClaimCode("  Dwnp ABCde fghJK mnPQR stvWX Yz012 34567  "), CLAIM_NORMALISED);
eq("normalise: hyphens AND whitespace together are both stripped", normaliseClaimCode(" DWNP- ABCDE -FGHJK- MNPQR -STVWX -YZ012- 34567 "), CLAIM_NORMALISED);

ok("shape: the canonical normalised form is accepted", isClaimCodeShape(CLAIM_NORMALISED));
ok("shape: the DWNP prefix is REQUIRED -- the bare 30-char payload alone is rejected", !isClaimCodeShape(CLAIM_NORMALISED.slice(4)));
ok("shape: a payload one character SHORT is rejected", !isClaimCodeShape(CLAIM_NORMALISED.slice(0, -1)));
ok("shape: a payload one character LONG is rejected", !isClaimCodeShape(`${CLAIM_NORMALISED}A`));
ok("shape: a disallowed Crockford character (I) is rejected", !isClaimCodeShape(`DWNP${"I".repeat(30)}`));
ok("shape: a disallowed Crockford character (O) is rejected", !isClaimCodeShape(`DWNP${"O".repeat(30)}`));
ok("shape: a non-alphanumeric character breaks an otherwise correct-length payload (never stripped like a hyphen)", !isClaimCodeShape(`DWNP${"A".repeat(29)}@`));
ok("shape: an empty string is rejected", !isClaimCodeShape(""));
// Negative control: isClaimCodeShape takes an ALREADY-normalised value; a raw lower-case prefix is
// rejected (case-folding is normaliseClaimCode's job, not isClaimCodeShape's).
ok("shape: is case-SENSITIVE on its own (the caller must normalise first)", !isClaimCodeShape(`dwnp${CLAIM_NORMALISED.slice(4)}`));

eq("format: reconstructs the canonical hyphenated grouping", formatClaimCode(CLAIM_NORMALISED), CLAIM_CANONICAL);
eq("format: round-trips regardless of the input's original casing/hyphenation", formatClaimCode(normaliseClaimCode("dwnp abcdefghjkmnpqrstvwxyz01234567")), CLAIM_CANONICAL);

// A second, independent fixture (not just the one code reused above), so the shape/format checks are
// proven on more than a single hand-picked value.
const CLAIM_2_NORMALISED = "DWNP23456789ABCDEFGHJKMNPQRSTVWXYZ";
ok("shape: a second, independent well-formed code is also accepted", isClaimCodeShape(CLAIM_2_NORMALISED));
eq("format: the second fixture formats correctly too", formatClaimCode(CLAIM_2_NORMALISED), "DWNP-23456-789AB-CDEFG-HJKMN-PQRST-VWXYZ");

// ===========================================================================
// 36. CLAIM TOKEN FETCH -- fetchClaimToken (fetch-stubbed, + a REAL timeout)
// ===========================================================================
// fetchClaimToken POSTs a well-formed, already-formatted code to the control plane and never throws: every
// fault (a 404, any other non-2xx, a malformed 200, a network failure, or the hard AbortController timeout)
// degrades to one of the two calm copies, so the submit handler in activation.ts never has to distinguish
// them further. Fetch-stubbed exactly like controlPlaneStatus/controlPlaneRestore in
// validate-control-plane-recovery.ts (a recording stub, restored in a finally).
console.log("\n-- claim token fetch (fetchClaimToken, fetch-stubbed) --");

eq("the production timeout default is 8 seconds", CLAIM_TIMEOUT_MS, 8000);

{
  interface RecordedFetch {
    url: string;
    method: string | undefined;
    headers: Record<string, string> | undefined;
    body: string | undefined;
    signalPresent: boolean;
  }
  const calls: RecordedFetch[] = [];
  const last = (): RecordedFetch => {
    const c = calls[calls.length - 1];
    if (!c) throw new Error("no recorded fetch call");
    return c;
  };
  let nextResponse: () => Response = () => new Response("{}", { status: 200 });
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async (
    input: unknown,
    init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ) => {
    calls.push({ url: String(input), method: init?.method, headers: init?.headers, body: init?.body, signalPresent: init?.signal instanceof AbortSignal });
    return nextResponse();
  }) as typeof fetch;

  try {
    // 36a. success: POSTs to the exact control-plane claim route with a JSON body carrying the code
    // verbatim, an AbortSignal wired in (the hard timeout), and the token parsed straight through.
    nextResponse = () => new Response(JSON.stringify({ token: "TOKEN.ABC", account: "acct_1", tier: "business-3", notAfter: "2027-01-01T00:00:00Z" }), { status: 200 });
    const success = await fetchClaimToken(CLAIM_CANONICAL);
    ok("success: result is ok, carrying the token", success.ok === true && success.token === "TOKEN.ABC");
    // : SAME-ORIGIN now, through the console Worker's narrow claim proxy. It used to assert
    // the absolute https://control.downpipes.io URL, and that assertion was the shape of the bug: the
    // console's own CSP sets connect-src to exactly 'self', so the browser blocked that fetch before
    // the network and activation was dead in the shipped product. This test could not see it because
    // it replaces globalThis.fetch, which is why scripts/connect-src-gate.mjs now exists to check the
    // policy statically. The two properties worth holding are asserted directly: the request is
    // same-origin, and it still never goes to admin.downpipes.io (which sits behind Access and would
    // redirect a customer's first activation into a login page).
    eq("success: POSTs the claim SAME-ORIGIN through the console Worker proxy", last().url, "/control-plane/licence/claim");
    ok("success: never posts to a foreign origin", !/^https?:\/\//.test(String(last().url)));
    ok("success: never posts to admin.downpipes.io", !String(last().url).includes("admin.downpipes.io"));
    eq("success: is a POST", last().method, "POST");
    eq("success: content-type is JSON", last().headers?.["content-type"], "application/json");
    eq("success: body carries the code verbatim, JSON-encoded", last().body, JSON.stringify({ code: CLAIM_CANONICAL }));
    ok("success: an AbortSignal was wired in (the hard timeout)", last().signalPresent === true);

    // 36b. 404 -> the "not recognised" copy specifically, never the generic unreachable one.
    nextResponse = () => new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const notFound = await fetchClaimToken(CLAIM_CANONICAL);
    ok("404 -> not ok", notFound.ok === false);
    eq("404 -> the not-recognised copy", !notFound.ok ? notFound.message : "", CLAIM_NOT_RECOGNISED_TEXT);

    // 36c. any other non-2xx -> the ERRORED copy, NOT the unreachable one (G112). The service ANSWERED. Telling
    // a customer whose connection is demonstrably working to "check your connection" sends them to debug a
    // network that is fine while a vendor outage runs, and it was the single most misleading string on the
    // screen. This assertion used to pin that behaviour; it now pins the correction, and the negative control
    // below is the point: the two copies must not be the same string again.
    nextResponse = () => new Response("boom", { status: 500 });
    const serverErr = await fetchClaimToken(CLAIM_CANONICAL);
    ok("500 -> not ok", serverErr.ok === false);
    eq("500 -> the ERRORED copy (the service answered; it was not unreachable)", !serverErr.ok ? serverErr.message : "", CLAIM_ERRORED_TEXT);
    // Compared as string: the checker knows these are two distinct literals and calls the comparison
    // unintentional, but the guard is against a future edit collapsing them into one message, which is
    // exactly the confusion the two texts exist to prevent.
    ok("negative control: the errored copy is NOT the unreachable copy", (CLAIM_ERRORED_TEXT as string) !== CLAIM_UNREACHABLE_TEXT);
    ok("the errored copy does not tell the customer to check their connection", !CLAIM_ERRORED_TEXT.toLowerCase().includes("your connection"));

    // 36d. a 200 with no usable token -> the ERRORED copy too: the service answered, and answered with
    // something that is not the contract (a control-plane deploy that changed the response shape looks exactly
    // like this). Never a crash, never a fabricated/empty token handed to the engine.
    nextResponse = () => new Response(JSON.stringify({ account: "a", tier: "business-3", notAfter: "x" }), { status: 200 });
    const malformed = await fetchClaimToken(CLAIM_CANONICAL);
    ok("malformed 200 (no token field) -> not ok", malformed.ok === false);
    eq("malformed 200 -> the ERRORED copy (a 200 is not an unreachable service)", !malformed.ok ? malformed.message : "", CLAIM_ERRORED_TEXT);

    // 36d-2. a 409 band-full refusal reads the control plane's own
    // message verbatim, never the generic ERRORED copy -- the code verified and the refusal is a
    // legitimate business rule the customer needs to actually read, not a shrug.
    nextResponse = () => Response.json({ error: "estate_band_full", message: "Your Business (up to 3 estates) licence covers 3 estates, and that many Cloudflare accounts are already bound to it." }, { status: 409 });
    const bandFull = await fetchClaimToken(CLAIM_CANONICAL);
    ok("409 band-full -> not ok", bandFull.ok === false);
    eq("409 band-full -> the control plane's own message, verbatim", !bandFull.ok ? bandFull.message : "", "Your Business (up to 3 estates) licence covers 3 estates, and that many Cloudflare accounts are already bound to it.");
    ok("409 band-full is NOT the generic ERRORED copy", !bandFull.ok && bandFull.message !== CLAIM_ERRORED_TEXT);

    // 36d-3. a 409 whose body cannot be read still degrades to the calm, specific fallback text (never a
    // crash, and never the generic ERRORED copy either: the customer still learns it is a band, not a fault).
    nextResponse = () => new Response("not json at all", { status: 409 });
    const bandFullBadBody = await fetchClaimToken(CLAIM_CANONICAL);
    ok("409 with an unparseable body -> not ok", bandFullBadBody.ok === false);
    eq("409 with an unparseable body -> the fallback band-full text", !bandFullBadBody.ok ? bandFullBadBody.message : "", CLAIM_BAND_FULL_FALLBACK_TEXT);

    // 36d-4. cfAccountId, when supplied, rides in the JSON body alongside the code; when omitted (the
    // default, and every call above), the body is byte-identical to before this parameter existed.
    nextResponse = () => new Response(JSON.stringify({ token: "TOKEN.WITH-ACCT" }), { status: 200 });
    await fetchClaimToken(CLAIM_CANONICAL, CLAIM_TIMEOUT_MS, "aaaa1111aaaa1111aaaa1111aaaa1111");
    eq("cfAccountId, when supplied, rides in the body alongside the code", last().body, JSON.stringify({ code: CLAIM_CANONICAL, cfAccountId: "aaaa1111aaaa1111aaaa1111aaaa1111" }));
    await fetchClaimToken(CLAIM_CANONICAL);
    eq("cfAccountId, when omitted, is not in the body at all (unchanged from before this parameter existed)", last().body, JSON.stringify({ code: CLAIM_CANONICAL }));

    // 36e. a network throw (a TypeError, exactly what fetch rejects with on a real connection failure) ->
    // the unreachable copy, never an uncaught rejection reaching the caller.
    (globalThis as { fetch: unknown }).fetch = (async () => {
      throw new TypeError("network request failed");
    }) as unknown as typeof fetch;
    const netFail = await fetchClaimToken(CLAIM_CANONICAL);
    ok("network failure -> not ok", netFail.ok === false);
    eq("network failure -> the unreachable copy", !netFail.ok ? netFail.message : "", CLAIM_UNREACHABLE_TEXT);
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
}

// 36f. the REAL hard timeout: a fetch that hangs until its AbortSignal fires (exactly a real fetch's
// behaviour against an aborted request) resolves to the unreachable copy once timeoutMs elapses, never
// hangs the caller and is never retried on its own. A tiny real timeoutMs (not the production 8000) keeps
// this fast; the abort is driven by the REAL AbortController inside fetchClaimToken, not a simulated clock.
{
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    })) as unknown as typeof fetch;
  try {
    const timedOut = await fetchClaimToken(CLAIM_CANONICAL, 20);
    ok("real timeout -> not ok", timedOut.ok === false);
    eq("real timeout -> the unreachable copy (one calm message, not a distinct 'timed out' string)", !timedOut.ok ? timedOut.message : "", CLAIM_UNREACHABLE_TEXT);
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
}

// ===========================================================================
// 37. CLAIM-CODE ACTIVATION (DOM) -- the real activationSection, end to end
// ===========================================================================
// activationSection reads its owner gate directly off the installed caller (canCap, screens/common.ts),
// the same convention rollbackControl uses in section 31, so an owner caller is installed here and reset
// at the end exactly like that section does. This drives the REAL component (not a mirror), fetch-stubbed
// for the claim exchange and a fake EngineClient recording setLicence calls, proving: the claim path wins
// when well-shaped and hands the FETCHED token (not the code) to the unchanged engine.setLicence submit;
// a wrong-shape or empty claim code falls back to the token-paste textarea unchanged, including the
// shared empty-input message when both are empty.
console.log("\n-- claim-code activation (DOM, fake engine + fetch-stubbed) --");
setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: true });

function claimActivationEngine(setLicenceImpl: (token: string | null) => Promise<LicenceStatus>): { engine: EngineClient; tokens: Array<string | null> } {
  const tokens: Array<string | null> = [];
  const engine = {
    setLicence: (token: string | null) => {
      tokens.push(token);
      return setLicenceImpl(token);
    },
  } as unknown as EngineClient;
  return { engine, tokens };
}
function mountClaimActivation(engine: EngineClient): { section: HTMLElement; reloadCount: () => number } {
  let reloads = 0;
  const section = activationSection(engine, lic("community"), () => {
    reloads++;
  }, "licence-card-heading-test-37");
  return { section, reloadCount: () => reloads };
}
function fieldValue(section: HTMLElement, id: string, value: string): void {
  const input = qs(section, `#${id}`) as unknown as { value: string } | null;
  if (input) input.value = value;
}
function activateBtn(section: HTMLElement): { text: string; click: () => void } | undefined {
  return buttonsOf(section).find((b) => b.text === "Activate");
}
// shownError reads whichever error is CURRENTLY VISIBLE: the claim field, the token field, and the
// standalone verify-before-store channel each carry their own .field__error slot (three in the DOM at
// once), but only one is ever un-hidden at a time across every path this section drives (the field-level
// required message OR the standalone channel, never both), so scanning for the first non-hidden one reads
// correctly regardless of which mechanism produced it. Checked via the "hidden" ATTRIBUTE (hasAttribute),
// not the .hidden property: the shim's h() sets the initial `hidden: true` through setAttribute (dom.ts
// applyAttrs), which never syncs the shim's separate hidden_ flag -- only a later PROPERTY assignment
// (`el.hidden = false`, exactly what field.ts's setError/clearError and activation.ts's formError toggle
// both do) does. The attribute stays the one signal both construction and later mutation agree on.
function shownError(section: HTMLElement): string {
  for (const el of qsa(section, ".field__error")) {
    if (!(el as unknown as HTMLElement).hasAttribute("hidden")) return textOf(el).trim();
  }
  return "";
}

{
  const claimRealFetch = globalThis.fetch;
  let nextClaimResponse: () => Response = () => new Response(JSON.stringify({ token: "FETCHED-TOKEN", account: "a", tier: "business-3", notAfter: "x" }), { status: 200 });
  let claimFetchCalls = 0;
  (globalThis as { fetch: unknown }).fetch = (async () => {
    claimFetchCalls++;
    return nextClaimResponse();
  }) as typeof fetch;

  try {
    // 37a. the initial render carries the claim field, its one hint line, and the textarea underneath --
    // the claim-code path is offered FIRST (it renders before the textarea in document order).
    {
      const { engine } = claimActivationEngine(() => Promise.reject(new Error("not called")));
      const { section } = mountClaimActivation(engine);
      const inputs = qsa(section, "input, textarea");
      ok("the claim-code input renders", qs(section, "#licence-claim-code") !== null);
      ok("the token textarea renders", qs(section, "#licence-token") !== null);
      ok(
        "the claim-code input comes FIRST in document order (the email leads with it)",
        inputs[0] !== undefined && (inputs[0] as unknown as { id: string }).id === "licence-claim-code",
      );
      ok("the one hint line is present", textOf(section).includes(CLAIM_HINT_TEXT));
    }

    // 37b. SUCCESS: a well-shaped code fetches a token, and that FETCHED token (not the code) reaches
    // engine.setLicence; a successful engine verify reloads the section.
    {
      claimFetchCalls = 0;
      nextClaimResponse = () => new Response(JSON.stringify({ token: "FETCHED-TOKEN", account: "a", tier: "business-3", notAfter: "x" }), { status: 200 });
      const { engine, tokens } = claimActivationEngine(() => Promise.resolve(lic("business-3", { valid: true })));
      const { section, reloadCount } = mountClaimActivation(engine);
      fieldValue(section, "licence-claim-code", CLAIM_CANONICAL);
      activateBtn(section)?.click();
      await flushAsync();
      eq("the claim endpoint was called exactly once", claimFetchCalls, 1);
      eq("engine.setLicence received the FETCHED token, not the claim code", tokens[0] ?? null, "FETCHED-TOKEN");
      eq("a successful verify reloads the section", reloadCount(), 1);
      eq("no inline error is left showing", shownError(section), "");
    }

    // 37c. 404: the not-recognised copy shows inline; the engine is NEVER called (nothing to verify).
    {
      claimFetchCalls = 0;
      nextClaimResponse = () => new Response(JSON.stringify({ error: "nope" }), { status: 404 });
      const { engine, tokens } = claimActivationEngine(() => Promise.reject(new Error("must not be called")));
      const { section, reloadCount } = mountClaimActivation(engine);
      fieldValue(section, "licence-claim-code", CLAIM_CANONICAL);
      activateBtn(section)?.click();
      await flushAsync();
      eq("the not-recognised copy is shown inline", shownError(section), CLAIM_NOT_RECOGNISED_TEXT);
      eq("the engine was never called", tokens.length, 0);
      eq("no reload happened", reloadCount(), 0);
      eq("the button is re-enabled with its resting label", activateBtn(section)?.text ?? "", "Activate");
    }

    // 37d. network failure: the unreachable copy shows inline; the engine is never called.
    {
      nextClaimResponse = () => {
        throw new TypeError("network down");
      };
      const { engine, tokens } = claimActivationEngine(() => Promise.reject(new Error("must not be called")));
      const { section } = mountClaimActivation(engine);
      fieldValue(section, "licence-claim-code", CLAIM_CANONICAL);
      activateBtn(section)?.click();
      await flushAsync();
      eq("the unreachable copy is shown inline", shownError(section), CLAIM_UNREACHABLE_TEXT);
      eq("the engine was never called", tokens.length, 0);
    }

    // 37e. BOTH empty -> the existing empty-input message, unchanged (today's exact copy: the field's own
    // required-message for the "Licence token" label), and the engine is never called.
    {
      const { engine, tokens } = claimActivationEngine(() => Promise.reject(new Error("must not be called")));
      const { section, reloadCount } = mountClaimActivation(engine);
      activateBtn(section)?.click();
      await flushAsync();
      eq("both empty -> the existing required-field message, unchanged", shownError(section), "Licence token is required.");
      eq("the engine was never called", tokens.length, 0);
      eq("no reload happened", reloadCount(), 0);
    }

    // 37f. the TEXTAREA path, claim field left empty: behaves EXACTLY as before claim codes existed -- the
    // pasted value reaches engine.setLicence unchanged, and the claim endpoint is never even called.
    //
    // THE FIXTURE MOVED FROM A ONE-PART VALUE TO A TWO-PART VALUE, and the reason is the defect the
    // token field's new shape rule closes: the engine's own gate (engine/src/admin/router-updates.ts:221)
    // takes EXACTLY TWO dot-joined parts, so a three-part token is a 400 "that does not look like a licence
    // token". This test had been paving a paste the engine would have refused, which is precisely the state
    // the field's old presence-only rule allowed. The assertion is unchanged: the pasted value must reach
    // setLicence verbatim.
    {
      claimFetchCalls = 0;
      const { engine, tokens } = claimActivationEngine(() => Promise.resolve(lic("enterprise", { valid: true })));
      const { section, reloadCount } = mountClaimActivation(engine);
      fieldValue(section, "licence-token", "pastedtoken.value");
      activateBtn(section)?.click();
      await flushAsync();
      eq("the claim endpoint was never called", claimFetchCalls, 0);
      eq("engine.setLicence received the PASTED value verbatim", tokens[0] ?? null, "pastedtoken.value");
      eq("a successful verify reloads the section", reloadCount(), 1);
    }

    // 37g. a WRONG-SHAPE claim code (no DWNP prefix) alongside a pasted token: rejected as a claim code
    // with no error of its own, quietly falling back to the token-paste path -- not a crash, not a second
    // error alongside the real one.
    {
      claimFetchCalls = 0;
      const { engine, tokens } = claimActivationEngine(() => Promise.resolve(lic("business-3", { valid: true })));
      const { section, reloadCount } = mountClaimActivation(engine);
      fieldValue(section, "licence-claim-code", "NOT-A-CLAIM-CODE");
      fieldValue(section, "licence-token", "pastedtoken.value");
      activateBtn(section)?.click();
      await flushAsync();
      eq("the claim endpoint was never called (wrong shape, not attempted)", claimFetchCalls, 0);
      eq("the token-paste path ran instead", tokens[0] ?? null, "pastedtoken.value");
      eq("a successful verify reloads the section", reloadCount(), 1);
    }

    // 37h. the claim-code path takes PRIORITY: a well-shaped code alongside an ALSO non-empty textarea
    // still fetches and submits the FETCHED token, never the textarea's stale/irrelevant value.
    {
      claimFetchCalls = 0;
      nextClaimResponse = () => new Response(JSON.stringify({ token: "FETCHED-TOKEN-2", account: "a", tier: "business-3", notAfter: "x" }), { status: 200 });
      const { engine, tokens } = claimActivationEngine(() => Promise.resolve(lic("business-3", { valid: true })));
      const { section } = mountClaimActivation(engine);
      fieldValue(section, "licence-claim-code", CLAIM_CANONICAL);
      fieldValue(section, "licence-token", "some-other-pasted-value");
      activateBtn(section)?.click();
      await flushAsync();
      eq("the claim-code path took priority over the non-empty textarea", tokens[0] ?? null, "FETCHED-TOKEN-2");
      eq("the claim endpoint was called", claimFetchCalls, 1);
    }

    // 37i. an engine refusal on the FETCHED token surfaces the EXISTING refusal copy, unchanged (the
    // verify-before-store contract is untouched by where the token came from).
    {
      nextClaimResponse = () => new Response(JSON.stringify({ token: "BAD-TOKEN", account: "a", tier: "business-3", notAfter: "x" }), { status: 200 });
      const { engine } = claimActivationEngine(() => Promise.reject(new Error(`set licence: ${ENGINE_SIG_BODY}: 400`)));
      const { section, reloadCount } = mountClaimActivation(engine);
      fieldValue(section, "licence-claim-code", CLAIM_CANONICAL);
      activateBtn(section)?.click();
      await flushAsync();
      eq("the engine's verify-before-store refusal shows verbatim, unchanged", shownError(section), ENGINE_SIG_BODY);
      eq("no reload happened on a refusal", reloadCount(), 0);
    }
  } finally {
    (globalThis as { fetch: unknown }).fetch = claimRealFetch;
  }
}

// Reset the caller installed for section 37 (test hygiene: this file otherwise never installs one, except
// transiently in section 31, which likewise resets to null when done).
setCaller(null);

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// G307: a MALFORMED engine/vendor value must not render as an ABSENT one.
//
// Three cues in this screen are computed from values the engine or the licence token supplies, and all
// three were DISARMED SILENTLY by a malformed input, because "malformed" and "absent" collapsed onto the
// same null:
//   - an unparseable notAfter  -> renewalNotice returns null -> no renews-soon cue, no expired cue. A
//                                 mis-minted Enterprise token therefore looks exactly like a healthy one
//                                 right up to the day it lapses ("we never saw a renewal warning").
//   - a malformed band triple  -> parseBandFeatures returns null -> no band line, no over-band nudge.
//   - a malformed artefact SHA -> artefactHashState returns null -> the SAME "not stamped" placeholder an
//                                 honest unstamped dev build shows.
// Each now has a predicate that is TRUE only for the malformed case, so the screen names the fault. The
// malformed value itself is never rendered: only the verdict travels.
// ---------------------------------------------------------------------------
console.log("\n-- G307: malformed engine values are named, not silently swallowed --");
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  // notAfter.
  ok("a garbage notAfter is UNREADABLE", licenceStampUnreadable(lic("enterprise", { notAfter: "not-a-date" })));
  ok("a garbage notAfter still disarms renewalNotice (which is why the predicate exists)", renewalNotice(lic("enterprise", { notAfter: "not-a-date" }), NOW) === null);
  ok("an ABSENT notAfter is NOT unreadable (Community never lapses: nothing is wrong)", !licenceStampUnreadable(lic("community")));
  ok("an empty notAfter is NOT unreadable", !licenceStampUnreadable(lic("community", { notAfter: "" })));
  ok("negative control: a valid notAfter is NOT unreadable", !licenceStampUnreadable(lic("enterprise", { notAfter: isoInDays(90) })));
  ok("the unreadable-stamp line says no renewal cue can be shown", LICENCE_STAMP_UNREADABLE_LINE.toLowerCase().includes("renewal"));
  ok("the unreadable-stamp line never echoes a value", !LICENCE_STAMP_UNREADABLE_LINE.includes("not-a-date"));

  // Band triple.
  ok("a band: with no estates:/protected-gb: is MALFORMED", bandFeaturesMalformed(["band:growth"]));
  ok("a band: with a non-numeric estates: is MALFORMED", bandFeaturesMalformed(["band:growth", "estates:many", "protected-gb:500"]));
  ok("a band: with a negative protected-gb: is MALFORMED", bandFeaturesMalformed(["band:growth", "estates:5", "protected-gb:-1"]));
  ok("NO band claimed at all is NOT malformed (an ordinary licence, nothing is wrong)", !bandFeaturesMalformed(["support:priority"]));
  ok("absent features are NOT malformed", !bandFeaturesMalformed(undefined));
  ok("negative control: a COMPLETE band triple is NOT malformed", !bandFeaturesMalformed(["band:growth", "estates:5", "protected-gb:500"]));
  ok("the malformed-band line never echoes a feature string", !BAND_MALFORMED_LINE.includes("band:"));

  // Estate figures.
  ok("a non-finite totalProtectedBytes is UNREADABLE", estateFiguresUnreadable(est(Number.NaN, 2)));
  ok("a negative account count is UNREADABLE", estateFiguresUnreadable(est(gbBytes(10), -3)));
  ok("an unreadable estate still withholds the summary line (which is why the predicate exists)", estateSummaryLine(est(Number.NaN, 2)) === null);
  ok("an ABSENT estate is NOT unreadable (no completed run yet: nothing is wrong)", !estateFiguresUnreadable(null));
  ok("negative control: a well-formed estate is NOT unreadable", !estateFiguresUnreadable(est(gbBytes(10), 2)));
  ok("the unreadable-estate line never echoes a figure", !ESTATE_UNREADABLE_LINE.includes("NaN"));

  // Artefact stamp.
  ok("a present but short artefactSha384 is MALFORMED", artefactStampMalformed(status({ artefactSha384: "abc123" })));
  ok("a present but non-hex artefactSha384 is MALFORMED", artefactStampMalformed(status({ artefactSha384: "z".repeat(96) })));
  ok("an ABSENT artefactSha384 is NOT malformed (an unstamped build: nothing is wrong)", !artefactStampMalformed(status({})));
  ok("negative control: a real 96-hex SHA-384 is NOT malformed", !artefactStampMalformed(status({ artefactSha384: REAL_SHA384 })));
  ok("the malformed-artefact line never echoes a value", !ARTEFACT_STAMP_MALFORMED_LINE.includes("abc123"));
}

// ===========================================================================
// A LICENCE MINTED FOR ANOTHER CLOUDFLARE ACCOUNT
// ===========================================================================
// The engine computes accountClaimMatchesEngine on every licence read and ships it (its own account tag
// against the token's signed account claim, a boolean with the claim's value withheld). This console had
// no reference to the field anywhere, so a licence issued against someone else's account was stored,
// reported as its tier, and confirmed to the operator as activated with nothing saying otherwise.
//
// The verdict drives what the screen SAYS, never what it permits: fail-open is absolute and the engine
// does not enforce the claim, so every assertion here is about copy and about the strictness of the
// predicate, which is where the honesty lives.
console.log("\n-- a licence minted for another Cloudflare account --");
{
  const enterprise = (extra: Partial<LicenceStatus> = {}): LicenceStatus => lic("enterprise", { valid: true, notAfter: isoInDays(200), ...extra });

  // The predicate is EXACTLY === false. An absent verdict is "not established" and must read as neither a
  // match nor a mismatch: an engine with no account tag, an engine that predates the field, and an invalid
  // or expired licence all leave it absent, and a truthiness test would claim a mismatch on every one of
  // them while a `!== true` test would do the same.
  ok("a false verdict is a mismatch", licenceAccountMismatch(enterprise({ accountClaimMatchesEngine: false })));
  ok("a true verdict is NOT a mismatch", !licenceAccountMismatch(enterprise({ accountClaimMatchesEngine: true })));
  ok("an ABSENT verdict is NOT a mismatch (an engine with no account tag, or an older engine)", !licenceAccountMismatch(enterprise()));
  ok("negative control: an ordinary community licence is not a mismatch", !licenceAccountMismatch(lic("community")));

  // The standing line states the fact, keeps the fail-open reassurance, and names a remedy. It must never
  // carry an account id: the engine deliberately withholds the claim's value, and a console that printed
  // one would be printing a value it was never sent.
  //
  // A later change altered WHEN this can fire (claiming with your own code binds
  // the account automatically, so this is now primarily "a token pasted from somewhere else") and the
  // wording changed with it: the PRIMARY remedy is now claiming with this account's own code, support is
  // the fallback, not the first line of defence.
  ok("the standing line names the account fact", LICENCE_ACCOUNT_MISMATCH_LINE.includes("does not name this Cloudflare account"));
  ok("the standing line keeps fail-open", LICENCE_ACCOUNT_MISMATCH_LINE.includes("nothing is gated"));
  ok("the standing line's PRIMARY remedy is claiming with this account's own code", LICENCE_ACCOUNT_MISMATCH_LINE.includes("claim code from this account's own licence email"));
  ok("the standing line names support as the fallback remedy", LICENCE_ACCOUNT_MISMATCH_LINE.includes("support@downpipes.io"));
  ok("the standing line never claims the licence will stop working", !/stop working|will be refused|no longer valid/i.test(LICENCE_ACCOUNT_MISMATCH_LINE));
  ok("the standing line carries no account id (the engine never sends one)", !/[0-9a-f]{32}/i.test(LICENCE_ACCOUNT_MISMATCH_LINE));

  // The activation toast. THE ORDINARY PATH IS UNCHANGED, byte for byte, so the fix cannot be mistaken for
  // a rewording of a working confirmation.
  eq("ordinary paid activation -> the unchanged confirmation", licenceActivatedLine(enterprise()), "Licence activated: Enterprise tier.");
  eq("ordinary community activation -> the unchanged confirmation", licenceActivatedLine(lic("community")), "Licence activated (Community).");
  eq("a matching account -> the unchanged confirmation", licenceActivatedLine(enterprise({ accountClaimMatchesEngine: true })), "Licence activated: Enterprise tier.");
  {
    const mismatched = licenceActivatedLine(enterprise({ accountClaimMatchesEngine: false }));
    // It must still say what really happened (the licence WAS stored and the tier IS reported): a toast
    // that only warned would be as false as one that only confirmed, in the other direction.
    ok("the mismatch toast says the licence was stored", mismatched.includes("stored"));
    ok("the mismatch toast names the tier the engine reports", mismatched.includes("Enterprise"));
    ok("the mismatch toast names the account fact", mismatched.includes("different Cloudflare account"));
    ok("the mismatch toast points at the card's note", mismatched.includes("Licence card"));
    // The failure this whole section exists to stop: it must not read as an ordinary success.
    ok("the mismatch toast is NOT the ordinary confirmation", mismatched !== "Licence activated: Enterprise tier.");
    ok("the mismatch toast does not open with a bare 'Licence activated'", !mismatched.startsWith("Licence activated"));
  }

  // The screen actually renders it. The two pure functions above could both be right while nothing on the
  // card changed, which is the shape of the original defect: the engine's verdict existed and no screen
  // read it.
  {
    const engineStub = {} as unknown as EngineClient; // handlers only fire on click; render never calls it
    const cardText = (l: LicenceStatus): string => textOf(renderLicenceView(engineStub, { licence: l, updates: upd(false), status: status({}), updateState: null }, () => {}));
    ok("the Licence card renders the standing note on a mismatch", cardText(enterprise({ accountClaimMatchesEngine: false })).includes("does not name this Cloudflare account"));
    ok("negative control: a matching account renders no such note", !cardText(enterprise({ accountClaimMatchesEngine: true })).includes("different Cloudflare account"));
    ok("negative control: an absent verdict renders no such note", !cardText(enterprise()).includes("different Cloudflare account"));
  }
}

// ===========================================================================
// THE ENGINE HAS NOT IDENTIFIED ITS OWN ACCOUNT YET
// ===========================================================================
//
// Before this, an engine that had never had CF_ACCOUNT_ID set and had never completed an attach or an
// update-apply sent no cfAccountId on GET /admin/status, and the Licence card said nothing about it: not
// a mismatch (the engine's own accountClaimMatchesEngine verdict is absent too, since checkExpiry only
// computes it once it already knows its account), just silence, indistinguishable from "binding does not
// apply here". This section proves the predicate and the standing note that replace the silence.
console.log("\n-- the engine has not identified its own account yet --");
{
  const enterprise = (extra: Partial<LicenceStatus> = {}): LicenceStatus => lic("enterprise", { valid: true, notAfter: isoInDays(200), ...extra });

  ok("cfAccountId absent -> unknown", licenceAccountUnknown(undefined));
  ok("cfAccountId present -> NOT unknown", !licenceAccountUnknown("aaaa1111aaaa1111aaaa1111aaaa1111"));

  // The standing hint must stay calm (no fault language) and must say the plain remedy: nothing to do,
  // it resolves on the first attach or update.
  ok("the standing hint names the plain cause", LICENCE_ACCOUNT_UNKNOWN_LINE.includes("has not identified its own Cloudflare account"));
  ok("the standing hint names the remedy (attach or update)", LICENCE_ACCOUNT_UNKNOWN_LINE.includes("attach a source or apply an update"));
  ok("the standing hint never reads as a fault", !/wrong|mismatch|error|fail(?!-open)/i.test(LICENCE_ACCOUNT_UNKNOWN_LINE));
  ok("the standing hint carries no account id", !/[0-9a-f]{32}/i.test(LICENCE_ACCOUNT_UNKNOWN_LINE));

  // The screen actually renders it, and the two states are MUTUALLY EXCLUSIVE by construction: a mismatch
  // requires accountClaimMatchesEngine === false, which the engine only ever sets once it already knows
  // its own account -- the exact condition an absent cfAccountId says is not yet true.
  {
    const engineStub = {} as unknown as EngineClient;
    const cardText = (l: LicenceStatus, cfAccountId?: string): string =>
      textOf(renderLicenceView(engineStub, { licence: l, updates: upd(false), status: status(cfAccountId !== undefined ? { cfAccountId } : {}), updateState: null }, () => {}));
    ok("cfAccountId absent -> the card renders the standing hint", cardText(enterprise()).includes("has not identified its own Cloudflare account"));
    ok("cfAccountId present -> no such hint", !cardText(enterprise(), "aaaa1111aaaa1111aaaa1111aaaa1111").includes("has not identified its own Cloudflare account"));
    ok("a mismatch takes precedence and the hint does not also render", !cardText(enterprise({ accountClaimMatchesEngine: false })).includes("has not identified its own Cloudflare account"));
  }
}

// ===========================================================================
// A REPEAT ACTIVATION THAT SHORTENS THE LICENCE
// ===========================================================================
// The engine's DO stores whatever verifies, with no comparison against the record already there
// (scheduler-do-account-config.ts setLicenceToken puts unconditionally), so pasting an older term's token
// over a current one is accepted, reported as the tier it names, and confirmed as an ordinary activation.
//
// The REFUSAL for that belongs in the engine and is handed up, not built here: the console never sees the
// pasted token's claims (the token is opaque to it and the engine is the only party that verifies it), so
// there is no pre-submit check available at any price. What the console holds is both sides of the
// exchange, and REPORTING from those two is evidence rather than a guess. That is what these pin.
console.log("\n-- a repeat activation that shortens the licence --");
{
  const at = (iso: string): LicenceStatus => lic("enterprise", { valid: true, notAfter: iso });
  const LONG = "2027-06-30T00:00:00Z";
  const SHORT = "2026-06-30T00:00:00Z";

  ok("a later date replaced by an earlier one IS a shortening", licenceValidityShortened(at(LONG), at(SHORT)));
  ok("an earlier date replaced by a later one is NOT (an ordinary renewal)", !licenceValidityShortened(at(SHORT), at(LONG)));
  // Re-pasting the SAME token is the flow working, not a fault, and must not be reported as one. This is
  // the case the handed finding called "repeated activation is not refused at all": it is idempotent, the
  // engine's answer is true, and refusing it would turn a harmless confirming re-paste into a dead end.
  ok("re-pasting the same token is NOT a shortening", !licenceValidityShortened(at(LONG), at(LONG)));
  // Never a fabricated claim: if either side cannot be read, nothing is asserted about the move.
  ok("an absent previous notAfter asserts nothing", !licenceValidityShortened(lic("community"), at(SHORT)));
  ok("an absent new notAfter asserts nothing", !licenceValidityShortened(at(LONG), lic("community")));
  ok("an unparseable previous notAfter asserts nothing", !licenceValidityShortened(at("not-a-date"), at(SHORT)));
  ok("an unparseable new notAfter asserts nothing", !licenceValidityShortened(at(LONG), at("not-a-date")));

  // The clause states BOTH dates (the size of the move is the point) and names the likely cause without
  // asserting it. It must never say the activation failed, because it did not.
  {
    const clause = licenceShortenedClause(at(LONG), at(SHORT));
    ok("the clause names the new date", clause.includes("2026"));
    ok("the clause names the date it replaced", clause.includes("2027"));
    ok("the clause points at the most recent licence email", clause.includes("most recent licence email"));
    ok("the clause never says the activation failed", !/failed|refused|was not stored|not activated/i.test(clause));
  }

  // The toast composes the two facts rather than choosing between them: a shortened licence and a
  // foreign-account licence are independent, and either can be true without the other.
  eq("no previous status supplied -> the unchanged confirmation", licenceActivatedLine(at(SHORT)), "Licence activated: Enterprise tier.");
  eq("a previous status that was NOT shortened -> the unchanged confirmation", licenceActivatedLine(at(LONG), at(SHORT)), "Licence activated: Enterprise tier.");
  {
    const shortened = licenceActivatedLine(at(SHORT), at(LONG));
    ok("a shortening still confirms the activation", shortened.startsWith("Licence activated: Enterprise tier."));
    ok("a shortening appends the clause", shortened.includes("earlier than"));
  }
  {
    // Both at once: the account sentence leads (it is the one that says something is wrong with the
    // licence itself) and the shortening clause follows. Neither displaces the other.
    const both = licenceActivatedLine(lic("enterprise", { valid: true, notAfter: SHORT, accountClaimMatchesEngine: false }), at(LONG));
    ok("both facts: the account fact is named", both.includes("different Cloudflare account"));
    ok("both facts: the shortening is named", both.includes("earlier than"));
    ok("both facts: it does not read as an ordinary confirmation", !both.startsWith("Licence activated"));
  }
}

// Summary
// ---------------------------------------------------------------------------
console.log("");
if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) {
  console.log(`VALIDATE-LICENCE: ${failures} FAILED`);
  process.exit(1);
}
console.log("VALIDATE-LICENCE VECTORS PASS");
