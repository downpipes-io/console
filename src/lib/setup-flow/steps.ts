// The step model of the unified first run: the ordered steps from the shared CONTRACT, their routes, and a
// PURE status function over (facts, draft, runtime). The model (model.ts) calls it on every change; a UI
// reads the result and never decides a step's status itself.
//
// Order: welcome, connect, destination, protect, keys, apply, backup, finish; then the two optional steps
// (team, approval) reached from Finish. Dependencies point backwards only, so the first unfinished step is
// never a locked one.

import type { SetupDraft, SetupFacts, SetupRuntime, SetupStepId, StepStatus, StepView } from "./types.ts";

export interface StepDef {
  id: SetupStepId;
  label: string;
  optional: boolean;
  // Suggested sub-steps that take input, each with its own URL (/setup/<step>/<sub>). A concept may use any
  // subset or none; the model accepts any sub a route carries.
  subs: readonly string[];
}

export const MAIN_STEPS: readonly StepDef[] = [
  { id: "welcome", label: "Welcome", optional: false, subs: [] },
  { id: "connect", label: "Connect", optional: false, subs: [] },
  { id: "destination", label: "Destination", optional: false, subs: ["provider", "bucket", "credentials", "immutability"] },
  { id: "protect", label: "Protect", optional: false, subs: [] },
  { id: "keys", label: "Keys", optional: false, subs: ["posture", "custody", "generate", "save"] },
  { id: "apply", label: "Apply", optional: false, subs: ["token", "self-deploy"] },
  { id: "backup", label: "First backup", optional: false, subs: ["plan", "run"] },
  { id: "finish", label: "Finish", optional: false, subs: [] },
];
export const OPTIONAL_STEPS: readonly StepDef[] = [
  { id: "team", label: "Invite your team", optional: true, subs: [] },
  { id: "approval", label: "Restore approval", optional: true, subs: [] },
];
export const ALL_STEPS: readonly StepDef[] = [...MAIN_STEPS, ...OPTIONAL_STEPS];

// OWNER_STEPS are the steps only an Owner can do: the engine's Owner gate on the token, destination, key
// ceremony, key install, attach and restore-approval routes, plus Welcome and Protect, which lead only into
// them. The setup page shows a caller who is not an Owner a hand-off on these, and the shell strip and Overview
// word them the same way. One set, so the page and the strip never disagree.
export const OWNER_STEPS: ReadonlySet<SetupStepId> = new Set<SetupStepId>(["welcome", "connect", "destination", "protect", "keys", "apply", "approval"]);

export function isSetupStepId(v: string): v is SetupStepId {
  return ALL_STEPS.some((s) => s.id === v);
}

// stepRoute is the URL of a step (or a sub-step).
export function stepRoute(id: SetupStepId, sub?: string): string {
  return `/setup/${id}${sub ? `/${encodeURIComponent(sub)}` : ""}`;
}

// parseSetupParams reads the router params of a /setup, /setup/:step or /setup/:step/:sub match. An unknown
// step reads as null (the screen then resumes at the current step).
export function parseSetupParams(params: Record<string, string>): { step: SetupStepId | null; sub: string | null } {
  const raw = params.step ?? "";
  return { step: isSetupStepId(raw) ? raw : null, sub: params.sub ?? null };
}

// ---- done tests -----------------------------------------------------------------------------------------

// connectDone: the engine holds the read-only token AND it sees at least one account. A token that sees
// none is stored by the demo engine but lists nothing, so it does not complete the step. Until discovery has
// answered in this tab the account list is unknown, and the engine's own token fact stands: a real engine
// refuses a token that sees no account before it stores it (engine src/admin/router-discovery.ts, POST
// /sources/discovery-token). An engine that already has downpipes is past Connect whatever its token.
function connectDone(f: SetupFacts): boolean {
  if (f.downpipes.length > 0) return true;
  const present = f.tokenPresent ?? f.setup?.discoveryTokenPresent ?? false;
  if (!present) return false;
  return f.discoveryReadAt === 0 || f.failedReads.includes("discovery") || f.accounts.length > 0;
}

function destinationDone(f: SetupFacts): boolean {
  return f.setup?.destination.configured === true || f.destinations.length > 0;
}

// protectDone: something is picked, or the engine already has sources bound (an IaC deploy) or downpipes.
function protectDone(f: SetupFacts, d: SetupDraft): boolean {
  return d.picks.length > 0 || f.downpipes.length > 0 || (f.setup?.boundSourceCount ?? 0) > 0;
}

