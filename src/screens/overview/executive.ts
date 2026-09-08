// Overview (IA screen 1) executive (shiny) framing: the five plain-English answers a
// manager actually asks (protected? / recoverable? / compliant? / who has access? / cost?),
// each a click-through to the technical evidence. A SECOND FRAMING of the SAME OverviewData
// the technical dashboard reads (no second fetch, no second derivation), so the two can
// never disagree. The answer COMPUTATION is a pure function (executiveAnswers) so it is
// exhaustively unit-testable. Moved verbatim out of overview.ts for size. House rules:
// Australian English, no em dashes, precise claims.

import { recordContractSkew } from "../../lib/client-diag/ring.ts";
import { accessVerdictFromCaller, type AccessVerdict } from "../../components/trust-chips.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { navigate, caller, whoamiAvailable } from "../../lib/nav.ts";
import type { StatusTone } from "../../components/status.ts";
import { relativeTime, groupNumber, humanBytes } from "../../lib/format.ts";
import { fleetProtection, destinationFromStatus } from "../../lib/protection-statement.ts";
import {
  PRESETS,
  monthlyCost,
} from "../../lib/cost-model.ts";
import {
  ICON_REFRESH,
  ICON_CHEVRON_RIGHT,
} from "../../lib/icons.ts";
import {
  COST_HEADLINE_MONTH,
  COST_CURRENCY_PREFIX,
  plural,
  newestDrill,
  trailReadState,
  type OverviewData,
  type FleetSummary,
} from "./shared.ts";
import { summariseFleet, observedCostSeed } from "./fleet-data.ts";
import { fleetBanner } from "./tiles.ts";
import { buildSurfaceCoverageGrid } from "./surface-coverage.ts";
import { buildFleetSection } from "./fleet-section.ts";
import { buildNeedsMe, buildRecoverySection } from "./recovery.ts";

// ExecVerdict is the tone an answer carries, mapped to the status-dot vocabulary. "good" reads
// reassuring (ok/trust), "watch" is an honest caution (warn), "bad" is a real gap (danger), and
// "unknown" is the honest "could not read" (neutral) -- never softened to good.
export type ExecVerdict = "good" | "watch" | "bad" | "unknown";

// ExecAnswer is one plain-English answer: the question, a short verdict word, the tone, the one-line
// plain answer, an honest detail line, and the click-through to the screen that holds the evidence.
// All strings are product copy or pass through the h() textContent path; no markup surface.
export interface ExecAnswer {
  key: "protected" | "recoverable" | "compliant" | "access" | "cost";
  question: string;
  verdict: string;
  tone: ExecVerdict;
  headline: string;
  detail: string;
  evidence: { label: string; route: string };
}

// execVerdictToStatusTone maps the executive verdict to the status-dot tone. "good" uses trust (the
// reassurance hue) so a calm answer reads distinctly from a plain ok; watch=warn, bad=danger,
// unknown=neutral. Never maps watch/bad/unknown to a reassuring tone (the honesty floor).
function execVerdictToStatusTone(v: ExecVerdict): StatusTone {
  switch (v) {
    case "good": return "trust";
    case "watch": return "warn";
    case "bad": return "danger";
    case "unknown": return "neutral";
  }
}

// executiveAnswers computes the five plain-English answers from the SAME OverviewData + FleetSummary
// the technical surface reads, plus the live Access verdict (access | token | unknown). Pure and
// DOM-free, so every branch is unit-testable. Honest precedence throughout: an unreadable source is
// "unknown", never a green; a backed-up-but-unproven posture is "watch", never "good".
export function executiveAnswers(
  data: OverviewData,
  fleet: FleetSummary,
  accessVerdict: AccessVerdict,
): ExecAnswer[] {
  return [
    protectedAnswer(data),
    recoverableAnswer(data, fleet),
    compliantAnswer(data),
    accessAnswer(accessVerdict),
    costAnswer(data, fleet),
  ];
}

