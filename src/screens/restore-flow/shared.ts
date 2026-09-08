// Restore, runs and actions shared leaves: the blast-radius constants,
// the FlowPrefill seed type the pick -> review -> apply path threads, and the small DOM
// leaves reused across the per-section render modules (the stepper, the skeletons, the
// figure/fact rows, the badges, the prefix splitter, the dated last-proven line). Split out
// of restore-flow.ts for size while keeping every definition byte-identical (a move, never
// a rewrite). No-custody is never weakened and no confirmation / dual-control wording is
// touched. House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon, type Child } from "../../lib/dom.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { copyButton } from "../../components/code-block.ts";
import { badge, statusWithLabel, statusDot, type StatusTone } from "../../components/status.ts";
import { groupNumber, dateOnly, titleCase } from "../../lib/format.ts";
import { restoreProvenMethodPhrase } from "../../lib/protection-statement.ts";
import { ICON_CHECK } from "../../lib/icons.ts";
import {
  applyClassForCounts,
  bulkReasonForCounts,
  recordApplyOutcome,
  recordBulkOutcome,
  recordContractDrift,
  recordRestoreGateBlocked,
} from "../../lib/client-diag/ring.ts";
import type { ClientDiagGateBlockClass } from "../../lib/client-diag/vocab.ts";
import type {
  EngineClient, RestorePlan, RestoreRequest, RestoreApproval, DownpipeState, RunHistoryEntry, RestoreResult,
} from "../../api.ts";

// The large-restore threshold above which type-to-confirm is required even for a
// same-binding restore, calibrated to blast radius.
// A redirect or a non-latest run always escalates regardless of size.
export const LARGE_RESTORE_WRITES = 1000;

// How often the unarmed dual-control gate re-checks for a distinct approver's signature, so
// Apply lights up shortly after they sign without the operator pressing refresh.
export const APPROVAL_POLL_MS = 5000;

// The upper bound on how many rows any one disclosure list renders (skipped records, the
// resolved-destinations sample). It caps the DOM a single plan can build so a very large run
// cannot freeze the review screen; the figures above each list always carry the true total.
export const MAX_DISPLAY_ROWS = 200;

// The break-glass-only drill reason the engine returns verbatim: the
// highest-assurance posture has no in-account read-back key, so a drill cannot
// self-test and the console guides an offline rehearsal instead of faking a result.
export const BREAK_GLASS_PREFIX = "break-glass-only posture";

// writeDrillEvidence records the dated recoverability entry after a PASSING drill. The write is a SECOND,
// SEPARATELY FAILABLE call, so its outcome is CARRIED, never assumed. It used to be swallowed into an empty
// catch, which left the auditor's recoverability report showing NO drill evidence for a customer who drilled
// every month, and left nobody able to say why: "never drilled" and "drilled, evidence write refused" looked
// identical from the outside. onMissed runs when the entry did not land, so the caller states it beside the
// verdict rather than implying a record that does not exist. The drill VERDICT is never disturbed (an
// evidence-route miss is not a restorability problem), and the failed call itself already rides the support
// pack as a value-free engine-call class (lib/api/engine-fetch.ts), so support sees the write refuse too.
export async function writeDrillEvidence(engine: EngineClient, runId: string, onMissed: () => void): Promise<void> {
  try {
    await engine.recordDrillEvidence(runId, "in-account");
  } catch {
    // The reason is not read: it is the operator-facing fact (no dated entry) that matters here, and the
    // engine-call class already rides the pack.
    onMissed();
  }
}

// drillEvidenceMissedNote is the honest line shown beside a PASSED drill whose evidence entry did not land.
// It is a hint, not an alarm: the drill passed, and the only loss is the dated artefact the recoverability
// report reads.
export function drillEvidenceMissedNote(): HTMLElement {
  return h(
    "p",
    { class: "field__hint", role: "status", style: "margin-top:var(--space-2)" },
    "The drill passed, but its dated evidence entry could not be written to the engine, so this drill will not appear in the recoverability report. Retry the drill once the engine is healthy if you need the record.",
  );
}

// FlowPrefill seeds the pick step when the flow is (re-)entered programmatically, e.g. the
// the "retry the failed subset" re-enters scoped to the failed record names. Every field is
// optional; runId defaults to the deep-linked run. include/exclude carry selectors (the
// failed record NAMES become include selectors for the subset); these are names and
// counts only, never a value or a key (no-custody). When a prefill is present the flow
// auto-runs the dry-run so the operator lands on the re-scoped review.
export interface FlowPrefill {
  runId?: string;
  include?: string[];
  exclude?: string[];
  maxRecords?: number;
  targetBinding?: string;
  // recordName seeds a GRANULAR single-record restore (the "Restore just this" affordance on a plan
  // row, or a name typed into the single-record field). When present the flow scopes the whole dry-run
  // -> dual-control -> apply path to EXACTLY that one record (it sets req.recordName), and the
  // include/exclude prefixes are ignored by the engine. A redaction-safe source name only (no value).
  recordName?: string;
  // mediaRestore seeds the media edit-token + account fields on a per-item media reenter (the
  // mediaPlanned row's "Restore just this" affordance, plan.ts): narrowing to ONE media record would
  // otherwise silently drop the token/account context the operator already typed, landing the reentered
  // flow back on the out-of-band guidance for that item. This is an IN-MEMORY handoff only (reenter
  // rebuilds the flow in place on the same page load; it is never written to the scope draft/
  // localStorage, matching how the Cloudflare-config token is never persisted either), so carrying the
  // token here does not weaken no-custody.
  mediaRestore?: { token: string; accountId: string };
  // A one-line note shown above the form explaining why the flow was re-entered (escaped).
  note?: string;
}