// keysDone: the engine holds keys, or this tab holds a ceremony whose files the user said are saved, or the
// engine accepted this setup's key install and has not reported the keys yet (Apply waits again; making new
// keys then would only produce files that open nothing). A reload drops the ceremony (memory only), so a draft
// that says "generated" without it and without an accepted install is NOT done.
function keysDone(f: SetupFacts, d: SetupDraft, r: SetupRuntime): boolean {
  return f.keysReady || d.keysSent || (r.ceremonyHeld && d.keysGenerated && d.keysSaved);
}

// pickedBindingsLive: every picked resource that needs a binding is bound on the engine.
export function pickedBindingsLive(f: SetupFacts, d: SetupDraft): boolean {
  const picked = new Set(d.picks);
  for (const g of f.groups) {
    for (const res of g.resources) {
      if (picked.has(res.key) && res.binding !== undefined && !res.bound) return false;
    }
  }
  return true;
}

// applyDone: the engine holds keys and every pick that needs a binding has it live. Apply attaches what Protect
// picked, so it cannot be done before Protect is: keys made by deploy.sh alone leave it open.
function applyDone(f: SetupFacts, d: SetupDraft): boolean {
  return f.keysReady && protectDone(f, d) && pickedBindingsLive(f, d);
}

// engineRecordSealed: the engine's own record for a downpipe (all downpipes when `id` is omitted): its
// integrity recorded (DownpipeState.lastIntegrityVerifiedAt, stamped when a run completes with a seal that is
// not suspect, or when an attestation or restore test passes; engine sched/scheduler-do-scheduling.ts
// ds.integrityVerified). A failed run never clears it.
function engineRecordSealed(f: SetupFacts, id?: string): boolean {
  return f.downpipes.some((dp) => (id === undefined || dp.config.id === id) && dp.lastIntegrityVerifiedAt !== undefined && dp.lastIntegrityVerifiedOk !== false);
}

// A run's seal, as the two tests below need it: "done" is any ok run whose seal is not suspect (an ok run with no
// verdict is final: verify-at-seal is switched off on that engine), "sealed" is an ok run the engine verified.
type RunEntry = NonNullable<SetupFacts["runs"][string]>[number];
type SealTest = (e: RunEntry) => boolean;
const DONE: SealTest = (e) => e.status === "ok" && e.sealVerification?.status !== "suspect";
const SEALED: SealTest = (e) => e.status === "ok" && e.sealVerification?.status === "verified";

// createdJudged: the downpipes this setup created that the first backup is judged by. A created downpipe the
// engine no longer lists, and whose runs this tab never read, is left out: it was deleted, or is still waiting
// for approval, and nothing of it can seal.
function createdJudged(f: SetupFacts, d: SetupDraft): string[] {
  return [...new Set(d.createdDownpipeIds)].filter((id) => f.downpipes.some((dp) => dp.config.id === id) || (f.runs[id]?.length ?? 0) > 0);
}

// createdSealed: one downpipe this setup created has had a run that passes `test`. It has no older runs, so every
// run in its ring is this setup's. Its ring is bounded, so when no ok run is left in it (or the ring was not
// read), the engine's integrity record for it stands in: only its own runs can have stamped it.
function createdSealed(f: SetupFacts, id: string, test: SealTest): boolean {
  const ring = f.runs[id] ?? [];
  if (ring.some(test)) return true;
  return !ring.some((e) => e.status === "ok") && engineRecordSealed(f, id);
}

// ownRuns: the runs the last Run now started (a draft from before startedRuns holds only the first).
function ownRuns(d: SetupDraft): Array<{ downpipeId: string; runId: string }> {
  return d.startedRuns.length > 0 ? d.startedRuns : d.firstRun !== null ? [d.firstRun] : [];
}

// ownRunJudged: one run of a setup that created no downpipe and ran the estate's own (a console set up before
// this setup page). Those downpipes have older runs that say nothing about this setup, so only the run it
// started counts. Its ring is bounded: a run that has left it can no longer be read, so that downpipe's
// integrity record stands in for it.
function ownRunJudged(f: SetupFacts, run: { downpipeId: string; runId: string }, test: SealTest): boolean {
  const ring = f.runs[run.downpipeId];
  const e = ring?.find((x) => x.runId === run.runId);
  if (e !== undefined) return test(e);
  return ring !== undefined && ring.length > 0 && !ring.some((x) => x.status === "in-flight") && engineRecordSealed(f, run.downpipeId);
}

