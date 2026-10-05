// The setup model's ACTIONS, part two: Apply (one deploy token installs the keys and attaches the picked
// sources), the first backup (create and run now, then watch the run), and the optional steps (team, restore
// approval). Same rules as actions.ts.

import { isOwnerActionQueuedResult, type AttachSourceInput, type Downpipe, type RunHistoryEntry } from "../../api.ts";
import { stepUpAwareText } from "../../components/error-view.ts";
import { deployCommand, wranglerStanza, type SourceInput } from "../add-source.ts";
import { runBulkCreate } from "../bulk-create.ts";
import { recordOnboardingStep } from "../client-diag/ring.ts";
import { isStepUpRequired, isUnauthorised } from "../errors.ts";
import { surfacePendingChange, surfaceQueuedOwnerAction } from "../pending-change-toast.ts";
import { clearSensitiveState, getEngine } from "../store.ts";
import { canCap, canDo, capGateReason, gateReason } from "../../screens/common.ts";
import { errMsg, slugId } from "../../screens/sources/shared.ts";
import { assembleBulkDownpipes, assembleCfConfigBulk } from "../../screens/sources-downpipes/bulk-assemble.ts";
import { caller } from "../nav.ts";
import type { Role } from "../identity.ts";
import { afterFactChange, ceremonyMatchesPosture, currentCeremony, fail, ok, POSTURE_MISMATCH, unauthorised, type ActionResult } from "./actions.ts";
import { clearRevokeReminder, noteDeployTokenUsed } from "./revoke-reminder.ts";
import { engineFaultOutcome, installCeremonyKeys, keysWaitMessage, waitForKeys } from "./install.ts";
import { orderPreflightItems, preflightItemPresentation } from "./preflight.ts";
import { CUSTOM_RETENTION_UNAVAILABLE, restoreTestChoices, retentionChoices, SCHEDULES } from "./inventory.ts";
import { pickedResources, setupModel } from "./model.ts";
import { effectivePosture } from "./steps.ts";
import type { Resource } from "./types.ts";

// ---- polling --------------------------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// pollUntil checks at once, then every intervalMs, up to `tries` checks. A check that throws counts as "not
// yet". The bounds match the keys wait (install.ts waitForKeys: 3 s, 40 tries).
async function pollUntil(check: () => Promise<boolean>, intervalMs: number, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      if (await check()) return true;
    } catch {
      // A transient read failure: try again on the next interval.
    }
    if (i + 1 < tries) await sleep(intervalMs);
  }
  return false;
}
const POLL_MS = 3000;
const POLL_TRIES = 40;
// The pause before the one retry of an attach refused straight after the key install (applyWithDeployToken).
const ATTACH_RETRY_MS = 3000;

// engineHoldsKeys asks the engine whether it holds its signer and break-glass keys, for up to about ten seconds.
// A lost install answer is most often the version rollout the install itself causes, and for a few seconds an
// isolate of the old version can answer "no keys" although they landed. Sending the keys again on that answer
// would install a second set over the first (and a second wrap key over credentials the first one sealed:
// safety review m4), so one "no" is not taken as the answer. null when the engine never answered.
const KEYS_SETTLE_TRIES = 4;
async function engineHoldsKeys(engine: NonNullable<ReturnType<typeof getEngine>>): Promise<boolean | null> {
  let answered = false;
  for (let i = 0; i < KEYS_SETTLE_TRIES; i++) {
    try {
      if ((await engine.getSetupState()).keysReady) return true;
      answered = true;
    } catch {
      // Not answered: ask again on the next interval.
    }
    if (i + 1 < KEYS_SETTLE_TRIES) await sleep(POLL_MS);
  }
  return answered ? false : null;
}

// ---- Apply ----------------------------------------------------------------------------------------------

export type ApplyStage = "install-keys" | "confirm-keys" | "attach-sources" | "confirm-sources" | "done";
export type ApplyStageState = "start" | "done" | "skipped";
export type ApplyProgress = (stage: ApplyStage, state: ApplyStageState, detail?: { done: number; total: number }) => void;

