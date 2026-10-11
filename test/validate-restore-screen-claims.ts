// TC-restore-screen-claims: five statements the restore screen made that the engine did not back. Run with:
//   node test/validate-restore-screen-claims.ts
//
// A claims check read each restore surface against the engine and found five sentences, or states, that
// were false in a case the screen could reach. Each section below drives the REAL module over the shared DOM
// shim and never re-implements it.
//
//   1. THE RUN PICKER listed every history row with a run id. The engine allocates the id when a run starts
//      and keeps it on the row whatever the outcome, so in-flight, failed and abandoned runs were offered as
//      restore targets that can only fail at the dry run. It now lists sealed runs only.
//   2. THE SKIPPED-RECORD GROUPS filed an incompleteness-marker row under "re-provisioned out of band
//      (Workers, secrets, media)". The backup holds no data for such a record, so there is nothing to
//      re-provision. It now has its own group.
//   3. THE SINGLE-RUN APPLY said "This apply was sent and its outcome is unknown" after the engine had
//      refused the apply before any write (a dismissed step-up, a role denial, a rate limit, another 4xx),
//      and withdrew "Nothing has been written yet" with it. The confirm dialogue had promised the operator
//      that a dismissed step-up writes nothing.
//   4. THE CHANGE BUTTON warned that changing the plan voids an approval on an estate with no approval at
//      all, because the no-approval-required "Ready to apply" state carried the approval-armed marker.
//   5. THE JOURNEY SUMMARY read "Approval: Applied" after an apply that returned ok:false, which the engine
//      does not treat as a completed apply and on which it does not consume the approval.
//
// Each section carries a CONTROL that must stay as it was, so a change that flipped every case at once
// fails here as surely as the original defect does.

import { flushAsync, installDomShim, markConnected, qs, qsa, textOf } from "./dom-shim.ts";

installDomShim();

import type { Caller, EngineClient, RestoreApproval, RestorePlan, RestoreRequest, RestoreResult, RunHistoryEntry } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { setCaller } from "../src/lib/store.ts";
import { renderConfirm, stopConfirmGate } from "../src/screens/restore-flow/confirm.ts";
import { renderRestoreFlow } from "../src/screens/restore-flow/flow.ts";
import { renderJourneySummary } from "../src/screens/restore-flow/journey.ts";
import { emptyPickerText, openRunPicker, recentRuns } from "../src/screens/restore-flow/run-picker.ts";
import { RESTORE_STEP_COUNT, type RestoreJourneyInfo, UNWRITTEN_MARK, UNWRITTEN_TEXT } from "../src/screens/restore-flow/shared.ts";
import { buildSkippedGroups } from "../src/screens/restore-flow/skip-groups.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
// An APPROVER holds restore.apply, so renderConfirm reaches its approval gate rather than its role gate.
setCaller({ method: "access", email: "maker@test", role: "approver", groups: [], isOnlyOwner: false } as Caller);

const RUN_ID = "01J8Z3K9QW7B2RTESTRUNAAAA";
const PLAN_HASH = "a".repeat(64);
const FLAGS = { highImpact: false, isLarge: false, isRedirect: false, isNonLatest: false, isCrossAccount: false, isCrossZone: false };

function row(runId: string, status: RunHistoryEntry["status"], minutesAgo: number): RunHistoryEntry {
  return { runId, index: 1, startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), status };
}

function planThatWrites(): RestorePlan {
  return {
    ok: true, runId: RUN_ID, mode: "dry-run", recordsVerified: 2, isLatest: true, plannedWrites: 2, bytes: 64,
    sample: [{ name: "k1", sourceType: "kv", binding: "KV", plaintextSize: 32 }, { name: "k2", sourceType: "kv", binding: "KV", plaintextSize: 32 }],
    skipped: [],
  } as unknown as RestorePlan;
}

