// Restore the confirm + apply gate (the safety heart). THE APPLY GATE is a
// client MIRROR of the engine control: an apply requires BOTH the Approver/Owner role
// AND a usable dual-control approval bound to THIS exact plan hash with a DISTINCT approver
// (maker != checker). Apply is NEVER enabled on role alone; until a usable approval exists the
// REQUIRED next step is to raise a request and have a distinct approver sign it. Friction is
// proportional to blast radius (type-to-confirm for redirect / non-latest / large). The receipt
// carries the real applier and the distinct approver. Moved verbatim out of
// restore-flow.ts for size: no confirmation / dual-control wording and no plan-hash handling is
// changed. House rules: Australian English, no em dashes, precise claims.

import type {
  EngineClient, 
  RestoreApproval,RestorePlan, RestoreRequest,
} from "../../api.ts";
import { copyButton } from "../../components/code-block.ts";
import { typeToConfirm } from "../../components/confirm.ts";
import { blockError, inlineOutcome } from "../../components/error-view.ts";
import { banner } from "../../components/feedback.ts";
import { field, validateForm } from "../../components/field.ts";
import { confirmModal } from "../../components/modal.ts";
import { requireChange } from "../../components/require-change.ts";
import { scheduleSlowNote } from "../../components/slow-note.ts";
import { toast } from "../../components/toast.ts";
import { verdictSurface } from "../../components/verdict.ts";
import { isRateLimited, rateLimitDelayMs } from "../../lib/bulk-pacing.ts";
import type { ClientDiagGateBlockClass } from "../../lib/client-diag/vocab.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { classifyError, isUnauthorised } from "../../lib/errors.ts";
import { absoluteTime, groupNumber } from "../../lib/format.ts";
import { ICON_CHECK, ICON_RESTORE } from "../../lib/icons.ts";
import { caller, goSignedOut, navigate } from "../../lib/nav.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { canCap, capGateReason, pendingEngineNote } from "../common.ts";
import { crossfadeSwap, drawStrokeOnce } from "./effects.ts";
import { wipeOnDisconnect } from "./reassembly.ts";
import { renderReceipt } from "./receipt.ts";
import {
  APPROVAL_POLL_MS,
  configSurfacesToApply,
  type FlowPrefill,
  findUsableApproval,
  gateBlockAdvice,
  gateBlockClassFor,
  hasLapsedApprovalForPlan,
  impactSentence,
  makeGateBlockReporter,
  noteApplyNotSent,
  noteApplyOutcome,
  RESTORE_STEP_COUNT,
  UNWRITTEN_MARK,
} from "./shared.ts";

// E2: the last plan hash the seal tick beside the hash cue has drawn for, module-scoped so it
// survives across the repeated renderConfirm calls one flow session makes (a fresh dry-run, a
// scoped re-entry). A genuinely new hash draws the seal once; an unchanged hash (a re-render that
// did not change the plan) renders it already complete, never re-drawn.
let lastDrawnPlanHash: string | null = null;

// ApprovalsReadTimeout is the 12-second approvals-read expiry as its OWN type rather than a bare Error
// carrying a message. The catch below has to tell it apart from a transport fault, a 401 and a 429, and
// matching on message text is exactly the kind of check that keeps passing after the text is reworded.
class ApprovalsReadTimeout extends Error {
  constructor() {
    super("listApprovals: timed out");
    this.name = "ApprovalsReadTimeout";
  }
}

// LAPSED_APPROVAL_NOTE is the sentence for an approval that WAS signed by a distinct approver and whose
// own 24-hour window has since closed. The remedy is the opposite of the standing dual-control copy's: the
// engine mints an approval against a plan HASH, so a lapsed one cannot be revived by anybody signing
// anything, and the plan has to be built again before a fresh request means anything.
const LAPSED_APPROVAL_NOTE =
  "A distinct approver did sign this exact plan, and that approval has since expired (approvals last 24 hours). It cannot be revived by re-approving it. Run the plan again from the review step, then raise a fresh request against the new plan.";

// expiryClause states WHEN an armed approval lapses, or says nothing at all. See its call site.
function expiryClause(approval: RestoreApproval): string {
  const at = absoluteTime(approval.expiresAt);
  return at === "" ? "" : ` It expires at ${at}, after which the plan has to be run again.`;
}

// APPLY_OUTCOME_UNKNOWN_NOTE is the sentence for the one call on this screen whose outcome the console
// genuinely cannot know: the apply POST that never came back. See the catch in the apply handler.
const APPLY_OUTCOME_UNKNOWN_NOTE =
  "The apply was sent and its response never arrived, so this console cannot tell whether the engine wrote anything. Do not assume it did not. Open the run's restore history or the audit log to see whether the write landed before you try again, because a retry that follows a completed apply writes the same records a second time.";

// ---- confirm + apply (friction proportional to blast radius) --------
// findUsableApproval (the client mirror of the engine's apply gate) moved to shared.ts so the batch
// restore queue (batch.ts) can reuse the EXACT same maker != checker mirror check per row, rather than a
// second copy that could silently drift from this one.

// noteApplyOutcome / noteApplyNotSent live in shared.ts, because BOTH live-apply paths must
// record through the one recorder: this single-run confirm, and the batch queue's per-row apply (batch.ts).

export async function renderConfirm(
  engine: EngineClient,
  plan: RestorePlan,
  req: RestoreRequest,
  planHash: string | null,
  flags: { highImpact: boolean; isLarge: boolean; isRedirect: boolean; isNonLatest: boolean; isCrossAccount: boolean; isCrossZone: boolean },
  paintStepper: (step: number) => void,
  reenter: (prefill: FlowPrefill) => void,
  // opts carries the break-glass restore panel's browser-recovered per-run master through to the
  // eventual apply call, exactly as the dry-run preview already carries it (client-downpipes.ts restore()).
  // Undefined for every OTHER caller of this function (the standard operational-key flow, plan.ts), so their
  // wire shape is byte-unchanged: opts is threaded to engine.restore() only, never into the request body, the
  // plan-hash computation or the dual-control approval request -- those stay master-agnostic, which is what
  // lets a SECOND, DISTINCT approver sign this exact plan from their own browser without ever touching the
  // master (maker != checker is preserved: the master lets THIS caller open the run; the approval is a
  // separate authorisation the engine gates independently, per router-restore.ts's dual-control block, which
  // runs identically whether or not a master header rides the same apply POST).
  opts?: { restoreMasterB64?: string },
): Promise<HTMLElement> {
  const section = h("div", { class: "restore-confirm" });
  section.appendChild(h("h3", { class: "drawer-section__title" }, "Confirm and apply"));

  // "Nothing to apply" must account for EVERY surface an apply writes, not data records alone.
  // plannedWrites counts only data records; a cf-config restore (configChanges, idempotent surfaces the apply
  // WOULD write back, willApply) and a media restore (mediaPlanned, files an apply WOULD re-upload) each write
  // outside that count. Keying the short-circuit on plannedWrites alone told a config-only or media-only run
  // "this plan writes nothing" (a false blast-radius statement) and hid Apply, so a legitimate config/media
  // restore was unreachable from the console while the engine would apply it. Short-circuit only when data,
  // config and media all write nothing.
  const writesData = plan.plannedWrites > 0;
  // Shared with the figure row and the impact banner (shared.ts), so the number the operator reads and the
  // decision to offer Apply at all can never come from two different counts.
  const writesConfig = configSurfacesToApply(plan) > 0;
  const writesMedia = (plan.mediaPlanned ?? []).length > 0;
  if (!writesData && !writesConfig && !writesMedia) {
    section.appendChild(h("p", { class: "field__hint" }, "This plan writes nothing, so there is nothing to apply."));
    return section;
  }

  // The plan-hash cue (the exact value an approval binds to). Redaction-safe. The hash text
  // itself is complete, selectable and copyable from the first frame (never touched); the seal
  // glyph beside it is decorative (aria-hidden) and is the only part E2 animates.
  if (planHash) {
    const seal = svgIcon(ICON_CHECK, { size: 14 });
    seal.classList.add("restore-confirm__seal");
    // E2: draws once via stroke-dashoffset, keyed to the hash VALUE so it only replays when a
    // genuinely new plan hash is computed; an unchanged hash renders the seal already drawn.
    const isReplayHash = planHash === lastDrawnPlanHash;
    lastDrawnPlanHash = planHash;
    drawStrokeOnce(seal, isReplayHash, 250);
    section.appendChild(
      h(
        "p",
        { class: "restore-confirm__hash field__hint mono", title: planHash },
        `Plan ${planHash.slice(0, 28)}…`,
        seal,
        copyButton("Copy plan hash", () => planHash!),
      ),
    );
  }

  const me = caller();

  // The capability gate, mirrored client-side: an apply requires restore.apply, the capability
  // the engine enforces at router-restore.ts (gate(caller, "restore.apply")) and which Restore
  // operator, Approver or Owner hold. Gating by CAPABILITY, not by the cumulative role RANK,
  // matters because a restore-operator sits off the rank ladder (roleRank 0) yet holds restore.apply,
  // so the old canDo("approver") rank check hid the whole apply/request panel from the recovery-only
  // role that exists for disaster recovery, even though the engine accepts its restore. A caller
  // without restore.apply never sees an Apply button; dry-run stays available to all (it wrote
  // nothing), and a restore.request holder can still RAISE a request (the step below, where the estate requires one).
  if (!canCap("restore.apply")) {
    section.appendChild(renderRoleGated(engine, plan, req, paintStepper));
    return section;
  }

  // Approver/Owner: the role gate is satisfied, but an apply ALSO requires a usable
  // dual-control approval bound to this plan, with a DISTINCT approver (maker != checker).
  // Ask the engine (read-only) whether one exists for this planHash; enable Apply ONLY if
  // so, otherwise surface the request step as the REQUIRED next step and let a refresh /
  // light poll light Apply up once a distinct approver signs. This is the gate the
  // engine enforces server-side; offering Apply on role alone would 403 ("restore not
  // approved"). The lookup is best-effort: if listApprovals is unavailable,
  // this degrades to the request step rather than a misleading enabled Apply.
  const approvalHost = h("div", { class: "restore-confirm__gate" });
  // A synchronous "checking" placeholder so the reviewed plan (the hero panel) paints
  // immediately and is NEVER blocked by the approvals lookup; the gate arms (or falls back
  // to the request step) asynchronously below.
  approvalHost.appendChild(h("p", { class: "field__hint" }, "Checking whether this plan has an approval from a distinct approver…"));
  section.appendChild(approvalHost);
  const result = h("div", { class: "restore-result-host" });

  // THE GATE'S TIMERS GET AN OWNER HERE, two of them, because the two ways a confirm section stops
  // mattering are different and neither covers the other.
  //
  // wipeOnDisconnect is the navigation half and is the pattern this repo already uses at four mount sites
  // (recover-key.ts, attend.ts, both branches of restore-flow.ts): it runs once, when `section` leaves the
  // document, which is what a route change or a re-rendered plan card does. Its name is about wiping
  // secrets and this stops timers instead, but the contract it encodes, "this element is gone, run the
  // cleanup", is exactly the one wanted, and a fifth inline copy of the observer block is the thing that
  // helper exists to prevent. Where MutationObserver is absent it is a documented no-op, which is why the
  // registry below is not optional.
  //
  // GATE_STOPPERS is the explicit half: a panel that tears itself down without ever leaving the DOM (the
  // break-glass panel does exactly this, and so does a test driving the panel directly) has no disconnect
  // to observe. renderConfirm returns an element rather than a handle, and threading a new return shape
  // through both callers and their tests would change an API that is right for everything else it does, so
  // the stop is keyed off the element the caller already holds. A WeakMap, so a section nobody kept is
  // collectable and this can never itself become the retention it was written to remove.
  const stop = startApprovalGate({ engine, plan, req, planHash, flags, me, paintStepper, reenter, section, approvalHost, result, opts });
  GATE_STOPPERS.set(section, stop);
  wipeOnDisconnect(section, stop);

  section.appendChild(result);
  return section;
}