// attachInputFor maps a picked binding resource to the attach wire shape (the same fields the Sources
// catalogue sends, screens/sources/account.ts:389-392).
function attachInputFor(r: Resource): SourceInput | null {
  if (r.binding === undefined) return null;
  switch (r.kind) {
    case "kv":
      return r.id !== undefined ? { type: "kv", binding: r.binding, namespaceId: r.id } : null;
    case "r2":
      return { type: "r2", binding: r.binding, bucketName: r.name };
    case "d1":
      return r.id !== undefined ? { type: "d1", binding: r.binding, databaseName: r.name, databaseId: r.id } : null;
    case "secrets":
      return r.id !== undefined && r.secretName !== undefined ? { type: "secrets", binding: r.binding, storeId: r.id, secretName: r.secretName } : null;
    default:
      return null;
  }
}

// bindingsToAttach is the picked binding resources that are not live on the engine yet.
export function bindingsToAttach(): SourceInput[] {
  return pickedResources(setupModel().get())
    .filter((r) => !r.bound && r.unavailable === undefined)
    .map(attachInputFor)
    .filter((x): x is SourceInput => x !== null);
}

export interface ApplyResult {
  keysInstalled: boolean;
  attached: string[];
}

// applyWithDeployToken uses ONE deploy token value for the whole Apply: it installs the keys (install.ts
// installCeremonyKeys), drops the key material from this tab the moment the engine has it, waits for the
// engine to report the keys (install.ts waitForKeys, which records how the wait ended), then attaches the
// picked binding sources (POST /admin/sources/attach) and waits for the bindings to read live.
// The token is held in this call's local variable only and is never stored, logged or put in the draft.
// Re-running after a partial failure is safe: installed keys and live bindings are skipped.
export async function applyWithDeployToken(token: string, onStage: ApplyProgress = () => {}): Promise<ActionResult<ApplyResult>> {
  const engine = getEngine();
  if (!engine) return fail("no-engine", "No engine is connected.");
  if (!canDo("owner")) return fail("not-owner", gateReason("owner"));
  const t = token.trim();
  if (t === "") return fail("validation", "Paste the deploy token first.", "token");
  const start = setupModel().get();
  if (start.facts.accounts.length === 0) return fail("refused", "Connect your account first: the engine needs the read-only token to name its own account.");

  let keysInstalled = false;
  // One use of this token is counted the first time it reaches the engine in this press (the install, else the
  // attach), so the revoke instruction can ask for every token pasted.
  let tokenCounted = false;
  const countToken = (): void => {
    if (tokenCounted) return;
    tokenCounted = true;
    const d = setupModel().get().draft;
    setupModel().update({ deployTokenUsed: true, deployTokenRevoked: false, deployTokenUses: d.deployTokenUses + 1 });
    noteDeployTokenUsed();
  };
  if (!start.facts.keysReady) {
    let result = currentCeremony();
    // An install whose answer never came back (m3: the response was lost, often to the version rollout the
    // install itself causes) may have landed. Ask the engine before sending the keys again: a second install
    // over keys that are in would be refused as a re-key, and the tab would hold keys that open nothing.
    if (result !== null && start.draft.keysInstallUnconfirmed && (await engineHoldsKeys(engine)) === true) {
      clearSensitiveState();
      setupModel().update({ keysSent: true, keysInstallUnconfirmed: false });
      result = null;
    }
    // Keys this setup already sent: the engine accepted them and the tab dropped them, so this press only waits
    // for the engine to report them again.
    const alreadySent = result === null && setupModel().get().draft.keysSent;
    if (result === null && !alreadySent) return fail("refused", "Generate and save your keys first. Keys made before a reload are gone from this tab.");
    // Keys made for the other posture never reach the engine (B1): the receipt, the engine's record and the
    // restore-test cadence all follow the posture the user confirmed.
    if (result !== null && !ceremonyMatchesPosture(result, setupModel().get().draft.posture)) return fail("refused", POSTURE_MISMATCH);
    if (result !== null) {
      onStage("install-keys", "start");
      setupModel().update({ keysInstallUnconfirmed: true });
      let installed: Awaited<ReturnType<typeof installCeremonyKeys>> | null = null;
      try {
        installed = await installCeremonyKeys(engine, result, t);
      } catch (e) {
        const fault = engineFaultOutcome(e);
        if (fault === "unauthorised") {
          recordOnboardingStep("install", "unauthorised");
          setupModel().update({ keysInstallUnconfirmed: false });
          // Signing in again clears the keys from this tab (store.ts clearSessionData), so a retry needs new keys.
          return unauthorised("Your session ended before the install finished. Nothing was installed, and signing in again clears the keys from this tab. Delete the key files you downloaded, sign in, then make new keys.");
        }
        if (fault !== null) recordOnboardingStep("install", fault);
        // Nothing came back that says what happened (a transport fault, or a fetch the page cancelled). Ask the
        // engine: when it holds keys, the install landed.
        const unknown = fault === "transport-error" || fault === null;
        if (unknown && (await engineHoldsKeys(engine)) === true) {
          installed = null;
        } else {
          // A definite refusal: nothing was installed and the keys are still in this tab for a retry.
          if (!unknown) setupModel().update({ keysInstallUnconfirmed: false });
          return fail("refused", isStepUpRequired(e) ? stepUpAwareText(e) : e instanceof Error ? e.message : "The install did not complete. Try again.", "token");
        }
      }
      // The engine holds the keys: drop the in-memory material now. The browser reclaims the bytes by garbage
      // collection at a later time; nothing here scrubs them on demand.
      clearSensitiveState();
      keysInstalled = true;
      countToken();
      // The re-wrap report, as the engine gave it (B3). null when the answer was lost: Finish then asks the user to
      // save the credentials again rather than assume they are encrypted.
      const rw = installed?.rewrap;
      setupModel().update({
        keysSent: true,
        keysInstallUnconfirmed: false,
        rewrap: rw !== undefined ? { ok: rw.ok, wrapped: rw.wrapped, leftPlaintext: rw.leftPlaintext, failedClasses: [...rw.failedClasses] } : null,
      });
      onStage("install-keys", "done");
    } else onStage("install-keys", "skipped");
    onStage("confirm-keys", "start");
    const wait = await waitForKeys(engine);
    if (wait.ending === "unauthorised") return unauthorised("Your session ended while the engine loaded the keys. They were sent. Sign in again and check Keys before you make new ones.");
    if (wait.ending === "cancelled") return fail("cancelled", "The check stopped when you left the page. The keys were sent. Do not make new keys.");
    if (wait.ending !== "ready") {
      await afterFactChange();
      return fail("timeout", keysWaitMessage(wait));
    }
    onStage("confirm-keys", "done");
  } else {
    onStage("install-keys", "skipped");
    onStage("confirm-keys", "skipped");
  }

  const inputs = bindingsToAttach();
  let attached: string[] = [];
  if (inputs.length > 0) {
    onStage("attach-sources", "start", { done: 0, total: inputs.length });
    let res: Awaited<ReturnType<typeof engine.changeBindings>> | null = null;
    // The key install rolls a new Worker version, and an attach straight after it was refused once in the live
    // proof (1 of 6), then accepted when the same token was pasted again. So an attach refused in the same press
    // as the install is tried once more after a pause, with the same token, before the refusal is shown.
    for (let attempt = 0; res === null; attempt++) {
      try {
        res = await engine.changeBindings(t, inputs as AttachSourceInput[], []);
      } catch (e) {
        if (isUnauthorised(e)) return unauthorised();
        if (keysInstalled && attempt === 0 && !isStepUpRequired(e)) {
          await sleep(ATTACH_RETRY_MS);
          continue;
        }
        countToken();
        await afterFactChange();
        const prefix = keysInstalled ? "Your keys are installed. The sources did not attach: " : "";
        return fail("refused", `${prefix}${errMsg(e)}`, "token");
      }
    }
    countToken();
    if (isOwnerActionQueuedResult(res)) {
      surfaceQueuedOwnerAction("Attaching these sources");
      await afterFactChange();
      return fail("queued", "A second owner must approve the attach. Then paste a deploy token again.");
    }
    attached = res.value.attached;
    onStage("attach-sources", "done", { done: attached.length, total: inputs.length });
    onStage("confirm-sources", "start", { done: 0, total: inputs.length });
    const wanted = inputs.map((i) => i.binding);
    const live = await pollUntil(async () => {
      const disc = await engine.discoverSources();
      const bound = new Set([...disc.bound.kv, ...disc.bound.r2, ...disc.bound.d1, ...disc.bound.secrets]);
      const n = wanted.filter((b) => bound.has(b)).length;
      onStage("confirm-sources", "start", { done: n, total: wanted.length });
      return n === wanted.length;
    }, POLL_MS, POLL_TRIES);
    await afterFactChange();
    if (!live) return fail("timeout", "The engine attached the sources and they are not live yet. Check again in a minute.");
    onStage("confirm-sources", "done", { done: wanted.length, total: wanted.length });
  } else {
    onStage("attach-sources", "skipped");
    onStage("confirm-sources", "skipped");
    await afterFactChange();
  }
  onStage("done", "done");
  return ok({ keysInstalled, attached });
}

