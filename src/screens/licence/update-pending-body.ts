// The pending card: a RESUME SURFACE for a promoted-but-not-settled update. It renders ONLY when a
// genuinely unresumed update exists (updateControlState's "pending" kind, driven by updateState.pending),
// and it ALWAYS carries its own controls (the token field + the "Finish verifying / roll back" button):
// every arm below writes ONLY into the sibling progress region (`out`), never into `body` (this card's own
// controls), so a recovery arm can never replace the card with prose that references controls it has itself
// just wiped, and the card's button and field are always exactly where the prose says they are.
//
// The settle attempt goes through the SAME grace + retry budget as the orchestrated apply flow
// (update-retry.ts settleWithBudget/readRecordedStatusWithRetry/pollUntilDefinitive): a click here is the
// SAME underlying operation (finish verifying a promoted update) as the live flow's own settle phase, just
// entered later, so it gets the same resilience and the same first-class outcome renderings: applied /
// applied-confirmation-pending / rolled-back / expired-cleared / genuinely-unknown.

import type { EngineClient, RampSettleResult, SettleResult } from "../../api.ts";
import { SESSION_ENDED_ACTION } from "../../components/error-view.ts";
import { banner } from "../../components/feedback.ts";
import { field, validateForm } from "../../components/field.ts";
import { toast } from "../../components/toast.ts";
import { h } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { capGateReason, refuseWithReason } from "../common.ts";
import { cfDashboardRedeployTarget, rampAppliedLine, rampInconclusiveLine, rampPendingBanner, rampStillSplitLine } from "./ramp-copy.ts";
import {
  recordedSettleOutcome,
  recordedSettleOutcomeLine,
  renderUpdateSteps,
  SETTLE_UNCONFIRMED_LINE,
  settleQueuedForSecondOwnerLine,
  UPDATE_MANAGE_CAP,
  validReleaseVersion,
  type RecordedSettleOutcome,
  type UpdateBodyEnv,
} from "./shared.ts";
import { STAGE_PROVING, STAGE_PROVING_SUBLINE, STALL_EXHAUSTED_LINE, STALL_INCONCLUSIVE_LINE } from "./update-outcome-copy.ts";
import { terminalLineForOutcome } from "./update-outcome-render.ts";
import { buildProgressRegion } from "./update-progress.ts";
import { pollUntilDefinitive, type RetryHooks, rampSettleWithBudget, readRecordedStatusWithRetry, type SettleLadderOutcome, settleWithBudget } from "./update-retry.ts";

// terminalLineForDisplay mirrors update-apply-flow.ts's own helper: for the three kinds whose sentence names
// a version (applied / applied-unconfirmed / rollback-failed), it swaps in the outcome's already-validated
// recommendedVersion before handing the record to the shared bridge, so the atomic path's recovered-status
// and stall-poll arms below never render the outcome's raw toVersion/onVersion (the Cloudflare deploy id).
// rollback-failed's target has no plain-version counterpart anywhere on the wire, so it is always dropped
// here. Every other kind passes through unchanged. The ramp settle's own recovery/poll arms (doRampSettleNow)
// share this same shape and use it too.
function terminalLineForDisplay(o: RecordedSettleOutcome): string {
  if (o.kind === "applied" || o.kind === "applied-unconfirmed") {
    return terminalLineForOutcome({ ...o, toVersion: o.recommendedVersion ?? null });
  }
  if (o.kind === "rollback-failed") {
    return terminalLineForOutcome({ ...o, onVersion: o.recommendedVersion ?? null, target: null });
  }
  return terminalLineForOutcome(o);
}

