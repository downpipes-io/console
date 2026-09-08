// The pending card: a RESUME SURFACE for a promoted-but-not-settled update (design/updates/UPDATE-UX-015-
// DESIGN.md s2). It renders ONLY when a genuinely unresumed update exists (updateControlState's "pending"
// kind, driven by updateState.pending), and it ALWAYS carries its own controls (the token field + the
// "Finish verifying / roll back" button) -- the 0.1.4 bug this design fixes: a recovery arm used to replace
// the card with prose that referenced controls it had itself just wiped. Never again: every arm below writes
// ONLY into the sibling progress region (`out`), never into `body` (this card's own controls), so the card's
// button and field are always exactly where the prose says they are.
//
// The settle attempt now goes through the SAME grace + retry budget as the orchestrated apply flow
// (update-retry.ts settleWithBudget/readRecordedStatusWithRetry/pollUntilDefinitive): a click here is the
// SAME underlying operation (finish verifying a promoted update) as the live flow's own settle phase, just
// entered later, so it gets the same resilience fix and the same first-class outcome renderings (design s5:
// applied / applied-confirmation-pending / rolled-back / expired-cleared / genuinely-unknown).
//
// House rules: Australian English, no em dashes, precise claims.

import type { EngineClient, RampSettleResult, SettleResult } from "../../api.ts";
import { SESSION_ENDED_ACTION } from "../../components/error-view.ts";
import { banner } from "../../components/feedback.ts";
import { field, validateForm } from "../../components/field.ts";
import { toast } from "../../components/toast.ts";
import { h } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { capGateReason, refuseWithReason } from "../common.ts";
import { rampAppliedLine, rampInconclusiveLine, rampPendingBanner, rampStillSplitLine } from "./ramp-copy.ts";
import {
  recordedSettleOutcome,
  recordedSettleOutcomeLine,
  renderUpdateSteps,
  SETTLE_UNCONFIRMED_LINE,
  settleQueuedForSecondOwnerLine,
  UPDATE_MANAGE_CAP,
  type UpdateBodyEnv,
} from "./shared.ts";
import { STAGE_PROVING, STAGE_PROVING_SUBLINE } from "./update-outcome-copy.ts";
import { terminalLineForOutcome } from "./update-outcome-render.ts";
import { buildProgressRegion } from "./update-progress.ts";
import { pollUntilDefinitive, type RetryHooks, rampSettleWithBudget, readRecordedStatusWithRetry, type SettleLadderOutcome, settleWithBudget } from "./update-retry.ts";

