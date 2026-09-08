// The posture render of the Security centre: the score band (the 0..100 score with an honest tone and the
// needs-attention / customer-graded / passing counts), the severity-ranked checks each naming the
// standard control it maps to, HOW it is determined, and stating a remediation, and the Owner-only
// override flow. A check the platform cannot verify automatically reads "needs attestation" (amber),
// never a red failure the operator has no way to clear; the Owner grades it with an override: an
// attested pass (with the why recorded), a compensating control (described), not applicable (excluded
// from the score), or an accepted risk. A risk-accepted check is stated as an accepted risk, never a
// pass; an attested/compensating check is stated as a pass clearly attributed to the customer's own
// determination. Moved verbatim from the security-centre coordinator for size; it imports the shared
// leaf (./shared.ts) only, so it never imports another section module (which would form a cycle).
//
// House rules: no-custody (a check carries names, statuses, a control reference, an observed detail, a
// method line and a remediation only); disabled-with-reason, never hidden-then-403; Australian English,
// no em dashes.

import { recordContractSkew } from "../../lib/client-diag/ring.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { collapsedSection, refuseWithReason } from "../common.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { isUnauthorised, isStepUpRequired } from "../../lib/errors.ts";
import { stepUpAwareText } from "../../components/error-view.ts";
import { field, validateForm } from "../../components/field.ts";
import { badge } from "../../components/status.ts";
import { openModal, confirmModal } from "../../components/modal.ts";
import { toast } from "../../components/toast.ts";
import { surfacePendingChange } from "../../lib/pending-change-toast.ts";
import { emptyState } from "../../components/feedback.ts";
import { statTile, statGrid } from "../../components/stat-tiles.ts";
import { relativeTime } from "../../lib/format.ts";
import { can } from "../../lib/identity.ts";
import { ICON_ALERT, ICON_REFRESH } from "../../lib/icons.ts";
import type { EngineClient, PostureReport, PostureCheck, PostureOverrideKind } from "../../api.ts";
import {
  callerRole,
  compareChecks,
  scoreStatus,
  scoreBadge,
  postureScoreReadable,
  severityTone,
  statusTone,
  statusLabel,
  severityBadge,
  statusBadge,
  isNeedsAttention,
  isOverriddenStatus,
  overrideKindLabel,
  overrideKindHelp,
  controlRef,
  kvBlock,
  remediationBlock,
  groupLabel,
  gateReason,
  readOnlyNote,
  errText,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// The posture render: the score band, then the severity-ranked checks.
// ---------------------------------------------------------------------------

export function renderPosture(engine: EngineClient, report: PostureReport, reload: () => void): HTMLElement {
  const wrap = h("div", { class: "stack", style: "display:grid;gap:var(--space-5)" });
  wrap.appendChild(scoreBand(report));
  wrap.appendChild(buildChecksSection(engine, report, reload));
  return wrap;
}

// buildChecksSection renders the ranked checks block: the header and refresh, the read-only note when
// the caller lacks the override gate, then the needs-attention / customer-graded / passing groups
// (needs-attention eager, the rest collapsed). Split out of renderPosture.
function buildChecksSection(engine: EngineClient, report: PostureReport, reload: () => void): HTMLElement {
  // The ranked list: critical first, and within a severity, needs-attention checks before
  // graded/passing ones, so the most important unresolved item is at the top.
  const ranked = report.checks.slice().sort(compareChecks);

  const attention = ranked.filter((c) => isNeedsAttention(c.status));
  const graded = ranked.filter((c) => isOverriddenStatus(c.status));
  const passing = ranked.filter((c) => c.status === "pass");

  const writeGate = can(callerRole(), "posture.riskaccept");

  const checksSection = h("section", { class: "stack", style: "display:grid;gap:var(--space-4)", "aria-labelledby": "checks-h" });
  const head = h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3);flex-wrap:wrap" });
  const lead = h("div", { style: "display:grid;gap:var(--space-1)" });
  lead.appendChild(h("h2", { id: "checks-h", style: "font-size:var(--text-lg)" }, "Checks"));
  lead.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      `${report.checks.length} checks, ranked by severity. Each names the control it maps to, states what was observed, how it is decided, and the remediation. Recomputed live on every view and report (this read: ${relativeTime(report.generatedAt)}); the engine also re-evaluates on a schedule (about every six hours) so a regression alerts you even when no one is watching.`,
    ),
  );
  head.appendChild(lead);
  const refreshBtn = h("button", { "data-dp": "security-centre.button.refresh#2", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_REFRESH, { size: 14 }), "Refresh") as HTMLButtonElement;
  refreshBtn.addEventListener("click", reload);
  head.appendChild(refreshBtn);
  checksSection.appendChild(head);
  if (!writeGate) checksSection.appendChild(readOnlyNote());

  if (report.checks.length === 0) {
    // A posture REPORT that arrived, well-formed, carrying no checks at all. This is not a fresh account
    // with nothing to check (a fresh account still evaluates every check and passes or warns on it); it is an
    // engine that computed a report and put nothing in it, and the screen's own copy says so. The screen tells
    // the operator honestly and the pack said nothing, so "the security centre says no checks reported" arrived
    // with no evidence that the console had ever been handed an empty report.
    recordContractSkew("empty-payload", "posture-checks");
    checksSection.appendChild(
      emptyState({
        title: "No checks reported",
        body: "The engine returned no posture checks. Refresh, or check the engine build supports the posture surface.",
      }),
    );
    return checksSection;
  }

  // Needs-attention checks are the only eager group (the gaps an operator came to fix): red failures
  // AND amber needs-attestation items. The customer-graded and passing groups collapse to one summary
  // line each with their counts (calm contract 7a: a long all-green scroll buries the group that
  // matters); their bodies still render, so find-in-page and one click reach every check.
  if (attention.length > 0) {
    checksSection.appendChild(groupLabel(`Needs attention (${attention.length})`, "danger"));
    for (const c of attention) checksSection.appendChild(checkCard(engine, c, writeGate, reload));
  }

  if (graded.length > 0) {
    const body = h("div", { class: "stack", style: "display:grid;gap:var(--space-3)" });
    for (const c of graded) body.appendChild(checkCard(engine, c, writeGate, reload));
    checksSection.appendChild(collapsedSection(`Marked by you: attested, compensating, N/A or accepted (${graded.length})`, body));
  }

  if (passing.length > 0) {
    const body = h("div", { class: "stack", style: "display:grid;gap:var(--space-3)" });
    for (const c of passing) body.appendChild(checkCard(engine, c, writeGate, reload));
    checksSection.appendChild(collapsedSection(`Passing (${passing.length})`, body));
  }

  return checksSection;
}

