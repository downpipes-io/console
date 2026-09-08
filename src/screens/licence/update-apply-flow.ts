// The LIVE apply flow for the safe-apply update control (multi-component updates P5; reworked for the 0.1.5
// update-UX design, design/updates/UPDATE-UX-015-DESIGN.md s1/s2). ONE token paste + ONE click drives the
// WHOLE flow: verify -> deploy -> prove (settle, with a grace pause and a bounded retry ladder, never a
// single racy attempt) -> (console build check) -> exactly one of two terminal sentences, or the honest stall
// state that keeps checking by itself. NO user-facing refresh exists anywhere in this flow (design's core
// invariant): every deploy in it swaps a worker, so the naive next read races the swap window and used to
// fail on the very first try (root cause #1) -- update-retry.ts's settleWithBudget/readRecordedStatusWithRetry
// are the fix. The full step-by-step log (the "todays essay" the design calls out) renders into the collapsed
// Details disclosure (update-progress.ts); the visible line only ever shows the four s2 stage strings, the
// two terminal sentences, or the stall line.
//
// The legacy path (requested === null, an engine that advertised no components) is behaviour-identical in
// SHAPE to the pre-multi-component control: no components field on the wire, always the engine settle. Its
// COPY now goes through the same s2 progress/terminal machinery as every other path (the design does not
// carve out an exception for it).
//
// TOKEN CUSTODY (unchanged contract): the one-shot deploy token arrives as a parameter, lives only in this
// call's stack/closures for the apply -> settle -> (check/rollback) chain, and is never persisted, copied to
// an attribute, or echoed by the engine. House rules: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { toast } from "../../components/toast.ts";
import { banner } from "../../components/feedback.ts";
import { preloadOwnLazyChunks } from "../../lib/preload-chunks.ts";
import {
  renderUpdateSteps,
  queuedForSecondOwnerLine,
  settleQueuedForSecondOwnerLine,
  updateRefusalText,
  componentApplyResultLine,
  consoleOnlyApplyOutcome,
  consoleWasApplied,
  recordedSettleOutcome,
  recordedSettleOutcomeLine,
  SETTLE_UNCONFIRMED_LINE,
  type RecordedSettleOutcome,
} from "./shared.ts";
import { runConsoleBuildCheck } from "./update-console-check.ts";
import { buildProgressRegion, type ProgressRegion } from "./update-progress.ts";
import {
  settleWithBudget,
  readRecordedStatusWithRetry,
  pollUntilDefinitive,
  type RetryHooks,
  type SettleLadderOutcome,
} from "./update-retry.ts";
import { STAGE_CHECKING, STAGE_DEPLOYING_ENGINE, STAGE_PROVING, STAGE_PROVING_SUBLINE, STAGE_UPDATING_CONSOLE, DESTINATION_GATE_ENGINE_REASON } from "./update-outcome-copy.ts";
import { terminalLineForOutcome, destinationGateNode } from "./update-outcome-render.ts";
import type { ComponentApplyResult, EngineClient, SettleResult, UpdateComponentId } from "../../api.ts";

// ApplyFlowEnv is the shared render context: the calm progress/error region and the section reload + focus
// callbacks (the same UpdateBodyEnv fields the body builders use).
export interface ApplyFlowEnv {
  engine: EngineClient;
  out: HTMLElement;
  reload: () => void;
  restoreFocus: () => void;
}

// ApplyFlowHooks are injectable seams for the validators ONLY (drive the flow with no network and no real
// clock). It extends RetryHooks so the s2 grace/ladder/backoff/stall-poll numbers are all zeroable from the
// same object a caller already passes. Production callers pass nothing: the real chunk preloader, the real
// /__build.json fetcher and the real s2 timing all run.
export interface ApplyFlowHooks extends RetryHooks {
  preload?: () => Promise<boolean>;
  fetchServedVersion?: () => Promise<string | null>;
  pollDelayMs?: number;
  // reload / reloadDelayMs: the PAGE-reload seam the post-apply console check fires once it confirms the new
  // console is served (distinct from env.reload, which only re-renders the licence section). Validators inject
  // a counter + a zero delay; production omits them (the real location.reload after a short beat).
  reload?: () => void;
  reloadDelayMs?: number;
}