// protectedAnswer reuses the SAME fleetProtection generator the technical lead and the downpipes
// screen use, so the executive "are we protected" answer can never disagree with them. An unreadable
// downpipe list is an honest unknown (never a claim that nothing -- or everything -- is protected).
function protectedAnswer(data: OverviewData): ExecAnswer {
  const ev = { label: "See every downpipe", route: "/downpipes" };
  // Null-defensive: a PARTIAL response can settle ok:true yet carry an undefined value (the type
  // promises DownpipeState[]; the wire does not). Treat a missing list exactly like an unread one
  // so fleetProtection never throws on states.length and the answer stays an honest unknown rather
  // than blanking the whole executive overview.
  // The list SETTLED OK and carried no array. That is an engine-console contract break, and the honest
  // "Unknown" verdict below masks it perfectly: it reads exactly like a list that could not be read at all
  // (data.downpipes.ok === false), which is an outage and a completely different ticket. The row separates them,
  // and it fires ONLY on the contract break: an unread list records nothing here.
  if (data.downpipes.ok && data.downpipes.value === undefined) recordContractSkew("missing-field", "downpipe-list");
  else if (data.downpipes.ok && !Array.isArray(data.downpipes.value)) recordContractSkew("wrong-shape", "downpipe-list");
  if (!data.downpipes.ok || data.downpipes.value === undefined) {
    return {
      key: "protected",
      question: "Are we protected?",
      verdict: "Unknown",
      tone: "unknown",
      headline: "We could not read the downpipe list, so we cannot state the protection posture right now.",
      detail: "This is an honest unknown, not a claim that nothing is protected. Retry, or check the engine connection.",
      evidence: ev,
    };
  }
  const dest = destinationFromStatus(data.status.ok ? data.status.value : null);
  const fp = fleetProtection(data.downpipes.value, dest);
  const tone: ExecVerdict =
    fp.tone === "covered" ? "good" : fp.tone === "uncovered" ? "bad" : "watch";
  const verdict =
    fp.tone === "covered" ? "Yes" : fp.tone === "uncovered" ? "No" : fp.tone === "unproven" ? "Backed up, not proven" : "Mostly";
  return {
    key: "protected",
    question: "Are we protected?",
    verdict,
    tone,
    headline: fp.summary,
    detail: fp.notCovered,
    evidence: ev,
  };
}

// recoverableAnswer reads the SAME recovery point (newest good backup) + drill-evidence trail the
// technical recovery card reads. Honest precedence: no runs -> not yet proven (neutral prompt); a
// good backup but no recorded drill -> watch (backed up is not the same as proven recoverable); a
// recorded drill -> good, dated. An unreadable history is unknown.
function recoverableAnswer(data: OverviewData, fleet: FleetSummary): ExecAnswer {
  const ev = { label: "Open recovery and drill", route: "/restore" };
  if (!data.history.ok) {
    return {
      key: "recoverable",
      question: "Can we get it back?",
      verdict: "Unknown",
      tone: "unknown",
      headline: "We could not read the run history, so we cannot state recoverability right now.",
      detail: "Retry, or check the engine connection. This is an honest unknown, not a failure.",
      evidence: ev,
    };
  }
  if (!fleet.anyRuns) {
    return {
      key: "recoverable",
      question: "Can we get it back?",
      verdict: "Not yet",
      tone: "watch",
      headline: "No backup has run yet, so recovery is not yet demonstrated.",
      detail: "Create and run a downpipe, then drill a run to prove recovery works.",
      evidence: ev,
    };
  }
  const newestDrillEntry = data.drillEvidence.ok ? newestDrill(data.drillEvidence.value) : null;
  if (newestDrillEntry) {
    const kindWord = newestDrillEntry.kind === "offline-rehearsal" ? "offline rehearsal" : "in-account drill";
    return {
      key: "recoverable",
      question: "Can we get it back?",
      verdict: "Yes, proven",
      tone: "good",
      headline: `Recovery is demonstrated: the most recent ${kindWord} was ${relativeTime(newestDrillEntry.recordedAt)}.`,
      detail: fleet.newestGoodAt
        ? `The newest good backup is ${relativeTime(fleet.newestGoodAt)}. The full dated evidence is on the recovery surface.`
        : "The full dated evidence is on the recovery surface.",
      evidence: ev,
    };
  }
  // Backed up, but not drilled (or the drill-evidence route is not yet wired): a genuine watch, never
  // a reassuring green. A silently-untested backup is the gap this surface exists to surface.
  return {
    key: "recoverable",
    question: "Can we get it back?",
    verdict: "Backed up, not drilled",
    tone: "watch",
    headline: fleet.newestGoodAt
      ? `The newest good backup is ${relativeTime(fleet.newestGoodAt)}, but recovery has not been drilled.`
      : "Backups have run, but recovery has not been drilled.",
    detail: "A backup that is never restored is unproven. Drill a recent run so recovery is demonstrated, not assumed.",
    evidence: ev,
  };
}

