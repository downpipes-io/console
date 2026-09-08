// Shared leaf for the Security centre: the route constant, the caller-role resolver, the pure (DOM-free)
// posture grading the validator pins (compareChecks / severityRank / statusOrder / severityTone / statusTone
// / scoreStatus), and the small presenters every section reaches for (the severity/status/score badges, the
// control reference, the observed/remediation blocks, the group label, the gate reason and read-only note,
// the note line and the error-text helper). These are the building blocks the posture, coverage and access
// sections share, so they live in this leaf and no section module imports another section module (which would
// form a cycle). Moved verbatim from the security-centre coordinator for size; behaviour, copy and markup are
// unchanged.
//
// House rules: no-custody; status by hue + shape + label; precise claims (tamper-evident, never tamper-proof);
// Australian English, no em dashes.

import { h, svgIcon } from "../../lib/dom.ts";
import { caller } from "../../lib/nav.ts";
import { blindGateRemedy } from "../../lib/identity-remedy.ts";
import { noteGateComputedBlind } from "../../lib/client-diag/identity-gate.ts";
import { badge, statusWithLabel, type StatusTone } from "../../components/status.ts";
import { titleCase } from "../../lib/format.ts";
import type { can, Capability } from "../../lib/identity.ts";
import { callerCan } from "../../lib/identity-custom-roles.ts";
import { ICON_SHIELD_CHECK, ICON_EXTERNAL } from "../../lib/icons.ts";
import type { PostureCheck, PostureOverrideKind, PostureSeverity, PostureStatus } from "../../api.ts";

export const ROUTE_SECURITY = "/security";

export function callerRole(): Parameters<typeof can>[0] {
  const c = caller();
  // THE FALLBACK IS THE FAULT, AND THIS IS WHERE IT HAPPENS. A null caller here does not mean the operator
  // is a viewer, it means we have not been told yet, and every control on this render is about to be gated as if
  // they were. The witness holds the screen; if the identity later LANDS, the race is proven and one row says so.
  if (!c) {
    noteGateComputedBlind();
    return "viewer";
  }
  return c.role;
}

// callerCanCap gates a capability write (e.g. access.policy for the inventory populate) over the
// caller's EFFECTIVE set, so a custom role holding the capability is not floored to the "viewer" the
// engine pins on its built-in role field. Same blind-witness discipline as callerRole: a null caller
// notes the blind gate and fails closed, never shown the control enabled before its role lands.
export function callerCanCap(capability: Capability): boolean {
  const c = caller();
  if (!c) {
    noteGateComputedBlind();
    return false;
  }
  return callerCan(c.role, capability, c.customRole ?? null);
}

// compareChecks orders checks for display: by severity (critical first), then needs-attention before
// customer-graded before passing, then by title for stability. Exported so the validator
// asserts the ranking (the load-bearing "most important unresolved item leads" behaviour).
export function compareChecks(a: PostureCheck, b: PostureCheck): number {
  const sev = severityRank(b.severity) - severityRank(a.severity);
  if (sev !== 0) return sev;
  const st = statusOrder(a.status) - statusOrder(b.status);
  if (st !== 0) return st;
  return a.title.localeCompare(b.title);
}

export function severityRank(s: PostureSeverity): number {
  switch (s) {
    case "critical": return 4;
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
  }
}

export function statusOrder(s: PostureStatus): number {
  // Lower sorts first: the needs-attention pair leads (fail, then needs-attestation), then the
  // customer-graded states, then N/A, then passing.
  switch (s) {
    case "fail": return 0;
    case "unattested": return 1;
    case "risk-accepted": return 2;
    case "compensating-control": return 3;
    case "attested-pass": return 4;
    case "resolved-alternative": return 5;
    case "not-applicable": return 6;
    case "pass": return 7;
  }
}

// isNeedsAttention is the score-negative set the "Needs attention" group shows: a red fail, or a
// control awaiting the owner's attestation. Exported for the validator.
export function isNeedsAttention(s: PostureStatus): boolean {
  return s === "fail" || s === "unattested";
}