// markDeployTokenRevoked records the user's "I have revoked it" tick (it stays on the page until ticked, and
// the Finish receipt reports it).
export function markDeployTokenRevoked(revoked: boolean): void {
  setupModel().update({ deployTokenRevoked: revoked });
  if (revoked) clearRevokeReminder();
}

// SelfDeployPlan is the no-token route (own wrangler or CI) as data: the secret commands with their values
// (only while this tab holds the keys; a reload drops them and the commands then show without values), the binding
// stanzas for wrangler.toml, and the deploy command. After running it, refreshDiscovery() reads the result.
export interface SelfDeployPlan {
  secrets: Array<{ command: string; label: string; value: string | null }>;
  stanzas: string;
  deployCommand: string;
}
export function selfDeployPlan(): SelfDeployPlan {
  const r = currentCeremony();
  const put = (name: string, label: string, value: string | undefined): { command: string; label: string; value: string | null } => ({ command: `npx wrangler secret put ${name}`, label, value: value ?? null });
  const secrets = [
    put("SIGNER_PRIVATE", "The signer private (the engine signs each run with it)", r?.signer.privateB64),
    put("BREAK_GLASS_PUBLIC", "The break-glass public (safe to show)", r?.breakGlass.recipientPublicB64),
    ...(r?.operational
      ? [put("OPERATIONAL_PUBLIC", "The operational public", r.operational.recipientPublicB64), put("OPERATIONAL_PRIVATE", "The operational private (can decrypt archives; your engine holds it)", r.operational.identityB64)]
      : []),
    put("CONFIG_RECIPIENT_PRIVATE", "The configuration recovery private (opens only this engine's own sealed configuration export)", r?.configRecipient.identityB64),
    put("CONFIG_RECIPIENT_PUBLIC", "The configuration recovery public", r?.configRecipient.recipientPublicB64),
    put("CONFIG_WRAP_KEY", "The configuration wrap key (encrypts your saved credentials)", r?.configWrapKeyB64),
  ];
  return { secrets, stanzas: bindingsToAttach().map((i) => wranglerStanza(i)).join("\n\n"), deployCommand: deployCommand() };
}