// pendingUpdateBody builds the calm "verification pending for vX" resume surface for a promoted-but-not-
// settled update (the page was closed between promote and settle, etc.). It re-collects the one-shot token
// and finishes the verification (keep or roll back), and notes the hourly canary will also verify it. The
// token is held ONLY in the local `token` for the settle call. Owner-gated; the engine enforces. `hooks` is
// the injectable retry-timing seam for the validators ONLY (production callers omit it and get the real
// numbers).
export function pendingUpdateBody(
  engine: EngineClient,
  state: { kind: "pending"; toVersion: string; recommendedVersion: string; percentage?: number },
  env: UpdateBodyEnv,
  hooks: RetryHooks = {},
): HTMLElement {
  const { out, reload, restoreFocus, canManage } = env;
  const body = h("div");
  // THE RAMP SHAPE IS THE ROUTE. A pending carrying a `percentage` came from the opt-in gradual ramp, and the
  // engine settles the two shapes on two mutually exclusive routes: POST /update/settle REFUSES a ramp-shaped
  // pending, POST /update/ramp/settle refuses a plain one. Sending every pending to the plain settle would
  // leave a customer who started a gradual ramp with no control anywhere in the console that could finish it,
  // and customers never run a terminal. The discriminator is read here, ONCE, and it drives the banner
  // copy, the button's resting label, and which client the button ends up calling.
  const ramp = typeof state.percentage === "number" ? state.percentage : null;
  const isRamp = ramp !== null;

  // The calm pending banner: a new version was deployed but its canary verification did not complete. This is
  // not a fault, it just needs finishing. The hourly canary keeps watching the live version; if it turns out
  // unhealthy it raises a critical alert so you can roll back in one click (it does not silently auto-deploy a
  // rollback, that needs your explicit one-click with a deploy token). A RAMPED pending gets its own sentence:
  // "deployed and live" is wrong for a ramp (the new version is serving a SHARE of traffic), and a ramp settle
  // can honestly decide nothing, which the operator has to be told BEFORE they press the button rather than
  // after.
  // state.toVersion is the Cloudflare deploy id; state.recommendedVersion (always present) is the plain
  // release version an operator recognises, so both banners name that instead, validated so a malformed or
  // absent field degrades to no version rather than a guess.
  const pendingVersion = validReleaseVersion(state.recommendedVersion);
  body.appendChild(
    banner({
      tone: "info",
      message:
        ramp === null
          ? pendingVersion
            ? `Verification is pending for ${pendingVersion}: it is deployed and live, but its canary check did not finish (for example, this page was closed mid-update). Finish it now, verify and keep it, or roll back in one click. If you leave it, the scheduled canary keeps checking ${pendingVersion}; if it is unhealthy you will get a critical alert to roll back (the engine will not silently auto-deploy a rollback).`
            : "Verification is pending: it is deployed and live, but its canary check did not finish (for example, this page was closed mid-update). Finish it now, verify and keep it, or roll back in one click. If you leave it, the scheduled canary keeps checking it; if it is unhealthy you will get a critical alert to roll back (the engine will not silently auto-deploy a rollback)."
          : rampPendingBanner(pendingVersion, ramp),
    }),
  );

  const tokenField = field({
    id: "update-settle-token",
    label: "One-shot deploy token",
    type: "password",
    placeholder: "Paste your Cloudflare API token",
    hint: "The same kind of Cloudflare API token (\"Edit Cloudflare Workers\"). If your engine binds a Secrets Store secret as a backup source, add Secrets Store edit to the token as well: the upload-version step refuses without it. Used once and discarded; never stored.",
    doc: { href: "https://docs.downpipes.io/operations/update-channel-applying", anchor: "what-the-operator-does" },
    autocomplete: "off",
    validate: (v) => (v.length >= 1 ? null : "Paste the deploy token to verify or roll back."),
  });
  body.appendChild(tokenField.el);

  // BUTTON COPY: plain language, no engine jargon in the resting label either. "Finish verifying / roll
  // back" rather than "Verify now / roll back": settle/verify-then-canary is an implementation detail,
  // and "finish" names the operator's actual situation, a resume, not a fresh action.
  const RESTING_LABEL = isRamp ? "Verify the ramp / roll back" : "Finish verifying / roll back";
  const verifyBtn = h(
    "button",
    { "data-busy-label": "Verifying", "data-dp": "licence.button.verify", class: "btn btn--primary btn--sm", type: "button", style: "margin-top:var(--space-3)" },
    RESTING_LABEL,
  ) as HTMLButtonElement;

  // isLive: the background stall poll's guard, exactly like the live apply flow's -- true while `out` still
  // hosts THIS attempt's region, false once a reload()/navigation (or a fresh click starting a NEW region)
  // has moved on, so a slow-resolving earlier poll can never clobber a later render.
  function settleNow(): Promise<void> {
    // A ramp pending settles on the RAMP settle route; the atomic settle would refuse it (and the refusal would
    // read as a fault to the operator, when the fix is simply the other endpoint). The fork lives INSIDE
    // doSettleNow, at the point where the progress region and the retry hooks exist: the ramp renderer needs
    // both, and hoisting the fork up here would mean building them twice.
    return doSettleNow(engine, state, out, tokenField, verifyBtn, canManage, reload, restoreFocus, hooks, RESTING_LABEL);
  }

  if (canManage) verifyBtn.addEventListener("click", () => void settleNow());
  else refuseWithReason(verifyBtn, capGateReason(UPDATE_MANAGE_CAP));
  body.appendChild(verifyBtn);
  return body;
}