// RestoreJourneyInfo is the live progress read flow.ts hands to the context rail's journey summary
// (journey.ts) at the same seams it repaints its own stepper: the current step number and the plan
// hash once one has been computed (null before a plan exists, or after a rearm). No plaintext, no
// key; a step number and a redaction-safe hash only.
export interface RestoreJourneyInfo {
  step: number;
  planHash: string | null;
}

// lastProvenLine renders the dated "restorability last proven" recency for a downpipe, in the
// SAME honest idiom as the protection statement (provenClause): "never proven yet" until the first
// pass, the date and prover once proven, and a neutral note when the recency could not be read. It is
// recency + who only (no value, no key); the prover email is the customer's own data, escaped by the
// h() text-node path. A null/undefined state (not yet fetched, or not found) reads as unavailable
// rather than a false "proven". The engine wire now KEEPS the proving method, so an ATTENDED
// verification is named faithfully ("via attended verification (72% sample)") rather than a generic
// claim; a blind test / keyless attestation adds no method phrase (restoreProvenMethodPhrase returns "").
export function lastProvenLine(state: DownpipeState | undefined): string {
  if (!state) return "Restorability recency unavailable here; run a proof below to record it now.";
  const at = state.lastRestoreProvenAt;
  if (at === undefined || at === "") {
    return "Restorability has never been proven for this downpipe yet. Verify it below to record the first proof.";
  }
  const by = state.lastRestoreProvenBy;
  const byPhrase = by && by.trim() !== "" ? ` by ${by}` : "";
  const methodPhrase = restoreProvenMethodPhrase(state);
  const via = methodPhrase ? ` via ${methodPhrase}` : "";
  // A PROOF THIS CONSOLE CANNOT DATE IS NOT A DATED PROOF. dateOnly returns the EMPTY STRING for any
  // instant it cannot parse, and the sentence around it kept its verb, so a corrupt stamp rendered
  // "Restorability last proven ." and, with a prover, "Restorability last proven  by a@b.c." The claim
  // that a recovery has actually been rehearsed is the strongest thing this screen says, and it was being
  // asserted over a blank. This is the one sentence on the restore path where a stale or unreadable stamp
  // decides whether an operator goes looking for a drill.
  //
  // THE SIBLINGS ALREADY HAD THE GUARD AND THIS SITE DID NOT. Six dateOnly call sites in the licence and
  // billing surfaces (licence/detail-rows.ts:44 and :68, licence/view.ts:287, licence/shared.ts:510,
  // lib/billing.ts:181 and :182) all write `dateOnly(x) || x`, falling back to the raw stamp so the
  // operator sees SOMETHING rather than a gap; protection-statement.ts:129 handles the empty return
  // explicitly. This site, the restore date-picker's heading and the Overview licence tile were the
  // hold-outs. Falling back to the raw stamp is not right here: an unparseable instant is not a date to
  // show a customer, and the recency is the whole claim, so the honest answer names the fault instead.
  const when = dateOnly(at);
  if (when === "") {
    return "Restorability was recorded as proven for this downpipe, but the stamp saying when is in a shape this console cannot read, so no date is shown. Verify it below to record a fresh proof; the raw stamp travels in a support pack.";
  }
  return `Restorability last proven ${when}${byPhrase}${via}.`;
}

// ---- small helpers ----------------------------------------------------------

// cardSkeleton: a card-shaped loading placeholder for regions whose loaded content is
// cards (the run context and the approvals inbox), so the skeleton matches the final
// layout's shape and the page does not jump when content arrives.
export function cardSkeleton(rows: number): HTMLElement {
  return h("div", { class: "card", "aria-busy": "true", "aria-hidden": "true" }, skeletonRows(rows));
}

// RESTORE_STEPS is the restore flow's step sequence (Pick run -> Receipt), exported so the stepper
// below and the live journey summary (journey.ts) share the exact same labels and can never disagree
// on what step N means. "Approval" is a real step (often the longest wait in the whole flow): it
// becomes current when a dual-control request is raised, and "Confirm" when the gate arms.
// RESTORE_STEP_COUNT is its length; paintStepper(RESTORE_STEP_COUNT + 1) (confirm.ts, the ONE call on
// a successful apply) is the terminal signal restoreStepper reads as "every step done", including the
// final Receipt tick.
export const RESTORE_STEPS = ["Pick run", "Review plan", "Approval", "Confirm", "Apply", "Receipt"] as const;
export const RESTORE_STEP_COUNT = RESTORE_STEPS.length;

