// The setup model's ACTIONS, part one: connect, destination and keys. Each is a thin wrapper over the
// existing EngineClient call and the existing safety helpers, returning ActionResult instead of painting
// anything, so every concept UI completes the same way. Part two (apply, first backup, optional steps) is
// actions-apply.ts; both are re-exported from index.ts.
//
// Rules every action keeps (see ../../../design notes in README.md):
//   - owner guards run first (canDo/canCap, the client mirror; the engine is the control);
//   - requireChange and the queued-owner-action path are the existing ones, unchanged;
//   - a 401 is RETURNED as { kind: "unauthorised" } and the sign-in redirect is scheduled on the next task,
//     so a caller that repaints synchronously after its await paints before the tab leaves;
//   - a token or credential is used for the one call and never stored, logged or put in the draft.

import { isOwnerActionQueuedResult } from "../../api.ts";
import { SESSION_ENDED_ACTION } from "../../components/error-view.ts";
import { requireChange } from "../../components/require-change.ts";
import { identityFile, isCeremonyResult, recipientFile, runKeyCeremony, signerPublicFile, type CeremonyResult } from "../../keygen.ts";
import { recoverySheet } from "../../recovery-sheet.ts";
import { commitDestination, destinationInputFromValues, parseAssumeRolePolicy, parseAzureEntraPolicy, parseWormPolicy } from "../../screens/destination-submit.ts";
import { downloadCeremonyFiles, downloadText, errMessage, openRecoverySheetWith, recordCeremonyIntent, sheetParams } from "./ceremony-files.ts";
import { errMsg } from "../../screens/sources/shared.ts";
import { tokenVerifiedToast } from "../../screens/sources/token-entry.ts";
import { canDo, gateReason } from "../../screens/common.ts";
import { reportKeygenFault } from "../client-diag/capability-faults.ts";
import { recordDiscoveryConnect, recordOnboardingStep } from "../client-diag/ring.ts";
import { makeSplitSignoffs, type CustodyMetadata } from "../custody.ts";
import { isUnauthorised } from "../errors.ts";
import { type HybridRecipientPrivate, identityFingerprint, parseIdentityFile } from "../keydecap.ts";
import { goSignedOut, requestSetupRefresh } from "../nav.ts";
import { surfaceQueuedOwnerAction } from "../pending-change-toast.ts";
import { POSTURE_ACK_STATEMENTS, postureAckStatementHash, type PostureChoice } from "../posture-ack-statements.ts";
import { getCeremony, getEngine, setCeremony } from "../store.ts";
import { ceremonyFileNames, pricingDefaults } from "./inventory.ts";
import { engineFaultOutcome } from "./install.ts";
import { setupModel } from "./model.ts";

// ---- result shape ---------------------------------------------------------------------------------------

export type ActionErrorKind =
  | "not-owner" // the caller lacks the role or capability (message is the standard gate reason)
  | "no-engine" // no engine client
  | "validation" // an input is missing or malformed; `field` names it
  | "refused" // the engine (or the browser) refused; message is the reason to show
  | "zero-accounts" // the token was accepted but sees no account
  | "queued" // dual control queued the change for a second owner; nothing applied yet
  | "cancelled" // the user dismissed a confirm or the change-reference prompt; nothing was sent
  | "unauthorised" // the session ended; the tab leaves for sign-in on the next task
  | "keygen-failed" // the in-browser ceremony produced no keys
  | "timeout"; // the engine accepted the change and has not reported it yet

export interface ActionError {
  kind: ActionErrorKind;
  message: string;
  field?: string;
}
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}
export function fail(kind: ActionErrorKind, message: string, field?: string): { ok: false; error: ActionError } {
  return { ok: false, error: { kind, message, ...(field !== undefined ? { field } : {}) } };
}

// leaveAfterPaint: the 401 half of paint-before-leave. The caller's continuation after `await action()` runs
// as a microtask; this runs on the next task, after it.
export function leaveAfterPaint(): void {
  setTimeout(() => goSignedOut(), 0);
}
export function unauthorised(message = SESSION_ENDED_ACTION): { ok: false; error: ActionError } {
  leaveAfterPaint();
  return fail("unauthorised", message);
}

// afterFactChange: a setup fact changed on the engine. Re-read it for the model and for the shell (strip,
// rail locks, gate) at once, so the progress model shows the step done without a navigation.
export async function afterFactChange(): Promise<void> {
  await Promise.allSettled([setupModel().refresh(), requestSetupRefresh()]);
}