// GATE_STOPPERS maps a mounted confirm section to the function that stops its approval gate. See the block
// in renderConfirm above for why the stop is keyed off the element rather than returned beside it.
const GATE_STOPPERS = new WeakMap<HTMLElement, () => void>();

// The largest delay setTimeout accepts, in node and in every browser: the argument is a 32-bit signed
// integer of milliseconds, about 24.8 days. A larger one is neither rejected nor clamped to this value, it
// is silently reset to 1 ms. See watchForLapse, which is the site that has to know.
const TIMER_HORIZON_MS = 2_147_483_647;

/**
 * stopConfirmGate stops the approval gate a renderConfirm section started: its lapse timer, its poll and
 * its in-flight read guard. Call it from the teardown of any panel that mounted a confirm section and can
 * dismiss it without that section leaving the document.
 *
 * IDEMPOTENT AND SAFE ON A STRANGER. A section that never started a gate (the "nothing to apply"
 * short-circuit, the capability-gated branch) is simply absent from the map, and calling this twice clears
 * handles that are already null. Both matter: a teardown that threw on the paths where there was nothing
 * to stop would be worse than the leak it replaces.
 */
export function stopConfirmGate(section: HTMLElement | null | undefined): void {
  if (!section) return;
  GATE_STOPPERS.get(section)?.();
}

// renderRoleGated draws the capability-gate state for a caller WITHOUT restore.apply: the info
// banner stating the requirement, plus either the dual-control request panel (a restore.request
// holder can RAISE a request, the step where the estate requires one) or the read-only note. The dry-run plan above
// stays the full read-only preview.
function renderRoleGated(engine: EngineClient, plan: RestorePlan, req: RestoreRequest, paintStepper: (step: number) => void): HTMLElement {
  const host = h("div");
  host.appendChild(
    banner({
      tone: "info",
      message: `Applying a restore requires ${capabilityPhrase("restore.apply")}, held by the Restore operator, Approver or Owner role. ${capGateReason("restore.apply")} The dry-run plan above is the full read-only preview; to proceed, request approval so a distinct approver can sign it.`,
    }),
  );
  // A restore.request holder that lacks apply (an Operator) can raise the dual-control
  // request; a caller holding neither restore capability (a Viewer, an Access-admin) gets the
  // read-only note.
  if (canCap("restore.request")) {
    host.appendChild(renderRequestPanel(engine, plan, req, paintStepper));
  } else {
    host.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "You can preview the plan but cannot request or apply a restore."));
  }
  return host;
}

// ApprovalGateCtx groups the approval-gate coordination inputs: the apply collaborators, plus the
// live hosts the recheck/poll paint into (section drives the poll-on-screen lifecycle, approvalHost
// is swapped armed/unarmed, result hosts the receipt).
interface ApprovalGateCtx {
  engine: EngineClient;
  plan: RestorePlan;
  req: RestoreRequest;
  planHash: string | null;
  flags: { highImpact: boolean; isLarge: boolean; isRedirect: boolean; isNonLatest: boolean; isCrossAccount: boolean; isCrossZone: boolean };
  me: ReturnType<typeof caller>;
  paintStepper: (step: number) => void;
  reenter: (prefill: FlowPrefill) => void;
  section: HTMLElement;
  approvalHost: HTMLElement;
  result: HTMLElement;
  // opts: the break-glass restore panel's recovered master, passed straight through to renderArmed /
  // renderApplyControls. See renderConfirm's own header comment for why this never touches the approval gate
  // itself (the lookup/request/poll above are all master-agnostic; only the final apply call needs it).
  opts?: { restoreMasterB64?: string } | undefined;
}