// restoreStepper draws the flow's progress ladder. The optional prev is the step this SAME paint
// is advancing FROM (flow.ts's paintStepper passes the value currentStep held before it was
// overwritten); it exists solely to drive E1, the connector fill: the ONE separator that just
// crossed into "done" this paint fills left-to-right in --ok (restore-step__sep--fill, tokens.css)
// over 220ms, a one-shot acknowledgement of the step just completed. The guard below is what makes
// this fire only on a genuine forward step: prev must be given AND current must be strictly
// greater than it, so a same-step re-render (paintStepper called twice for the same step) and a
// decrease (the Change / re-arm reset back to step 1) never animate a fill. fillAfterStep is
// clamped to RESTORE_STEP_COUNT - 1 (the last real connector) so the terminal
// paintStepper(RESTORE_STEP_COUNT + 1) call on a successful apply still fills the Apply -> Receipt
// connector rather than targeting a step number with no trailing separator at all. Reduced motion
// is handled entirely in CSS (the animation-duration collapse in tokens.css section 9): this
// function does not need to know about it.
export function restoreStepper(current: number, prev?: number): HTMLElement {
  // A terminal current beyond the last step marks EVERY step done. The plain n < current
  // comparison below already yields this for any current beyond RESTORE_STEP_COUNT, but allDone
  // makes the "beyond the end means fully done" rule explicit, so it survives a future change to
  // RESTORE_STEPS' length rather than relying on that arithmetic coincidence silently.
  const allDone = current > RESTORE_STEP_COUNT;
  const fillAfterStep = prev !== undefined && current > prev ? Math.min(current - 1, RESTORE_STEP_COUNT - 1) : null;
  const ol = h("ol", { class: "restore-steps", "aria-label": "Restore progress" });
  RESTORE_STEPS.forEach((label, i) => {
    const n = i + 1;
    const status = allDone || n < current ? "done" : n === current ? "current" : "upcoming";
    const li = h("li", { class: `restore-step restore-step--${status}` });
    if (status === "current") li.setAttribute("aria-current", "step");
    const marker = h("span", { class: "restore-step__num", "aria-hidden": "true" });
    if (status === "done") marker.appendChild(svgIcon(ICON_CHECK, { size: 12 }));
    else marker.appendChild(document.createTextNode(String(n)));
    // Each step and its trailing separator share one .restore-step-group inside the step's
    // li (one flex item), so a wrapped stepper can never strand a dangling dash on its own
    // line; the separator was previously its own li, its own wrap unit.
    const group = h("span", { class: "restore-step-group" });
    group.appendChild(marker);
    group.appendChild(h("span", { class: "restore-step__label" }, label));
    const statusWord = status === "done" ? "done" : status === "current" ? "current step" : "upcoming";
    group.appendChild(h("span", { class: "visually-hidden" }, `, ${statusWord}`));
    if (i < RESTORE_STEPS.length - 1) {
      const sepClass = n === fillAfterStep ? "restore-step__sep restore-step__sep--fill" : "restore-step__sep";
      group.appendChild(h("span", { class: sepClass, "aria-hidden": "true" }));
    }
    li.appendChild(group);
    ol.appendChild(li);
  });
  return ol;
}

export function loadingPlan(): HTMLElement {
  const card = h("div", { class: "card restore-plan", "aria-busy": "true" });
  card.appendChild(h("h2", { class: "card__title" }, "Review the restore plan"));
  card.appendChild(h("p", { class: "restore-plan__loadnote field__hint" }, "Verifying the run. Nothing is being written."));
  card.appendChild(skeletonRows(4));
  return card;
}

// configSurfacesToApply counts the Cloudflare-config surfaces an apply would actually WRITE, which is the
// willApply subset of the diff and not its length. A config dry-run examines every surface in the snapshot
// and most of them come back "no changes (already matches the snapshot)": one live re-proof read 59 surfaces
// examined and 5 with something to write. Reporting the length would claim 59 writes that will not happen,
// which is the same class of wrong answer as reporting the zero.
export function configSurfacesToApply(plan: RestorePlan): number {
  return (plan.configChanges ?? []).filter((c) => c.willApply).length;
}

// configLegPhrase is the trailing clause naming the config leg, or "" when the plan has no surfaces to
// write. Kept in one place so the review banner, the type-to-confirm dialog and the approval request state
// the same fact in the same words.
function configLegPhrase(plan: RestorePlan): string {
  const n = configSurfacesToApply(plan);
  if (n === 0) return "";
  return `${groupNumber(n)} Cloudflare config surface${n === 1 ? "" : "s"}`;
}

// writeSummarySentence is the bare write summary (count + where), WITHOUT the older-run
// note: the review banner appends that fact as its own single escalate line, so the body
// sentence must not state it too. impactSentence keeps the combined form for the surfaces
// that show exactly one sentence (the type-to-confirm dialog, the approval request).
//
// plannedWrites counts DATA RECORDS only, and a config restore writes outside that count. A
// Cloudflare-config downpipe carries configuration and no data records, so its plan comes back with
// plannedWrites 0 and this sentence used to read "Write 0 verified records back to their original source
// bindings in this account" over an apply that would change real config. The count is not inflated to
// cover it: plannedWrites is read by the large-write friction threshold, shown to the approver in the
// approvals inbox and reconciled against on the receipt, so folding surfaces in would make one number mean
// two things. The config leg is stated beside it instead, and leads when there are no records at all,
// because a sentence that opens on a zero is read as a plan that does nothing.
export function writeSummarySentence(plan: RestorePlan, req: RestoreRequest): string {
  const where = req.target?.binding ? `binding ${req.target.binding}` : "their original source bindings";
  const config = configLegPhrase(plan);
  if (config !== "" && plan.plannedWrites === 0) {
    return `Apply ${config} to this account. No data records are written by this plan.`;
  }
  const records = `Write ${groupNumber(plan.plannedWrites)} verified records back to ${where} in this account`;
  return config === "" ? `${records}.` : `${records}, and apply ${config}.`;
}