// currentCeremony narrows the store's ceremony material (typed unknown there).
export function currentCeremony(): CeremonyResult | null {
  const c = getCeremony();
  return isCeremonyResult(c) ? c : null;
}

// ---- Welcome ----------------------------------------------------------------------------------------------

export function startSetup(): void {
  setupModel().update({ started: true });
}

// ---- Connect ----------------------------------------------------------------------------------------------

// verifyToken sends the read-only discovery token once (POST /admin/sources/discovery-token, verified live by
// the engine before it stores it) and clears nothing locally because nothing was kept. Mirrors
// screens/sources/token-entry.ts:66-150 step for step.
export async function verifyToken(value: string): Promise<ActionResult<{ accountsSeen: number }>> {
  const engine = getEngine();
  if (!engine) return fail("no-engine", "No engine is connected.");
  if (!canDo("owner")) return fail("not-owner", gateReason("owner"));
  const token = value.trim();
  if (token === "") return fail("validation", "Paste the token first.", "token");
  const cr = await requireChange(engine, "Set the account-browsing token", "discovery-token-set");
  if (!cr.proceed) return fail("cancelled", "Nothing was sent.");
  let res: Awaited<ReturnType<typeof engine.setDiscoveryToken>>;
  try {
    res = await engine.setDiscoveryToken(token, cr.change ?? undefined);
  } catch (e) {
    if (isUnauthorised(e)) return unauthorised();
    recordDiscoveryConnect("refused");
    return fail("refused", errMsg(e), "token");
  }
  if (isOwnerActionQueuedResult(res)) {
    surfaceQueuedOwnerAction("Setting the account-browsing token");
    return fail("queued", "A second owner must approve the token before it is stored.");
  }
  const seen = res.value.accountsSeen?.length ?? 0;
  recordDiscoveryConnect(seen > 0 ? "verified-accounts-seen" : "verified-zero-accounts");
  await afterFactChange();
  if (seen === 0) return fail("zero-accounts", tokenVerifiedToast(0).message, "token");
  return ok({ accountsSeen: seen });
}

// refreshDiscovery re-reads the account catalogue (and every other fact) without sending anything.
export async function refreshDiscovery(): Promise<ActionResult<{ resources: number }>> {
  await setupModel().refresh();
  const s = setupModel().get();
  if (s.facts.readError !== null) return fail("refused", s.facts.readError);
  return ok({ resources: s.facts.groups.reduce((n, g) => n + g.resources.length, 0) });
}

// removeToken clears the read-only token (POST the token as null), the Sources screen's "Remove token"
// (sources/account.ts), with the same change reference and queued-owner handling. The caller confirms first.
export async function removeToken(): Promise<ActionResult<null>> {
  const engine = getEngine();
  if (!engine) return fail("no-engine", "No engine is connected.");
  if (!canDo("owner")) return fail("not-owner", gateReason("owner"));
  const cr = await requireChange(engine, "Remove the account-browsing token", "discovery-token-clear");
  if (!cr.proceed) return fail("cancelled", "Nothing was sent.");
  try {
    const res = await engine.setDiscoveryToken(null, cr.change ?? undefined);
    if (isOwnerActionQueuedResult(res)) {
      surfaceQueuedOwnerAction("Removing the account-browsing token");
      return fail("queued", "A second owner must approve the removal. The token stays until then.");
    }
  } catch (e) {
    if (isUnauthorised(e)) return unauthorised();
    return fail("refused", errMsg(e));
  }
  await afterFactChange();
  return ok(null);
}

// readAccountChoice reads which of the token's accounts are browsed and which is the engine's own (the
// presence-only discovery status; never the token).
export async function readAccountChoice(): Promise<ActionResult<{ seen: Array<{ id: string; name: string }>; selected: string[]; engineAccountId: string | null }>> {
  const engine = getEngine();
  if (!engine) return fail("no-engine", "No engine is connected.");
  try {
    const st = await engine.getDiscoveryStatus();
    return ok({ seen: st.accountsSeen ?? [], selected: st.selected ?? [], engineAccountId: st.engineAccountId ?? null });
  } catch (e) {
    if (isUnauthorised(e)) return unauthorised();
    return fail("refused", errMsg(e));
  }
}