// ---- First backup ---------------------------------------------------------------------------------------

export interface CreateResult {
  created: string[];
  queued: number;
  failures: Array<{ name: string; reason: string }>;
}

// planDownpipes assembles the downpipes the picks become, with the user's own names: one per binding source
// (ticked secrets bundle into one, bulk-assemble.ts:36), one per configuration pick, one per Workers, Stream
// or Images account. Schedule, retention and restore-test cadence from the draft, checked against the posture.
export function planDownpipes(): ActionResult<Array<{ dp: Downpipe; label: string }>> {
  const s = setupModel().get();
  const d = s.draft;
  // The posture the engine will run with: confirmed here, or set by keys already on the engine.
  const posture = effectivePosture(s.facts, d);
  const sched = SCHEDULES.find((x) => x.id === d.schedule);
  if (!sched) return fail("validation", "Choose a schedule.", "schedule");
  // The two dated presets arm enforce:true, which the engine's addDownpipe re-checks against
  // restore.apply beyond downpipe.write (retentionWidensPrune). A caller without it gets the same
  // capGateReason here that gates the downpipe editor's own Enforce checkbox, so the preset reads as
  // unavailable rather than creating downpipes the engine will 403 on the retention arm.
  const armReason = canCap("restore.apply") ? undefined : capGateReason("restore.apply");
  const ret = retentionChoices(posture, armReason).find((x) => x.id === d.retention);
  if (!ret || ret.unavailable !== undefined) return fail("validation", ret?.unavailable ?? "Choose how long to keep runs.", "retention");
  const rt = restoreTestChoices(posture).find((x) => x.id === (d.restoreTest ?? (posture === "operational" ? "weekly" : "off")));
  if (!rt || rt.unavailable !== undefined) return fail("validation", rt?.unavailable ?? "Choose a restore test cadence.", "restoreTest");
  const picks = pickedResources(s).filter((r) => r.unavailable === undefined);
  if (picks.length === 0) return fail("validation", "Pick at least one source on the Protect step.", "picks");
  const cadence = sched.seconds;
  const nameFor = (r: Resource): string => (d.names[r.key] ?? "").trim() || r.name;
  // The operator's own retention replaces the preset (operational posture only, as the presets are).
  const custom = d.retentionCustom !== null && posture === "operational" ? d.retentionCustom : null;
  if (d.retentionCustom !== null && custom === null) return fail("validation", CUSTOM_RETENTION_UNAVAILABLE, "retention");
  // The operator's own enforce toggle arms the same widening edit as the two dated presets. The sheet
  // disables the checkbox for a caller without restore.apply, but this is the one place every path reads
  // the draft (a single create, the bulk create and the First backup preview all call planDownpipes), so
  // it is where the gate must hold regardless of how the draft got here.
  if (custom?.enforce === true && armReason !== undefined) return fail("validation", armReason, "retention");
  const policy = custom !== null ? { ...(custom.keepRuns !== undefined ? { keepRuns: custom.keepRuns } : {}), ...(custom.keepDays !== undefined ? { keepDays: custom.keepDays } : {}), ...(custom.enforce ? { enforce: true as const } : {}) } : ret.policy;
  const shared = { restoreTestCadenceSeconds: rt.seconds, ...(policy ? { retention: { ...policy } } : {}) };
  const byBinding = new Map(picks.filter((r) => r.binding !== undefined).map((r) => [r.binding!, r]));
  const entries = [...byBinding.values()].map((r) => [r.binding!, r.kind as "kv" | "r2" | "d1" | "secrets"] as [string, "kv" | "r2" | "d1" | "secrets"]);
  const bindingItems = assembleBulkDownpipes(entries, cadence, []).map((a) => {
    const res = byBinding.get(a.label);
    // The user's own name, not the SRC_* binding (CONTRACT requirement 5), or the name typed for it at the
    // first backup (draft.names). The secrets bundle keeps its name.
    const name = res ? nameFor(res) : "";
    return res ? { label: name, dp: { ...a.dp, id: slugId(name), name } } : a;
  });
  const multi = s.facts.accounts.length > 1;
  const cfAccounts = picks.filter((r) => r.kind === "cf-config" && r.id === undefined).map((r) => ({ accountId: r.accountId, accountName: r.accountName, multiAccount: multi }));
  const cfZones = picks.filter((r) => r.kind === "cf-config" && r.id !== undefined).map((r) => ({ zoneId: r.id!, zoneName: r.name.replace(/: zone configuration$/, ""), accountId: r.accountId }));
  const cfItems = assembleCfConfigBulk(cfZones, cfAccounts, "account-and-zone", [], cadence, []);
  const tokenItems = picks
    .filter((r) => r.kind === "workers" || r.kind === "stream" || r.kind === "images")
    .map((r) => ({ label: nameFor(r), dp: { id: slugId(nameFor(r)), name: nameFor(r), cadenceSeconds: cadence, enabled: true, source: { type: r.kind as "workers" | "stream" | "images", accountId: r.accountId, include: [], exclude: [], ...(d.mediaContent.includes(r.key) && r.kind !== "workers" ? { includeContent: true } : {}) } } as Downpipe }));
  return ok([...bindingItems, ...cfItems, ...tokenItems].map((i) => ({ label: i.label, dp: { ...i.dp, ...shared } })));
}