// firstBackupJudged: the first backup passes `test`. When this setup created downpipes, EVERY one of them must
// have sealed: a first backup where one of two downpipes failed is not done. With no downpipe of its own, EVERY
// run it started on the estate's downpipes counts, and a downpipe it did not start holds it open. With neither
// (another tab or browser, or an engine set up outside the console), the engine's integrity record for any
// downpipe.
function firstBackupJudged(f: SetupFacts, d: SetupDraft, test: SealTest): boolean {
  if (d.createdDownpipeIds.length > 0) {
    const ids = createdJudged(f, d);
    return ids.length > 0 && ids.every((id) => createdSealed(f, id, test));
  }
  const runs = ownRuns(d);
  if (runs.length > 0) return d.notStarted.length === 0 && runs.every((r) => ownRunJudged(f, r, test));
  return engineRecordSealed(f);
}

// firstBackupOutstanding: the downpipes the first backup waits on (the "done" test): each one this setup
// created that has not sealed, or, with none of its own, each run it started that has not sealed and each
// downpipe it did not start. "Run it again" starts these.
export function firstBackupOutstanding(f: SetupFacts, d: SetupDraft): string[] {
  if (d.createdDownpipeIds.length > 0) return createdJudged(f, d).filter((id) => !createdSealed(f, id, DONE));
  const open = ownRuns(d).filter((r) => !ownRunJudged(f, r, DONE)).map((r) => r.downpipeId);
  return [...new Set([...open, ...d.notStarted.map((n) => n.downpipeId)])];
}

// firstBackupProgress: of the downpipes this setup created, how many have sealed a run (the "done" test). null
// when this setup created none that can be judged. The shell reads it to say a first backup is not finished.
export function firstBackupProgress(f: SetupFacts, d: SetupDraft): { sealed: number; total: number } | null {
  if (d.createdDownpipeIds.length === 0) return null;
  const ids = createdJudged(f, d);
  if (ids.length === 0) return null;
  return { sealed: ids.filter((id) => createdSealed(f, id, DONE)).length, total: ids.length };
}

// firstRunSealed: this setup's first backup ended ok AND the engine verified the seal of every downpipe it
// created (or of the run it started), or, with no run of its own, the engine's integrity record. Only this may
// make a UI say "protected".
export function firstRunSealed(f: SetupFacts, d: SetupDraft): boolean {
  return firstBackupJudged(f, d, SEALED);
}

// firstRunDone: the first backup has run to its end without a suspect seal, on every downpipe this setup created.
// The engine attaches the verify-at-seal verdict to the run row at the moment it completes (seal/runseal-do.ts
// computes it before complete()), so an ok row with NO verdict is final: verify-at-seal is switched off on that
// engine (VERIFY_AT_SEAL). That completes First backup, so setup never locks a console whose operator chose it,
// but it is not "protected": only a verified seal (firstRunSealed) licenses that word.
export function firstRunDone(f: SetupFacts, d: SetupDraft): boolean {
  return firstBackupJudged(f, d, DONE);
}

// effectivePosture is the posture this setup works to. Once the engine holds keys and has reported which
// posture they set (GET /admin/status), that is the answer, whoever made them: the engine runs with the keys it
// holds, not with the answer in a draft. Before that, it is the posture the user confirmed here. null while
// neither is known. Retention, restore tests and the receipt read this, never the draft alone, so keys made
// outside setup are never treated as the offline posture by default, and a draft never overrides the engine.
export function effectivePosture(f: SetupFacts, d: SetupDraft): SetupDraft["posture"] {
  if (f.keysReady && f.enginePosture !== null) return f.enginePosture;
  if (d.posture !== null) return d.posture;
  return null;
}

// ---- the shell's completeness --------------------------------------------------------------------------------

// shellFactsRead: the shell may judge setup only from a setup-state read and a downpipe list read that both
// landed, and on a refresh where neither failed (fail open: lib/setup-state.ts setupViewOf returns no view).
export function shellFactsRead(f: SetupFacts): boolean {
  if (f.setup === null || f.readsAt["setup-state"] === undefined || f.readsAt.downpipes === undefined) return false;
  return !f.failedReads.includes("setup-state") && !f.failedReads.includes("downpipes");
}

// setUpByEstateFacts: the facts the console counted as "setup done" before this setup page existed. The engine
// holds keys, a destination is set, the account is connected (or the estate is past Connect), and at least one
// downpipe exists. An install that finished setup under that rule may have no downpipe with the engine's
// integrity stamp (its downpipes have not run yet, its runs failed, or verify-at-seal is off), and the shell
// must not lock it again after an upgrade. This decides the shell only: the setup page keeps its own step
// statuses, and only a verified first seal (firstRunSealed) licenses "protected".
export function setUpByEstateFacts(f: SetupFacts): boolean {
  return f.keysReady && destinationDone(f) && connectDone(f) && f.downpipes.length > 0;
}