function approvalForHash(planHash: string): RestoreApproval {
  return {
    id: "apr_1", runId: RUN_ID, planHash, requestedBy: "maker@test", requestedAt: new Date().toISOString(), reason: "test",
    status: "approved", approvedBy: "checker@test", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as RestoreApproval;
}

const clickShim = (el: unknown): void => { (el as { click: () => void } | null)?.click(); };

// clickApplyAndConfirm presses the section's Apply button, then the confirm modal's own "Apply restore".
async function clickApplyAndConfirm(root: HTMLElement): Promise<void> {
  clickShim(qs(root as never, '[data-dp="restore-flow.button.apply#3"]'));
  await flushAsync();
  const modal = qs(document.body as never, ".dialog--modal");
  const confirmBtn = modal ? qsa(modal, "button").find((b) => textOf(b).trim() === "Apply restore") : undefined;
  clickShim(confirmBtn ?? null);
  await flushAsync();
}

// teardown stops every approval gate the flow started (the lapse timer an armed approval holds runs for the
// approval's whole remaining life, and would hold node open for an hour), then detaches the flow.
function teardown(flow: HTMLElement): void {
  for (const section of qsa(flow as never, ".restore-confirm")) stopConfirmGate(section as unknown as HTMLElement);
  flow.remove();
  closeModals();
}

// closeModals removes any dialog a section left open, so the next section starts from a clean body.
function closeModals(): void {
  for (const m of qsa(document.body as never, ".dialog--modal")) (m as unknown as { remove?: () => void }).remove?.();
  for (const b of qsa(document.body as never, ".modal-backdrop, .dialog-backdrop")) (b as unknown as { remove?: () => void }).remove?.();
}

async function main(): Promise<void> {
  // ==========================================================================================================
  console.log("\n-- 1. the run picker offers sealed runs only --");
  // ==========================================================================================================
  {
    const byDownpipe: Record<string, RunHistoryEntry[]> = {
      dp_a: [row("RUN_OK_OLD", "ok", 90), row("RUN_FAILED", "failed", 10), row("RUN_INFLIGHT", "in-flight", 1)],
      dp_b: [row("RUN_ABANDONED", "abandoned", 5), row("RUN_OK_NEW", "ok", 30)],
    };
    const ids = recentRuns(byDownpipe, new Map()).map((r) => r.run.runId);
    ok("an in-flight run is not offered", !ids.includes("RUN_INFLIGHT"));
    ok("a failed run is not offered", !ids.includes("RUN_FAILED"));
    ok("an abandoned run is not offered", !ids.includes("RUN_ABANDONED"));
    ok("both sealed runs are offered, newest first, and nothing else", JSON.stringify(ids) === JSON.stringify(["RUN_OK_NEW", "RUN_OK_OLD"]));

    // The cap applies AFTER the filter: forty failed runs newer than one sealed run must not push it off.
    const burst: RunHistoryEntry[] = Array.from({ length: 45 }, (_, i) => row(`RUN_F${i}`, "failed", i + 1));
    burst.push(row("RUN_SEALED", "ok", 500));
    ok("a burst of newer failed runs does not push a sealed run off the list", recentRuns({ dp: burst }, new Map()).some((r) => r.run.runId === "RUN_SEALED"));

    // The empty state has two cases. pickerBody opens the real picker over a history and returns its text.
    const pickerBody = async (byDownpipe: Record<string, RunHistoryEntry[]>): Promise<string> => {
      const engine = { listAllHistory: async () => ({ byDownpipe }), listDownpipes: async () => [] } as unknown as EngineClient;
      openRunPicker(engine);
      await flushAsync();
      const text = textOf(document.body as never);
      closeModals();
      return text;
    };

    // A fleet with no run at all waits for a first seal.
    const none = await pickerBody({ dp_a: [] });
    ok("with no run at all, the picker says there is no sealed run yet", none.includes("No sealed runs across any downpipe yet."));
    ok("and it says a run appears when a downpipe seals its first backup", none.includes("A run appears here when a downpipe seals its first backup."));

    // A ring that holds only failed rows is the case a failing source reaches: the ring keeps the latest 50
    // entries per downpipe, so 50 failures in a row push every sealed run off it. Those sealed runs are still
    // on the destination, so "wait for a first seal" would be false here.
    const failedRing: RunHistoryEntry[] = Array.from({ length: 50 }, (_, i) => row(`RUN_FAILED_${i}`, "failed", i + 1));
    const failedOnly = await pickerBody({ dp_a: failedRing });
    ok("with only failed runs, the picker does not say no downpipe has sealed yet", !failedOnly.includes("No sealed runs across any downpipe yet."));
    ok("with only failed runs, the picker does not say to wait for a first seal", !failedOnly.includes("seals its first backup"));
    ok(
      "with only failed runs, the picker names the 50-run history and the run-id route",
      failedOnly.includes(
        "The recent run history has no sealed run. This history keeps only the last 50 runs of each downpipe, and none of the runs in it sealed a backup. A downpipe can have older sealed runs on its destination. To restore one of those runs, type its run id on the restore form.",
      ),
    );
    ok("it does not list a failed run", !failedOnly.includes("RUN_FAILED_0"));
    ok("emptyPickerText agrees with the rendered picker for an empty history", emptyPickerText({}).startsWith("No sealed runs across any downpipe yet."));
  }

  // ==========================================================================================================
  console.log("\n-- 2. an incompleteness-marker row has its own skipped group --");
  // ==========================================================================================================
  {
    const MARKER = "the captured value is an incompleteness marker (the object vanished or was skipped at capture), not real bytes; nothing to restore";
    const MEDIA_MARKER = "media file, the captured value was a marker (capture had failed), not file bytes";
    const SECRET = "Secrets Store value, restore out of band: the binding is read-only at runtime, so there is no in-account write path";
    const groups = buildSkippedGroups([
      { name: "kv/vanished", reason: MARKER },
      { name: "stream/clip", reason: MEDIA_MARKER },
      { name: "secrets/API_TOKEN", reason: SECRET },
    ]);
    const summaries = groups.map((g) => textOf(qs(g as never, "summary")));
    const groupOf = (name: string): string => {
      const g = groups.find((x) => textOf(x as never).includes(name));
      return g ? textOf(qs(g as never, "summary")) : "";
    };
    ok("the two marker rows are counted in one marker group", summaries.includes("2 records not captured (incompleteness markers)"));
    ok("the data-record marker is in the marker group", groupOf("kv/vanished").includes("incompleteness markers"));
    ok("the media marker is in the marker group", groupOf("stream/clip").includes("incompleteness markers"));
    ok("CONTROL: the secret stays in the out-of-band group", groupOf("secrets/API_TOKEN").includes("re-provisioned out of band"));
    ok("the out-of-band group counts the secret alone", summaries.includes("1 re-provisioned out of band (Workers, secrets, media)"));
    const outOfBand = groups.find((g) => textOf(qs(g as never, "summary")).includes("re-provisioned out of band"));
    ok("the out-of-band lead no longer carries the marker sentence", outOfBand !== undefined && !textOf(outOfBand as never).includes("incompleteness marker"));
    const marker = groups.find((g) => textOf(qs(g as never, "summary")).includes("incompleteness"));
    ok("the marker lead says there is nothing to restore", marker !== undefined && textOf(marker as never).includes("There is nothing to restore"));
    ok(
      "the marker lead says what can cause a marker, one fact per sentence",
      marker !== undefined &&
        textOf(marker as never).includes("The source deleted the record before the backup read it, or the backup did not read it, or the read failed."),
    );
    // The row names and the engine's reason can carry "vanished", so this reads the old lead's phrase.
    ok("the marker lead no longer says a record vanished before capture", marker !== undefined && !textOf(marker as never).includes("vanished before capture"));
  }

  // ==========================================================================================================
  console.log("\n-- 3. an apply the engine refused before any write is not an unknown outcome --");
  // ==========================================================================================================
  {
    // driveApply renders the real confirm section on an estate without dual control, presses Apply, and lets
    // the apply throw. It returns the section so the caller can read what the operator sees.
    //
    // The section is mounted inside a stand-in plan card that carries the plan's own "Nothing has been
    // written yet" line, marked the way plan.ts marks it. markApplyOutcomeUnknown reaches that line through
    // section.parentElement, so without a parent this file could not see it withdrawn and the assertion on
    // it would pass whatever the code did.
    const driveApply = async (thrown: Error): Promise<{ section: HTMLElement; unwritten: HTMLElement }> => {
      const engine = {
        listApprovals: async () => [],
        getConfigApprovalPolicy: async () => ({ requireRestoreApproval: false, requireChangeNumber: false }),
        restore: async (req: RestoreRequest) => {
          if (req.confirm === true) throw thrown;
          return planThatWrites();
        },
      } as unknown as EngineClient;
      const card = document.createElement("div");
      const unwritten = document.createElement("p");
      unwritten.className = UNWRITTEN_MARK;
      unwritten.textContent = UNWRITTEN_TEXT;
      card.appendChild(unwritten);
      const section = await renderConfirm(engine, planThatWrites(), { runId: RUN_ID } as RestoreRequest, PLAN_HASH, FLAGS, () => {}, () => {});
      card.appendChild(section);
      markConnected(card);
      markConnected(section);
      await flushAsync();
      await clickApplyAndConfirm(section);
      return { section, unwritten };
    };
    const beforeWrite: Array<[string, Error]> = [
      ["a dismissed passkey step-up", new Error("restore: stepup-required: 401")],
      ["an Access sign-in that is too old", new Error("restore: access-reauth-required: 401")],
      ["a role denial", new Error("restore: 403")],
      ["a rate limit", new Error("restore: retry-after=3: 429")],
      ["a change-number refusal (a 400)", new Error("restore: 400")],
    ];
    for (const [name, thrown] of beforeWrite) {
      const { section, unwritten } = await driveApply(thrown);
      const text = textOf(section as never);
      ok(`${name}: the screen does not say the outcome is unknown`, !text.includes("its outcome is unknown"));
      ok(`${name}: the plan still says nothing has been written`, unwritten.textContent === UNWRITTEN_TEXT);
      ok(`${name}: the refusal is shown with a Retry`, qsa(section as never, "button").some((b) => textOf(b).trim() === "Retry" || textOf(b).includes("Try again")));
      stopConfirmGate(section);
      closeModals();
    }
    for (const [name, thrown] of [["a 503", new Error("restore: 503")], ["no answer at all", new TypeError("Failed to fetch")]] as Array<[string, Error]>) {
      const { section, unwritten } = await driveApply(thrown);
      ok(`CONTROL, ${name}: the screen still says the outcome is unknown`, textOf(section as never).includes("its outcome is unknown"));
      ok(`CONTROL, ${name}: the plan's "nothing has been written" line is retracted`, unwritten.textContent !== UNWRITTEN_TEXT);
      stopConfirmGate(section);
      closeModals();
    }
  }

  // ==========================================================================================================
  console.log("\n-- 4 and 5. the Change button and the journey summary, through the real flow --");
  // ==========================================================================================================
  {
    // driveFlow mounts the whole restore flow for a known run, the way /restore/:runId does, and lets its
    // automatic dry-run and approval gate settle. approvals decides which enabled state the gate reaches.
    const driveFlow = async (opts: { requireApproval: boolean; applyResult?: RestoreResult }): Promise<{ flow: HTMLElement; journey: RestoreJourneyInfo[] }> => {
      const journey: RestoreJourneyInfo[] = [];
      let hash = "";
      const engine = {
        restore: async (req: RestoreRequest) => {
          if (req.confirm === true) return opts.applyResult;
          return planThatWrites();
        },
        listApprovals: async () => (opts.requireApproval && hash !== "" ? [approvalForHash(hash)] : []),
        getConfigApprovalPolicy: async () => ({ requireRestoreApproval: opts.requireApproval, requireChangeNumber: false }),
        getRunHistory: async () => [],
        listAllHistory: async () => ({ byDownpipe: {} }),
        listDownpipes: async () => [],
      } as unknown as EngineClient;
      const flow = renderRestoreFlow(engine, RUN_ID, undefined, (info) => {
        journey.push(info);
        if (info.planHash) hash = info.planHash;
      });
      document.body.appendChild(flow as never);
      markConnected(flow);
      for (let i = 0; i < 6; i++) await flushAsync();
      // The approvals listing is read once the hash is known. A recheck picks up the approval bound to it.
      if (opts.requireApproval && qs(flow as never, ".restore-confirm__approved") === null) {
        const recheck = qsa(flow as never, "button").find((b) => textOf(b).includes("Check for approval"));
        clickShim(recheck ?? null);
        for (let i = 0; i < 4; i++) await flushAsync();
      }
      return { flow, journey };
    };
    const changeOpensModal = async (flow: HTMLElement): Promise<boolean> => {
      closeModals();
      clickShim(qs(flow as never, '[data-dp="restore-flow.button.change"]'));
      await flushAsync();
      return textOf(document.body as never).includes("Change the restore plan");
    };

    {
      const { flow } = await driveFlow({ requireApproval: false });
      ok("no approval required: the gate offers Apply", qs(flow as never, ".restore-confirm__armed") !== null);
      ok("no approval required: the state carries its own marker", qs(flow as never, ".restore-confirm__ready") !== null);
      ok("no approval required: the state is not marked as approval-armed", qs(flow as never, ".restore-confirm__approved") === null);
      ok("no approval required: Change re-opens the form with no approval warning", !(await changeOpensModal(flow)));
      teardown(flow);
    }
    {
      const { flow } = await driveFlow({ requireApproval: true });
      ok("an approval armed Apply: the gate is marked approval-armed", qs(flow as never, ".restore-confirm__approved") !== null);
      ok("CONTROL, an approval armed Apply: Change asks before it voids the approval", await changeOpensModal(flow));
      teardown(flow);
    }

    // 5. The journey summary after an apply. The flow must hand the outcome through, and the summary must
    // read it. The apply result below did not complete and an approval rode on it.
    const failed: RestoreResult = { ok: false, runId: RUN_ID, mode: "applied", recordsVerified: 2, recordsRestored: 1, bytesRestored: 32, isLatest: true, failures: [{ name: "k2", reason: "write failed" }] } as RestoreResult;
    {
      const { flow, journey } = await driveFlow({ requireApproval: true, applyResult: failed });
      await clickApplyAndConfirm(flow);
      const last = journey[journey.length - 1];
      ok("an ok:false apply reaches the terminal step", last !== undefined && last.step === RESTORE_STEP_COUNT + 1);
      ok("the flow hands the journey an outcome that did not complete", last?.applied?.ok === false);
      ok("the flow says an approval rode on the apply", last?.applied?.approvalCarried === true);
      const summary = renderJourneySummary();
      if (last) summary.update(last);
      const text = textOf(summary.el as never);
      ok('the journey summary does not read "Applied" after an ok:false apply', !/Approval\s*Applied/.test(text));
      ok("the journey summary says the approval was not consumed", text.includes("Not consumed. The apply did not complete."));
      teardown(flow);
    }
    {
      const { flow, journey } = await driveFlow({ requireApproval: false, applyResult: { ...failed, recordsRestored: 0, failures: [] } });
      await clickApplyAndConfirm(flow);
      const last = journey[journey.length - 1];
      ok("no approval required: the flow says no approval rode on the apply", last?.applied?.approvalCarried === false);
      const summary = renderJourneySummary();
      if (last) summary.update(last);
      const text = textOf(summary.el as never);
      ok("no approval required: the summary says the apply did not complete, and names no approval", text.includes("The apply did not complete.") && !text.includes("Not consumed"));
      teardown(flow);
    }
    {
      const ok_: RestoreResult = { ...failed, ok: true, recordsRestored: 2, failures: [] };
      const { flow, journey } = await driveFlow({ requireApproval: true, applyResult: ok_ });
      await clickApplyAndConfirm(flow);
      const last = journey[journey.length - 1];
      const summary = renderJourneySummary();
      if (last) summary.update(last);
      ok("CONTROL: a completed apply still reads Applied", /Approval\s*Applied/.test(textOf(summary.el as never)));
      teardown(flow);
    }
  }

  verdictReached(failures);
  console.log(`\nVERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