// isOverriddenStatus is the customer-graded set (an owner recorded a determination): risk accepted,
// attested pass, compensating control, N/A, or the reserved resolved-alternative. Exported for the
// validator.
export function isOverriddenStatus(s: PostureStatus): boolean {
  return s === "risk-accepted" || s === "attested-pass" || s === "compensating-control" || s === "not-applicable" || s === "resolved-alternative";
}

export function severityTone(s: PostureSeverity): StatusTone {
  switch (s) {
    case "critical": return "danger";
    case "high": return "warn";
    case "medium": return "info";
    case "low": return "neutral";
  }
}

// statusTone derives the dot tone from the status: a pass is ok, a fail uses the severity
// tone (so a critical fail reads danger), needs-attestation and an accepted risk read warn (amber, a
// tracked item, never the red of a failure), the customer-graded passes read trust, and N/A reads
// neutral, so the dot reads by hue AND shape AND the badge text alongside. Takes the already-derived
// severity tone so it stays a pure mapping; exported for the validator.
export function statusTone(status: PostureStatus, severityToneValue: StatusTone): StatusTone {
  switch (status) {
    case "pass": return "ok";
    case "fail": return severityToneValue;
    case "unattested": return "warn";
    case "risk-accepted": return "warn";
    case "attested-pass": return "trust";
    case "compensating-control": return "trust";
    case "not-applicable": return "neutral";
    case "resolved-alternative": return "trust";
  }
}

export function severityBadge(s: PostureSeverity): HTMLElement {
  return badge(severityTone(s), s);
}

export function statusBadge(s: PostureStatus): HTMLElement {
  switch (s) {
    case "pass": return badge("ok", "pass");
    case "fail": return badge("danger", "fail");
    case "unattested": return badge("warn", "needs attestation");
    case "risk-accepted": return badge("warn", "risk accepted");
    case "attested-pass": return badge("trust", "pass (attested)");
    case "compensating-control": return badge("trust", "pass (compensating control)");
    case "not-applicable": return badge("neutral", "N/A");
    case "resolved-alternative": return badge("trust", "pass (alternative control)");
  }
}

export function statusLabel(s: PostureStatus): string {
  switch (s) {
    case "pass": return "pass";
    case "fail": return "fail";
    case "unattested": return "needs attestation";
    case "risk-accepted": return "risk accepted";
    case "attested-pass": return "pass (attested by you)";
    case "compensating-control": return "pass (compensating control)";
    case "not-applicable": return "not applicable (N/A)";
    case "resolved-alternative": return "pass (alternative control)";
  }
}

// overrideKindLabel / overrideKindHelp are the modal's radio labels + explanations: what each
// determination MEANS, what it does to the score, and how it is presented in the signed reports.
export function overrideKindLabel(k: PostureOverrideKind): string {
  switch (k) {
    case "attested-pass": return "Pass: I attest this control is satisfied";
    case "compensating-control": return "Pass: a compensating control is in place";
    case "not-applicable": return "Not applicable (N/A)";
    case "risk-accepted": return "Accept this risk";
  }
}
export function overrideKindHelp(k: PostureOverrideKind): string {
  switch (k) {
    case "attested-pass":
      return "For controls the platform cannot verify automatically (for example MFA enforced at your IdP or in your Cloudflare Access policy). Counts as pass; reports show it as a pass attested by you, with your reason.";
    case "compensating-control":
      return "A different control satisfies the same intent. Counts as pass; reports show it as a pass via a compensating control, with your description.";
    case "not-applicable":
      return "This control does not apply to your deployment. Removed from the score entirely (it neither helps nor hurts); reports show N/A with your reason.";
    case "risk-accepted":
      return "The finding is real and you accept the risk for now. Counts as pass for the score, but stays listed as an accepted risk, never as a pass.";
  }
}