// startApprovalGate kicks off the dual-control approval lookup WITHOUT blocking the plan paint: it
// arms the gate (an enabled Apply) when a usable approval bound to this plan exists from a distinct
// approver, otherwise paints the REQUIRED-request state and runs a light poll that arms Apply once a
// distinct approver signs. The single recheck path is shared by the initial lookup, the refresh
// button and the poll, so the gate can never get stuck on a stale state. A failed lookup degrades
// honestly to the request step (never a misleading enabled Apply).
//
// IT RETURNS THE WAY TO STOP IT, because it arms timers and nothing else can reach them. Without a
// stop, the 12-second approvals-read guard below can be left running after the read it guards has
// already won its race, and watchForLapse can arm one timer per arming for the approval's whole
// remaining lifetime (up to about an hour) with no handle kept. Each such timer holds the closure over
// `section`, `approvalHost` and `paintStepper`, which is the panel's whole detached subtree, for as long
// as an hour after the operator navigated away, and a console left on the restore screen re-arms on
// every poll tick. Returning a stop function lets every caller clear these timers deterministically.
function startApprovalGate(ctx: ApprovalGateCtx): () => void {
  const { engine, plan, req, planHash, flags, me, paintStepper, reenter, section, approvalHost, result, opts } = ctx;

  // The gate's OWN timers, held so they can be cleared rather than merely guarded when they fire. One
  // lapse timer at a time: renderArmed runs again on every re-arm (a poll tick, the operator's own Check
  // for approval, a re-armed DIFFERENT approval), and an unheld handle made that unbounded.
  let lapseTimer: number | null = null;
  let pollTimer: number | null = null;
  let polling = false;
  let stopped = false;
  // stop is idempotent and safe before anything is armed, exactly like the teardown paths that call it.
  // `stopped` is checked by the arming sites too: a recheck already in flight when stop runs would
  // otherwise resolve afterwards and arm a fresh timer over a section that has left the screen.
  const stop = (): void => {
    stopped = true;
    if (lapseTimer !== null) {
      window.clearTimeout(lapseTimer);
      lapseTimer = null;
    }
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    polling = false;
  };

  // The gate's own account of why it did not arm. The four fault states below rendered one identical
  // "awaiting approval" panel, so an operator whose approver HAD signed, and whose console was matching on a
  // plan hash it could not compute (or a different one from the approval's), had no way to say so and neither
  // did the pack. The reporter latches per class, so the five-second poll below cannot turn a persistent block
  // into a count in the thousands, and the legitimate state (genuinely awaiting an approver) records nothing.
  const noteGateBlock = makeGateBlockReporter();

  // renderArmed draws the enabled-Apply state for a found usable approval (the checker is carried
  // through to the apply handler and onto the receipt, F2/F3).
  const renderArmed = (approval: RestoreApproval): HTMLElement => {
    const armed = h("div", { class: "restore-confirm__armed" });
    armed.appendChild(
      verdictSurface({
        tone: "ok",
        title: "Approved and ready to apply",
        // The expiry is STATED, and stated only when this console can read it. absoluteTime returns "" for
        // an instant it cannot parse, and a sentence that keeps its verb and blanks its date is defect 67's
        // exact shape, so the clause is dropped whole rather than rendered empty. That is also the only
        // case where watchForLapse below arms no timer, so the two agree: where the deadline cannot be
        // read, nothing is claimed about it and nothing acts on it.
        body: `Approved by ${approval.approvedBy ?? ""} for this exact plan. You can apply now; the approval is single-use and is consumed on a successful apply.${expiryClause(approval)}`,
      }),
    );
    armed.appendChild(renderApplyControls({ engine, plan, req, planHash, approval, flags, me, result, paintStepper, reenter, section, opts }));
    watchForLapse(approval);
    return armed;
  };

  // watchForLapse retracts an ARMED gate the moment the approval it armed on reaches its own expiresAt.
  //
  // THE LOOKUP'S LAPSE TEST IS ONLY HALF OF THIS. findUsableApproval refusing a lapsed record closes
  // every case where the LISTING is read after the deadline: a fresh navigation, a reload, the batch
  // queue, the operator's own Check for approval. It does nothing for the tab that armed WHILE the
  // approval was still live and is still open when the deadline passes, because startPoll stops the
  // moment the gate arms, leaving nothing running to notice the deadline pass. Without this timer that
  // tab would keep reading "Approved and ready to apply" over an enabled Apply well past expiresAt.
  //
  // NO READ IS NEEDED AND NONE IS MADE. expiresAt is already in the record on screen, so the lapse is a
  // local certainty rather than something to go and ask about, and this costs no request. A single timer at
  // the exact instant is used rather than a resumed poll: a poll would re-enter the network every few
  // seconds for the life of every armed restore tab to learn a fact the tab already holds.
  //
  // AN UNPARSEABLE expiresAt ARMS NO TIMER AT ALL, mirroring approvalHasLapsed and the engine's own
  // effectiveStatus: a corrupt timestamp must not retract a healthy approval, exactly as it must not
  // withhold one.
  //
  // THE HANDLE IS HELD, AND ONE AT A TIME. The fire-time guards below are about CORRECTNESS, and they were
  // always right; they say nothing about the timer still being armed. renderArmed runs on every re-arm, so
  // an unheld handle meant one live hour-long timer per arming, each retaining this closure's `section` and
  // `approvalHost` after the panel had left the screen. Clearing the previous one before arming the next
  // keeps exactly one, and `stop` (returned by this function, called from the panel's teardown and from the
  // section's own disconnect) clears that one.
  const watchForLapse = (approval: RestoreApproval): void => {
    if (stopped) return;
    const expires = Date.parse(approval.expiresAt);
    if (!Number.isFinite(expires)) return;
    const remaining = expires - Date.now();
    if (remaining <= 0) return; // findUsableApproval would not have armed on it; nothing to retract.
    // A DEADLINE BEYOND THE TIMER HORIZON ARMS NOTHING, and this is not a tidiness guard. setTimeout takes a
    // 32-bit signed delay in both node and every browser, and a larger one is not rejected and not clamped
    // to the maximum, it is silently reset to 1 ms. So an approval more than 24.8 days out would otherwise
    // retract about one millisecond after it armed: the operator would watch "Approved and ready to apply"
    // turn into the window-has-closed sentence over an approval that was live, valid and signed by a
    // distinct approver, with the remedy on offer being to re-run a plan that needed no re-running.
    //
    // NOT ARMING IS THE ANSWER, rather than a chain of re-armed timers. This timer exists for the tab that
    // armed while the approval was live and is still open when the deadline passes; no tab is open for
    // twenty-five days, and every fresh read of the listing is already covered by findUsableApproval
    // refusing a lapsed record. It is the same rule as the unparseable expiresAt above: where the deadline
    // cannot be acted on, nothing is claimed about it and nothing acts.
    if (remaining > TIMER_HORIZON_MS) return;
    if (lapseTimer !== null) window.clearTimeout(lapseTimer);
    lapseTimer = window.setTimeout(() => {
      lapseTimer = null;
      // The section may have left the screen, or a later recheck may already have re-armed on a DIFFERENT
      // approval, in which case this timer is about a record that is no longer the one on offer.
      if (!section.isConnected) return;
      if (!approvalHost.querySelector(".restore-confirm__armed")) return;
      showUnarmed(null, LAPSED_APPROVAL_NOTE);
      paintStepper(3);
    }, remaining);
  };

  // renderUnarmed draws the request state for no usable approval on an estate that REQUIRES one (an
  // estate that does not never reaches here: the gate arms straight past it): the dual-control
  // request, plus a refresh that re-checks and arms Apply once a distinct approver has signed.
  //
  // gateNote is the ONE banner slot, held outside renderUnarmed so the CAUSE can be corrected without
  // rebuilding the panel underneath it. The panel is deliberately painted once and left alone (see
  // showUnarmed), because rebuilding it wiped a half-typed reason-for-change; but the cause is not known at
  // the same moment for all four classes. plan-hash-failed is known before any listing is read, while
  // plan-hash-mismatch and self-approval are only knowable once the records come back. Swapping this one
  // element's children keeps both properties: the form below survives, and the sentence tells the truth as
  // soon as the truth is available.
  //
  // `override` is a sentence the gate knows to be true that the CLOSED diagnostic vocabulary has no member
  // for, and it takes precedence over both the class advice and the standing copy. It exists because two of
  // the states below are not "nobody has approved this yet" and the standing copy asserts that they are:
  // an approvals read that TIMED OUT (a fact about the read, not about the approval) and an approval that
  // was signed by a distinct approver and has since LAPSED (a fact about the clock, not about the approver).
  // Neither may become a new ClientDiagGateBlockClass member from this side: that enum is admitted
  // member-for-member by engine/src/admin/client-diag-vocab.ts and a console-only addition is DROPPED WHOLE
  // by projectRecord on arrival, so the row would read as silence in the support pack rather than as a
  // downgrade. So the sentence is
  // carried on the screen, where it is needed, and the vocabulary is left alone.
  const gateNote = h("div");
  const paintGateNote = (cause: ClientDiagGateBlockClass | null, override?: string): void => {
    const advice = gateBlockAdvice(cause);
    gateNote.replaceChildren(
      banner({
        tone: "warn",
        message:
          override ??
          advice ??
          "This apply needs a second authorised identity to approve this exact plan first; the approver must differ from you. Raise the request below; Apply unlocks once a distinct approver signs it.",
      }),
    );
  };

  const renderUnarmed = (): HTMLElement => {
    const unarmed = h("div", { class: "restore-confirm__unarmed" });
    unarmed.appendChild(gateNote);
    unarmed.appendChild(renderRequestPanel(engine, plan, req, paintStepper));
    const refreshBtn = h("button", { "data-dp": "restore-flow.button.refresh", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-3)" }, svgIcon(ICON_CHECK, { size: 14 }), "Check for approval") as HTMLButtonElement;
    refreshBtn.addEventListener("click", () => void recheck());
    unarmed.appendChild(h("div", { class: "restore-confirm__recheck" }, refreshBtn, h("span", { class: "field__hint", style: "margin-left:var(--space-2)" }, "Checks whether a distinct approver has signed this plan.")));
    return unarmed;
  };

  // showUnarmed paints the unarmed state ONCE and then leaves it alone: the host is only swapped when
  // it is not already showing the unarmed panel. Rebuilding it on every recheck (the 5s poll ran
  // recheck on each tick) wiped a half-typed reason-for-change, destroyed keyboard focus, and erased
  // the "Awaiting approval" outcome. The state only ever changes unarmed -> armed.
  const showUnarmed = (cause: ClientDiagGateBlockClass | null = null, override?: string): void => {
    // The cause is painted on every call, including the ones that only re-assert the panel already on
    // screen: a plan the operator edits can move between classes (a mismatch becomes a fresh await), and a
    // stale sentence about a cause that has passed is its own defect.
    paintGateNote(cause, override);
    if (!approvalHost.querySelector(".restore-confirm__unarmed")) {
      approvalHost.replaceChildren(renderUnarmed());
    }
  };

  // recheck re-queries the listing and arms the gate when a usable approval appears.
  // pollPausedUntil is the wall-clock instant (ms) the AUTOMATIC poll may resume after the engine
  // rate-limited an approvals read. Only the poll observes it: the operator's own "Check for approval"
  // button stays live, because a person choosing to retry is not the thing that saturates a bucket, and
  // refusing them a button that works would trade one frozen-feeling screen for another.
  let pollPausedUntil = 0;
  const recheck = async (): Promise<boolean> => {
    if (planHash === null) {
      // The client has no binding key, so Apply can NEVER arm here: no listing is even worth reading. Recorded
      // with an empty listing, because the class does not depend on one.
      noteGateBlock([], planHash, me?.email ?? null, req.runId);
      showUnarmed(gateBlockClassFor([], planHash, me?.email ?? null, req.runId));
      return false;
    }
    // Declared out here so the `finally` can reach it: the timer is created inside the race arm below.
    let readTimer: number | null = null;
    try {
      // DOES THIS ESTATE EVEN REQUIRE A SECOND APPROVER? Asked BEFORE the approvals read, because when it
      // does not there is no record to find and the read can only ever come back empty. Without this the
      // screen sat on "Needs approval" for ever on a solo estate: the engine would have accepted the apply,
      // and the console never offered it. That is the half-landed shape, an engine fix whose UI still
      // refuses, and it is the whole point of the change to fix both ends.
      //
      // FAIL-SAFE ON EVERY UNCERTAINTY. Only an explicit `false` takes this path. An engine that does not
      // report the field, a read that fails, anything unparsed: all fall through to the approval gate below,
      // so a policy this console could not read never becomes permission to skip a control the estate wants.
      // A PROMISE .catch CANNOT DEFEND A CALL THAT FAILS BEFORE IT RETURNS A PROMISE. This read was
      // `engine.getConfigApprovalPolicy().catch(() => null)`, which defends a REJECTION and nothing else: if
      // the method is absent or throws while evaluating, the TypeError is raised before .catch is attached and
      // escapes to recheck's outer handler, taking every classification branch below with it. That is not
      // hypothetical: it collapsed four distinct gate-block classes into one generic state, so an operator
      // holding a valid approval for a DIFFERENT plan was told nobody had signed and sent to fetch one they
      // already had. try/catch is the shape the comment above already promised, covering a throw and a
      // rejection alike rather than only the half that returns a promise.
      let policy: Awaited<ReturnType<EngineClient["getConfigApprovalPolicy"]>> | null = null;
      try {
        policy = await engine.getConfigApprovalPolicy();
      } catch {
        policy = null;
      }
      if (policy !== null && policy.requireRestoreApproval === false) {
        const free = h("div", { class: "restore-confirm__armed" });
        free.appendChild(
          verdictSurface({
            tone: "ok",
            title: "Ready to apply",
            body: "This estate does not require a second approver for restores, so you can apply on your own. The dry run above is the plan that will be applied, and the apply is recorded in the audit log against you. An Owner can require a second approver in Security Centre.",
          }),
        );
        free.appendChild(renderApplyControls({ engine, plan, req, planHash, approval: null, flags, me, result, paintStepper, reenter, section, opts }));
        const wasUnarmedFree = approvalHost.querySelector(".restore-confirm__unarmed") !== null;
        if (wasUnarmedFree) crossfadeSwap(approvalHost, free, 180);
        else approvalHost.replaceChildren(free);
        paintStepper(4);
        return true;
      }
      // BOUNDED. Every other path out of this function paints, because every other path either resolves or
      // rejects. A lookup that does NEITHER reaches no catch and no continuation, so approvalHost keeps the
      // synchronous "Checking whether this plan has an approval" placeholder for the life of the screen and
      // neither .restore-confirm__unarmed nor .restore-confirm__armed ever exists.
      //
      // That is a frozen screen with no error, which is worse than either alone: the operator cannot act and
      // has nothing to report.
      //
      // Twelve seconds is chosen to be longer than any healthy approvals read and shorter than a person's
      // patience. On expiry the gate degrades to the honest UNARMED state, exactly as a transport fault
      // already does, so the operator still gets the request path rather than a dead panel.
      // THE EXPIRY IS TAGGED, NOT JUST THROWN. On expiry this used to reject with a bare Error that fell
      // through to the generic `showUnarmed()` at the foot of the catch, which paints the standing
      // dual-control copy: so a plan that WAS approved, by a distinct approver, bound to the exact plan
      // hash, read as a plan nobody had signed, and the remedy on offer was to raise a SECOND request for
      // the approval that already exists. A read that could not be completed is not a fact about the approval, and the one thing the
      // screen could not say was the only thing that was true.
      //
      // THE LOSING ARM IS CANCELLED, and until it was not. Promise.race settles on the first arm
      // and abandons the other, so a healthy read that came back in 200 ms still left this timer armed for
      // the remaining 11.8 seconds. Nothing wrong was ever painted (the rejection is already handled by the
      // race), but the poll below re-enters this function every APPROVAL_POLL_MS, so an unarmed gate held
      // two or three dead timers at all times for the life of the screen, each retaining this closure. It
      // is cleared in the `finally` at the foot of this try, which is the only place every exit passes
      // through: there are eight returns between here and there, across the try and the catch.
      const records = await Promise.race([
        engine.listApprovals(),
        new Promise<never>((_, reject) => {
          readTimer = window.setTimeout(() => {
            readTimer = null;
            reject(new ApprovalsReadTimeout());
          }, 12_000);
        }),
      ]);
      const usable = findUsableApproval(records, planHash, me?.email ?? null);
      if (!usable) noteGateBlock(records, planHash, me?.email ?? null, req.runId);
      if (usable) {
        // E4: crossfade the amber "Needs approval" tint + icon into the green "Approved and
        // ready" state ONLY when a genuine unarmed panel was on screen to dissolve out of. A gate
        // that arms on its very first check (no amber state was ever shown) has nothing to
        // crossfade from, so it renders the armed state complete and still, from the first frame,
        // the same as every other first-frame state in this flow.
        const wasUnarmed = approvalHost.querySelector(".restore-confirm__unarmed") !== null;
        const armed = renderArmed(usable);
        if (wasUnarmed) crossfadeSwap(approvalHost, armed, 180);
        else approvalHost.replaceChildren(armed);
        paintStepper(4);
        return true;
      }
      // The gate did not arm. If the reason is an approval for THIS plan, signed by a distinct approver,
      // whose own expiresAt has passed, say that: the standing copy tells the operator to go and get an
      // approval they already have, and the remedy here is the opposite one (the plan itself must be
      // re-run, because the engine mints an approval against a plan hash and this one's window is shut).
      showUnarmed(
        gateBlockClassFor(records, planHash, me?.email ?? null, req.runId),
        hasLapsedApprovalForPlan(records, planHash, me?.email ?? null) ? LAPSED_APPROVAL_NOTE : undefined,
      );
      return false;
    } catch (err) {
      // A READ THAT COULD NOT BE COMPLETED, REPORTED AS ONE. Tested before every branch below, because it
      // is the only one of them that is a fact about this console's own read rather than about the
      // approval, the session or the engine's verdict.
      if (err instanceof ApprovalsReadTimeout) {
        showUnarmed(
          null,
          "The approvals list did not come back within 12 seconds, so this console could not check whether this plan has been approved. This says nothing about the approval itself: one may already exist. Use Check for approval below to try the read again before raising a request.",
        );
        return false;
      }
      // A RATE LIMIT IS NOT A SESSION LOSS, and it is tested FIRST so it can never be swept into the
      // sign-out below. The engine's bare-token anti-brute-force throttle refuses before the credential is
      // even compared (engine/src/admin/auth.ts, the tokenRateLimited branch), so it says nothing about the
      // caller's session. It used to answer 401 and this console signed the operator out on it: a throttled
      // approvals poll ended a session in the middle of a restore. The engine answers 429 for it now
      // (engine/src/admin/router.ts, the verdict.throttled branch), and this branch is the console half of
      // that pair. It is NOT an ordering nicety: leaving a 429 to fall through to the generic branch below
      // paints correctly by accident, and nothing then stops a future widening of isUnauthorised from
      // silently restoring the sign-out.
      //
      // The backoff is the load-bearing part. The poll below re-checks every APPROVAL_POLL_MS (5s) while the
      // gate is unarmed, and the engine's throttle window is a minute, so an unpaced poll spends that minute
      // re-tripping the limiter it is waiting out: the throttle becomes self-sustaining and the gate can
      // never arm. Honouring the engine's own Retry-After (capped by rateLimitDelayMs, the same helper the
      // bulk loops pace by) lets the window actually drain.
      if (isRateLimited(err)) {
        pollPausedUntil = Date.now() + rateLimitDelayMs(err);
        showUnarmed();
        return false;
      }
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE. This branch used to return without painting anything, and that is the
        // only path through this function that leaves approvalHost holding the SYNCHRONOUS "Checking
        // whether this plan has an approval" placeholder it was seeded with. The host is only ever
        // replaced asynchronously, so on this path it is never replaced at all: the operator sits on
        // "Checking..." forever, and neither .restore-confirm__unarmed nor .restore-confirm__armed exists
        // for anything (a person or a test) to wait on.
        //
        // Reaching here now means a genuine 401, so the sign-out is the right answer: the throttle that used
        // to arrive as one is handled above. The paint stays regardless, because a session that ends while
        // the operator is mid-flow must still leave a readable screen behind it rather than a frozen one.
        showUnarmed();
        goSignedOut();
        return false;
      }
      // Not yet wired (or a transport fault): degrade to the request step honestly, never a
      // misleading enabled Apply. The request panel surfaces the pending dependency when the request
      // route is also absent.
      showUnarmed();
      return false;
    } finally {
      // Every exit from the try and the catch above passes through here, including the eight returns and
      // the ApprovalsReadTimeout rejection itself (whose own callback has already nulled the handle).
      if (readTimer !== null) {
        window.clearTimeout(readTimer);
        readTimer = null;
      }
    }
  };

  // A light poll while the gate is unarmed and the section is on-screen, so Apply lights up shortly
  // after a distinct approver signs without the operator pressing refresh. It stops as soon as the
  // gate arms or the section leaves the document.
  // The interval handle is now ALSO held in pollTimer, so `stop` can end the poll at once rather than at
  // its next tick. The tick's own three exits stay exactly as they were: they are the on-screen lifecycle,
  // and stop is the off-screen one.
  const startPoll = () => {
    if (stopped || polling) return;
    polling = true;
    const tick = window.setInterval(async () => {
      if (!section.isConnected) { window.clearInterval(tick); polling = false; return; }
      // Only poll while unarmed; once armed there is nothing to re-check.
      if (approvalHost.querySelector(".restore-confirm__armed")) { window.clearInterval(tick); polling = false; return; }
      // SKIP, do not stop, while the engine's Retry-After is still running. The gate must keep waiting for
      // an approver, so the poll is paced rather than cancelled: at 5s a tick against a minute-long throttle
      // window, an unpaced poll re-trips the limiter it is waiting out and the gate never arms.
      if (Date.now() < pollPausedUntil) return;
      const armed = await recheck();
      if (armed) { window.clearInterval(tick); polling = false; }
    }, APPROVAL_POLL_MS);
    pollTimer = tick;
  };

  // Kick off the first lookup WITHOUT blocking the plan paint: arm the gate (or fall back to the
  // request step) when it resolves, and start the light poll if it did not arm.
  void recheck().then((armedNow) => { if (!armedNow) startPoll(); });
  return stop;
}