// reviewImpactLine is the review banner's calm-branch wording of the same fact, in the screen's own voice
// ("On apply, this ...") rather than the imperative the confirm dialog uses. It carries the config leg for
// the same reason writeSummarySentence does, and by the same rule: the config leg leads when there are no
// records, so the operator never reads a bare zero as the whole plan.
// The trailing "Nothing has been written yet." is NOT part of this string any more. It is appended by the
// caller as its own marked element (plan.ts unwrittenNote), because it is the one clause on this card that
// can stop being true while the card is still on screen, and a sentence welded into a longer string cannot
// be revised without rewriting a claim that is still correct. See UNWRITTEN_MARK.
export function reviewImpactLine(plan: RestorePlan): string {
  const config = configLegPhrase(plan);
  if (config !== "" && plan.plannedWrites === 0) {
    return `On apply, this applies ${config} to your live Cloudflare account and writes no data records.`;
  }
  const records = `On apply, this writes ${groupNumber(plan.plannedWrites)} verified records back to their original bindings`;
  return config === "" ? `${records}.` : `${records} and applies ${config}.`;
}

// UNWRITTEN_MARK is the class every copy of the dry-run reassurance carries, and UNWRITTEN_TEXT is the
// sentence itself.
//
// WHY THIS IS A MARKED ELEMENT RATHER THAN THREE STRING LITERALS. "Nothing has been written yet." is the
// one sentence a frightened operator needs earliest, so it is deliberately repeated in every tone of the
// impact banner and again on the integrity statement. It is painted at DRY-RUN time. It was never revised.
// An apply whose response never came back leaves the whole plan card on screen underneath the failure, so
// the card went on asserting that nothing had been written while the records were already back in the
// account and the single-use approval was already spent. An apply can be received, its records written
// and the approval consumed, all recorded server-side with monotonic instants, before the socket is
// destroyed. The CONTROL is why this is a finding about the unknown outcome
// and not about the sentence existing: on a SUCCESSFUL apply the receipt hides the whole plan card and the
// same sentence is correctly gone.
export const UNWRITTEN_MARK = "restore-plan__unwritten";
export const UNWRITTEN_TEXT = "Nothing has been written yet.";

export function impactSentence(plan: RestorePlan, req: RestoreRequest): string {
  const latest = plan.isLatest === false ? " This is an older run, restored over current data." : "";
  return `${writeSummarySentence(plan, req)}${latest}`;
}

// figure renders one plan-figure tile: a label, a big tabular-numeral value and a one-line sub
// caption. The optional status ("ok" | "warn", default "none") adds the SAME small hue + shape
// status dot the stat tiles and the check cards use, beside the value, for a figure that itself
// carries a good/caution reading (a verified count, a non-latest run) - so the tile speaks the
// console's own tile language instead of the sub caption having to restate the fact in words.
// Existing 3-argument callers are unaffected: status defaults to no marker.
export function figure(label: string, value: string, sub: string, status: "ok" | "warn" | "none" = "none"): HTMLElement {
  const valueRow = h("span", { class: "restore-fig__value-row" }, h("span", { class: "restore-fig__value tnum" }, value));
  if (status !== "none") valueRow.appendChild(statusDot(status, status === "ok" ? "Good" : "Caution"));
  return h(
    "div",
    { class: "restore-fig" },
    h("span", { class: "restore-fig__label" }, label),
    valueRow,
    h("span", { class: "restore-fig__sub" }, sub),
  );
}

export function factRow(dl: HTMLElement, label: string, value: Child): void {
  dl.appendChild(h("dt", label));
  const dd = h("dd");
  if (typeof value === "string" || typeof value === "number") dd.appendChild(document.createTextNode(String(value)));
  else if (value) dd.appendChild(value as Node);
  dl.appendChild(dd);
}

export function runIdCell(runId: string): HTMLElement {
  if (!runId) return h("span", { class: "field__hint" }, "-");
  return h("span", { class: "run-id-cell" }, h("span", { class: "mono" }, runId), copyButton("Copy run id", () => runId));
}

export function cue(host: HTMLElement, label: string, value: string): HTMLElement {
  // Returns the VALUE element so a caller can decorate the cue it just added (the approvals inbox tags the
  // "Requested by" value for the tour and ellipsis-truncates it) without a position-sensitive query.
  const valueEl = h("span", { class: "approval-cue__value" }, value);
  host.appendChild(h("div", { class: "approval-cue" }, h("span", { class: "field__hint" }, label), valueEl));
  return valueEl;
}

export function approvalStatusBadge(status: RestoreApproval["status"]): HTMLElement {
  // A pending request reads "Awaiting approval" in info tone, matching the two config inboxes'
  // wording and tone for the same state (the "Requested by / Requested" metadata labels stay).
  if (status === "requested") return statusWithLabel("info", "Awaiting approval");
  // "applying" is called out explicitly (rather than left to the titleCase fallback below, which already
  // produced the same "Applying"/info badge) to match pruneApprovalStatusBadge's explicit branch
  // (prune-approvals.ts) for the same PruneApprovalStatus member, now that ApprovalStatus mirrors it.
  if (status === "applying") return badge("info", "Applying");
  const tone: StatusTone = status === "approved" ? "ok" : status === "rejected" ? "danger" : status === "expired" ? "neutral" : "info";
  return badge(tone, titleCase(status));
}

export function sourceTypeBadge(type: "kv" | "r2" | "secrets" | "d1" | "cf-config" | "workers"): HTMLElement {
  return badge("default", type);
}