// compliantAnswer is deliberately framed as "is the evidence in place" rather than asserting a
// compliance verdict (which the console cannot determine). It reads what it CAN honestly: the
// configuration presence (signer + break-glass + destination, the recoverability floor) and whether
// the signed-evidence surfaces are reachable. It never claims "compliant"; it states whether the
// evidence an auditor needs is in place, and links to the signed reports.
function compliantAnswer(data: OverviewData): ExecAnswer {
  const ev = { label: "Open the signed reports", route: "/reports" };
  if (!data.status.ok) {
    return {
      key: "compliant",
      question: "Is the evidence in place?",
      verdict: "Unknown",
      tone: "unknown",
      headline: "We could not read the configuration, so we cannot state whether the evidence floor is in place.",
      detail: "Retry, or check the engine connection.",
      evidence: ev,
    };
  }
  const s = data.status.value;
  const missing: string[] = [];
  if (!s.signerConfigured) missing.push("a signer");
  if (!s.breakGlassConfigured) missing.push("a break-glass key");
  if (!s.destConfigured) missing.push("a destination");
  if (missing.length > 0) {
    return {
      key: "compliant",
      question: "Is the evidence in place?",
      verdict: "Incomplete",
      tone: "watch",
      headline: `The recoverability floor is not fully configured. ${missing.length === 1 ? "This is" : `These ${missing.length} items are`} not present: ${missing.join(", ")}.`,
      detail: "Presence is not validity. Complete the setup, then the signed reports build the evidence trail an auditor reads.",
      evidence: { label: "Finish setup", route: "/security" },
    };
  }
  // The floor is present. The durable, dated audit + drill trail is an engine addition (D4) when not yet
  // wired; be honest about that rather than claiming a complete evidence chain, and do not describe a real
  // read fault as an unbuilt feature (B44).
  const state = trailReadState(data.drillEvidence, data.audit);
  return {
    key: "compliant",
    question: "Is the evidence in place?",
    verdict: state === "live" ? "In place" : "Floor in place",
    tone: "good",
    headline: "The recoverability floor is present: a signer, a break-glass key and a destination are all configured.",
    detail:
      state === "live"
        ? "The signed reports and the tamper-evident trail give an auditor the evidence they need, generated and held in your own account."
        : state === "not-wired"
          ? "The signed reports are available now; the durable dated audit and drill trail is an engine addition that completes the chain."
          : "The signed reports are available now; the durable dated audit and drill trail could not be read (the engine faulted), so the chain is not confirmed until that read recovers.",
    evidence: ev,
  };
}