// ApplyControlsCtx groups the renderApplyControls inputs into a single config object (the apply
// gate has more than four collaborators: the engine + plan + request + hash, the usable approval,
// the friction flags, the caller, the result host, and the stepper/reenter callbacks). The flags
// are the blast-radius signals that calibrate the confirm friction.
interface ApplyControlsCtx {
  engine: EngineClient;
  plan: RestorePlan;
  req: RestoreRequest;
  planHash: string | null;
  // NULL when the estate does not require a second approver (OrgPolicy.requireRestoreApproval, off by
  // default). There is then no approval record to bind to, expire or attribute, so the receipt names the
  // applier alone and nothing watches for a lapse. It is NOT a missing approval on an estate that wants
  // one: that case never reaches these controls, because the gate below only arms on a usable record.
  approval: RestoreApproval | null;
  flags: { highImpact: boolean; isLarge: boolean; isRedirect: boolean; isNonLatest: boolean; isCrossAccount: boolean; isCrossZone: boolean };
  me: ReturnType<typeof caller>;
  result: HTMLElement;
  paintStepper: (step: number) => void;
  reenter: (prefill: FlowPrefill) => void;
  // section is the whole "Confirm and apply" block this armed control lives in; a
  // successful apply uses it to collapse everything above the receipt (its own header/hash-cue/
  // approval verdict, and its ancestor plan card's impact/figures/destinations/skipped/integrity
  // content) so the receipt is the payoff reached in a short scroll, not buried under stale banners.
  section: HTMLElement;
  // opts: forwarded verbatim to the final engine.restore() apply call. See renderConfirm's header
  // comment for the full custody + dual-control reasoning.
  opts?: { restoreMasterB64?: string } | undefined;
}