// createDownpipes creates the planned downpipes: one through addDownpipe, several through the shared bulk loop
// (lib/bulk-create.ts runBulkCreate, the wizard's path). Token-read types are first ADDED on the engine
// (POST /admin/sources/enable), as the Sources screen does, so they also show under Sources afterwards.
export async function createDownpipes(): Promise<ActionResult<CreateResult>> {
  const engine = getEngine();
  if (!engine) return fail("no-engine", "No engine is connected.");
  if (!canCap("downpipe.write")) return fail("not-owner", capGateReason("downpipe.write"));
  const plan = planDownpipes();
  if (!plan.ok) return plan;
  const items = plan.data;
  const tokenTypes = [...new Set(items.map((i) => i.dp.source.type).filter((t) => t === "cf-config" || t === "workers" || t === "stream" || t === "images"))];
  if (tokenTypes.length > 0) {
    try {
      const disc = await engine.discoverSources();
      await engine.setEnabledSources([...new Set([...(disc.addedSources ?? []), ...tokenTypes])]);
    } catch (e) {
      if (isUnauthorised(e)) return unauthorised();
      // Advisory: the engine does not gate a downpipe on this list; the Sources screen reads it.
    }
  }
  let queued = 0;
  let failures: Array<{ name: string; reason: string }> = [];
  try {
    if (items.length === 1) {
      const res = await engine.addDownpipe(items[0]!.dp);
      if (res.status === "pending") queued = 1;
    } else {
      const out = await runBulkCreate({ bulk: (dps) => engine.bulkAddDownpipes(dps), single: (dp) => engine.addDownpipe(dp) }, items);
      if (out.halted) return unauthorised();
      queued = out.queued;
      failures = out.failures;
    }
  } catch (e) {
    if (isUnauthorised(e)) return unauthorised();
    return fail("refused", errMsg(e));
  }
  if (queued > 0) surfacePendingChange(queued === 1 ? "downpipe" : "set of downpipes");
  const failed = new Set(failures.map((f) => f.name));
  const ids = items.filter((i) => !failed.has(i.label)).map((i) => i.dp.id);
  setupModel().update({ createdDownpipeIds: [...new Set([...setupModel().get().draft.createdDownpipeIds, ...ids])] });
  await afterFactChange();
  const created = ids.filter((id) => setupModel().get().facts.downpipes.some((dp) => dp.config.id === id));
  if (created.length === 0 && queued === 0) return fail("refused", failures[0]?.reason ?? "No downpipe was created.");
  return ok({ created, queued, failures });
}