// accessAnswer reads the SAME Access verdict the trust chip reads, and now it really is the same read: it takes
// the AccessVerdict accessVerdictFromCaller produced. It never hardcodes a green: the token fallback is an
// honest watch (actions are not attributable to a person), and an unknown verdict reads unknown.
//
// IT USED TO RE-IMPLEMENT THE METHOD READ, AND THE RE-IMPLEMENTATION LIED. The old three-state read was
// "access -> access; passkey -> passkey; everything else -> token", so a live OIDC session, a live SAML session,
// a recovery-code sign-in and any method a newer engine adds all rendered the SHARED-TOKEN card: "the engine is
// reachable with a shared token, so actions are not attributable to a person", with the remedy "put the engine
// behind Cloudflare Access". On the same screen the trust chip said the session was IdP-verified. It is the worst
// claim the console can make about a customer's posture, it was false for three of the six methods the engine can
// report, and it named a remedy that would fix nothing. Deriving from the verdict is what makes the comment above
// (the card and the chip cannot disagree) true.
function accessAnswer(verdict: AccessVerdict): ExecAnswer {
  const ev = { label: "Open access and roles", route: "/access" };
  if (verdict.state === "verified") {
    return {
      key: "access",
      question: "Who can touch this?",
      verdict: "Named people",
      tone: "good",
      headline: "Access is enforced by Cloudflare Access, so every action is attributable to a verified person.",
      detail: "Roles decide who can do what; the engine enforces them. Review the role table on the access surface.",
      evidence: ev,
    };
  }
  if (verdict.state === "passkey-verified") {
    return {
      key: "access",
      question: "Who can touch this?",
      verdict: "Named people",
      tone: "good",
      headline: "Sign-in is by passkey, so every action is attributable to a verified person without a shared secret.",
      detail: "Passkeys are the engine's own phishing-resistant sign-in; roles decide who can do what and the engine enforces them. Review the role table on the access surface.",
      evidence: ev,
    };
  }
  if (verdict.state === "idp-verified") {
    return {
      key: "access",
      question: "Who can touch this?",
      verdict: "Named people",
      tone: "good",
      headline: `Sign-in is through your identity provider over ${verdict.protocol === "saml" ? "SAML" : "OIDC"}, verified by the engine, so every action is attributable to a verified person.`,
      detail: "The engine verifies the assertion itself; roles decide who can do what and the engine enforces them. Review the role table on the access surface.",
      evidence: ev,
    };
  }
  if (verdict.state === "recovery-verified") {
    return {
      key: "access",
      question: "Who can touch this?",
      verdict: "Recovery sign-in",
      tone: "watch",
      headline: "This session was opened with a recovery code, which is attributable but is the break-glass door.",
      detail: "Return to the usual sign-in (Access, a passkey or your identity provider) and issue fresh recovery codes.",
      evidence: ev,
    };
  }
  if (verdict.state === "token-fallback") {
    return {
      key: "access",
      question: "Who can touch this?",
      verdict: "Shared token",
      tone: "watch",
      headline: "The engine is reachable with a shared token, so actions are not attributable to a person.",
      detail: "Put the engine behind Cloudflare Access so each action is tied to a verified identity.",
      evidence: ev,
    };
  }
  return {
    key: "access",
    question: "Who can touch this?",
    verdict: "Unknown",
    tone: "unknown",
    headline: "The engine has not yet reported the verified identity, so we cannot state who has access.",
    detail: "The access surface shows the roles and the enforcement posture once the engine reports them.",
    evidence: ev,
  };
}

// costAnswer seeds the SAME cost model the technical cost card and the /costs screen use, so the
// executive figure agrees with both. When the observed throughput fields are not present it gives a
// calm prompt, never a fabricated figure. Every figure is an estimate, not a quote.
function costAnswer(data: OverviewData, fleet: FleetSummary): ExecAnswer {
  const ev = { label: "Open the cost calculator", route: "/costs" };
  if (!data.history.ok) {
    return {
      key: "cost",
      question: "What does it cost?",
      verdict: "Unknown",
      tone: "unknown",
      headline: "We could not read the run history, so a projected cost is unavailable.",
      detail: "Open the calculator to estimate a cost from your own figures, in your browser.",
      evidence: ev,
    };
  }
  const seed = observedCostSeed(data.history.value);
  if (!seed) {
    return {
      key: "cost",
      question: "What does it cost?",
      verdict: "Not projected yet",
      tone: "unknown",
      headline: fleet.anyRuns
        ? "Your runs do not yet carry the per-run figures a projection needs."
        : "No runs yet to project a cost from.",
      detail: "Open the calculator to estimate from a source size and a schedule, in your browser. Nothing is sent anywhere.",
      evidence: ev,
    };
  }
  const breakdown = monthlyCost(seed.inputs, PRESETS.r2, { regime: "accumulate", month: COST_HEADLINE_MONTH });
  return {
    key: "cost",
    question: "What does it cost?",
    verdict: `About ${money(breakdown.total)} / month`,
    tone: "good",
    headline: `The projected destination cost is about ${money(breakdown.total)} per month at month ${COST_HEADLINE_MONTH}, around ${humanBytes(breakdown.averageStoredBytes)} stored.`,
    detail: `An estimate, not a quote, projected from your last ${seed.runs} ${plural(seed.runs, "run")} at indicative R2 pricing. Computed in your browser. Open the calculator for your own rates.`,
    evidence: ev,
  };
}