// renderApplyControls draws the enabled danger Apply for an armed gate: the impact
// sentence, the Apply button with friction proportional to blast radius, and the apply
// click handler. The usable approval is threaded in so its distinct approver appears on
// the receipt and so the apply handler re-arms correctly on success.
function renderApplyControls(ctx: ApplyControlsCtx): HTMLElement {
  const { plan, req } = ctx;
  const wrap = h("div", { class: "restore-confirm__controls" });
  const oneSentence = impactSentence(plan, req);
  const applyBtn = h("button", { "data-busy-label": "Restoring", "data-dp": "restore-flow.button.apply#3", class: "btn btn--danger", type: "button" }, svgIcon(ICON_RESTORE, { size: 16 }), "Apply restore") as HTMLButtonElement;

  applyBtn.addEventListener("click", () => void applyRestore(ctx, applyBtn, oneSentence));

  wrap.appendChild(h("p", { class: "field__hint" }, oneSentence));
  wrap.appendChild(h("div", { class: "restore-confirm__apply" }, applyBtn));
  wrap.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-3)" }, "A fresh dry-run replaces this plan; change any input and review again before applying. A successful apply consumes the approval; a fresh apply needs a fresh request and approval."));
  return wrap;
}

// crossAccountConfirmTargets returns the DISTINCT foreign target accounts a
// cross-account restore would write into, sorted for a deterministic, reproducible match value.
// crossAccountWarnings carries one entry PER LEG (cf-config, media), and each leg's targetAccount is
// whatever accountId the request supplied for that leg, so a plan with a cf-config leg targeting one
// foreign account and a media leg targeting a DIFFERENT one has two warnings naming two accounts. This
// used to be read at [0] only, so typing the FIRST warning's account was enough to arm Apply, and
// applyRestore then stamped confirmDifferentAccountId onto EVERY cross-account leg regardless -- the
// second, untyped foreign account was confirmed to the engine on the strength of a gesture the operator
// never made toward it. Deduplicated because two legs can legitimately share one foreign target, in
// which case the operator still only has one account to type.
export function crossAccountConfirmTargets(warnings: ReadonlyArray<{ targetAccount: string }>): string[] {
  return [...new Set(warnings.map((w) => w.targetAccount))].sort();
}