// recoverSettleConclusion is the persistence-first settle recovery (the settle-response race, seen live on
// the first 0.1.0 -> 0.1.2 apply): when the settle call throws or returns a non-definitive result, the
// response is NOT the truth, the engine's persisted record is. It replaces the settle heading with the
// no-claims interim line, re-reads GET /update/status WITH a bounded retry (design s1/s2: never a single
// shot), renders the RECORDED conclusion (applied / rolled-back with the engine's reason / expired-cleared /
// still pending / honestly unknown), and returns it so the caller decides toasts and reloads. It never throws
// (an exhausted re-read is the "unknown" conclusion). Shared by the pending-verification body
// (update-pending-body.ts); the live apply flow below uses the lower-level readRecordedStatusWithRetry
// directly against its own progress region instead of a bare heading.
export async function recoverSettleConclusion(engine: EngineClient, out: HTMLElement, heading: HTMLElement, hooks: RetryHooks = {}): Promise<RecordedSettleOutcome> {
  heading.textContent = SETTLE_UNCONFIRMED_LINE;
  const recorded = await readRecordedStatusWithRetry(engine, hooks);
  const outcome = recordedSettleOutcome(recorded);
  out.appendChild(h("p", { style: "color:var(--text);margin-top:var(--space-2)" }, recordedSettleOutcomeLine(outcome)));
  return outcome;
}

// renderComponentResults appends the per-component rows (plan rows on a preview, outcome rows on a live
// apply) when the engine sent them; silent otherwise (an old engine never sends them, so nothing new
// renders). Each row is the pure one-line summary plus that component's own step checklist when present.
export function renderComponentResults(out: HTMLElement, results: ComponentApplyResult[] | undefined): void {
  if (!Array.isArray(results) || results.length === 0) return;
  const list = h("ul", { class: "stack-sm", style: "list-style:none;padding-left:0;margin:var(--space-2) 0 0;display:flex;flex-direction:column;gap:var(--space-2)" });
  for (const r of results) {
    const item = h("li", h("p", { style: "color:var(--text);margin:0" }, componentApplyResultLine(r)));
    if (Array.isArray(r.steps) && r.steps.length > 0) item.appendChild(renderUpdateSteps(r.steps));
    list.appendChild(item);
  }
  out.appendChild(list);
}

// runConsoleCheckAndFinish runs the post-apply console build check into the region's VISIBLE area (its
// transient "checking" hint and, lastingly, its own actionable banner: a real Reload button on confirm, a
// real "Roll back console" button otherwise -- neither is jargon, both are exactly what the operator needs
// next, so neither hides behind Details), then sets the region's terminal sentence honestly: the reload
// suffix is added ONLY when the check actually confirmed the console is serving the new version.
async function runConsoleCheckAndFinish(
  region: ProgressRegion,
  engine: EngineClient,
  token: string,
  expectedConsoleVersion: string,
  toVersion: string | null,
  confirmationPending: boolean,
  hooks: ApplyFlowHooks,
): Promise<void> {
  region.setStage(STAGE_UPDATING_CONSOLE);
  const checkOut = h("div");
  region.append(checkOut);
  const confirmed = await runConsoleBuildCheck({
    engine,
    out: checkOut,
    token,
    expectedVersion: expectedConsoleVersion,
    ...(hooks.fetchServedVersion !== undefined ? { fetchServedVersion: hooks.fetchServedVersion } : {}),
    ...(hooks.pollDelayMs !== undefined ? { pollDelayMs: hooks.pollDelayMs } : {}),
    ...(hooks.reload !== undefined ? { reload: hooks.reload } : {}),
    ...(hooks.reloadDelayMs !== undefined ? { reloadDelayMs: hooks.reloadDelayMs } : {}),
  });
  region.setTerminal(appliedTerminalLineFor(toVersion, confirmationPending, confirmed));
}

// appliedTerminalLineFor is a tiny local wrapper so both call sites (the definitive-settle path and the
// recovered-status path) build the SAME s2 applied sentence the same way.
function appliedTerminalLineFor(toVersion: string | null, confirmationPending: boolean, consoleApplied: boolean): string {
  return terminalLineForOutcome({ kind: "applied", toVersion, confirmationPending }, { consoleApplied });
}