// What runNow records for a downpipe whose run the engine skipped: it answers with no run id when a run of that
// downpipe is still in flight.
const RUN_SKIPPED = "The engine skipped the run. It may already be running.";

// runNow starts a run of each given downpipe (default: every downpipe this setup created). The draft records
// every run it started (the run view watches them, in this tab or a new one), the first of them, which the
// receipt names, and each downpipe it did not start, with the engine's reason. A run started again replaces
// them: the first backup is the last attempt. With `again` (the run view's "Run it again"), only the given
// downpipes are replaced, and the record of the others stands. When no run starts, nothing is recorded and the
// first reason is returned. A 401 returns at once.
export async function runNow(ids?: string[], opts: { again?: boolean } = {}): Promise<ActionResult<Array<{ downpipeId: string; runId: string }>>> {
  const engine = getEngine();
  if (!engine) return fail("no-engine", "No engine is connected.");
  if (!canCap("run.trigger")) return fail("not-owner", capGateReason("run.trigger"));
  const want = ids ?? setupModel().get().draft.createdDownpipeIds;
  if (want.length === 0) return fail("validation", "Create a downpipe first.");
  const started: Array<{ downpipeId: string; runId: string }> = [];
  const notStarted: Array<{ downpipeId: string; reason: string }> = [];
  for (const id of want) {
    try {
      const r = await engine.trigger(id);
      if ("runId" in r) started.push({ downpipeId: id, runId: r.runId });
      else notStarted.push({ downpipeId: id, reason: RUN_SKIPPED });
    } catch (e) {
      if (isUnauthorised(e)) return unauthorised();
      notStarted.push({ downpipeId: id, reason: errMsg(e) });
    }
  }
  if (started.length === 0) return fail("refused", notStarted[0]?.reason ?? RUN_SKIPPED);
  const d = setupModel().get().draft;
  const tried = new Set(want);
  const runs = [...started, ...(opts.again ? d.startedRuns.filter((r) => !tried.has(r.downpipeId)) : [])];
  const missed = [...notStarted, ...(opts.again ? d.notStarted.filter((n) => !tried.has(n.downpipeId)) : [])];
  setupModel().update({ firstRun: runs[0]!, startedRuns: runs, notStarted: missed });
  return ok(started);
}