// confirmApply runs the friction gate: a redirect / non-latest / large restore uses
// type-to-confirm; a small same-binding restore uses a single confirm modal. Returns the operator's
// decision.
async function confirmApply(ctx: ApplyControlsCtx, oneSentence: string): Promise<boolean> {
  const { plan, req, flags } = ctx;
  if (flags.isCrossAccount || flags.isCrossZone || flags.highImpact || flags.isLarge) {
    // CROSS-ACCOUNT is the strongest match: the operator must TYPE every DISTINCT
    // target Cloudflare account the plan would write into, proving they mean to write into each one.
    // A single account (the common case) types the same as before; two or more must be typed together,
    // joined by ", " in sorted order, so a deliberate gesture is required for each -- typing just one of
    // several can never satisfy the match. Otherwise a redirect matches the target binding name, and
    // everything else matches the run id.
    const crossAccountTargets = flags.isCrossAccount ? crossAccountConfirmTargets(plan.crossAccountWarnings ?? []) : [];
    const crossTarget = crossAccountTargets.length > 0 ? crossAccountTargets.join(", ") : null;
    // The ZONE target is the next strongest match after the account one. Account first because a wrong
    // account is the wider blast radius; a wrong zone is the more likely mistake but stays inside the
    // account the operator already chose.
    const zoneTarget = flags.isCrossZone ? (plan.crossZoneWarning?.targetZone ?? null) : null;
    const matchValue = crossTarget ?? zoneTarget ?? (flags.isRedirect && req.target?.binding ? req.target.binding : plan.runId);
    const matchLabel = crossTarget !== null
      ? crossAccountTargets.length > 1
        ? `all ${crossAccountTargets.length} target Cloudflare account ids, separated by commas`
        : "target Cloudflare account id"
      : zoneTarget !== null ? "target Cloudflare zone id" : flags.isRedirect && req.target?.binding ? "target binding name" : "run id";
    const extra: Node[] = [];
    if (flags.isCrossAccount) {
      extra.push(
        h(
          "p",
          { class: "field__hint" },
          crossAccountTargets.length > 1
            ? `This restore writes into ${crossAccountTargets.length} different Cloudflare accounts than the one the archive was captured from. Type all ${crossAccountTargets.length} target account ids, separated by commas, to confirm you mean to write into every one of them.`
            : "This restores into a different Cloudflare account than the one the archive was captured from. Type the target account id to confirm you mean to write there.",
        ),
      );
    }
    if (flags.isCrossZone) extra.push(h("p", { class: "field__hint" }, `This restores into a different Cloudflare zone than the one the archive was captured from, and would write ${plan.crossZoneWarning?.zoneSurfaces.length ?? 0} zone-scoped surface(s) there. Type the target zone id to confirm you mean to write there.`));
    if (flags.isNonLatest) extra.push(h("p", { class: "field__hint" }, "This is not the latest run; it restores older data over current data."));
    extra.push(h("p", { class: "field__hint" }, "A cancel stops further writes but does not undo records already written; the engine does not roll back."));
    // THE CEREMONY, named before the button rather than discovered after it. The apply is step-up gated
    // (the engine calls requireStepUp inside the confirm:true branch of POST /restore, before it reserves
    // the dual-control approval and before any byte is written), so the prompt opens AFTER the operator has
    // typed the match value and pressed Apply. Unannounced, at that moment, it reads as a fault mid-restore.
    extra.push(h("p", { class: "field__hint" }, "You may be asked to confirm with your own passkey before the restore starts. If you dismiss that prompt, or it fails, nothing is written and you can apply again from here."));
    return typeToConfirm({
      title: "Apply restore",
      impactSentence: oneSentence,
      extra,
      matchValue,
      matchLabel,
      confirmLabel: "Apply restore",
      busyLabel: "Restoring",
    });
  }
  return confirmModal({
    title: "Apply restore",
    body: h(
      "div",
      h("p", { style: "color:var(--text)" }, oneSentence),
      h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "A cancel stops further writes but does not undo records already written."),
      // The same claim as the type-to-confirm branch above. Both branches carry it because a customer only
      // ever sees ONE of them, and which one they see is decided by the size and shape of their own restore.
      h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "You may be asked to confirm with your own passkey before the restore starts. If you dismiss that prompt, or it fails, nothing is written and you can apply again from here."),
    ),
    confirmLabel: "Apply restore",
    variant: "danger",
    busyLabel: "Restoring",
  });
}

// applyRestore is the Apply click handler: it runs the friction gate, then POSTs the apply and
// renders the receipt (F2/F3, the maker != checker pair) or the honest failure verdict. A
// restore-unapproved race re-hides the stale Apply and prompts a re-check; any other fault stays
// an inline block error with Retry that genuinely re-runs the handler (the gate is still armed).
// markApplyOutcomeUnknown revises the two standing claims the plan card and the approval gate keep making
// once an apply has been sent and its outcome has become unknowable. Both are painted before the apply and
// neither has any reason of its own to be revised, so this is the one place that can retract them.
//
// It takes the DOM route rather than a callback for the same reason the success path already does: the
// receipt path reaches the ancestor plan card through `section.parentElement`, which is a live relationship
// renderPlan builds and never re-parents, so no new parameter has to be threaded through renderConfirm and
// renderApplyControls to reach either surface.
//
// WHAT IT RETRACTS, and only these two, because every other sentence on the card is still true:
//   - "Nothing has been written yet." Every copy is marked by plan.ts unwrittenNote, so all of them are
//     revised together and none is missed. It becomes a statement of the unknown, not a claim either way.
//   - "Approved and ready to apply." The approvals poll stops the moment the gate arms (startPoll), so
//     nothing re-reads the approval for the life of the tab, and the approval this apply carried may well
//     have been consumed by the very call whose answer never came back. Only the VERDICT BANNER is
//     rewritten; the apply controls beneath it stay, because a Retry that genuinely re-runs the apply is
//     still the right control once the operator has checked whether the first one landed. Removing the
//     control would drop the operator's route forward, which is a different defect, not a fix for this one.
function markApplyOutcomeUnknown(section: HTMLElement): void {
  const planCard = section.parentElement;
  for (const node of Array.from((planCard ?? section).querySelectorAll(`.${UNWRITTEN_MARK}`))) {
    node.textContent = "Whether anything has been written is now unknown: an apply was sent and its response did not arrive.";
  }
  const armed = section.querySelector(".restore-confirm__armed");
  const verdict = armed?.firstElementChild;
  if (armed && verdict) {
    armed.replaceChild(
      verdictSurface({
        tone: "warn",
        title: "This approval's state is now unknown",
        body: "The approval is single-use and is consumed on a successful apply. The apply that was just sent may have succeeded, so this console can no longer say whether this approval is still usable. It last re-read the approvals list before the apply was sent.",
      }),
      verdict,
    );
  }
}