// chooseAccounts saves the browsed accounts and the engine's own account, the Sources account chooser's
// "Save accounts" (sources/account.ts renderAccountChooser), with the same change reference and queue path.
export async function chooseAccounts(selected: string[], engineAccountId: string | null): Promise<ActionResult<null>> {
  const engine = getEngine();
  if (!engine) return fail("no-engine", "No engine is connected.");
  if (!canDo("owner")) return fail("not-owner", gateReason("owner"));
  if (selected.length === 0) return fail("validation", "Tick at least one account to browse.", "accounts");
  const cr = await requireChange(engine, "Choose the browsed accounts", "discovery-accounts-set");
  if (!cr.proceed) return fail("cancelled", "Nothing was sent.");
  try {
    const res = await engine.setDiscoveryAccounts(selected, engineAccountId, cr.change ?? undefined);
    if (isOwnerActionQueuedResult(res)) {
      surfaceQueuedOwnerAction("Changing the browsed accounts");
      return fail("queued", "A second owner must approve the change. Nothing changed yet.");
    }
  } catch (e) {
    if (isUnauthorised(e)) return unauthorised();
    return fail("refused", errMsg(e));
  }
  await afterFactChange();
  return ok(null);
}

// ---- Destination ------------------------------------------------------------------------------------------

// The credentials are arguments, never draft: they reach the engine in the one POST and are dropped.
export interface DestinationCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  externalId?: string;
}

// saveDestination builds the destination from the draft plus the credentials and saves it through the SAME
// commit path as the Destinations form (screens/destination-submit.ts commitDestination): the compliance
// confirm, requireChange, the live reach-write-remove probe in the engine, the queued-owner-action path. Storage
// pricing is the provider preset (inventory.ts pricingDefaults), exactly what the form sends unedited, unless
// the draft holds the operator's own rates (draft.pricing), which go as source "operator".
export async function saveDestination(creds: DestinationCredentials): Promise<ActionResult<{ bucket: string }>> {
  const engine = getEngine();
  if (!engine) return fail("no-engine", "No engine is connected.");
  if (!canDo("owner")) return fail("not-owner", gateReason("owner"));
  const s = setupModel().get();
  const d = s.draft;
  const provider = d.provider;
  const bucket = d.bucket.trim();
  if (bucket === "") return fail("validation", "Choose or type a bucket.", "bucket");
  const r2AccountId = d.otherAccount || s.facts.engineAccountId === null ? d.r2AccountId.trim() : s.facts.engineAccountId;
  if (provider === "r2" && r2AccountId === "") return fail("validation", "Type the bucket's Cloudflare Account ID.", "r2AccountId");
  if (provider !== "r2" && !/^https:\/\/[^\s]+$/.test(d.endpoint.trim())) return fail("validation", "Endpoint must be an https URL with a host, for example https://s3.example.com.", "endpoint");
  if (creds.accessKeyId.trim() === "") return fail("validation", "Paste the access key ID.", "accessKeyId");
  if (creds.secretAccessKey === "") return fail("validation", "Paste the secret.", "secretAccessKey");

  const worm = parseWormPolicy(d.immutability, d.immutabilityDays.trim());
  if (!worm.ok) return fail("validation", worm.message, "immutabilityDays");
  const sts = parseAssumeRolePolicy(provider, d.roleArn, creds.externalId ?? "", d.stsDuration, d.region);
  if (!sts.ok) return fail("validation", sts.message, "roleArn");
  const entra = parseAzureEntraPolicy(provider, d.entraTenantId, d.entraClientId);
  if (!entra.ok) return fail("validation", entra.message, "entraTenantId");

  const input = destinationInputFromValues(
    provider,
    { bucket, r2AccountId, endpoint: d.endpoint.trim(), region: d.region.trim(), addressing: d.addressing, storageClass: d.storageClass, accessKeyId: creds.accessKeyId.trim(), secretAccessKey: creds.secretAccessKey },
    d.pricing !== null ? { ...d.pricing, currency: "USD", source: "operator" } : { ...pricingDefaults(provider), source: "preset" },
    worm.value,
    sts.value,
    entra.value,
  );
  const out = await commitDestination(engine, input, d.label.trim() || bucket, { confirmReplace: false }, () => {});
  switch (out.kind) {
    case "cancelled":
      return fail("cancelled", "Nothing was saved.");
    case "queued":
      surfaceQueuedOwnerAction("Saving this destination");
      return fail("queued", "A second owner must approve this destination before it is stored.");
    case "unauthorised":
      return unauthorised();
    case "refused":
      return fail("refused", out.message);
    case "saved":
      await afterFactChange();
      return ok({ bucket });
  }
}