// RunStage is what the run ring shows, in order. "starting" (allocated, nothing read yet), "reading" (records
// counted), "sealing" (segments written), then one ending: "sealed" (ok, and the engine verified the seal),
// "unverified" (ok with no verify-at-seal verdict: the engine attaches the verdict when the run completes, so
// its absence means VERIFY_AT_SEAL is off), or "failed" (failed, abandoned, or a suspect seal). The engine
// writes the counts when it settles a slice; a UI must not invent stages the ring does not show.
export type RunStage = "starting" | "reading" | "sealing" | "sealed" | "unverified" | "failed";
export interface RunProgress {
  stage: RunStage;
  entry: RunHistoryEntry | null;
  message?: string;
}

export function runStageOf(e: RunHistoryEntry | null): RunStage {
  if (e === null) return "starting";
  if (e.status === "failed" || e.status === "abandoned") return "failed";
  if (e.status === "ok") {
    if (e.sealVerification?.status === "verified") return "sealed";
    if (e.sealVerification?.status === "suspect") return "failed";
    return "unverified";
  }
  if ((e.segmentsWritten ?? 0) > 0 || (e.archiveBytesWritten ?? 0) > 0) return "sealing";
  if ((e.recordCount ?? 0) > 0) return "reading";
  return "starting";
}

// watchRun polls the downpipe's run ring (GET /admin/history?id=, the Runs screen's read) every intervalMs
// and reports each stage change. It ends on "sealed", "unverified" or "failed", after maxMs, or on stop(). A
// run still in flight at the bound ends in its last stage, which a UI must not call sealed.
export function watchRun(
  downpipeId: string,
  runId: string,
  onStage: (p: RunProgress) => void,
  opts: { intervalMs?: number; maxMs?: number } = {},
): { stop: () => void; done: Promise<RunProgress> } {
  const intervalMs = opts.intervalMs ?? 1000;
  const maxMs = opts.maxMs ?? 15 * 60 * 1000;
  let stopped = false;
  const done = (async (): Promise<RunProgress> => {
    const engine = getEngine();
    let last: RunProgress = { stage: "starting", entry: null };
    if (!engine) return { ...last, stage: "failed", message: "No engine is connected." };
    const t0 = Date.now();
    let lastStage: RunStage | null = null;
    while (!stopped && Date.now() - t0 < maxMs) {
      try {
        const ring = await engine.listHistory(downpipeId);
        setupModel().setRuns(downpipeId, ring);
        const entry = ring.find((e) => e.runId === runId) ?? null;
        last = { stage: runStageOf(entry), entry, ...(entry?.error ? { message: entry.error } : {}) };
        if (last.stage !== lastStage) {
          lastStage = last.stage;
          onStage(last);
        }
        if (last.stage === "sealed" || last.stage === "unverified" || last.stage === "failed") break;
      } catch (e) {
        if (isUnauthorised(e)) {
          unauthorised();
          return { stage: "failed", entry: null, message: "Your session ended." };
        }
      }
      await sleep(intervalMs);
    }
    if (last.stage === "sealed" || last.stage === "unverified") await afterFactChange();
    return last;
  })();
  return { stop: () => { stopped = true; }, done };
}

// ---- Optional: team and restore approval -------------------------------------------------------------------

// grantRole stores a role for a teammate (POST /admin/roles, step-up gated), the same call the Access roles
// screen makes (screens/access-security/roles-members.ts). A queued grant waits for a second approver.
export async function grantRole(email: string, role: Role): Promise<ActionResult<{ email: string; role: Role; queued: boolean; inviteToken?: string }>> {
  const engine = getEngine();
  if (!engine) return fail("no-engine", "No engine is connected.");
  if (!canCap("roles.write")) return fail("not-owner", capGateReason("roles.write"));
  const e = email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return fail("validation", "Enter a valid email address.", "email");
  try {
    const res = await engine.setRole(e, role);
    const queued = res.status === "pending";
    setupModel().update({ grants: [...setupModel().get().draft.grants, { email: e, role, queued }] });
    const token = res.status === "applied" ? (res.value as { inviteToken?: unknown }).inviteToken : undefined;
    return ok({ email: e, role, queued, ...(typeof token === "string" ? { inviteToken: token } : {}) });
  } catch (err) {
    if (isUnauthorised(err)) return unauthorised();
    return fail("refused", isStepUpRequired(err) ? stepUpAwareText(err) : errMsg(err));
  }
}