// doSettleNow is the click handler's body, factored out so pendingUpdateBody stays under the file's
// complexity budget. It NEVER touches `body`/the token field/the button beyond disabling/relabelling it (the
// resume-surface invariant): every outcome renders into `out`, the sibling region, via a fresh progress
// region exactly like the live apply flow's.
async function doSettleNow(
  engine: EngineClient,
  state: { toVersion: string; recommendedVersion: string; percentage?: number },
  out: HTMLElement,
  tokenField: ReturnType<typeof field>,
  verifyBtn: HTMLButtonElement,
  canManage: boolean,
  reload: () => void,
  restoreFocus: () => void,
  hooks: RetryHooks,
  restingLabel: string,
): Promise<void> {
  if (!validateForm([tokenField])) return;
  // One-shot token, held ONLY for this settle call (either settle route: both spend it in the request body to
  // the in-account engine and neither stores it).
  const token = tokenField.value();
  verifyBtn.disabled = true;
  verifyBtn.textContent = "Verifying";

  const region = buildProgressRegion();
  out.replaceChildren(region.root);
  region.setStage(STAGE_PROVING, STAGE_PROVING_SUBLINE);
  const isLive = (): boolean => out.isConnected && out.contains(region.root);

  const reenable = (): void => {
    verifyBtn.disabled = !canManage;
    verifyBtn.textContent = restingLabel;
  };

  // THE FORK. A ramp-shaped pending (the engine recorded a live traffic `percentage` on it) can ONLY be
  // settled by POST /update/ramp/settle: the plain settle below refuses it outright. Everything after this
  // point in the plain path assumes an atomic settle's outcomes, so the ramp gets its own renderer rather than
  // being squeezed through a mapping that has no word for "inconclusive" or "still split".
  if (typeof state.percentage === "number") {
    await doRampSettleNow(engine, { toVersion: state.toVersion, recommendedVersion: state.recommendedVersion, percentage: state.percentage }, { region, isLive, reload, restoreFocus, reenable }, token, hooks);
    return;
  }

  let settle: SettleResult | null = null;
  let run: SettleLadderOutcome = { kind: "unresolved" };
  try {
    run = await settleWithBudget(engine, token, undefined, hooks);
  } catch (err) {
    if (isUnauthorised(err)) {
      // PAINT FIRST, THEN LEAVE. reenable() restores the button from "Verifying" and the progress region
      // gets a terminal line, so the settle does not sit on a proving stage that has stopped.
      reenable();
      region.setTerminal(SESSION_ENDED_ACTION);
      return goSignedOut();
    }
    run = { kind: "unresolved" };
  }
  // DUAL CONTROL, the SETTLE half: keeping a migration/breaking release takes a second owner's approval,
  // so the engine answers this settle with a 202 and finalises nothing. It is a real, readable answer, not
  // the unread state the `settle === null` recovery below reports, and the pending stays exactly where it is
  // until a second owner approves. reenable() restores the button so the operator can come back and finish
  // after the approval without reloading the screen.
  if (run.kind === "queued") {
    reenable();
    region.setTerminal(settleQueuedForSecondOwnerLine());
    restoreFocus();
    return;
  }
  settle = run.kind === "settled" ? run.settle : null;

  if (settle === null) {
    // PERSISTENCE-FIRST RECOVERY, with its own bounded retry (never a single shot): the settle response can
    // lose a race against the engine's own auto-rollback deploy, so re-read the PERSISTED record and render
    // what it says, never the failure itself.
    region.detail(h("p", { style: "color:var(--text)" }, SETTLE_UNCONFIRMED_LINE));
    const recorded = await readRecordedStatusWithRetry(engine, hooks);
    const outcome = recordedSettleOutcome(recorded);
    region.detail(h("p", { style: "color:var(--text)" }, recordedSettleOutcomeLine(outcome)));
    region.setTerminal(run.kind === "unresolved" && run.inconclusive === true && outcome.kind === "pending" ? STALL_INCONCLUSIVE_LINE : terminalLineForDisplay(outcome));

    if (outcome.kind === "applied") {
      const version = outcome.recommendedVersion ?? null;
      toast({ message: version ? `Verified, ${version} is live.` : "Verified; the update is live." });
      reload();
      restoreFocus();
      return;
    }
    if (outcome.kind === "rolled-back") {
      toast({ message: "Rolled back; nothing was lost.", tone: "info" });
      reload();
      restoreFocus();
      return;
    }
    if (outcome.kind === "expired-cleared") {
      reload();
      restoreFocus();
      return;
    }
    // pending / unknown: the whole client retry budget is spent -- the honest stall state, which keeps
    // checking by itself (no further click required); re-enable the button regardless, so the operator CAN
    // try again sooner if they want to, though nothing here needs it.
    pollUntilDefinitive(
      engine,
      isLive,
      (polledOutcome) => {
        region.setTerminal(terminalLineForDisplay(polledOutcome));
        if (polledOutcome.kind === "applied") {
          const version = polledOutcome.recommendedVersion ?? null;
          toast({ message: version ? `Verified, ${version} is live.` : "Verified; the update is live." });
        } else if (polledOutcome.kind === "rolled-back") toast({ message: "Rolled back; nothing was lost.", tone: "info" });
        reload();
        restoreFocus();
      },
      () => region.setTerminal(STALL_EXHAUSTED_LINE),
      hooks,
      { token },
    );
    reenable();
    return;
  }

  // A DEFINITIVE settle response arrived within the budget.
  region.detail(renderUpdateSteps(settle.steps));
  // rollback-failed is definitive (update-retry.ts counts it): the automatic rollback deploy failed and the
  // failed build is still live. It must not reach the rolled-back toast and sentence below ("nothing was
  // lost"). The reload renders the urgent rollback control.
  if (settle.outcome === "rollback-failed") {
    // onVersion names the failed candidate: settle.toVersion is the Cloudflare deploy id, so the visible
    // terminal line reads settle.recommendedVersion (validated) instead. The rollback TARGET has no
    // plain-version counterpart anywhere on the wire, so target stays null here (never settle.fromVersion,
    // the id).
    region.setTerminal(terminalLineForOutcome({ kind: "rollback-failed", onVersion: validReleaseVersion(settle.recommendedVersion), target: null, reason: settle.reason ?? null }));
    reenable();
    reload();
    restoreFocus();
    return;
  }
  const dropped = settle.outcome === "applied" ? (settle.droppedSources ?? []) : [];
  // settle.recommendedVersion is the release's plain version (always present on a settle response), never
  // settle.toVersion/fromVersion, which are the Cloudflare deploy ids.
  const appliedVersion = validReleaseVersion(settle.recommendedVersion);
  if (dropped.length > 0) {
    // POST-UPDATE SOURCE VERIFICATION: the update kept, but the engine's pre/post binding diff found source
    // bindings it did not carry forward (it should not happen). Surface it LOUDLY with a direct re-attach
    // path rather than letting the operator discover it via a failed run later.
    region.append(
      banner({
        tone: "danger",
        message: `The update did not carry ${dropped.length} source binding${dropped.length === 1 ? "" : "s"} forward (${dropped.join(", ")}), so ${dropped.length === 1 ? "its" : "their"} next backups will fail. Re-attach ${dropped.length === 1 ? "it" : "them"} now with a one-shot deploy token.`,
        action: { label: "Re-attach sources", onClick: () => navigate("/sources") },
      }),
    );
    const lead = appliedVersion ? `${appliedVersion} is live` : "The update is live";
    toast({ message: `${lead}, but it dropped ${dropped.length} source binding${dropped.length === 1 ? "" : "s"}; re-attach ${dropped.length === 1 ? "it" : "them"} on the Sources screen.`, tone: "warn", durationMs: 0 });
  } else if (settle.outcome === "applied") {
    toast({ message: appliedVersion ? `Verified, ${appliedVersion} is live.` : "Verified; the update is live." });
  } else {
    toast({ message: "Rolled back; nothing was lost.", tone: "info" });
  }
  region.setTerminal(
    settle.outcome === "applied"
      ? terminalLineForOutcome({ kind: "applied", toVersion: appliedVersion, confirmationPending: settle.confirmationPending === true })
      : terminalLineForOutcome({ kind: "rolled-back", fromVersion: settle.fromVersion ?? null, toVersion: settle.toVersion ?? null, reason: settle.reason ?? null }),
  );
  reload();
  restoreFocus();
}