// runLiveApplyFlow runs one live apply end to end and renders every phase into env.out. `requested` is the
// component set to apply: null = the LEGACY engine-only apply (no components field on the wire; the path
// every deployed engine understands); a non-empty set = a component-aware apply against an engine that
// advertised components. expectedConsoleVersion is the channel's console version (needed by the post-apply
// build check); null when the console is not in play. Returns "queued" when dual control deferred the apply
// to a second owner (the caller keeps its button disabled), else "done".
export async function runLiveApplyFlow(
  env: ApplyFlowEnv,
  token: string,
  requested: UpdateComponentId[] | null,
  expectedConsoleVersion: string | null,
  hooks: ApplyFlowHooks = {},
): Promise<"queued" | "done"> {
  const { engine, out, reload, restoreFocus } = env;
  const includesConsole = requested?.includes("console") === true;
  const includesEngine = requested === null || requested.includes("engine");
  const componentsArg = requested !== null && requested.length > 0 ? requested : undefined;

  // PRELOAD before a console-including apply: the asset swap renames this build's lazy chunks, so import
  // them now while the old assets are still served; the running session then cannot 404 mid-flow. Failure
  // is swallowed inside the preloader (belt-and-braces, never a blocker).
  if (includesConsole) await (hooks.preload ?? preloadOwnLazyChunks)();

  // ONE progress region for the WHOLE flow (design s2: the card stays one interactive object). It is built
  // once and only ever MUTATED thereafter (setStage/setTerminal/detail/append), never replaced, so the
  // operator watches an in-place progress line, not a sequence of re-renders.
  const region = buildProgressRegion();
  out.replaceChildren(region.root);
  region.setStage(STAGE_CHECKING);
  if (includesEngine) region.setStage(STAGE_DEPLOYING_ENGINE);
  else if (includesConsole) region.setStage(STAGE_UPDATING_CONSOLE);

  // isLive: the background stall poll's guard (started only after this function has already returned "done"
  // to its caller) -- true while `out` still hosts THIS flow's region, false once a reload()/navigation has
  // swapped it out, mirroring the isConnected guard screens/common.ts's focusFirstField uses for the same
  // reason (never keep touching a detached subtree).
  const isLive = (): boolean => out.isConnected && out.contains(region.root);

  try {
    const applied = await engine.applyUpdate({
      token,
      dryRun: false,
      ...(componentsArg !== undefined ? { components: componentsArg } : {}),
    });
    // DUAL CONTROL: a migration/breaking apply under dual control is QUEUED for a second owner (202).
    // Nothing was deployed, surface the calm "queued for approval" message, not a deploy claim.
    if (applied.status === "queued") {
      region.setTerminal(queuedForSecondOwnerLine("apply"));
      return "queued";
    }
    const promote = applied.value;
    region.detail(h("p", { style: "color:var(--text)" }, promoteSummaryDetail(promote.outcome, promote.toVersion ?? promote.recommendedVersion, promote.fromVersion, promote.reason)));
    region.detail(renderUpdateSteps(promote.steps));
    if (Array.isArray(promote.componentResults) && promote.componentResults.length > 0) {
      const rows = h("div");
      renderComponentResults(rows, promote.componentResults);
      region.detail(rows);
    }

    if (promote.outcome === "refused") {
      // Refused BEFORE any change: the engine is unchanged. The destination gate (design s4) is the one
      // refusal with its OWN first-class rendering (a link to /destinations, not a generic error box); every
      // other refusal reason is shown calmly as the terminal line.
      if (promote.reason === DESTINATION_GATE_ENGINE_REASON) {
        out.replaceChildren(destinationGateNode());
        return "done";
      }
      region.setTerminal("The engine was left unchanged. You can correct the cause and try again.");
      return "done";
    }
    if (promote.outcome === "no-update") {
      toast({ message: "Already on the recommended version." });
      reload();
      restoreFocus();
      return "done";
    }

    // CONSOLE-ONLY apply (requested names "console" alone, no "engine"): the response above IS the
    // console's own already-terminal outcome (applyConsoleComponent verifies, uploads, promotes and
    // confirms-live in ONE request; there is no engine canary to settle, so nothing below this branch --
    // the two-phase engine settle -- ever runs for it). Live-confirmed defect: this used to fall straight
    // into the "promoted" check below, which a console-only response never satisfies (it carries the
    // console's OWN outcome string, "applied"/"applied-unconfirmed"/"rolled-back"/"rollback-failed", never
    // "promoted"), so a genuinely successful console-only apply rendered "An unexpected outcome was
    // returned" indefinitely while the console was already live and healthy.
    if (!includesEngine) {
      const outcome = consoleOnlyApplyOutcome(promote);
      if (outcome.kind === "applied" || outcome.kind === "applied-unconfirmed") {
        const confirmationPending = outcome.kind === "applied-unconfirmed";
        if (expectedConsoleVersion !== null) {
          await runConsoleCheckAndFinish(region, engine, token, expectedConsoleVersion, promote.toVersion ?? null, confirmationPending, hooks);
          return "done";
        }
        region.setTerminal(appliedTerminalLineFor(promote.toVersion ?? null, confirmationPending, false));
        toast({ message: promote.toVersion ? `Console updated to ${promote.toVersion}.` : "Console updated." });
        reload();
        restoreFocus();
        return "done";
      }
      if (outcome.kind === "rolled-back") {
        region.setTerminal(terminalLineForOutcome(outcome));
        toast({ message: "Rolled back; nothing was lost.", tone: "info" });
        reload();
        restoreFocus();
        return "done";
      }
      if (outcome.kind === "rollback-failed") {
        region.setTerminal(terminalLineForOutcome(outcome));
        return "done";
      }
      // "unknown": dryRun:false cannot return "dry-run"/"refused"/"no-update" this far down (all three are
      // handled above), and "promoted" is an engine-only string a console-only response never carries, so
      // reaching here means a genuinely new, unrecognised outcome string. Surfaced honestly, never claimed.
      region.setTerminal("An unexpected outcome was returned; the console state is unclear. Reload to check the current version.");
      return "done";
    }

    if (promote.outcome !== "promoted") {
      // dryRun:false cannot return "dry-run"; any other unexpected outcome is surfaced honestly without
      // claiming success.
      region.setTerminal("An unexpected outcome was returned; the engine state is unclear. Reload to check the current version.");
      return "done";
    }

    // PROMOTED. For an apply that includes the ENGINE: prove it (settle/canary-gate) with the SAME one-shot
    // token, now via the s2 grace + retry ladder (settleWithBudget) rather than a single racy attempt. A
    // console-only apply has no engine canary to fly (a static-assets promote is atomic; its gate is the
    // build check below), so settling is skipped entirely.
    let settle: SettleResult | null = null;
    if (includesEngine) {
      region.setStage(STAGE_PROVING, STAGE_PROVING_SUBLINE);
      let run: SettleLadderOutcome;
      try {
        run = await settleWithBudget(engine, token, componentsArg, hooks);
      } catch (err) {
        if (isUnauthorised(err)) {
          goSignedOut();
          return "done";
        }
        throw err;
      }
      // DUAL CONTROL, the SETTLE half: keeping a migration/breaking release takes a second owner's
      // approval, so the engine answers the settle with a 202 and finalises nothing. The promote already
      // happened, so this is NOT the apply's "nothing was deployed" state and must not borrow its copy. It is
      // also not the "outcome could not be read" state the unresolved branch below reports: before this
      // branch existed a queued settle burnt the whole retry budget and then landed there, telling the
      // operator the engine could not be read when it had answered clearly.
      if (run.kind === "queued") {
        region.setTerminal(settleQueuedForSecondOwnerLine());
        reload();
        restoreFocus();
        return "done";
      }
      settle = run.kind === "settled" ? run.settle : null;

      if (settle === null) {
        // The WHOLE settle ladder is spent without a definitive answer. PERSISTENCE-FIRST RECOVERY: the
        // engine persists the settled outcome before any rollback deploy, so re-read the record (itself
        // retried, never a single shot) and render what it says, never the failure itself.
        region.detail(h("p", { style: "color:var(--text)" }, SETTLE_UNCONFIRMED_LINE));
        const recorded = await readRecordedStatusWithRetry(engine, hooks);
        const outcome = recordedSettleOutcome(recorded);
        region.detail(h("p", { style: "color:var(--text)" }, recordedSettleOutcomeLine(outcome)));

        if (outcome.kind === "applied") {
          toast({ message: outcome.toVersion ? `Engine updated to ${outcome.toVersion}.` : "Engine update applied." });
          if (consoleWasApplied(promote, null, requested) && expectedConsoleVersion !== null) {
            await runConsoleCheckAndFinish(region, engine, token, expectedConsoleVersion, outcome.toVersion, outcome.confirmationPending, hooks);
            return "done";
          }
          region.setTerminal(appliedTerminalLineFor(outcome.toVersion, outcome.confirmationPending, false));
          reload();
          restoreFocus();
          return "done";
        }
        if (outcome.kind === "rolled-back") {
          region.setTerminal(terminalLineForOutcome(outcome));
          toast({ message: "Rolled back; nothing was lost.", tone: "info" });
          reload();
          restoreFocus();
          return "done";
        }
        if (outcome.kind === "expired-cleared") {
          region.setTerminal(terminalLineForOutcome(outcome));
          reload();
          restoreFocus();
          return "done";
        }
        // pending / unknown: the WHOLE client retry budget is spent. This is the s2 stall state -- it keeps
        // checking by itself, no user action requested, no reload (nothing is concluded yet).
        region.setTerminal(terminalLineForOutcome(outcome));
        pollUntilDefinitive(
          engine,
          isLive,
          (polledOutcome) => {
            region.setTerminal(terminalLineForOutcome(polledOutcome));
            if (polledOutcome.kind === "applied") toast({ message: polledOutcome.toVersion ? `Engine updated to ${polledOutcome.toVersion}.` : "Engine update applied." });
            else if (polledOutcome.kind === "rolled-back") toast({ message: "Rolled back; nothing was lost.", tone: "info" });
            reload();
            restoreFocus();
          },
          hooks,
        );
        return "done";
      }

      // A DEFINITIVE settle response arrived within the budget.
      region.detail(h("p", { style: "color:var(--text)" }, settleOutcomeDetail(settle)));
      region.detail(renderUpdateSteps(settle.steps));
      if (Array.isArray(settle.componentResults) && settle.componentResults.length > 0) {
        const rows = h("div");
        renderComponentResults(rows, settle.componentResults);
        region.detail(rows);
      }
      if (settle.outcome === "rolled-back") {
        region.setTerminal(terminalLineForOutcome({ kind: "rolled-back", fromVersion: settle.fromVersion ?? null, toVersion: settle.toVersion ?? null, reason: settle.reason ?? null }));
        toast({ message: `Rolled back to ${settle.fromVersion}; nothing was lost.`, tone: "info" });
        reload();
        restoreFocus();
        return "done";
      }
      // applied: the SAME droppedSources loud-surface the pending-verification body carries (post-update
      // source verification), so the live-apply path never quietly misses it either.
      const dropped = settle.droppedSources ?? [];
      if (dropped.length > 0) {
        region.append(droppedSourcesBanner(dropped));
        toast({ message: `${settle.toVersion} is live, but the update dropped ${dropped.length} source binding${dropped.length === 1 ? "" : "s"}; re-attach ${dropped.length === 1 ? "it" : "them"} on the Sources screen.`, tone: "warn", durationMs: 0 });
      } else {
        toast({ message: `Engine updated to ${settle.toVersion}.` });
      }
    }

    // POST-APPLY CONSOLE CHECK: only when the evidence says the console component actually landed (and the
    // engine, if it was in the set, settled KEPT: an engine rollback aborts the console engine-side). The
    // check ends in the reload prompt or the rollback affordance, so the section is NOT re-rendered under
    // it; every other path reloads the section exactly as before.
    if (consoleWasApplied(promote, settle, requested) && expectedConsoleVersion !== null && (settle === null || settle.outcome === "applied")) {
      const confirmationPending = settle?.confirmationPending === true;
      // toVersion: the engine's settled version when the engine was in play (the headline fact); otherwise
      // (a console-only apply, settle never ran at all) the top-level PromoteResult describes the single
      // requested component directly, i.e. the CONSOLE's own new version (api.ts ComponentApplyResult doc).
      const toVersion = settle?.toVersion ?? promote.toVersion ?? null;
      await runConsoleCheckAndFinish(region, engine, token, expectedConsoleVersion, toVersion, confirmationPending, hooks);
      return "done";
    }
    if (includesEngine && settle) {
      region.setTerminal(appliedTerminalLineFor(settle.toVersion, settle.confirmationPending === true, false));
    } else {
      // A console-only apply landed (a static-assets promote is atomic): the engine loop above never ran.
      toast({ message: "Console update deployed." });
      region.setTerminal("Updated.");
    }
    reload();
    restoreFocus();
    return "done";
  } catch (err) {
    if (isUnauthorised(err)) {
      goSignedOut();
      return "done";
    }
    // A throw can happen mid-flight (a transport fault during the APPLY call itself; a settle fault is
    // handled above via settleWithBudget + the recorded-truth recovery and never reaches here). The
    // destination gate (design s4) can also surface here if the refusal happened before any change was even
    // attempted; every other refusal/fault is shown as the honest recovery note below. The engine's own
    // paths never 500 (they roll back to a structured outcome), so a throw here is transport/auth/refusal.
    if (updateRefusalText(err) === DESTINATION_GATE_ENGINE_REASON) {
      out.replaceChildren(destinationGateNode());
      return "done";
    }
    // HONEST recovery note: applying PROMOTES the new version live, THEN verifies; if this page was closed
    // before verification finished, the engine does NOT silently auto-deploy a rollback (it deliberately
    // holds no deploy token). Instead the hourly canary keeps checking the live version and, if it is
    // unhealthy, raises a CRITICAL alert so you can roll back in one click. So: reopen this screen to finish
    // verification (or roll back), don't navigate away until verification completes.
    out.replaceChildren(h("p", { class: "field__error", role: "alert" }, updateRefusalText(err)));
    out.appendChild(
      h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "Applying deploys the new version live and then verifies it, so don't navigate away until verification finishes. If you did, reopen this screen to finish verification or roll back in one click. The hourly canary keeps watching the live version and will alert you to roll back if it turns out unhealthy."),
    );
    return "done";
  }
}