// scoreBand is the top-of-screen posture summary: the 0..100 score with an honest tone,
// plus a count breakdown (needs attention vs marked-by-you vs passing). The score counts a
// customer-graded check as pass (attested, compensating, accepted) and excludes an N/A entirely, but
// the band lists graded items distinctly so a reviewer sees a customer determination for what it is.
// Exported for the truthfulness census: the score tile is a SECOND consumer of report.score and the
// census has to be able to see it, or a repair that landed on scoreBadge alone would leave no cell red.
export function scoreBand(report: PostureReport): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": "posture-score-h", style: "display:grid;gap:var(--space-4)" });
  const header = h("div", { class: "card__header" });
  header.appendChild(h("h2", { class: "card__title", id: "posture-score-h" }, "Posture score"));
  header.appendChild(scoreBadge(report.score));
  card.appendChild(header);

  const failing = report.checks.filter((c) => c.status === "fail").length;
  const unattested = report.checks.filter((c) => c.status === "unattested").length;
  const graded = report.checks.filter((c) => isOverriddenStatus(c.status)).length;
  const notApplicable = report.checks.filter((c) => c.status === "not-applicable").length;
  const passing = report.checks.filter((c) => c.status === "pass").length;
  const criticalFails = report.checks.filter((c) => c.status === "fail" && c.severity === "critical").length;
  const attention = failing + unattested;

  card.appendChild(
    statGrid(
      statTile({
        // THE SECOND CONSUMER OF THE SAME NUMBER, and the reason the readability test is applied HERE too
        // rather than only inside scoreBadge. This tile re-derives the figure itself, so a repair that
        // landed on the badge alone would have fixed the header and left the tile beneath it printing
        // "NaN / 100", or "0 / 100" for a score that arrived null, in a card whose own header had just said
        // the score could not be read. That is the lone-hold-out shape: two consumers of one value, one
        // repaired and one not, with the unrepaired one on the surface the operator actually reads.
        label: "Score",
        value: postureScoreReadable(report.score) ? `${Math.round(report.score)} / 100` : "Unreadable",
        status: scoreStatus(report.score),
        secondary: postureScoreReadable(report.score)
          ? "Weighted pass fraction over the applicable checks (critical weighted highest; an N/A is excluded entirely)."
          : "Your engine reported a posture score this console cannot read, so no score is shown. The per-check results below are read separately and are unaffected; the raw figure travels in a support pack.",
      }),
      statTile({
        label: "Needs attention",
        value: String(attention),
        status: attention > 0 ? { tone: criticalFails > 0 ? "danger" : "warn", label: criticalFails > 0 ? `${criticalFails} critical` : "review" } : { tone: "ok", label: "clear" },
        secondary:
          attention > 0
            ? unattested > 0
              ? `${failing} failing, ${unattested} awaiting your attestation; ranked below.`
              : "Failing checks, ranked below with their remediation."
            : "No failing or unattested checks.",
      }),
      statTile({
        label: "Marked by you",
        value: String(graded),
        status: graded > 0 ? { tone: "info", label: "recorded" } : { tone: "ok", label: "none" },
        secondary:
          graded > 0
            ? `Attested passes, compensating controls${notApplicable > 0 ? `, ${notApplicable} N/A` : ""} and accepted risks; each stays listed with your reason, never hidden.`
            : "No overrides or attestations recorded.",
      }),
      statTile({
        label: "Passing",
        value: String(passing),
        status: { tone: "ok", label: "ok" },
        secondary: "Checks the platform verified on its own.",
      }),
    ),
  );
  return card;
}