// findUsableApproval is the client MIRROR of the engine's apply gate (engine/src/admin/approvals.ts
// isUsableApproval): from a listing it finds the record whose planHash matches THIS one and that is
// genuinely usable to apply, i.e. its (effective) status is "approved" AND a checker is recorded AND the
// checker DIFFERS from the caller (maker != checker). The listing already projects the effective status
// (the engine's viewStatus substitutes "expired" for a lapsed record on read), so a status of "approved"
// here is the effective status. The engine remains the authority and re-checks this server-side at apply;
// this lookup decides only whether to OFFER an enabled Apply. A null planHash (the binding could not be
// computed) or a null caller email (the token fallback, no attributable identity to compare) yields no
// match, so Apply stays gated. Shared by the single-run confirm gate (confirm.ts) and the batch restore
// queue (batch.ts): EACH row/run has its OWN distinct planHash, so calling this once per row/plan hash is
// exactly what keeps every run's approval independent -- there is no shared or aggregate gate here.
//
// IDENTITY KEY: the ENGINE enforces maker != checker on the
// stable, immutable SUBJECT (iss|sub), not the mutable email, closing ASVS V10.3.3 / V10.5.2. This
// console pre-flight compares EMAIL because the RestoreApproval wire shape projects requestedBy /
// approvedBy as emails (display) only; it carries no approval subject for the console to mirror on. That
// is safe: this is a UX hint that decides only whether to show an enabled Apply, never the control (the
// engine re-checks by subject at apply and a same-subject-different-email self-approval is refused there
// regardless of what this email compare returned). When the engine surfaces the approval subjects on
// this wire shape, switch this compare to caller.subject vs the approval's requester/approver subject to
// mirror the server gate exactly.
export function findUsableApproval(records: RestoreApproval[], planHash: string | null, callerEmail: string | null): RestoreApproval | null {
  if (planHash === null || callerEmail === null) return null;
  const now = Date.now();
  for (const r of records) {
    if (r.planHash !== planHash) continue;
    if (r.status !== "approved") continue;
    if (approvalHasLapsed(r, now)) continue;
    if (!r.approvedBy) continue;
    if (r.approvedBy === callerEmail) continue; // maker != checker (UX pre-flight by email; engine re-checks by subject)
    return r;
  }
  return null;
}

// approvalHasLapsed re-applies the engine's OWN 24-hour TTL to a listing this console is still holding.
//
// WHY THE PROJECTED STATUS IS NOT ENOUGH, WHICH IS THE WHOLE POINT. The engine applies the TTL LAZILY at
// every decision (engine/src/admin/approvals.ts effectiveStatus) and the listing route projects the result
// (viewStatus), so a status of "approved" is the effective status AT THE INSTANT THE LISTING WAS READ. It
// is not a standing fact. The confirm gate stops its approvals poll the moment Apply arms
// (confirm.ts startPoll), so nothing looks again for the life of the tab, and a tab left open past the
// approval's own expiresAt went on offering an enabled Apply over an approval the engine would now refuse.
// Without this, a tab left open well past expiresAt could still read "Approved and ready to apply"
// long after the approval had actually lapsed.
// expiresAt is REQUIRED on the wire (lib/api/types/rbac.ts RestoreApproval) and was already sitting in
// this record unread.
//
// IT MIRRORS effectiveStatus EXACTLY, INCLUDING WHERE THAT REFUSES TO DECIDE. An UNPARSEABLE expiresAt is
// NOT a lapse: the engine's `Number.isFinite(exp) && exp <= now` deliberately leaves a corrupt stamp alone
// so a bad timestamp cannot fail the restore machine closed on a healthy approval (approvals.ts records
// that reasoning beside approvalTimestampUnparseable). Reading it as lapsed here would replace a false
// "ready to apply" with a false "no approval", and both are states the product is not in. The engine stays
// the authority either way: this decides only whether to OFFER an enabled Apply, exactly as the rest of
// this function does.
function approvalHasLapsed(record: RestoreApproval, now: number): boolean {
  const expires = Date.parse(record.expiresAt);
  return Number.isFinite(expires) && expires <= now;
}

// hasLapsedApprovalForPlan reports the ONE state findUsableApproval now refuses that it did not refuse
// before: this exact plan HAS an approval, signed by a distinct approver, and its own expiresAt has passed.
// It is what lets the screen say "the approval lapsed, re-run the plan" instead of the standing "raise a
// request" copy, which is advice for a plan nobody has signed and would send an operator to fetch an
// approval they already have. Kept beside the lookup it qualifies so the two read the same fields.
export function hasLapsedApprovalForPlan(records: RestoreApproval[], planHash: string | null, callerEmail: string | null): boolean {
  if (planHash === null || callerEmail === null) return false;
  const now = Date.now();
  return records.some(
    (r) => r.planHash === planHash && r.status === "approved" && !!r.approvedBy && r.approvedBy !== callerEmail && approvalHasLapsed(r, now),
  );
}