// ---- Keys: posture ----------------------------------------------------------------------------------------

// acknowledgePosture records the chosen posture with the engine (POST /admin/keys/posture-acknowledgement,
// the verbatim statement, channel "onboarding", the engine's name for the first-run channel) and puts it in the
// draft, which is where the key ceremony reads it (generateKeys). The record is ADVISORY: the choice stands when
// the engine does not record it, and `recorded: false` with the engine's reason says so. Finish keeps that open
// until the statement is recorded (recordPostureAgain). An engine that already holds keys shows no fork.
export async function acknowledgePosture(choice: PostureChoice): Promise<ActionResult<{ recorded: boolean; reason: string | null; statementVersion: string; hashPrefix: string }>> {
  if (!canDo("owner")) return fail("not-owner", gateReason("owner"));
  const s = setupModel().get();
  if (s.facts.keysReady) return fail("refused", "Your engine already holds keys, so its posture is already set. Change it on the Keys screen.");
  const held = currentCeremony();
  if (held !== null && (held.operational !== null) !== (choice === "operational")) {
    return fail("refused", "Keys were generated for the other posture. Generate them again after you change it.");
  }
  const stmt = POSTURE_ACK_STATEMENTS[choice];
  const posted = await postStatement(choice);
  if (posted === "unauthorised") return unauthorised("Your session ended. Your posture was not recorded. Sign in again, then confirm it.");
  const hash = await postureAckStatementHash(stmt.text);
  const hashPrefix = hash.slice(0, "sha384:".length + 12);
  setupModel().update({ posture: choice, postureAcknowledged: true, postureRecorded: posted.recorded, postureRefusal: posted.reason, postureHashPrefix: hashPrefix });
  return ok({ recorded: posted.recorded, reason: posted.reason, statementVersion: stmt.version, hashPrefix });
}

// recordPostureAgain posts the statement of the posture this setup confirmed once more, after the engine did not
// record it (a refusal, a lost connection). It is allowed after the keys are installed, as the Keys screen's
// re-affirm is, but never for a posture other than the one the engine's keys set.
export async function recordPostureAgain(): Promise<ActionResult<{ recorded: boolean; reason: string | null }>> {
  if (!canDo("owner")) return fail("not-owner", gateReason("owner"));
  const s = setupModel().get();
  const choice = s.draft.posture;
  if (choice === null || !s.draft.postureAcknowledged) return fail("validation", "Choose and confirm a key posture first.", "posture");
  if (s.facts.keysReady && s.facts.enginePosture !== null && s.facts.enginePosture !== choice) {
    return fail("refused", "Your engine holds keys for the other posture, so this statement does not describe it. Re-affirm the posture on the Keys screen.");
  }
  const posted = await postStatement(choice);
  if (posted === "unauthorised") return unauthorised("Your session ended. The statement was not recorded. Sign in again, then record it.");
  setupModel().update({ postureRecorded: posted.recorded, postureRefusal: posted.reason });
  return ok(posted);
}

// postStatement is the one POST of a posture statement from setup. A 401 is its own answer, so the caller sends
// the tab to sign-in; every other refusal comes back with the engine's own reason.
async function postStatement(choice: PostureChoice): Promise<{ recorded: boolean; reason: string | null } | "unauthorised"> {
  const stmt = POSTURE_ACK_STATEMENTS[choice];
  const engine = getEngine();
  if (!engine) return { recorded: false, reason: "no engine is connected" };
  const res = await engine.acknowledgePosture({ posture: choice, statementVersion: stmt.version, acknowledgedText: stmt.text, channel: "onboarding" });
  if (res.ok) return { recorded: true, reason: null };
  if (res.status === 401) return "unauthorised";
  return { recorded: false, reason: res.reason ?? "no reason given" };
}

// ---- Keys: custody, generate, save, prove ------------------------------------------------------------------

// custodyForSheet is the PUBLIC custody metadata the first recovery sheet records (scheme, and N and M for the
// split with a blank sign-off table). null until a scheme is chosen.
export function custodyForSheet(): CustodyMetadata | undefined {
  const d = setupModel().get().draft;
  if (d.custody === null) return undefined;
  if (d.custody === "mofn-split") return { scheme: "mofn-split", n: d.splitShares, threshold: d.splitThreshold, signoffs: makeSplitSignoffs(d.splitShares) };
  return { scheme: d.custody, signoffs: [] };
}