// checkCard renders one check: its severity, status, title, the named control it maps to, the observed
// detail, HOW it is decided, any recorded override (kind + reason + who/when), and the remediation. A
// needs-attention check shows the remediation prominently and (for an Owner) the override action; a
// graded check shows the customer's determination with Owner-only change/withdraw. Every string is a
// text node.
function checkCard(engine: EngineClient, check: PostureCheck, writeGate: boolean, reload: () => void): HTMLElement {
  const tone = severityTone(check.severity);
  const card = h("section", {
    class: check.status === "fail" ? "card card--warn" : "card",
    "aria-label": `${check.title} (${check.severity}, ${statusLabel(check.status)})`,
    style: "display:grid;gap:var(--space-3)",
  });

  // Header row: a status dot + the title, with the severity and status badges on the right.
  const header = h("div", { style: "display:flex;justify-content:space-between;gap:var(--space-3);align-items:flex-start;flex-wrap:wrap" });
  const titleWrap = h("div", { style: "display:flex;gap:var(--space-2);align-items:flex-start" });
  titleWrap.appendChild(h("span", { class: `dot dot--${statusTone(check.status, tone)}`, "aria-hidden": "true", style: "margin-top:6px;flex:none" }));
  const titleText = h("div", { style: "display:grid;gap:var(--space-1)" });
  titleText.appendChild(h("h3", { style: "font-size:var(--text-md)" }, check.title));
  titleText.appendChild(controlRef(check.control));
  titleWrap.appendChild(titleText);
  header.appendChild(titleWrap);

  const badges = h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" });
  // A passing check's severity is its WEIGHT if it ever failed, not a live alarm: a red "critical"
  // chip inside the Passing group reads as a problem. Render it as a neutral outline "weight" badge
  // and keep the tonal severity chip only where the severity is live (needs-attention or graded).
  badges.appendChild(check.status === "pass" || check.status === "not-applicable" ? badge("default", `weight: ${check.severity}`) : severityBadge(check.severity));
  badges.appendChild(statusBadge(check.status));
  header.appendChild(badges);
  card.appendChild(header);

  // Observed detail, then how the determination is made (so anyone can understand the check without
  // reading source; the method is engine-supplied, one plain-language sentence).
  card.appendChild(kvBlock("Observed", check.detail));
  card.appendChild(kvBlock("How this is decided", check.how));

  // The recorded override, when one exists: the customer's own determination, attributed and dated. A
  // DORMANT override (the automatic check passes on its own again) is stated as such so the owner can
  // tidy it up with a withdraw.
  if (check.override !== undefined) {
    card.appendChild(overrideBlock(check));
  }

  // Remediation: shown prominently for a needs-attention check; available but calmer otherwise.
  if (isNeedsAttention(check.status)) {
    card.appendChild(remediationBlock(check.remediation, "prominent"));
  } else {
    card.appendChild(remediationBlock(check.remediation, "muted"));
  }

  // The in-console fix for the two checks whose remedy is the same act: attended verification (the
  // offline-key-only in-platform proof path). This replaces the old offline-CLI rehearsal dead-end for a
  // break-glass-only posture, where the engine cannot run a scheduled test itself.
  //
  // attended-verification-cadence joins restore-test-recency here because it is the SAME remedy: the engine
  // raises it only on a break-glass-only estate that stated a proof interval and has a downpipe past it or
  // never verified, and the only way to clear either is to run an attended verification. A finding whose
  // fix is one click away must not be a dead end just because it is a newer check.
  //
  // Only the documented check ids are matched, so an engine that renames a check simply shows no CTA (a
  // safe degradation).
  if (isNeedsAttention(check.status) && (check.id === "restore-test-recency" || check.id === "attended-verification-cadence")) {
    card.appendChild(
      h(
        "div",
        { style: "display:flex;gap:var(--space-2);flex-wrap:wrap" },
        h("button", { "data-dp": "security-centre.button.navigate-restore-attend", class: "btn btn--secondary btn--sm", type: "button", on: { click: () => navigate("/restore/attend") } }, "Prove it with attended verification"),
      ),
    );
  }

  // The Owner-only override / withdraw controls.
  card.appendChild(overrideActionRow(engine, check, writeGate, reload));

  return card;
}