// gateBlockClassFor says WHY findUsableApproval above returned null, in one frozen class. It is the
// diagnostic twin of that lookup and reads exactly the same four preconditions, in the same order, so the two
// can never disagree about the state of the same gate.
//
// The fault it exists for is a real ticket and an unfalsifiable one: "the approver signed the plan and Apply
// never lit up". Four completely different states produced that identical screen and identical (absent)
// evidence -- the client could not compute the plan hash at all, the caller has no attributable identity, the
// approval that exists is bound to a DIFFERENT hash than the one this console is matching on, or the only
// approval is the operator's own. Each is a different remedy, and none of them was visible in the tab or in the
// pack. The engine's approval records ride in the pack and say an approval EXISTS; nothing said why the console
// would not use it.
//
// It returns NULL for the fifth state, an approval that has simply not been given yet, and that omission is
// deliberate. That state is the dual-control ceremony working as designed; it persists for as long as the second
// approver takes; and the approval poll re-enters here every few seconds while it lasts. A row for it would fire
// on every healthy restore in the product and drown the four states that are actually faults.
//
// Reads only the plan hash (a digest), the caller's email presence, and the records' own status/planHash/runId.
// It returns a frozen enum member: no email, no hash and no run id can leave through it.
export function gateBlockClassFor(
  records: RestoreApproval[],
  planHash: string | null,
  callerEmail: string | null,
  runId: string | null,
): ClientDiagGateBlockClass | null {
  // The client could not compute the binding key, so it has nothing to match ANY approval against and Apply can
  // never arm, however many approvers sign. restorePlanHash needs WebCrypto, which is absent outside a secure
  // context, so a console served over plain http lands here on every restore.
  if (planHash === null) return "plan-hash-failed";
  // No attributable caller (the bare-token break-glass path carries no email), so maker != checker has no
  // left-hand side to compare and the pre-flight refuses every approval.
  if (callerEmail === null) return "no-caller-identity";

  const forThisPlan = records.filter((r) => r.planHash === planHash);
  // LAPSED RECORDS ARE EXCLUDED HERE FOR THE SAME REASON findUsableApproval EXCLUDES THEM, and the header
  // above is why it is not optional: this function is that lookup's diagnostic twin and reads "exactly the
  // same four preconditions, in the same order, so the two can never disagree about the state of the same
  // gate". Leaving the lapse test out of one of the two would have made them disagree in precisely the case
  // the lapse test was added for: the lookup would refuse to arm while :440 below returned null, meaning
  // "a usable approval exists: the gate is armed, not blocked", and the screen would fall back to the
  // standing dual-control copy for a plan that HAS been approved. The lapse is surfaced as its own sentence
  // by the caller (confirm.ts approvalLapsedNote) rather than as a new member of this enum, because the enum
  // is a CLOSED vocabulary the engine must admit member-for-member: a console-only addition is dropped whole
  // on arrival by projectRecord and reads as silence in the support pack.
  const approvedForThisPlan = forThisPlan.filter((r) => r.status === "approved" && r.approvedBy && !approvalHasLapsed(r, Date.now()));
  // An approval for this plan is approved, and the approver IS the caller. The gate is right to refuse it, and
  // the operator (who signed it themselves) has no way of knowing that is what they are looking at.
  if (approvedForThisPlan.length > 0 && approvedForThisPlan.every((r) => r.approvedBy === callerEmail)) return "self-approval";
  if (approvedForThisPlan.length > 0) return null; // a usable approval exists: the gate is armed, not blocked

  // THE HASH MISMATCH. An approval for THIS RUN exists and is approved, and its planHash is not the one this
  // console computed, so findUsableApproval passes over a record the operator can see in the approvals inbox.
  // The approver really did sign; the console is matching on a different key. This is the ticket, and it was
  // completely invisible: it rendered as "awaiting approval", which is also what an unsigned plan renders as.
  if (runId !== null && records.some((r) => r.runId === runId && r.status === "approved" && r.planHash !== planHash)) {
    return "plan-hash-mismatch";
  }
  // Nothing approved for this run at all: the plan is genuinely awaiting its approver. NOT a fault, NOT recorded.
  return null;
}

// GATE_BLOCK_ADVICE is the CUSTOMER half of gateBlockClassFor, and it exists because the diagnosis above was
// built and then routed only to the support pack. The four classes each have a different remedy, and the
// screen painted the same sentence over all four: "This apply needs a second authorised identity to approve
// this exact plan first." Three of them are not that at all.
//
// Two of the four are unliftable without knowing which one you are in. plan-hash-failed can never arm however
// many approvers sign, because the client has no key to match an approval against, so the sentence about
// raising a request is advice that cannot work. plan-hash-mismatch is worse to read: the operator can SEE an
// approved record in the inbox and Apply stays dark, and the screen tells them to go and get the approval they
// already have.
//
// So each entry names the fact, keeps the reassurance that nothing has been written, and names the remedy. The
// fifth state, an approval that has simply not been given yet, is deliberately NOT in this map: it is the
// ceremony working as designed, gateBlockClassFor returns null for it, and the standing unarmed copy is
// already the right thing to say. An absent class therefore reads as neither a fault nor a pass.
const GATE_BLOCK_ADVICE: Record<ClientDiagGateBlockClass, string> = {
  "plan-hash-failed":
    "Apply cannot arm on this plan, and an approval will not change that. This browser could not compute the plan's fingerprint, and an approval is bound to that fingerprint, so there is nothing here to match one against. Computing it needs the browser's cryptography, which is offered only on a secure (https) address. Open this console over https, or in a browser that offers it, then build the plan again. Nothing has been written.",
  "no-caller-identity":
    "Apply cannot arm on this plan. The console has no identity for you, so it cannot check that the approver is somebody other than you, which is what dual control requires. A shared admin token carries no identity. Sign in as yourself, then open this plan again. Nothing has been written.",
  "plan-hash-mismatch":
    "An approval for this run has been signed, and it is bound to a different plan than the one on screen, so it cannot unlock this apply. Any change to the plan's inputs changes what is being approved. Open the approvals inbox to see which plan was signed, or raise a fresh request for this one. Nothing has been written.",
  "self-approval":
    "The only approval for this plan is your own, and dual control requires a different person. Ask another approver to sign this exact plan; Apply unlocks as soon as they do. Nothing has been written.",
};