async function applyRestore(ctx: ApplyControlsCtx, applyBtn: HTMLButtonElement, oneSentence: string): Promise<void> {
  const { engine, req, planHash, approval, me, result, paintStepper, reenter, section, opts } = ctx;
  paintStepper(4);
  const confirmed = await confirmApply(ctx, oneSentence);
  if (!confirmed) {
    // Cancelled at the confirm gate: the operator stays at the armed confirm step.
    paintStepper(4);
    return;
  }

  // F4 retry-subset: re-enter the FULL flow scoped to the failed record names. The names become
  // include selectors; the run and redirect target carry forward, but exclude/maxRecords drop
  // because the subset is now an explicit include list. A fresh dry-run yields a NEW plan hash, so
  // the subset correctly requires its own fresh approval (the prior one was consumed by the partial
  // apply). The names are selectors only (no value, no key); they are escaped wherever rendered.
  const retrySubset = (failedNames: string[]): void => {
    const include = failedNames.filter((n) => n !== "");
    if (include.length === 0) return;
    reenter({
      runId: req.runId,
      include,
      ...(req.target?.binding !== undefined && req.target.binding !== "" ? { targetBinding: req.target.binding } : {}),
      note: `Retrying ${groupNumber(include.length)} failed record${include.length === 1 ? "" : "s"} from run ${req.runId}. Review the re-scoped plan, then request a fresh approval and apply.`,
    });
  };

  // Change management (owner opt-in): applying a restore writes customer data back, a change-controlled
  // action. Collect a change reference when the policy requires one (a no-op otherwise); a cancel aborts the
  // apply without consuming the approval (it stays usable for a retry).
  const cr = await requireChange(engine, "Apply this restore", "restore-apply");
  if (!cr.proceed) return;

  paintStepper(5);
  applyBtn.dataset.busy = "true";
  applyBtn.textContent = "Restoring";
  applyBtn.disabled = true;
  // The apply is one un-streamed POST behind a busy button. After the slow-note threshold paint a
  // reassurance line into the result region so a large restore never reads as a hang. It does not fake
  // progress (the call is not streamed); it states honestly that a large run takes a while. Cancelled the
  // moment the call lands so a fast restore never flashes it, and the real outcome is painted over it.
  const cancelSlowNote = scheduleSlowNote(
    result,
    "Still restoring. A large run writes every record back in one pass, so this can take a while. Leave this tab open; the apply continues on the engine and the receipt appears when it finishes.",
  );
  // CROSS-ACCOUNT: the type-to-confirm gate above (confirmApply) already required the
  // operator to type EVERY distinct foreign target account crossAccountConfirmTargets found across all
  // legs, not just the first -- that is what makes it safe to stamp confirmDifferentAccountId onto each
  // cross-account leg here unconditionally, echoing that leg's own target account. Before this the gate only
  // demanded the FIRST warning's account, so a second leg targeting a DIFFERENT foreign account was stamped
  // here without the operator ever having typed it. A same-account leg is left untouched, so the common case
  // is unchanged. The engine still cross-checks the SIGNED origin, so this only unlocks a write the operator
  // has explicitly confirmed, never one to an account the archive did not come from without confirmation.
  const applyReq: RestoreRequest = { ...req, confirm: true };
  if (ctx.flags.isCrossAccount) {
    const legs = new Set((ctx.plan.crossAccountWarnings ?? []).map((w) => w.leg));
    if (legs.has("cf-config") && applyReq.cfConfig) applyReq.cfConfig = { ...applyReq.cfConfig, confirmDifferentAccountId: applyReq.cfConfig.accountId };
    if (legs.has("media") && applyReq.mediaRestore) applyReq.mediaRestore = { ...applyReq.mediaRestore, confirmDifferentAccountId: applyReq.mediaRestore.accountId };
  }
  // CROSS-ZONE: same shape, echoing the target zone. Stamped only when the dry-run flagged a PROVEN
  // mismatch, which is the only case the engine refuses; a warning with no recorded origin zone is shown
  // but never blocks, so confirming it would be asking the operator to approve something not being stopped.
  if (ctx.flags.isCrossZone && applyReq.cfConfig?.zoneId) {
    applyReq.cfConfig = { ...applyReq.cfConfig, confirmDifferentZoneId: applyReq.cfConfig.zoneId };
  }
  try {
    // opts carries the break-glass restore panel's browser-recovered per-run master (never present for
    // the standard operational-key flow, where opts is undefined and this call is byte-identical to before).
    // The engine threads it into the SAME runRestore open the dry-run preview already used
    // (engine/src/admin/router-restore.ts, unconditional on body.confirm), gated by the identical
    // capability check + dual-control reservation this whole function already runs above -- there is no
    // separate "break-glass apply" code path to keep in sync, only this one, now able to carry a master.
    const res = await engine.restore(applyReq, cr.change ?? undefined, opts);
    noteApplyOutcome(res);
    if (res.mode !== "applied") {
      result.replaceChildren(inlineOutcome({ heading: "Unexpected response", reason: "The engine did not return an apply result." }));
      return;
    }
    // The terminal step, ONE beyond the last real step (Receipt); restoreStepper reads any
    // current beyond RESTORE_STEP_COUNT as "every step done", so the stepper shows all six steps
    // ticked rather than stalling on step 6 forever (paintStepper never reaches the exact value
    // equal to the last step on the success path today).
    paintStepper(RESTORE_STEP_COUNT + 1);
    // The receipt carries the real applier and the DISTINCT approver (the checker from the
    // usable approval), so the durable receipt shows the maker != checker pair.
    result.replaceChildren(renderReceipt(res, me?.email ?? null, planHash, approval?.approvedBy ?? null, retrySubset));
    // After a successful apply the approval is consumed (single use); re-hide Apply so a second
    // click cannot re-fire against a consumed approval (re-arm).
    applyBtn.remove();
    // The receipt is the payoff. Collapse everything else in THIS section (its own
    // "Confirm and apply" header, the plan-hash cue and the now-consumed approval verdict) and
    // everything else in the ANCESTOR plan card (the impact banner, figures, resolved destinations,
    // skipped groups, the integrity line and its own heading), so a short scroll lands directly on
    // the receipt rather than a stack of superseded banners. DOM-only: nothing is removed (only
    // hidden via the CSSOM, per house style), so this never touches a tour anchor's presence.
    // section.parentElement is the plan card renderPlan built (card.appendChild(renderConfirm(...))),
    // reached via a live DOM relationship rather than a new parameter, since confirm.ts already has
    // `section` in scope and plan.ts never re-parents it.
    for (const child of Array.from(section.children)) {
      if (child !== result) (child as HTMLElement).style.setProperty("display", "none");
    }
    const planCard = section.parentElement;
    if (planCard) {
      for (const child of Array.from(planCard.children)) {
        if (child !== section) (child as HTMLElement).style.setProperty("display", "none");
      }
      // The outer plan card's own chrome (border/padding/background) is redundant once its only
      // visible content is the receipt (which carries its own full card styling); dropping it stops
      // the receipt reading as "a card nested inside another card".
      planCard.classList.add("restore-plan--collapsed");
    }
  } catch (err) {
    // The apply POST did not come back, so this attempt fired and the console cannot say whether the
    // engine wrote anything. Recorded BEFORE the sign-out branch, because a session that lapsed mid-apply is
    // exactly the case where the operator retries and support must count the attempts.
    noteApplyNotSent();
    if (isUnauthorised(err)) return goSignedOut();
    // Distinguish the engine's two 403s (lib/errors.ts): a ROLE denial ("forbidden") is a
    // capability gate, but "restore not approved" means this exact plan now lacks a usable
    // approval (a distinct approver, maker != checker) -> render an INLINE awaiting-approval
    // verdict with a link to the inbox, NOT the capability-gate copy. With the gate above this is
    // a race (the approval was consumed/rejected/expired between arming and apply), so this also
    // re-hides this stale Apply and prompts a re-check. Any other transport/auth fault stays the
    // inline block error with Retry.
    const kind = classifyError(err, { origin: location.origin });
    if (kind.kind === "restore-unapproved") {
      paintStepper(3);
      applyBtn.remove();
      // SIX CAUSES ARRIVE HERE AS ONE BYTE-IDENTICAL 403, AND THE OLD SENTENCE WAS WRONG FOR THREE OF THEM.
      // engine/src/admin/approvals.ts classifyRestoreApplyRefusal tells `expired`, `consumed`,
      // `applying-lease`, `pending`, `self-approval` and `missing-approver` apart as a closed enum, and
      // engine/src/admin/router-restore.ts flattens every one of them into { error: "restore not
      // approved", planHash }. This console therefore CANNOT say which, and the previous copy picked one
      // and asserted it: "a distinct approver must sign this exact plan".
      //
      // For a CONSUMED approval that is an instruction to run the same restore a second time, and a
      // consumed approval is exactly what an apply whose response never came back tends to leave behind.
      // For an `applying-lease` the remedy is to WAIT, because one is running right now and a fresh
      // approval is refused anyway. For an EXPIRED one the plan itself must be re-run, and no amount of
      // signing revives it. So the sentence now says what is known (the engine refused this apply on the
      // approval), says plainly that the refusal does not distinguish these cases, and leads with the one
      // whose cost is a duplicate write. A could-not-check outranks a confident wrong remedy.
      const body = h("div", { style: "display:grid;gap:var(--space-2)" });
      body.appendChild(h("p", { style: "margin:0" }, "The engine refused this apply because this plan has no usable approval right now. It does not say which of several reasons applies, so check before you act."));
      const causes = h("ul", { style: "margin:0;padding-left:var(--space-4);display:grid;gap:var(--space-1)" });
      causes.appendChild(h("li", "The approval may have already been used, in which case this restore has already run and applying again would write the same records a second time. Check the run's restore history first."));
      causes.appendChild(h("li", "Another apply of this plan may be running right now, in which case the remedy is to wait rather than to raise anything."));
      causes.appendChild(h("li", "The approval may have expired, in which case it cannot be revived and the plan must be run again from the review step before a fresh request means anything."));
      causes.appendChild(h("li", "The approval may genuinely still be outstanding, in which case a distinct approver signing this exact plan is what unblocks it."));
      body.appendChild(causes);
      result.replaceChildren(
        verdictSurface({
          tone: "warn",
          title: "The engine refused this apply on the approval",
          body,
          action: { label: "Open the approvals inbox", onClick: () => navigate("/restore/approvals") },
        }),
      );
    } else {
      // A TRANSPORT FAULT ON THE APPLY IS THE ONE CALL ON THIS SCREEN WHOSE OUTCOME CANNOT BE KNOWN, and
      // this branch used to treat it as one whose outcome was known to be nothing. The comment it carried
      // said "the gate is still armed and the approval unconsumed, so Retry genuinely re-runs the apply
      // handler", and that is an assumption, not a fact: the engine is a Worker on the other side of a
      // socket and does not care whether the browser is still there. The apply can be received, its
      // records written and the approval consumed, all recorded server-side with monotonic instants,
      // before the socket is destroyed, and the screen would otherwise go on reading "Nothing
      // has been written yet" and "Approved and ready to apply" over both.
      //
      // blockError's own copy ("Check the engine is reachable on its custom domain and try again") is
      // exactly right for a READ and stays for every other call. It is kept here, under the honest
      // statement rather than instead of it, because a Retry that genuinely re-runs the apply is still the
      // right control once the operator has checked. What changes is that the screen no longer asserts the
      // two things it cannot know.
      paintStepper(4);
      markApplyOutcomeUnknown(section);
      const unknown = h("div", { style: "display:grid;gap:var(--space-3)" });
      unknown.appendChild(
        verdictSurface({
          tone: "warn",
          title: "This apply was sent and its outcome is unknown",
          body: APPLY_OUTCOME_UNKNOWN_NOTE,
          assertive: true,
        }),
      );
      unknown.appendChild(blockError(err, () => applyBtn.click(), { origin: location.origin }));
      result.replaceChildren(unknown);
    }
  } finally {
    // CON-3: stop the slow-note timer the moment the call lands (success or failure) so it never fires
    // after the real outcome has already been painted into the result region.
    cancelSlowNote();
    // Re-enable the button only when it is still in the DOM. The success path and the
    // restore-unapproved error path call applyBtn.remove() to prevent a second application
    // of a consumed approval; guarding here makes that intent explicit and avoids appearing
    // to restore a button that was deliberately removed.
    if (applyBtn.isConnected) {
      applyBtn.dataset.busy = "false";
      applyBtn.textContent = "Apply restore";
      applyBtn.disabled = false;
    }
  }
}