// promoteSummaryDetail / settleOutcomeDetail render the OLD verbose phase-summary prose for the Details
// disclosure only (design s2: this is exactly the "todays essay" that moves behind Details; the visible line
// only ever carries a stage string or a terminal sentence). Kept local and tiny (a handful of plain-words
// branches) rather than reusing the pre-0.1.5 promoteSummaryLine/settleOutcomeLine's SHAPE-typed signatures,
// so the Details content stays honest even from the recovered (non-SettleResult) path above.
function promoteSummaryDetail(outcome: string, to: string, from: string | undefined, reason: string | undefined): string {
  if (outcome === "refused") return reason ? `This update was refused: ${reason}.` : "This update was refused; the engine is unchanged.";
  return from ? `Deployed ${to}. Verifying it now (rollback target ${from})…` : `Deployed ${to}. Verifying it now…`;
}
function settleOutcomeDetail(r: SettleResult): string {
  if (r.outcome === "applied") return `Update applied. The new version ${r.toVersion} is live and the canary confirmed it.`;
  return r.reason
    ? `Rolled back to ${r.fromVersion}. The canary did not confirm ${r.toVersion} (${r.reason}). Nothing was lost, your data and recovery were never affected, and the engine is running the previous version exactly as before.`
    : `Rolled back to ${r.fromVersion}. The canary did not confirm the new version. Nothing was lost, your data and recovery were never affected, and the engine is running the previous version exactly as before.`;
}

// droppedSourcesBanner is the loud, actionable post-update source-verification prompt (unchanged wording +
// action from the pre-0.1.5 pending-verification body): a KEPT update whose pre/post binding diff found
// source bindings it did not carry forward. It is genuinely actionable (a direct re-attach path with a real
// button), never jargon, so it stays in the visible area via region.append, not Details.
function droppedSourcesBanner(dropped: string[]): HTMLElement {
  return banner({
    tone: "danger",
    message: `The update did not carry ${dropped.length} source binding${dropped.length === 1 ? "" : "s"} forward (${dropped.join(", ")}), so ${dropped.length === 1 ? "its" : "their"} next backups will fail. Re-attach ${dropped.length === 1 ? "it" : "them"} now with a one-shot deploy token.`,
    action: { label: "Re-attach sources", onClick: () => navigate("/sources") },
  });
}