// gateBlockAdvice translates a blocked-gate class into the sentence the operator reads. Total over the closed
// enum (a Record, so a new member is a compiler error rather than a silently missing case), and null in, null
// out: the caller keeps its own standing copy for the healthy awaiting-an-approver state.
export function gateBlockAdvice(cls: ClientDiagGateBlockClass | null): string | null {
  return cls === null ? null : GATE_BLOCK_ADVICE[cls];
}

// makeGateBlockReporter is the ONE emitter both the single-run confirm gate and the batch queue use, and it
// exists to keep the COUNT honest. Both surfaces re-check the gate on a poll, so a gate that is blocked stays
// blocked for as long as the operator leaves the screen open: recording on every re-check would make `count`
// mean "how many times the poll ran" rather than "how many restore plans were blocked this way", which is the sort
// of number a support engineer would reasonably read as a severity. The latch is keyed on the run and the class
// (the run id is a LOCAL key and never enters a record), so each blocked plan contributes exactly one, and a
// second plan blocked the same way still counts.
export function makeGateBlockReporter(): (records: RestoreApproval[], planHash: string | null, callerEmail: string | null, runId: string | null) => void {
  const reported = new Set<string>();
  return (records, planHash, callerEmail, runId): void => {
    const gateBlockClass = gateBlockClassFor(records, planHash, callerEmail, runId);
    if (gateBlockClass === null) return;
    // plan-hash-failed is latched GLOBALLY, not per reporter instance, because it has TWO producers for one run:
    // the plan step's swallowed restorePlanHash catch fires it the moment the hash fails, and this reporter fires
    // it again at the first approval recheck, which sees the same null hash. Two increments, one blocked run. The
    // count is what a support engineer reads as severity, so it must mean "how many restore plans were blocked
    // this way" and not "how many code paths noticed".
    if (gateBlockClass === "plan-hash-failed") {
      reportPlanHashFailed(runId);
      return;
    }
    const key = `${runId ?? ""}|${gateBlockClass}`;
    if (reported.has(key)) return;
    reported.add(key);
    recordRestoreGateBlocked(gateBlockClass);
  };
}

// planHashFailedRuns is the SHARED latch for the plan-hash-failed class: the plan step and the approval recheck
// both observe the same null hash for the same run, and they must contribute ONE row between them. Module-level
// on purpose, so the two call sites cannot each keep their own idea of what has been reported. The run id is a
// LOCAL key only and never enters a record.
const planHashFailedRuns = new Set<string>();

// reportPlanHashFailed is the ONE emitter for the swallowed restorePlanHash failure. Both the single-run
// plan step and the batch queue's per-row plan call it, so a run whose hash cannot be computed contributes exactly
// one row however many times the flow notices, and a SECOND run that fails the same way still counts.
export function reportPlanHashFailed(runId: string | null): void {
  const key = runId ?? "";
  if (planHashFailedRuns.has(key)) return;
  planHashFailedRuns.add(key);
  recordRestoreGateBlocked("plan-hash-failed");
}

// resetGateBlockLatches is the validator's seam (the module holds session state and a validator drives several
// independent scenarios in one process). Not called by production code.
export function resetGateBlockLatches(): void {
  planHashFailedRuns.clear();
}

// ---- self-identification: friendly downpipe names for a raw runId/downpipeId ----------------------
// The run picker, the run-context card and the approvals inbox each showed only a raw runId/downpipeId,
// so a second approver (or anyone browsing runs) could not tell WHAT a card was about. The console
// already has the join elsewhere (runs/view.ts fetchRuns enriches its fleet-wide run list the same way);
// these two small helpers reuse that exact idiom rather than re-deriving it three times.

// fetchDownpipeNames reads the fleet ONCE and returns its id -> Downpipe.name map. Read-only
// enrichment: a failed read degrades to an empty map (every caller falls back to the raw id, never a
// fabricated name), so a naming-only fetch can never block or fail the restore flow it labels.
export async function fetchDownpipeNames(engine: EngineClient): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const states = await engine.listDownpipes();
    for (const s of states) names.set(s.config.id, s.config.name);
  } catch {
    // presence-safe: callers read the raw id when it is not in the map.
  }
  return names;
}

// RunIdentity is the join value buildRunNameJoin resolves per runId: the owning downpipe's id (always,
// when the run is found in a retained ring) and its friendly name (when the fleet name read resolved it).
export interface RunIdentity { downpipeId: string; downpipeName?: string }