// buildExecutiveOverview assembles the executive body: the honest protection banner (loud failures
// stay loud in either framing), then the five plain-English answer cards, then the same recovery +
// needs-me detail the technical surface carries (so the executive can still act, and nothing is
// hidden). Pure given the data + callbacks, so a poll re-runs it on fresh data and swaps atomically.
export function buildExecutiveOverview(
  data: OverviewData,
  cb: { onDrillFleet: () => void | Promise<void>; announce: (m: string) => void; onRefresh?: () => void },
): HTMLElement {
  const wrap = h("div");
  const fleet = summariseFleet(data);

  // Banners first: a failed/stale fleet is loud in EVERY framing (a silently stopped backup is the
  // worst failure; the executive must not be shielded from it). Reuses the same fleetBanner.
  wrap.appendChild(fleetBanner(fleet));
  // The Cloudflare-coverage hero leads both framings (after the loud banner), so the executive reads like
  // the public advert and gets the same at-a-glance per-surface protection map the technical view does.
  wrap.appendChild(buildSurfaceCoverageGrid(data));
  wrap.appendChild(buildAnswersSection(data, fleet, cb.onRefresh));
  wrap.appendChild(buildExecutiveDetail(data, fleet, cb));
  return wrap;
}

// buildAnswersSection builds the five plain-English answer cards, collapsing 3+ same-cause engine-read
// unknowns into a single "could not reach the engine" card (one Retry, not four restatements of one
// root cause). The access answer's unknown is a whoami matter, not an engine read, so it never joins
// the collapse. The Access verdict reads the live caller method (the SAME read the trust chip uses).
function buildAnswersSection(data: OverviewData, fleet: FleetSummary, onRefresh: (() => void) | undefined): HTMLElement {
  const accessVerdict = execAccessVerdict();
  const answers = executiveAnswers(data, fleet, accessVerdict);
  const unreadable = new Set<ExecAnswer["key"]>();
  if (!data.downpipes.ok) unreadable.add("protected");
  if (!data.history.ok) { unreadable.add("recoverable"); unreadable.add("cost"); }
  if (!data.status.ok) unreadable.add("compliant");
  const collapse = unreadable.size >= 3;
  const section = h("section", { "aria-labelledby": "ov-exec-h" });
  section.appendChild(h("h2", { id: "ov-exec-h", class: "visually-hidden" }, "Plain-English answers"));
  const list = h("div", { class: "ov-exec-grid" });
  if (collapse) list.appendChild(execUnreachableCard(unreadable.size, answers.length, onRefresh));
  for (const answer of answers) {
    if (collapse && unreadable.has(answer.key)) continue;
    list.appendChild(execAnswerCard(answer));
  }
  section.appendChild(list);
  return section;
}

// buildExecutiveDetail renders the same recovery posture + needs-me detail the technical surface
// carries (so the executive can still act and nothing is summarised away), or, for a true-empty
// account, the same teaching empty-state the technical fleet section shows.
function buildExecutiveDetail(
  data: OverviewData,
  fleet: FleetSummary,
  cb: { onDrillFleet: () => void | Promise<void>; announce: (m: string) => void },
): HTMLElement {
  if (fleet.total > 0) {
    // Stacked full-width, not a two-column grid: the recovery posture's stat tiles flow across the
    // whole page (matching the status-row treatment) rather than being crammed into a narrow column.
    const detail = h("div", { style: "margin-top:var(--space-6);display:flex;flex-direction:column;gap:var(--space-6)" });
    detail.appendChild(buildNeedsMe(data, fleet));
    detail.appendChild(buildRecoverySection(data, fleet, cb.onDrillFleet));
    return detail;
  }
  return buildFleetSection(fleet, cb.announce);
}

// execAccessVerdict reads the live caller through THE trust-chip classifier, rather than through a private copy
// of it. accessVerdictFromCaller is the one place that maps a whoami method to a posture claim: it knows
// all six methods the engine can report, it answers `unknown` for a method this console build cannot interpret
// rather than asserting the break-glass posture, and it records the wire-anomaly row from the surface that
// actually saw the value. The old private copy did none of those things, and the executive card contradicted the
// chip beside it on three of the six methods.
function execAccessVerdict(): AccessVerdict {
  return accessVerdictFromCaller(caller(), whoamiAvailable());
}