// RampSettleRender groups the render context doRampSettleNow writes into, so it stays a four-parameter
// function like the rest of this family. It writes ONLY into the progress region (the sibling of the card's
// own controls), never into the card, which is the resume-surface invariant this whole module exists to hold.
interface RampSettleRender {
  region: ReturnType<typeof buildProgressRegion>;
  isLive: () => boolean;
  reload: () => void;
  restoreFocus: () => void;
  reenable: () => void;
}

// doRampSettleNow finishes a GRADUAL RAMP's pending through POST /admin/update/ramp/settle. It is the ramp's
// own renderer because the ramp settle's outcomes are not the atomic settle's:
//
//   applied      the ramped version was verified ON ITS OWN CODE and STAYS at its percentage. It is not "live"
//                in the atomic sense and the copy does not say so: promoting to 100% is a separate act.
//   rolled-back  reverted to 100% prior. Nothing was lost. Same reassurance as the atomic path.
//   rollback-failed-still-split  the loudest state in the surface: it failed AND the rollback failed, so live
//                traffic is still reaching the suspect version. A danger banner, a sticky toast, and the
//                Cloudflare-side remedy. The button is re-enabled: a retry is a legitimate next move.
//   inconclusive the settle ran, landed on the prior version's slice, and decided NOTHING. The ramp is
//                UNCHANGED and the pending is still ARMED. This is the outcome the plain settle has no word
//                for, and it is the one that keeps the operator's own count honest: every one of these bumped
//                the engine's update-settle-inconclusive counter, so "we tried all night" is now legible in
//                the support pack instead of being byte-identical to "nobody touched it". It is NOT a fault,
//                so it never reloads the card out from under the operator and never renders the stall line.
//
// A total transport failure (the engine never answered) falls back to the SAME persistence-first recovery the
// atomic path uses: re-read the recorded record and render what the engine actually persisted.
async function doRampSettleNow(engine: EngineClient, state: { toVersion: string; recommendedVersion: string; percentage: number }, r: RampSettleRender, token: string, hooks: RetryHooks): Promise<void> {
  let run: { definitive: RampSettleResult | null; lastSeen: RampSettleResult | null };
  try {
    run = await rampSettleWithBudget(engine, token, hooks);
  } catch (err) {
    if (isUnauthorised(err)) return goSignedOut();
    run = { definitive: null, lastSeen: null };
  }

  const settle = run.definitive;
  if (settle === null) {
    if (run.lastSeen !== null) {
      // Every attempt came back INCONCLUSIVE from a healthy engine. Say the true thing, leave the card's
      // controls exactly where they are, and do NOT reload (nothing changed, and a reload would rebuild the
      // very card the operator is about to press again).
      r.region.detail(renderUpdateSteps(run.lastSeen.steps));
      // state.toVersion is the Cloudflare deploy id; state.recommendedVersion is the plain release version.
      const pendingVersion = validReleaseVersion(state.recommendedVersion);
      r.region.setTerminal(rampInconclusiveLine(pendingVersion));
      toast({ message: `Nothing was decided: the checks did not reach ${pendingVersion ?? "the ramped version"}. Verify again.`, tone: "info" });
      r.reenable();
      return;
    }
    // The engine never answered at all. Identical persistence-first recovery to the atomic path: the settle
    // response can lose a race against the engine's own rollback deploy, so re-read the PERSISTED record and
    // render what it says, never the failure itself.
    r.region.detail(h("p", { style: "color:var(--text)" }, SETTLE_UNCONFIRMED_LINE));
    const recorded = await readRecordedStatusWithRetry(engine, hooks);
    const outcome = recordedSettleOutcome(recorded);
    r.region.detail(h("p", { style: "color:var(--text)" }, recordedSettleOutcomeLine(outcome)));
    r.region.setTerminal(terminalLineForDisplay(outcome));
    if (outcome.kind === "applied" || outcome.kind === "rolled-back" || outcome.kind === "expired-cleared") {
      if (outcome.kind === "applied") {
        const version = outcome.recommendedVersion ?? null;
        toast({ message: version ? `Verified, ${version} is live.` : "Verified; the update is live." });
      }
      if (outcome.kind === "rolled-back") toast({ message: "Rolled back; nothing was lost.", tone: "info" });
      r.reload();
      r.restoreFocus();
      return;
    }
    pollUntilDefinitive(
      engine,
      r.isLive,
      (polledOutcome) => {
        r.region.setTerminal(terminalLineForDisplay(polledOutcome));
        if (polledOutcome.kind === "applied") {
          const version = polledOutcome.recommendedVersion ?? null;
          toast({ message: version ? `Verified, ${version} is live.` : "Verified; the update is live." });
        } else if (polledOutcome.kind === "rolled-back") toast({ message: "Rolled back; nothing was lost.", tone: "info" });
        r.reload();
        r.restoreFocus();
      },
      () => r.region.setTerminal(STALL_EXHAUSTED_LINE),
      hooks,
    );
    r.reenable();
    return;
  }

  r.region.detail(renderUpdateSteps(settle.steps));
  // settle.toVersion/fromVersion are the Cloudflare deploy ids; settle.recommendedVersion (always present)
  // is the plain release version the ramp is verifying, so every sentence below names that instead. The ONE
  // exception is the redeploy instruction below: it sends the operator to the Cloudflare dashboard, which
  // lists versions by id, so settle.fromVersion (the prior version's own id) is named there, labelled and in
  // full (see cfDashboardRedeployTarget).
  const settledVersion = validReleaseVersion(settle.recommendedVersion);
  if (settle.outcome === "rollback-failed-still-split") {
    r.region.append(banner({ tone: "danger", message: rampStillSplitLine(settledVersion, settle.fromVersion) }));
    r.region.setTerminal(rampStillSplitLine(settledVersion, settle.fromVersion));
    toast({ message: `${settledVersion ?? "The ramped version"} failed and the rollback failed: live traffic is still reaching it. Re-deploy ${cfDashboardRedeployTarget(null, settle.fromVersion)} from the Cloudflare dashboard.`, tone: "warn", durationMs: 0 });
    r.reenable();
    r.reload();
    r.restoreFocus();
    return;
  }
  if (settle.outcome === "applied") {
    r.region.setTerminal(rampAppliedLine(settledVersion, state.percentage));
    toast({ message: settledVersion ? `Verified: ${settledVersion} is trusted and stays at ${state.percentage}% of live traffic.` : `Verified: the ramped version is trusted and stays at ${state.percentage}% of live traffic.` });
  } else {
    r.region.setTerminal(terminalLineForOutcome({ kind: "rolled-back", fromVersion: settle.fromVersion, toVersion: settle.toVersion, reason: settle.reason ?? null }));
    // settle.fromVersion is the Cloudflare deploy id, and nothing here carries the plain version traffic
    // returned to (recommendedVersion names the FAILED candidate, the opposite fact), so the toast states no
    // version rather than showing the id or guessing.
    toast({ message: "Rolled back; nothing was lost.", tone: "info" });
  }
  r.reload();
  r.restoreFocus();
}