// buildRunNameJoin resolves EVERY retained run's runId -> RunIdentity in one pass, for a surface that
// starts with only a runId and no downpipeId (the approvals inbox: RestoreApproval carries runId alone,
// no downpipeId -- a second approver otherwise cannot tell WHAT they are approving). Combines
// listAllHistory() (the ring walk run-context.ts's locateRun and the run picker above also perform)
// with fetchDownpipeNames() (the id -> name map). Each read degrades independently and this function
// NEVER throws: a failed history read yields an empty join, a failed name read yields a join keyed by id
// with no name, so a naming-only fetch can never block or fail the surface it labels -- every caller
// falls back to the raw runId (or downpipeId) when the join has no usable entry for it. This is a
// BEST-EFFORT join, not an authoritative one: an approval can legitimately outlive the ring of a very
// high-frequency downpipe (RING_CAP is a fixed run count, not a time window), in which case the identity
// is honestly absent rather than guessed.
export async function buildRunNameJoin(engine: EngineClient): Promise<Map<string, RunIdentity>> {
  const join = new Map<string, RunIdentity>();
  let byDownpipe: Record<string, RunHistoryEntry[]>;
  try {
    byDownpipe = (await engine.listAllHistory()).byDownpipe;
  } catch {
    return join; // no history reachable: every caller falls back to the raw runId
  }
  const names = await fetchDownpipeNames(engine);
  for (const downpipeId of Object.keys(byDownpipe)) {
    const downpipeName = names.get(downpipeId);
    for (const run of byDownpipe[downpipeId] ?? []) {
      if (run.runId) join.set(run.runId, { downpipeId, ...(downpipeName ? { downpipeName } : {}) });
    }
  }
  return join;
}

// downpipeIdentityCell renders the owning downpipe's friendly name (when known) with its id as a
// secondary mono line beneath -- the id stays visible (it is the stable join key, still useful for
// support), but the name leads so a second approver, or anyone browsing runs, can tell WHAT the row is
// about at a glance. Falls back to the id alone when the name could not be resolved (a failed/slow name
// read, or a downpipe deleted after the run), never a fabricated name. Shared by the run detail card, the
// run picker and the approval card so the three surfaces read the identity identically.
export function downpipeIdentityCell(downpipeId: string, downpipeName: string | undefined): HTMLElement {
  if (!downpipeName) return h("span", { class: "mono" }, downpipeId);
  return h(
    "span",
    { style: "display:grid;gap:2px" },
    h("span", downpipeName),
    h("span", { class: "mono field__hint" }, downpipeId),
  );
}

export function legendSwatch(tone: StatusTone, label: string): HTMLElement {
  return h("span", { class: "run-strip__legenditem" }, statusDot(tone, label), h("span", { class: "field__hint" }, label));
}

export function splitPrefixes(s: string): string[] {
  return s.split(",").map((p) => p.trim()).filter((p) => p !== "");
}

// ---- the live-apply evidence ------------------------------------------------------------------

// noteApplyOutcome makes a LIVE APPLY correlatable with what the engine actually did. The ticket it answers
// is "did my restore write anything?". It lives here, not in confirm.ts, because there are TWO live-apply
// paths (the single-run confirm and the batch queue's per-row apply) and both must record through the one
// recorder, or the queue's writes stay invisible exactly as they were.
//
// THE FOURTH ENDING USED TO BE SILENCE, AND SILENCE MEANT TOO MANY THINGS. The first build recorded only the
// bad endings, so an apply that came back with no failures recorded no row at all. But "no row at all" was
// also what a restore that never ran left behind, and what a restore that reported success and wrote NOTHING
// left behind. Three states support must act on differently were one state in the pack, which is the precise
// ticket the gap names. An apply-outcome row is now recorded on EVERY ending, and the class says which:
//
//   wrote-all              applied, no failures, records written. The happy path, recorded EXPLICITLY, so its
//                          ABSENCE beside a receipt the customer swears they saw is itself evidence.
//   wrote-some             applied, some records written and some failed. Half-applied: a retry must be scoped
//                          to the remainder rather than re-run whole.
//   wrote-none             applied, NO failures reported, NO records written. Success reported, nothing moved.
//   wrote-none-all-failed  applied, nothing written, every record failed. A different ticket to the line above.
//   unknown-shape          a 2xx that is not an apply result, so the console cannot say what was written.
//   not-sent               the apply POST never came back (noteApplyNotSent, below).
//
// The row's `count` is how many applies ended that way, so an operator who pressed Apply three times against
// the same silent ending reads as three, not as one.
//
// NO-CUSTODY: closed classes and counts only. A failure's `name` is a customer record name and its `reason`
// is engine text, so neither is read; the mode value the engine did send is not read either. The bulk-outcome
// row is still emitted alongside a FAILING apply, because it carries the MAGNITUDE (how many records did not
// come back), which the class deliberately does not.
export function noteApplyOutcome(res: RestorePlan | RestoreResult): void {
  if (res.mode !== "applied") {
    recordApplyOutcome("unknown-shape");
    recordContractDrift("unknown-enum");
    return;
  }
  recordApplyOutcome(applyClassForCounts(res.recordsRestored, res.failures.length));
  if (res.failures.length > 0) {
    recordBulkOutcome("restore-apply", bulkReasonForCounts(res.recordsRestored, res.failures.length), res.failures.length);
  }
}

// noteApplyNotSent records the apply that never came back: the POST threw (transport, timeout, a refusal), so
// the console cannot say whether the engine wrote anything and the operator is about to press Retry. It gets
// its OWN class rather than being left to the generic engine-call row, because an engine-call row on the
// restore screen is also what a plan read and an approval poll leave behind, and "how many apply POSTs
// actually fired" cannot be answered from a tuple that three different calls share.
export function noteApplyNotSent(): void {
  recordApplyOutcome("not-sent");
}