// renderRequestPanel raises a dual-control request bound to the dry-run plan, with a
// required reason-for-change recorded for the audit trail. This is the MANDATORY path to an
// apply (not an optional "second signer"): every apply needs a usable approval from a
// distinct approver (maker != checker), so an Approver/Owner with no approval yet, and any
// Operator+, raise the request here. It degrades honestly: if the engine has not wired the
// request route, the failure is shown as "design-complete, pending the engine", never faked.
// planHash is not a parameter: the engine recomputes it server-side from the forwarded request
// fields (recordName / cfConfig / target / include / exclude / maxRecords), so the panel does not
// need the precomputed value here.
function renderRequestPanel(engine: EngineClient, plan: RestorePlan, req: RestoreRequest, paintStepper: (step: number) => void): HTMLElement {
  const panel = h("div", { class: "card card--inset restore-request" });
  panel.appendChild(h("h3", { class: "drawer-section__title" }, "Dual control: request an approval"));
  // One load-bearing line only: the dual-control rule itself is already stated by the
  // banner above this panel on both paths, so restating it here was a duplicate notice.
  panel.appendChild(
    h("p", { class: "field__hint" }, "Approval is bound to this plan hash; a changed plan needs a fresh request."),
  );

  const reasonField = field({ id: "rs-reason", label: "Reason for change", required: true, kind: "textarea", placeholder: "Restoring after a bad migration", hint: "Recorded in the audit trail. Not a secret.", doc: { href: "https://docs.downpipes.io/recovery/dual-control" } });
  panel.appendChild(reasonField.el);

  const requestBtn = h("button", { "data-dp": "restore-flow.button.request#2", class: "btn btn--secondary", type: "button", style: "margin-top:var(--space-3)" }, "Request approval") as HTMLButtonElement;
  const outcome = h("div");
  requestBtn.addEventListener("click", async () => {
    if (!validateForm([reasonField])) return;
    requestBtn.dataset.busy = "true";
    requestBtn.disabled = true;
    try {
      // Build the request payload from the confirmed request fields, then attach the
      // blast-radius cues (isLatest / plannedWrites / bytes) from the dry-run plan so the
      // approver inbox shows the real plan figures, not fabricated zeros. Cues are
      // conditionally set: a cue is only attached when the plan carries a real value
      // (plan.ok is guaranteed by the time this panel is visible; see renderConfirm).
      const r: Parameters<EngineClient["requestRestore"]>[0] & {
        isLatest?: boolean;
        plannedWrites?: number;
        bytes?: number;
      } = { runId: req.runId, reason: reasonField.value() };
      if (req.target) r.target = req.target;
      if (req.include) r.include = req.include;
      if (req.exclude) r.exclude = req.exclude;
      if (req.maxRecords !== undefined) r.maxRecords = req.maxRecords;
      // recordName and cfConfig bind into the plan hash, so they MUST travel on the request or the
      // approval the engine mints carries a planHash that never matches the hash this screen shows the
      // operator (dropping them left a granular single-record or a cf-config restore
      // approvable in name only and the dual-control gate stuck permanently). Pass recordName verbatim,
      // and pass cfConfig as the account + optional zone ONLY: the Cloudflare token is NEVER forwarded
      // here and NEVER enters the hash (a secret must not transit or bind), matching how the requester
      // computes the mirror (helpers.ts restorePlanHash) and how the engine recomputes it server-side.
      if (req.recordName !== undefined) r.recordName = req.recordName;
      if (req.cfConfig) r.cfConfig = { accountId: req.cfConfig.accountId, ...(req.cfConfig.zoneId !== undefined ? { zoneId: req.cfConfig.zoneId } : {}) };
      // mediaRestore binds into the plan hash the same way (its account, never the token), so it MUST
      // also travel on the approval request or a media restore's approval carries a planHash that never
      // matches the hash this screen shows the operator -- the SAME failure class as
      // above, for the media-restore feature added alongside this fix. Account only; the media edit
      // token is NEVER forwarded here and NEVER enters the hash.
      if (req.mediaRestore) r.mediaRestore = { accountId: req.mediaRestore.accountId };
      // d1Tables binds into the plan hash the same way, so it MUST travel on the approval request too, or
      // the minted approval's planHash never matches the apply and the dual-control gate sticks. No secret
      // is involved (database + table names only), so it is forwarded verbatim.
      if (req.d1Tables) r.d1Tables = req.d1Tables;
      // Blast-radius cues: taken from the dry-run plan the screen already computed.
      // Only attached when the plan is ok (the cues come from a real run, not a failure
      // stub). Omitted rather than sent as 0/false when genuinely unknown.
      if (plan.ok) {
        r.isLatest = plan.isLatest;
        if (plan.plannedWrites > 0) r.plannedWrites = plan.plannedWrites;
        if (plan.bytes > 0) r.bytes = plan.bytes;
      }
      const record = await engine.requestRestore(r);
      // The approval WAIT is now the real current step (often the longest in the flow).
      paintStepper(3);
      // The next-step copy is capability-accurate: a requester who holds restore.apply (a Restore
      // operator, Approver or Owner) can apply once a DISTINCT approver signs (the confirm gate above
      // arms automatically), but a request-only Operator cannot apply at all (they lack restore.apply),
      // so they hand off entirely. Gated by the SAME capability the apply path uses, so a restore-
      // operator who raised this is told Apply unlocks above, never that they cannot apply.
      const requesterCanApply = canCap("restore.apply");
      outcome.replaceChildren(
        verdictSurface({
          tone: "info",
          title: "Awaiting approval",
          body: requesterCanApply
            ? `Request raised for run ${record.runId}. It is in the Approver inbox; an approver other than you must approve it. Once a distinct approver signs this exact plan, Apply unlocks above.`
            : `Request raised for run ${record.runId}. It is in the Approver inbox; a Restore operator, Approver or Owner must approve and apply it (you cannot apply, as that needs ${capabilityPhrase("restore.apply")}).`,
          action: { label: "Open the approvals inbox", onClick: () => navigate("/restore/approvals") },
        }),
      );
      toast({ message: "Restore approval requested" });
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      // Classify to distinguish a design-acknowledged degrade (404 or 501: the
      // request route is not yet wired on this engine build) from a genuine transport
      // fault (5xx or network) where the operator input should be preserved with a Retry.
      const kind = classifyError(err, { origin: location.origin });
      if (kind.kind === "server" && (kind.status === 404 || kind.status === 501)) {
        // The engine build predates restore approvals: an honest degrade in the user's
        // vocabulary (no internal milestone names or raw routes in the standing line;
        // the route detail stays in the interim disclosure for whoever updates the engine).
        outcome.replaceChildren(
          pendingEngineNote({
            what: "The approval request could not be recorded: this engine build does not support restore approvals yet.",
            dependsOn: "an engine update",
            interim: `The engine returned: ${err instanceof Error ? err.message : String(err)}. The request route (POST /admin/restore/request) is not on this engine build; update the engine to enable restore approvals.`,
          }),
        );
      } else {
        // 5xx or network: a block error with Retry so the operator's reason-for-change
        // is not lost on a transient fault (operator input is in the field, not the outcome).
        outcome.replaceChildren(blockError(err, () => { requestBtn.click(); }, { origin: location.origin }));
      }
    } finally {
      requestBtn.dataset.busy = "false";
      requestBtn.disabled = false;
    }
  });
  panel.appendChild(requestBtn);
  panel.appendChild(outcome);
  return panel;
}

// The receipt (IA screen 5, trust-closing) and its applied-result classifier now live in
// receipt.ts. restoreOutcome / RestoreOutcome / RestoreOutcomeKind are re-exported here so test
// and screen importers of this module are unchanged.
export { type RestoreOutcome, type RestoreOutcomeKind, restoreOutcome } from "./receipt.ts";