export interface GeneratedKeys {
  files: string[];
  refused: string[];
  fingerprints: { breakGlass: string; operational: string | null; signer: string };
}

// generateKeys runs the in-browser ceremony: recordCeremonyIntent BEFORE the ceremony (so a ceremony that
// throws still leaves an audit trail), the posture from the store with the strict fallback, setCeremony, then
// the file downloads. A browser that refuses a file is a
// DELIVERY failure, not a ceremony failure: the keys exist and `refused` names the files to download again.
// The custody scheme chosen earlier rides into the first recovery sheet (downloadCeremonyFiles' custody).
export async function generateKeys(): Promise<ActionResult<GeneratedKeys>> {
  if (!canDo("owner")) return fail("not-owner", gateReason("owner"));
  const s = setupModel().get();
  if (s.facts.keysReady) return fail("refused", "Your engine already holds keys. Continue with them. To replace the signer and the break-glass key, use the Keys screen.");
  if (s.draft.posture === null || !s.draft.postureAcknowledged) return fail("validation", "Choose and confirm a key posture first.", "posture");
  if (s.draft.custody === null) return fail("validation", "Choose how you will keep the offline key first.", "custody");
  const pre = await keysPrecheck();
  if (pre !== null) return pre;
  recordCeremonyIntent();
  let result: CeremonyResult;
  try {
    // The posture comes from the draft, which survives a reload (a memory-only copy did not, and made
    // offline-only keys for a user who had confirmed the operational posture). An operational key is made
    // only on that explicit, confirmed choice.
    result = await runKeyCeremony({ operational: s.draft.posture === "operational" });
  } catch (err) {
    reportKeygenFault("key-ceremony");
    return fail("keygen-failed", `Could not generate keys in this browser (${errMessage(err)}). No key left this device.`);
  }
  setCeremony(result);
  const refused = downloadCeremonyFiles(result, custodyForSheet());
  if (refused.length === 0) recordOnboardingStep("generate", "ok");
  setupModel().update({ keysGenerated: true, refusedFiles: refused, keysSaved: false, keysSent: false, possession: null });
  return ok({
    files: ceremonyFileNames(result.operational ? "operational" : "break-glass-only"),
    refused,
    fingerprints: { breakGlass: result.breakGlass.fingerprint, operational: result.operational?.fingerprint ?? null, signer: result.signer.fingerprint },
  });
}

// keysPrecheck asks the engine, fresh, whether it already holds keys, before any key is made. The model's
// facts can be stale or unread (a setup-state read that failed leaves keysReady at its default, false), and
// keys made for an engine that already holds keys are files that open nothing: deploy.sh makes keys before
// the console first loads, so this is a real first-run state, not an edge. The engine also refuses to
// replace a signer without an explicit re-key (engine src/admin/router-keys.ts, POST /keys/install), so this
// check keeps the user from downloading files the install would then refuse. null means: no keys, go on.
//
// A failed read is recorded as its own step, "keys-precheck", not "install": this read installs nothing, and
// it must not coalesce with a genuine install row. It is classified by the same total classifier every
// setup call uses; a null class is an aborted read (a navigation or an unmount), which is not recorded.
async function keysPrecheck(): Promise<{ ok: false; error: ActionError } | null> {
  const engine = getEngine();
  if (!engine) return fail("no-engine", "No engine is connected.");
  let keysReady: boolean;
  try {
    keysReady = (await engine.getSetupState()).keysReady;
  } catch (err) {
    const fault = engineFaultOutcome(err);
    if (fault !== null) recordOnboardingStep("keys-precheck", fault);
    if (fault === "unauthorised") return unauthorised("Your session ended. No keys were made. Sign in again, then make your keys.");
    return fail("refused", "Could not confirm that your engine holds no keys yet, so no keys were made. Check that your engine is running, then try again.");
  }
  if (!keysReady) return null;
  await afterFactChange();
  return fail("refused", "Your engine already holds keys, so setup continues with them. No new keys were made. To replace the signer and the break-glass key, use the Keys screen.");
}