// overrideBlock renders the recorded determination: the kind label, the owner's reason, who recorded it
// and when, plus the dormant note when the automatic outcome has recovered on its own.
function overrideBlock(check: PostureCheck): HTMLElement {
  const o = check.override;
  const wrap = h("div", { class: "card card--inset", style: "display:grid;gap:var(--space-1)" });
  if (o === undefined) return wrap;
  const kindText =
    o.kind === "attested-pass" ? "Pass, attested by you"
    : o.kind === "compensating-control" ? "Pass via a compensating control"
    : o.kind === "not-applicable" ? "Not applicable (your determination)"
    : "Risk accepted";
  wrap.appendChild(h("span", { class: "section-label" }, `Your determination: ${kindText}`));
  wrap.appendChild(h("p", { style: "color:var(--text)" }, o.reason));
  wrap.appendChild(h("p", { class: "field__hint" }, `Recorded by ${o.setBy ?? "the break-glass token"} ${relativeTime(o.setAt)}. This flows into the posture report and evidence packs, labelled as your determination.`));
  if (check.autoStatus === "pass" && o.kind !== "not-applicable") {
    wrap.appendChild(h("p", { class: "field__hint" }, "The automatic check now passes on its own, so this override is dormant; you can withdraw it."));
  }
  return wrap;
}

// overrideActionRow renders the Owner-gated override (for a needs-attention check) or change/withdraw
// (for a graded check, or a passing check carrying a dormant override). For a non-Owner the action is
// shown disabled-with-reason.
function overrideActionRow(engine: EngineClient, check: PostureCheck, writeGate: boolean, reload: () => void): HTMLElement {
  const row = h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin-top:var(--space-1)" });

  const mkBtn = (label: string, cls: string, onClick?: () => void): HTMLButtonElement => {
    const btn = (writeGate
      ? h("button", { "data-dp": "security-centre.button.mk-btn#1", class: cls, type: "button" }, label)
      : h("button", { "data-dp": "security-centre.button.mk-btn#2", class: cls, type: "button" }, label)) as HTMLButtonElement;
    if (writeGate && onClick) btn.addEventListener("click", onClick);
    if (!writeGate) refuseWithReason(btn, gateReason());
    return btn;
  };

  if (isNeedsAttention(check.status)) {
    // An unattested check leads with the attest flow (that is the expected resolution); a failing check
    // leads with the full override choice (fix it, or grade it). One modal serves both; only the
    // preselected kind differs.
    const label = check.status === "unattested" ? "Attest or override" : "Override";
    const defaultKind: PostureOverrideKind = check.status === "unattested" ? "attested-pass" : "risk-accepted";
    row.appendChild(mkBtn(label, "btn btn--secondary btn--sm", () => void openOverrideForm(engine, check, reload, defaultKind)));
    return row;
  }

  if (check.override !== undefined) {
    // Graded (or passing with a dormant override): change or withdraw.
    row.appendChild(mkBtn("Change override", "btn btn--secondary btn--sm", () => void openOverrideForm(engine, check, reload, check.override?.kind ?? "risk-accepted")));
    row.appendChild(mkBtn("Withdraw override", "btn btn--ghost btn--sm", () => void withdrawOverride(engine, check, reload)));
    return row;
  }

  // A plainly passing check needs no action; keep the row empty (no affordance that implies one).
  return row;
}