// EngineCheck is one row of the read-only engine check: the keys, then each preflight item the engine has
// verified or seen fail, failures first (preflight.ts orderPreflightItems). Items it has not observed are left
// out: only an engine-observed "verified" reads as a pass (preflightItemPresentation, no fabricated green).
export interface EngineCheck {
  name: string;
  ok: boolean;
  // The honest word for the row's state ("verified" or "failed").
  word: string;
  detail: string;
}
export async function readEngineChecks(): Promise<ActionResult<EngineCheck[]>> {
  const engine = getEngine();
  if (!engine) return fail("no-engine", "No engine is connected.");
  try {
    const [st, pf] = await Promise.all([engine.status(), engine.preflight().catch(() => null)]);
    const keysIn = st.signerConfigured && st.breakGlassConfigured;
    const out: EngineCheck[] = [{ name: "Keys on your engine", ok: keysIn, word: keysIn ? "present" : "not installed", detail: keysIn ? "The signer and offline keys are present." : "The keys are not installed yet." }];
    for (const it of orderPreflightItems(pf?.items ?? [])) {
      if (it.status !== "verified" && it.status !== "failed") continue;
      out.push({ name: it.name, ok: it.status === "verified", word: preflightItemPresentation(it.status).word, detail: `Requires ${it.requires}. Observed: ${it.evidence}` });
    }
    return ok(out);
  } catch (e) {
    // The completion readiness read failed. Recorded on the "finish" step with the same total classifier every
    // setup call uses, because the engine's own logs may hold the other half; a null class is an aborted read.
    const fault = engineFaultOutcome(e);
    if (fault !== null) recordOnboardingStep("finish", fault);
    if (isUnauthorised(e)) return unauthorised();
    return fail("refused", errMsg(e));
  }
}

export function skipTeam(): void {
  setupModel().update({ teamSkipped: true });
}

// setRestoreApproval stores the restore-approval policy (POST /admin/config/restore-approval-policy). "later"
// sends nothing: the engine default (off) stands. A sole identity cannot require a second approver.
//
// A "solo" choice is a DISARM, which takes the engine's asymmetric off switch: an attributable owner's
// disarm queues for a second owner rather than applying, so the requirement stays ON. This is reported as a
// queued action, the same as every other gated owner mutation in this flow, rather than storing "solo" as if
// the requirement had already gone off.
export async function setRestoreApproval(choice: "solo" | "second" | "later"): Promise<ActionResult<{ requireRestoreApproval: boolean | null }>> {
  if (choice === "later") {
    setupModel().update({ restoreApproval: "later" });
    return ok({ requireRestoreApproval: null });
  }
  const engine = getEngine();
  if (!engine) return fail("no-engine", "No engine is connected.");
  if (!canDo("owner")) return fail("not-owner", gateReason("owner"));
  if (choice === "second" && caller()?.isOnlyOwner === true) return fail("refused", "You are the only Owner. Invite a second Owner first. Approvers do not count for this.");
  try {
    const res = await engine.setRestoreApprovalPolicy(choice === "second");
    if (isOwnerActionQueuedResult(res)) {
      surfaceQueuedOwnerAction("Turning off the second-approver requirement for restores");
      return fail("queued", "A second Owner must approve turning this off. The requirement stays on until then.");
    }
    setupModel().update({ restoreApproval: choice });
    await afterFactChange();
    return ok({ requireRestoreApproval: res.value.requireRestoreApproval });
  } catch (err) {
    if (isUnauthorised(err)) return unauthorised();
    return fail("refused", isStepUpRequired(err) ? stepUpAwareText(err) : errMsg(err));
  }
}