// redownloadFile offers one ceremony file again (the per-file re-download). Only while this tab holds keys.
export function redownloadFile(name: string): ActionResult<{ delivered: boolean }> {
  const r = currentCeremony();
  if (r === null) return fail("refused", "The keys are no longer in this tab. Generate them again.");
  const content =
    name === "identity.key" ? identityFile(r.breakGlass)
    : name === "recipient.pub" ? recipientFile(r.breakGlass)
    : name === "operational.pub" && r.operational ? recipientFile(r.operational)
    : name === "signer.pub" ? signerPublicFile(r.signer)
    : name === "recovery-sheet.txt" ? recoverySheet(r, sheetParams(r, custodyForSheet()))
    : null;
  if (content === null) return fail("validation", `There is no file called ${name}.`);
  const delivered = downloadText(name, content, name === "recovery-sheet.txt" ? "recovery-sheet" : "key-ceremony");
  if (delivered) {
    const left = setupModel().get().draft.refusedFiles.filter((f) => f !== name);
    setupModel().update({ refusedFiles: left });
  }
  return ok({ delivered });
}

// openRecoverySheet opens the printable sheet (public fingerprints only) in a new tab.
export function openRecoverySheet(): ActionResult<{ opened: boolean }> {
  const r = currentCeremony();
  if (r === null) return fail("refused", "The keys are no longer in this tab. The sheet you saved is the record.");
  return ok({ opened: openRecoverySheetWith(r, custodyForSheet()) });
}

// ceremonyMatchesPosture: the keys in this tab were made for the posture the draft confirms. Saved and Apply
// refuse keys that do not match, so the receipt, the engine's record and the restore-test cadence can never
// name a posture the installed keys do not have.
export function ceremonyMatchesPosture(r: CeremonyResult, posture: PostureChoice | null): boolean {
  return posture !== null && (r.operational !== null) === (posture === "operational");
}
export const POSTURE_MISMATCH = "The keys in this tab were made for the other posture. Make them again, then save the new files.";

// confirmKeysSaved records the user's "I have saved the files" (the step's done condition with the ceremony).
export function confirmKeysSaved(): ActionResult<null> {
  const r = currentCeremony();
  if (r === null) return fail("refused", "The keys are no longer in this tab. Generate them again.");
  if (!ceremonyMatchesPosture(r, setupModel().get().draft.posture)) return fail("refused", POSTURE_MISMATCH);
  const refused = setupModel().get().draft.refusedFiles;
  if (refused.length > 0) return fail("validation", `Save ${refused.join(", ")} first.`, "files");
  setupModel().update({ keysSaved: true });
  return ok(null);
}

// verifyIdentityFile is the optional proof of possession: the user supplies the identity.key they saved and
// the browser checks it derives the same public key as the one this ceremony made. It uses only the existing
// parse and fingerprint helpers (lib/keydecap.ts:136 identityFingerprint, :202 parseIdentityFile), so it
// adds no crypto: a key that derives the same public key IS the key, which proves possession without
// sealing a challenge (sealing would need a hybrid-KEM encapsulation the console does not have). The file is
// read in the browser, nothing is sent, and the parsed private bytes are zeroed before this returns.
export async function verifyIdentityFile(text: string): Promise<ActionResult<{ match: boolean }>> {
  if (currentCeremony() === null) return fail("refused", "The keys are no longer in this tab, so there is nothing to compare against.");
  let priv: HybridRecipientPrivate;
  try {
    priv = parseIdentityFile(text);
  } catch {
    return fail("validation", "That is not an identity.key file.", "identityFile");
  }
  return verifyRecoveredIdentity(priv);
}

// verifyRecoveredIdentity is the same proof for a key the reassembly card rebuilt from custodian shares and
// identity.key.enc (screens/restore-flow/reassembly.ts renderReassemblyCard, which hands back the parsed
// private): a split holder proves the shares they will keep rebuild the key this ceremony made, before they
// leave setup. It takes ownership of the private and zeroes both halves before it returns.
export async function verifyRecoveredIdentity(priv: HybridRecipientPrivate): Promise<ActionResult<{ match: boolean }>> {
  const r = currentCeremony();
  try {
    if (r === null) return fail("refused", "The keys are no longer in this tab, so there is nothing to compare against.");
    const match = (await identityFingerprint(priv)) === r.breakGlass.fingerprint;
    setupModel().update({ possession: match ? "match" : "mismatch" });
    return ok({ match });
  } finally {
    priv.x25519Scalar.fill(0);
    priv.mlkemSeed.fill(0);
  }
}