// pendingUpdateBody builds the calm "verification pending for vX" resume surface for a promoted-but-not-
// settled update (the page was closed between promote and settle, etc.). It re-collects the one-shot token
// and finishes the verification (keep or roll back), and notes the hourly canary will also verify it. The
// token is held ONLY in the local `token` for the settle call. Owner-gated; the engine enforces. `hooks` is
// the injectable retry-timing seam for the validators ONLY (production callers omit it and get the real s2
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
  // pending, POST /update/ramp/settle refuses a plain one. This card used to send EVERY pending to the plain
  // settle, so a customer who started a gradual ramp had no control anywhere in the console that could finish
  // it, and customers never run a terminal. The discriminator is read here, ONCE, and it drives the banner
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
  body.appendChild(
    banner({
      tone: "info",
      message:
        ramp === null
          ? `Verification is pending for ${state.toVersion}: it is deployed and live, but its canary check did not finish (for example, this page was closed mid-update). Finish it now, verify and keep it, or roll back in one click. If you leave it, the hourly canary keeps checking ${state.toVersion}; if it is unhealthy you will get a critical alert to roll back (the engine will not silently auto-deploy a rollback).`
          : rampPendingBanner(state.toVersion, ramp),
    }),
  );

  const tokenField = field({
    id: "update-settle-token",
    label: "One-shot deploy token",
    type: "password",
    placeholder: "Paste your Cloudflare API token",
    hint: "The same kind of Cloudflare API token (\"Edit Cloudflare Workers\"), needed so the engine can roll back if the new version does not pass. If your engine binds a Secrets Store secret as a backup source, add Secrets Store edit to the token as well: the template predates Secrets Store, and the upload-version step refuses without it. Used once and discarded; never stored.",
    doc: { href: "https://docs.downpipes.io/operations/update-channel-applying", anchor: "what-the-operator-does" },
    autocomplete: "off",
    validate: (v) => (v.length >= 1 ? null : "Paste the deploy token to verify or roll back."),
  });
  body.appendChild(tokenField.el);

  // BUTTON COPY (design s2: plain language, no engine jargon in the resting label either): "Finish verifying
  // / roll back", not the old "Verify now / roll back" (settle/verify-then-canary is an implementation
  // detail; "finish" names the operator's actual situation, a resume, not a fresh action).
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
    await doRampSettleNow(engine, { toVersion: state.toVersion, percentage: state.percentage }, { region, isLive, reload, restoreFocus, reenable }, token, hooks);
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
    region.setTerminal(terminalLineForOutcome(outcome));

    if (outcome.kind === "applied") {
      toast({ message: outcome.toVersion ? `Verified, ${outcome.toVersion} is live.` : "Verified; the update is live." });
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
        region.setTerminal(terminalLineForOutcome(polledOutcome));
        if (polledOutcome.kind === "applied") toast({ message: polledOutcome.toVersion ? `Verified, ${polledOutcome.toVersion} is live.` : "Verified; the update is live." });
        else if (polledOutcome.kind === "rolled-back") toast({ message: "Rolled back; nothing was lost.", tone: "info" });
        reload();
        restoreFocus();
      },
      hooks,
    );
    reenable();
    return;
  }

  // A DEFINITIVE settle response arrived within the budget.
  region.detail(renderUpdateSteps(settle.steps));
  const dropped = settle.outcome === "applied" ? (settle.droppedSources ?? []) : [];
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
    toast({ message: `${state.toVersion} is live, but the update dropped ${dropped.length} source binding${dropped.length === 1 ? "" : "s"}; re-attach ${dropped.length === 1 ? "it" : "them"} on the Sources screen.`, tone: "warn", durationMs: 0 });
  } else if (settle.outcome === "applied") {
    toast({ message: `Verified, ${settle.toVersion} is live.` });
  } else {
    toast({ message: `Rolled back to ${settle.fromVersion}; nothing was lost.`, tone: "info" });
  }
  region.setTerminal(
    settle.outcome === "applied"
      ? terminalLineForOutcome({ kind: "applied", toVersion: settle.toVersion, confirmationPending: settle.confirmationPending === true })
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

// doRampSettleNow finishes a GRADUAL RAMP's pending through POST /admin/update/ramp/settle, the route the
// console had no client for. It is the ramp's own renderer because the ramp settle's outcomes are not the
// atomic settle's:
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
async function doRampSettleNow(engine: EngineClient, state: { toVersion: string; percentage: number }, r: RampSettleRender, token: string, hooks: RetryHooks): Promise<void> {
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
      r.region.setTerminal(rampInconclusiveLine(state.toVersion));
      toast({ message: `Nothing was decided: the checks did not reach ${state.toVersion}. Verify again.`, tone: "info" });
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
    r.region.setTerminal(terminalLineForOutcome(outcome));
    if (outcome.kind === "applied" || outcome.kind === "rolled-back" || outcome.kind === "expired-cleared") {
      if (outcome.kind === "applied") toast({ message: outcome.toVersion ? `Verified, ${outcome.toVersion} is live.` : "Verified; the update is live." });
      if (outcome.kind === "rolled-back") toast({ message: "Rolled back; nothing was lost.", tone: "info" });
      r.reload();
      r.restoreFocus();
      return;
    }
    pollUntilDefinitive(
      engine,
      r.isLive,
      (polledOutcome) => {
        r.region.setTerminal(terminalLineForOutcome(polledOutcome));
        if (polledOutcome.kind === "applied") toast({ message: polledOutcome.toVersion ? `Verified, ${polledOutcome.toVersion} is live.` : "Verified; the update is live." });
        else if (polledOutcome.kind === "rolled-back") toast({ message: "Rolled back; nothing was lost.", tone: "info" });
        r.reload();
        r.restoreFocus();
      },
      hooks,
    );
    r.reenable();
    return;
  }

  r.region.detail(renderUpdateSteps(settle.steps));
  if (settle.outcome === "rollback-failed-still-split") {
    r.region.append(banner({ tone: "danger", message: rampStillSplitLine(settle.fromVersion, settle.toVersion) }));
    r.region.setTerminal(rampStillSplitLine(settle.fromVersion, settle.toVersion));
    toast({ message: `${settle.toVersion} failed and the rollback failed: live traffic is still reaching it. Re-deploy ${settle.fromVersion} from the Cloudflare dashboard.`, tone: "warn", durationMs: 0 });
    r.reenable();
    r.reload();
    r.restoreFocus();
    return;
  }
  if (settle.outcome === "applied") {
    r.region.setTerminal(rampAppliedLine(settle.toVersion, state.percentage));
    toast({ message: `Verified: ${settle.toVersion} is trusted and stays at ${state.percentage}% of live traffic.` });
  } else {
    r.region.setTerminal(terminalLineForOutcome({ kind: "rolled-back", fromVersion: settle.fromVersion, toVersion: settle.toVersion, reason: settle.reason ?? null }));
    toast({ message: `Rolled back to ${settle.fromVersion}; nothing was lost.`, tone: "info" });
  }
  r.reload();
  r.restoreFocus();
}