// Posture score bands (0..100): at or above STRONG reads as strong, at or above FAIR reads
// as fair, below FAIR reads as needs work. The validator references these same constants so a
// threshold change stays in one place.
export const POSTURE_SCORE_STRONG = 90;
export const POSTURE_SCORE_FAIR = 70;

// scoreStatus / scoreBadge give the 0..100 score an honest tone following the bands above.
// Never a stale green; the tone follows the real number.
export function scoreStatus(score: number): { tone: StatusTone; label: string } {
  // A SCORE THAT IS NOT A READABLE SCORE MAY NOT REACH A BAND AT ALL. This is recoveryCountTone's defect in
  // a different number, and it is here for the same reason it was there: every `>=` below is FALSE for NaN
  // and TRUE BY COERCION for null and for a numeric string, so the bands answer confidently about a value
  // they never read.
  //
  // On the real badge: a score that arrived null rendered "0 / 100 (needs work)", BYTE-IDENTICAL
  // to a genuine zero, because null coerces to 0 in both the comparison and Math.round; a score that
  // arrived as the string "88" rendered "88 / 100 (fair)", byte-identical to a real 88, right by accident
  // and wrong in principle; NaN and an absent score both rendered "NaN / 100 (needs work)"; and a score of
  // 150 wore the OK GREEN a strong posture wears. This is the Security Centre's headline figure and it
  // rides into the signed posture report, so a number nobody can read must not be given a band.
  //
  // It fails to WARN, never to ok and never to danger. Warn is the honest middle: it is not an assertion
  // that the posture is bad (which "needs work" would be, over a value that was never read) and it is not
  // the green a strong posture earns. That is the same choice recoveryCountTone makes.
  if (!postureScoreReadable(score)) return { tone: "warn", label: "unreadable" };
  if (score >= POSTURE_SCORE_STRONG) return { tone: "ok", label: "strong" };
  if (score >= POSTURE_SCORE_FAIR) return { tone: "warn", label: "fair" };
  return { tone: "danger", label: "needs work" };
}

// postureScoreReadable is the ONE test of whether the engine's posture score may be believed. The wire
// contract is a 0..100 number (lib/api/types/posture.ts), so a value outside that is engine skew or
// corruption, and it is the value not to trust. Exported for the validator.
export function postureScoreReadable(score: unknown): score is number {
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100;
}

// POSTURE_SCORE_UNREADABLE_LABEL is what the badge says instead of a figure. It states the fault rather
// than a number, because printing "NaN / 100" or a coerced "0 / 100" is worse than printing nothing: both
// are readable as a real score, and one of them is readable as the worst possible real score.
export const POSTURE_SCORE_UNREADABLE_LABEL = "Score unreadable (the engine sent a figure this console cannot use)";

export function scoreBadge(score: number): HTMLElement {
  const s = scoreStatus(score);
  if (!postureScoreReadable(score)) return statusWithLabel(s.tone, POSTURE_SCORE_UNREADABLE_LABEL);
  return statusWithLabel(s.tone, `${Math.round(score)} / 100 (${s.label})`);
}

// controlRef renders the named standard a check maps to. The control NAME ITSELF is the
// quiet inline link (a generic standards search; the control is a free-text reference the
// engine supplies, e.g. "CIS 11.5", so the console links a search rather than guessing a
// deep URL it cannot verify). The contract's link affordance stays on every card without
// N button-styled "Look up" controls competing with the real per-card actions. The
// control text itself is a text node (escaped).
export function controlRef(control: string): HTMLElement {
  const wrap = h("span", { class: "field__hint", style: "display:inline-flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" });
  wrap.appendChild(h("span", { style: "color:var(--text-muted)" }, "Control:"));
  wrap.appendChild(
    h(
      "a",
      {
        class: "mono linklike",
        style: "display:inline-flex;gap:var(--space-1);align-items:center",
        href: `https://duckduckgo.com/?q=${encodeURIComponent(control)}`,
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": `Look up the ${control} control`,
      },
      control,
      svgIcon(ICON_EXTERNAL, { size: 12 }),
    ),
  );
  return wrap;
}