// shellComplete: whether the shell (the gate, the first-load landing, the rail locks, the strip and the
// palette) counts setup as complete. Either every numbered step before Finish is done in the step model, or the
// estate facts above hold. The model (model.ts) latches it, so once it is true the shell never locks again in
// that page's life.
export function shellComplete(f: SetupFacts, steps: readonly StepView[]): boolean {
  if (!shellFactsRead(f)) return false;
  const byId = new Map(steps.map((st) => [st.id, st.status]));
  const modelDone = MAIN_STEPS.every((def) => def.id === "welcome" || def.id === "finish" || byId.get(def.id) === "done");
  return modelDone || setUpByEstateFacts(f);
}

function anyFactProgress(f: SetupFacts): boolean {
  return connectDone(f) || destinationDone(f) || f.keysReady || f.downpipes.length > 0;
}

// ---- status ---------------------------------------------------------------------------------------------

function mainDone(id: SetupStepId, f: SetupFacts, d: SetupDraft, r: SetupRuntime): boolean {
  switch (id) {
    case "welcome":
      return d.started || anyFactProgress(f);
    case "connect":
      return connectDone(f);
    case "destination":
      return destinationDone(f);
    case "protect":
      return protectDone(f, d);
    case "keys":
      return keysDone(f, d, r);
    case "apply":
      return applyDone(f, d);
    case "backup":
      return firstRunDone(f, d);
    case "finish":
      return false;
    case "team":
      return d.teamSkipped || d.grants.length > 0;
    case "approval":
      return d.restoreApproval !== null || f.restoreApproval === true;
  }
}

// lockReason returns why a step cannot be used yet, or null. Reasons are plain text a UI shows as is.
function lockReason(id: SetupStepId, f: SetupFacts, d: SetupDraft, r: SetupRuntime): string | null {
  switch (id) {
    case "apply": {
      const missing: string[] = [];
      // The engine names its own account from the read-only token before it can install keys or attach
      // (engine src/admin/router-keys.ts:385 on origin/main), so Connect is a hard dependency here.
      if (!connectDone(f)) missing.push("connect your account");
      if (!protectDone(f, d)) missing.push("pick what to protect");
      if (!keysDone(f, d, r)) missing.push(d.keysGenerated && !r.ceremonyHeld && !f.keysReady ? "make your keys again (leaving setup or reloading the page cleared them)" : "generate and save your keys");
      return missing.length === 0 ? null : `First ${missing.join(", then ")}.`;
    }
    case "backup": {
      const missing: string[] = [];
      if (!destinationDone(f)) missing.push("save a destination");
      if (!applyDone(f, d)) missing.push("apply your keys and sources");
      return missing.length === 0 ? null : `First ${missing.join(", then ")}.`;
    }
    case "finish":
      return firstRunDone(f, d) ? null : "Finish opens when the first backup has run and sealed.";
    case "team":
    case "approval":
      return firstRunDone(f, d) ? null : "Optional. Available after the first backup.";
    default:
      return null;
  }
}

// availableNote is the advisory line for a step that can be used but lacks something useful.
function availableNote(id: SetupStepId, f: SetupFacts): string | undefined {
  if ((id === "destination" || id === "protect") && !connectDone(f)) {
    return id === "destination" ? "Connect first to pick your bucket from a list. You can also type it." : "Connect first to list what you can protect.";
  }
  return undefined;
}

// computeSteps is the whole status model: the main steps in order, then the optional steps.
export function computeSteps(f: SetupFacts, d: SetupDraft, r: SetupRuntime): { steps: StepView[]; current: SetupStepId } {
  let current: SetupStepId | null = null;
  const steps: StepView[] = [];
  for (const def of ALL_STEPS) {
    const done = mainDone(def.id, f, d, r);
    const lock = done ? null : lockReason(def.id, f, d, r);
    let status: StepStatus;
    if (done) status = "done";
    else if (lock !== null) status = "locked";
    else if (current === null && !def.optional) {
      status = "current";
      current = def.id;
    } else status = "available";
    const note = status === "locked" ? lock ?? undefined : status === "done" ? undefined : availableNote(def.id, f);
    steps.push({ id: def.id, label: def.label, route: stepRoute(def.id), optional: def.optional, status, ...(note !== undefined ? { reason: note } : {}) });
  }
  // Every main step before Finish done: Finish is current.
  return { steps, current: current ?? "finish" };
}

// nextMainStep is the step after `id` in the main order (or null after Finish).
export function nextMainStep(id: SetupStepId): SetupStepId | null {
  const i = MAIN_STEPS.findIndex((s) => s.id === id);
  if (i < 0 || i + 1 >= MAIN_STEPS.length) return null;
  return MAIN_STEPS[i + 1]!.id;
}