// withdrawOverride confirms and removes the recorded determination so the check is graded on its
// observed state again.
async function withdrawOverride(engine: EngineClient, check: PostureCheck, reload: () => void): Promise<void> {
  const ok = await confirmModal({
    title: "Withdraw this override",
    body: `Withdraw your determination for "${check.title}"? It will be graded on its observed state again and may show as failing or needing attestation. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is withdrawn and your determination stands.`,
    confirmLabel: "Withdraw override",
    variant: "primary",
    busyLabel: "Withdrawing",
  });
  if (!ok) return;
  try {
    const res = await engine.unacceptPostureRisk(check.id);
    if (res.status === "pending") surfacePendingChange("override withdrawal");
    else toast({ message: `Override withdrawn for "${check.title}"` });
    reload();
  } catch (err) {
    if (isUnauthorised(err)) return goSignedOut();
    // stepUpAwareText, not errText: /posture/unaccept is step-up gated, and a cancelled ceremony threw
    // "unaccept posture risk: stepup-required: 401" straight into this toast.
    toast({ message: `Could not withdraw the override. ${stepUpAwareText(err)}`, tone: "warn" });
  }
}

// OVERRIDE_KINDS is the modal's radio order: the two customer-graded passes first (the states a
// customer most often needs when the platform cannot verify), then N/A, then the accepted risk.
const OVERRIDE_KINDS: readonly PostureOverrideKind[] = ["attested-pass", "compensating-control", "not-applicable", "risk-accepted"];