export function kvBlock(label: string, value: string): HTMLElement {
  return h(
    "div",
    { style: "display:grid;gap:var(--space-1)" },
    h("span", { class: "section-label" }, label),
    h("p", { style: "color:var(--text)" }, value),
  );
}

export type RemediationVariant = "prominent" | "muted";

// remediationBlock renders the how-to-fix. The "prominent" variant (a failing check) uses a
// lock glyph and full-strength text; the "muted" variant is a calmer note (the control is
// not failing, so the remediation is reference, not a call to action).
export function remediationBlock(remediation: string, variant: RemediationVariant): HTMLElement {
  const prominent = variant === "prominent";
  const wrap = h("div", { style: "display:grid;grid-template-columns:auto 1fr;gap:var(--space-2);align-items:start" });
  wrap.appendChild(h("span", { style: `flex:none;margin-top:2px;color:${prominent ? "var(--text)" : "var(--text-muted)"}` }, svgIcon(ICON_SHIELD_CHECK, { size: 16 })));
  const body = h("div", { style: "display:grid;gap:var(--space-1)" });
  body.appendChild(h("span", { class: "section-label" }, "Remediation"));
  // A failing check's remediation reads at full strength; otherwise it is a muted hint.
  const para = prominent
    ? h("p", { style: "color:var(--text)" }, remediation)
    : h("p", { class: "field__hint" }, remediation);
  body.appendChild(para);
  wrap.appendChild(body);
  return wrap;
}

export function groupLabel(text: string, tone: StatusTone): HTMLElement {
  return h(
    "div",
    { style: "display:flex;gap:var(--space-2);align-items:center;margin-top:var(--space-2)" },
    h("span", { class: `dot dot--${tone}`, "aria-hidden": "true" }),
    h("span", { class: "section-label" }, text),
  );
}

export function gateReason(): string {
  const c = caller();
  if (!c) return `Requires the Owner role. ${blindGateRemedy()}`;
  return `Accepting or withdrawing a risk is Owner only; your role (${titleCase(c.role)}) cannot. The engine enforces this server-side.`;
}

// readOnlyNote is the ONE visible read-only statement for a gated view: a quiet line
// beside the checks toolbar (CALM-04), replacing the bottom gate card. The disabled
// accept/withdraw buttons keep their title reasons.
export function readOnlyNote(): HTMLElement {
  return h("p", { class: "note-quiet" }, `Read only: ${gateReason()}`);
}

export function noteLine(icon: string, text: string): HTMLElement {
  return h(
    "p",
    { class: "field__hint measure", style: "display:flex;gap:var(--space-2);align-items:flex-start" },
    h("span", { style: "flex:none;margin-top:1px" }, svgIcon(icon, { size: 16 })),
    h("span", text),
  );
}

// POLICY_READ_FAILED is the one sentence the three approval-policy switches (dual control, change number,
// new-location sign-in notification) show when their shared read throws something other than a 404/501. All
// three call getConfigApprovalPolicy, so an engine fault reaches all three at once and they must not each
// invent their own wording for it.
//
// It replaced `Could not load the policy (${errText(err)})`, which interpolated the engine client's own
// "<verb>: <status>" throw. That sentence failed the helpful bar twice over: an operator reading "(get
// approval policy: 500)" has been handed an internal verb name rather than a remedy, and the switch it sat
// under was left disabled for the life of the screen with nothing to press. What the operator needs to know
// here is that the SWITCH IS NOT LYING TO THEM (a disabled control showing no value is the honest state when
// the value could not be read) and that the read is repeatable. The Retry control beside it carries the
// remedy; this carries the meaning.
export const POLICY_READ_FAILED =
  "The engine did not answer with this setting, so the switch stays disabled rather than showing a value that might be wrong. Nothing has changed.";

// errText now lives in lib/errors.ts; re-exported here so the security-centre screens keep their local import.
export { errText } from "../../lib/errors.ts";