// execUnreachableCard is the single honest card 3+ same-cause unknown answers collapse
// into: one statement of the one root cause (the engine could not be read) with one
// Retry, instead of the same "could not read X" boilerplate repeated per answer. It is
// a plain region (not a navigation card): the action is the retry, not a click-through.
function execUnreachableCard(unknownCount: number, total: number, onRefresh: (() => void) | undefined): HTMLElement {
  return h(
    "div",
    { class: "card", role: "region", "aria-label": "Engine unreachable" },
    h(
      "div",
      { style: "display:flex;align-items:center;gap:var(--space-2)" },
      h("span", { class: "dot dot--neutral", "aria-hidden": "true" }),
      h("span", { style: "font-weight:var(--weight-semibold)" }, "Could not reach the engine"),
    ),
    h(
      "p",
      { style: "margin-top:var(--space-3)" },
      `${unknownCount} of the ${total} answers cannot be read right now. That is an unreachable engine, not a backup failure.`,
    ),
    h(
      "div",
      { style: "margin-top:var(--space-3);display:flex;align-items:center;gap:var(--space-3)" },
      ...(onRefresh
        ? [h("button", { "data-dp": "overview.button.refresh#1", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => onRefresh() } }, svgIcon(ICON_REFRESH, { size: 14 }), "Retry")]
        : []),
      h("span", { class: "field__hint" }, onRefresh ? "Or check the engine connection." : "Check the engine connection."),
    ),
  );
}

// execAnswerCard renders one ExecAnswer: the question, a tone dot + a short verdict word (hue + shape
// + text, never colour alone), the plain answer, the honest detail, and the click-through to its
// evidence. The whole card is keyboard-operable as a single button so the manager can open the
// evidence with one action; the route is the screen that owns the detail.
function execAnswerCard(answer: ExecAnswer): HTMLElement {
  const tone = execVerdictToStatusTone(answer.tone);
  const card = h(
    "button",
    { "data-dp": "overview.button.card",
      class: "card ov-exec-card",
      type: "button",
      "aria-label": `${answer.question} ${answer.verdict}. ${answer.headline} ${answer.evidence.label}.`,
      on: { click: () => navigate(answer.evidence.route) },
    },
    h(
      "div",
      { class: "ov-exec-card__top", style: "display:flex;align-items:center;gap:var(--space-2);justify-content:space-between" },
      h("span", { class: "field__hint", style: "font-weight:var(--weight-medium)" }, answer.question),
      h(
        "span",
        { class: "ov-exec-card__verdict", style: "display:inline-flex;align-items:center;gap:var(--space-2)" },
        h("span", { class: `dot dot--${tone}`, "aria-hidden": "true" }),
        h("span", { style: "font-weight:var(--weight-semibold)" }, answer.verdict),
      ),
    ),
    h("p", { class: "ov-exec-card__headline", style: "margin-top:var(--space-3)" }, answer.headline),
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, answer.detail),
    h(
      "span",
      // margin-top comes from .ov-exec-card__cta (tokens.css: margin-top auto, the equal-height
      // CTA baseline across cards); an inline margin-top here would out-rank and defeat it.
      { class: "linklike ov-exec-card__cta", "aria-hidden": "true", style: "display:inline-flex;align-items:center;gap:var(--space-1)" },
      answer.evidence.label,
      svgIcon(ICON_CHEVRON_RIGHT, { size: 14 }),
    ),
  );
  return card;
}

// money formats a currency figure for the compact card, matching the /costs screen's money()
// so the two surfaces format the same figure identically. Presentation only; the value comes
// from the cost-model library, never the reverse. A non-finite figure reads "-".
function money(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "-";
  const v = Math.max(0, n);
  if (v === 0) return `${COST_CURRENCY_PREFIX}0.00`;
  if (v < 0.01) return `${COST_CURRENCY_PREFIX}${v.toFixed(4)}`;
  if (v < 1000) return `${COST_CURRENCY_PREFIX}${v.toFixed(2)}`;
  return `${COST_CURRENCY_PREFIX}${groupNumber(Math.round(v))}`;
}