// openOverrideForm is the Owner-only override modal: choose the determination kind (attested pass /
// compensating control / not applicable / accept the risk), each explained with its score and report
// consequence, and give the mandatory reason. The engine re-checks the posture.riskaccept capability
// and the kind/reason bounds; a refusal is shown inline. The reason is never a secret; the console
// escapes it on render. When the config-approval policy (dual control) is on, the override queues for
// a second approver, so the form says so up front and the primary reads "Submit for approval".
async function openOverrideForm(engine: EngineClient, check: PostureCheck, reload: () => void, defaultKind: PostureOverrideKind): Promise<void> {
  const dualControlOn = await engine
    .getConfigApprovalPolicy()
    .then((p) => p.requireConfigApproval)
    .catch(() => false);

  // The kind radio group: each option carries its label + a one-line consequence.
  let selectedKind: PostureOverrideKind = defaultKind;
  const kindGroup = h("div", { role: "radiogroup", "aria-label": "Determination", style: "display:grid;gap:var(--space-2)" });
  const helpByKind = new Map<PostureOverrideKind, HTMLElement>();
  for (const kind of OVERRIDE_KINDS) {
    const id = `posture-override-kind-${kind}`;
    const radio = h("input", { type: "radio", name: "posture-override-kind", id, value: kind }) as HTMLInputElement;
    radio.checked = kind === defaultKind;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      selectedKind = kind;
      for (const [k, el] of helpByKind) el.hidden = k !== kind;
    });
    const help = h("p", { class: "field__hint", style: "margin-left:26px" }, overrideKindHelp(kind));
    help.hidden = kind !== defaultKind;
    helpByKind.set(kind, help);
    kindGroup.appendChild(
      h(
        "div",
        { style: "display:grid;gap:var(--space-1)" },
        h(
          "label",
          { for: id, style: "display:flex;gap:var(--space-2);align-items:center;cursor:pointer" },
          radio,
          h("span", overrideKindLabel(kind)),
        ),
        help,
      ),
    );
  }

  const reasonField = field({
    id: "posture-override-reason",
    label: "Why (recorded and shown in reports)",
    kind: "textarea",
    required: true,
    hint: "A short, auditable statement (for example the policy or control that satisfies this, or the risk decision). Recorded with your identity and carried into the posture report and evidence packs; never include a secret or a value.",
    placeholder: check.status === "unattested" ? "e.g. MFA is enforced for all admin staff by our IdP conditional-access policy." : "e.g. compensating control X is in place; full remediation scheduled for the next maintenance window.",
    doc: { href: "https://docs.downpipes.io/assurance-audit/risk-accept-and-regression", anchor: "the-four-override-kinds-and-what-each-does" },
    validate: (v) => (v.trim().length >= 4 ? null : "Give a brief reason (at least a few characters)."),
  });

  const summary = h("div", { class: "card card--inset", style: "display:grid;gap:var(--space-2)" });
  summary.appendChild(h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" }, severityBadge(check.severity), h("b", check.title)));
  summary.appendChild(controlRef(check.control));
  summary.appendChild(h("p", { class: "field__hint" }, check.detail));

  const formError = h("p", { class: "field__error", role: "alert", hidden: true });
  const body = h(
    "form",
    { class: "form-stack", style: "display:grid;gap:var(--space-4)", "aria-label": `Override ${check.title}`, on: { submit: (ev: Event) => ev.preventDefault() } },
    summary,
    kindGroup,
    reasonField.el,
    h(
      "p",
      { class: "field__hint", style: "display:flex;gap:var(--space-2);align-items:flex-start" },
      h("span", { style: "flex:none;margin-top:1px" }, svgIcon(ICON_ALERT, { size: 14 })),
      h("span", "Your determination is recorded with your identity, stays listed on this screen, and appears in the signed posture report and evidence packs labelled as your own grading, never as a platform verification. Withdraw it at any time."),
    ),
    dualControlOn ? h("p", { class: "field__hint" }, "Dual control is on: this override is queued for a second approver.") : null,
    // THE CEREMONY, named before the button rather than discovered after it. Recording a determination
    // changes how a failing control is graded in a signed report, so the engine demands a fresh identity
    // check; the prompt opens on the primary action, after the reason has been written.
    h("p", { class: "field__hint measure" }, "You may be asked to confirm with your own passkey when you record this. If you dismiss that prompt, or it fails, nothing is recorded and your reason stays in this form."),
    formError,
  );

  openModal({
    title: check.status === "unattested" ? "Attest or override this check" : "Override this check",
    body,
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => {} },
      {
        label: dualControlOn ? "Submit for approval" : "Record determination",
        variant: "primary",
        busyLabel: dualControlOn ? "Queueing" : "Recording",
        onClick: () => handleOverrideSubmit(engine, check, () => selectedKind, reasonField, formError, reload),
      },
    ],
  });
}

// handleOverrideSubmit is the override modal's primary-action handler, hoisted out of openOverrideForm
// so the form body construction and the openModal call stay readable. It
// validates, calls the engine with the chosen kind + reason, and routes a refusal to the inline form
// error. Returns whether the modal should close.
async function handleOverrideSubmit(
  engine: EngineClient,
  check: PostureCheck,
  kindOf: () => PostureOverrideKind,
  reasonField: ReturnType<typeof field>,
  formError: HTMLElement,
  reload: () => void,
): Promise<boolean> {
  formError.hidden = true;
  if (!validateForm([reasonField])) return false;
  try {
    const res = await engine.acceptPostureRisk(check.id, reasonField.value(), kindOf());
    if (res.status === "pending") surfacePendingChange("override");
    else toast({ message: `Determination recorded for "${check.title}"` });
    reload();
    return true;
  } catch (err) {
    if (isUnauthorised(err)) {
      goSignedOut();
      return true;
    }
    // The engine refused (not Owner, unknown check, bad kind): show its reason inline. /posture/accept is
    // step-up gated too, so the same split applies: a cancelled ceremony is not a refusal by the engine.
    formError.textContent = isStepUpRequired(err)
      ? `The override was not recorded. ${stepUpAwareText(err)}`
      : `The engine refused the override (${errText(err)}).`;
    formError.hidden = false;
    return false;
  }
}
